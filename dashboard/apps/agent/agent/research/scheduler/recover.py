"""Recovery policies (spec §14, §42, §47, §54).

On startup — and whenever the scheduler ticks — it must reconcile durable state
with reality: a job persisted RUNNING whose worker died, a lease that expired, a
worker whose heartbeat went stale. A `RecoveryPolicy` decides, per job, what to
do: requeue it (the normal case), count the attempt against the retry budget, or
mark it failed / dead-letter. Policies are registered so a deployment can plug its
own recovery semantics (spec §53).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..registry import Registry
from . import model as S

log = logging.getLogger("agent.research.scheduler.recover")

RECOVERY_REGISTRY: Registry[RecoveryPolicy] = Registry("recovery_policy")

# recovery actions
ACTION_REQUEUE = "REQUEUE"
ACTION_MARK_FAILED = "MARK_FAILED"
ACTION_MARK_DEAD_LETTER = "MARK_DEAD_LETTER"
ACTION_SKIP = "SKIP"


@dataclass
class RecoveryContext:
    now_ms: int
    lease_expired: bool = False
    worker_stale: bool = False
    process_restarted: bool = False
    attempts: int = 0
    max_attempts: int = 3


@dataclass
class RecoveryDecision:
    job_id: str
    action: str = ACTION_REQUEUE
    reason: str = ""
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"jobId": self.job_id, "action": self.action, "reason": self.reason, "reasons": self.reasons}


class RecoveryPolicy(ABC):
    name: str = ""

    @abstractmethod
    def can_recover(self, job: S.ScheduledJob) -> bool:
        ...

    @abstractmethod
    def recover(self, job: S.ScheduledJob, ctx: RecoveryContext) -> RecoveryDecision:
        ...


class DefaultRecoveryPolicy(RecoveryPolicy):
    """Requeue a recoverable job, spending one attempt; dead-letter once the
    attempts are exhausted. A job with a NON_RETRYABLE last error is failed
    outright rather than requeued forever."""

    name = "default"

    def can_recover(self, job: S.ScheduledJob) -> bool:
        # only active jobs can need recovery; terminal jobs are left alone
        return job.status in (S.JOB_RUNNING, S.JOB_CHECKPOINTING)

    def recover(self, job: S.ScheduledJob, ctx: RecoveryContext) -> RecoveryDecision:
        reasons = []
        if ctx.lease_expired:
            reasons.append("lease expired (worker stopped heartbeating)")
        if ctx.worker_stale:
            reasons.append("worker heartbeat stale")
        if ctx.process_restarted:
            reasons.append("process restarted with job active")

        last_class = (job.last_error or {}).get("class")
        if last_class == S.NON_RETRYABLE:
            return RecoveryDecision(job.id, ACTION_MARK_FAILED,
                                    "non-retryable error; not requeued", reasons)

        next_attempt = ctx.attempts + 1
        if next_attempt > ctx.max_attempts:
            return RecoveryDecision(job.id, ACTION_MARK_DEAD_LETTER,
                                    f"recovery would exceed max attempts ({ctx.max_attempts})", reasons)

        return RecoveryDecision(job.id, ACTION_REQUEUE,
                                f"recovering (attempt {next_attempt}/{ctx.max_attempts})", reasons)


class WorkerCrashRecovery(DefaultRecoveryPolicy):
    name = "worker_crash"

    def can_recover(self, job: S.ScheduledJob) -> bool:
        return job.is_active()


class LeaseExpirationRecovery(DefaultRecoveryPolicy):
    name = "lease_expiration"

    def can_recover(self, job: S.ScheduledJob) -> bool:
        return job.is_active()


class DeploymentRecovery(DefaultRecoveryPolicy):
    """On a planned restart/deploy, jobs left active are requeued once."""

    name = "deployment"

    def recover(self, job: S.ScheduledJob, ctx: RecoveryContext) -> RecoveryDecision:
        ctx.process_restarted = True
        return super().recover(job, ctx)


RECOVERY_REGISTRY.register("default", DefaultRecoveryPolicy())
RECOVERY_REGISTRY.register("worker_crash", WorkerCrashRecovery())
RECOVERY_REGISTRY.register("lease_expiration", LeaseExpirationRecovery())
RECOVERY_REGISTRY.register("deployment", DeploymentRecovery())

DEFAULT_RECOVERY = "default"
