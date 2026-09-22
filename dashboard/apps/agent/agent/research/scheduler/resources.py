"""Resource management: budgets, concurrency, rate limits, backpressure (spec §30-32, §55).

The scheduler must not treat "queue has room" as "resources are available". A
`ResourceManager` reserves capacity before a job runs: global slots, per-class
slots (e.g. "network", "llm"), and token-bucket rate limits. When capacity is
missing the job stays WAITING — it is not failed (spec §32).

Everything is in-memory accounting over durable job state: the authoritative
"who holds a slot" is derived from the persisted RUNNING jobs at recovery, so a
restart rebuilds the counters rather than trusting a lost dict.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import model as S


@dataclass
class ResourceLimits:
    """Global and per-class ceilings (spec §30)."""

    max_concurrent_runs: int = 5
    max_concurrent_agents: int = 10
    max_per_class: dict[str, int] = field(default_factory=lambda: {"network": 2, "llm": 10, "default": 5})
    max_queue_depth: int = 10_000         # backpressure threshold (spec §55)
    max_per_run_instances: int = 1        # default single-instance per research run


class RateLimiter:
    """A token bucket (spec §32). `try_acquire(n)` succeeds only if `n` tokens are
    available; tokens refill continuously at `rate_per_s`. Not a failure when
    empty — the caller treats it as WAITING_FOR_CAPACITY."""

    def __init__(self, rate_per_s: float, burst: int, *, clock=time.monotonic):
        self.rate = max(0.0, rate_per_s)
        self.burst = max(1, burst)
        self._tokens = float(burst)
        self._last = clock()
        self._clock = clock

    def _refill(self) -> None:
        now = self._clock()
        elapsed = now - self._last
        if elapsed > 0 and self.rate > 0:
            self._tokens = min(self.burst, self._tokens + elapsed * self.rate)
        self._last = now

    def try_acquire(self, n: int = 1) -> bool:
        self._refill()
        if self._tokens >= n:
            self._tokens -= n
            return True
        return False

    def available(self) -> int:
        self._refill()
        return int(self._tokens)


class ResourceManager:
    """Tracks slot usage and decides whether a job may run now.

    `reserve(job)` returns (ok, reason). `release(job)` frees its slots. The
    scheduler calls `rehydrate(active_jobs)` at startup so counters reflect
    persisted RUNNING jobs (spec §47)."""

    def __init__(self, limits: ResourceLimits | None = None):
        self.limits = limits or ResourceLimits()
        self._global = 0
        self._by_class: dict[str, int] = {}
        self._by_run: dict[str, int] = {}
        self._agents = 0
        self._rate_limiters: dict[str, RateLimiter] = {}

    def set_rate_limit(self, name: str, rate_per_s: float, burst: int, *, clock=time.monotonic) -> None:
        self._rate_limiters[name] = RateLimiter(rate_per_s, burst, clock=clock)

    def rehydrate(self, active_jobs: list[S.ScheduledJob]) -> None:
        """Rebuild counters from persisted RUNNING jobs."""
        self._global = 0
        self._by_class = {}
        self._by_run = {}
        self._agents = 0
        for j in active_jobs:
            if not j.is_active():
                continue
            self._global += 1
            cls = j.resources.class_ or "default"
            self._by_class[cls] = self._by_class.get(cls, 0) + 1
            self._by_run[j.research_run_id] = self._by_run.get(j.research_run_id, 0) + 1
            self._agents += max(1, j.resources.slots)

    def try_reserve(self, job: S.ScheduledJob, *, run_limit: int | None = None) -> tuple[bool, list[str]]:
        """Attempt to reserve capacity for `job`. Returns (ok, reasons-if-not)."""
        reasons: list[str] = []
        if self._global >= self.limits.max_concurrent_runs:
            reasons.append(f"global concurrency limit reached ({self.limits.max_concurrent_runs})")
        cls = job.resources.class_ or "default"
        cls_cap = self.limits.max_per_class.get(cls)
        if cls_cap is not None and self._by_class.get(cls, 0) >= cls_cap:
            reasons.append(f"resource class '{cls}' at capacity ({cls_cap})")
        eff_run_limit = run_limit if run_limit is not None else self.limits.max_per_run_instances
        if self._by_run.get(job.research_run_id, 0) >= eff_run_limit:
            reasons.append(f"research run already has {eff_run_limit} active instance(s)")
        if self._agents + max(1, job.resources.slots) > self.limits.max_concurrent_agents:
            reasons.append(f"agent limit reached ({self.limits.max_concurrent_agents})")
        if reasons:
            return False, reasons
        self._global += 1
        self._by_class[cls] = self._by_class.get(cls, 0) + 1
        self._by_run[job.research_run_id] = self._by_run.get(job.research_run_id, 0) + 1
        self._agents += max(1, job.resources.slots)
        return True, []

    def release(self, job: S.ScheduledJob) -> None:
        cls = job.resources.class_ or "default"
        self._global = max(0, self._global - 1)
        self._by_class[cls] = max(0, self._by_class.get(cls, 0) - 1)
        self._by_run[job.research_run_id] = max(0, self._by_run.get(job.research_run_id, 0) - 1)
        self._agents = max(0, self._agents - max(1, job.resources.slots))

    def acquire_rate(self, name: str, n: int = 1) -> bool:
        """Acquire `n` from a named rate limiter; True if none is configured."""
        limiter = self._rate_limiters.get(name)
        if limiter is None:
            return True
        return limiter.try_acquire(n)

    def has_capacity(self) -> bool:
        return self._global < self.limits.max_concurrent_runs

    def snapshot(self) -> dict:
        return {
            "globalActive": self._global,
            "maxConcurrentRuns": self.limits.max_concurrent_runs,
            "byClass": dict(self._by_class),
            "byRun": dict(self._by_run),
            "agents": self._agents,
            "maxAgents": self.limits.max_concurrent_agents,
        }
