"""Regression tests for the system-audit fixes.

Each test pins a defect found in the full-system audit so it cannot silently
return. They are grouped by the bug they lock down:

  - candidate hygiene      (D1/R1: unbounded duplicate candidates, oldest-first ranking)
  - knowledge corruption   (R2: contradicts always None; K1: frozen `_today`)
  - scheduler durability   (S1: backpressure counts terminal jobs; S2: lease TOCTOU)
  - loop termination       (contradiction alone must not reset the low-value streak)
  - chat reliability       (C1/C2: retry middleware must be transient-only + raise)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
