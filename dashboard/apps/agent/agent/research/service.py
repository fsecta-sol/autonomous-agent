"""ResearchService — process-wide owner of the loop's runtime pieces.

Ties together the durable store, the event bus and the background runner, and
builds a per-run `ResearchLoop` (with its executor) from a run config. The
endpoints in `main.py` are thin over this; keeping the wiring here means the API
layer owns no lifecycle logic, matching how the chat routes delegate to `runs.ts`
rather than reimplementing the pump.

The executor is built from a `RunRequest`-shaped config the caller supplies (the
backend resolves LLM creds + tools, exactly as it does for `/run`). With no config
the run cannot execute — that is honest, not silently faked: a run started without
credentials simply produces insufficient-evidence results.
"""

from __future__ import annotations

import asyncio
import logging

from langchain_core.tools import BaseTool

from ..config import subagent_timeout_s
from ..knowledge.manager import default_manager
from ..models import RunRequest
from . import models as M
from .config import ResearchConfig
from .events import EventBus
from .executor import ResearchExecutor, ScriptedExecutor, SubagentExecutor
from .loop import ResearchLoop, build_default_deps
from .scheduler import Scheduler, SchedulerConfig
from .scheduler.research_bridge import ResearchJobDriver
from .store import ResearchStore, get_research_store

log = logging.getLogger("agent.research.service")

# A sub-agent must not hold the approval-gated terminal tool (no operator thread),
# nor the delegation tools (no recursion).
_EXCLUDED_TOOLS = {"run_command", "spawn_subagent", "batch_research"}

# The states at which a driver must stop re-arming: the run has either ended
# (terminal) or come to rest and needs an external event (resume/wake) to move.
_RESTING_STATUSES = frozenset({M.RUN_PAUSED, M.RUN_WAITING, M.RUN_BLOCKED, M.RUN_CANCELLED})

# How often the watchdog sweeps for a RUNNING run that nothing is driving, and how
# long a run may sit undriven before it is re-armed (longer than the gap between
# steps so a healthy driver is never double-started).
WATCHDOG_INTERVAL_S = 30.0
WATCHDOG_GRACE_MS = 120_000


class ResearchService:
    """Owns the per-process research runtime: the durable store, the event bus,
    the background runner, and a cached loop per run."""

    def __init__(self, store: ResearchStore):
        self.store = store
        self.bus = EventBus()
        self.runner = RunDriver(self)  # type: ignore[arg-type]  # duck-typed driver
        self._loops: dict[str, ResearchLoop] = {}
        # the durable execution scheduler (built + started by the lifespan)
        self.scheduler: Scheduler | None = None
        self._scheduler_config = SchedulerConfig.from_env()
        # the safety net for an in-process run that stopped being driven
        self._watchdog: asyncio.Task | None = None

    def start_watchdog(self) -> None:
        """Start the background sweep that re-arms a RUNNING run with no driver.

        The re-arm loop in `RunDriver._drive` covers the step cap; this covers the
        larger gap — a driver task that died (an unexpected exception outside its
        own handler, an event-loop hiccup, a process that came back up with the run
        still RUNNING). Without it such a run sits RUNNING but undriven forever."""
        if self._watchdog is None or self._watchdog.done():
            self._watchdog = asyncio.create_task(self._watchdog_loop())

    async def stop_watchdog(self) -> None:
        task = self._watchdog
        self._watchdog = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _watchdog_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(WATCHDOG_INTERVAL_S)
                await self._sweep_undriven()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("research watchdog sweep failed")

    async def _sweep_undriven(self) -> None:
        """Re-arm every RUNNING run that is neither drivable by the scheduler nor
        currently driven by this process. Skips a run a scheduler job is actively
        running (that path drives it) so we never double-drive one run."""
        runs = await self.store.list_runs(status=M.RUN_RUNNING, limit=200)
        now = M.now_ms()
        for run in runs:
            if self.runner.is_running(run.id):
                continue
            if now - run.updated_at < WATCHDOG_GRACE_MS:
                continue  # recently touched — a driver is probably mid-step
            try:
                jobs = await self.store.list_jobs(
                    status=["RUNNING", "CHECKPOINTING"], research_run_id=run.id, limit=1
                )
            except Exception:
                jobs = []
            if jobs:
                continue  # the scheduler owns this run right now
            log.warning("watchdog re-arming undriven RUNNING run %s (stage %s)", run.id, run.stage)
            # `_drive` reads the cached loop; build it first so the run is drivable.
            await self.loop_for(run.id)
            self.runner.drive(run.id)

    def build_scheduler(self, config: SchedulerConfig | None = None) -> Scheduler:
        """Construct the scheduler with the research bridge as its driver. Not
        started here — `init_research_service` starts it so recovery runs before
        the API accepts traffic."""
        cfg = config or self._scheduler_config
        drv = ResearchJobDriver(self)
        self.scheduler = Scheduler(self.store, config=cfg, driver=drv)
        return self.scheduler

    @classmethod
    def create(cls, store: ResearchStore) -> ResearchService:
        return cls(store)

    def _build_executor(self, config: dict | None) -> ResearchExecutor:
        """A sub-agent executor when the caller supplied LLM creds + tools, else a
        scripted no-op that returns insufficient-evidence results — the honest
        behaviour for a run started without an executor."""
        if not config or not config.get("llm"):
            return ScriptedExecutor()  # default rule -> insufficient evidence
        req = RunRequest.model_validate(config)
        names = [t for t in (req.tools or []) if t not in _EXCLUDED_TOOLS]
        tools = self._build_subagent_tools(names, req)
        return SubagentExecutor(req, tools, timeout_s=subagent_timeout_s())

    @staticmethod
    def _build_subagent_tools(names: list[str], req: RunRequest) -> list[BaseTool]:
        from ..tools import build_tools  # imported late to keep module import light

        return build_tools(names, req.terminalMode, req.allowUnsandboxed, req.agentId, req.permissionMode)

    async def loop_for(self, run_id: str, config: dict | None = None, research_config: dict | None = None) -> ResearchLoop:
        """The loop driving a run. Cached per run so its locks/lease are stable.

        The executor is fixed when the loop is first built. When this is a fresh
        process resuming an existing run (no `config` supplied — the callers that
        drive a run by id pass none), the run's persisted `seed_config` is read
        back so the SAME LLM creds, tools and loop knobs are rebuilt. Without this
        a restarted process rebuilt the loop from env defaults and a long run died
        at the default iteration cap. `async` because that recovery needs the
        durable store.
        """
        existing = self._loops.get(run_id)
        if existing is not None:
            return existing
        if config is None and not research_config:
            run = await self.store.get_run(run_id)
            seed = run.metadata.get("seed_config") if run and isinstance(run.metadata, dict) else None
            if isinstance(seed, dict):
                config = seed.get("executor") if isinstance(seed.get("executor"), dict) else config
                research_config = seed.get("research") if isinstance(seed.get("research"), dict) else research_config
        cfg = ResearchConfig.from_dict(research_config) if research_config else ResearchConfig.from_env()
        deps = build_default_deps(
            store=self.store,
            km=default_manager(),
            executor=self._build_executor(config),
            config=cfg,
            bus=self.bus,
        )
        loop = ResearchLoop(deps)
        self._loops[run_id] = loop
        return loop


