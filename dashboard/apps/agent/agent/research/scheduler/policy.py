"""Scheduling policies — which READY job runs next (spec §9, §33, §34).

A `SchedulingPolicy` inspects the set of candidate jobs plus the scheduling
context and returns the single job to run next (or None). The Scheduler core
depends only on this interface, so the fairness rule is swappable: `FIFO`,
`PRIORITY`, and `PRIORITY_WITH_AGING` are provided, and the last is the default
because it avoids starving a low-priority job behind a stream of high-priority
ones (spec §9).

Effective score blends: base priority weight, waiting time (aging), deadline
proximity, and a small depth-of-queue pressure term. Deterministic except for
explicitly age-based tie-breaks, so it is unit-testable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..registry import Registry
from . import model as S

SCHEDULING_POLICY_REGISTRY: Registry[SchedulingPolicy] = Registry("scheduling_policy")

# aging: how much score a job gains per minute waited. High enough that a LOW job
# eventually outranks a fresh HIGH one, low enough that a fresh CRITICAL still
# wins within a reasonable window.
_AGING_PER_MIN = 4.0
# deadline: score bonus scales with how close the deadline is
_DEADLINE_HORIZON_MS = 60 * 60 * 1000  # within the hour, deadline pressure grows


@dataclass
class SchedulingContext:
    """Inputs to a scheduling decision beyond the jobs themselves."""

    now_ms: int
    capacity: int = 1                      # how many slots are free right now
    used_by_run: dict[str, int] = field(default_factory=dict)  # active instances per run
    max_per_run: dict[str, int] = field(default_factory=dict)  # concurrency limit per run


class SchedulingPolicy(ABC):
    name: str = ""

    @abstractmethod
    def select_next(self, jobs: list[S.ScheduledJob], context: SchedulingContext) -> S.ScheduledJob | None:
        ...


class FifoPolicy(SchedulingPolicy):
    """Oldest scheduled_at first, ignoring priority. Useful for strict ordering."""

    name = "fifo"

    def select_next(self, jobs: list[S.ScheduledJob], context: SchedulingContext) -> S.ScheduledJob | None:
        if not jobs:
            return None
        return min(jobs, key=lambda j: (j.scheduled_at, j.created_at))


class PriorityPolicy(SchedulingPolicy):
    """Strict priority, oldest first within a priority band. Can starve LOW."""

    name = "priority"

    def select_next(self, jobs: list[S.ScheduledJob], context: SchedulingContext) -> S.ScheduledJob | None:
        if not jobs:
            return None
        return min(jobs, key=lambda j: (S.PRIORITY_RANK.get(j.priority, 99), j.scheduled_at))


class PriorityWithAgingPolicy(SchedulingPolicy):
    """Priority weighted with aging, deadline pressure and queue depth (spec §9).
    The default: fair to long-waiting jobs without letting a flood of LOW jobs
    preempt a genuinely urgent one."""

    name = "priority_with_aging"

    def select_next(self, jobs: list[S.ScheduledJob], context: SchedulingContext) -> S.ScheduledJob | None:
        if not jobs:
            return None
        now = context.now_ms
        best: S.ScheduledJob | None = None
        best_score = float("-inf")
        for j in jobs:
            score = _effective_score(j, now, len(jobs))
            if score > best_score:
                best_score = score
                best = j
        return best


def _effective_score(job: S.ScheduledJob, now_ms: int, queue_depth: int) -> float:
    base = S.PRIORITY_WEIGHT.get(job.priority, 20.0)
    waited_min = max(0.0, (now_ms - job.scheduled_at) / 60_000.0)
    aging = waited_min * _AGING_PER_MIN
    depth = min(20.0, queue_depth * 0.5)   # mild pressure toward more contention
    return base + aging + depth + _deadline_bonus(job, now_ms)


def _deadline_bonus(job: S.ScheduledJob, now_ms: int) -> float:
    """Extra score as a job's deadline approaches, so a soon-to-expire job floats
    up even against higher-priority peers (spec §29)."""
    # the deadline rides in metadata (set when the schedule has one and a job is made)
    deadline = job.metadata.get("deadline_ms") if isinstance(job.metadata, dict) else None
    if not deadline:
        return 0.0
    remaining = deadline - now_ms
    if remaining <= 0:
        return 60.0  # already at/over deadline — surface it first
    if remaining >= _DEADLINE_HORIZON_MS:
        return 0.0
    # linear ramp: 0 at the horizon, up to 50 just before the deadline
    closeness = 1.0 - (remaining / _DEADLINE_HORIZON_MS)
    return 50.0 * closeness


SCHEDULING_POLICY_REGISTRY.register("fifo", FifoPolicy())
SCHEDULING_POLICY_REGISTRY.register("priority", PriorityPolicy())
SCHEDULING_POLICY_REGISTRY.register("priority_with_aging", PriorityWithAgingPolicy())

DEFAULT_POLICY = "priority_with_aging"
