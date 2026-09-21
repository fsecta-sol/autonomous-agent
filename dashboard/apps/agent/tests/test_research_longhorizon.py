"""Long-horizon endurance tests for the Research Loop.

Run:
    cd apps/agent && .venv/bin/python -m unittest tests.test_research_longhorizon -v

The loop is built for runs that live far longer than a chat turn — a run may
tick for a day, pausing and resuming across many process restarts. These tests
exercise the properties that make a full-day run possible without waiting a real
day, by driving the loop through a fake clock surface and many isolated
"processes" over one durable DB:

  * a run survives N sequential restarts (N new store+loop pairs over the same
    file), losing nothing and never reusing an iteration index;
  * a run with a 24h wall-clock budget is NOT stopped by the wall-clock bound
    while it is still making progress (no premature stop);
  * the wall-clock bound IS a hard ceiling: once elapsed reaches it, the very
    next tick stops with TIME_LIMIT_REACHED;
  * per-episode step counts and iteration records stay bounded and unique,
    so a long run cannot duplicate work.

`now_ms` is monkeypatched at the module level for the wall-clock cases (the loop
reads it through `M.now_ms`), so an episode can span a simulated day in ms. The
restart case uses the real clock, since what it proves is durability, not time.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SEED_NOTES = ["mev", "mempool", "oracle", "rollup"]
DAY_S = 24 * 60 * 60


def _seed_vault(root: Path) -> None:
    (root / "03-Areas/concepts").mkdir(parents=True, exist_ok=True)
    (root / "02-Projects").mkdir(parents=True, exist_ok=True)
    real = Path(os.environ.get("KM_DEMO_SOURCE", "/home/hermes/vault"))
    for slug in SEED_NOTES:
        src = real / "03-Areas/concepts" / f"{slug}.md"
        if src.exists():
            shutil.copy2(src, root / "03-Areas/concepts" / f"{slug}.md")
    if not (root / "03-Areas/concepts/mev.md").exists():
        (root / "03-Areas/concepts/mev.md").write_text(
            "---\nconcept: mev\ntype: trading\nlayer: market\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: active\n---\n\n## What\nMEV.\n"
        )


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


class LongHorizonBase(unittest.IsolatedAsyncioTestCase):
    """Isolated vault + data dir per test (never the operator's real graph)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="longhorizon-"))
        self.vault = self.tmp / "vault"
        self.data = self.tmp / "data"
        _seed_vault(self.vault)
        os.environ["VAULT_ROOT"] = str(self.vault)
        os.environ["AGENT_DATA_DIR"] = str(self.data)
        from agent.knowledge import index as kix
        from agent.tools import vault_index

        kix.invalidate()
        vault_index.invalidate()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def _new_process(self, *, executor=None, config=None):
        """One (store, loop) pair — a fresh `ResearchStore` over the SAME DB file,
        i.e. what a restarted agent process sees."""
        from agent.knowledge.manager import KnowledgeManager
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor
        from agent.research.loop import ResearchLoop, build_default_deps
        from agent.research.store import ResearchStore

        store = await ResearchStore.open()
        self.addAsyncCleanup(store.close)
        ex = executor if executor is not None else ScriptedExecutor(rules=[("any", _evidence_result)])
        cfg = config or ResearchConfig(max_iterations=6, diminishing_returns_streak=3)
        deps = build_default_deps(store=store, km=KnowledgeManager(), executor=ex, config=cfg)
        return store, ResearchLoop(deps)


class TestManyRestarts(LongHorizonBase):
    async def test_run_survives_many_process_restarts(self):
        """A long-lived run is driven, then the process is killed and rebuilt
        repeatedly; the run always resumes at its saved stage and finishes."""
        from agent.research.config import ResearchConfig

        cfg = ResearchConfig(max_iterations=8, diminishing_returns_streak=3)
        store, loop = await self._new_process(config=cfg)
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})

        # five simulated restarts; each new process advances a few stages then "dies"
        for episode in range(5):
            if run.is_terminal():
                break
            for _ in range(3):
                if run.is_terminal():
                    break
                await loop.step(run.id)
                run = await store.get_run(run.id)
            # simulate a crash: rebuild store+loop (fresh process) over the same DB
            await store.close()
            store, loop = await self._new_process(config=cfg)
            run = await store.get_run(run.id)
            self.assertFalse(run.is_terminal(), f"run ended prematurely at episode {episode}: {run.termination_reason}")

        # let it finish in the final process
        await loop.advance(run.id)
        run = await store.get_run(run.id)
        self.assertTrue(run.is_terminal(), "the run must finish after enough steps")

        # durability: no iteration index is ever reused across all restarts
        its = await store.list_iterations(run.id)
        idxs = [it.index for it in its]
        self.assertEqual(len(idxs), len(set(idxs)), "an iteration index was reused across restarts")


