"""Canonical model for the Scheduler — the durable temporal execution layer.

A `Schedule` is WHEN a research run should happen; a `ScheduledJob` is one
execution instance of that schedule. They are deliberately separate (spec §7): a
schedule "every 6 hours" produces many jobs, each with its own lifecycle, lease
and attempt history. A `ResearchRun` is referenced by id, never duplicated here —
the State Manager stays the single source of truth for research state (spec §38).

Dataclasses with `to_row`/`from_row`/`to_dict`, matching the rest of
`agent.research`, so everything round-trips through the shared SQLite store.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from typing import Any

from ..models import new_id, now_ms

# ── schedule type (spec §5, §6) ──────────────────────────────────────────────
TYPE_IMMEDIATE = "IMMEDIATE"
TYPE_ONCE = "ONCE"
TYPE_DELAYED = "DELAYED"
TYPE_RECURRING = "RECURRING"  # umbrella: interval/cron below are the concrete ones
TYPE_CRON = "CRON"
TYPE_INTERVAL = "INTERVAL"
TYPE_EVENT = "EVENT"
TYPE_DEPENDENCY = "DEPENDENCY"

SCHEDULE_TYPES = (
    TYPE_IMMEDIATE, TYPE_ONCE, TYPE_DELAYED, TYPE_RECURRING,
    TYPE_CRON, TYPE_INTERVAL, TYPE_EVENT, TYPE_DEPENDENCY,
)

# ── schedule status (spec §5) ────────────────────────────────────────────────
SCHED_ACTIVE = "ACTIVE"
SCHED_PAUSED = "PAUSED"
SCHED_COMPLETED = "COMPLETED"
SCHED_CANCELLED = "CANCELLED"
SCHED_FAILED = "FAILED"

SCHEDULE_STATUSES = (SCHED_ACTIVE, SCHED_PAUSED, SCHED_COMPLETED, SCHED_CANCELLED, SCHED_FAILED)

# ── job status — the explicit state machine (spec §8, §36) ───────────────────
JOB_SCHEDULED = "SCHEDULED"
JOB_READY = "READY"
JOB_QUEUED = "QUEUED"
JOB_RUNNING = "RUNNING"
JOB_CHECKPOINTING = "CHECKPOINTING"
JOB_WAITING = "WAITING"          # blocked on resources / rate limit / dependency
JOB_RETRYING = "RETRYING"
JOB_PAUSED = "PAUSED"
JOB_COMPLETED = "COMPLETED"
JOB_FAILED = "FAILED"
JOB_CANCELLED = "CANCELLED"
JOB_EXPIRED = "EXPIRED"
JOB_DEAD_LETTER = "DEAD_LETTER"

JOB_STATUSES = (
    JOB_SCHEDULED, JOB_READY, JOB_QUEUED, JOB_RUNNING, JOB_CHECKPOINTING, JOB_WAITING,
    JOB_RETRYING, JOB_PAUSED, JOB_COMPLETED, JOB_FAILED, JOB_CANCELLED, JOB_EXPIRED, JOB_DEAD_LETTER,
)
# statuses from which nothing further happens without an explicit operator action
JOB_TERMINAL = frozenset({JOB_COMPLETED, JOB_CANCELLED, JOB_EXPIRED, JOB_DEAD_LETTER})
# statuses that occupy a worker slot / a concurrency instance
JOB_ACTIVE = frozenset({JOB_RUNNING, JOB_CHECKPOINTING})

# ── priority (spec §9) ───────────────────────────────────────────────────────
PRIORITY_CRITICAL = "CRITICAL"
PRIORITY_HIGH = "HIGH"
PRIORITY_NORMAL = "NORMAL"
PRIORITY_LOW = "LOW"

PRIORITIES = (PRIORITY_CRITICAL, PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_LOW)
PRIORITY_RANK = {PRIORITY_CRITICAL: 0, PRIORITY_HIGH: 1, PRIORITY_NORMAL: 2, PRIORITY_LOW: 3}
PRIORITY_WEIGHT = {PRIORITY_CRITICAL: 100.0, PRIORITY_HIGH: 50.0, PRIORITY_NORMAL: 20.0, PRIORITY_LOW: 5.0}

# ── concurrency policy (spec §10) ────────────────────────────────────────────
CONC_ALLOW_PARALLEL = "ALLOW_PARALLEL"
CONC_SINGLE_INSTANCE = "SINGLE_INSTANCE"
CONC_MAX_INSTANCES = "MAX_INSTANCES"

CONCURRENCY_MODES = (CONC_ALLOW_PARALLEL, CONC_SINGLE_INSTANCE, CONC_MAX_INSTANCES)

# ── retry strategy (spec §15) ────────────────────────────────────────────────
RETRY_FIXED = "FIXED"
RETRY_LINEAR = "LINEAR"
RETRY_EXPONENTIAL = "EXPONENTIAL"
RETRY_EXPONENTIAL_JITTER = "EXPONENTIAL_JITTER"

RETRY_STRATEGIES = (RETRY_FIXED, RETRY_LINEAR, RETRY_EXPONENTIAL, RETRY_EXPONENTIAL_JITTER)

# ── retry classification (spec §16) ──────────────────────────────────────────
RETRYABLE = "RETRYABLE"
NON_RETRYABLE = "NON_RETRYABLE"
RETRY_UNKNOWN = "UNKNOWN"

RETRY_CLASSES = (RETRYABLE, NON_RETRYABLE, RETRY_UNKNOWN)

# ── dependency condition (spec §6, §56) ──────────────────────────────────────
DEP_SUCCESS = "SUCCESS"
DEP_COMPLETED = "COMPLETED"
DEP_PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
DEP_FAILED = "FAILED"

DEPENDENCY_CONDITIONS = (DEP_SUCCESS, DEP_COMPLETED, DEP_PARTIAL_SUCCESS, DEP_FAILED)


@dataclass
class RetryPolicy:
    """Pluggable retry policy (spec §15). Delay between attempts is computed by
    the strategy in `retry.py`; this is only the data."""

    max_attempts: int = 3
    strategy: str = RETRY_EXPONENTIAL_JITTER
    base_delay_ms: int = 10_000
    max_delay_ms: int = 600_000
    jitter: float = 0.2  # fraction of the delay, applied ±

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> RetryPolicy:
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ConcurrencyPolicy:
    """How many instances of one schedule may run at once (spec §10)."""

    mode: str = CONC_SINGLE_INSTANCE
    max_instances: int = 1

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> ConcurrencyPolicy:
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    def limit(self) -> int:
        if self.mode == CONC_ALLOW_PARALLEL:
            return 1 << 30
        if self.mode == CONC_MAX_INSTANCES:
            return max(1, self.max_instances)
        return 1  # SINGLE_INSTANCE


@dataclass
class ResourceRequirements:
    """What a job needs to run (spec §30). Compared against the ResourceManager."""

    cpu: float = 0.0
    memory_mb: float = 0.0
    slots: int = 1                 # worker slots
    provider_requests: int = 0     # upstream LLM/tool calls
    class_: str = "default"        # a resource class, e.g. "network", "llm"
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["class"] = d.pop("class_")
        return d

    @classmethod
    def from_dict(cls, d: dict | None) -> ResourceRequirements:
        d = dict(d or {})
        if "class" in d:
            d["class_"] = d.pop("class")
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class Schedule:
    """WHEN a research run should execute. One run may have several schedules."""

    id: str
    research_run_id: str
    type: str = TYPE_IMMEDIATE
    status: str = SCHED_ACTIVE
    # trigger specification — meaning depends on `type`
    cron: str = ""
    interval_s: int = 0
    at_ms: int | None = None       # ONCE / DELAYED absolute epoch ms (canonical)
    delay_s: int = 0               # DELAYED relative seconds
    event: str = ""                # EVENT: the event name to match
    depends_on: list[str] = field(default_factory=list)   # DEPENDENCY: job ids
    dep_condition: str = DEP_COMPLETED
    timezone: str = "UTC"
    priority: str = PRIORITY_NORMAL
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    concurrency: ConcurrencyPolicy = field(default_factory=ConcurrencyPolicy)
    resources: ResourceRequirements = field(default_factory=ResourceRequirements)
    deadline_ms: int | None = None
    # runtime bookkeeping
    next_run_at: int | None = None
    last_run_at: int | None = None
    run_count: int = 0
    max_runs: int | None = None         # runaway guard (spec §60)
    max_runs_per_hour: int = 0          # 0 = unlimited
    created_by: str = "SYSTEM"          # SYSTEM | USER (audit, spec §59)
    metadata: dict = field(default_factory=dict)
    created_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)

    def is_finished(self) -> bool:
        """A schedule that will produce no further jobs."""
        if self.status in (SCHED_CANCELLED, SCHED_COMPLETED, SCHED_FAILED):
            return True
        if self.max_runs is not None and self.run_count >= self.max_runs:
            return True
        # one-shot types are done once they have produced their single job
        return self.type in (TYPE_IMMEDIATE, TYPE_ONCE, TYPE_DELAYED) and self.run_count >= 1

    def to_row(self) -> dict:
        d = asdict(self)
        d["retry"] = json.dumps(self.retry.to_dict(), ensure_ascii=False)
        d["concurrency"] = json.dumps(self.concurrency.to_dict(), ensure_ascii=False)
        d["resources"] = json.dumps(self.resources.to_dict(), ensure_ascii=False)
        d["depends_on"] = json.dumps(self.depends_on, ensure_ascii=False)
        d["metadata"] = json.dumps(self.metadata, ensure_ascii=False)
        d["at"] = d.pop("at_ms")
        d["deadline"] = d.pop("deadline_ms")
        return d

    @classmethod
    def from_row(cls, row: dict) -> Schedule:
        d = dict(row)
        d["at_ms"] = d.pop("at", None)
        d["deadline_ms"] = d.pop("deadline", None)
        d["retry"] = RetryPolicy.from_dict(_maybe_json(d.get("retry")))
        d["concurrency"] = ConcurrencyPolicy.from_dict(_maybe_json(d.get("concurrency")))
        d["resources"] = ResourceRequirements.from_dict(_maybe_json(d.get("resources")))
        d["depends_on"] = _maybe_json(d.get("depends_on")) or []
        d["metadata"] = _maybe_json(d.get("metadata")) or {}
        return cls(**{k: v for k, v in d.items() if k in _fields(cls)})

    def to_dict(self) -> dict:
        d = asdict(self)
        d["at"] = self.at_ms
        d["deadline"] = self.deadline_ms
        return d

    def summary(self) -> dict:
        return {
            "id": self.id,
            "researchRunId": self.research_run_id,
            "type": self.type,
            "status": self.status,
            "priority": self.priority,
            "cron": self.cron,
            "intervalS": self.interval_s,
            "at": self.at_ms,
            "delayS": self.delay_s,
            "event": self.event,
            "dependsOn": self.depends_on,
            "depCondition": self.dep_condition,
            "timezone": self.timezone,
            "nextRunAt": self.next_run_at,
            "lastRunAt": self.last_run_at,
            "runCount": self.run_count,
            "maxRuns": self.max_runs,
            "retry": self.retry.to_dict(),
            "concurrency": self.concurrency.to_dict(),
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


@dataclass
class ScheduledJob:
    """One execution instance of a Schedule."""

    id: str
    schedule_id: str
    research_run_id: str
    status: str = JOB_SCHEDULED
    priority: str = PRIORITY_NORMAL
    scheduled_at: int = field(default_factory=now_ms)
    ready_at: int | None = None        # when it became eligible (for queue latency)
    started_at: int | None = None
    completed_at: int | None = None
    attempt: int = 0
    max_attempts: int = 3
    worker_id: str = ""
    lease_id: str = ""
    idempotency_key: str = ""
    dependency_ids: list[str] = field(default_factory=list)
    dep_condition: str = DEP_COMPLETED
    resources: ResourceRequirements = field(default_factory=ResourceRequirements)
    last_error: dict = field(default_factory=dict)   # {"class","kind","message","retryable"}
    decision: str = ""                 # last scheduling decision (spec §51)
    decision_reasons: list[str] = field(default_factory=list)
    wait_reason: str = ""              # why it is WAITING (spec §50)
    checkpoint_iteration: int | None = None
    replay_of: str = ""                # original execution id (spec §58)
    created_by: str = "SYSTEM"
    metadata: dict = field(default_factory=dict)
    created_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)

    def is_terminal(self) -> bool:
        return self.status in JOB_TERMINAL

    def is_active(self) -> bool:
        return self.status in JOB_ACTIVE

    def to_row(self) -> dict:
        d = asdict(self)
        d["resources"] = json.dumps(self.resources.to_dict(), ensure_ascii=False)
        d["dependency_ids"] = json.dumps(self.dependency_ids, ensure_ascii=False)
        d["last_error"] = json.dumps(self.last_error, ensure_ascii=False)
        d["decision_reasons"] = json.dumps(self.decision_reasons, ensure_ascii=False)
        d["metadata"] = json.dumps(self.metadata, ensure_ascii=False)
        return d

    @classmethod
    def from_row(cls, row: dict) -> ScheduledJob:
        d = dict(row)
        d["resources"] = ResourceRequirements.from_dict(_maybe_json(d.get("resources")))
        d["dependency_ids"] = _maybe_json(d.get("dependency_ids")) or []
        d["last_error"] = _maybe_json(d.get("last_error")) or {}
        d["decision_reasons"] = _maybe_json(d.get("decision_reasons")) or []
        d["metadata"] = _maybe_json(d.get("metadata")) or {}
        return cls(**{k: v for k, v in d.items() if k in _fields(cls)})

    def to_dict(self) -> dict:
        return asdict(self)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "scheduleId": self.schedule_id,
            "researchRunId": self.research_run_id,
            "status": self.status,
            "priority": self.priority,
            "scheduledAt": self.scheduled_at,
            "readyAt": self.ready_at,
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
            "attempt": self.attempt,
            "maxAttempts": self.max_attempts,
            "workerId": self.worker_id,
            "leaseId": self.lease_id,
            "idempotencyKey": self.idempotency_key,
            "dependencyIds": self.dependency_ids,
            "lastError": self.last_error,
            "decision": self.decision,
            "decisionReasons": self.decision_reasons,
            "waitReason": self.wait_reason,
            "checkpointIteration": self.checkpoint_iteration,
            "replayOf": self.replay_of,
            "createdBy": self.created_by,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }


@dataclass
class ExecutionAttempt:
    """One attempt at running a job — the durable audit of every try (spec §43, §59)."""

    id: str
    job_id: str
    worker_id: str = ""
    attempt: int = 0
    started_at: int = field(default_factory=now_ms)
    finished_at: int | None = None
    outcome: str = ""            # completed | failed | retried | cancelled | recovered
    error_class: str = ""        # RETRYABLE | NON_RETRYABLE | UNKNOWN
    error_kind: str = ""
    error_message: str = ""
    iteration_from: int | None = None
    iteration_to: int | None = None
    detail: dict = field(default_factory=dict)

    def to_row(self) -> dict:
        d = asdict(self)
        d["detail"] = json.dumps(self.detail, ensure_ascii=False)
        return d

    @classmethod
    def from_row(cls, row: dict) -> ExecutionAttempt:
        d = dict(row)
        d["detail"] = _maybe_json(d.get("detail")) or {}
        return cls(**{k: v for k, v in d.items() if k in _fields(cls)})

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ExecutionLease:
    """A cross-process claim on a job (spec §11). Persisted, never in-memory only."""

    job_id: str
    worker_id: str
    lease_id: str
    acquired_at: int = field(default_factory=now_ms)
    expires_at: int = 0
    heartbeat_at: int = field(default_factory=now_ms)

    def is_expired(self, now: int) -> bool:
        return now >= self.expires_at

    def to_row(self) -> dict:
        return asdict(self)

    @classmethod
    def from_row(cls, row: dict) -> ExecutionLease:
        return cls(**{k: v for k, v in row.items() if k in _fields(cls)})

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WorkerRecord:
    """A registered worker and its liveness (spec §12, §13)."""

    id: str
    capabilities: list[str] = field(default_factory=list)
    max_concurrency: int = 1
    status: str = "STARTING"  # STARTING | IDLE | BUSY | STOPPING | STOPPED | STALE
    started_at: int = field(default_factory=now_ms)
    last_heartbeat_at: int = field(default_factory=now_ms)
    stopped_at: int | None = None
    active_jobs: int = 0
    completed_jobs: int = 0
    failed_jobs: int = 0
    metadata: dict = field(default_factory=dict)

    def is_stale(self, now: int, threshold_ms: int) -> bool:
        return (now - self.last_heartbeat_at) > threshold_ms and self.status not in ("STOPPED",)

    def to_row(self) -> dict:
        d = asdict(self)
        d["capabilities"] = json.dumps(self.capabilities, ensure_ascii=False)
        d["metadata"] = json.dumps(self.metadata, ensure_ascii=False)
        return d

    @classmethod
    def from_row(cls, row: dict) -> WorkerRecord:
        d = dict(row)
        d["capabilities"] = _maybe_json(d.get("capabilities")) or []
        d["metadata"] = _maybe_json(d.get("metadata")) or {}
        return cls(**{k: v for k, v in d.items() if k in _fields(cls)})

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScheduleDecision:
    """The scheduler's explanation of why it did (or did not) run a job (spec §51)."""

    job_id: str
    decision: str = ""     # RUN | WAIT | RETRY | DEFER | SKIP | STOP
    reasons: list[str] = field(default_factory=list)
    next_attempt_at: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _fields(cls) -> set[str]:
    return {f.name for f in fields(cls)}


def _maybe_json(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return None
    return v


def make_schedule_id() -> str:
    return new_id("sch_")


def make_job_id() -> str:
    return new_id("job_")


def make_attempt_id() -> str:
    return new_id("att_")


def make_lease_id() -> str:
    return new_id("lease_")


def idempotency_key(schedule_id: str, scheduled_at: int, *extra: Any) -> str:
    """A deterministic key that makes a (schedule, occurrence) pair unique, so a
    re-delivered trigger cannot create a second job (spec §25, §26)."""
    parts = [schedule_id, str(scheduled_at), *[str(e) for e in extra if e not in (None, "")]]
    return "|".join(parts)
