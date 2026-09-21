"""ExperimentStrategy — answer a question by observation rather than reading.

For questions that only direct observation settles (does endpoint X require
auth? what does it return?), the strongest evidence is a real, recorded
observation. Highest reliability, highest cost.
"""

from __future__ import annotations

from .. import models as M
from ..executor import ResearchExecutor
from .base import ResearchStrategy


class ExperimentStrategy(ResearchStrategy):
    name = "experiment"
    description = "Answer the question by direct observation or a controlled probe."
    capabilities = ("conflict", "low_confidence", "unknown")
    reliability = 0.9
    cost = 0.9

    def __init__(self, executor: ResearchExecutor):
        self.executor = executor

    async def plan(self, candidate: M.ResearchCandidate, ctx: ResearchContext) -> M.ResearchPlan:
        return M.ResearchPlan(
            id=M.new_id("plan_"),
            candidate_id=candidate.id,
            question=candidate.question,
            strategy=self.name,
            steps=[
                "State the hypothesis the observation would confirm or refute.",
                "Design the minimal probe that distinguishes the outcomes.",
                "Run it and record the raw observation (request id, output, timestamp).",
                "Compare the observation to the hypothesis and record the verdict.",
            ],
            expected_evidence=["a raw observation", "the probe command/request", "a timestamp"],
            success_conditions=["a reproducible observation that settles the question"],
            failure_conditions=["the probe could not be run or is inconclusive"],
            constraints=["read-only probes; no state mutation"],
        )

    async def execute(self, plan: M.ResearchPlan, ctx: ResearchContext, run: M.ResearchRun) -> M.ResearchResult:
        return await self.executor.execute(plan, ctx, run)


if False:  # pragma: no cover
    from ..context import ResearchContext
