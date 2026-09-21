"""Recommendation engine (spec §2, §4).

Maps the scored dimensions and named signals into a single recommendation the
NextActionSelector consumes (a `models.ACTION_*` value, an optional strategy
suggestion, and a confidence). Pluggable: the loop asks the registry for an
engine; the deterministic default needs no model.

The default is a small decision table, not a formula — each rule names the signal
that fired and why, so the recommendation is auditable ("why did it recommend
X?").
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from .. import models as M
from ..registry import Registry
from . import model as EM
from .base import EvaluationInput

RECOMMENDATION_REGISTRY: Registry[RecommendationEngine] = Registry("recommendation")


class RecommendationEngine(ABC):
    @abstractmethod
    def recommend(
        self,
        *,
        inp: EvaluationInput,
        dimensions: dict[str, float],
        signals: list[EM.EvaluationSignal],
        status: str,
        contradictions: list[EM.Contradiction],
        redundant_with: list[str],
    ) -> EM.Recommendation:
        ...


class SignalDrivenRecommender(RecommendationEngine):
    """A priority-ordered decision table over the evaluation's signals.

    Ordered from most-urgent to least: a hard stop, a contradiction to resolve, a
    retry, a branch, then continue. The first rule whose signal is present and
    funded (weight > 0) wins, so the outcome is deterministic and explainable.
    """

    def recommend(
        self,
        *,
        inp: EvaluationInput,
        dimensions: dict[str, float],
        signals: list[EM.EvaluationSignal],
        status: str,
        contradictions: list[EM.Contradiction],
        redundant_with: list[str],
    ) -> EM.Recommendation:
        by_name = {s.name: s for s in signals if s.weight > 0}
        fired = lambda n: by_name.get(n)

        def conf(base: float) -> float:
            return round(min(0.95, max(0.1, base)), 3)

        # 1. objective satisfied or no progress left → stop
        if fired(EM.SIG_STOP_SATISFIED):
            s = by_name[EM.SIG_STOP_SATISFIED]
            return EM.Recommendation(M.ACTION_STOP, s.reason or "objective satisfied",
                                     confidence=conf(0.85), signals=[s.name])
        if fired(EM.SIG_STOP_NO_PROGRESS):
            s = by_name[EM.SIG_STOP_NO_PROGRESS]
            return EM.Recommendation(M.ACTION_STOP, s.reason or "no meaningful progress",
                                     confidence=conf(0.7), signals=[s.name])

        # 2. an unresolved contradiction → resolve it before moving on
        if contradictions and fired(EM.SIG_RESOLVE_CONFLICT):
            return EM.Recommendation(
                M.ACTION_CONTINUE, "resolve the contradiction surfaced this iteration",
                suggested_strategy="source-comparison",
                suggested_focus=contradictions[0].subject,
                confidence=conf(0.75), signals=[EM.SIG_RESOLVE_CONFLICT],
            )

        # 3. a transient failure that we may retry
        if fired(EM.SIG_RETRY_TRANSIENT):
            s = by_name[EM.SIG_RETRY_TRANSIENT]
            return EM.Recommendation(M.ACTION_RETRY, s.reason or "transient failure",
                                     confidence=conf(0.6), signals=[s.name])
        if fired(EM.SIG_RETRY_STRATEGY_CHANGE):
            s = by_name[EM.SIG_RETRY_STRATEGY_CHANGE]
            return EM.Recommendation(M.ACTION_RETRY, s.reason or "retry with a different strategy",
                                     suggested_strategy="source-comparison", confidence=conf(0.55), signals=[s.name])

        # 4. a discovery opened a new direction → branch (when the signal allows)
        if fired(EM.SIG_BRANCH):
            s = by_name[EM.SIG_BRANCH]
            return EM.Recommendation(M.ACTION_BRANCH, s.reason or "new direction discovered",
                                     suggested_focus=s.reason, confidence=conf(0.6), signals=[s.name])

        # 5. weak evidence → seek corroboration (still CONTINUE, but with a nudge)
        if fired(EM.SIG_VERIFY):
            s = by_name[EM.SIG_VERIFY]
            return EM.Recommendation(M.ACTION_CONTINUE, s.reason or "seek corroborating evidence",
                                     suggested_strategy="source-comparison",
                                     confidence=conf(0.5), signals=[s.name])

        # 6. a low-value iteration that is not a hard stop → broaden the question
        if fired(EM.SIG_LOW_VALUE) and fired(EM.SIG_BROADEN):
            return EM.Recommendation(M.ACTION_CONTINUE, "low-value iteration — broaden the question",
                                     suggested_focus="broaden: " + (inp.question[:60] or "objective"),
                                     confidence=conf(0.45), signals=[EM.SIG_LOW_VALUE, EM.SIG_BROADEN])

        # 7. default: keep going
        return EM.Recommendation(M.ACTION_CONTINUE, "iteration made usable progress",
                                 confidence=conf(dimensions.get("confidence", 0.4)),
                                 signals=[s.name for s in signals if s.weight > 0] or [EM.SIG_CONTINUE])


RECOMMENDATION_REGISTRY.register("signal-driven", SignalDrivenRecommender())
DEFAULT_RECOMMENDER = "signal-driven"
