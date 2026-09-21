"""The Modular Autonomous Research Scheduler — a durable temporal execution layer.

Decides WHEN research runs (never WHAT): persistent schedules fire triggers into a
durable job queue, workers claim jobs under cross-process leases, retries use
backoff + jitter, and every decision is explainable. Built to survive process
restarts, worker crashes and deployment — the durable state is the source of
truth; in-memory timers are only an optimization (spec §45, §46, §65).

    model.py      Schedule, ScheduledJob, ExecutionAttempt, ExecutionLease, ...
    timeutil.py   Clock (System/Fake) + tz-aware helpers
    cron.py       a small 5-field cron parser
    triggers.py   Trigger ABC + Immediate/Once/Delayed/Interval/Cron/Event/Dependency/Manual
    policy.py     SchedulingPolicy: FIFO / PRIORITY / PRIORITY_WITH_AGING
    retry.py      backoff strategies + error classification
    lease.py      LeaseManager (durable cross-process claims)
    resources.py  ResourceManager + RateLimiter + backpressure
    safety.py     runaway guard + event coalescer + circuit breaker
    worker.py     SchedulerWorker + WorkerPool + JobDriver interface
    recover.py    RecoveryPolicy + concrete recovery policies
    metrics.py    SchedulerMetrics
    scheduler.py  the Scheduler core (contract §4) + wake-up loop + startup recovery
    config.py     SchedulerConfig (env-driven, no hardcoded policy)

The Research Loop is reached only through the injected `JobDriver`, so the
scheduler carries no research logic (spec §2, §38, §39).
"""

from .config import SchedulerConfig
from .model import Schedule, ScheduledJob
from .scheduler import SCHEDULER_REGISTRY, Scheduler, ScheduleRequest
from .worker import ExecutionResult, FunctionWorker, JobDriver, SchedulerWorker, WorkerPool

__all__ = [
    "SCHEDULER_REGISTRY",
    "ExecutionResult",
    "FunctionWorker",
    "JobDriver",
    "Schedule",
    "ScheduleRequest",
    "ScheduledJob",
    "Scheduler",
    "SchedulerConfig",
    "SchedulerWorker",
    "WorkerPool",
]
