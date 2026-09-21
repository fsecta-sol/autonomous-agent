"""SourceComparisonStrategy — settle conflicts and low confidence by comparing
sources directly.

When the graph holds two claims that disagree, or a claim is unverified, the job
is not "find more" but "compare what we have and say which survives".
"""

from __future__ import annotations

from .. import models as M
from ..executor import ResearchExecutor
from .base import ResearchStrategy


class SourceComparisonStrategy(ResearchStrategy):
    name = "source-comparison"
    description = "Resolve contradictions and low confidence by comparing competing sources."
    capabilities = ("conflict", "low_confidence")
    reliability = 0.7
    cost = 0.6

    def __init__(self, executor: ResearchExecutor):
        self.executor = executor

    async def plan(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> M.ResearchPlan:
        subject = (candidate.related_conflicts or candidate.related_knowledge or [candidate.question])[0]
        return M.ResearchPlan(
            id=M.new_id("plan_"),
            candidate_id=candidate.id,
            question=candidate.question,
            strategy=self.name,
            steps=[
                f"State both competing claims about {subject} explicitly.",
                "Find the primary source behind each claim.",
                "Compare the evidence, not the conclusions.",
                "Conclude which claim the evidence supports, or that it is undecidable.",
            ],
            expected_evidence=["the two competing claims", "their respective sources", "a verdict"],
            success_conditions=["a justified verdict on which claim holds"],
            failure_conditions=["both claims are unsourced or equally supported"],
        )

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        return await self.executor.execute(plan, ctx, run)


if False:  # pragma: no cover
    from ..context import ResearchContext
