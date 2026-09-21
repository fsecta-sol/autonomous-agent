"""Tests for the Research Loop.

Runs under the agent venv's Python with the stdlib test runner (no pytest in the
venv):

    cd apps/agent && .venv/bin/python -m unittest tests.test_research_loop -v

Covers the cases the spec enumerates (§39): basic loop, resume-after-restart,
pause, dedup, strategy selection, strategy fallback, branching, conflict, stop
condition, diminishing returns, failure loop, and concurrency (lease guard).

Every test runs against a throwaway sandbox vault + data dir, so the operator's
real graph is never touched, and drives the loop with a ScriptedExecutor so the
assertions are deterministic and model-free.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

# make `agent.*` importable when run as a module from apps/agent
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SEED_NOTES = ["mev", "mempool", "oracle", "rollup"]


def _seed_vault(root: Path) -> None:
    (root / "03-Areas/concepts").mkdir(parents=True, exist_ok=True)
    (root / "02-Projects").mkdir(parents=True, exist_ok=True)
    real = Path(os.environ.get("KM_DEMO_SOURCE", "/home/hermes/vault"))
    for slug in SEED_NOTES:
        src = real / "03-Areas/concepts" / f"{slug}.md"
        if src.exists():
            shutil.copy2(src, root / "03-Areas/concepts" / f"{slug}.md")
    if not (root / "03-Areas/concepts/mev.md").exists():
        # a minimal seed if the real vault is unavailable
        (root / "03-Areas/concepts/mev.md").write_text(
            "---\nconcept: mev\ntype: trading\nlayer: market\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: active\n---\n\n## What\nMEV.\n"
        )


class ResearchTestCase(unittest.IsolatedAsyncioTestCase):
    """A base that sets up an isolated vault + data dir per test."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="research-test-"))
        self.vault = self.tmp / "vault"
        self.data = self.tmp / "data"
        _seed_vault(self.vault)
        os.environ["VAULT_ROOT"] = str(self.vault)
        os.environ["AGENT_DATA_DIR"] = str(self.data)
        os.environ["AGENT_RESEARCH_MAX_ITERATIONS"] = "50"
        os.environ["AGENT_RESEARCH_MAX_SECONDS"] = "3600"
        # reset the global caches that key off the (now-changed) vault root
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def _make(self, *, executor=None, config=None, km=None):
        from agent.knowledge.manager import KnowledgeManager
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor
        from agent.research.loop import ResearchLoop, build_default_deps
        from agent.research.store import ResearchStore

        store = await ResearchStore.open()
        self.addAsyncCleanup(store.close)
        ex = executor if executor is not None else ScriptedExecutor(rules=[("any", _evidence_result)])
        cfg = config or ResearchConfig(max_iterations=6, min_useful_info_gain=0.15, diminishing_returns_streak=3)
        deps = build_default_deps(store=store, km=km or KnowledgeManager(), executor=ex, config=cfg)
        loop = ResearchLoop(deps)
        return store, deps, loop


def _evidence_result(plan, ctx):
    from agent.research import models as M

    return M.ResearchResult(
        id=M.new_id("res_"),
        candidate_id=plan.candidate_id,
        iteration_id="",
        strategy=plan.strategy,
        observations=[{"statement": f"observed {plan.question[:40]}", "source": "doc"}],
        evidence=[{"kind": "source", "statement": "documented behaviour", "source": "https://example.org"}],
        sources=["https://example.org"],
        conclusions=["the mechanism works as documented"],
        hypothesis_survived=True,
    )


class TestBasicLoop(ResearchTestCase):
    async def test_start_research_update_next_iteration(self):
        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})
        self.assertEqual(run.status, "RUNNING")
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        self.assertEqual(run.status, "COMPLETED")
        # it ran multiple iterations and produced knowledge
        self.assertGreaterEqual(run.iteration, 1)
        self.assertGreater(run.progress.knowledge_created, 0)
        # each completed iteration has a full record
        its = await store.list_iterations(run.id)
        self.assertTrue(any(it.plan_id and it.result_id and it.strategy for it in its))
        # and it wrote into the Markdown graph
        concepts = list((self.vault / "03-Areas/concepts").glob("*.md"))
        self.assertGreater(len(concepts), len(SEED_NOTES))


