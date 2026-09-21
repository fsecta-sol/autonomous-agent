"""DocumentationStrategy — resolve a gap from official docs/specs.

Best for unknowns, objective coverage and missing evidence: the questions whose
answer is a documented fact, not an experiment.
"""

from __future__ import annotations

from .. import models as M
from ..executor import ResearchExecutor
from .base import ResearchStrategy


class DocumentationStrategy(ResearchStrategy):
    name = "documentation"
    description = "Resolve the question from official documentation, specs and EIPs."
    capabilities = ("unknown", "objective_coverage", "missing_evidence", "unexplored_relationship")
    reliability = 0.8
    cost = 0.3

    def __init__(self, executor: ResearchExecutor):
        self.executor = executor

    async def plan(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> M.ResearchPlan:
        subject = candidate.related_knowledge[0] if candidate.related_knowledge else candidate.question
        return M.ResearchPlan(
            id=M.new_id("plan_"),
            candidate_id=candidate.id,
            question=candidate.question,
            strategy=self.name,
            steps=[
                f"Find the canonical documentation or spec that covers {subject}.",
                "Extract the specific statements that answer the question.",
                "Note any claims the docs leave unstated (those become new unknowns).",
            ],
            expected_evidence=["documentation excerpt", "spec section", "source URL"],
            success_conditions=["a documented statement that directly answers the question"],
            failure_conditions=["no authoritative source found"],
        )

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        return await self.executor.execute(plan, ctx, run)


if False:  # pragma: no cover
    from ..context import ResearchContext
