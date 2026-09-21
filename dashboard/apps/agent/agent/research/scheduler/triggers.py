"""Triggers — the modular "should this fire, and when next?" layer (spec §6, §35).

A `Trigger` is derived from a `Schedule` and answers two questions:
  * `next_occurrence(ctx)` — when should the next job be created (or None)?
  * `should_trigger(ctx)`  — should a job be created right now?

The concrete triggers map 1:1 to the schedule types. They are pure functions of
the schedule + time + event/dependency context, so they are trivially testable
and the Scheduler core never branches on schedule type directly — it looks the
trigger up in the registry.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..registry import Registry
from . import cron as cronlib
from . import model as S
from . import timeutil as T


@dataclass
class TriggerContext:
    """Everything a trigger needs to decide. `now_ms` and `tz` come from the
    scheduler's Clock; `events` are event names seen since the last evaluation;
    `dependency_states` maps a job id → its terminal status."""

    now_ms: int
    tz: str = "UTC"
    events: list[str] = field(default_factory=list)
    dependency_states: dict[str, str] = field(default_factory=dict)
    last_fire_ms: int | None = None


class Trigger(ABC):
    type: str = ""

    def __init__(self, schedule: S.Schedule):
        self.schedule = schedule

    @abstractmethod
    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        """The next instant this should fire (epoch ms), or None if never again."""

    def should_trigger(self, ctx: TriggerContext) -> bool:
        """Whether a job should be created now. Default: the next occurrence has
        arrived (or passed)."""
        nxt = self.next_occurrence(ctx)
        return nxt is not None and nxt <= ctx.now_ms

    def is_recurring(self) -> bool:
        return False


class ImmediateTrigger(Trigger):
    type = S.TYPE_IMMEDIATE

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        # fires once, as soon as it is scheduled
        return None if self.schedule.run_count >= 1 else ctx.now_ms

    def should_trigger(self, ctx: TriggerContext) -> bool:
        return self.schedule.run_count < 1


class OnceTrigger(Trigger):
    type = S.TYPE_ONCE

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        if self.schedule.run_count >= 1 or self.schedule.at_ms is None:
            return None
        return self.schedule.at_ms

    def should_trigger(self, ctx: TriggerContext) -> bool:
        return self.schedule.run_count < 1 and self.schedule.at_ms is not None and ctx.now_ms >= self.schedule.at_ms


class DelayedTrigger(Trigger):
    type = S.TYPE_DELAYED

    def _fire_at(self) -> int | None:
        # absolute `at_ms` wins; else created_at + delay_s
        if self.schedule.at_ms is not None:
            return self.schedule.at_ms
        if self.schedule.delay_s > 0:
            return T.add_s(self.schedule.created_at, self.schedule.delay_s)
        return None

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        if self.schedule.run_count >= 1:
            return None
        return self._fire_at()

    def should_trigger(self, ctx: TriggerContext) -> bool:
        fire = self._fire_at()
        return self.schedule.run_count < 1 and fire is not None and ctx.now_ms >= fire


class IntervalTrigger(Trigger):
    type = S.TYPE_INTERVAL

    def is_recurring(self) -> bool:
        return True

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        if self.schedule.interval_s <= 0:
            return None
        if self.schedule.next_run_at is not None:
            return self.schedule.next_run_at
        # first fire is immediate (spec §64: the scheduler creates a job at
        # creation time); thereafter every `interval_s` from the last fire.
        if self.schedule.last_run_at is None:
            return self.schedule.created_at
        return T.add_s(self.schedule.last_run_at, self.schedule.interval_s)


class CronTrigger(Trigger):
    type = S.TYPE_CRON

    def __init__(self, schedule: S.Schedule):
        super().__init__(schedule)
        self._expr = cronlib.CronExpression(schedule.cron) if schedule.cron else None

    def is_recurring(self) -> bool:
        return True

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        if self._expr is None:
            return None
        if self.schedule.next_run_at is not None:
            return self.schedule.next_run_at
        anchor = self.schedule.last_run_at if self.schedule.last_run_at is not None else self.schedule.created_at
        return self._expr.next_after(anchor, self.schedule.timezone or ctx.tz)


class EventTrigger(Trigger):
    type = S.TYPE_EVENT

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        # no time-based next; it fires only when its event appears
        return None

    def should_trigger(self, ctx: TriggerContext) -> bool:
        return bool(self.schedule.event) and self.schedule.event in set(ctx.events)

    def is_recurring(self) -> bool:
        return True


class DependencyTrigger(Trigger):
    type = S.TYPE_DEPENDENCY

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        # has no intrinsic time; becomes eligible when its dependencies settle
        return ctx.now_ms if self._deps_satisfied(ctx) else None

    def _deps_satisfied(self, ctx: TriggerContext) -> bool:
        if not self.schedule.depends_on:
            return True
        for dep in self.schedule.depends_on:
            status = ctx.dependency_states.get(dep)
            if status is None:
                return False  # unknown yet -> not satisfied
            if not _condition_met(self.schedule.dep_condition, status):
                return False
        return True

    def should_trigger(self, ctx: TriggerContext) -> bool:
        return self.schedule.run_count < 1 and self._deps_satisfied(ctx)


class ManualTrigger(Trigger):
    """Only fires when `Scheduler.trigger()` is called explicitly."""

    type = "MANUAL"

    def next_occurrence(self, ctx: TriggerContext) -> int | None:
        return None

    def should_trigger(self, ctx: TriggerContext) -> bool:
        return False  # only a manual `trigger()` enqueues it


def _condition_met(condition: str, status: str) -> bool:
    """Map a dependency condition to a completed job's terminal status."""
    if condition == S.DEP_COMPLETED:
        return status in (S.JOB_COMPLETED, S.JOB_FAILED, S.JOB_CANCELLED, S.JOB_EXPIRED)
    if condition == S.DEP_SUCCESS:
        return status == S.JOB_COMPLETED
    if condition == S.DEP_FAILED:
        return status in (S.JOB_FAILED, S.JOB_DEAD_LETTER, S.JOB_EXPIRED)
    if condition == S.DEP_PARTIAL_SUCCESS:
        # the research-level outcome is carried in the job metadata by the worker;
        # absent that, treat a completed run as satisfying it
        return status in (S.JOB_COMPLETED, S.JOB_FAILED)
    return status in (S.JOB_COMPLETED,)


