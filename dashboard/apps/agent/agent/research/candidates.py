"""CandidateGenerator + CandidateEvaluator — gaps → researchable questions.

The generator is deliberately *grounded*: it maps gaps (which came from the
knowledge state) to candidates, and refuses to invent questions the graph gives
no reason to ask. A pluggable `llm_generator` may enrich the pool, but the
deterministic gap-mapping is the floor, so the loop still works with no model.

The evaluator annotates each candidate with expected information gain, cost and
risk — cheap, heuristic estimates the prioritizer later combines.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from . import models as M

log = logging.getLogger("agent.research.candidates")

# How much a gap of each kind is expected to teach us, before prioritisation.
_GAIN_BY_KIND = {
    "conflict": "high",
    "unknown": "high",
    "objective_coverage": "high",
    "unexplored_relationship": "medium",
    "missing_evidence": "medium",
    "low_confidence": "medium",
    "stale": "low",
}
# Cost hint by the strategy most likely to resolve the gap kind.
_COST_BY_KIND = {
    "conflict": "medium",
    "unknown": "high",
    "objective_coverage": "medium",
    "unexplored_relationship": "low",
    "missing_evidence": "medium",
    "low_confidence": "medium",
    "stale": "low",
}
_RISK_BY_KIND = {
    "conflict": "medium",
    "objective_coverage": "low",
    "unknown": "low",
    "missing_evidence": "low",
    "unexplored_relationship": "low",
    "low_confidence": "low",
    "stale": "low",
}


def question_key(question: str) -> str:
    """A normalised key for the anti-redundancy ledger."""
    return " ".join("".join(c.lower() if c.isalnum() else " " for c in question).split())


def dedup_against_known(new: list[M.ResearchCandidate], known_keys: set[str]) -> list[M.ResearchCandidate]:
    """Drop candidates whose normalised question is already recorded for this run.

    The generator re-derives the same questions from the run's own growing set of
    unknowns every iteration; without this the candidate table grows without bound
    (one run reached ~700 rows per distinct question) and the prioritizer drowns.
    `known_keys` is `store.candidate_question_keys(run_id)`. Duplicates *within*
    `new` are also collapsed."""
    seen: set[str] = set()
    out: list[M.ResearchCandidate] = []
    for c in new:
        k = question_key(c.question)
        if not k or k in known_keys or k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


class CandidateGenerator(ABC):
    """Turns gaps into candidate questions. Replaceable (spec §9)."""

    @abstractmethod
    async def generate(self, gaps: list[dict], ctx: ResearchContext, run: M.ResearchRun) -> list[M.ResearchCandidate]:
        ...


class GapBasedCandidateGenerator(CandidateGenerator):
    """One candidate per gap, grounded in the gap's subject and suggestion.

    `llm_generator`, if supplied, is an async fn `(gaps, ctx) -> list[dict]` that
    may add candidates; its output is merged (and de-duped) with the deterministic
    pool. It is optional so the loop runs headless.
    """

    def __init__(
        self,
        *,
        llm_generator: Callable[[list[dict], ResearchContext], Awaitable[list[dict]]] | None = None,
        max_candidates: int = 12,
    ):
        self.llm_generator = llm_generator
        self.max_candidates = max_candidates

    async def generate(self, gaps: list[dict], ctx: ResearchContext, run: M.ResearchRun) -> list[M.ResearchCandidate]:
        cands: list[M.ResearchCandidate] = []
        for g in gaps:
            kind = g.get("kind", "")
            related = list(g.get("related_knowledge", []) or [])
            cand = M.ResearchCandidate(
                id=M.new_id("cand_"),
                question=g.get("suggested_question") or g.get("statement", ""),
                reason=g.get("statement", ""),
                objective=f"Resolve {kind} gap on {g.get('subject', '')}".strip(),
                expected_information_gain=_GAIN_BY_KIND.get(kind, "medium"),
                estimated_cost=_COST_BY_KIND.get(kind, "medium"),
                risk=_RISK_BY_KIND.get(kind, "low"),
                related_knowledge=related,
                related_unknowns=[g["subject"]] if kind == "unknown" and g.get("subject") else [],
                related_conflicts=[g["subject"]] if kind == "conflict" and g.get("subject") else [],
                source_gap_kind=kind,
                branch=ctx.branch,
            )
            if cand.question:
                cands.append(cand)

        if self.llm_generator is not None:
            try:
                extra = await self.llm_generator(gaps, ctx)
                for e in extra or []:
                    cands.append(
                        M.ResearchCandidate(
                            id=M.new_id("cand_"),
                            question=str(e.get("question", "")),
                            reason=str(e.get("reason", "")),
                            objective=str(e.get("objective", "")),
                            expected_information_gain=str(e.get("expected_information_gain", "medium")),
                            estimated_cost=str(e.get("estimated_cost", "medium")),
                            related_knowledge=list(e.get("related_knowledge", []) or []),
                            source_gap_kind="llm",
                            branch=ctx.branch,
                        )
                    )
            except Exception:
                log.exception("llm candidate generator failed")

        # de-dupe by normalised question, keep the first (deterministic wins)
        seen: set[str] = set()
        out: list[M.ResearchCandidate] = []
        for c in cands:
            k = question_key(c.question)
            if not k or k in seen:
                continue
            seen.add(k)
            out.append(c)
        return out[: self.max_candidates]


class CandidateEvaluator(ABC):
    """Annotates candidates with expected gain / cost / risk (spec §9)."""

    @abstractmethod
    async def evaluate(self, candidates: list[M.ResearchCandidate], ctx: ResearchContext) -> list[M.ResearchCandidate]:
        ...


class HeuristicCandidateEvaluator(CandidateEvaluator):
    """Boosts expected gain when a candidate targets a conflict/unknown or an
    objective-covered topic, and lowers it for stale-only gaps."""

    async def evaluate(self, candidates: list[M.ResearchCandidate], ctx: ResearchContext) -> list[M.ResearchCandidate]:
        obj_terms = set(ctx.objective.statement.lower().split())
        for c in candidates:
            q_terms = set(c.question.lower().split())
            overlap = len(obj_terms & q_terms)
            if overlap:
                c.priority_hint = "high"
            if c.related_conflicts:
                c.expected_information_gain = "high"
                c.priority_hint = "high"
            if c.source_gap_kind == "stale" and not c.related_conflicts:
                c.expected_information_gain = "low"
                c.priority_hint = "low"
            # record the signals the prioritizer will sum
            c.rank_inputs = {
                "objective_overlap": float(overlap),
                "gap_kind": c.source_gap_kind,
            }
        return candidates


if False:  # pragma: no cover
    from .context import ResearchContext
