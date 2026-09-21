"""Regression tests for the undriven-run defects.

The stall this pins: a long run driven by the in-process runner was left
`RUNNING` but undriven. `RunDriver._drive`/`ResearchRunner._drive` called
`advance(max_steps=N)` once and stopped when the cap was hit, so a run that
crosses ~500 stage transitions (≈40 iterations × ~12 stages) parked mid-stage
forever — nothing re-armed it. The watchdog covers the wider case (a driver task
that died). These tests fail if the re-arm or the watchdog is removed.

    cd apps/agent && .venv/bin/python -m unittest tests.test_research_rerun -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.test_research_loop import ResearchTestCase, _evidence_result  # noqa: E402


class TestRunnerRearm(ResearchTestCase):
    async def test_runner_rearms_past_step_cap(self):
        """With max_steps=1 a run needs many ticks; the runner must keep stepping
        to a terminal state, not stop after the first cap."""
        from agent.research.runner import ResearchRunner

        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})
        runner = ResearchRunner(loop)
        task = runner.drive(run.id, max_steps=1)
        await task
        run = await store.get_run(run.id)
        self.assertTrue(run.is_terminal(), f"runner stopped at non-terminal {run.status}/{run.stage}")

    async def test_run_driver_rearms_past_step_cap(self):
        """The service-level RunDriver (used by /research/runs autostart) must also
        re-arm across the step cap."""
        from agent.research.service import ResearchService

        store, _deps, loop = await self._make()
        svc = ResearchService.create(store)
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})
        svc._loops[run.id] = loop
        task = svc.runner.drive(run.id, max_steps=1)
        await task
        run = await store.get_run(run.id)
        self.assertTrue(run.is_terminal(), f"driver stopped at non-terminal {run.status}/{run.stage}")


class TestCancelRace(ResearchTestCase):
    async def test_cancel_during_step_sticks(self):
        """A cancel issued while a step is mid-flight must not be clobbered by the
        step writing its stale copy back. We drive a step concurrently with a
        cancel and require the run to end CANCELLED, never resurrected RUNNING."""
        import asyncio

        store, _deps, loop = await self._make()
        run = await loop.start({"objective": "Understand MEV extraction and its preconditions"})
        # fire a step and a cancel together; whatever the interleaving, cancel wins
        step_task = asyncio.create_task(loop.step(run.id))
        cancel_task = asyncio.create_task(loop.cancel(run.id))
        await asyncio.gather(step_task, cancel_task, return_exceptions=True)
        run = await store.get_run(run.id)
        self.assertTrue(run.is_terminal(), f"run not terminal: {run.status}/{run.stage}")
        self.assertEqual(run.status, "CANCELLED")


class TestWatchdog(ResearchTestCase):
    async def test_watchdog_rearms_an_undriven_running_run(self):
        """A RUNNING run that nothing is driving and that has been untouched past
        the grace window must be picked back up by the sweep."""
        from agent.research.service import ResearchService, WATCHDOG_GRACE_MS
        from agent.research import models as M

        store, _deps, loop = await self._make()
        svc = ResearchService.create(store)
        run = await loop.start({"objective": "Understand mempool behaviour"})
        # step one stage so the run is genuinely mid-flight, then abandon it
        await loop.step(run.id)
        run = await store.get_run(run.id)
        self.assertFalse(run.is_terminal())
        # age the run so it is past the grace window, and drop any loop cache
        run.updated_at = M.now_ms() - WATCHDOG_GRACE_MS - 1000
        await store.save_run(run)
        svc._loops.clear()
        self.assertFalse(svc.runner.is_running(run.id))

        await svc._sweep_undriven()
        self.assertTrue(
            svc.runner.is_running(run.id),
            "watchdog must re-arm a RUNNING run that nothing is driving",
        )
        # the sweep started a real driver task; drain it so it never outlives the
        # store (which closes in teardown and would raise on a late write)
        import asyncio
        from contextlib import suppress

        for t in list(svc.runner._tasks.values()):
            t.cancel()
            with suppress(asyncio.CancelledError):
                await t

    async def test_watchdog_skips_a_freshly_touched_run(self):
        """A RUNNING run touched within the grace window is left alone (a driver is
        probably mid-step), so the sweep never double-drives a live run."""
        from agent.research.service import ResearchService

        store, _deps, loop = await self._make()
        svc = ResearchService.create(store)
        run = await loop.start({"objective": "Understand mempool behaviour"})
        await loop.step(run.id)
        svc._loops.clear()
        await svc._sweep_undriven()
        self.assertFalse(svc.runner.is_running(run.id), "a fresh run must not be re-armed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