TRIGGER_REGISTRY: Registry[type[Trigger]] = Registry("trigger")

# schedule type → trigger class. A deployment registers a custom trigger with
# `register_trigger(type_, cls)` and the Scheduler picks it up with no other change.
_TRIGGERS: dict[str, type[Trigger]] = {
    S.TYPE_IMMEDIATE: ImmediateTrigger,
    S.TYPE_ONCE: OnceTrigger,
    S.TYPE_DELAYED: DelayedTrigger,
    S.TYPE_INTERVAL: IntervalTrigger,
    S.TYPE_RECURRING: IntervalTrigger,  # umbrella defaults to interval semantics
    S.TYPE_CRON: CronTrigger,
    S.TYPE_EVENT: EventTrigger,
    S.TYPE_DEPENDENCY: DependencyTrigger,
    ManualTrigger.type: ManualTrigger,
}


def trigger_for(schedule: S.Schedule) -> Trigger:
    """Build the trigger for a schedule, from the registry."""
    cls = _TRIGGERS.get(schedule.type, ImmediateTrigger)
    return cls(schedule)


def register_trigger(type_: str, cls: type[Trigger]) -> None:
    """Register a custom trigger class (spec §53)."""
    _TRIGGERS[type_] = cls
    TRIGGER_REGISTRY.register(type_, cls)


def registered_types() -> list[str]:
    return sorted(_TRIGGERS.keys())


for _t, _cls in _TRIGGERS.items():
    TRIGGER_REGISTRY.register(_t, _cls)

