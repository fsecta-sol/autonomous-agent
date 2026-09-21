"""KnowledgeGapDetector — turns the current knowledge state into research gaps.

This is where the loop stays *grounded*: candidates are not conjured from the
model's imagination, they are derived from what the Knowledge Manager actually
holds — unanswered unknowns, unresolved conflicts, low-confidence or stale notes,
notes with no evidence, dangling relationships, and objective topics the graph
does not cover.

A `Gap` is a plain dict (JSON-safe) so it flows through events and the API:
    {id, kind, subject, statement, severity, related_knowledge, suggested_question}

`kind` ∈ unknown | conflict | low_confidence | stale | missing_evidence |
          unexplored_relationship | objective_coverage
"""

from __future__ import annotations

import logging
import re
from abc import ABC, abstractmethod
from datetime import date, datetime, timezone

from .context import ResearchContext

log = logging.getLogger("agent.research.gaps")

# Gap severities, highest first. The prioritizer reads these.
SEVERITY_ORDER = {"critical": 3, "high": 2, "medium": 1, "low": 0}

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9-]{2,}")

# Terms too generic to name a concept. Two families: function words / pronouns,
# and the status verbs that success criteria are written with ("X understood",
# "Y identified") — those are checks, not concepts. Kept as an explicit stoplist
# rather than -ed/-ing suffix stripping, because many real concepts end in those
# ("ordering", "pricing", "routing").
_STOP = {
    # function words / pronouns / determiners
    "the", "and", "for", "with", "how", "does", "what", "why", "when", "which", "who", "whom",
    "into", "from", "that", "this", "these", "those", "are", "was", "were", "has", "have", "had",
    "can", "not", "its", "it's", "their", "there", "here", "some", "any", "all", "each", "every",
    "other", "another", "more", "most", "less", "least", "such", "same", "own", "about", "over",
    "under", "against", "between", "within", "without", "well", "also", "then", "than", "them",
    # generic verbs / status participles used in success criteria
    "understand", "understood", "comprehend", "know", "knows", "known", "learn", "learns", "learnt",
    "identify", "identified", "map", "mapped", "capture", "captures", "captured", "document",
    "documented", "verify", "verified", "establish", "established", "achieve", "achieved", "define",
    "defined", "determine", "determined", "resolve", "resolved", "cover", "covered", "reduce",
    "reduced", "increase", "increased", "improve", "improved", "add", "added", "create", "created",
    "update", "updated", "extract", "extracted", "obtain", "obtained", "gather", "gathered",
    "collect", "collected", "analyse", "analysed", "analyze", "analyzed", "compare", "compared",
    "describe", "described", "list", "listed", "enumerate", "review", "reviewed", "check", "checked",
    "validate", "validated", "confirm", "confirmed", "test", "tested", "measure", "measured",
    "make", "makes", "made", "get", "gets", "got", "give", "gives", "find", "finds", "found",
    "see", "seen", "show", "shows", "shown", "need", "needs", "want", "wants", "ensure", "ensures",
    "allow", "allows", "enable", "enables", "use", "using", "used", "work", "works", "working",
    "system", "internal", "internally", "part", "parts", "thing", "things", "stuff", "way", "ways",
    "kind", "sort", "matter", "value", "complete", "completed", "full", "fully", "main",
    "key", "core", "basic", "general", "overall", "whole", "end", "ends",
}


def _keywords(text: str) -> set[str]:
    """Content-bearing lowercased terms in `text` — the vocabulary a concept is
    named with, with function words and success-criterion status verbs removed."""
    return {w for w in _WORD_RE.findall(text.lower()) if w not in _STOP}


_ENTITY_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9]*[.\-0-9][A-Za-z0-9.\-]*")

_SCOPE_PATTERNS = [
    # "Robinhood-chain (chain id 4663)" / "Robinhood chain" — a capitalised
    # proper noun, so "on-chain facts" does not match
    re.compile(r"\b([A-Z][\w]*(?:[-\s]chain)(?:\s*\(chain id\s*\d+\))?)"),
    re.compile(r"\bchain id\s*(\d+)"),
]