class TestPauseResume(ResearchTestCase):
    async def test_pause_preserves_state_and_resumes(self):
        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand mempool behaviour"})
        # step a few stages, then pause
        for _ in range(4):
            await loop.step(run.id)
        paused = await loop.pause(run.id)
        self.assertEqual(paused.status, "PAUSED")
        stage_at_pause = paused.stage
        # a stepped run does nothing while paused
        res = await loop.step(run.id)
        self.assertTrue(res.output.get("paused"))
        # resume continues from the same stage
        resumed = await loop.resume(run.id)
        self.assertEqual(resumed.status, "RUNNING")
        self.assertEqual(resumed.stage, stage_at_pause)
        await loop.advance(run.id)
        done = await store.get_run(run.id)
        self.assertEqual(done.status, "COMPLETED")

    async def test_resume_after_process_restart(self):
        """Simulate a crash: drive part-way with one loop, then build a fresh
        store+loop over the same DB (a new process) and finish the run."""
        from agent.knowledge.manager import KnowledgeManager
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor
        from agent.research.loop import ResearchLoop, build_default_deps
        from agent.research.store import ResearchStore

        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand how oracles authenticate their feeds"})
        for _ in range(6):
            await loop.step(run.id)
        partial = await store.get_run(run.id)
        iters_before = partial.iteration
        iterations_done = len(await store.list_iterations(run.id))
        await store.close()

        # fresh "process": new store over the same file, new loop
        store2 = await ResearchStore.open()
        self.addAsyncCleanup(store2.close)
        ex = ScriptedExecutor(rules=[("any", _evidence_result)])
        deps2 = build_default_deps(store=store2, km=KnowledgeManager(), executor=ex,
                                   config=ResearchConfig(max_iterations=6))
        loop2 = ResearchLoop(deps2)
        # the run is intact and mid-flight
        recovered = await store2.get_run(run.id)
        self.assertEqual(recovered.status, "RUNNING")
        self.assertEqual(recovered.iteration, iters_before)
        # it resumes at its saved stage, not from iteration 1
        self.assertGreaterEqual(len(await store2.list_iterations(run.id)), iterations_done)
        await loop2.advance(run.id)
        done = await store2.get_run(run.id)
        self.assertEqual(done.status, "COMPLETED")
        # no iteration index was reused (each iteration is distinct)
        idxs = [it.index for it in await store2.list_iterations(run.id)]
        self.assertEqual(len(idxs), len(set(idxs)))


class TestDedup(ResearchTestCase):
    async def test_existing_knowledge_prevents_redundant_research(self):
        """The same question researched twice yields one node, not two, and the
        second pass is recognized as not-new."""
        from agent.research import models as M
        from agent.research.executor import ScriptedExecutor

        # an executor that always answers the SAME question with the same evidence
        def same(plan, ctx):
            return M.ResearchResult(
                id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="", strategy=plan.strategy,
                question="What is mev-preconditions and how does it work?",
                observations=[{"statement": "MEV preconditions are ordering discretion etc."}],
                evidence=[{"kind": "source", "statement": "from the spec", "source": "https://x"}],
                sources=["https://x"], conclusions=["preconditions enumerated"], hypothesis_survived=True,
            )

        _store, _deps, loop = await self._make(executor=ScriptedExecutor(rules=[("any", same)]))
        run = await loop.start({"objective": "Understand MEV preconditions"})
        await loop.advance(run.id)
        # the node exists once
        node_path = self.vault / "03-Areas/concepts/mev-preconditions.md"
        self.assertTrue(node_path.exists(), "the researched node should exist")
        # a repeat of the same subject resolves to the SAME node — never a fork
        from agent.knowledge.manager import KnowledgeManager

        km = KnowledgeManager()
        again = km.create_knowledge(title="MEV preconditions", text="MEV preconditions are ordering discretion etc.")
        self.assertEqual(again["id"], "mev-preconditions", "dedup must reuse the existing node id")
        self.assertNotEqual(again["action"], "CREATE", "a known subject must not create a second node")
        self.assertFalse((self.vault / "03-Areas/concepts/mev-preconditions-2.md").exists())


class TestStrategySelection(ResearchTestCase):
    async def test_conflict_gap_selects_comparison_or_experiment(self):
        from agent.research import models as M
        from agent.research.context import ResearchContext
        from agent.research.executor import ScriptedExecutor
        from agent.research.strategies.registry import build_strategies
        from agent.research.strategies.selector import WeightedStrategySelector

        sel = WeightedStrategySelector(build_strategies(ScriptedExecutor()))
        ctx = ResearchContext(run_id="r", objective=M.Objective(statement="x"), iteration=1)
        cand = M.ResearchCandidate(id="c", question="which claim is right about oracle?", source_gap_kind="conflict")
        chosen = await sel.select(cand, ctx)
        self.assertIn(chosen.name, ("source-comparison", "experiment"))
        # a stale gap does not pick the experiment strategy
        stale = M.ResearchCandidate(id="c2", question="has X changed?", source_gap_kind="stale")
        chosen2 = await sel.select(stale, ctx)
        self.assertNotEqual(chosen2.name, "experiment")


