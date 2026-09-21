"""The Scheduler — a durable temporal execution layer for autonomous research.

It decides WHEN a research run runs: it fires triggers into a durable queue,
admits ready jobs under resource/concurrency/rate limits, dispatches them to
workers holding cross-process leases, keeps them alive with heartbeats, recovers
from crashes, retries transient failures with backoff, dead-letters the rest, and
explains every decision. It never decides WHAT to research — that is the Research
Loop's job, reached only through the injected `JobDriver`.

Semantics (spec §27): **at-least-once delivery + idempotent execution**. A job may
run more than once across a crash (the lease expired, another worker recovered
it), so the driver must be idempotent; scheduling itself is exactly-once per
(schedule, occurrence) via the idempotency key. This is stated rather than claimed
as exactly-once, which the SQLite-backed single-writer store cannot promise across
a partition.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from ..registry import Registry
from . import model as S
from . import timeutil as T
from .config import SchedulerConfig
from .lease import LeaseManager
from .metrics import SchedulerMetrics
from .policy import SCHEDULING_POLICY_REGISTRY, SchedulingContext, SchedulingPolicy
from .recover import DEFAULT_RECOVERY, RECOVERY_REGISTRY, RecoveryContext
from .resources import ResourceLimits, ResourceManager
from .retry import backoff_delay_ms, classify_result, should_retry
from .safety import GUARD_OK, GUARD_PAUSE, CircuitBreaker, EventCoalescer, RunawayGuard
from .triggers import TriggerContext, trigger_for
from .worker import ExecutionResult, FunctionWorker, JobDriver, WorkerPool

log = logging.getLogger("agent.research.scheduler")

# Job statuses that mean "this occurrence is still outstanding" — a fresh fire
# would be a duplicate. Used for the per-schedule single-flight check.
_OPEN_JOB_STATUSES = frozenset({
    S.JOB_SCHEDULED, S.JOB_READY, S.JOB_QUEUED, S.JOB_RUNNING,
    S.JOB_CHECKPOINTING, S.JOB_WAITING, S.JOB_RETRYING,
})

# scheduler event vocabulary (spec §44)
EV_JOB_CREATED = "scheduler.job.created"
EV_JOB_QUEUED = "scheduler.job.queued"
EV_JOB_STARTED = "scheduler.job.started"
EV_JOB_COMPLETED = "scheduler.job.completed"
EV_JOB_FAILED = "scheduler.job.failed"
EV_JOB_RETRYING = "scheduler.job.retrying"
EV_JOB_WAITING = "scheduler.job.waiting"
EV_JOB_PAUSED = "scheduler.job.paused"
EV_JOB_RESUMED = "scheduler.job.resumed"
EV_JOB_CANCELLED = "scheduler.job.cancelled"
EV_JOB_EXPIRED = "scheduler.job.expired"
EV_JOB_DEAD_LETTERED = "scheduler.job.dead_lettered"
EV_JOB_RECOVERED = "scheduler.job.recovered"
EV_SCHEDULE_CREATED = "scheduler.schedule.created"
EV_SCHEDULE_PAUSED = "scheduler.schedule.paused"
EV_SCHEDULE_RESUMED = "scheduler.schedule.resumed"
EV_SCHEDULE_CANCELLED = "scheduler.schedule.cancelled"
EV_SCHEDULE_COMPLETED = "scheduler.schedule.completed"
EV_WORKER_STARTED = "scheduler.worker.started"
EV_WORKER_STOPPED = "scheduler.worker.stopped"
EV_WORKER_STALE = "scheduler.worker.stale"
EV_LEASE_EXPIRED = "scheduler.lease.expired"
EV_GUARD_THROTTLED = "scheduler.guard.throttled"


@dataclass
class ScheduleRequest:
    """What a caller submits to `Scheduler.schedule()` (spec §4)."""

    research_run_id: str
    type: str = S.TYPE_IMMEDIATE
    cron: str = ""
    interval_s: int = 0
    at: str | int | None = None          # ONCE/DELAYED absolute: ISO-8601 or epoch ms
    delay_s: int = 0
    event: str = ""
    depends_on: list[str] = field(default_factory=list)
    dep_condition: str = S.DEP_COMPLETED
    timezone: str = ""
    priority: str = S.PRIORITY_NORMAL
    retry: Any = None                    # RetryPolicy | dict | None
    concurrency: Any = None              # ConcurrencyPolicy | dict | None
    resources: Any = None                # ResourceRequirements | dict | None
    deadline: str | int | None = None
    max_runs: int | None = None
    max_runs_per_hour: int = 0
    idempotency_key: str = ""
    created_by: str = "SYSTEM"
    metadata: dict = field(default_factory=dict)


def _to_ms(value: str | int | None) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    return T.parse_iso(value)


class Scheduler:
    """The durable execution scheduler. One instance owns the process' queue,
    workers and background loop; the service builds and starts it."""

    def __init__(
        self,
        store,
        *,
        config: SchedulerConfig | None = None,
        clock=None,
        driver: JobDriver | None = None,
        policy: SchedulingPolicy | None = None,
    ):
        self.store = store
        self.config = config or SchedulerConfig.from_env()
        self.clock = clock or T.SystemClock()
        self.driver = driver
        self.policy = policy or SCHEDULING_POLICY_REGISTRY.get(self.config.queue_policy)

        # managers
        self.lease_mgr = LeaseManager(
            store, clock=self.clock, lease_ms=self.config.lease_ms,
            heartbeat_ms=self.config.heartbeat_ms, stale_ms=self.config.stale_worker_ms,
        )
        self.resources = ResourceManager(
            ResourceLimits(
                max_concurrent_runs=self.config.max_concurrent_runs,
                max_concurrent_agents=self.config.max_concurrent_agents,
                max_per_class=dict(self.config.max_per_class),
                max_queue_depth=self.config.max_queue_depth,
            )
        )
        self.pool = WorkerPool()
        self.recovery = RECOVERY_REGISTRY.get(DEFAULT_RECOVERY)
        self.metrics = SchedulerMetrics()

        # safety
        self.runaway = RunawayGuard(
            min_interval_s=self.config.min_fire_interval_s,
            max_per_hour=self.config.max_fires_per_hour,
        )
        self.coalescer = EventCoalescer(window_ms=self.config.event_coalesce_ms)
        self.breaker = CircuitBreaker(
            threshold=self.config.circuit_breaker_threshold,
            cooldown_ms=self.config.circuit_breaker_cooldown_ms,
        )

        # runtime
        self._loop_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._inflight: dict[str, asyncio.Task] = {}
        self._running = False
        self._stopping = False
        self._observed_events: list[str] = []
        self._subscribers: list[asyncio.Queue] = []
        self._decisions: dict[str, S.ScheduleDecision] = {}
        # Serialises ticks. `_tick` runs from the background loop AND directly from
        # `schedule()` (an IMMEDIATE request fires at once); without this the two
        # interleave, both see the same READY job, both try to dispatch it, and the
        # second `try_reserve` fails — stranding the job WAITING while the first is
        # already running it.
        self._tick_lock = asyncio.Lock()

    # ── lifecycle (spec §4) ─────────────────────────────────────────────────
    async def start(self) -> None:
        """Startup recovery, then start workers + the wake-up loop (spec §47)."""
        if self._running:
            return
        self._running = True
        self._stopping = False
        await self._recover()
        await self._ensure_workers()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        self._loop_task = asyncio.create_task(self._main_loop())
        log.info("scheduler started: %d worker(s), %d schedule(s)", len(self.pool.workers),
                 len(await self.store.list_schedules()))

    async def stop(self, *, grace_s: float | None = None) -> None:
        """Graceful shutdown (spec §48): stop firing, let in-flight work finish or
        checkpoint, release leases, persist, stop workers."""
        if self._stopping:
            return
        self._stopping = True
        self._running = False
        grace = self.config.shutdown_grace_period_s if grace_s is None else grace_s

        for t in (self._loop_task, self._heartbeat_task):
            if t is not None:
                t.cancel()
        if self._loop_task is not None:
            await _safe_await(self._loop_task)
        if self._heartbeat_task is not None:
            await _safe_await(self._heartbeat_task)
        self._loop_task = None
        self._heartbeat_task = None

        # give in-flight jobs up to `grace` seconds to finish, then cancel
        if self._inflight:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*self._inflight.values(), return_exceptions=True), timeout=max(0.0, grace)
                )
            except asyncio.TimeoutError:
                for jid, task in list(self._inflight.items()):
                    task.cancel()
                    job = await self._load_job(jid)
                    if job is not None:
                        await self._release_claim(job)
                        job.status = S.JOB_READY
                        await self.store.save_job(job)   # remains recoverable
                await asyncio.gather(*self._inflight.values(), return_exceptions=True)
        await self.pool.stop()
        for w in self.pool.workers:
            await self._mark_worker(w.id, "STOPPED")
        await self._emit(EV_WORKER_STOPPED, worker="all")
        log.info("scheduler stopped cleanly")

    def subscribe(self, maxsize: int = 512) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    # ── scheduling API (spec §4) ────────────────────────────────────────────
    async def schedule(self, request: ScheduleRequest) -> S.Schedule:
        """Create a durable schedule. Validates the trigger spec up front."""
        self._validate(request)
        now = self.clock.now_ms()
        tz = request.timezone or self.config.timezone
        sched = S.Schedule(
            id=S.make_schedule_id(),
            research_run_id=request.research_run_id,
            type=request.type,
            cron=request.cron,
            interval_s=request.interval_s,
            at_ms=_to_ms(request.at),
            delay_s=request.delay_s,
            event=request.event,
            depends_on=list(request.depends_on or []),
            dep_condition=request.dep_condition,
            timezone=tz,
            priority=request.priority if request.priority in S.PRIORITIES else S.PRIORITY_NORMAL,
            retry=_as_retry(request.retry, self.config),
            concurrency=_as_concurrency(request.concurrency),
            resources=_as_resources(request.resources),
            deadline_ms=_to_ms(request.deadline),
            max_runs=request.max_runs,
            max_runs_per_hour=request.max_runs_per_hour,
            created_by=request.created_by,
            metadata=dict(request.metadata or {}),
            # stamp from the injected clock, never the wall-clock default, so
            # time-based triggers anchor deterministically (and tests can drive time)
            created_at=now,
            updated_at=now,
        )
        if request.idempotency_key:
            sched.metadata["idempotency_key"] = request.idempotency_key
        # seed the next occurrence so the UI can show "next run at" immediately
        trig = trigger_for(sched)
        sched.next_run_at = trig.next_occurrence(TriggerContext(now_ms=self.clock.now_ms(), tz=tz))
        await self.store.save_schedule(sched)
        await self._emit(EV_SCHEDULE_CREATED, schedule=sched.id, run=sched.research_run_id, type=sched.type)
        if request.type == S.TYPE_IMMEDIATE:
            # fire immediately rather than waiting for the next tick
            await self._tick()
        return sched

    async def cancel(self, job_id: str) -> dict:
        """Cancel a job (idempotent, spec §19). A running job is cooperatively
        stopped via its task; a terminal job is returned unchanged."""
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        if job.is_terminal():
            return job.summary()   # already terminal — cancel is a no-op (idempotent)
        if job.is_active():
            task = self._inflight.get(job_id)
            if task is not None:
                task.cancel()
            await self._release_claim(job)
        job.status = S.JOB_CANCELLED
        job.completed_at = self.clock.now_ms()
        await self.store.save_job(job)
        self.metrics.incr("jobs_cancelled")
        await self._emit(EV_JOB_CANCELLED, job=job_id)
        return job.summary()

    async def pause(self, job_id: str) -> dict:
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        if job.status in (S.JOB_READY, S.JOB_QUEUED, S.JOB_WAITING, S.JOB_RETRYING, S.JOB_SCHEDULED):
            job.status = S.JOB_PAUSED
            await self.store.save_job(job)
            await self._emit(EV_JOB_PAUSED, job=job_id)
        return job.summary()

    async def resume(self, job_id: str) -> dict:
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        if job.status == S.JOB_PAUSED:
            job.status = S.JOB_READY
            await self.store.save_job(job)
            await self._emit(EV_JOB_RESUMED, job=job_id)
        return job.summary()

    async def trigger(self, job_id: str) -> dict:
        """Manual trigger (§57): enqueue a fresh job for a schedule right now,
        through the same path as any other fire (never bypasses the queue)."""
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        sched = await self._load_schedule(job.schedule_id)
        if sched is None:
            return {"error": "schedule not found"}
        new_job = await self._create_job(sched, fire_at=self.clock.now_ms(), manual=True)
        return new_job.summary() if new_job else {"error": "not created (guard or duplicate)"}

    async def get_job(self, job_id: str) -> dict | None:
        job = await self._load_job(job_id)
        return job.summary() if job else None

    async def list_jobs(
        self, *, status: str | list[str] | None = None, schedule_id: str | None = None,
        research_run_id: str | None = None, limit: int = 1000,
    ) -> list[dict]:
        rows = await self.store.list_jobs(
            status=status, schedule_id=schedule_id, research_run_id=research_run_id, limit=limit
        )
        return [S.ScheduledJob.from_row(r).summary() for r in rows]

    # ── schedule-level operations ───────────────────────────────────────────
    async def get_schedule(self, schedule_id: str) -> dict | None:
        sched = await self._load_schedule(schedule_id)
        return sched.summary() if sched else None

    async def list_schedules(self, *, status: str | None = None, research_run_id: str | None = None) -> list[dict]:
        rows = await self.store.list_schedules(status=status, research_run_id=research_run_id)
        return [S.Schedule.from_row(r).summary() for r in rows]

    async def pause_schedule(self, schedule_id: str) -> dict:
        return await self._set_schedule_status(schedule_id, S.SCHED_PAUSED, EV_SCHEDULE_PAUSED)

    async def resume_schedule(self, schedule_id: str) -> dict:
        return await self._set_schedule_status(schedule_id, S.SCHED_ACTIVE, EV_SCHEDULE_RESUMED)

    async def cancel_schedule(self, schedule_id: str) -> dict:
        return await self._set_schedule_status(schedule_id, S.SCHED_CANCELLED, EV_SCHEDULE_CANCELLED)

    async def _set_schedule_status(self, schedule_id: str, status: str, ev: str) -> dict:
        sched = await self._load_schedule(schedule_id)
        if sched is None:
            return {"error": "not found"}
        sched.status = status
        sched.updated_at = self.clock.now_ms()
        await self.store.save_schedule(sched)
        await self._emit(ev, schedule=schedule_id)
        return sched.summary()

    async def replay(self, job_id: str) -> dict:
        """Replay a terminal job as a NEW execution (spec §58) — the original is
        never overwritten."""
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        sched = await self._load_schedule(job.schedule_id)
        if sched is None:
            return {"error": "schedule not found"}
        new_job = await self._create_job(
            sched, fire_at=self.clock.now_ms(), manual=True,
            extra_meta={"replay_of": job.id},
        )
        if new_job:
            new_job.replay_of = job.id
            await self.store.save_job(new_job)
        return new_job.summary() if new_job else {"error": "not created"}

    # ── events (spec §23, §44) ──────────────────────────────────────────────
    async def notify_event(self, name: str) -> None:
        """Feed an external event into the trigger matcher. Coalesced so a burst
        becomes one scheduling decision (spec §62)."""
        first = self.coalescer.observe(name, self.clock.now_ms())
        if first:
            self._observed_events.append(name)
        else:
            self.metrics.incr("coalesced_events")
        # wake any job waiting on this event
        await self._wake_waiters(event=name)

    async def wake(self, job_id: str) -> dict:
        """Explicit wake-up for a WAITING job (spec §22)."""
        job = await self._load_job(job_id)
        if job is None:
            return {"error": "not found"}
        if job.status == S.JOB_WAITING:
            job.status = S.JOB_READY
            job.wait_reason = ""
            job.metadata.pop("wake_at_ms", None)
            job.metadata.pop("wait_event", None)
            await self.store.save_job(job)
            await self._emit(EV_JOB_RESUMED, job=job_id)
        return job.summary()

    # ── explainability + observability (spec §49-51) ────────────────────────
    async def explain(self, job_id: str) -> dict:
        """Why is this job in its current state? (spec §51). Prefers the live
        in-memory decision; falls back to the decision persisted on the job so the
        explanation survives a restart."""
        d = self._decisions.get(job_id)
        if d is not None and d.reasons:
            return d.to_dict()
        job = await self._load_job(job_id)
        if job is None:
            return {"jobId": job_id, "decision": "", "reasons": ["job not found"]}
        reasons = list(job.decision_reasons or [])
        if job.wait_reason:
            reasons.append(job.wait_reason)
        if job.last_error:
            reasons.append(f"last error ({job.last_error.get('class', '')}): {job.last_error.get('message', '')}")
        return {"jobId": job_id, "decision": job.decision or job.status, "reasons": reasons or ["no recorded decision"]}

    async def queue_depth(self) -> dict[str, int]:
        # Only work that still needs a worker counts toward backpressure. Counting
        # terminal jobs made the depth monotonically rise to the cap and then
        # refuse *every* new job forever regardless of how idle the queue was.
        open_statuses = tuple(s for s in S.JOB_STATUSES if s not in S.JOB_TERMINAL)
        return await self.store.count_jobs_by_status(statuses=open_statuses)

    async def metrics_snapshot(self) -> dict:
        depth = await self.queue_depth()
        return self.metrics.snapshot(queue_depth=depth, workers={"active": self.pool.used_capacity(),
                                                                  "capacity": self.pool.total_capacity()})

    async def debug_view(self) -> dict:
        """The scheduler debug view (spec §50): workers, queue, upcoming, running,
        recent, and the waiting/retry reasons."""
        depth = await self.queue_depth()
        schedules = [S.Schedule.from_row(r) for r in await self.store.list_schedules(status=S.SCHED_ACTIVE)]
        upcoming = sorted(
            [{"scheduleId": s.id, "runId": s.research_run_id, "nextRunAt": s.next_run_at, "type": s.type}
             for s in schedules if s.next_run_at is not None],
            key=lambda x: x["nextRunAt"],
        )[:10]
        running = [S.ScheduledJob.from_row(r).summary() for r in await self.store.list_jobs(status=[S.JOB_RUNNING, S.JOB_CHECKPOINTING])]
        waiting = [S.ScheduledJob.from_row(r).summary() for r in await self.store.list_jobs(status=[S.JOB_WAITING])]
        retrying = [S.ScheduledJob.from_row(r).summary() for r in await self.store.list_jobs(status=[S.JOB_RETRYING])]
        dlq = [S.ScheduledJob.from_row(r).summary() for r in await self.store.list_jobs(status=[S.JOB_DEAD_LETTER])]
        return {
            "workers": self.pool.snapshot(),
            "queue": depth,
            "upcoming": upcoming,
            "running": running,
            "waiting": waiting,
            "retrying": retrying,
            "deadLetter": dlq,
            "resources": self.resources.snapshot(),
            "metrics": await self.metrics_snapshot(),
        }

    async def list_dead_letters(self) -> list[dict]:
        return await self.list_jobs(status=S.JOB_DEAD_LETTER)

    # ── the wake-up loop (spec §46) ─────────────────────────────────────────
    async def _main_loop(self) -> None:
        try:
            while self._running:
                try:
                    await self._tick()
                except Exception:
                    log.exception("scheduler tick failed")
                await asyncio.sleep(self.config.polling_interval_s)
        except asyncio.CancelledError:
            pass

    async def _tick(self) -> None:
        async with self._tick_lock:
            await self._tick_locked()

    async def _tick_locked(self) -> None:
        now = self.clock.now_ms()
        # consume pending events atomically: swap the list so events that arrive
        # while this tick is awaiting are kept for the next tick, not discarded
        events = self._observed_events
        self._observed_events = []
        await self._reap_stale(now)
        await self._fire_triggers(now, events)
        await self._promote_waiting(now, events)
        await self._expire_overdue(now)
        await self._dispatch(now)

    # ── triggers → jobs (spec §6, §25, §26, §60) ───────────────────────────
    async def _fire_triggers(self, now: int, events: list[str]) -> None:
        schedules = [S.Schedule.from_row(r) for r in await self.store.list_schedules(status=S.SCHED_ACTIVE)]
        dep_states = await self._dependency_states(schedules)
        ctx = TriggerContext(now_ms=now, tz=self.config.timezone, events=events,
                             dependency_states=dep_states)
        for sched in schedules:
            if sched.is_finished():
                await self._complete_schedule(sched)
                continue
            guard = self.runaway.check(sched, now)
            if guard.action == GUARD_PAUSE:
                sched.status = S.SCHED_PAUSED
                await self.store.save_schedule(sched)
                self.metrics.incr("guard_pauses")
                await self._emit(EV_GUARD_THROTTLED, schedule=sched.id, action=guard.action, reason=guard.reason)
                continue
            if guard.action != GUARD_OK:
                self.metrics.incr("guard_throttles")
                self._decisions[sched.id] = S.ScheduleDecision(sched.id, "DEFER", [guard.reason])
                continue

            trig = trigger_for(sched)
            nxt = trig.next_occurrence(ctx)
            if trig.should_trigger(ctx):
                # Single-flight for a schedule bound to a research run: while one
                # of its jobs is still pending or running, do not create another.
                # An INTERVAL schedule re-fires every interval, and the idempotency
                # key uses the fire instant (always fresh), so without this a run
                # that takes hours accumulated hundreds of WAITING jobs that nothing
                # would ever dispatch or expire.
                if sched.research_run_id and await self._has_open_job(sched.id):
                    continue
                fire_at = now
                await self._create_job(sched, fire_at=fire_at)
                # a one-shot or run-limited schedule that just fired its last job
                # is done producing work, regardless of the job still running
                if sched.is_finished():
                    await self._complete_schedule(sched)
            elif nxt is not None and nxt != sched.next_run_at:
                sched.next_run_at = nxt
                sched.updated_at = now
                await self.store.save_schedule(sched)

    async def _create_job(self, sched: S.Schedule, *, fire_at: int, manual: bool = False,
                          extra_meta: dict | None = None) -> S.ScheduledJob | None:
        now = self.clock.now_ms()
        # backpressure (spec §55)
        depth = sum((await self.queue_depth()).values())
        if depth >= self.resources.limits.max_queue_depth:
            self._decisions[sched.id] = S.ScheduleDecision(sched.id, "DEFER",
                                                           ["queue depth limit reached (backpressure)"])
            return None
        # circuit breaker (spec §60)
        allow = self.breaker.allow(sched.id, now)
        if not allow.allowed():
            self.metrics.incr("circuit_breaks")
            self._decisions[sched.id] = S.ScheduleDecision(sched.id, "SKIP", [allow.reason])
            return None
        # idempotency / duplicate prevention (spec §25, §26): a manual trigger and
        # a natural fire of the same instant must not collide, so manual is tagged
        idem = S.idempotency_key(sched.id, fire_at, "manual" if manual else "")
        existing = await self.store.find_job_by_idempotency(idem)
        if existing is not None:
            return None  # this occurrence already produced a job

        job = S.ScheduledJob(
            id=S.make_job_id(),
            schedule_id=sched.id,
            research_run_id=sched.research_run_id,
            status=S.JOB_READY,
            priority=sched.priority,
            scheduled_at=fire_at,
            ready_at=now,
            max_attempts=sched.retry.max_attempts,
            idempotency_key=idem,
            dependency_ids=list(sched.depends_on),
            dep_condition=sched.dep_condition,
            resources=sched.resources,
            created_by="USER" if manual else sched.created_by,
            metadata={"deadline_ms": sched.deadline_ms, **(extra_meta or {}), **dict(sched.metadata or {})},
            created_at=now,
            updated_at=now,
        )
        await self.store.save_job(job)
        sched.run_count += 1
        sched.last_run_at = fire_at
        # Recompute the next fire from this fire's instant. Clear the stale value
        # first: Interval/Cron triggers echo `next_run_at` back when it is already
        # set, so without this the schedule would keep firing on the same past
        # instant and the interval would never advance.
        sched.next_run_at = None
        trig = trigger_for(sched)
        sched.next_run_at = trig.next_occurrence(TriggerContext(now_ms=fire_at, tz=sched.timezone))
        sched.updated_at = now
        await self.store.save_schedule(sched)
        self.runaway.record_fire(sched.id, now)
        self.metrics.incr("jobs_scheduled")
        job.decision = "CREATED"
        job.decision_reasons = [f"{'manual' if manual else sched.type} trigger fired"]
        self._decisions[job.id] = S.ScheduleDecision(job.id, "CREATED", job.decision_reasons)
        await self.store.save_job(job)
        await self._emit(EV_JOB_CREATED, job=job.id, schedule=sched.id, priority=job.priority)
        return job

    # ── waiting / wake-ups (spec §22, §23) ─────────────────────────────────
    async def _promote_waiting(self, now: int, events: list[str] | None = None) -> None:
        events = events or []
        waiting = [S.ScheduledJob.from_row(r) for r in await self.store.list_jobs(status=[S.JOB_WAITING])]
        for job in waiting:
            wake_at = job.metadata.get("wake_at_ms") if isinstance(job.metadata, dict) else None
            wait_event = job.metadata.get("wait_event") if isinstance(job.metadata, dict) else None
            transient = bool(job.metadata.get("retry_transient")) if isinstance(job.metadata, dict) else False
            ready = False
            if wake_at is not None and now >= int(wake_at):
                ready = True
            if wait_event and wait_event in events:
                ready = True
            if transient:
                # blocked only on resources/lease — re-eligible as soon as the next
                # tick runs, no clock dependency (a frozen/coarse clock must not
                # strand it). Dispatched again only if capacity has since freed.
                ready = True
            if job.dependency_ids and await self._deps_satisfied(job):
                ready = True
            if ready:
                job.status = S.JOB_READY
                job.wait_reason = ""
                job.metadata.pop("wake_at_ms", None)
                job.metadata.pop("wait_event", None)
                job.metadata.pop("retry_transient", None)
                await self.store.save_job(job)

    async def _wake_waiters(self, *, event: str) -> None:
        waiting = [S.ScheduledJob.from_row(r) for r in await self.store.list_jobs(status=[S.JOB_WAITING])]
        for job in waiting:
            if isinstance(job.metadata, dict) and job.metadata.get("wait_event") == event:
                job.status = S.JOB_READY
                job.wait_reason = ""
                job.metadata.pop("wait_event", None)
                await self.store.save_job(job)
                await self._emit(EV_JOB_RESUMED, job=job.id, event=event)

    async def _expire_overdue(self, now: int) -> None:
        """Mark jobs past their deadline EXPIRED (spec §29) — never silently stop
        research, only flag the job."""
        rows = await self.store.list_jobs(status=[S.JOB_READY, S.JOB_SCHEDULED, S.JOB_QUEUED, S.JOB_WAITING])
        for r in rows:
            job = S.ScheduledJob.from_row(r)
            deadline = job.metadata.get("deadline_ms") if isinstance(job.metadata, dict) else None
            if deadline and now > int(deadline):
                job.status = S.JOB_EXPIRED
                job.completed_at = now
                await self.store.save_job(job)
                self.metrics.incr("jobs_expired")
                await self._emit(EV_JOB_EXPIRED, job=job.id)

    # ── dispatch (spec §9, §10, §30, §31) ───────────────────────────────────
    async def _dispatch(self, now: int) -> None:
        if not self.pool.has_capacity():
            return
        candidates = await self._ready_candidates(now)
        if not candidates:
            return
        ctx = SchedulingContext(now_ms=now, capacity=self.pool.total_capacity() - self.pool.used_capacity())
        while candidates and self.pool.has_capacity():
            job = self.policy.select_next(candidates, ctx)
            if job is None:
                break
            candidates.remove(job)
            worker = self.pool.pick()
            if worker is None:
                break
            sched = await self._load_schedule(job.schedule_id)
            if sched is None:
                # an orphaned job — fail it rather than spin
                job.status = S.JOB_FAILED
                job.last_error = {"class": S.NON_RETRYABLE, "kind": "ORPHANED", "message": "schedule gone"}
                await self.store.save_job(job)
                continue

            # dependency gate (spec §56)
            if job.dependency_ids and not await self._deps_satisfied(job):
                await self._mark_waiting(job, ["waiting for dependencies"], wait_event="")
                continue

            ok, reasons = self.resources.try_reserve(job, run_limit=sched.concurrency.limit())
            if not ok:
                await self._mark_waiting(job, reasons, transient=True)
                continue
            lease = await self.lease_mgr.acquire(job, worker.id)
            if lease is None:
                self.resources.release(job)
                await self._mark_waiting(job, ["job leased by another worker"], transient=True)
                continue

            job.status = S.JOB_RUNNING
            job.started_at = now
            job.worker_id = worker.id
            job.lease_id = lease.lease_id
            job.wait_reason = ""
            job.decision = "RUN"
            job.decision_reasons = [f"dispatched to {worker.id}", f"lease {lease.lease_id}"]
            self._decisions[job.id] = S.ScheduleDecision(job.id, "RUN", job.decision_reasons)
            await self.store.save_job(job)
            self.metrics.observe_queue_latency(now - job.scheduled_at)
            await self._emit(EV_JOB_STARTED, job=job.id, worker=worker.id)

            task = asyncio.create_task(self._dispatch_one(job, sched, worker, lease))
            self._inflight[job.id] = task
            task.add_done_callback(lambda _t, jid=job.id: self._inflight.pop(jid, None))

    async def _dispatch_one(self, job: S.ScheduledJob, sched: S.Schedule, worker, lease) -> None:
        started = self.clock.now_ms()
        attempt = S.ExecutionAttempt(
            id=S.make_attempt_id(), job_id=job.id, worker_id=worker.id,
            attempt=job.attempt + 1, started_at=started,
        )
        hb = asyncio.create_task(self._heartbeat_job(lease))
        try:
            result = await worker.run(job, sched)
        except asyncio.CancelledError:
            hb.cancel()
            await self._release_claim(job, lease)
            raise
        except Exception as exc:
            log.exception("worker raised for job %s", job.id)
            from .retry import serialize_error

            err = serialize_error(exc)
            result = ExecutionResult(outcome="failed", failure_kind=err["kind"], failure_message=err["message"])
        finally:
            hb.cancel()
            await _safe_await(hb)

        attempt.finished_at = self.clock.now_ms()
        self.metrics.observe_execution(attempt.finished_at - started)
        await self._finish(job, sched, attempt, result)

    async def _finish(self, job: S.ScheduledJob, sched: S.Schedule, attempt: S.ExecutionAttempt,
                      result: ExecutionResult) -> None:
        self.resources.release(job)
        await self.lease_mgr.release(await self._lease_for(job))
        now = self.clock.now_ms()

        if result.outcome == "completed":
            job.status = S.JOB_COMPLETED
            job.completed_at = now
            job.checkpoint_iteration = result.iteration_to
            attempt.outcome = "completed"
            attempt.iteration_from = result.iteration_from
            attempt.iteration_to = result.iteration_to
            self.breaker.record_success(job.schedule_id)
            self.metrics.incr("jobs_completed")
            await self._emit(EV_JOB_COMPLETED, job=job.id, iteration=result.iteration_to)
            if sched.is_finished():
                await self._complete_schedule(sched)
        elif result.outcome == "cancelled":
            job.status = S.JOB_CANCELLED
            job.completed_at = now
            attempt.outcome = "cancelled"
            self.metrics.incr("jobs_cancelled")
            await self._emit(EV_JOB_CANCELLED, job=job.id)
        elif result.outcome == "waiting":
            job.status = S.JOB_WAITING
            if result.waiting_until_ms is not None:
                job.metadata["wake_at_ms"] = result.waiting_until_ms
                job.wait_reason = f"wake at {T.human(result.waiting_until_ms, sched.timezone)}"
            elif result.wait_event:
                job.metadata["wait_event"] = result.wait_event
                job.wait_reason = f"waiting for event '{result.wait_event}'"
            attempt.outcome = "waiting"
            self.metrics.incr("jobs_completed")
            await self._emit(EV_JOB_WAITING, job=job.id, reason=job.wait_reason)
        else:  # failed / blocked
            cls, kind, msg = classify_result(result.failure_kind, result.failure_message)
            job.last_error = {"class": cls, "kind": kind, "message": msg, "retryable": cls != S.NON_RETRYABLE}
            attempt.outcome = "failed"
            attempt.error_class = cls
            attempt.error_kind = kind
            attempt.error_message = msg
            self.breaker.record_failure(job.schedule_id, now)
            next_attempt = job.attempt + 1
            if should_retry(sched.retry, next_attempt, cls):
                job.attempt = next_attempt
                job.status = S.JOB_RETRYING
                delay = backoff_delay_ms(sched.retry, next_attempt)
                job.metadata["retry_at_ms"] = now + delay
                self.metrics.incr("jobs_retried")
                self._decisions[job.id] = S.ScheduleDecision(
                    job.id, "RETRY", [f"{cls} failure", f"retry {next_attempt}/{sched.retry.max_attempts}"],
                    next_attempt_at=now + delay,
                )
                await self._emit(EV_JOB_RETRYING, job=job.id, attempt=next_attempt, delayMs=delay)
            else:
                if cls == S.NON_RETRYABLE:
                    job.status = S.JOB_FAILED
                    self.metrics.incr("jobs_failed")
                    await self._emit(EV_JOB_FAILED, job=job.id, error=msg)
                else:
                    job.status = S.JOB_DEAD_LETTER
                    self.metrics.incr("jobs_dead_lettered")
                    await self._emit(EV_JOB_DEAD_LETTERED, job=job.id, attempts=next_attempt)

        await self.store.save_attempt(attempt)
        await self.store.save_job(job)

    # ── retry promotion ─────────────────────────────────────────────────────
    async def _ready_candidates(self, now: int) -> list[S.ScheduledJob]:
        rows = await self.store.list_jobs(status=[S.JOB_READY, S.JOB_QUEUED, S.JOB_RETRYING])
        out: list[S.ScheduledJob] = []
        for r in rows:
            job = S.ScheduledJob.from_row(r)
            if job.status == S.JOB_RETRYING:
                retry_at = job.metadata.get("retry_at_ms") if isinstance(job.metadata, dict) else None
                if retry_at is not None and now < int(retry_at):
                    continue
            elif job.status == S.JOB_READY:
                if job.ready_at is not None and now < job.ready_at:
                    continue
            out.append(job)
        return out

    async def _mark_waiting(self, job: S.ScheduledJob, reasons: list[str], *, wait_event: str = "",
                            transient: bool = False) -> None:
        job.status = S.JOB_WAITING
        job.wait_reason = "; ".join(reasons)
        if wait_event:
            job.metadata["wait_event"] = wait_event
        if transient and isinstance(job.metadata, dict):
            # A wait on a *transient* condition (resources busy, lease held) can
            # clear at any moment, so it must be re-eligible on the next tick —
            # otherwise `_promote_waiting` never promotes it and the job is
            # stranded WAITING forever (the pileup this replaces).
            job.metadata["retry_transient"] = True
        self._decisions[job.id] = S.ScheduleDecision(job.id, "WAIT", reasons)
        await self.store.save_job(job)
        await self._emit(EV_JOB_WAITING, job=job.id, reason=job.wait_reason)

    async def _has_open_job(self, schedule_id: str) -> bool:
        """True when a schedule already has a job that is neither finished nor
        paused — so firing again would stack a duplicate occurrence."""
        rows = await self.store.list_jobs(schedule_id=schedule_id, status=list(_OPEN_JOB_STATUSES), limit=1)
        return bool(rows)

    # ── recovery (spec §14, §42, §47, §54) ─────────────────────────────────
    async def _recover(self) -> None:
        now = self.clock.now_ms()
        # 1. stale workers
        workers = await self.store.list_workers()
        for w in workers:
            rec = S.WorkerRecord.from_row(w)
            if rec.is_stale(now, self.config.stale_worker_ms):
                rec.status = "STALE"
                await self.store.save_worker(rec)
                await self._emit(EV_WORKER_STALE, worker=rec.id)
        # 2. active jobs with a dead/expired/absent lease → recover
        active = [S.ScheduledJob.from_row(r) for r in await self.store.list_jobs(status=[S.JOB_RUNNING, S.JOB_CHECKPOINTING])]
        for job in active:
            lease = await self.lease_mgr.held_by(job.id)
            lease_expired = lease is None or lease.is_expired(now)
            worker_stale = False
            if lease is not None:
                wrec = await self.store.get_worker(lease.worker_id)
                worker_stale = bool(wrec) and S.WorkerRecord.from_row(wrec).is_stale(now, self.config.stale_worker_ms)
            if not (lease_expired or worker_stale):
                continue  # a live worker is on it (shouldn't happen at startup, but be safe)
            await self._recover_job(job, lease_expired=lease_expired, worker_stale=worker_stale, process_restarted=True)
        # 3. rebuild resource counters from durable active jobs
        still_active = [S.ScheduledJob.from_row(r) for r in await self.store.list_jobs(status=[S.JOB_RUNNING, S.JOB_CHECKPOINTING])]
        self.resources.rehydrate(still_active)
        # 4. promote due waiting jobs
        await self._promote_waiting(now)

    async def _reap_stale(self, now: int) -> None:
        """Runs each tick: recover jobs whose lease expired while the worker that
        held it is gone (spec §13, §42)."""
        for row in await self.store.list_leases():
            lease = S.ExecutionLease.from_row(row)
            if not lease.is_expired(now):
                continue
            job = await self._load_job(lease.job_id)
            if job is None or not job.is_active():
                await self.store.delete_lease(lease.job_id)
                continue
            await self._recover_job(job, lease_expired=True, worker_stale=True)

    async def _recover_job(self, job: S.ScheduledJob, *, lease_expired: bool, worker_stale: bool,
                           process_restarted: bool = False) -> None:
        decision = self.recovery.recover(
            job, RecoveryContext(now_ms=self.clock.now_ms(), lease_expired=lease_expired,
                                 worker_stale=worker_stale, process_restarted=process_restarted,
                                 attempts=job.attempt, max_attempts=job.max_attempts)
        )
        await self.lease_mgr.release(await self._lease_for(job))
        self.resources.release(job)
        self.metrics.incr("jobs_recovered")
        self.metrics.incr("lease_expirations")
        job.decision = decision.action
        job.decision_reasons = decision.reasons or [decision.reason]
        self._decisions[job.id] = S.ScheduleDecision(job.id, decision.action, job.decision_reasons)
        if decision.action == "REQUEUE":
            job.attempt += 1
            job.status = S.JOB_READY
            job.worker_id = ""
            job.lease_id = ""
        elif decision.action == "MARK_DEAD_LETTER":
            job.status = S.JOB_DEAD_LETTER
            self.metrics.incr("jobs_dead_lettered")
        else:
            job.status = S.JOB_FAILED
            self.metrics.incr("jobs_failed")
        await self.store.save_job(job)
        await self._emit(EV_JOB_RECOVERED, job=job.id, action=decision.action, reason=decision.reason)
        await self._emit(EV_LEASE_EXPIRED, job=job.id)

    # ── heartbeats (spec §13) ───────────────────────────────────────────────
    async def _heartbeat_loop(self) -> None:
        """Keeps this process' workers' records fresh so they are not seen as
        stale, and renews the leases of jobs this process is running."""
        try:
            while self._running:
                now = self.clock.now_ms()
                for w in self.pool.workers:
                    rec = await self.store.get_worker(w.id)
                    if rec is None:
                        await self._register_worker(w.id, w.max_concurrency, w.capabilities)
                    else:
                        r = S.WorkerRecord.from_row(rec)
                        r.last_heartbeat_at = now
                        r.status = "BUSY" if w.active else "IDLE"
                        r.active_jobs = w.active
                        await self.store.save_worker(r)
                await asyncio.sleep(self.config.heartbeat_ms / 1000)
        except asyncio.CancelledError:
            pass

    async def _heartbeat_job(self, lease: S.ExecutionLease) -> None:
        try:
            while True:
                await asyncio.sleep(self.config.heartbeat_ms / 1000)
                await self.lease_mgr.heartbeat(lease)
        except asyncio.CancelledError:
            pass

    # ── helpers ─────────────────────────────────────────────────────────────
    async def _ensure_workers(self) -> None:
        if not self.pool.workers:
            for i in range(max(1, self.config.max_workers)):
                wid = f"worker-{i + 1:02d}"
                self.pool.add(FunctionWorker(wid, self._run_segment, max_concurrency=self.config.worker_concurrency))
        for w in self.pool.workers:
            await self._register_worker(w.id, w.max_concurrency, w.capabilities)
            self.metrics.incr("workers_started")
            await self._emit(EV_WORKER_STARTED, worker=w.id)

    async def _register_worker(self, worker_id: str, max_concurrency: int, capabilities: list[str]) -> None:
        rec = S.WorkerRecord(id=worker_id, max_concurrency=max_concurrency,
                             capabilities=capabilities, status="IDLE")
        await self.store.save_worker(rec)

    async def _mark_worker(self, worker_id: str, status: str) -> None:
        rec = await self.store.get_worker(worker_id)
        if rec is None:
            return
        r = S.WorkerRecord.from_row(rec)
        r.status = status
        r.stopped_at = self.clock.now_ms()
        await self.store.save_worker(r)

    async def _run_segment(self, job: S.ScheduledJob, sched: S.Schedule) -> ExecutionResult:
        """Bridge to the research execution. Without a driver a job completes as a
        no-op (the honest behaviour for a scheduler started without an executor)."""
        if self.driver is None:
            return ExecutionResult(outcome="completed", detail={"no_driver": True})
        return await self.driver.drive(job, sched)

    async def _lease_for(self, job: S.ScheduledJob) -> S.ExecutionLease | None:
        return await self.lease_mgr.held_by(job.id)

    async def _release_claim(self, job: S.ScheduledJob, lease: S.ExecutionLease | None = None) -> None:
        await self.lease_mgr.release(lease if lease is not None else await self._lease_for(job))

    async def _deps_satisfied(self, job: S.ScheduledJob) -> bool:
        from .triggers import _condition_met

        for dep in job.dependency_ids:
            row = await self.store.get_job(dep)
            if row is None:
                return False
            status = row["status"]
            if not _condition_met(job.dep_condition, status):
                return False
        return True

    async def _dependency_states(self, schedules: list[S.Schedule]) -> dict[str, str]:
        needed: set[str] = set()
        for s in schedules:
            needed.update(s.depends_on)
        out: dict[str, str] = {}
        for dep in needed:
            row = await self.store.get_job(dep)
            if row is not None:
                out[dep] = row["status"]
        return out

    async def _complete_schedule(self, sched: S.Schedule) -> None:
        if sched.status in (S.SCHED_COMPLETED, S.SCHED_CANCELLED):
            return
        sched.status = S.SCHED_COMPLETED
        sched.updated_at = self.clock.now_ms()
        await self.store.save_schedule(sched)
        await self._emit(EV_SCHEDULE_COMPLETED, schedule=sched.id)

    async def _load_job(self, job_id: str) -> S.ScheduledJob | None:
        row = await self.store.get_job(job_id)
        return S.ScheduledJob.from_row(row) if row else None

    async def _load_schedule(self, schedule_id: str) -> S.Schedule | None:
        row = await self.store.get_schedule(schedule_id)
        return S.Schedule.from_row(row) if row else None

    async def _emit(self, type_: str, **data: Any) -> None:
        ev = {"type": type_, "ts": self.clock.now_ms(), "data": data}
        try:
            await self.store.record_sched_event(S.make_attempt_id(), type_, ts=ev["ts"],
                                                job_id=str(data.get("job", "")),
                                                schedule_id=str(data.get("schedule", "")), **{k: v for k, v in data.items() if k not in ("job", "schedule")})
        except Exception:  # noqa: BLE001 — observability must not break scheduling
            log.debug("failed to persist scheduler event %s", type_)
        for q in list(self._subscribers):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass

    def _validate(self, request: ScheduleRequest) -> None:
        from . import cron as cronlib

        if request.type not in S.SCHEDULE_TYPES:
            raise ValueError(f"unknown schedule type {request.type!r}")
        if request.type == S.TYPE_CRON and not cronlib.is_valid(request.cron):
            raise ValueError(f"invalid cron expression: {request.cron!r}")
        if request.type == S.TYPE_INTERVAL and request.interval_s <= 0:
            raise ValueError("INTERVAL requires interval_s > 0")
        if request.type == S.TYPE_EVENT and not request.event:
            raise ValueError("EVENT requires an event name")
        if request.type == S.TYPE_DEPENDENCY and not request.depends_on:
            raise ValueError("DEPENDENCY requires depends_on")
        if request.type == S.TYPE_ONCE and _to_ms(request.at) is None:
            raise ValueError("ONCE requires `at`")
        if request.priority not in S.PRIORITIES:
            raise ValueError(f"unknown priority {request.priority!r}")


# a registry of Scheduler subclasses, for a deployment that wants a custom core
SCHEDULER_REGISTRY: Registry[type[Scheduler]] = Registry("scheduler")
SCHEDULER_REGISTRY.register("default", Scheduler)


def _as_retry(value: Any, config: SchedulerConfig) -> S.RetryPolicy:
    if isinstance(value, S.RetryPolicy):
        return value
    if isinstance(value, dict):
        return S.RetryPolicy.from_dict(value)
    return S.RetryPolicy(
        max_attempts=config.max_attempts,
        strategy=config.retry_policy,
        base_delay_ms=config.base_retry_delay_ms,
        max_delay_ms=config.max_retry_delay_ms,
    )


def _as_concurrency(value: Any) -> S.ConcurrencyPolicy:
    if isinstance(value, S.ConcurrencyPolicy):
        return value
    if isinstance(value, dict):
        return S.ConcurrencyPolicy.from_dict(value)
    return S.ConcurrencyPolicy()


def _as_resources(value: Any) -> S.ResourceRequirements:
    if isinstance(value, S.ResourceRequirements):
        return value
    if isinstance(value, dict):
        return S.ResourceRequirements.from_dict(value)
    return S.ResourceRequirements()


async def _safe_await(task: asyncio.Task | None) -> None:
    """Await a task, swallowing cancellation and any error — used only for
    background loops at shutdown, where a raised error must not mask the others."""
    if task is None:
        return
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        log.debug("background task raised during shutdown", exc_info=True)
