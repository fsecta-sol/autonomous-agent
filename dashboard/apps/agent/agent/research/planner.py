"""ResearchPlanner — turns a selected candidate + strategy into a ResearchPlan.

The planner is thin on purpose: the *strategy* knows how it investigates, so the
strategy's `plan()` produces the steps. The planner's job is to (a) pick the
strategy for the candidate when the loop hasn't, (b) ask it for a plan, and (c)
persist that plan. Selection here stays a strategy concern (the registry matches
capabilities); the planner just orchestrates the hand-off.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from . import models as M
from .strategies.base import ResearchStrategy
from .strategies.selector import StrategySelector

log = logging.getLogger("agent.research.planner")


class ResearchPlanner(ABC):
    @abstractmethod
    async def plan(
        self, candidate: M.ResearchCandidate, ctx: ResearchContext, run: M.ResearchRun
    ) -> tuple[M.ResearchPlan, ResearchStrategy]:
        ...


class DefaultResearchPlanner(ResearchPlanner):
    """Selects a strategy for the candidate, asks it to plan, and returns both."""

    def __init__(self, selector: StrategySelector):
        self.selector = selector

    async def plan(
        self, candidate: M.ResearchCandidate, ctx: ResearchContext, run: M.ResearchRun
    ) -> tuple[M.ResearchPlan, ResearchStrategy]:
        strategy = await self.selector.select(candidate, ctx)
        plan = await strategy.plan(candidate, ctx)
        if plan is None:
            plan = M.ResearchPlan(
                id=M.new_id("plan_"),
                candidate_id=candidate.id,
                question=candidate.question,
                strategy=strategy.name,
                steps=["Investigate the question and record what is observed."],
            )
        return plan, strategy


if False:  # pragma: no cover
    from .context import ResearchContext