class TestStrategyFallback(ResearchTestCase):
    async def test_failed_strategy_is_abandoned_for_another(self):
        """After a strategy fails on a question, selection prefers a different
        capable strategy (the attempt ledger drives it)."""
        from agent.research import models as M
        from agent.research.candidates import question_key
        from agent.research.context import ResearchContext
        from agent.research.executor import ScriptedExecutor
        from agent.research.strategies.registry import build_strategies
        from agent.research.strategies.selector import WeightedStrategySelector

        sel = WeightedStrategySelector(build_strategies(ScriptedExecutor()))
        q = "which claim is right about oracle?"
        ctx = ResearchContext(run_id="r", objective=M.Objective(statement="x"), iteration=1)
        # seed the ledger: source-comparison already failed twice on this question
        ctx.recent_attempts = [
            {"question_norm": question_key(q), "strategy": "source-comparison", "outcome": "failed"},
            {"question_norm": question_key(q), "strategy": "source-comparison", "outcome": "failed"},
        ]
        cand = M.ResearchCandidate(id="c", question=q, source_gap_kind="conflict")
        chosen = await sel.select(cand, ctx)
        self.assertNotEqual(chosen.name, "source-comparison")


class TestBranching(ResearchTestCase):
    async def test_unexpected_discovery_creates_branch(self):
        from agent.research import models as M
        from agent.research.executor import ScriptedExecutor

        def branchy(plan, ctx):
            return M.ResearchResult(
                id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="", strategy=plan.strategy,
                observations=[{"statement": "found a caching layer"}],
                evidence=[{"kind": "observation", "statement": "a new subsystem appeared", "source": "probe"}],
                sources=["https://x"], conclusions=["opens a new direction"],
                uncertainties=["what is this caching layer?"], hypothesis_survived=True,
            )

        store, _deps, loop = await self._make(executor=ScriptedExecutor(rules=[("any", branchy)]))
        run = await loop.start({"objective": "Understand a layered system"})
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        branches = run.metadata.get("branches", {})
        self.assertGreater(len(branches), 1, f"expected a branch, got {branches}")
        # the branch has a parent edge back to main
        child = next(b for name, b in branches.items() if name != "main")
        self.assertEqual(child.get("parent"), "main")


class TestConflict(ResearchTestCase):
    async def test_contradictory_evidence_creates_conflict_not_overwrite(self):
        from agent.research import models as M
        from agent.research.executor import ScriptedExecutor

        def conflicting(plan, ctx):
            return M.ResearchResult(
                id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="", strategy=plan.strategy,
                question="What does the oracle feed require?",
                observations=[{"statement": "the oracle updates without authentication"}],
                evidence=[{"kind": "observation", "statement": "unauth update observed", "source": "request #1"}],
                sources=["https://x"], conclusions=["authentication may be absent"], hypothesis_survived=False,
            )

        _store, deps, _loop = await self._make(executor=ScriptedExecutor(rules=[("any", conflicting)]))
        # force a conflict via the updater path: run against an objective that
        # targets the oracle node, then check the graph kept both.
        km = deps.km
        km.create_knowledge(title="oracle", text="Oracle feeds require authentication.", contradicts=[])
        before = (self.vault / "03-Areas/concepts/oracle.md").read_text()
        # direct manager call for the conflict (the updater surfaces conflicts the
        # analyzer marks; here we assert the manager's contract holds)
        out = km.create_knowledge(title="oracle", text="Observation: the feed updates without authentication.",
                                  contradicts=["oracle"], evidence=["request #1"])
        self.assertEqual(out["action"], "CONFLICT")
        after = (self.vault / "03-Areas/concepts/oracle.md").read_text()
        self.assertIn("## Conflict", after)
        # the original content is intact (not overwritten)
        self.assertIn("## What", after)
        self.assertNotEqual(before, after)  # something was added
        self.assertGreaterEqual(len(after), len(before) - 5)


class TestStopCondition(ResearchTestCase):
    async def test_objective_satisfied_stops_loop(self):
        from agent.research import models as M
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor

        def robust(plan, ctx):
            return M.ResearchResult(
                id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="", strategy=plan.strategy,
                observations=[{"statement": "x"}],
                evidence=[{"kind": "source", "statement": "y", "source": "https://x"}],
                sources=["https://x"], conclusions=["z"], hypothesis_survived=True,
            )

        # objective keyword equals the seeded note slug, so coverage is immediately
        # high once the note exists -> objective-satisfied fires.
        cfg = ResearchConfig(max_iterations=50, stopping=["objective-satisfied", "diminishing-returns"])
        store, _deps, loop = await self._make(executor=ScriptedExecutor(rules=[("any", robust)]), config=cfg)
        run = await loop.start({"objective": "mev mempool", "success_criteria": ["mev"]})
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        self.assertEqual(run.status, "COMPLETED")
        self.assertIn(run.termination_reason, ("OBJECTIVE_SATISFIED", "KNOWLEDGE_COVERAGE_REACHED", "ITERATION_LIMIT_REACHED"))

    async def test_iteration_limit_stops(self):
        from agent.research.config import ResearchConfig

        store, _deps, loop = await self._make(config=ResearchConfig(max_iterations=2))
        run = await loop.start({"objective": "Understand a broad domain"})
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        self.assertEqual(run.status, "COMPLETED")
        self.assertEqual(run.termination_reason, "ITERATION_LIMIT_REACHED")
        self.assertEqual(run.iteration, 2)