def _scope_anchor(text: str, domain: str = "") -> str:
    """The objective's own scope qualifier — the chain or domain it is about.

    Generated questions that name a bare term ("What is b20?") are ambiguous: on
    Robinhood Chain `b20` is a memecoin, on Base it is the EIP-20-style precompile
    standard, and an unqualified question sent a run down the wrong chain for
    hundreds of iterations. Anchoring each derived question to the objective's own
    chain/domain keeps the term in the scope the objective actually means."""
    if domain:
        return domain
    for pat in _SCOPE_PATTERNS:
        m = pat.search(text)
        if m:
            return re.sub(r"\s+", " ", m.group(1)).strip()
    return ""


def _qualify(term: str, anchor: str) -> str:
    """Turn a bare objective term into a question scoped to `anchor`, when the
    term is ambiguous (a short code like `b20`, `b420`) and an anchor exists."""
    base = f"What is {term}"
    ambiguous = bool(anchor) and re.search(r"\d", term) is not None and len(term) <= 6
    if ambiguous and anchor.lower() not in term.lower():
        return f"{base} on {anchor}, and how does it work?"
    return f"{base} and how does it work?"



def _salient_terms(text: str) -> set[str]:
    """Entity-like terms in an objective — hyphenated/dotted/versioned identifiers
    (robinhood-chain, block-0, b20, pmav.fun). Used to name an objective-coverage
    gap. Sentence-initial capitalisation is deliberately NOT used (it is
    indistinguishable from a proper noun and would surface "Addresses"), and plain
    lowercase English words are excluded, so a coverage gap names a real subject."""
    out: set[str] = set()
    for tok in _ENTITY_TOKEN_RE.findall(text):
        low = tok.lower().strip("-.")
        if low and low not in _STOP:
            out.add(low)
    return out


def _parse_date(value: str) -> date | None:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d"):
        try:
            # calendar dates (no time, no tz) — tz-naive is correct here
            return datetime.strptime(value[:10], fmt).date()  # noqa: DTZ007
        except ValueError:
            continue
    return None


def _severity_conflict() -> str:
    return "critical"


class KnowledgeGapDetector(ABC):
    """Produces this iteration's gaps from the knowledge state (spec §8)."""

    @abstractmethod
    async def detect(self, ctx: ResearchContext) -> list[dict]:
        ...


