"""The dimension evaluators (spec §5).

Each class scores ONE dimension of a research iteration and explains itself in a
rationale. They are small, deterministic and independent, so they are unit-testable
in isolation and addable without touching the pipeline: register a new one and the
aggregate picks it up.

Dimensions are seeded from `inp.scratch`:
  * `scratch["assessments"]` — EvidenceAssessment list (evidence pass)
  * `scratch["source_grades"]` — per-source grades (source pass)
  * `scratch["contradictions"]` — Contradiction list (contradiction pass)
  * `scratch["redundant_with"]` — ids this result duplicates (redundancy pass)
"""

from __future__ import annotations

from . import evidence as E
from . import model as EM
from . import text as T
from .base import DIMENSION_REGISTRY, DimensionEvaluator, EvaluationInput, score


class ResultQuality(DimensionEvaluator):
    name = "result_quality"
    weight = 1.5

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        r = inp.result
        if r is None:
            return score(self.name, 0.0, weight=self.weight, rationale="no result")
        assessments: list[EM.EvidenceAssessment] = inp.scratch.get("assessments", [])
        # quality blends evidence strength with internal coherence: a result whose
        # conclusions are all unsupported cannot be high quality, however long.
        ev_quality, _ = E.evidence_quality(assessments)
        levels = E.level_counts(assessments)
        unsupported = levels.get(EM.LEVEL_UNSUPPORTED, 0)
        total_levels = max(1, sum(levels.values()))
        coherence = 1.0 - (unsupported / total_levels)
        # an answered question with no unsupported claims reads as coherent
        base = 0.6 * ev_quality + 0.4 * coherence
        if r.failure_kind:
            base *= 0.3
        why = f"evidence {ev_quality:.2f} · coherence {coherence:.2f} · unsupported {unsupported}/{total_levels}"
        return score(self.name, base, weight=self.weight, rationale=why)


class EvidenceQualityDim(DimensionEvaluator):
    name = "evidence_quality"
    weight = 2.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        assessments: list[EM.EvidenceAssessment] = inp.scratch.get("assessments") or E.assess(inp.result)
        q, why = E.evidence_quality(assessments)
        return score(self.name, q, weight=self.weight, rationale=why)


class SourceQualityDim(DimensionEvaluator):
    name = "source_quality"
    weight = 1.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        grades = inp.scratch.get("source_grades")
        if grades is None:
            _q, _why, grades = E.source_quality(inp.result.sources if inp.result else [])
        if not grades:
            return score(self.name, 0.0, weight=self.weight, rationale="no sources cited")
        vals = [g.get("tier", 0.0) for g in grades]
        return score(self.name, T.mean(vals), weight=self.weight,
                     rationale=f"{len(grades)} source(s), mean tier {T.mean(vals):.2f}")


class Relevance(DimensionEvaluator):
    name = "relevance"
    weight = 1.5

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        # how much of the question/objective vocabulary the result actually covers
        q = inp.question or inp.objective.statement
        text = inp.all_text()
        q_overlap = T.overlap_ratio(q, text)
        o_overlap = T.overlap_ratio(inp.objective.statement, text)
        base = 0.6 * q_overlap + 0.4 * o_overlap
        why = f"question coverage {q_overlap:.2f} · objective coverage {o_overlap:.2f}"
        return score(self.name, base, weight=self.weight, rationale=why)


class Completeness(DimensionEvaluator):
    name = "completeness"
    weight = 1.2

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        r = inp.result
        if r is None:
            return score(self.name, 0.0, weight=self.weight, rationale="no result")
        # a question is "complete" when it has an answer AND few open uncertainties.
        # (The pipeline computes answered/unanswered authoritatively; here we proxy
        # from the result's own shape.)
        has_answer = bool(r.conclusions) or bool(r.evidence)
        n_unc = len(r.uncertainties or [])
        unc_penalty = min(0.6, 0.2 * n_unc)
        plan = inp.plan
        cond_met = 1.0
        if plan and plan.success_conditions:
            met = sum(1 for c in plan.success_conditions if T.overlap_ratio(c, inp.all_text()) >= 0.5)
            cond_met = met / len(plan.success_conditions)
        base = (0.5 if has_answer else 0.0) + 0.3 * cond_met + (0.2 if not n_unc else 0.0) - unc_penalty
        why = f"answer={has_answer} · success-conditions {cond_met:.0%} · {n_unc} uncertainty(ies)"
        return score(self.name, base, weight=self.weight, rationale=why)


