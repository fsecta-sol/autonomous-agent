"""ResearchPrioritizer — pluggable candidate ranking (spec §19).

No single universal formula is hardcoded: the loop asks a prioritizer to rank,
and the default `WeightedPrioritizer` exposes its weight vector as data, so it can
be retuned or swapped without touching the loop. `RankedCandidate` carries the
per-signal breakdown so debug mode can show *why* a candidate won.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from . import models as M
from .registry import Registry

PRIORITIZER_REGISTRY: Registry[ResearchPrioritizer] = Registry("prioritizer")

_GAIN_SCORE = {"high": 1.0, "medium": 0.55, "low": 0.2}
_COST_SCORE = {"low": 1.0, "medium": 0.5, "high": 0.15}
_RISK_SCORE = {"low": 1.0, "medium": 0.5, "high": 0.15}
_SEVERITY_SCORE = {"critical": 1.0, "high": 0.75, "medium": 0.4, "low": 0.1}


@dataclass
class RankedCandidate:
    candidate: M.ResearchCandidate
    score: float
    breakdown: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"candidateId": self.candidate.id, "question": self.candidate.question, "score": round(self.score, 4), "breakdown": {k: round(v, 4) for k, v in self.breakdown.items()}}


@dataclass
class Weights:
    """The default scoring vector. Each term is 0..1; higher = more of that
    signal pushes a candidate up. `cost`/`risk` are subtracted."""

    information_gain: float = 3.0
    objective_relevance: float = 2.0
    uncertainty: float = 1.5
    confidence_gap: float = 1.0
    novelty: float = 1.2
    cost: float = 1.0
    risk: float = 0.8


class ResearchPrioritizer(ABC):
    @abstractmethod
    async def rank(self, candidates: list[M.ResearchCandidate], ctx: ResearchContext) -> list[RankedCandidate]:
        ...


class WeightedPrioritizer(ResearchPrioritizer):
    """Sums weighted, normalised signals into one score. Deterministic and
    inspectable — nothing here needs a model."""

    def __init__(self, weights: Weights | None = None):
        self.w = weights or Weights()

    async def rank(self, candidates: list[M.ResearchCandidate], ctx: ResearchContext) -> list[RankedCandidate]:
        obj_terms = set(ctx.objective.statement.lower().split())
        # subjects already attempted (novelty penalty)
        attempted = {a.get("question_norm", "") for a in ctx.recent_attempts}

        ranked: list[RankedCandidate] = []
        for c in candidates:
            gain = _GAIN_SCORE.get(c.expected_information_gain, 0.5)
            cost = _COST_SCORE.get(c.estimated_cost, 0.5)
            risk = _RISK_SCORE.get(c.risk, 0.5)
            overlap = len(obj_terms & set(c.question.lower().split()))
            obj_rel = min(1.0, overlap / 4.0)
            uncertainty = _SEVERITY_SCORE.get("critical" if c.related_conflicts else c.priority_hint, 0.4)
            confidence_gap = 1.0 if c.related_conflicts else (0.6 if c.related_unknowns else 0.2)
            from .candidates import question_key

            novelty = 0.0 if question_key(c.question) in attempted else 1.0

            breakdown = {
                "information_gain": self.w.information_gain * gain,
                "objective_relevance": self.w.objective_relevance * obj_rel,
                "uncertainty": self.w.uncertainty * uncertainty,
                "confidence_gap": self.w.confidence_gap * confidence_gap,
                "novelty": self.w.novelty * novelty,
                "cost": -self.w.cost * cost,
                "risk": -self.w.risk * risk,
            }
            score = sum(breakdown.values())
            c.priority = score
            c.rank_inputs = {**c.rank_inputs, **breakdown, "total": score}
            ranked.append(RankedCandidate(candidate=c, score=score, breakdown=breakdown))

        ranked.sort(key=lambda r: r.score, reverse=True)
        return ranked


PRIORITIZER_REGISTRY.register("weighted", WeightedPrioritizer())
DEFAULT_PRIORITIZER = "weighted"


if False:  # pragma: no cover
    from .context import ResearchContext