class DefaultGapDetector(KnowledgeGapDetector):
    """Reads the Knowledge Manager's index and objective to enumerate gaps.

    `stale_days` bounds how old a note must be (and how long since verified) to
    count as stale. `confidence_floor` is the numeric cut for low-confidence.
    All thresholds are constructor args so the behaviour is testable and tunable.
    """

    def __init__(self, deps: Deps, *, stale_days: int = 90, min_sources: int = 1, max_gaps: int = 40):
        self.deps = deps
        self.stale_days = stale_days
        self.min_sources = min_sources
        self.max_gaps = max_gaps

    async def detect(self, ctx: ResearchContext) -> list[dict]:
        gaps: list[dict] = []
        seen_subjects: set[str] = set()

        idx = None
        try:
            from ..knowledge import index as kix

            idx = kix.get()
        except Exception:
            log.exception("knowledge index unavailable for gap detection")

        # The set of nodes this run may raise gaps about: the objective-relevant
        # nodes the loader recalled, plus nodes whose slug/title names an objective
        # term. Everything else in the vault belongs to some *other* line of work,
        # and adopting it is exactly how a run drifts off-topic (a memecoin study
        # once spent its whole budget on a previous run's archive questions).
        scope = self._objective_scope(ctx, idx)

        # ── unknowns ──
        relevant_ids = {r.get("id", "") for r in ctx.relevant}
        for u in ctx.open_unknowns:
            sid = u.get("id", "")
            # Only the run's own unknowns, or ones the loader recalled as relevant
            # to its objective. The loader pulls every open unknown in the vault;
            # adopting them all is how a run inherits a previous run's agenda (a
            # memecoin study once spent its whole budget on Common Crawl
            # archaeology). Keyword overlap is NOT used here — a long objective
            # shares generic words with any long question, so it scopes nothing.
            investigations = [str(i) for i in (u.get("investigations") or [])]
            # investigation pointers read "research:<run_id>", so match by substring
            own = any(ctx.run_id and ctx.run_id in inv for inv in investigations)
            if not (own or sid in relevant_ids):
                continue
            seen_subjects.add(sid)
            gaps.append(
                {
                    "id": f"gap-unknown-{sid}",
                    "kind": "unknown",
                    "subject": sid,
                    "statement": f"Open unknown: {u.get('question') or u.get('title') or sid}",
                    "severity": "high",
                    "related_knowledge": [sid] if sid else [],
                    "suggested_question": u.get("question") or f"What is the answer to the open unknown '{sid}'?",
                }
            )

        if idx is not None:
            today = datetime.now(timezone.utc).date()
            for slug, node in idx.nodes.items():
                if node.status in ("superseded", "open"):
                    continue
                if slug not in scope:
                    continue
                # ── conflicts ──
                if self._has_section(node.path, "Conflict"):
                    if slug not in seen_subjects:
                        seen_subjects.add(slug)
                        gaps.append(
                            {
                                "id": f"gap-conflict-{slug}",
                                "kind": "conflict",
                                "subject": slug,
                                "statement": f"Unresolved conflict recorded on [[{slug}]]",
                                "severity": _severity_conflict(),
                                "related_knowledge": [slug],
                                "suggested_question": f"Which claim is correct about {slug}, and what evidence settles it?",
                            }
                        )
                    continue

                # ── missing evidence ──
                if node.sources < self.min_sources and node.kind == "concept":
                    gaps.append(
                        {
                            "id": f"gap-evidence-{slug}",
                            "kind": "missing_evidence",
                            "subject": slug,
                            "statement": f"[[{slug}]] has no cited sources to substantiate it",
                            "severity": "medium",
                            "related_knowledge": [slug],
                            "suggested_question": f"What primary sources substantiate the claims in {slug}?",
                        }
                    )

                # ── low confidence / unverified ──
                if not node.verified_at and (node.confidence or "").lower() in ("", "low", "medium"):
                    gaps.append(
                        {
                            "id": f"gap-confidence-{slug}",
                            "kind": "low_confidence",
                            "subject": slug,
                            "statement": f"[[{slug}]] is unverified (confidence {node.confidence or 'unset'})",
                            "severity": "medium",
                            "related_knowledge": [slug],
                            "suggested_question": f"What evidence would verify the claims in {slug}?",
                        }
                    )

                # ── stale ──
                upd = _parse_date(node.updated)
                if upd and (today - upd).days > self.stale_days:
                    gaps.append(
                        {
                            "id": f"gap-stale-{slug}",
                            "kind": "stale",
                            "subject": slug,
                            "statement": f"[[{slug}]] last updated {node.updated} (> {self.stale_days}d ago)",
                            "severity": "low",
                            "related_knowledge": [slug],
                            "suggested_question": f"Has anything about {slug} changed since {node.updated}?",
                        }
                    )

            # ── dangling relationships ──
            for edge in idx.dangling:
                target = edge.target
                # only surface a missing link the run's own knowledge points at
                if edge.source not in scope:
                    continue
                if target in seen_subjects:
                    continue
                seen_subjects.add(target)
                gaps.append(
                    {
                        "id": f"gap-rel-{edge.source}-{target}",
                        "kind": "unexplored_relationship",
                        "subject": target,
                        "statement": f"[[{edge.source}]] links to [[{target}]], which has no note yet",
                        "severity": "medium",
                        "related_knowledge": [edge.source],
                        "suggested_question": f"What is {target}, and how does it relate to {edge.source}?",
                    }
                )

        # ── objective coverage ──
        gaps.extend(self._objective_gaps(ctx, idx, scope))

        # de-dupe by id, cap, and order by severity
        uniq: dict[str, dict] = {}
        for g in gaps:
            uniq.setdefault(g["id"], g)
        ordered = sorted(uniq.values(), key=lambda g: SEVERITY_ORDER.get(g["severity"], 0), reverse=True)
        return ordered[: self.max_gaps]

    @staticmethod
    def _objective_scope(ctx: ResearchContext, idx) -> set[str]:
        """The nodes this run is allowed to raise gaps about.

        Union of (a) the objective-relevant nodes the loader recalled and (b) nodes
        whose slug/title names an objective term. `status-open-question-*` notes are
        excluded — those are the unknown nodes themselves, handled by the unknown
        path, not concept nodes to verify."""
        scope: set[str] = set()
        obj_kw = _keywords(ctx.objective.statement) | {
            k for c in ctx.objective.success_criteria for k in _keywords(c)
        }
        for r in ctx.relevant:
            rid = r.get("id", "")
            if rid and not rid.startswith("status-open-question"):
                scope.add(rid)
        if idx is not None and obj_kw:
            for slug, node in idx.nodes.items():
                if slug.startswith("status-open-question"):
                    continue
                if (_keywords(slug) | _keywords(node.title)) & obj_kw:
                    scope.add(slug)
        return scope

    def _objective_gaps(self, ctx: ResearchContext, idx, scope: set[str]) -> list[dict]:
        """Objective terms no *relevant* node covers — the "we were asked to
        understand X and have nothing on it" gap. Coverage is measured against the
        in-scope nodes only, so an objective term is a gap unless the run's own
        knowledge already names it (the whole vault does not count as coverage —
        that is what let a run consider its objective pre-satisfied)."""
        terms = _keywords(ctx.objective.statement) | {k for c in ctx.objective.success_criteria for k in _keywords(c)}
        # drop bare numbers/ordering tokens ("1", "2-3") that succeed-criteria
        # numbering leaks into the keyword set
        terms = {t for t in terms if not t.replace("-", "").isdigit()}
        if not terms:
            return []
        covered: set[str] = set()
        if idx is not None:
            for slug in scope:
                node = idx.node(slug)
                if node is not None:
                    covered |= _keywords(slug) | _keywords(node.title)
        else:
            for r in ctx.relevant:
                covered |= _keywords(r.get("id", "")) | _keywords(r.get("title", ""))
        missing = terms - covered
        if not missing:
            return []
        # Name the gap after entity-like objective terms (robinhood-chain, b20,
        # pmav.fun) rather than the alphabetically-first leftover English word, so
        # the surfaced question is about a real subject.
        salient = _salient_terms(ctx.objective.statement) - covered
        salient = sorted(salient) or sorted(missing)
        named = ", ".join(salient[:8])
        anchor = _scope_anchor(ctx.objective.statement, getattr(ctx.objective, "domain", ""))
        out = [
            {
                "id": "gap-objective-coverage",
                "kind": "objective_coverage",
                "subject": ctx.objective.statement[:80],
                "statement": f"Objective topics with no knowledge node: {named}",
                "severity": "high",
                "related_knowledge": [],
                "suggested_question": _qualify(salient[0], anchor),
            }
        ]
        for term in salient[:2]:
            out.append(
                {
                    "id": f"gap-objective-{term}",
                    "kind": "objective_coverage",
                    "subject": term,
                    "statement": f"'{term}' is required by the objective but has no node",
                    "severity": "medium",
                    "related_knowledge": [],
                    "suggested_question": _qualify(term, anchor),
                }
            )
        return out

    @staticmethod
    def _has_section(rel: str, section: str) -> bool:
        try:
            from ..config import vault_root
            from ..knowledge.model import Note

            raw = (vault_root() / rel).read_text(encoding="utf-8", errors="replace")
            note = Note(path=rel, raw=raw)
            return note.section(section) is not None
        except Exception:  # noqa: BLE001
            return False


if False:  # pragma: no cover
    from .loop import Deps
