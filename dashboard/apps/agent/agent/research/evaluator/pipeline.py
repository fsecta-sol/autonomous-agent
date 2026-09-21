"""The evaluation pipeline — `ResearchEvaluator` (spec §3).

Runs the modular passes in order and aggregates them into one
`ResearchEvaluation`:

    evidence pass   → per-item level + strength (+ source grades)
    dimension pass  → 14 scored dimensions
    contradiction / redundancy passes
    (optional) LLM judge adjustments
    status derivation
    signal derivation
    recommendation
    reasoning

The evaluator is pure: it reads only its `EvaluationInput` (the loop supplies the
result, the run, and the loaded history) and returns the evaluation. It never
touches the store or a tool, so it is deterministic and unit-testable in
isolation — the loop persists what it returns.
"""

from __future__ import annotations

import logging

from .. import models as M
from ..registry import Registry
from . import dimensions as _dimensions  # noqa: F401 — populates DIMENSION_REGISTRY
from . import evidence as E
from . import model as EM
from . import passes as P
from .base import DIMENSION_REGISTRY, DimensionEvaluator, EvaluationInput
from .llm import LlmJudge, NoopJudge, apply_adjustments
from .recommend import DEFAULT_RECOMMENDER, RECOMMENDATION_REGISTRY, RecommendationEngine

log = logging.getLogger("agent.research.evaluator.pipeline")

# The floor below which an iteration is "no progress" — shared with the loop's
# diminishing-returns notion so the two agree.
DEFAULT_FLOOR = 0.15

EVALUATOR_REGISTRY: Registry[ResearchEvaluator] = Registry("evaluator")


