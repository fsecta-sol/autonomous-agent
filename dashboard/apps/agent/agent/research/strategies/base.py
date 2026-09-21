"""ResearchStrategy — the pluggable investigation behaviours (spec §10).

A strategy decides (a) whether it can handle a candidate, (b) how it would
investigate it (a plan), and (c) the execution of that plan — which it delegates
to the `ResearchExecutor` so planning stays separate from execution and the loop
never touches a tool directly.

Adding a strategy is: subclass, implement the three methods, register it. The
core loop is untouched. A strategy is a plain object, not a LangGraph node, so it
is unit-testable with a scripted executor.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from .. import models as M

log = logging.getLogger("agent.research.strategies")


class ResearchStrategy(ABC):
    """Common interface every strategy implements."""

    #: stable identifier used in plans, attempts and the strategy registry
    name: str = "strategy"
    #: human description for the API/UI
    description: str = ""
    #: candidate "shapes" this strategy is suited to (gap kinds, or "any")
    capabilities: tuple[str, ...] = ("any",)
    #: relative reliability 0..1 (feeds strategy selection)
    reliability: float = 0.7
    #: relative cost 0..1 (feeds strategy selection)
    cost: float = 0.5

    def can_handle(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> bool:
        if "any" in self.capabilities:
            return True
        return candidate.source_gap_kind in self.capabilities

    @abstractmethod
    async def plan(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> M.ResearchPlan:
        """A concrete plan for this candidate (steps + expected evidence)."""

    @abstractmethod
    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        """Run the plan — typically by delegating to the executor."""


if False:  # pragma: no cover
    from ..context import ResearchContext