class Novelty(DimensionEvaluator):
    name = "novelty"
    weight = 1.3

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        # novelty = 1 - max similarity to prior results' text + redundancy penalty
        text = inp.all_text()
        prior_texts = [p for ev in inp.prior_evaluations for p in [ev.reasoning.get("summary", "")] if p]
        max_sim = max((T.jaccard(text, p) for p in prior_texts), default=0.0)
        redundant = inp.scratch.get("redundant_with", [])
        base = (1.0 - max_sim)
        if redundant:
            base *= 0.4
        why = f"max prior similarity {max_sim:.2f}" + (f" · redundant with {len(redundant)}" if redundant else "")
        return score(self.name, base, weight=self.weight, rationale=why)


class KnowledgeGain(DimensionEvaluator):
    name = "knowledge_gain"
    weight = 2.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        ups = inp.knowledge_updates or []
        created = sum(1 for u in ups if u.get("op") in ("create", "new"))
        enriched = sum(1 for u in ups if u.get("op") in ("update", "interpretation"))
        verified = sum(1 for u in ups if u.get("op") == "verified")
        unknown = sum(1 for u in ups if u.get("op") == "unknown")
        relation = sum(1 for u in ups if u.get("op") == "relation")
        # saturating: 3 meaningful changes is a full-gain iteration
        raw = created * 1.0 + (enriched + verified) * 0.6 + relation * 0.7 + unknown * 0.3
        base = min(1.0, raw / 3.0)
        why = f"create {created} · update {enriched} · verify {verified} · rel {relation} · unknown {unknown}"
        return score(self.name, base, weight=self.weight, rationale=why)


class ObjectiveAlignment(DimensionEvaluator):
    name = "objective_progress"
    weight = 2.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        # objective progress = coverage of the objective statement by the result
        # text, blended with how much of the successful criteria the result touches
        obj = inp.objective.statement
        text = inp.all_text()
        base = T.overlap_ratio(obj, text)
        criteria = inp.objective.success_criteria
        if criteria:
            touched = sum(1 for c in criteria if T.overlap_ratio(c, text) >= 0.4)
            base = 0.5 * base + 0.5 * (touched / len(criteria))
            why = f"objective coverage {T.overlap_ratio(obj, text):.2f} · criteria touched {touched}/{len(criteria)}"
        else:
            why = f"objective coverage {base:.2f}"
        return score(self.name, base, weight=self.weight, rationale=why)


class HypothesisEvaluation(DimensionEvaluator):
    name = "hypothesis"
    weight = 1.2

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        r = inp.result
        if r is None or r.hypothesis_survived is None:
            return score(self.name, 0.4, weight=self.weight, rationale="no explicit hypothesis stated")
        # a survived hypothesis supports the plan; a rejected one is still
        # information (it eliminated a possibility) but scores lower on alignment.
        if r.hypothesis_survived:
            return score(self.name, 0.9, weight=self.weight, rationale="hypothesis survived the evidence")
        return score(self.name, 0.5, weight=self.weight, rationale="hypothesis rejected (a possibility eliminated)")


