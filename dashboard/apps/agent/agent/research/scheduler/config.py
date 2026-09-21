"""Configuration for the Scheduler.

Mirrors the project's env-driven config style: every knob has a safe default via
`from_env`, and `from_dict` lets one deployment override without an env change
(spec §52 — policy is never hardcoded).
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


@dataclass
class SchedulerConfig:
    """The scheduler's tunable policy."""

    enabled: bool = True
    max_workers: int = 3
    worker_concurrency: int = 1
    queue_policy: str = "priority_with_aging"
    retry_policy: str = "EXPONENTIAL_JITTER"
    max_attempts: int = 3
    base_retry_delay_ms: int = 10_000
    max_retry_delay_ms: int = 600_000

    # leases + heartbeat (spec §11, §13)
    lease_ms: int = 60_000
    heartbeat_ms: int = 15_000
    stale_worker_ms: int = 90_000

    # capacity (spec §30)
    max_concurrent_runs: int = 5
    max_concurrent_agents: int = 10
    max_per_class: dict[str, int] = field(default_factory=lambda: {"network": 2, "llm": 10, "default": 5})
    max_queue_depth: int = 10_000

    # safety (spec §60-62)
    min_fire_interval_s: float = 5.0
    max_fires_per_hour: int = 120
    event_coalesce_ms: int = 1000
    circuit_breaker_threshold: int = 5
    circuit_breaker_cooldown_ms: int = 300_000

    # timing
    polling_interval_s: float = 1.0
    shutdown_grace_period_s: float = 30.0
    timezone: str = "UTC"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict | None) -> SchedulerConfig:
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    @classmethod
    def from_env(cls) -> SchedulerConfig:
        return cls(
            enabled=os.environ.get("AGENT_SCHEDULER_ENABLED", "1") != "0",
            max_workers=_env_int("AGENT_SCHEDULER_MAX_WORKERS", 3),
            worker_concurrency=_env_int("AGENT_SCHEDULER_WORKER_CONCURRENCY", 1),
            queue_policy=os.environ.get("AGENT_SCHEDULER_QUEUE_POLICY", "priority_with_aging"),
            retry_policy=os.environ.get("AGENT_SCHEDULER_RETRY_POLICY", "EXPONENTIAL_JITTER"),
            max_attempts=_env_int("AGENT_SCHEDULER_MAX_ATTEMPTS", 3),
            base_retry_delay_ms=_env_int("AGENT_SCHEDULER_BASE_DELAY_MS", 10_000),
            max_retry_delay_ms=_env_int("AGENT_SCHEDULER_MAX_DELAY_MS", 600_000),
            lease_ms=_env_int("AGENT_SCHEDULER_LEASE_MS", 60_000),
            heartbeat_ms=_env_int("AGENT_SCHEDULER_HEARTBEAT_MS", 15_000),
            stale_worker_ms=_env_int("AGENT_SCHEDULER_STALE_WORKER_MS", 90_000),
            max_concurrent_runs=_env_int("AGENT_SCHEDULER_MAX_CONCURRENT_RUNS", 5),
            max_concurrent_agents=_env_int("AGENT_SCHEDULER_MAX_CONCURRENT_AGENTS", 10),
            max_queue_depth=_env_int("AGENT_SCHEDULER_MAX_QUEUE_DEPTH", 10_000),
            min_fire_interval_s=_env_float("AGENT_SCHEDULER_MIN_FIRE_INTERVAL_S", 5.0),
            max_fires_per_hour=_env_int("AGENT_SCHEDULER_MAX_FIRES_PER_HOUR", 120),
            event_coalesce_ms=_env_int("AGENT_SCHEDULER_EVENT_COALESCE_MS", 1000),
            circuit_breaker_threshold=_env_int("AGENT_SCHEDULER_CB_THRESHOLD", 5),
            circuit_breaker_cooldown_ms=_env_int("AGENT_SCHEDULER_CB_COOLDOWN_MS", 300_000),
            polling_interval_s=_env_float("AGENT_SCHEDULER_POLL_S", 1.0),
            shutdown_grace_period_s=_env_float("AGENT_SCHEDULER_SHUTDOWN_GRACE_S", 30.0),
            timezone=os.environ.get("AGENT_SCHEDULER_TZ", "UTC"),
        )
