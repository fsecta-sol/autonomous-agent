"""Derived knowledge index, built ONLY from the Markdown vault.

This is inspectable, disposable infrastructure: delete it and `rebuild()` puts it
back from the `.md` files alone. It is never the source of truth — the notes are.
The index adds what a per-file read cannot cheaply give: typed edges (the graph),
inbound/outbound degree, and the frontmatter fields retrieval filters on.

Nodes are concept notes (`03-Areas/concepts/*.md`) and project notes
(`02-Projects/*.md`). Edges come from `[[wikilinks]]` whose *section* names the
relationship (`## Builds on` / `## Enables` / `## Related (same layer)`), exactly
the on-disk convention the vault already uses — no new relationship format.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..config import knowledge_index_path, vault_root
from . import vault_store
from .model import Note, slugify

CONCEPT_DIR = "03-Areas/concepts"
PROJECT_DIR = "02-Projects"

SECTION_RELATION = {
    "builds on": "builds-on",
    "enables": "enables",
    "related (same layer)": "related",
}

REVERSE_RELATION = {"builds-on": "enables", "enables": "builds-on", "related": "related"}


@dataclass
class Node:
    id: str
    path: str
    kind: str  # "concept" | "project"
    title: str
    layer: str
    type: str
    status: str
    created: str
    updated: str
    confidence: str
    aliases: list[str] = field(default_factory=list)
    superseded_by: str = ""
    verified_at: str = ""
    degree: int = 0
    links_out: int = 0
    links_in: int = 0
    sources: int = 0


@dataclass
class Edge:
    source: str  # slug
    target: str  # slug
    relation: str  # builds-on | enables | related
    section: str


@dataclass
class Index:
    signature: str
    built_at: float
    nodes: dict[str, Node]
    edges: list[Edge]
    # slug -> {"in": [Edge], "out": [Edge]}
    adjacency: dict[str, dict[str, list[Edge]]] = field(default_factory=dict)
    dangling: list[Edge] = field(default_factory=list)

    def node(self, slug: str) -> Node | None:
        return self.nodes.get(slugify(slug))

    def neighbors(self, slug: str, relation: str | None = None) -> list[str]:
        adj = self.adjacency.get(slugify(slug))
        if not adj:
            return []
        out: list[str] = []
        for e in adj["out"] + adj["in"]:
            if relation and e.relation != relation:
                continue
            other = e.target if e.source == slugify(slug) else e.source
            if other not in out:
                out.append(other)
        return out


def _note_roots() -> list[Path]:
    """Roots a note may live under: the shared vault, plus the active staging
    workspace when a run is writing to one (staged notes shadow the vault's)."""
    roots = [vault_root()]
    stage = vault_store.staging_root()
    if stage is not None and stage != vault_root():
        roots.append(stage)
    return roots


def _iter_notes() -> list[tuple[str, str]]:
    """(rel, kind) for every concept/project note across the vault and any active
    staging workspace, sorted for determinism. A rel present in both is listed
    once (the staged copy shadows the vault's)."""
    seen: dict[str, str] = {}
    for root in _note_roots():
        for folder, kind in ((CONCEPT_DIR, "concept"), (PROJECT_DIR, "project")):
            d = root / folder
            if not d.is_dir():
                continue
            for p in sorted(d.glob("*.md")):
                seen.setdefault(str(p.relative_to(root)), kind)
    return sorted(seen.items())


def _signature(files: list[tuple[str, str]]) -> str:
    total = 0
    max_mtime = 0.0
    roots = _note_roots()
    for rel, _kind in files:
        for root in roots:
            try:
                st = (root / rel).stat()
            except OSError:
                continue
            total += st.st_size
            max_mtime = max(max_mtime, st.st_mtime)
    return f"{len(files)}:{total}:{round(max_mtime)}"


def _node_from(note: Note, rel: str, kind: str, slug: str) -> Node:
    def s(key: str, default: str = "") -> str:
        return note.fm(key) or default

    aliases = note.frontmatter.get_list("aliases")
    return Node(
        id=slug,
        path=rel,
        kind=kind,
        title=s("title") or slug,
        layer=s("layer"),
        type=s("type"),
        status=s("status", "active"),
        created=s("created"),
        updated=s("updated"),
        confidence=s("confidence"),
        aliases=aliases,
        superseded_by=s("superseded_by"),
        verified_at=s("verified_at"),
        sources=len(note.frontmatter.get_list("sources")),
    )


def build() -> Index:
    """Parse the vault and construct the index in memory."""
    files = _iter_notes()
    notes: list[tuple[str, str, str, Note]] = []
    for rel, kind in files:
        try:
            raw = vault_store._read_path(rel, must_exist=False).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        note = Note(path=rel, raw=raw)
        slug = note.slug() or slugify(Path(rel).stem)
        notes.append((rel, kind, slug, note))

    known = {slug for _rel, _kind, slug, _note in notes}
    nodes: dict[str, Node] = {}
    edges: list[Edge] = []
    dangling: list[Edge] = []

    for rel, kind, slug, note in notes:
        nodes[slug] = _node_from(note, rel, kind, slug)
        for target_raw, _alias, section in note.all_links():
            relation = SECTION_RELATION.get(section.lower())
            if relation is None:
                continue  # only the three structured sections form typed edges
            target = slugify(target_raw.rsplit("/", 1)[-1])
            e = Edge(source=slug, target=target, relation=relation, section=section)
            if target in known and target != slug:
                edges.append(e)
            elif target not in known:
                dangling.append(e)

    # degrees + adjacency
    adjacency: dict[str, dict[str, list[Edge]]] = {s: {"in": [], "out": []} for s in nodes}
    for e in edges:
        if e.source in adjacency:
            adjacency[e.source]["out"].append(e)
        if e.target in adjacency:
            adjacency[e.target]["in"].append(e)
    for slug, node in nodes.items():
        adj = adjacency.get(slug, {"in": [], "out": []})
        # unique neighbor count = degree (both directions)
        nbrs = {(e.target if e.source == slug else e.source) for e in adj["out"] + adj["in"]}
        node.degree = len(nbrs)
        node.links_out = len(adj["out"])
        node.links_in = len(adj["in"])

    return Index(signature=_signature(files), built_at=time.time(), nodes=nodes, edges=edges, adjacency=adjacency, dangling=dangling)


# ── cache + persistence ──────────────────────────────────────────────────────

_cached: Index | None = None
_checked_at = 0.0
REVALIDATE_SECONDS = 2.0


def get(force: bool = False) -> Index:
    """The index, rebuilt only when the vault's signature changed."""
    global _cached, _checked_at
    now = time.monotonic()
    if not force and _cached is not None and now - _checked_at < REVALIDATE_SECONDS:
        return _cached
    sig = _signature(_iter_notes())
    _checked_at = now
    if not force and _cached is not None and _cached.signature == sig:
        return _cached
    _cached = build()
    return _cached


def rebuild() -> Index:
    """Force a full rebuild from Markdown (the recovery path)."""
    global _cached
    _cached = build()
    save(_cached)
    return _cached


def invalidate() -> None:
    global _cached, _checked_at
    _cached = None
    _checked_at = 0.0


def to_json(idx: Index) -> str:
    return json.dumps(
        {
            "signature": idx.signature,
            "built_at": idx.built_at,
            "nodes": {k: asdict(v) for k, v in idx.nodes.items()},
            "edges": [asdict(e) for e in idx.edges],
            "dangling": [asdict(e) for e in idx.dangling],
        },
        ensure_ascii=False,
        indent=0,
    )


def save(idx: Index | None = None) -> Path:
    idx = idx or get()
    path = knowledge_index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(to_json(idx), encoding="utf-8")
    return path


def stats(idx: Index | None = None) -> dict:
    idx = idx or get()
    by_layer: dict[str, int] = {}
    by_type: dict[str, int] = {}
    by_status: dict[str, int] = {}
    for n in idx.nodes.values():
        by_layer[n.layer or "?"] = by_layer.get(n.layer or "?", 0) + 1
        by_type[n.type or "?"] = by_type.get(n.type or "?", 0) + 1
        by_status[n.status or "?"] = by_status.get(n.status or "?", 0) + 1
    return {
        "nodes": len(idx.nodes),
        "edges": len(idx.edges),
        "dangling": len(idx.dangling),
        "by_layer": by_layer,
        "by_type": by_type,
        "by_status": by_status,
    }