class RunDriver:
    """A runner facade that resolves the right loop per run id.

    `loop.py`'s `ResearchRunner` drives ONE loop; the service has many, so this
    thin driver looks up the run's loop and calls `advance`. Kept here (not in
    runner.py) so runner.py stays a single-loop concept.
    """

    def __init__(self, service: ResearchService):
        self.service = service
        self._tasks: dict[str, asyncio.Task] = {}

    def is_running(self, run_id: str) -> bool:
        t = self._tasks.get(run_id)
        return t is not None and not t.done()

    def running_ids(self) -> list[str]:
        return [rid for rid, t in self._tasks.items() if not t.done()]

    def drive(self, run_id: str, *, max_steps: int = 500) -> asyncio.Task:
        existing = self._tasks.get(run_id)
        if existing and not existing.done():
            return existing
        task = asyncio.create_task(self._drive(run_id, max_steps))
        self._tasks[run_id] = task
        task.add_done_callback(lambda _t, rid=run_id: self._tasks.pop(rid, None))
        return task

    async def _drive(self, run_id: str, max_steps: int) -> None:
        loop = self.service._loops.get(run_id)
        if loop is None:
            return
        try:
            # Re-arm across the per-call step cap. `loop.advance` stops after
            # `max_steps` stage transitions and returns normally even when the run
            # is neither terminal nor resting — a long run crosses 500 steps after
            # ~40 iterations (≈12 stages each) and would otherwise be left parked
            # mid-stage, RUNNING but undriven forever.
            last: tuple | None = None
            while True:
                run = await loop.advance(run_id, max_steps=max_steps)
                if run.is_terminal() or run.status in _RESTING_STATUSES:
                    break
                marker = (run.status, run.stage, run.iteration)
                if marker == last:
                    # a whole pass moved nothing (e.g. the run is leased by another
                    # worker) — stop rather than spin re-arming it.
                    break
                last = marker
        except Exception:
            log.exception("research driver failed for %s", run_id)
            try:
                run = await self.service.store.get_run(run_id)
                if run and not run.is_terminal():
                    run.status = "FAILED"
                    run.stage = "DONE"
                    run.termination_reason = "driver error"
                    await self.service.store.save_run(run)
            except Exception:
                log.exception("could not mark run %s failed", run_id)


_service: ResearchService | None = None


async def init_research_service() -> ResearchService:
    global _service
    if _service is None:
        _service = ResearchService.create(get_research_store())
        svc = _service
        if svc._scheduler_config.enabled:
            svc.build_scheduler()
            await svc.scheduler.start()
        svc.start_watchdog()
    return _service


def get_research_service() -> ResearchService:
    if _service is None:
        raise RuntimeError("research service not initialized")
    return _service


async def close_research_service() -> None:
    """Stop the background driver + scheduler and drop the service. `async` to
    match the other close hooks the lifespan awaits; running tasks are cancelled so
    they do not outlive the process' other stores."""
    global _service
    if _service is not None:
        try:
            await _service.stop_watchdog()
        except Exception:
            log.exception("watchdog stop failed")
        if _service.scheduler is not None:
            try:
                await _service.scheduler.stop()
            except Exception:
                log.exception("scheduler stop failed")
        for task in getattr(_service.runner, "_tasks", {}).values():
            if not task.done():
                task.cancel()
        _service = None

