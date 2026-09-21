"""ResultAnalyzer — the structured read of one result (spec §15).

Evidence-first: the analyzer keeps observation, interpretation and conclusion
separate, and never promotes a conclusion to a fact. It computes the Evaluation
fields the rest of the loop decides on — did we answer the question, gain
evidence, create a contradiction, reject a hypothesis, or fail — and an
information-gain scalar in [0, 1].

Deterministic by default; a `ModelAnalyzer` could replace it, but the loop does
not depend on one.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

from . import models as M
from .registry import Registry

log = logging.getLogger("agent.research.analyzer")

ANALYZER_REGISTRY: Registry[ResultAnalyzer] = Registry("analyzer")

# evidence kinds and how much each is worth toward information gain
_EVIDENCE_WEIGHT = {
    "experiment": 1.0,
    "measurement": 0.9,
    "observation": 0.7,
    "source": 0.6,
    "artifact": 0.5,
}


class ResultAnalyzer(ABC):
    @abstractmethod
    def analyze(self, result: M.ResearchResult, ctx: ResearchContext) -> M.Evaluation:
        ...


class EvidenceFirstAnalyzer(ResultAnalyzer):
    """Scores a result by the *evidence* it carries, not the confidence of its
    prose. A conclusion with no evidence behind it does not count as knowledge."""

    def analyze(self, result: M.ResearchResult, ctx: ResearchContext) -> M.Evaluation:
        ev = result.evidence or []
        obs = result.observations or []

        # evidence strength: sum of kind weights, saturating at 1.0 by ~3 items
        strength = sum(_EVIDENCE_WEIGHT.get(e.get("kind", "source"), 0.5) for e in ev if isinstance(e, dict))
        if not ev and obs:
            strength = 0.4 * min(1.0, len(obs) / 2.0)
        evidence_strength = min(1.0, strength / 3.0)

        new_evidence = bool(ev or obs)
        answered = bool(ev or obs) and bool(result.conclusions)
        uncertainties = result.uncertainties or []

        failed = result.failure_kind not in ("", None)
        # an empty result (no evidence, no observations) is an insufficient-evidence failure
        if not new_evidence and not failed:
            failed = True
            result.failure_kind = M.FAIL_INSUFFICIENT_EVIDENCE
            if not result.failure_reason:
                result.failure_reason = "no observations or evidence were produced"

        # contradictions: evidence that explicitly conflicts, or a rejected hypothesis
        contradiction = result.hypothesis_survived is False

        # information gain: evidence strength nudged by conclusions and penalised
        # by unresolved uncertainties and failure.
        info_gain = evidence_strength
        if result.conclusions:
            info_gain = min(1.0, info_gain + 0.15)
        info_gain -= min(0.3, 0.05 * len(uncertainties))
        if failed:
            info_gain *= 0.2
        info_gain = max(0.0, min(1.0, info_gain))

        # a rejected hypothesis is real information (we eliminated a possibility)
        hypothesis_survived = result.hypothesis_survived

        notes: list[str] = []
        if failed:
            notes.append(f"failure: {result.failure_kind}")
        if contradiction:
            notes.append("hypothesis rejected — a candidate explanation was eliminated")
        if uncertainties:
            notes.append(f"{len(uncertainties)} open uncertaint(ies) surfaced")

        return M.Evaluation(
            answered_question=answered,
            new_evidence=new_evidence,
            knowledge_increased=info_gain > ctx_floor(ctx),
            uncertainty_reduced=bool(result.conclusions) and not uncertainties,
            new_unknowns=len(uncertainties),
            contradiction_created=contradiction,
            hypothesis_survived=hypothesis_survived,
            failed=failed,
            failure_kind=result.failure_kind,
            info_gain=round(info_gain, 4),
            should_retry=(failed and result.failure_kind in (M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT)),
            # a genuinely new direction worth a branch: the result surfaced
            # uncertainties and still cleared the useful-info floor.
            should_branch=bool(uncertainties) and info_gain >= 0.25,
            notes=notes,
        )


def ctx_floor(ctx: ResearchContext) -> float:
    """The loop's "this counted" threshold. Read from config via the context's
    extra bag when present, else a sane default."""
    return float(ctx.extra.get("min_useful_info_gain", 0.15))


ANALYZER_REGISTRY.register("evidence-first", EvidenceFirstAnalyzer())
DEFAULT_ANALYZER = "evidence-first"


if False:  # pragma: no cover
    from .context import ResearchContext
