"""Regression tests for the system-audit fixes.

Each test pins a defect found in the full-system audit so it cannot silently
return. They are grouped by the bug they lock down:

  - candidate hygiene      (D1/R1: unbounded duplicate candidates, oldest-first ranking)
  - knowledge corruption   (R2: contradicts always None; K1: frozen `_today`)
  - scheduler durability   (S1: backpressure counts terminal jobs; S2: lease TOCTOU)
  - loop termination       (contradiction alone must not reset the low-value streak)
  - chat reliability       (C1/C2: retry middleware must be transient-only + raise)
  - small audit items      (R7 missing-result kind; R9 unknowns_resolved;
                            terminal killpg; store subquery-safe table parsing)

    cd apps/agent && .venv/bin/python -m unittest tests.test_audit_fixes -v
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.test_research_loop import ResearchTestCase  # noqa: E402


# ── candidate hygiene (D1 / R1) ──────────────────────────────────────────────

class TestCandidateDedup(unittest.TestCase):
    def test_dedup_drops_known_and_intra_duplicates(self):
        """The generator re-derives the same questions every cycle; a question the
        run already recorded must be dropped, and duplicates within one batch too."""
        from agent.research.candidates import dedup_against_known, question_key
        from agent.research import models as M

        def cand(q: str) -> M.ResearchCandidate:
            return M.ResearchCandidate(id=M.new_id("cand_"), question=q)

        known = {question_key("What is MEV?")}
        batch = [cand("What is MEV?"), cand("How is MEV extracted?"), cand("how  is  mev extracted?")]
        out = dedup_against_known(batch, known)
        self.assertEqual([c.question for c in out], ["How is MEV extracted?"],
                         "known questions and normalized duplicates must be dropped")

    def test_dedup_keeps_fresh_questions(self):
        from agent.research.candidates import dedup_against_known
        from agent.research import models as M

        batch = [M.ResearchCandidate(id="c1", question="New question A"),
                 M.ResearchCandidate(id="c2", question="New question B")]
        self.assertEqual(len(dedup_against_known(batch, set())), 2)


# ── knowledge corruption (R2 / K1) ───────────────────────────────────────────

class TestUpdaterContradicts(unittest.TestCase):
    def _updater(self):
        from agent.research.updater import KnowledgeManagerUpdater

        captured: dict = {}

        class FakeKM:
            def create_knowledge(self, **kw):
                captured.update(kw)
                return {"action": "CREATE", "id": "node-x"}

            def add_evidence(self, *a, **k): ...
            def verify(self, *a, **k): ...
            def update_knowledge(self, *a, **k): ...
            def create_unknown(self, *a, **k):
                return {"id": "u"}

        return KnowledgeManagerUpdater(FakeKM()), captured

    def test_conflict_targets_are_forwarded_as_contradicts(self):
        """A candidate that targets a known conflict must hand that target to the
        manager, so the conflict path can fire (it was dead: always None)."""
        import asyncio
        from agent.research import models as M

        updater, captured = self._updater()
        result = M.ResearchResult(id="res_1", candidate_id="cand_1", iteration_id="", strategy="direct",
                                  observations=[{"statement": "x", "source": "s"}])
        evaluation = M.Evaluation()
        run = M.ResearchRun(id="run_1", objective=M.Objective(statement="o"))
        asyncio.run(updater.update(result, evaluation, run, conflict_targets=["known-conflict"]))
        self.assertEqual(captured.get("contradicts"), ["known-conflict"])

    def test_no_conflict_target_means_none_not_broken_slice(self):
        import asyncio
        from agent.research import models as M

        updater, captured = self._updater()
        result = M.ResearchResult(id="res_2", candidate_id="cand_2", iteration_id="", strategy="direct",
                                  observations=[{"statement": "x", "source": "s"}])
        run = M.ResearchRun(id="run_2", objective=M.Objective(statement="o"))
        asyncio.run(updater.update(result, M.Evaluation(), run))
        self.assertIsNone(captured.get("contradicts"))


class TestManagerTodayPerCall(unittest.TestCase):
    def test_today_is_recomputed_not_frozen(self):
        """`_today` must reflect the current date on every access — the process-wide
        manager used to cache it at construction, mis-dating every later write."""
        import agent.knowledge.manager as mgr

        class _Date:
            def __init__(self, s): self._s = s
            def isoformat(self): return self._s

        class _DT:
            def __init__(self, s): self._s = s
            def now(self, tz=None): return self
            def date(self): return _Date(self._s)

        km = mgr.KnowledgeManager()
        with mock.patch.object(mgr, "datetime", _DT("2099-01-01")):
            self.assertEqual(km._today, "2099-01-01")
        with mock.patch.object(mgr, "datetime", _DT("2099-06-15")):
            self.assertEqual(km._today, "2099-06-15", "date must not be cached from the first read")

    def test_explicit_now_is_pinned_for_tests(self):
        import agent.knowledge.manager as mgr
        from datetime import date

        km = mgr.KnowledgeManager(now=date(2020, 5, 4))
        self.assertEqual(km._today, "2020-05-04")


# ── loop termination (progress durable rule) ─────────────────────────────────

class TestProgressDurable(unittest.TestCase):
    def test_contradiction_alone_does_not_reset_streak(self):
        """Surfacing a conflict is not durable knowledge growth: a run that only
        ever finds conflicts must still plateau and stop."""
        from agent.research.progress import ProgressEvaluator
        from agent.research import models as M

        pe = ProgressEvaluator(min_useful_info_gain=0.15)
        progress = M.Progress()
        ev = M.Evaluation(info_gain=0.7, contradiction_created=True)
        for _ in range(5):
            progress = pe.apply(progress, ev, updates=[])
        self.assertGreaterEqual(progress.low_value_streak, 5,
                                "contradiction-only iterations must raise the low-value streak")
        self.assertEqual(progress.conflicts_found, 5, "conflicts are still counted")

    def test_new_node_resets_streak(self):
        from agent.research.progress import ProgressEvaluator
        from agent.research import models as M

        pe = ProgressEvaluator(min_useful_info_gain=0.15)
        progress = M.Progress(low_value_streak=4)
        progress = pe.apply(progress, M.Evaluation(info_gain=0.7), updates=[{"op": "create"}])
        self.assertEqual(progress.low_value_streak, 0)


# ── chat reliability (C1 / C2) ───────────────────────────────────────────────

class TestGraphRetryMiddleware(unittest.TestCase):
    def test_graph_uses_transient_only_and_raises(self):
        from agent import graph
        from agent.middleware import is_transient_upstream_error

        with mock.patch.object(graph, "RETRY_MAX", 2):
            mws = graph._retry_middleware()
        self.assertEqual(len(mws), 2)
        for mw in mws:
            self.assertEqual(mw.on_failure, "error",
                             "a permanent failure must raise, not render as a normal reply")
            self.assertIs(mw.retry_on, is_transient_upstream_error,
                          "only transient upstream errors may be retried")


# ── scheduler durability (S1 / S2) ───────────────────────────────────────────

class StoreTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="audit-test-"))
        os.environ["AGENT_DATA_DIR"] = str(self.tmp / "data")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def _store(self):
        from agent.research.store import ResearchStore

        store = await ResearchStore.open()
        self.addAsyncCleanup(store.close)
        return store


class TestBackpressureIgnoresTerminal(StoreTestCase):
    async def test_queue_depth_excludes_terminal_jobs(self):
        """A completed job must not count toward queue depth, or the cap refuses
        all new work once enough jobs have ever run."""
        from agent.research.scheduler import model as S

        store = await self._store()
        for i in range(5):
            await store.save_job(S.ScheduledJob(id=f"done{i}", schedule_id="s", research_run_id="r",
                                                status=S.JOB_COMPLETED))
        for i in range(3):
            await store.save_job(S.ScheduledJob(id=f"open{i}", schedule_id="s", research_run_id="r",
                                                status=S.JOB_READY))
        all_counts = await store.count_jobs_by_status()
        self.assertEqual(all_counts.get(S.JOB_COMPLETED), 5)
        open_statuses = tuple(s for s in S.JOB_STATUSES if s not in S.JOB_TERMINAL)
        open_counts = await store.count_jobs_by_status(statuses=open_statuses)
        self.assertEqual(sum(open_counts.values()), 3, "terminal jobs must be excluded")
        self.assertNotIn(S.JOB_COMPLETED, open_counts)


class TestLeaseAtomicity(StoreTestCase):
    async def test_second_acquirer_loses_until_expiry(self):
        """The lease claim is a single conditional upsert: two racers cannot both
        win, and only an expired lease may be re-taken."""
        from agent.research.scheduler import model as S

        store = await self._store()
        def lease(wid):
            return S.ExecutionLease(job_id="job1", worker_id=wid, lease_id=S.make_lease_id(),
                                    acquired_at=0, expires_at=0, heartbeat_at=0)
        a = lease("A"); a.acquired_at = 1000; a.expires_at = 1060
        b = lease("B"); b.acquired_at = 1010; b.expires_at = 1070

        self.assertTrue(await store.acquire_lease(a, now=1000), "first claim must win")
        self.assertFalse(await store.acquire_lease(b, now=1010), "a live lease must block a second claimant")
        held = S.ExecutionLease.from_row(await store.get_lease("job1"))
        self.assertEqual(held.worker_id, "A")

        c = lease("C"); c.acquired_at = 1100; c.expires_at = 1160
        self.assertTrue(await store.acquire_lease(c, now=1100), "an expired lease must be reclaimable")
        held = S.ExecutionLease.from_row(await store.get_lease("job1"))
        self.assertEqual(held.worker_id, "C")


class TestCandidateStoreHelpers(StoreTestCase):
    async def test_newest_first_ordering_and_retire(self):
        from agent.research import models as M

        store = await self._store()
        run_id = "run_1"
        cands = [M.ResearchCandidate(id=f"c{i}", question=f"Question {i}", created_at=1000 + i) for i in range(5)]
        # two rows share a question — the duplicate the generator keeps re-adding
        cands.append(M.ResearchCandidate(id="dup", question="Question 2", created_at=2000))
        await store.save_candidates(run_id, cands)

        newest = await store.list_candidates(run_id, status="open", newest_first=True, limit=2)
        self.assertEqual([c.id for c in newest], ["dup", "c4"],
                         "newest_first must surface the freshly-added rows, not the oldest")

        keys = await store.candidate_question_keys(run_id)
        self.assertEqual(len(keys), 5, "5 distinct questions across 6 rows")

        n = await store.retire_duplicate_candidates(run_id, "question 2", keep_id="c2")
        self.assertEqual(n, 1, "the duplicate of the chosen question must be retired")
        self.assertTrue(await store.get_candidate("dup"))
        self.assertEqual((await store.get_candidate("dup")).status, "abandoned")
        self.assertEqual((await store.get_candidate("c2")).status, "open")


# ── small audit items (R7 / R9 / terminal / store) ───────────────────────────

class TestMissingResultKind(ResearchTestCase):
    async def test_missing_result_is_marked_transient(self):
        """`_stage_analyze_result` with no stored result must build a *transient*
        failure (FAIL_TOOL). FAIL_NONE made nextaction read it as non-transient and
        CONTINUE, dropping the iteration as if it had succeeded."""
        from agent.research import models as M

        _store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})
        # force the missing-result branch: a result id that resolves to nothing
        run.metadata["current_result_id"] = "res_missing"
        await loop._stage_analyze_result(run)
        ev = M.Evaluation.from_dict(run.metadata.get("evaluation", {}))
        self.assertTrue(ev.failed)
        self.assertIn(ev.failure_kind, (M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT),
                      "a missing result must be a transient failure kind")


class TestUnknownsResolvedNotVerified(unittest.TestCase):
    def test_verified_is_not_counted_as_resolved(self):
        from agent.research.progress import ProgressEvaluator
        from agent.research import models as M

        pe = ProgressEvaluator()
        progress = M.Progress()
        pe.apply(progress, M.Evaluation(new_evidence=True), updates=[{"op": "verified"}])
        self.assertEqual(progress.unknowns_resolved, 0, "a verified node is not a resolved unknown")
        pe.apply(progress, M.Evaluation(), updates=[{"op": "resolved"}])
        self.assertEqual(progress.unknowns_resolved, 1, "a real resolution is counted")


class TestTerminalKillsProcessGroup(unittest.TestCase):
    @staticmethod
    def _live_members(pgid: int) -> list[str]:
        # states R/S/D mean actually alive; Z (zombie) is already dead and reaped
        # asynchronously, so a lingering zombie is not a leak.
        out = []
        for p in os.listdir("/proc"):
            if not p.isdigit():
                continue
            try:
                with open(f"/proc/{p}/stat") as fh:
                    raw = fh.read()
            except Exception:
                continue
            # the comm field is parenthesised and may contain spaces/parens; parse
            # the fields after its final ')' — state, ppid, pgrp — robustly.
            rest = raw[raw.rfind(")") + 2:].split()
            if len(rest) >= 3 and int(rest[2]) == pgid and rest[0] in ("R", "S", "D"):
                out.append(p)
        return out

    def test_backgrounded_grandchild_is_killed_on_timeout(self):
        """A timed-out command must be bounded by its timeout. The backgrounded
        grandchild inherits the stdout/stderr pipes, so `proc.kill()` (child only)
        left `communicate()` blocked until the grandchild exited on its own — the
        timeout stopped bounding the call. A whole-group kill returns promptly."""
        import subprocess
        import time
        from agent.tools import terminal as T

        # grandchild lives 5s: with killpg the call returns in ~1s; with the old
        # proc.kill it blocks for the full 5s waiting on the inherited pipes.
        proc = subprocess.Popen("sleep 5 & sleep 5", shell=True, start_new_session=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        t0 = time.monotonic()
        out = T._collect(proc, timeout_s=1)
        elapsed = time.monotonic() - t0
        self.assertTrue(out["timedOut"])
        self.assertLess(elapsed, 3.0,
                        "the timed-out call kept running past its timeout (grandchild left alive)")
        live: list[str] = []
        for _ in range(20):
            live = self._live_members(proc.pid)
            if not live:
                break
            time.sleep(0.1)
        self.assertEqual(live, [], "a backgrounded grandchild survived the timeout")


# ── dead-code cleanup + wiring (R6) ──────────────────────────────────────────

class TestShouldRetryHonored(unittest.TestCase):
    def test_should_retry_flag_is_honored(self):
        """R6: the analyzer's `Evaluation.should_retry` must be read by the next
        action, not silently ignored. A failed eval whose kind is outside the
        hardcoded transient set but that the analyzer flagged for retry must
        RETRY; one that is not flagged and has a non-transient kind must NOT."""
        from agent.research.nextaction import DefaultNextActionSelector
        from agent.research import models as M

        sel = DefaultNextActionSelector()
        run = M.ResearchRun(id="r", objective=M.Objective(statement="o"))
        flagged = M.Evaluation(failed=True, failure_kind=M.FAIL_NONE, should_retry=True)
        a = sel.select(evaluation=flagged, stop=None, run=run, attempts_on_question=0,
                       max_attempts=4, branch_depth=0, max_branch_depth=2)
        self.assertEqual(a.action, M.ACTION_RETRY, "a flagged retry must be honoured")

        not_flagged = M.Evaluation(failed=True, failure_kind=M.FAIL_NONE, should_retry=False)
        b = sel.select(evaluation=not_flagged, stop=None, run=run, attempts_on_question=0,
                       max_attempts=4, branch_depth=0, max_branch_depth=2)
        self.assertEqual(b.action, M.ACTION_CONTINUE)


class TestPrioritizerHasNoDeadSignal(unittest.TestCase):
    def test_breakdown_excludes_dependency_impact(self):
        """R5: `dependency_impact` was a dead term (candidates never populate
        `dependencies`), so it must not appear in the score breakdown or weights."""
        import asyncio
        from agent.research.prioritizer import WeightedPrioritizer, Weights
        from agent.research.context import ResearchContext
        from agent.research import models as M

        self.assertFalse(hasattr(Weights(), "dependency_impact"))
        cand = M.ResearchCandidate(id="c1", question="What is MEV?")
        ctx = ResearchContext(run_id="r", objective=M.Objective(statement="Understand MEV"), iteration=1)
        ranked = asyncio.run(WeightedPrioritizer().rank([cand], ctx))
        self.assertEqual(len(ranked), 1)
        self.assertNotIn("dependency_impact", ranked[0].breakdown)


class TestStoreTableParsing(StoreTestCase):
    async def test_subquery_still_decodes_json_columns(self):
        """`_decode` must resolve the real table through a subquery. The old
        `sql.split('FROM')[1].split()[0]` yielded '(SELECT', so JSON columns stayed
        raw strings instead of being parsed."""
        from agent.research import models as M

        store = await self._store()
        await store.save_run(M.ResearchRun(id="run_x", objective=M.Objective(statement="decode me")))
        rows = await store._fetchall("SELECT * FROM (SELECT * FROM research_runs) t")
        self.assertEqual(len(rows), 1)
        self.assertIsInstance(rows[0]["objective"], dict,
                              "objective must be JSON-decoded, not left as a raw string")


# ── medium audit items (K2 / S3 / S4 / C3) ───────────────────────────────────

class TestVaultSearchSeesStaging(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="k2-test-"))
        self.vault = self.tmp / "vault"
        (self.vault / "03-Areas/concepts").mkdir(parents=True)
        (self.vault / "03-Areas/concepts/robinhood-chain.md").write_text(
            "---\nconcept: robinhood-chain\nstatus: active\n---\n\n# Robinhood Chain\nA chain.\n",
            encoding="utf-8")
        self.ws = self.tmp / "workspaces" / "run_k2"
        self._env = os.environ.get("VAULT_ROOT")
        os.environ["VAULT_ROOT"] = str(self.vault)
        from agent.knowledge import index as kix
        from agent.tools import vault_index
        kix.invalidate(); vault_index.invalidate()

    def tearDown(self):
        if self._env is None:
            os.environ.pop("VAULT_ROOT", None)
        else:
            os.environ["VAULT_ROOT"] = self._env
        from agent.knowledge import index as kix
        from agent.tools import vault_index
        kix.invalidate(); vault_index.invalidate()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_staged_note_is_searchable(self):
        """A note a run just created (in staging) must be found by vault_search —
        before, it was visible to knowledge_* but missing from vault_search, so the
        two search surfaces disagreed on the same corpus."""
        from agent.knowledge import vault_store
        from agent.tools import vault_index

        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/b20-x.md",
                              "---\nconcept: b20-x\nstatus: active\n---\n\n# B20 Precompile\nUnique zzmarker term.\n")
            vault_index.invalidate()
            hits = vault_index.search("zzmarker")
        self.assertTrue(any(h["path"].endswith("b20-x.md") for h in hits),
                        f"staged note not found by vault_search: {hits}")
        # the vault copy remains visible too
        keys = {h["path"] for h in vault_index.search("robinhood")}
        self.assertTrue(any("robinhood-chain.md" in k for k in keys))

    def test_staged_shadows_vault_in_search(self):
        from agent.knowledge import vault_store
        from agent.tools import vault_index

        with vault_store.staging(self.ws):
            vault_store.write("03-Areas/concepts/robinhood-chain.md",
                              "---\nconcept: robinhood-chain\nstatus: active\n---\n\n# Robinhood Chain\nSTAGEDONLY term.\n")
            vault_index.invalidate()
            hits = vault_index.search("stagedonly")
        self.assertTrue(hits, "the staged shadow of an existing note must be searched")


class TestRunawayGuardPerFire(unittest.TestCase):
    def test_idle_ticks_do_not_pause(self):
        """S3: the guard rates fires, so an idle tick (no fire due) must never count
        as a violation — otherwise a healthy schedule would be paused by ticks."""
        from agent.research.scheduler.safety import RunawayGuard
        from tests.test_research_scheduler import _sched, _ms

        g = RunawayGuard(min_interval_s=60, pause_after=3)
        now = _ms(2026, 9, 17, 10, 0)
        s = _sched(type="INTERVAL", interval_s=3600, last_run_at=now - 5_000)
        # 10 idle ticks inside the interval floor, no fire due: must stay OK
        for _ in range(10):
            self.assertEqual(g.check(s, now, fire_due=False).action, "OK")
        # a fire that is actually due too soon still throttles -> pauses
        self.assertEqual(g.check(s, now, fire_due=True).action, "THROTTLE")


class TestExpireOverdueIncludesRetrying(StoreTestCase):
    async def test_retrying_job_past_deadline_is_expired(self):
        """S4: a job that failed into RETRYING with a deadline in the past must be
        expired — it was skipped, so it retried past its deadline without bound."""
        from agent.research.scheduler import model as S
        from agent.research.scheduler.scheduler import Scheduler, SchedulerConfig
        from agent.research.scheduler.timeutil import FakeClock

        store = await self._store()
        clk = FakeClock(1_700_000_000_000)
        sch = Scheduler(store, config=SchedulerConfig(), clock=clk)
        job = S.ScheduledJob(id="j_retry", schedule_id="s", research_run_id="r",
                             status=S.JOB_RETRYING, created_at=clk.now_ms())
        job.metadata = {"deadline_ms": clk.now_ms() - 60_000}  # deadline an hour ago
        await store.save_job(job)
        await sch._expire_overdue(clk.now_ms())
        self.assertEqual((await store.get_job("j_retry"))["status"], S.JOB_EXPIRED)


class TestTailEvents(StoreTestCase):
    async def test_tail_returns_recent_not_oldest(self):
        """C3: replay of a long run must be the *recent* window, oldest-first. The
        old ASC+limit read returned the head and dropped the recent events."""
        from agent.research.events import ResearchEvent

        store = await self._store()
        for i in range(10):
            await store.record_event(ResearchEvent(id=f"e{i}", run_id="r", type="T", ts=1000 + i))
        self.assertEqual(await store.count_events("r"), 10)
        tail = await store.tail_events("r", limit=3)
        self.assertEqual([e["id"] for e in tail], ["e7", "e8", "e9"], "must be the newest 3, chronological")
        # the old behaviour (ASC + limit) would have returned e0..e2
        head = await store.list_events("r", limit=3)
        self.assertEqual([e["id"] for e in head], ["e0", "e1", "e2"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