class ResearchEvaluator:
    """Composes the passes. Construct once per run; call `evaluate` per iteration."""

    def __init__(
        self,
        *,
        dimensions: list[DimensionEvaluator] | None = None,
        recommender: RecommendationEngine | None = None,
        judge: LlmJudge | None = None,
        floor: float = DEFAULT_FLOOR,
        name: str = "default",
    ):
        self.dimensions = dimensions if dimensions is not None else list(DIMENSION_REGISTRY.all())
        self.recommender = recommender or RECOMMENDATION_REGISTRY.get(DEFAULT_RECOMMENDER)
        self.judge = judge or NoopJudge()
        self.floor = floor
        self.name = name

    # ── the pipeline ────────────────────────────────────────────────────────
    async def evaluate(self, inp: EvaluationInput, *, persist_run_meta: bool = False) -> EM.ResearchEvaluation:
        # 1. evidence pass — classify + grade every claim
        assessments = E.assess(inp.result)
        inp.scratch["assessments"] = assessments
        _src_score, _src_why, src_grades = E.source_quality(inp.result.sources if inp.result else [])
        inp.scratch["source_grades"] = src_grades

        # 2. comparison passes
        contradictions = P.detect_contradictions(inp)
        inp.scratch["contradictions"] = contradictions
        redundant = P.detect_redundancy(inp)
        inp.scratch["redundant_with"] = redundant

        # 3. dimension pass
        dim_results: list[EM.DimensionScore] = []
        for d in self.dimensions:
            try:
                dim_results.append(d.evaluate(inp))
            except Exception:
                log.exception("dimension %s failed", d.name)
                dim_results.append(EM.DimensionScore(name=d.name, score=0.0, rationale="dimension errored"))
        dims = {d.name: d.score for d in dim_results}

        # 4. optional LLM judge — clamped adjustments only
        judge_res = await self._safe_judge(inp, dims)
        if judge_res.used:
            adjusted = apply_adjustments(dims, judge_res)
            for d in dim_results:
                if d.name in adjusted and adjusted[d.name] != d.score:
                    d.rationale = f"{d.rationale} · judge-adjusted {d.score:.2f}→{adjusted[d.name]:.2f}"
                    d.score = adjusted[d.name]
            dims = adjusted

        # 5. structured findings
        answered, unanswered = self._question_status(inp, assessments)
        new_ids, updated_ids = self._knowledge_ids(inp.knowledge_updates)
        discoveries = self._discoveries(inp, assessments)
        unknowns = self._unknowns(inp)
        failures = self._failures(inp)

        # 6. status
        status = self._status(inp, dims, assessments, contradictions, redundant)

        # 7. signals
        signals = self._signals(inp, dims, status, assessments, contradictions, redundant, failures)

        # 8. recommendation
        recommendation = self.recommender.recommend(
            inp=inp, dimensions=dims, signals=signals, status=status,
            contradictions=contradictions, redundant_with=redundant,
        )

        # 9. reasoning
        reasoning = EM.EvaluationReasoning(
            summary=self._summary(inp, dims, status, contradictions, redundant),
            steps=[
                (
                    f"graded {len(assessments)} evidence item(s); "
                    f"{sum(1 for a in assessments if EM.STRENGTH_ORDER[a.strength] >= EM.STRENGTH_ORDER[EM.STRENGTH_DIRECT])} direct-or-better"
                ),
                f"scored {len(dim_results)} dimension(s)",
                f"contradictions: {len(contradictions)}; redundant: {len(redundant)}",
                f"status={status} → recommend {recommendation.action}",
            ],
            dimensions=[d.to_dict() for d in dim_results],
            notes=(judge_res.notes if judge_res.used else []) + list(failures and [f.memory_safe() for f in failures[:2]] or []),
        )

        ev = EM.ResearchEvaluation(
            id=EM.make_evaluation_id(),
            research_run_id=inp.run.id,
            iteration_id=inp.iteration_id,
            status=status,
            result_quality=dims.get("result_quality", 0.0),
            evidence_quality=dims.get("evidence_quality", 0.0),
            source_quality=dims.get("source_quality", 0.0),
            relevance=dims.get("relevance", 0.0),
            completeness=dims.get("completeness", 0.0),
            novelty=dims.get("novelty", 0.0),
            knowledge_gain=dims.get("knowledge_gain", 0.0),
            uncertainty_reduction=dims.get("uncertainty_reduction", 0.0),
            objective_progress=dims.get("objective_progress", 0.0),
            confidence=dims.get("confidence", 0.0),
            answered_questions=answered,
            unanswered_questions=unanswered,
            new_knowledge_ids=new_ids,
            updated_knowledge_ids=updated_ids,
            contradictions=[c.to_dict() for c in contradictions],
            discoveries=[d.to_dict() for d in discoveries],
            unresolved_unknowns=[u.to_dict() for u in unknowns],
            redundant_with=redundant,
            failures=[f.to_dict() for f in failures],
            evidence_assessments=[a.to_dict() for a in assessments],
            signals=[s.to_dict() for s in signals],
            recommendation=recommendation.to_dict(),
            reasoning=reasoning.to_dict(),
            strategy=inp.strategy,
            scored_by=[d.name for d in dim_results],
            llm_assisted=judge_res.used,
        )
        return ev

    # ── passes ──────────────────────────────────────────────────────────────
    async def _safe_judge(self, inp: EvaluationInput, dims: dict[str, float]):
        if isinstance(self.judge, NoopJudge):
            return await self.judge.judge(inp, dims)
        try:
            return await self.judge.judge(inp, dims)
        except Exception:
            log.exception("judge failed; continuing deterministically")
            from .llm import JudgeResult

            return JudgeResult(used=False)

    def _question_status(self, inp: EvaluationInput, assessments) -> tuple[list[str], list[str]]:
        q = inp.question
        if not q:
            return [], []
        # answered when there is a conclusion AND it clears the weak grade
        strong = any(
            a.level == EM.LEVEL_CONCLUSION and a.value >= EM.STRENGTH_VALUE[EM.STRENGTH_INDIRECT]
            for a in assessments
        )
        has_evidence = bool(inp.evidence_items() or inp.observation_texts())
        answered = [q] if (has_evidence and strong) else []
        unanswered = [] if answered else [q]
        # uncertainties are unanswered questions too
        r = inp.result
        if r is not None:
            unanswered.extend([u for u in (r.uncertainties or []) if u])
        return answered, unanswered

    @staticmethod
    def _knowledge_ids(updates: list[dict]) -> tuple[list[str], list[str]]:
        new_ids, upd_ids = [], []
        for u in updates or []:
            op, kid = u.get("op"), u.get("id")
            if not kid:
                continue
            if op in ("create", "new"):
                new_ids.append(kid)
            elif op in ("update", "interpretation", "verified", "relation"):
                upd_ids.append(kid)
        return new_ids, upd_ids

    def _discoveries(self, inp: EvaluationInput, assessments) -> list[EM.Discovery]:
        r = inp.result
        if r is None:
            return []
        out: list[EM.Discovery] = []
        for a in assessments:
            if a.level == EM.LEVEL_CONCLUSION and a.value >= EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT]:
                out.append(EM.Discovery(id=M.new_id("disc_"), statement=a.statement, kind="fact",
                                        confidence=a.value, related_knowledge=inp.knowledge_updates and [u.get("id", "") for u in inp.knowledge_updates[:2]] or []))
        for u in (r.uncertainties or [])[:3]:
            out.append(EM.Discovery(id=M.new_id("disc_"), statement=str(u), kind="unknown", confidence=0.4))
        if r.hypothesis_survived is False:
            out.append(EM.Discovery(id=M.new_id("disc_"), statement="a candidate explanation was eliminated",
                                    kind="hypothesis", confidence=0.6))
        return out

    def _unknowns(self, inp: EvaluationInput) -> list[EM.Unknown]:
        r = inp.result
        out: list[EM.Unknown] = []
        if r is not None:
            for u in r.uncertainties or []:
                out.append(EM.Unknown(id=M.new_id("unk_"), question=str(u), severity="medium", source="uncertainty"))
        for g in inp.ctx.gaps or []:
            if g.get("kind") in ("unknown", "conflict") and g.get("suggested_question"):
                out.append(EM.Unknown(id=g.get("id", M.new_id("unk_")), question=g["suggested_question"],
                                      severity="high" if g.get("kind") == "conflict" else "medium", source="gap"))
        return out[:12]

    def _failures(self, inp: EvaluationInput) -> list[EM.EvaluationFailure]:
        r = inp.result
        if r is None or not r.failure_kind:
            return []
        retryable = r.failure_kind in (M.FAIL_TOOL, M.FAIL_SOURCE_UNAVAILABLE, M.FAIL_TIMEOUT)
        attempts = sum(1 for a in inp.attempts if a.get("strategy") == inp.strategy)
        return [EM.EvaluationFailure(kind=r.failure_kind, reason=r.failure_reason,
                                     strategy=inp.strategy, retryable=retryable, attempts=attempts)]

    def _status(self, inp: EvaluationInput, dims, assessments, contradictions, redundant) -> str:
        r = inp.result
        if r is not None and r.failure_kind == M.FAIL_BLOCKED:
            return EM.STATUS_BLOCKED
        has_evidence = bool(inp.evidence_items() or inp.observation_texts())
        # a failure with nothing to show is a hard failure
        if r is not None and r.failure_kind and not has_evidence:
            return EM.STATUS_FAILED
        if r is not None and r.failure_kind and has_evidence:
            # informative failure (e.g. rejected hypothesis with observations)
            return EM.STATUS_PARTIAL_SUCCESS

        knowledge_moved = bool(inp.knowledge_updates)
        info = self._composite(dims)
        if info < self.floor and not knowledge_moved:
            return EM.STATUS_NO_PROGRESS
        answered, _ = self._question_status(inp, assessments)
        if answered and dims.get("completeness", 0) >= 0.6 and dims.get("evidence_quality", 0) >= 0.5:
            return EM.STATUS_SUCCESS
        return EM.STATUS_PARTIAL_SUCCESS

    def _signals(self, inp, dims, status, assessments, contradictions, redundant, failures) -> list[EM.EvaluationSignal]:
        sig: list[EM.EvaluationSignal] = []

        def add(name, direction, weight, reason=""):
            sig.append(EM.EvaluationSignal(name=name, direction=direction, weight=round(weight, 3), reason=reason))

        info = self._composite(dims)
        ev_q = dims.get("evidence_quality", 0.0)

        if status == EM.STATUS_BLOCKED:
            add(EM.SIG_STOP_NO_PROGRESS, "negative", 1.0, "research is blocked")
        if status == EM.STATUS_NO_PROGRESS:
            add(EM.SIG_LOW_VALUE, "negative", max(0.3, 1.0 - info), "iteration produced no usable progress")
            add(EM.SIG_BROADEN, "positive", 0.6, "broaden the question to escape a low-value streak")
            if redundant:
                add(EM.SIG_STOP_NO_PROGRESS, "negative", 0.8, "no progress and no new questions remain")

        if contradictions and any(not c.resolved for c in contradictions):
            add(EM.SIG_RESOLVE_CONFLICT, "positive", 0.8, "an unresolved contradiction should be settled first")

        if failures:
            f = failures[0]
            if f.retryable and f.attempts < inp.max_attempts:
                add(EM.SIG_RETRY_TRANSIENT, "positive", 0.7, f"{f.kind} is transient")
            elif f.attempts >= 1:
                add(EM.SIG_RETRY_STRATEGY_CHANGE, "positive", 0.6, f"{f.kind} recurred; change approach")

        # a discovery worth branching: new hard fact OR a surviving hypothesis with
        # open uncertainties, while progress is positive
        strong_conclusions = sum(1 for a in assessments if a.level == EM.LEVEL_CONCLUSION and a.value >= EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT])
        if strong_conclusions and (inp.result and inp.result.uncertainties) and info >= 0.4:
            add(EM.SIG_BRANCH, "positive", 0.5, "a confirmed finding opened a new direction")

        # weak-but-present evidence → seek corroboration rather than conclude
        if ev_q and ev_q < 0.45 and status in (EM.STATUS_PARTIAL_SUCCESS, EM.STATUS_SUCCESS):
            add(EM.SIG_VERIFY, "positive", 0.6, "evidence is weak; seek independent corroboration")

        # objective satisfied: high completeness + high objective progress
        if dims.get("completeness", 0) >= 0.75 and dims.get("objective_progress", 0) >= 0.7:
            add(EM.SIG_STOP_SATISFIED, "positive", 0.9, "objective appears satisfied")

        if not sig or all(s.direction == "negative" for s in sig):
            add(EM.SIG_CONTINUE, "neutral", 0.2, "default continuation")

        # positive signals first, then by weight — a stable, explainable order
        sig.sort(key=lambda s: (s.direction != "positive", -s.weight))
        return sig

    def _composite(self, dims: dict[str, float]) -> float:
        """A single 0..1 'did this iteration progress' scalar, weighted. Used for
        status and low-value detection, NOT as the public per-dimension output."""
        weights = {
            "knowledge_gain": 2.0,
            "objective_progress": 2.0,
            "evidence_quality": 1.5,
            "relevance": 1.0,
            "uncertainty_reduction": 1.0,
            "novelty": 1.0,
        }
        num = sum(dims.get(k, 0.0) * w for k, w in weights.items())
        den = sum(weights.values())
        return (num / den) if den else 0.0

    def _summary(self, inp, dims, status, contradictions, redundant) -> str:
        q = inp.question[:70] or "objective"
        bits = [f"status={status}"]
        if contradictions:
            bits.append(f"{len(contradictions)} contradiction(s)")
        if redundant:
            bits.append(f"{len(redundant)} redundant")
        bits.append(f"evidence {dims.get('evidence_quality', 0):.2f}")
        bits.append(f"gain {dims.get('knowledge_gain', 0):.2f}")
        return f"{q} — " + ", ".join(bits)


# The default evaluator instance (stateless, shareable across runs).
DEFAULT_EVALUATOR = "default"
EVALUATOR_REGISTRY.register(DEFAULT_EVALUATOR, ResearchEvaluator())
