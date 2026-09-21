"""Evidence taxonomy + strength model (spec §5, §6).

Two orthogonal questions, kept apart:

  * LEVEL   — what *kind of claim* is this?  observation < interpretation <
              inference < conclusion, plus UNSUPPORTED (a claim with nothing
              behind it). This is about the *shape* of the statement.
  * STRENGTH— how *well supported* is it?     corroborated > direct > indirect >
              weak > unsupported > contradicted. This is about the *evidence*.

A conclusion must never be stronger than the evidence under it; the assessor
enforces that and explains every grade in a `rationale`, so the API/UI can answer
"why was this graded weak?".

Everything here is deterministic and model-free. The evidence-first rule from the
ResultAnalyzer is the same principle, applied per item instead of per result.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .. import models as M
from . import model as EM
from . import text as T

# ── linguistic markers ───────────────────────────────────────────────────────
# hedges signal interpretation/inference rather than a raw observation
_HEDGE = {
    "appears", "appear", "likely", "probably", "may", "might", "could", "suggests", "suggest",
    "seems", "seem", "indicates", "indicate", "possibly", "presumably", "apparently", "assume",
    "assumed", "suspect", "suspects", "estimate", "estimated", "roughly", "approximately",
    "maybe", "perhaps", "tends", "tend", "generally", "usually", "often",
}
# inference connectives signal a step beyond the observation
_INFERENCE = {
    "therefore", "thus", "hence", "implies", "consequently", "because", "since", "means",
    "so", "then", "thereby", "resulting",
}
# markers of a first-hand, concrete observation
_CONCRETE = re.compile(r"(\b\d+\b|https?://|\bid\b|\bstatus\b|\breturned\b|\bresponse\b|\bobserved\b|\bmeasured\b|\brecorded\b|\bon 20\d\d|reproduced|\bgithub\b|\.md\b)", re.IGNORECASE)

# ── source quality tiers (deterministic, generic) ────────────────────────────
_HIGH_TLDS = (".gov", ".edu", ".gov.uk", ".ac.uk")
_HIGH_DOMAINS = (
    "ethereum.org", "eips.ethereum.org", "github.com", "w3.org", "rfc-editor.org", "ietf.org",
    "developer.mozilla.org", "docs.python.org", "arxiv.org", "acm.org", "ieee.org", "nature.com",
    "science.org", "who.int", "europa.eu", "nist.gov",
)
_MEDIUM_DOMAINS = ("medium.com", "substack.com", "dev.to", "stackoverflow.com", "reddit.com", "forum.", "blog")
_LOW_DOMAINS = ("twitter.com", "x.com", "facebook.com", "t.me", "tiktok.com", "youtube.com", "youtu.be", "pinterest.")


def _domain(url: str) -> str:
    try:
        host = urlparse(url if "://" in url else f"https://{url}").netloc.lower()
        return host.removeprefix("www.")
    except ValueError:
        return ""


def source_tier(url: str) -> tuple[float, str]:
    """A (0..1, rationale) quality tier for a single source URL."""
    host = _domain(url)
    if not host:
        if url.strip():
            return 0.3, "non-URL reference"
        return 0.0, "empty source"
    tld_match = next((t for t in _HIGH_TLDS if host.endswith(t)), None)
    if tld_match:
        return 1.0, f"authoritative domain ({host})"
    if any(host == d or host.endswith("." + d) for d in _HIGH_DOMAINS):
        return 0.95, f"primary/authoritative source ({host})"
    if any(d in host for d in _LOW_DOMAINS):
        return 0.25, f"low-authority social source ({host})"
    if any(d in host for d in _MEDIUM_DOMAINS):
        return 0.55, f"secondary source ({host})"
    return 0.6, f"independent web source ({host})"


def classify_level(statement: str, *, kind: str = "", is_conclusion: bool = False) -> tuple[str, str]:
    """Classify the *shape* of a claim. Returns (level, rationale)."""
    s = (statement or "").strip()
    if not s:
        return EM.LEVEL_UNSUPPORTED, "empty statement"
    toks = set(T.words(s))
    hedged = bool(toks & _HEDGE)
    inference = bool(toks & _INFERENCE)
    concrete = bool(_CONCRETE.search(s))

    if is_conclusion:
        return EM.LEVEL_CONCLUSION, "stated as a conclusion"
    if kind in ("experiment", "measurement") and not hedged:
        return EM.LEVEL_OBSERVATION, f"first-hand {kind}, no hedge"
    if hedged and inference:
        return EM.LEVEL_INFERENCE, "hedged and connective (a step beyond the data)"
    if hedged:
        return EM.LEVEL_INTERPRETATION, "hedged language (a reading of the data)"
    if concrete or kind in ("observation", "source", "artifact"):
        return EM.LEVEL_OBSERVATION, "concrete, first-hand statement"
    if T.is_substantive(s):
        return EM.LEVEL_INTERPRETATION, "asserted without a concrete marker"
    return EM.LEVEL_UNSUPPORTED, "too little content to be a finding"


def _claim_key(statement: str) -> set[str]:
    return T.content_tokens(statement)


def assess(result: M.ResearchResult | None, *, known_claims: dict[str, str] | None = None) -> list[EM.EvidenceAssessment]:
    """Grade every evidence item and conclusion of a result (spec §6).

    `known_claims` maps a normalised claim key phrase → the node it belongs to,
    letting the assessor mark an item CONTRADICTED when it clashes with a known
    conflict. Absent, no contradiction grading happens here (the pipeline's
    contradiction pass handles that).
    """
    out: list[EM.EvidenceAssessment] = []
    if result is None:
        return out

    # gather candidates: observations, evidence items, conclusions
    items: list[tuple[str, str, str, str]] = []  # (id, statement, kind, source)
    for i, o in enumerate(result.observations or []):
        st = o.get("statement", "") if isinstance(o, dict) else str(o)
        src = o.get("source", "") if isinstance(o, dict) else ""
        items.append((f"obs-{i}", st, "observation", src))
    for i, e in enumerate(result.evidence or []):
        if isinstance(e, dict):
            items.append((f"ev-{i}", e.get("statement", ""), e.get("kind", "source"), e.get("source", "")))
    conclusions = []
    for i, c in enumerate(result.conclusions or []):
        conclusions.append((f"con-{i}", c, "conclusion", ""))

    # corroboration: two items sharing a claim across different sources
    keys = {iid: _claim_key(st) for iid, st, _k, _s in items}
    by_source: dict[str, list[str]] = {}
    for iid, _st, _k, src in items:
        if src:
            by_source.setdefault(_domain(src) or src, []).append(iid)

    def corroborators(iid: str, st: str, src: str) -> list[str]:
        found = []
        for other_id, other_st, _k, other_src in items:
            if other_id == iid:
                continue
            if _domain(other_src) == _domain(src) and src:  # same source = not independent
                continue
            if T.jaccard(keys[iid], keys[other_id]) >= 0.5:
                found.append(other_id)
        return found

    max_ev_value = 0.0
    for iid, st, kind, src in items:
        level, level_why = classify_level(st, kind=kind)
        corr = corroborators(iid, st, src) if level == EM.LEVEL_OBSERVATION else []
        contra = bool(known_claims) and any(k in (known_claims or {}) for k in T.words(st))

        if contra:
            strength, value = EM.STRENGTH_CONTRADICTED, EM.STRENGTH_VALUE[EM.STRENGTH_CONTRADICTED]
            why = "clashes with a recorded claim"
        elif corr:
            strength, value = EM.STRENGTH_CORROBORATED, EM.STRENGTH_VALUE[EM.STRENGTH_CORROBORATED]
            why = f"corroborated by {len(corr)} independent item(s)"
        elif level == EM.LEVEL_OBSERVATION and src:
            strength, value = EM.STRENGTH_DIRECT, EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT]
            why = "first-hand observation with a citation"
        elif level == EM.LEVEL_OBSERVATION and not src:
            strength, value = EM.STRENGTH_INDIRECT, EM.STRENGTH_VALUE[EM.STRENGTH_INDIRECT]
            why = "first-hand but uncited"
        elif level in (EM.LEVEL_INTERPRETATION, EM.LEVEL_INFERENCE) and src:
            strength, value = EM.STRENGTH_INDIRECT, EM.STRENGTH_VALUE[EM.STRENGTH_INDIRECT]
            why = "interpretation grounded in a citation"
        elif level == EM.LEVEL_UNSUPPORTED:
            strength, value = EM.STRENGTH_UNSUPPORTED, EM.STRENGTH_VALUE[EM.STRENGTH_UNSUPPORTED]
            why = "no concrete basis"
        else:
            strength, value = EM.STRENGTH_WEAK, EM.STRENGTH_VALUE[EM.STRENGTH_WEAK]
            why = "asserted without independent support"

        max_ev_value = max(max_ev_value, value)
        out.append(
            EM.EvidenceAssessment(
                evidence_id=iid, statement=st, kind=kind, level=level, strength=strength,
                value=value, source=src, corroborated_by=corr, rationale=f"{level_why}; {why}",
            )
        )

    # conclusions: never stronger than the strongest supporting evidence
    for iid, st, _k, _s in conclusions:
        level, level_why = classify_level(st, is_conclusion=True)
        support = [iid2 for iid2, ost, _k2, _s2 in items if T.jaccard(_claim_key(ost), _claim_key(st)) >= 0.34]
        support_vals = [a.value for a in out if a.evidence_id in support]
        ceiling = max(support_vals) if support_vals else 0.0
        if not support and max_ev_value == 0.0:
            strength, value = EM.STRENGTH_UNSUPPORTED, EM.STRENGTH_VALUE[EM.STRENGTH_UNSUPPORTED]
            why = "conclusion with no evidence behind it"
        elif not support:
            strength, value = EM.STRENGTH_WEAK, min(max_ev_value, EM.STRENGTH_VALUE[EM.STRENGTH_WEAK])
            why = "conclusion not directly tied to a specific evidence item"
        else:
            value = min(ceiling, EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT])
            strength = _value_to_strength(value)
            why = f"bounded by its weakest-linked evidence ({strength.lower()})"
        out.append(
            EM.EvidenceAssessment(
                evidence_id=iid, statement=st, kind="conclusion", level=level, strength=strength,
                value=value, source="", corroborated_by=support, rationale=f"{level_why}; {why}",
            )
        )
    return out


def _value_to_strength(value: float) -> str:
    if value >= EM.STRENGTH_VALUE[EM.STRENGTH_CORROBORATED]:
        return EM.STRENGTH_CORROBORATED
    if value >= EM.STRENGTH_VALUE[EM.STRENGTH_DIRECT]:
        return EM.STRENGTH_DIRECT
    if value >= EM.STRENGTH_VALUE[EM.STRENGTH_INDIRECT]:
        return EM.STRENGTH_INDIRECT
    if value >= EM.STRENGTH_VALUE[EM.STRENGTH_WEAK]:
        return EM.STRENGTH_WEAK
    return EM.STRENGTH_UNSUPPORTED


def evidence_quality(assessments: list[EM.EvidenceAssessment]) -> tuple[float, str]:
    """Aggregate evidence quality in [0, 1] from the item grades.

    Weighted toward the stronger grades but penalised by an unsupported ratio —
    one strong item among five unsupported ones is not great evidence.
    """
    if not assessments:
        return 0.0, "no evidence to assess"
    vals = [a.value for a in assessments]
    base = T.mean(vals)
    unsupported = sum(1 for a in assessments if a.strength in (EM.STRENGTH_UNSUPPORTED, EM.STRENGTH_CONTRADICTED))
    penalty = 0.15 * (unsupported / len(assessments))
    score = T.clamp01(base - penalty)
    strong = sum(1 for a in assessments if EM.STRENGTH_ORDER[a.strength] >= EM.STRENGTH_ORDER[EM.STRENGTH_DIRECT])
    why = f"{strong}/{len(assessments)} items at direct-or-better; {unsupported} unsupported/contradicted"
    return round(score, 4), why


def level_counts(assessments: list[EM.EvidenceAssessment]) -> dict[str, int]:
    counts = {lvl: 0 for lvl in EM.EVIDENCE_LEVELS}
    for a in assessments:
        counts[a.level] = counts.get(a.level, 0) + 1
    return counts


def source_quality(sources: list[str]) -> tuple[float, str, list[dict]]:
    """Score the source set: tier-weighted, with a diversity bonus.

    Returns (score, rationale, per-source grades). Deduplicates by domain so ten
    links to one host count once toward diversity.
    """
    clean = [s for s in (sources or []) if isinstance(s, str) and s.strip()]
    if not clean:
        return 0.0, "no sources cited", []
    graded = []
    domains = set()
    for s in clean:
        tier, why = source_tier(s)
        graded.append({"source": s, "domain": _domain(s), "tier": round(tier, 3), "rationale": why})
        domains.add(_domain(s))
    base = T.mean([g["tier"] for g in graded])
    diversity = min(1.0, len(domains) / max(1, len(clean)))  # 1.0 when all distinct
    score = T.clamp01(base * (0.8 + 0.2 * diversity))
    why = f"{len(clean)} source(s) across {len(domains)} domain(s); mean tier {base:.2f}"
    return round(score, 4), why, graded
