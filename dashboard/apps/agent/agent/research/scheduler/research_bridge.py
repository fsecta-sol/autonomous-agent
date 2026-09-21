"""The bridge from the Scheduler to the Research Loop (spec §2, §39).

The scheduler carries no research logic; this is the one place the two meet. A
`ResearchJobDriver` takes a job + its schedule, drives the referenced Research Run
to its next resting point (WAIT / PAUSE / terminal), and reports an
`ExecutionResult` the scheduler maps onto job lifecycle. It also translates the
run's terminal status and its WAIT intent into the scheduler's vocabulary.

Two run shapes are supported:

  * **advance an existing run** — the common case: a schedule wakes a long-lived
    run so it can continue (spec §22, §64). The run is resumed if waiting, then
    advanced.
  * **start a fresh run** — when the schedule carries a `run_request` in its
    metadata, each fire creates a new Research Run (the "periodic new research"
    pattern). The created run id is recorded on the job, never written back as the
    schedule's run, so the next fire starts another.

A completed/failed run marks the schedule done via `ExecutionResult.outcome`,
which the scheduler turns into a no-further-fires schedule state.
"""

from __future__ import annotations

import logging

from .. import models as M
from . import model as S
from .worker import ExecutionResult, JobDriver

log = logging.getLogger("agent.research.scheduler.bridge")

# default wait when a run is WAITING but named no explicit wake time
DEFAULT_WAIT_S = 300


class ResearchJobDriver(JobDriver):
    """Drives a Research Run for one scheduled job. Holds the loop factory (the
    service's `loop_for`), never the loop itself, so it stays stateless per run."""

    def __init__(self, service, *, default_wait_s: int = DEFAULT_WAIT_S):
        self.service = service
        self.default_wait_s = default_wait_s

    async def drive(self, job: S.ScheduledJob, schedule: S.Schedule) -> ExecutionResult:
        run_id = job.research_run_id
        store = self.service.store
        run = await store.get_run(run_id) if run_id else None

        if run is None:
            created = await self._start_new_run(job, schedule)
            if created is None:
                return ExecutionResult(
                    outcome="failed", failure_kind=M.FAIL_BLOCKED,
                    failure_message=f"research run {run_id!r} not found and no run_request",
                )
            run = created
            run_id = run.id
            job.metadata["created_run_id"] = run.id

        return await self._advance_run(job, schedule, run)

    async def _start_new_run(self, job: S.ScheduledJob, schedule: S.Schedule):
        req = (schedule.metadata or {}).get("run_request")
        if not isinstance(req, dict) or not req.get("objective"):
            return None
        loop = await self.service.loop_for("__pending__", config=req.get("config"),
                                           research_config=req.get("research_config"))
        run = await loop.start(req)
        # re-key the cached loop under the real id (same as the /research/runs path)
        self.service._loops.pop("__pending__", None)
        self.service._loops[run.id] = loop
        return run

    async def _advance_run(self, job: S.ScheduledJob, schedule: S.Schedule, run: M.ResearchRun) -> ExecutionResult:
        loop = await self.service.loop_for(run.id)

        if run.is_terminal():
            return self._terminal_result(job, run)

        # resume a waiting/paused run so `advance` can proceed
        if run.status in (M.RUN_WAITING, M.RUN_PAUSED):
            run = await loop.resume(run.id)

        try:
            run = await loop.advance(run.id)
        except Exception as exc:
            log.exception("advancing run %s failed", run.id)
            from .retry import classify_error

            _cls, kind, msg = classify_error(exc)
            return ExecutionResult(outcome="failed", failure_kind=kind or "DRIVER_ERROR", failure_message=msg)

        if run.is_terminal():
            return self._terminal_result(job, run)

        if run.status in (M.RUN_WAITING, M.RUN_PAUSED):
            # translate the run's WAIT intent into a scheduler wake-up (spec §22, §23)
            wake_at = self._wake_time(run, schedule)
            wait_event = run.metadata.get("wait_event") if isinstance(run.metadata, dict) else None
            return ExecutionResult(
                outcome="waiting",
                iteration_to=run.iteration,
                waiting_until_ms=wake_at if not wait_event else None,
                wait_event=wait_event or "",
                detail={"run_status": run.status, "stage": run.stage},
            )

        # advance returned without reaching a resting point (e.g. step cap) — let
        # the scheduler retry/requeue per policy
        return ExecutionResult(
            outcome="waiting", iteration_to=run.iteration,
            waiting_until_ms=self.service.scheduler.clock.now_ms() + 1000,
            detail={"run_status": run.status, "stage": run.stage, "note": "step cap reached"},
        )

    def _terminal_result(self, job: S.ScheduledJob, run: M.ResearchRun) -> ExecutionResult:
        if run.status == M.RUN_COMPLETED:
            return ExecutionResult(outcome="completed", iteration_from=0, iteration_to=run.iteration,
                                   detail={"run_status": run.status, "run_terminal": True})
        if run.status == M.RUN_CANCELLED:
            return ExecutionResult(outcome="cancelled", detail={"run_status": run.status})
        if run.status == M.RUN_BLOCKED:
            return ExecutionResult(outcome="blocked", failure_kind=M.FAIL_BLOCKED,
                                   failure_message=run.termination_reason or "run blocked")
        # RUN_FAILED
        return ExecutionResult(outcome="failed",
                               failure_kind=self._failure_kind(run),
                               failure_message=run.termination_reason or "run failed",
                               detail={"run_status": run.status, "run_terminal": True})

    @staticmethod
    def _failure_kind(run: M.ResearchRun) -> str:
        """Map a run's termination reason onto the research failure taxonomy so the
        retry classifier can decide retryable vs permanent."""
        reason = (run.termination_reason or "").upper()
        if "TIME" in reason:
            return M.FAIL_TIMEOUT
        if "BUDGET" in reason:
            return M.FAIL_BUDGET
        if "BLOCK" in reason:
            return M.FAIL_BLOCKED
        if "TOOL" in reason:
            return M.FAIL_TOOL
        return M.FAIL_INSUFFICIENT_EVIDENCE

    def _wake_time(self, run: M.ResearchRun, schedule: S.Schedule) -> int:
        """When should a WAITING run be woken? An explicit `wait_until_ms` on the
        run wins; else the schedule's next occurrence; else a small default."""
        meta = run.metadata if isinstance(run.metadata, dict) else {}
        explicit = meta.get("wait_until_ms")
        if isinstance(explicit, int):
            return explicit
        now = self.service.scheduler.clock.now_ms()
        if schedule.next_run_at is not None and schedule.next_run_at > now:
            return schedule.next_run_at
        return now + self.default_wait_s * 1000
