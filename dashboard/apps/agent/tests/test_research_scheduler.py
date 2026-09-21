"""Tests for the Modular Autonomous Research Scheduler.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_research_scheduler -v

Coverage maps to the spec's "definition of done" (§68): triggers (immediate/once/
delayed/interval/cron/event/dependency), the cron parser (tz + DST safe), fairness
policies, retry backoff + classification, leases and stale-worker recovery, durable
queue with dedup/idempotency, pause/resume/cancel, DLQ + replay, safety guards
(runaway / event storm / circuit breaker), crash recovery, and an end-to-end
Scheduler → Worker → Research Loop → Evaluator → NextAction run. Time is driven by
a FakeClock so scheduling over hours/days is deterministic.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.research import models as M
from agent.research.scheduler import Scheduler, SchedulerConfig
from agent.research.scheduler import cron as cronlib
from agent.research.scheduler import model as S
from agent.research.scheduler import policy as P
from agent.research.scheduler import retry as R
from agent.research.scheduler import triggers as TR
from agent.research.scheduler.resources import RateLimiter, ResourceLimits, ResourceManager
from agent.research.scheduler.safety import CircuitBreaker, EventCoalescer, RunawayGuard
from agent.research.scheduler.scheduler import ScheduleRequest
from agent.research.scheduler.timeutil import FakeClock, dt_to_ms
from agent.research.scheduler.worker import ExecutionResult, JobDriver
from agent.research.store import ResearchStore

UTC = timezone.utc


def _ms(*parts) -> int:
    return dt_to_ms(datetime(*parts, tzinfo=UTC))


class _RecordingDriver(JobDriver):
    """A driver that records calls and returns a scripted result per job."""

    def __init__(self, results: list[ExecutionResult] | None = None):
        self.calls: list[str] = []
        self._results = list(results or [])

    async def drive(self, job, schedule) -> ExecutionResult:
        self.calls.append(job.id)
        if self._results:
            return self._results.pop(0)
        return ExecutionResult(outcome="completed", iteration_to=1)


def _sched(**kw) -> S.Schedule:
    base = {"id": "sch_x", "research_run_id": "run_x", "created_at": _ms(2026, 9, 17, 0, 0)}
    base.update(kw)
    return S.Schedule(**base)


# ── cron parser ──────────────────────────────────────────────────────────────

class TestCron(unittest.TestCase):
    def test_basic_step(self):
        c = cronlib.parse("0 */6 * * *")
        self.assertEqual(c.next_after(_ms(2026, 9, 17, 10, 0)), _ms(2026, 9, 17, 12, 0))
        self.assertEqual(c.next_after(_ms(2026, 9, 17, 12, 0)), _ms(2026, 9, 17, 18, 0))

    def test_matches_exact_minute(self):
        c = cronlib.parse("30 9 * * *")
        self.assertTrue(c.matches(_ms(2026, 9, 17, 9, 30)))
        self.assertFalse(c.matches(_ms(2026, 9, 17, 9, 31)))

    def test_names_ranges_and_lists(self):
        c = cronlib.parse("0,30 9-17 * JAN-MAR MON-FRI")
        # 2026-01-05 is a Monday
        self.assertTrue(c.matches(_ms(2026, 1, 5, 9, 0)))
        self.assertFalse(c.matches(_ms(2026, 1, 4, 9, 0)))  # Sunday

    def test_timezone_aware(self):
        c = cronlib.parse("0 9 * * *")
        nxt = c.next_after(_ms(2026, 9, 17, 10, 0), tz="Asia/Jakarta")
        # 09:00 Jakarta (UTC+7) == 02:00 UTC next day
        self.assertEqual(nxt, _ms(2026, 9, 18, 2, 0))

    def test_dst_boundary_no_drift(self):
        # US DST spring-forward 2026-03-08; a 02:30 job must still resolve sanely
        c = cronlib.parse("30 2 * * *")
        nxt = c.next_after(_ms(2026, 3, 7, 6, 0), tz="America/New_York")
        self.assertIsNotNone(nxt)
        self.assertGreater(nxt, _ms(2026, 3, 7, 6, 0))

    def test_invalid(self):
        for bad in ("", "not a cron", "0 0 * * * *", "60 0 * * *", "* * * * 8"):
            self.assertFalse(cronlib.is_valid(bad), bad)


# ── triggers ─────────────────────────────────────────────────────────────────

class TestTriggers(unittest.TestCase):
    def setUp(self):
        self.now = _ms(2026, 9, 17, 10, 0)
        self.ctx = TR.TriggerContext(now_ms=self.now)

    def test_immediate_fires_once(self):
        t = TR.trigger_for(_sched(type="IMMEDIATE"))
        self.assertTrue(t.should_trigger(self.ctx))
        t2 = TR.trigger_for(_sched(type="IMMEDIATE", run_count=1))
        self.assertFalse(t2.should_trigger(self.ctx))

    def test_once_future_then_due(self):
        at = self.now + 3_600_000
        t = TR.trigger_for(_sched(type="ONCE", at_ms=at))
        self.assertFalse(t.should_trigger(self.ctx))
        self.assertEqual(t.next_occurrence(self.ctx), at)
        self.assertTrue(t.should_trigger(TR.TriggerContext(now_ms=at)))

    def test_delayed(self):
        t = TR.trigger_for(_sched(type="DELAYED", delay_s=1800, created_at=self.now))
        self.assertFalse(t.should_trigger(self.ctx))
        self.assertEqual(t.next_occurrence(self.ctx) - self.now, 1_800_000)

    def test_interval_anchors_from_last_run(self):
        s = _sched(type="INTERVAL", interval_s=3600, last_run_at=self.now)
        t = TR.trigger_for(s)
        self.assertEqual(t.next_occurrence(self.ctx), self.now + 3_600_000)
        self.assertTrue(t.is_recurring())

    def test_cron_trigger(self):
        t = TR.trigger_for(_sched(type="CRON", cron="0 */6 * * *", created_at=self.now))
        self.assertEqual(t.next_occurrence(self.ctx), _ms(2026, 9, 17, 12, 0))

    def test_event_trigger(self):
        t = TR.trigger_for(_sched(type="EVENT", event="knowledge.updated"))
        self.assertFalse(t.should_trigger(self.ctx))
        self.assertTrue(t.should_trigger(TR.TriggerContext(now_ms=self.now, events=["knowledge.updated"])))

    def test_dependency_conditions(self):
        t = TR.trigger_for(_sched(type="DEPENDENCY", depends_on=["jA"], dep_condition="SUCCESS"))
        self.assertFalse(t.should_trigger(self.ctx))
        self.assertTrue(t.should_trigger(TR.TriggerContext(now_ms=self.now, dependency_states={"jA": S.JOB_COMPLETED})))
        self.assertFalse(t.should_trigger(TR.TriggerContext(now_ms=self.now, dependency_states={"jA": S.JOB_FAILED})))
        # FAILED condition flips it
        t2 = TR.trigger_for(_sched(type="DEPENDENCY", depends_on=["jA"], dep_condition="FAILED"))
        self.assertTrue(t2.should_trigger(TR.TriggerContext(now_ms=self.now, dependency_states={"jA": S.JOB_FAILED})))

    def test_registry_is_pluggable(self):
        self.assertIn("CRON", TR.registered_types())
        self.assertIn("EVENT", TR.TRIGGER_REGISTRY.names())


# ── scheduling policy / fairness (§9, §33) ───────────────────────────────────

class TestPolicy(unittest.TestCase):
    def setUp(self):
        self.now = _ms(2026, 9, 17, 10, 0)
        self.ctx = P.SchedulingContext(now_ms=self.now)

    def _job(self, jid, prio, waited_min):
        return S.ScheduledJob(id=jid, schedule_id="s", research_run_id="r", priority=prio,
                              scheduled_at=self.now - waited_min * 60_000)

    def test_fifo_oldest_first(self):
        jobs = [self._job("new", "CRITICAL", 1), self._job("old", "LOW", 100)]
        self.assertEqual(P.FifoPolicy().select_next(jobs, self.ctx).id, "old")

    def test_strict_priority(self):
        jobs = [self._job("low", "LOW", 100), self._job("crit", "CRITICAL", 1)]
        self.assertEqual(P.PriorityPolicy().select_next(jobs, self.ctx).id, "crit")

    def test_aging_prevents_starvation(self):
        # a long-waiting LOW job eventually beats a fresh HIGH one
        jobs = [self._job("low_old", "LOW", 120), self._job("high_new", "HIGH", 0)]
        self.assertEqual(P.PriorityWithAgingPolicy().select_next(jobs, self.ctx).id, "low_old")

    def test_fresh_critical_still_wins(self):
        jobs = [self._job("low_old", "LOW", 5), self._job("crit_new", "CRITICAL", 0)]
        self.assertEqual(P.PriorityWithAgingPolicy().select_next(jobs, self.ctx).id, "crit_new")

    def test_deadline_pressure(self):
        soon = self._job("soon", "LOW", 0)
        soon.metadata["deadline_ms"] = self.now + 60_000
        later = self._job("later", "NORMAL", 0)
        self.assertEqual(P.PriorityWithAgingPolicy().select_next([later, soon], self.ctx).id, "soon")


# ── retry (§15, §16) ─────────────────────────────────────────────────────────

class TestRetry(unittest.TestCase):
    def test_strategies(self):
        pol = S.RetryPolicy(max_attempts=5, strategy="EXPONENTIAL", base_delay_ms=10_000, max_delay_ms=1_000_000)
        self.assertEqual([R.backoff_delay_ms(pol, a) for a in (1, 2, 3)], [10_000, 20_000, 40_000])
        lin = S.RetryPolicy(strategy="LINEAR", base_delay_ms=1_000)
        self.assertEqual([R.backoff_delay_ms(lin, a) for a in (1, 2, 3)], [1_000, 2_000, 3_000])
        fixed = S.RetryPolicy(strategy="FIXED", base_delay_ms=5_000)
        self.assertEqual(R.backoff_delay_ms(fixed, 4), 5_000)

    def test_cap_and_jitter(self):
        pol = S.RetryPolicy(strategy="EXPONENTIAL", base_delay_ms=10_000, max_delay_ms=25_000)
        self.assertEqual(R.backoff_delay_ms(pol, 5), 25_000)  # capped
        jit = S.RetryPolicy(strategy="EXPONENTIAL_JITTER", base_delay_ms=10_000, jitter=0.25)
        for _ in range(50):
            d = R.backoff_delay_ms(jit, 1)
            self.assertGreaterEqual(d, 7_500)
            self.assertLessEqual(d, 12_500)

    def test_classification(self):
        self.assertEqual(R.classify_error(TimeoutError("timed out"))[0], S.RETRYABLE)
        self.assertEqual(R.classify_error(ValueError("bad config"))[0], S.NON_RETRYABLE)
        self.assertEqual(R.classify_error("rate limit exceeded")[0], S.RETRYABLE)
        self.assertEqual(R.classify_error("permission denied")[0], S.NON_RETRYABLE)

    def test_should_retry(self):
        pol = S.RetryPolicy(max_attempts=3)
        self.assertTrue(R.should_retry(pol, 1, S.RETRYABLE))
        self.assertFalse(R.should_retry(pol, 3, S.RETRYABLE))
        self.assertFalse(R.should_retry(pol, 1, S.NON_RETRYABLE))

    def test_research_failure_mapping(self):
        self.assertEqual(R.classify_result(M.FAIL_TOOL)[0], S.RETRYABLE)
        self.assertEqual(R.classify_result(M.FAIL_HYPOTHESIS_REJECTED)[0], S.NON_RETRYABLE)


# ── resources (§30-32) ───────────────────────────────────────────────────────

class TestResources(unittest.TestCase):
    def test_global_concurrency(self):
        rm = ResourceManager(ResourceLimits(max_concurrent_runs=1, max_per_run_instances=5))
        j1 = S.ScheduledJob(id="j1", schedule_id="s", research_run_id="r1")
        j2 = S.ScheduledJob(id="j2", schedule_id="s", research_run_id="r2")
        ok, _ = rm.try_reserve(j1)
        self.assertTrue(ok)
        ok2, reasons = rm.try_reserve(j2)
        self.assertFalse(ok2)
        self.assertTrue(reasons)
        rm.release(j1)
        self.assertTrue(rm.try_reserve(j2)[0])

    def test_class_limit(self):
        rm = ResourceManager(ResourceLimits(max_concurrent_runs=10, max_per_class={"network": 1}, max_per_run_instances=10))
        a = S.ScheduledJob(id="a", schedule_id="s", research_run_id="r1", resources=S.ResourceRequirements(class_="network"))
        b = S.ScheduledJob(id="b", schedule_id="s", research_run_id="r2", resources=S.ResourceRequirements(class_="network"))
        self.assertTrue(rm.try_reserve(a)[0])
        self.assertFalse(rm.try_reserve(b)[0])

    def test_per_run_single_instance(self):
        rm = ResourceManager(ResourceLimits(max_concurrent_runs=10, max_per_run_instances=1))
        a = S.ScheduledJob(id="a", schedule_id="s", research_run_id="r1")
        b = S.ScheduledJob(id="b", schedule_id="s", research_run_id="r1")
        self.assertTrue(rm.try_reserve(a)[0])
        self.assertFalse(rm.try_reserve(b)[0])

    def test_rehydrate(self):
        rm = ResourceManager(ResourceLimits(max_concurrent_runs=5))
        rm.rehydrate([S.ScheduledJob(id="x", schedule_id="s", research_run_id="r", status=S.JOB_RUNNING)])
        self.assertEqual(rm.snapshot()["globalActive"], 1)

    def test_rate_limiter(self):
        t = [0.0]
        rl = RateLimiter(rate_per_s=1.0, burst=2, clock=lambda: t[0])
        self.assertTrue(rl.try_acquire())
        self.assertTrue(rl.try_acquire())
        self.assertFalse(rl.try_acquire())  # bucket empty
        t[0] += 1.0  # one second refills 1 token
        self.assertTrue(rl.try_acquire())


# ── safety (§60-62) ──────────────────────────────────────────────────────────

class TestSafety(unittest.TestCase):
    def test_runaway_throttle_then_pause(self):
        g = RunawayGuard(min_interval_s=60, pause_after=3)
        now = _ms(2026, 9, 17, 10, 0)
        s = _sched(type="IMMEDIATE", last_run_at=now - 5_000)  # 5s ago < 60s floor
        self.assertEqual(g.check(s, now).action, "THROTTLE")
        g.check(s, now)
        self.assertEqual(g.check(s, now).action, "PAUSE")

    def test_runaway_hourly_cap(self):
        g = RunawayGuard(min_interval_s=0, max_per_hour=2)
        now = _ms(2026, 9, 17, 10, 0)
        s = _sched(type="INTERVAL", interval_s=1, last_run_at=None)
        g.record_fire(s.id, now)
        g.record_fire(s.id, now)
        self.assertEqual(g.check(s, now).action, "CIRCUIT_BREAK")

    def test_event_coalescer(self):
        ec = EventCoalescer(window_ms=1000)
        t = 1_000_000
        self.assertTrue(ec.observe("ev", t))        # opens window
        self.assertFalse(ec.observe("ev", t + 100))  # coalesced
        self.assertFalse(ec.observe("ev", t + 500))  # coalesced
        self.assertEqual(ec.ready(t + 500), [])       # window still open
        self.assertEqual(ec.ready(t + 1001), ["ev"])  # closed → ready once

    def test_circuit_breaker(self):
        cb = CircuitBreaker(threshold=2, cooldown_ms=1000)
        now = 10_000
        cb.record_failure("k", now)
        self.assertFalse(cb.is_open("k", now))
        cb.record_failure("k", now)
        self.assertTrue(cb.is_open("k", now))
        self.assertFalse(cb.allow("k", now).allowed())
        # after cooldown → half-open probe allowed
        self.assertFalse(cb.is_open("k", now + 1001))
        cb.record_success("k")
        self.assertFalse(cb.is_open("k", now + 2000))


# ── leases + workers (§11-13) ────────────────────────────────────────────────

class TestLeaseAndWorker(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sched-lease-"))
        os.environ["AGENT_DATA_DIR"] = str(self.tmp)
        self.store = await ResearchStore.open()

    async def asyncTearDown(self):
        await self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_lease_acquire_excludes_second_holder(self):
        clk = FakeClock(_ms(2026, 9, 17, 10, 0))
        sch = Scheduler(self.store, config=SchedulerConfig(lease_ms=60_000), clock=clk)
        job = S.ScheduledJob(id="j1", schedule_id="s", research_run_id="r")
        await self.store.save_job(job)
        lease = await sch.lease_mgr.acquire(job, "w1")
        self.assertIsNotNone(lease)
        # a second worker cannot claim a job with a live lease
        self.assertIsNone(await sch.lease_mgr.acquire(job, "w2"))

    async def test_lease_expiry_allows_reclaim(self):
        clk = FakeClock(_ms(2026, 9, 17, 10, 0))
        sch = Scheduler(self.store, config=SchedulerConfig(lease_ms=10_000), clock=clk)
        job = S.ScheduledJob(id="j2", schedule_id="s", research_run_id="r")
        await self.store.save_job(job)
        await sch.lease_mgr.acquire(job, "w1")
        clk.advance_s(11)
        lease2 = await sch.lease_mgr.acquire(job, "w2")
        self.assertIsNotNone(lease2)
        self.assertEqual(lease2.worker_id, "w2")

    async def test_heartbeat_extends(self):
        clk = FakeClock(_ms(2026, 9, 17, 10, 0))
        sch = Scheduler(self.store, config=SchedulerConfig(lease_ms=10_000), clock=clk)
        job = S.ScheduledJob(id="j3", schedule_id="s", research_run_id="r")
        await self.store.save_job(job)
        lease = await sch.lease_mgr.acquire(job, "w1")
        first_exp = lease.expires_at
        clk.advance_s(5)
        lease = await sch.lease_mgr.heartbeat(lease)
        self.assertGreater(lease.expires_at, first_exp)


# ── scheduler integration (§4, §22-27, §36, §58) ─────────────────────────────

class TestSchedulerCore(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._env = os.environ.get("AGENT_DATA_DIR")
        self.tmp = Path(tempfile.mkdtemp(prefix="sched-core-"))
        os.environ["AGENT_DATA_DIR"] = str(self.tmp)
        self.store = await ResearchStore.open()
        self.clk = FakeClock(_ms(2026, 9, 17, 10, 0))
        self.drv = _RecordingDriver()
        self.cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, min_fire_interval_s=0,
                                   max_fires_per_hour=10_000, max_attempts=3)
        self.sch = Scheduler(self.store, config=self.cfg, clock=self.clk, driver=self.drv)
        # register workers for dispatch capacity, but do NOT start the background
        # loop — the tests drive `_tick()` by hand so timing is deterministic
        await self.sch._ensure_workers()

    async def asyncTearDown(self):
        await self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._env is None:
            os.environ.pop("AGENT_DATA_DIR", None)
        else:
            os.environ["AGENT_DATA_DIR"] = self._env

    async def _tick(self):
        await self.sch._tick()
        await asyncio.sleep(0)  # let dispatched tasks run

    async def test_immediate_runs_to_completion(self):
        await self.sch.schedule(ScheduleRequest(research_run_id="r1", type=S.TYPE_IMMEDIATE))
        await self._tick()
        await asyncio.sleep(0.05)
        jobs = await self.sch.list_jobs(research_run_id="r1")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], S.JOB_COMPLETED)
        self.assertEqual(len(self.drv.calls), 1)

    async def test_delayed_not_run_until_due(self):
        await self.sch.schedule(ScheduleRequest(research_run_id="r2", type=S.TYPE_DELAYED, delay_s=600))
        await self._tick()
        self.assertEqual(await self.sch.list_jobs(research_run_id="r2"), [])
        self.clk.advance_s(601)
        await self._tick()
        self.assertEqual(len(await self.sch.list_jobs(research_run_id="r2")), 1)

    async def test_interval_max_runs_completes_schedule(self):
        s = await self.sch.schedule(ScheduleRequest(research_run_id="r3", type=S.TYPE_INTERVAL,
                                                    interval_s=60, max_runs=2))
        await self._tick()  # fire 1
        self.clk.advance_s(61)
        await self._tick()  # fire 2 → max_runs reached
        sched = await self.sch.get_schedule(s.id)
        self.assertEqual(sched["status"], S.SCHED_COMPLETED)
        self.assertEqual(sched["runCount"], 2)

    async def test_dedup_same_occurrence(self):
        await self.sch.schedule(ScheduleRequest(research_run_id="r4", type=S.TYPE_IMMEDIATE))
        await self._tick()
        await self._tick()  # a second tick at the same instant must not duplicate
        self.assertEqual(len(await self.sch.list_jobs(research_run_id="r4")), 1)

    async def test_event_trigger_fires_and_coalesces(self):
        await self.sch.schedule(ScheduleRequest(research_run_id="r5", type=S.TYPE_EVENT, event="knowledge.updated"))
        await self.sch.notify_event("knowledge.updated")
        await self.sch.notify_event("knowledge.updated")  # coalesced
        await self._tick()
        self.assertEqual(len(await self.sch.list_jobs(research_run_id="r5")), 1)

    async def test_dependency_gate(self):
        # job A completes, then dependent B becomes eligible
        await self.sch.schedule(ScheduleRequest(research_run_id="rA", type=S.TYPE_IMMEDIATE))
        await self._tick()
        await asyncio.sleep(0.05)
        a_jobs = await self.sch.list_jobs(research_run_id="rA")
        await self.sch.schedule(ScheduleRequest(research_run_id="rB", type=S.TYPE_DEPENDENCY,
                                                depends_on=[a_jobs[0]["id"]], dep_condition="SUCCESS"))
        await self._tick()
        self.assertEqual(len(await self.sch.list_jobs(research_run_id="rB")), 1)

    async def test_pause_and_resume_job(self):
        s = await self.sch.schedule(ScheduleRequest(research_run_id="r6", type=S.TYPE_DELAYED, delay_s=10_000))
        job = S.ScheduledJob(id="pause_me", schedule_id=s.id, research_run_id="r6", status=S.JOB_SCHEDULED)
        await self.store.save_job(job)
        self.assertEqual((await self.sch.pause("pause_me"))["status"], S.JOB_PAUSED)
        self.assertEqual((await self.sch.resume("pause_me"))["status"], S.JOB_READY)

    async def test_cancel_idempotent(self):
        s = await self.sch.schedule(ScheduleRequest(research_run_id="r7", type=S.TYPE_DELAYED, delay_s=10_000))
        job = S.ScheduledJob(id="cancel_me", schedule_id=s.id, research_run_id="r7", status=S.JOB_SCHEDULED)
        await self.store.save_job(job)
        a = await self.sch.cancel("cancel_me")
        b = await self.sch.cancel("cancel_me")
        self.assertEqual(a["status"], S.JOB_CANCELLED)
        self.assertEqual(b["status"], S.JOB_CANCELLED)

    async def test_manual_trigger_creates_new_job(self):
        s = await self.sch.schedule(ScheduleRequest(research_run_id="r8", type=S.TYPE_EVENT, event="never"))
        await self._tick()
        ready = S.ScheduledJob(id="seed", schedule_id=s.id, research_run_id="r8", status=S.JOB_READY)
        await self.store.save_job(ready)
        new = await self.sch.trigger("seed")
        self.assertNotEqual(new["id"], "seed")
        self.assertEqual(new["status"], S.JOB_READY)
        self.assertEqual(new["createdBy"], "USER")

    async def test_replay_does_not_overwrite(self):
        job = S.ScheduledJob(id="orig", schedule_id="sX", research_run_id="r9", status=S.JOB_COMPLETED)
        await self.store.save_job(job)
        sched = _sched(id="sX", research_run_id="r9", type="EVENT", event="never")
        await self.store.save_schedule(sched)
        new = await self.sch.replay("orig")
        self.assertNotEqual(new["id"], "orig")
        self.assertEqual(new["replayOf"], "orig")
        still = await self.sch.get_job("orig")
        self.assertEqual(still["status"], S.JOB_COMPLETED)  # original untouched

    async def test_transient_wait_is_promoted_not_stranded(self):
        """A job blocked only on resources/lease must be re-eligible on the next
        tick. Without this it stranded WAITING forever and piled up (the bug this
        pins). A job waiting on a real event must stay waiting."""
        now = self.clk.now_ms()
        transient = S.ScheduledJob(
            id="t_wait", schedule_id="sT", research_run_id="rT", status=S.JOB_WAITING,
            wait_reason="resources busy", metadata={"retry_transient": True},
        )
        event_wait = S.ScheduledJob(
            id="e_wait", schedule_id="sT", research_run_id="rT", status=S.JOB_WAITING,
            wait_reason="waiting for event", metadata={"wait_event": "never"},
        )
        await self.store.save_job(transient)
        await self.store.save_job(event_wait)

        await self.sch._promote_waiting(now, [])

        self.assertEqual((await self.sch.get_job("t_wait"))["status"], S.JOB_READY)
        self.assertEqual((await self.sch.get_job("e_wait"))["status"], S.JOB_WAITING)

    async def test_interval_schedule_does_not_stack_open_jobs(self):
        """A run-bound INTERVAL schedule whose job is still open must not create a
        second job on the next fire — that is what accumulated hundreds of WAITING
        jobs while a long run was still executing."""
        self.drv = _RecordingDriver([ExecutionResult(outcome="waiting", iteration_to=1)])
        self.sch.driver = self.drv
        await self.sch.schedule(ScheduleRequest(research_run_id="rSL", type=S.TYPE_INTERVAL, interval_s=60))
        await self._tick()
        await asyncio.sleep(0.02)
        jobs = await self.sch.list_jobs(research_run_id="rSL")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], S.JOB_WAITING)  # still open

        self.clk.advance_s(61)  # the interval re-fires while the job is open
        await self._tick()
        await asyncio.sleep(0.02)
        self.assertEqual(len(await self.sch.list_jobs(research_run_id="rSL")), 1)
        self.assertEqual(len(self.drv.calls), 1)


class TestRetryAndDlq(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._env = os.environ.get("AGENT_DATA_DIR")
        self.tmp = Path(tempfile.mkdtemp(prefix="sched-retry-"))
        os.environ["AGENT_DATA_DIR"] = str(self.tmp)
        self.store = await ResearchStore.open()
        self.clk = FakeClock(_ms(2026, 9, 17, 10, 0))

    async def asyncTearDown(self):
        await self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._env is None:
            os.environ.pop("AGENT_DATA_DIR", None)
        else:
            os.environ["AGENT_DATA_DIR"] = self._env

    async def test_retryable_failure_retries(self):
        drv = _RecordingDriver([ExecutionResult(outcome="failed", failure_kind=M.FAIL_TOOL, failure_message="timeout")])
        cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, min_fire_interval_s=0, max_attempts=3,
                              base_retry_delay_ms=1000, retry_policy="FIXED")
        sch = Scheduler(self.store, config=cfg, clock=self.clk, driver=drv)
        await sch.start()
        await sch.schedule(ScheduleRequest(research_run_id="rr", type=S.TYPE_IMMEDIATE))
        await sch._tick()
        await asyncio.sleep(0.05)
        job = (await sch.list_jobs(research_run_id="rr"))[0]
        self.assertEqual(job["status"], S.JOB_RETRYING)
        self.assertEqual(job["attempt"], 1)
        # the decision is explainable
        expl = await sch.explain(job["id"])
        self.assertEqual(expl["decision"], "RETRY")
        await sch.stop(grace_s=0.3)

    async def test_non_retryable_fails_immediately(self):
        drv = _RecordingDriver([ExecutionResult(outcome="failed", failure_kind=M.FAIL_HYPOTHESIS_REJECTED,
                                                failure_message="rejected")])
        cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, min_fire_interval_s=0, max_attempts=5)
        sch = Scheduler(self.store, config=cfg, clock=self.clk, driver=drv)
        await sch.start()
        await sch.schedule(ScheduleRequest(research_run_id="nr", type=S.TYPE_IMMEDIATE))
        await sch._tick()
        await asyncio.sleep(0.05)
        job = (await sch.list_jobs(research_run_id="nr"))[0]
        self.assertEqual(job["status"], S.JOB_FAILED)
        await sch.stop(grace_s=0.3)

    async def test_retry_exhaustion_dead_letters(self):
        drv = _RecordingDriver([ExecutionResult(outcome="failed", failure_kind=M.FAIL_TOOL, failure_message="timeout")] * 5)
        cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, min_fire_interval_s=0, max_attempts=2,
                              retry_policy="FIXED", base_retry_delay_ms=1)
        sch = Scheduler(self.store, config=cfg, clock=self.clk, driver=drv)
        await sch.start()
        await sch.schedule(ScheduleRequest(research_run_id="dl", type=S.TYPE_IMMEDIATE))
        for _ in range(6):
            await sch._tick()
            await asyncio.sleep(0.03)
            self.clk.advance_s(1)
        job = (await sch.list_jobs(research_run_id="dl"))[0]
        self.assertEqual(job["status"], S.JOB_DEAD_LETTER)
        dlq = await sch.list_dead_letters()
        self.assertEqual(len(dlq), 1)
        await sch.stop(grace_s=0.3)


class TestRecovery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._env = os.environ.get("AGENT_DATA_DIR")
        self.tmp = Path(tempfile.mkdtemp(prefix="sched-recover-"))
        os.environ["AGENT_DATA_DIR"] = str(self.tmp)
        self.store = await ResearchStore.open()
        self.clk = FakeClock(_ms(2026, 9, 17, 10, 0))

    async def asyncTearDown(self):
        await self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._env is None:
            os.environ.pop("AGENT_DATA_DIR", None)
        else:
            os.environ["AGENT_DATA_DIR"] = self._env

    async def test_crash_recovery_requeues_stale_job(self):
        """A job left RUNNING with an expired lease is recovered on a new
        scheduler's startup (spec §42, §47)."""
        cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, min_fire_interval_s=0,
                              lease_ms=10_000, stale_worker_ms=10_000, max_attempts=3)
        # simulate: job RUNNING + a lease from a now-dead worker
        job = S.ScheduledJob(id="crash", schedule_id="s", research_run_id="rc", status=S.JOB_RUNNING,
                             worker_id="dead-worker", attempt=0, max_attempts=3)
        await self.store.save_job(job)
        lease = S.ExecutionLease(job_id="crash", worker_id="dead-worker", lease_id="l1",
                                 acquired_at=self.clk.now_ms() - 20_000, expires_at=self.clk.now_ms() - 1,
                                 heartbeat_at=self.clk.now_ms() - 20_000)
        await self.store.put_lease(lease)
        # a fresh scheduler recovers it
        drv = _RecordingDriver()
        sch = Scheduler(self.store, config=cfg, clock=self.clk, driver=drv)
        await sch.start()
        recovered = await sch.get_job("crash")
        self.assertEqual(recovered["status"], S.JOB_READY)
        self.assertEqual(recovered["attempt"], 1)
        await sch.stop(grace_s=0.3)

    async def test_live_lease_not_recovered(self):
        cfg = SchedulerConfig(max_workers=1, polling_interval_s=99, lease_ms=600_000, stale_worker_ms=600_000)
        job = S.ScheduledJob(id="live", schedule_id="s", research_run_id="rl", status=S.JOB_RUNNING)
        await self.store.save_job(job)
        lease = S.ExecutionLease(job_id="live", worker_id="alive", lease_id="l2",
                                 acquired_at=self.clk.now_ms(), expires_at=self.clk.now_ms() + 600_000,
                                 heartbeat_at=self.clk.now_ms())
        await self.store.put_lease(lease)
        # register a fresh heartbeat so the worker is not stale
        await self.store.save_worker(S.WorkerRecord(id="alive", last_heartbeat_at=self.clk.now_ms()))
        drv = _RecordingDriver()
        sch = Scheduler(self.store, config=cfg, clock=self.clk, driver=drv)
        await sch.start()
        still = await sch.get_job("live")
        self.assertEqual(still["status"], S.JOB_RUNNING)  # untouched
        await sch.stop(grace_s=0.3)


