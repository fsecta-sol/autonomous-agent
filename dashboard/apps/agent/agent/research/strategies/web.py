"""WebResearchStrategy — investigate across the open web.

The generalist fallback: anything not pinned to a spec or an experiment (stale
notes, coverage gaps, broad unknowns) can be approached with sourced web research.
"""

from __future__ import annotations

from .. import models as M
from ..executor import ResearchExecutor
from .base import ResearchStrategy


class WebResearchStrategy(ResearchStrategy):
    name = "web"
    description = "Investigate the question across multiple web sources."
    capabilities = ("objective_coverage", "unknown", "unexplored_relationship", "stale", "missing_evidence", "any")
    reliability = 0.6
    cost = 0.5

    def __init__(self, executor: ResearchExecutor):
        self.executor = executor

    async def plan(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> M.ResearchPlan:
        return M.ResearchPlan(
            id=M.new_id("plan_"),
            candidate_id=candidate.id,
            question=candidate.question,
            strategy=self.name,
            steps=[
                "Search for authoritative sources on the question.",
                "Read at least two independent sources.",
                "Record each concrete finding with its URL.",
                "Flag disagreements between sources as uncertainties.",
            ],
            expected_evidence=["source URLs", "quoted findings", "independent corroboration"],
            success_conditions=["at least one sourced, verifiable finding"],
            failure_conditions=["only low-quality or single-source claims found"],
        )

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        return await self.executor.execute(plan, ctx, run)


if False:  # pragma: no cover
    from ..context import ResearchContext
