"""ResearchRunner — an in-process background driver (spec §4, §34).

`step()` is enough for a scheduler to drive the loop one stage at a time. The
runner is the convenience that drives a whole run to a stopping point in the
background without blocking the HTTP request that started it, so a run behaves
like the chat runs already do (owned by the process, not the client).

It is deliberately minimal: one asyncio task per run, cancellable, and it never
holds state the store doesn't — a restart re-drives from disk via `resume`.
"""

from __future__ import annotations

import asyncio
import logging

from . import models as M
from .loop import ResearchLoop

log = logging.getLogger("agent.research.runner")


class ResearchRunner:
    def __init__(self, loop: ResearchLoop):
        self.loop = loop
        self._tasks: dict[str, asyncio.Task] = {}

    def is_running(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    def running_ids(self) -> list[str]:
        return [rid for rid, t in self._tasks.items() if not t.done()]

    def drive(self, run_id: str, *, max_steps: int = 500) -> asyncio.Task:
        """Start (or return the existing) background driver for a run."""
        existing = self._tasks.get(run_id)
        if existing and not existing.done():
            return existing
        task = asyncio.create_task(self._drive(run_id, max_steps=max_steps))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))
        return task

    async def _drive(self, run_id: str, *, max_steps: int) -> None:
        try:
            # Re-arm across the per-call step cap (a ~40-iteration run crosses 500
            # stages); `step` stops the inner loop only at a real resting point.
            # A pass that moves nothing (e.g. the run is leased by another worker)
            # breaks instead of spinning.
            last: tuple | None = None
            while True:
                for _ in range(max_steps):
                    res = await self.loop.step(run_id)
                    if res.done or res.status in (M.RUN_PAUSED, M.RUN_WAITING, M.RUN_BLOCKED, M.RUN_CANCELLED):
                        return
                marker = (res.status, res.stage_after, res.iteration)
                if marker == last:
                    return
                last = marker
        except Exception:
            log.exception("research driver failed for %s", run_id)
            try:
                run = await self.loop._load(run_id)
                if not run.is_terminal():
                    run.status = M.RUN_FAILED
                    run.stage = M.STAGE_DONE
                    run.termination_reason = "driver error"
                    run.completed_at = M.now_ms()
                    await self.loop.deps.store.save_run(run)
            except Exception:
                log.exception("could not mark run %s failed", run_id)

    async def wait(self, run_id: str) -> None:
        task = self._tasks.get(run_id)
        if task:
            await asyncio.shield(task)
