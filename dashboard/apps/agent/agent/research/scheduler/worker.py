"""Workers and the worker pool (spec §12, §13).

A `SchedulerWorker` is an execution slot: it can run up to `max_concurrency` jobs
at once and reports a heartbeat while doing so. Workers are kept as stateless as
possible — the durable job state lives in the store; a worker only holds its id,
its capacity and the running tasks. A `JobDriver` (the bridge to the Research
Loop, injected by the service layer) does the actual work, so the scheduler never
imports the loop.

The `WorkerPool` chooses a worker with free capacity, runs the job, and tracks the
task so shutdown can await it.
"""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from . import model as S

log = logging.getLogger("agent.research.scheduler.worker")


@dataclass
class ExecutionResult:
    """What a worker reports after attempting a job. The scheduler maps this onto
    job lifecycle transitions (complete / retry / wait / dead-letter)."""

    outcome: str = "completed"          # completed | failed | waiting | cancelled | blocked
    failure_kind: str = ""              # research failure taxonomy, when outcome=failed
    failure_message: str = ""
    iteration_from: int | None = None
    iteration_to: int | None = None
    waiting_until_ms: int | None = None  # WAIT_UNTIL wake-up (spec §22)
    wait_event: str = ""                 # WAIT_FOR_EVENT (spec §23)
    detail: dict = field(default_factory=dict)

    def is_failure(self) -> bool:
        return self.outcome in ("failed", "blocked")


class JobDriver(ABC):
    """Runs one job's actual work (research), returning an `ExecutionResult`.
    Implemented by the service layer to bridge to the Research Loop."""

    @abstractmethod
    async def drive(self, job: S.ScheduledJob, schedule: S.Schedule) -> ExecutionResult:
        ...

    async def on_lifecycle(self, job: S.ScheduledJob, phase: str) -> None:
        """Optional hook for checkpointing around a run (spec §21). Phases:
        'starting', 'checkpointing', 'finished'. Default: no-op."""


class SchedulerWorker(ABC):
    """An execution slot. Stateless beyond its id, capacity and running tasks."""

    def __init__(self, worker_id: str, *, max_concurrency: int = 1, capabilities: list[str] | None = None):
        self.id = worker_id
        self.max_concurrency = max(1, max_concurrency)
        self.capabilities = capabilities or []
        self._sem = asyncio.Semaphore(self.max_concurrency)
        self._running: set[asyncio.Task] = set()
        self.status = "IDLE"

    def can_accept(self) -> bool:
        return not self._sem.locked()

    @abstractmethod
    async def execute(self, job: S.ScheduledJob, schedule: S.Schedule) -> ExecutionResult:
        ...

    async def run(self, job: S.ScheduledJob, schedule: S.Schedule) -> ExecutionResult:
        """Acquire a slot and execute, tracking the task for shutdown."""
        async with self._sem:
            self.status = "BUSY"
            task = asyncio.current_task()
            if task is not None:
                self._running.add(task)
            try:
                return await self.execute(job, schedule)
            finally:
                if task is not None:
                    self._running.discard(task)
                self.status = "BUSY" if self.active > 0 else "IDLE"

    @property
    def active(self) -> int:
        return len(self._running)

    async def stop(self) -> None:
        """Cancel in-flight tasks (used at shutdown after the grace period)."""
        for t in list(self._running):
            t.cancel()


class FunctionWorker(SchedulerWorker):
    """A worker that delegates to an async `fn(job, schedule) -> ExecutionResult`.
    The common case: the service wraps its research-driving callable in this."""

    def __init__(self, worker_id: str, fn: Callable[[S.ScheduledJob, S.Schedule], Awaitable[ExecutionResult]],
                 *, max_concurrency: int = 1, capabilities: list[str] | None = None):
        super().__init__(worker_id, max_concurrency=max_concurrency, capabilities=capabilities)
        self._fn = fn

    async def execute(self, job: S.ScheduledJob, schedule: S.Schedule) -> ExecutionResult:
        return await self._fn(job, schedule)


class WorkerPool:
    """A fixed set of workers. `pick()` returns a worker with free capacity, or
    None. Round-robin over eligible workers keeps load roughly even."""

    def __init__(self, workers: list[SchedulerWorker] | None = None):
        self.workers = workers or []
        self._rr = 0

    def add(self, worker: SchedulerWorker) -> None:
        self.workers.append(worker)

    def pick(self, required_caps: list[str] | None = None) -> SchedulerWorker | None:
        req = set(required_caps or [])
        eligible = [
            w for w in self.workers
            if w.can_accept() and (not req or req.issubset(set(w.capabilities)))
        ]
        if not eligible:
            return None
        # rotate for even distribution
        self._rr = (self._rr + 1) % len(eligible)
        ordered = eligible[self._rr:] + eligible[: self._rr]
        return ordered[0]

    def total_capacity(self) -> int:
        return sum(w.max_concurrency for w in self.workers)

    def used_capacity(self) -> int:
        return sum(w.active for w in self.workers)

    def has_capacity(self) -> bool:
        return any(w.can_accept() for w in self.workers)

    def snapshot(self) -> list[dict]:
        return [
            {"id": w.id, "status": w.status, "active": w.active,
             "maxConcurrency": w.max_concurrency, "capabilities": w.capabilities}
            for w in self.workers
        ]

    async def stop(self) -> None:
        for w in self.workers:
            await w.stop()
