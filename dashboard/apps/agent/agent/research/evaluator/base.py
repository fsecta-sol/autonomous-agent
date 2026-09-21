"""Base types for the evaluator: the input bundle, the dimension interface, and
the dimension registry (spec §2, §3).

A `DimensionEvaluator` receives one `EvaluationInput` and returns one
`DimensionScore`. Dimensions are independent and independently testable; the
pipeline runs them, aggregates the scores, and derives signals + a recommendation.

`EvaluationInput.scratch` is a shared dict so a dimension can cache expensive work
once (e.g. the evidence assessments) for later dimensions to reuse — the pipeline
seeds evidence/source assessments there before the dimension pass.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from .. import models as M
from ..context import ResearchContext
from ..registry import Registry
from . import model as EM


@dataclass
class EvaluationInput:
    """Everything a dimension evaluator may inspect for one iteration."""

    run: M.ResearchRun
    objective: M.Objective
    ctx: ResearchContext
    iteration_id: str = ""
    candidate: M.ResearchCandidate | None = None
    plan: M.ResearchPlan | None = None
    result: M.ResearchResult | None = None
    knowledge_updates: list[dict] = field(default_factory=list)
    prior_evaluations: list[EM.ResearchEvaluation] = field(default_factory=list)
    attempts: list[dict] = field(default_factory=list)
    debug: bool = False
    # the loop's retry cap, so the evaluator's retry signal agrees with the loop
    max_attempts: int = 4
    # cross-dimension scratch (evidence/source assessments, rendered text, …)
    scratch: dict = field(default_factory=dict)

    # ── convenience accessors ──
    @property
    def question(self) -> str:
        if self.result and self.result.question:
            return self.result.question
        if self.plan:
            return self.plan.question
        if self.candidate:
            return self.candidate.question
        return ""

    @property
    def strategy(self) -> str:
        return (self.plan.strategy if self.plan else "") or (self.result.strategy if self.result else "")

    def all_text(self) -> str:
        """Every textual field of the result, concatenated — for relevance/overlap."""
        r = self.result
        if r is None:
            return ""
        parts = [r.question, *r.conclusions, *r.uncertainties, *[s for s in r.sources]]
        for o in r.observations:
            parts.append(o.get("statement", "") if isinstance(o, dict) else str(o))
        for e in r.evidence:
            if isinstance(e, dict):
                parts.append(e.get("statement", ""))
        return " ".join(p for p in parts if p)

    def observation_texts(self) -> list[str]:
        r = self.result
        if r is None:
            return []
        return [(o.get("statement", "") if isinstance(o, dict) else str(o)) for o in r.observations]

    def evidence_items(self) -> list[dict]:
        r = self.result
        if r is None:
            return []
        return [e for e in r.evidence if isinstance(e, dict)]


class DimensionEvaluator(ABC):
    """One scored dimension of a research iteration."""

    #: stable identifier, used in `scored_by` and the registry
    name: str = "dimension"
    #: relative weight in the aggregate
    weight: float = 1.0

    @abstractmethod
    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        ...


DIMENSION_REGISTRY: Registry[DimensionEvaluator] = Registry("dimension")


def score(name: str, value: float, *, weight: float = 1.0, rationale: str = "") -> EM.DimensionScore:
    """Build a DimensionScore (clamped to [0, 1])."""
    v = 0.0 if value < 0 else 1.0 if value > 1 else value
    return EM.DimensionScore(name=name, score=round(v, 4), weight=weight, rationale=rationale)
