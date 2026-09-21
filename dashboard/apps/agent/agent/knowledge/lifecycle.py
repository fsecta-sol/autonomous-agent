"""The knowledge lifecycle decision: what to do with a candidate fact.

Before creating a node, the manager runs the candidate through here to answer the
spec's questions — is this new, duplicate, an expansion, a contradiction, or a
supersede? — using several signals in order (never embeddings alone):

  1. id / slug exact      -> the node exists
  2. title / alias exact  -> same entity under another name
  3. BM25 near-match      -> same concept, lexical
  4. content similarity   -> duplicate (nothing new) vs update (adds detail)
  5. explicit contradiction / supersede hints -> conflict / supersede

The last two signals (contradiction, supersede) are semantic, so they are taken
as *hints* on the candidate: the extraction layer or the model proposes "this
contradicts X", and the manager acts on it. That keeps this module deterministic
and LLM-free while staying LLM-compatible.
"""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

from ..tools import vault_index
from . import index as ix
from .model import slugify

Decision = str  # NEW | UPDATE | RELATED | CONFLICT | DUPLICATE | SUPERSEDE

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Tuned so "same text restated" reads DUPLICATE and "same note + a new paragraph"
# reads UPDATE; a lexical near-match that shares less reads RELATED.
DUP_THRESHOLD = 0.90
UPDATE_THRESHOLD = 0.45
RELATED_THRESHOLD = 0.28


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def content_similarity(a: str, b: str) -> float:
    """A stable 0..1 similarity of two texts (token Jaccard, blended with a
    sequence ratio for short inputs)."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta and not tb:
        return 0.0
    jac = len(ta & tb) / max(1, len(ta | tb))
    seq = difflib.SequenceMatcher(None, a[:4000].lower(), b[:4000].lower()).ratio()
    return max(jac, 0.5 * jac + 0.5 * seq)


@dataclass
class Candidate:
    """A proposed knowledge item, before the manager decides how to integrate."""

    title: str
    text: str = ""
    id: str = ""
    layer: str = ""
    type: str = ""
    tags: list[str] = field(default_factory=list)
    aliases: list[str] = field(default_factory=list)
    # semantic hints from the extraction/LLM layer:
    contradicts: list[str] = field(default_factory=list)
    supersedes: list[str] = field(default_factory=list)

    def slug(self) -> str:
        return slugify(self.id or self.title)


@dataclass
class Verdict:
    kind: Decision
    target: str | None = None  # slug the decision applies to
    score: float = 0.0
    matched_on: str = ""
    reasons: list[str] = field(default_factory=list)
    existing_text: str = ""
    existing_hash: str = ""
    # on NEW: the strongest lexical match, so the new node can be wired in
    related_hint: str | None = None


def decide(cand: Candidate) -> Verdict:
    """Classify a candidate against the current graph."""
    idx = ix.get()
    slug = cand.slug()

    # (5a) explicit supersede hint wins — the caller knows the old note is replaced
    if cand.supersedes:
        t = slugify(cand.supersedes[0])
        if t in idx.nodes:
            return Verdict("SUPERSEDE", t, 1.0, "supersedes-hint", [f"candidate supersedes [[{t}]]"])

    # (1) exact id/slug
    if slug in idx.nodes:
        return _classify_existing(idx, slug, cand, "exact-id")

    # (2) title / alias exact
    cand_title = cand.title.strip().lower()
    for s, node in idx.nodes.items():
        if node.title.lower() == cand_title or any(a.lower() == cand_title for a in node.aliases):
            return _classify_existing(idx, s, cand, "title/alias")

    # (5b) explicit contradiction hint — an assertion that this candidate
    # conflicts with a named node. Checked before lexical similarity so a real
    # contradiction is never downgraded to a vague "related".
    if cand.contradicts:
        t = slugify(cand.contradicts[0])
        if t in idx.nodes:
            existing = _read_body(idx.nodes[t].path)
            return Verdict("CONFLICT", t, 1.0, "contradicts-hint", [f"contradicts [[{t}]]"], existing, "")

    # (3) BM25 near-match, then (4) content similarity on the best candidate
    best_slug = ""
    best_score = 0.0
    for hit in vault_index.search(cand.title + " " + cand.text[:400], limit=12):
        rel = hit["path"]
        if not rel.startswith((ix.CONCEPT_DIR + "/", ix.PROJECT_DIR + "/")):
            continue
        s = slugify(rel.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        if s in idx.nodes:
            sc = float(hit.get("score", 0.0))
            if sc > best_score:
                best_score, best_slug = sc, s

    related_hint = best_slug or None
    if best_slug:
        existing = _read_body(idx.nodes[best_slug].path)
        sim = content_similarity(cand.text, existing)
        if sim >= DUP_THRESHOLD:
            return Verdict("DUPLICATE", best_slug, sim, "bm25+content", [f"≈ duplicate of [[{best_slug}]] (sim {sim:.2f})"], existing, "")
        if sim >= UPDATE_THRESHOLD:
            return Verdict("UPDATE", best_slug, sim, "bm25+content", [f"expands [[{best_slug}]] (sim {sim:.2f})"], existing, "")
        if sim >= RELATED_THRESHOLD:
            return Verdict("RELATED", best_slug, sim, "bm25+content", [f"related to [[{best_slug}]] (sim {sim:.2f})"], existing, "")

    # (NEW) genuinely new. Keep the strongest lexical match as a relation hint so
    # the new node can still be wired into the graph.
    v = Verdict("NEW", None, 0.0, "no-match", ["no existing node matches this candidate"])
    v.related_hint = related_hint
    return v


def _classify_existing(idx: ix.Index, slug: str, cand: Candidate, matched_on: str) -> Verdict:
    node = idx.nodes[slug]
    existing = _read_body(node.path)
    if cand.contradicts and slugify(cand.contradicts[0]) == slug:
        return Verdict("CONFLICT", slug, 1.0, "contradicts-hint", [f"contradicts [[{slug}]]"], existing, "")
    sim = content_similarity(cand.text, existing)
    if not cand.text.strip():
        return Verdict("UPDATE", slug, 0.0, matched_on, [f"[[{slug}]] exists"], existing, "")
    if sim >= DUP_THRESHOLD:
        return Verdict("DUPLICATE", slug, sim, matched_on, [f"content already present in [[{slug}]]"], existing, "")
    return Verdict("UPDATE", slug, sim, matched_on, [f"enrich [[{slug}]] with new detail"], existing, "")


def _read_body(rel: str) -> str:
    from ..config import vault_root

    try:
        return (vault_root() / rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def find_duplicates(cand: Candidate, threshold: float = 0.75) -> list[dict]:
    """Every node plausibly the same concept as `cand`, ranked."""
    idx = ix.get()
    out: list[dict] = []
    seen: set[str] = set()
    for hit in vault_index.search(cand.title + " " + cand.text[:400], limit=20):
        rel = hit["path"]
        if not rel.startswith((ix.CONCEPT_DIR + "/", ix.PROJECT_DIR + "/")):
            continue
        s = slugify(rel.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        if s in seen or s not in idx.nodes:
            continue
        seen.add(s)
        sim = content_similarity(cand.text, _read_body(idx.nodes[s].path))
        if sim >= threshold:
            out.append({"id": s, "title": idx.nodes[s].title, "score": round(float(hit.get("score", 0)), 2), "similarity": round(sim, 2)})
    out.sort(key=lambda d: d["similarity"], reverse=True)
    return out
