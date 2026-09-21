"""Stop conditions — explicit, pluggable reasons a run finishes (spec §20).

The loop never uses `while(true)` with a timeout. It asks every enabled stop
condition to check the current state; the first to fire ends the run with a named
reason. Conditions live in a registry, so a new one is added without touching the
loop, and which ones are active is per-run config.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from . import models as M
from .registry import Registry

log = logging.getLogger("agent.research.stop")


@dataclass
class StopState:
    """Everything a stop condition may inspect. Built fresh each check."""

    run: M.ResearchRun
    config: ResearchConfig
    candidate_count: int = 0
    coverage: float = 0.0
    open_gaps: int = 0
    consecutive_failures: int = 0
    last_evaluation: M.Evaluation | None = None
    now: int = field(default_factory=M.now_ms)


@dataclass
class StopDecision:
    reason: str
    detail: str = ""


class StopCondition(ABC):
    #: the reason string this condition reports when it fires (a STOP_* constant)
    reason: str = ""

    @abstractmethod
    def check(self, state: StopState) -> StopDecision | None:
        """Return a StopDecision to stop, or None to continue."""
        ...


class IterationLimit(StopCondition):
    reason = M.STOP_ITERATION_LIMIT

    def check(self, state: StopState) -> StopDecision | None:
        budget_max = state.run.budget.max_iterations
        cfg_max = state.config.max_iterations
        limit = min([v for v in (budget_max, cfg_max) if v is not None], default=None)
        if limit is not None and state.run.iteration >= limit:
            return StopDecision(self.reason, f"reached iteration {state.run.iteration}/{limit}")
        return None


class TimeLimit(StopCondition):
    reason = M.STOP_TIME_LIMIT

    def check(self, state: StopState) -> StopDecision | None:
        limit = state.run.budget.max_wall_clock_s
        if limit is not None and state.run.elapsed_s() >= limit:
            return StopDecision(self.reason, f"elapsed {state.run.elapsed_s():.0f}s >= {limit:.0f}s")
        return None


class TokenBudget(StopCondition):
    reason = M.STOP_BUDGET

    def check(self, state: StopState) -> StopDecision | None:
        limit = state.run.budget.max_tokens
        used = state.run.metadata.get("tokens_used", 0)
        if limit is not None and used >= limit:
            return StopDecision(self.reason, f"tokens {used}/{limit}")
        return None


class ToolCallBudget(StopCondition):
    reason = M.STOP_BUDGET

    def check(self, state: StopState) -> StopDecision | None:
        limit = state.run.budget.max_tool_calls
        used = state.run.metadata.get("tool_calls_used", 0)
        if limit is not None and used >= limit:
            return StopDecision(self.reason, f"tool_calls {used}/{limit}")
        return None


class NoMeaningfulResearch(StopCondition):
    reason = M.STOP_NO_RESEARCH

    def check(self, state: StopState) -> StopDecision | None:
        # no candidates and no gaps left to close
        if state.candidate_count == 0 and state.open_gaps == 0:
            return StopDecision(self.reason, "no candidates and no open gaps remain")
        return None


class RepeatedFailure(StopCondition):
    reason = M.STOP_REPEATED_FAILURE

    def check(self, state: StopState) -> StopDecision | None:
        limit = state.config.max_attempts_per_question
        if state.consecutive_failures >= limit:
            return StopDecision(self.reason, f"{state.consecutive_failures} consecutive failures (limit {limit})")
        return None


class DiminishingReturns(StopCondition):
    reason = M.STOP_DIMINISHING_RETURNS

    def check(self, state: StopState) -> StopDecision | None:
        streak = state.run.progress.low_value_streak
        if streak >= state.config.diminishing_returns_streak:
            return StopDecision(
                self.reason,
                f"{streak} consecutive low-value iterations (floor {state.config.min_useful_info_gain})",
            )
        return None


class ObjectiveSatisfied(StopCondition):
    reason = M.STOP_OBJECTIVE_SATISFIED

    def check(self, state: StopState) -> StopDecision | None:
        if state.coverage >= 0.8:
            return StopDecision(self.reason, f"objective coverage {state.coverage:.0%}")
        return None


class KnowledgeCoverageReached(StopCondition):
    reason = M.STOP_COVERAGE_REACHED

    def check(self, state: StopState) -> StopDecision | None:
        if state.coverage >= 0.95 and state.open_gaps == 0:
            return StopDecision(self.reason, "coverage ≥95% and no open gaps")
        return None


class UserCancelled(StopCondition):
    reason = M.STOP_USER_CANCELLED

    def check(self, state: StopState) -> StopDecision | None:
        if state.run.status == M.RUN_CANCELLED:
            return StopDecision(self.reason, "cancelled by operator")
        return None


class Blocked(StopCondition):
    reason = M.STOP_BLOCKED

    def check(self, state: StopState) -> StopDecision | None:
        if state.run.status == M.RUN_BLOCKED:
            return StopDecision(self.reason, state.run.metadata.get("blocked_reason", "blocked"))
        return None


STOP_REGISTRY: Registry[StopCondition] = Registry("stop-condition")


def _register_builtins() -> None:
    for name, cond in {
        "iteration-limit": IterationLimit(),
        "time-limit": TimeLimit(),
        "token-budget": TokenBudget(),
        "tool-budget": ToolCallBudget(),
        "no-research": NoMeaningfulResearch(),
        "repeated-failure": RepeatedFailure(),
        "diminishing-returns": DiminishingReturns(),
        "objective-satisfied": ObjectiveSatisfied(),
        "coverage-reached": KnowledgeCoverageReached(),
        "user-cancelled": UserCancelled(),
        "blocked": Blocked(),
    }.items():
        STOP_REGISTRY.register(name, cond)


_register_builtins()

# The conditions active unless a run overrides via config. `objective-satisfied`
# and `coverage-reached` are opt-in (they need a coverage signal), the rest are
# always-on safety/sanity bounds.
DEFAULT_ACTIVE = (
    "iteration-limit",
    "time-limit",
    "token-budget",
    "tool-budget",
    "no-research",
    "repeated-failure",
    "diminishing-returns",
    "user-cancelled",
    "blocked",
)


def evaluate_stops(state: StopState, active: list[str] | None = None) -> StopDecision | None:
    """The first firing condition wins. Deterministic order = the toggle list.

    The always-on conditions run first, then any the run explicitly opted into via
    `config.stopping` (e.g. objective-satisfied), so a run can add conditions
    without replacing the safety bounds.
    """
    order = list(active if active is not None else DEFAULT_ACTIVE)
    for name in state.config.stopping:
        if name not in order:
            order.append(name)
    for name in order:
        cond = STOP_REGISTRY.get(name) if STOP_REGISTRY.has(name) else None
        if cond is None:
            continue
        decision = cond.check(state)
        if decision is not None:
            return decision
    return None


if False:  # pragma: no cover
    from .config import ResearchConfig
