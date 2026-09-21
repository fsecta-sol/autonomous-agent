"""Configuration for the Research Loop.

Mirrors the project's env-driven config style (`config.py`) with a dataclass that
can also be built from a run's `metadata.research` block, so one run can override
the defaults without an env change. Every field has a safe default; a deployment
that sets nothing still gets a bounded, sensible loop.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field

from .models import Budget


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
class ResearchConfig:
    """The knobs the loop reads. `strategies` is an allow-list of strategy names
    (empty = all registered); `stopping` enables named stop conditions."""

    max_iterations: int = 50
    max_concurrent_tasks: int = 1
    # information-gain gate: an iteration worth less than this counts toward the
    # diminishing-returns streak.
    min_useful_info_gain: float = 0.15
    diminishing_returns_streak: int = 3
    strategies: list[str] = field(default_factory=list)
    strategy_fallback: bool = True
    # after this many identical failures on one question, stop retrying it
    max_attempts_per_question: int = 4
    objective: str = ""
    success_criteria: list[str] = field(default_factory=list)
    budget: Budget = field(default_factory=Budget)
    # named stop conditions to enable, by their registry key (see stop.py).
    # "diminishing-returns" is on by default; add e.g. "objective-satisfied".
    stopping: list[str] = field(default_factory=lambda: ["diminishing-returns"])
    # debug mode records extra decision detail on each event/iteration
    debug: bool = False
    max_branch_depth: int = 3

    def to_dict(self) -> dict:
        d = asdict(self)
        d["budget"] = self.budget.to_dict()
        return d

    @classmethod
    def from_dict(cls, d: dict | None) -> ResearchConfig:
        d = d or {}
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        cfg = cls(**known)
        if isinstance(d.get("budget"), dict):
            cfg.budget = Budget.from_dict(d["budget"])
        return cfg

    @classmethod
    def from_env(cls) -> ResearchConfig:
        return cls(
            max_iterations=_env_int("AGENT_RESEARCH_MAX_ITERATIONS", 50),
            max_concurrent_tasks=_env_int("AGENT_RESEARCH_MAX_CONCURRENT", 1),
            min_useful_info_gain=_env_float("AGENT_RESEARCH_MIN_INFO_GAIN", 0.15),
            diminishing_returns_streak=_env_int("AGENT_RESEARCH_DIMINISHING_STREAK", 3),
            max_attempts_per_question=_env_int("AGENT_RESEARCH_MAX_ATTEMPTS", 4),
            budget=Budget(
                max_iterations=_env_int("AGENT_RESEARCH_MAX_ITERATIONS", 50),
                max_tool_calls=_env_int("AGENT_RESEARCH_MAX_TOOL_CALLS", 0) or None,
                max_tokens=_env_int("AGENT_RESEARCH_MAX_TOKENS", 0) or None,
                max_wall_clock_s=_env_float("AGENT_RESEARCH_MAX_SECONDS", 3600.0) or None,
            ),
            debug=os.environ.get("AGENT_RESEARCH_DEBUG") == "1",
        )