class UncertaintyReduction(DimensionEvaluator):
    name = "uncertainty_reduction"
    weight = 1.4

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        r = inp.result
        ups = inp.knowledge_updates or []
        resolved = sum(1 for u in ups if u.get("op") == "verified")
        new_unknowns = len(r.uncertainties) if r else 0
        opened = sum(1 for u in ups if u.get("op") == "unknown")
        net = resolved - (new_unknowns + opened)
        # map net into [0,1]: net>0 reduces uncertainty, net<0 increases it
        base = T.clamp01(0.5 + 0.25 * net)
        why = f"resolved {resolved} · opened {new_unknowns + opened} · net {net:+d}"
        return score(self.name, base, weight=self.weight, rationale=why)


class ContradictionDim(DimensionEvaluator):
    name = "contradiction"
    weight = 1.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        contradictions = inp.scratch.get("contradictions", [])
        if not contradictions:
            return score(self.name, 1.0, weight=self.weight, rationale="no contradictions introduced")
        # a contradiction is not automatically bad — it is often valuable signal —
        # but an unresolved one lowers confidence in the iteration's conclusions.
        unresolved = sum(1 for c in contradictions if not c.resolved)
        base = T.clamp01(1.0 - 0.25 * unresolved)
        why = f"{len(contradictions)} contradiction(s), {unresolved} unresolved"
        return score(self.name, base, weight=self.weight, rationale=why)


class RedundancyDim(DimensionEvaluator):
    name = "redundancy"
    weight = 1.1

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        redundant = inp.scratch.get("redundant_with", [])
        if not redundant:
            return score(self.name, 1.0, weight=self.weight, rationale="not redundant with prior iterations")
        base = T.clamp01(1.0 - 0.4 * len(redundant))
        return score(self.name, base, weight=self.weight,
                     rationale=f"duplicates {len(redundant)} prior iteration(s)")


class FailureQuality(DimensionEvaluator):
    name = "failure_quality"
    weight = 1.2

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        from .. import models as M

        r = inp.result
        if r is None or not r.failure_kind:
            return score(self.name, 1.0, weight=self.weight, rationale="no failure")
        # a *good* failure is one that is classified, retryable, or eliminated a
        # hypothesis — the loop learns from it. A silent empty failure is a bad one.
        retryable = r.failure_kind in (M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT)
        informative = r.failure_kind == M.FAIL_HYPOTHESIS_REJECTED or bool(r.uncertainties)
        if informative:
            base = 0.7
            why = f"{r.failure_kind}: informative failure (eliminated a possibility)"
        elif retryable:
            base = 0.5
            why = f"{r.failure_kind}: transient, retryable"
        else:
            base = 0.2
            why = f"{r.failure_kind}: uninformative failure"
        return score(self.name, base, weight=self.weight, rationale=why)


class Confidence(DimensionEvaluator):
    name = "confidence"
    weight = 1.0

    def evaluate(self, inp: EvaluationInput) -> EM.DimensionScore:
        # confidence is the agreement of the strong signals: weight the strongest
        # evidence, penalise unsupported claims and unresolved contradictions.
        assessments: list[EM.EvidenceAssessment] = inp.scratch.get("assessments", [])
        if not assessments:
            return score(self.name, 0.05, weight=self.weight, rationale="no evidence")
        strong = max((a.value for a in assessments), default=0.0)
        unsupported = sum(1 for a in assessments if a.strength in (EM.STRENGTH_UNSUPPORTED, EM.STRENGTH_CONTRADICTED))
        ratio_unsupported = unsupported / len(assessments)
        base = strong * (1.0 - 0.6 * ratio_unsupported)
        why = f"strongest {strong:.2f} · {ratio_unsupported:.0%} unsupported"
        return score(self.name, base, weight=self.weight, rationale=why)


def register_builtin_dimensions() -> None:
    for d in (
        ResultQuality(), EvidenceQualityDim(), SourceQualityDim(), Relevance(), Completeness(),
        Novelty(), KnowledgeGain(), ObjectiveAlignment(), HypothesisEvaluation(),
        UncertaintyReduction(), ContradictionDim(), RedundancyDim(), FailureQuality(), Confidence(),
    ):
        DIMENSION_REGISTRY.register(d.name, d)


register_builtin_dimensions()