class TestSchedulerLoop(unittest.IsolatedAsyncioTestCase):
    """End-to-end: the real Scheduler drives a real Research Run through the loop."""

    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("VAULT_ROOT", "AGENT_DATA_DIR")}
        self.tmp = Path(tempfile.mkdtemp(prefix="sched-test-"))
        vault = self.tmp / "vault"
        (vault / "03-Areas/concepts").mkdir(parents=True)
        (vault / "02-Projects").mkdir(parents=True)
        real = Path("/home/hermes/vault")
        for slug in ("mev", "mempool", "oracle"):
            src = real / "03-Areas/concepts" / f"{slug}.md"
            if src.exists():
                shutil.copy2(src, vault / "03-Areas/concepts" / f"{slug}.md")
        if not (vault / "03-Areas/concepts/mev.md").exists():
            (vault / "03-Areas/concepts/mev.md").write_text("---\nconcept: mev\n---\n\n## What\nMEV.\n")
        os.environ["VAULT_ROOT"] = str(vault)
        os.environ["AGENT_DATA_DIR"] = str(self.tmp / "data")
        from agent.knowledge import index as kix
        from agent.tools import vault_index
        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        from agent.knowledge import index as kix
        from agent.tools import vault_index
        kix.invalidate()
        vault_index.invalidate()

    def test_schedule_drives_run_to_completion(self):
        async def go():
            from agent.knowledge.manager import KnowledgeManager
            from agent.research.config import ResearchConfig
            from agent.research.executor import ScriptedExecutor
            from agent.research.loop import ResearchLoop, build_default_deps
            from agent.research.scheduler.research_bridge import ResearchJobDriver

            def finder(plan, ctx):
                return M.ResearchResult(id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="",
                                        strategy=plan.strategy,
                                        observations=[{"statement": f"observed {plan.question[:30]}", "source": "spec"}],
                                        evidence=[{"kind": "source", "statement": "documented", "source": "https://ethereum.org"}],
                                        sources=["https://ethereum.org"], conclusions=["as documented"], hypothesis_survived=True)

            store = await ResearchStore.open()
            try:
                from agent.research.service import ResearchService

                svc = ResearchService.create(store)
                # build the loop for the pending key (with the scripted executor),
                # start the run, then re-key it under the real id — exactly as the
                # /research/runs endpoint does, so the bridge reuses this executor.
                loop = ResearchLoop(build_default_deps(
                    store=store, km=KnowledgeManager(),
                    executor=ScriptedExecutor(rules=[("any", finder)]),
                    config=ResearchConfig(max_iterations=2)))
                run = await loop.start(
                    {"objective": "Understand MEV extraction preconditions", "success_criteria": ["mev understood"]})
                svc._loops[run.id] = loop

                clk = FakeClock(_ms(2026, 9, 17, 10, 0))
                sch = Scheduler(store, config=SchedulerConfig(max_workers=1, polling_interval_s=0.02,
                                                              min_fire_interval_s=0),
                                clock=clk, driver=ResearchJobDriver(svc))
                svc.scheduler = sch
                await sch.start()
                await sch.schedule(ScheduleRequest(research_run_id=run.id, type=S.TYPE_IMMEDIATE))
                for _ in range(100):
                    await asyncio.sleep(0.05)
                    r = await store.get_run(run.id)
                    if r.is_terminal():
                        break
                # stop first, so the in-flight job task finishes and its terminal
                # status is persisted before we snapshot — reading jobs before the
                # graceful stop raced the driver and saw the job still RUNNING.
                await sch.stop(grace_s=1)
                jobs = await sch.list_jobs(research_run_id=run.id)
                r = await store.get_run(run.id)
                self.assertTrue(r.is_terminal(), f"run not terminal: {r.status}")
                self.assertEqual(jobs[0]["status"], S.JOB_COMPLETED)
                self.assertIsNotNone(jobs[0]["checkpointIteration"])
            finally:
                await store.close()

        asyncio.run(go())


if __name__ == "__main__":
    unittest.main(verbosity=2)
