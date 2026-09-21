"""Hybrid retrieval over the Markdown knowledge graph.

Signals, combined (never embeddings-alone, and embeddings are optional):

  1. exact id / title / alias match      (strongest)
  2. BM25 text relevance                 (reuses tools.vault_index)
  3. graph relationship                  (neighbors of a direct hit)
  4. frontmatter filters                 (layer / type / status)
  5. confidence, then recency            (tie-breakers)

`search` ranks nodes; `get_relevant` renders a compact context block that keeps
the provenance the spec asks for: node, source, confidence, verification status,
relationships, last-updated. Nothing here injects the whole vault.
"""

from __future__ import annotations

from ..tools import vault_index
from . import index as ix
from .model import slugify

KNOWLEDGE_PREFIXES = (ix.CONCEPT_DIR + "/", ix.PROJECT_DIR + "/")


def _is_knowledge_path(rel: str) -> bool:
    return rel.startswith(KNOWLEDGE_PREFIXES)


def _confidence_rank(v: str) -> float:
    """Map a confidence field to a comparable number (unknown = neutral)."""
    if not v:
        return 0.5
    low = v.strip().lower()
    named = {"high": 0.9, "medium": 0.6, "low": 0.3}
    if low in named:
        return named[low]
    try:
        return max(0.0, min(1.0, float(low)))
    except ValueError:
        return 0.5


def _node_dict(idx: ix.Index, slug: str, score: float, why: str) -> dict:
    n = idx.node(slug)
    if n is None:
        return {}
    adj = idx.adjacency.get(slug, {"in": [], "out": []})
    related = sorted({(e.target if e.source == slug else e.source) for e in adj["out"] + adj["in"]})
    return {
        "id": n.id,
        "path": n.path,
        "kind": n.kind,
        "title": n.title,
        "layer": n.layer,
        "type": n.type,
        "status": n.status,
        "confidence": n.confidence or None,
        "verified_at": n.verified_at or None,
        "superseded_by": n.superseded_by or None,
        "updated": n.updated,
        "sources": n.sources,
        "degree": n.degree,
        "related": related,
        "score": round(score, 3),
        "why": why,
    }


def search(
    query: str,
    *,
    limit: int = 8,
    layer: str | None = None,
    type_: str | None = None,
    status: str | None = None,
    include_superseded: bool = False,
    expand_neighbors: bool = True,
    exclude_id: str | None = None,
) -> list[dict]:
    """Rank knowledge nodes for `query`. Returns dicts (see `_node_dict`)."""
    idx = ix.get()
    q = (query or "").strip().lower()
    if not q:
        return []

    scores: dict[str, float] = {}
    why: dict[str, str] = {}

    # (1) exact id / title / alias
    for slug, node in idx.nodes.items():
        if slug == q or node.title.lower() == q or any(a.lower() == q for a in node.aliases):
            scores[slug] = scores.get(slug, 0.0) + 10.0
            why[slug] = "exact id/title/alias"

    # (2) BM25 (reuse the vault's existing lexical index)
    for hit in vault_index.search(query, limit=max(limit * 4, 24)):
        rel = hit["path"]
        if not _is_knowledge_path(rel):
            continue
        slug = slugify(rel.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        if slug not in idx.nodes:
            continue
        scores[slug] = scores.get(slug, 0.0) + float(hit.get("score", 0.0))
        why.setdefault(slug, "text match")

    # (3) graph expansion from the strongest hits
    if expand_neighbors and scores:
        seeds = sorted(scores, key=lambda s: scores[s], reverse=True)[:3]
        for seed in seeds:
            for nbr in idx.neighbors(seed):
                if nbr == seed:
                    continue
                scores.setdefault(nbr, 0.0)
                scores[nbr] += 1.5
                why.setdefault(nbr, f"neighbor of {seed}")

    out: list[dict] = []
    for slug, score in scores.items():
        if exclude_id and slug == slugify(exclude_id):
            continue
        node = idx.node(slug)
        if node is None:
            continue
        if node.superseded_by and not include_superseded:
            continue
        # (4) filters
        if layer and node.layer != layer:
            continue
        if type_ and node.type != type_:
            continue
        if status and node.status != status:
            continue
        # (5) confidence + degree + recency nudges
        score += _confidence_rank(node.confidence) * 0.5
        score += min(node.degree, 20) * 0.05
        out.append(_node_dict(idx, slug, score, why.get(slug, "related")))

    out.sort(key=lambda d: (d["score"], d["updated"]), reverse=True)
    return out[: max(1, limit)]


def get_node(slug: str) -> dict | None:
    """A single node with its full metadata + relations (no body)."""
    idx = ix.get()
    s = slugify(slug)
    if s not in idx.nodes:
        return None
    return _node_dict(idx, s, 0.0, "direct read")


def get_relevant(
    context: str,
    *,
    limit: int = 6,
    layer: str | None = None,
    include_superseded: bool = False,
) -> dict:
    """Retrieve + render the context block for a task's free-text `context`."""
    hits = search(context, limit=limit, layer=layer, include_superseded=include_superseded)
    return {"context": context, "count": len(hits), "nodes": hits, "rendered": render_context(hits)}


def render_context(hits: list[dict]) -> str:
    """The compact, provenance-retaining block injected before a task runs."""
    if not hits:
        return "KNOWLEDGE\n(none found in the graph for this task)"
    lines = ["KNOWLEDGE"]
    for h in hits:
        status_bit = h["status"] or "active"
        if h.get("superseded_by"):
            status_bit = f"superseded by [[{h['superseded_by']}]]"
        conf = h.get("confidence") or "—"
        lines.append("")
        lines.append(f"[[{h['id']}]]  ({h['kind']})")
        lines.append(f"Title: {h['title']}")
        lines.append(f"Layer: {h['layer'] or '—'} · Type: {h['type'] or '—'} · Status: {status_bit} · Confidence: {conf}")
        lines.append(f"Updated: {h['updated'] or '—'} · Sources: {h['sources']} · Verification: {h.get('verified_at') or 'unverified'}")
        if h["related"]:
            lines.append("Related: " + ", ".join(f"[[{r}]]" for r in h["related"][:8]))
    return "\n".join(lines)