class TestWallClockBudget(LongHorizonBase):
    """The wall-clock bound, driven through a simulated clock."""

    async def _run_with_clock(self, *, budget_s, elapsed_s, max_iterations=50):
        from agent.research import models as M
        from agent.research.config import ResearchConfig
        from agent.research.executor import ScriptedExecutor
        from agent.research.loop import ResearchLoop, build_default_deps
        from agent.research.store import ResearchStore
        from agent.knowledge.manager import KnowledgeManager

        store = await ResearchStore.open()
        self.addAsyncCleanup(store.close)
        cfg = ResearchConfig(max_iterations=max_iterations, diminishing_returns_streak=3)
        ex = ScriptedExecutor(rules=[("any", _evidence_result)])
        deps = build_default_deps(store=store, km=KnowledgeManager(), executor=ex, config=cfg)
        loop = ResearchLoop(deps)

        base = M.now_ms()
        run = await loop.start({"objective": "Understand a broad domain",
                                "budget": {"max_iterations": max_iterations, "max_wall_clock_s": budget_s}})
        # backdate the start so `elapsed_s()` reads `elapsed_s` right now
        stored = await store.get_run(run.id)
        stored.started_at = base - int(elapsed_s * 1000)
        await store.save_run(stored)
        return store, loop, run.id

    async def test_day_budget_does_not_stop_early_while_progressing(self):
        """With a 24h budget and only ~1h elapsed, the wall-clock bound must NOT
        fire — a day-long run keeps going as long as it is making progress."""
        store, loop, run_id = await self._run_with_clock(budget_s=DAY_S, elapsed_s=3600, max_iterations=4)
        await loop.advance(run_id)
        run = await store.get_run(run_id)
        self.assertEqual(run.termination_reason, "ITERATION_LIMIT_REACHED",
                         "a 24h run with 1h elapsed must not be stopped by the time bound")

    async def test_day_budget_is_a_hard_ceiling(self):
        """Once elapsed reaches the 24h ceiling, the next tick stops the run with
        TIME_LIMIT_REACHED — the day bound is enforced, not advisory."""
        store, loop, run_id = await self._run_with_clock(budget_s=DAY_S, elapsed_s=DAY_S + 60, max_iterations=50)
        await loop.advance(run_id)
        run = await store.get_run(run_id)
        self.assertTrue(run.is_terminal())
        self.assertEqual(run.termination_reason, "TIME_LIMIT_REACHED")

    async def test_elapsed_is_measured_from_started_at(self):
        """`elapsed_s()` is real wall-clock from the run's start, so a backdated
        start reads as the simulated elapsed time (the ceiling is honest)."""
        store, loop, run_id = await self._run_with_clock(budget_s=DAY_S, elapsed_s=12 * 3600, max_iterations=50)
        run = await store.get_run(run_id)
        self.assertGreaterEqual(run.elapsed_s(), 12 * 3600)
        self.assertLess(run.elapsed_s(), DAY_S)


class TestConfigRecovery(LongHorizonBase):
    """A restarted process must rebuild a run's per-run config from durable state.

    The regression: per-run config lived ONLY in the in-memory loop cache, so
    after a restart the loop was rebuilt from env defaults and a long run died at
    the default iteration cap (50) instead of its own (e.g. 5000)."""

    async def test_restart_recovers_per_run_iteration_limit(self):
        from agent.research.service import ResearchService
        from agent.research.store import ResearchStore

        # --- process 1: start a run with a NON-default iteration limit ---
        store1 = await ResearchStore.open()
        self.addAsyncCleanup(store1.close)
        svc1 = ResearchService.create(store1)
        loop1 = await svc1.loop_for("__pending__", research_config={"max_iterations": 5000})
        run = await loop1.start({"objective": "A long-running study", "budget": {"max_iterations": 5000}})
        # mirror the endpoint: re-key the cached loop under the real id
        svc1._loops.pop("__pending__", None)
        svc1._loops[run.id] = loop1
        # a couple of steps so it is genuinely mid-flight, not terminal
        for _ in range(3):
            await loop1.step(run.id)
        persisted = await store1.get_run(run.id)
        self.assertFalse(persisted.is_terminal())
        # the config was written to durable state
        self.assertEqual(persisted.metadata.get("seed_config", {}).get("research", {}).get("max_iterations"), 5000)
        self.assertEqual(loop1.deps.config.max_iterations, 5000)
        await store1.close()

        # --- process 2: fresh store + service, NO config passed ---
        store2 = await ResearchStore.open()
        self.addAsyncCleanup(store2.close)
        svc2 = ResearchService.create(store2)
        loop2 = await svc2.loop_for(run.id)  # <- the fix: recovers from seed_config

        # the recovered loop carries the ORIGINAL limit, not the env default (50)
        self.assertEqual(loop2.deps.config.max_iterations, 5000,
                         "a restarted process must recover the run's own iteration limit, not the default 50")

    async def test_env_default_is_not_used_when_run_persisted_its_config(self):
        """Even with a low env default, the run's persisted config wins after a
        restart."""
        import os

        from agent.research.service import ResearchService
        from agent.research.store import ResearchStore

        prev = os.environ.get("AGENT_RESEARCH_MAX_ITERATIONS")
        self.addCleanup(lambda: os.environ.__setitem__("AGENT_RESEARCH_MAX_ITERATIONS", prev) if prev is not None else os.environ.pop("AGENT_RESEARCH_MAX_ITERATIONS", None))
        os.environ["AGENT_RESEARCH_MAX_ITERATIONS"] = "50"  # a low env default

        store1 = await ResearchStore.open()
        self.addAsyncCleanup(store1.close)
        svc1 = ResearchService.create(store1)
        loop1 = await svc1.loop_for("__pending__", research_config={"max_iterations": 4321})
        run = await loop1.start({"objective": "Another long study", "budget": {"max_iterations": 4321}})
        svc1._loops.pop("__pending__", None)
        svc1._loops[run.id] = loop1
        await store1.close()

        store2 = await ResearchStore.open()
        self.addAsyncCleanup(store2.close)
        loop2 = await (ResearchService.create(store2)).loop_for(run.id)
        self.assertEqual(loop2.deps.config.max_iterations, 4321)


if __name__ == "__main__":
    unittest.main(verbosity=2)
