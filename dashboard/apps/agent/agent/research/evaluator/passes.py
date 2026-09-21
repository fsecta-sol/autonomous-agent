"""Contradiction and redundancy detection (spec §5).

Both are "compare this iteration against what came before", kept out of the
per-dimension scorers because they need the run's history, not just one result.

  * contradiction — the result's conclusions clash with a prior conclusion, or a
    rejected hypothesis reverses an earlier accepted one.
  * redundancy — the result restates a question already answered, or duplicates a
    prior iteration's text, so the loop must not count it as progress.

Deterministic and model-free; similarity via token Jaccard (see `text.py`).
"""

from __future__ import annotations

from .. import models as M
from . import model as EM
from . import text as T
from .base import EvaluationInput


def detect_contradictions(inp: EvaluationInput) -> list[EM.Contradiction]:
    """Find claims in this result that conflict with prior accepted findings.

    Signals used (any is enough):
      * the result explicitly rejected its hypothesis while a prior iteration on
        the same question accepted one;
      * a conclusion negates a prior conclusion on an overlapping subject
        (token overlap ≥ 0.34 plus an explicit negation marker).
    """
    r = inp.result
    if r is None:
        return []
    out: list[EM.Contradiction] = []

    prior_conclusions: list[tuple[str, str]] = []  # (subject-ish, conclusion)
    for ev in inp.prior_evaluations:
        for c in ev.reasoning.get("conclusions", []) or []:
            prior_conclusions.append((ev.strategy, c))

    # explicit hypothesis reversal on the same question
    if r.hypothesis_survived is False:
        for ev in inp.prior_evaluations:
            if T.jaccard(ev.reasoning.get("summary", ""), r.question) >= 0.3 and ev.reasoning.get("hypothesis_survived") is True:
                out.append(
                    EM.Contradiction(
                        id=M.new_id("con_"),
                        subject=r.question[:80],
                        claim="hypothesis rejected this iteration",
                        conflicts_with="an earlier iteration accepted this hypothesis",
                        severity="high",
                        evidence=[e.get("statement", "") for e in r.evidence[:2] if isinstance(e, dict)],
                        rationale="a previously-accepted hypothesis was rejected on the same question",
                    )
                )
                break

    # conclusion-vs-conclusion negation
    negations = {"not", "no", "never", "without", "fails", "failed", "cannot", "can't", "doesn't", "isn't", "won't", "absent"}
    for c in r.conclusions or []:
        c_toks = T.content_tokens(c)
        for _subj, prior in prior_conclusions:
            if not prior:
                continue
            sim = T.jaccard(c, prior)
            if sim < 0.34:
                continue
            c_neg = bool(set(T.words(c)) & negations)
            p_neg = bool(set(T.words(prior)) & negations)
            if c_neg != p_neg:  # one negated, the other not → they disagree
                out.append(
                    EM.Contradiction(
                        id=M.new_id("con_"),
                        subject=(c[:80]),
                        claim=c,
                        conflicts_with=prior[:120],
                        severity="medium",
                        evidence=[c_toks and c or ""][:1],
                        rationale=f"conclusion disagrees with a prior conclusion (sim {sim:.2f}, opposing polarity)",
                    )
                )
                break
    return out


def detect_redundancy(inp: EvaluationInput, *, threshold: float = 0.6) -> list[str]:
    """Return the ids of prior iterations this result duplicates.

    Uses the question key (a restated question is redundant regardless of wording
    drift) plus a text-similarity fallback against prior evaluation summaries.
    """
    r = inp.result
    if r is None:
        return []
    redundant: list[str] = []
    q = inp.question

    # 1. same question already attempted AND produced a non-failed result
    from ..candidates import question_key

    qk = question_key(q)
    for a in inp.attempts:
        if a.get("question_norm") == qk and a.get("outcome") in ("done",) and float(a.get("info_gain", 0)) > 0:
            cid = a.get("candidate_id") or a.get("id") or qk
            if cid not in redundant:
                redundant.append(cid)

    # 2. text overlap with a prior iteration's evaluation summary
    text = inp.all_text()
    for ev in inp.prior_evaluations:
        summary = ev.reasoning.get("summary", "")
        if summary and T.jaccard(text, summary) >= threshold and ev.iteration_id not in redundant:
            redundant.append(ev.iteration_id)

    return redundant