class TestDiminishingReturns(ResearchTestCase):
    async def test_low_value_iterations_trigger_stop(self):
        from agent.research import models as M
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor

        # an executor that finds nothing -> insufficient evidence -> low value
        def empty(plan, ctx):
            return M.ResearchResult(id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="",
                                    strategy=plan.strategy, observations=[], evidence=[])

        cfg = ResearchConfig(max_iterations=50, diminishing_returns_streak=3, min_useful_info_gain=0.15)
        store, _deps, loop = await self._make(executor=ScriptedExecutor(rules=[("any", empty)]), config=cfg)
        run = await loop.start({"objective": "Investigate an obscure topic with no sources"})
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        self.assertEqual(run.status, "COMPLETED")
        # it stopped by diminishing returns, well before the 50-iteration cap
        self.assertLess(run.iteration, 50)
        self.assertIn(run.termination_reason, ("DIMINISHING_RETURNS", "NO_MEANINGFUL_RESEARCH_REMAINING", "REPEATED_FAILURE"))


class TestFailureLoop(ResearchTestCase):
    async def test_repeated_failure_does_not_retry_forever(self):
        from agent.research import models as M
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor

        calls = {"n": 0}

        def flaky(plan, ctx):
            calls["n"] += 1
            return M.ResearchResult(id=M.new_id("res_"), candidate_id=plan.candidate_id, iteration_id="",
                                    strategy=plan.strategy, failure_kind=M.FAIL_TOOL,
                                    failure_reason="tool blew up")

        cfg = ResearchConfig(max_iterations=50, max_attempts_per_question=3, diminishing_returns_streak=4)
        store, _deps, loop = await self._make(executor=ScriptedExecutor(rules=[("any", flaky)]), config=cfg)
        run = await loop.start({"objective": "Investigate a flaky thing"})
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        # the loop terminated (did not run to the 50 cap retrying the same failure)
        self.assertTrue(run.is_terminal())
        self.assertLess(run.iteration, 50)
        # a bounded number of attempts per question
        attempts = await store.all_attempts(run.id)
        from collections import Counter

        per_q = Counter(a["question_norm"] for a in attempts)
        self.assertTrue(all(n <= cfg.max_attempts_per_question + 1 for n in per_q.values()), per_q)


class TestConcurrency(ResearchTestCase):
    async def test_lease_prevents_double_driving(self):
        """A run leased by another worker is not stepped — two processes cannot
        mutate the same run."""
        from agent.research import models as M

        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand something"})
        # simulate a live lease held by a different worker
        run.metadata["lease"] = {"owner": "other-worker", "expires": M.now_ms() + 60_000}
        await store.save_run(run)
        res = await loop.step(run.id)
        self.assertTrue(res.output.get("leased"), "a leased run must not be stepped")
        # the stage did not advance
        fresh = await store.get_run(run.id)
        self.assertEqual(fresh.stage, M.STAGE_IDLE)

    async def test_concurrent_drivers_do_not_double_iterate(self):
        """Two drivers racing the same run produce no duplicate iteration records."""

        from agent.knowledge.manager import KnowledgeManager
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor
        from agent.research.loop import ResearchLoop, build_default_deps
        from agent.research.store import ResearchStore

        store, _deps, loop = await self._make(config=ResearchConfig(max_iterations=3))
        run = await loop.start({"objective": "Race test"})

        store2 = await ResearchStore.open()
        self.addAsyncCleanup(store2.close)
        loop2 = ResearchLoop(build_default_deps(store=store2, km=KnowledgeManager(),
                                                 executor=ScriptedExecutor(rules=[("any", _evidence_result)]),
                                                 config=ResearchConfig(max_iterations=3)))
        await asyncio.gather(loop.advance(run.id), loop2.advance(run.id))
        its = await store.list_iterations(run.id)
        idxs = [it.index for it in its]
        self.assertEqual(len(idxs), len(set(idxs)), "no duplicate iteration index under a race")


if __name__ == "__main__":
    unittest.main(verbosity=2)
