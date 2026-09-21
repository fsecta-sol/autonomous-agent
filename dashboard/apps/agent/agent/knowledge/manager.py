"""KnowledgeManager — the lifecycle service over the Markdown knowledge graph.

This is the public API the agent (and tools) call. It owns the lifecycle of
accumulated knowledge — create, read, update, relate, verify, contradict,
supersede, archive, retrieve — and delegates every byte-level write to
`vault_store` (atomic, backed up, locked) and every parse to `model`. It does NOT
own scheduling, task state, orchestration or chat history; those stay elsewhere.

The Markdown remains canonical. If this module is deleted, the notes still hold
everything; if the derived index is deleted, `rebuild_index()` restores it.
"""

from __future__ import annotations

from collections import deque
from datetime import date, datetime, timezone

from ..tools import vault_index
from . import index as ix
from . import lifecycle, observability, retrieval, vault_store
from . import model as M
from .model import Note, render_new_concept, slugify

CONCEPT_DIR = ix.CONCEPT_DIR
PROJECT_DIR = ix.PROJECT_DIR


def _reindex() -> None:
    """Drop both derived caches — the knowledge index and the vault's BM25 index —
    so a read that immediately follows a write sees the change without waiting out
    either cache's TTL."""
    ix.invalidate()
    vault_index.invalidate()


# Relation name -> the reverse relation written on the target note.
INVERSE = {"builds-on": "enables", "enables": "builds-on", "related": "related"}


def _inverse_for(relation: str) -> str:
    r = relation.lower().replace("-", "_")
    if r in M.BUILDS_ON_TYPES:
        return "enables"
    if r in M.ENABLES_TYPES:
        return "builds-on"
    return "related"


class KnowledgeManager:
    def __init__(self, *, now: date | None = None):
        # `now` pins the date for tests only. Production must NOT cache it: this
        # instance is process-wide (`default_manager()`), and the service lives
        # for days — a cached date stamps every later write with the first day.
        self._today_override = now.isoformat() if now is not None else None

    @property
    def _today(self) -> str:
        """Today's UTC date, evaluated per call (never cached — see __init__)."""
        return self._today_override or datetime.now(timezone.utc).date().isoformat()

    # ── read ─────────────────────────────────────────────────────────────────
    def get(self, knowledge_id: str, *, with_body: bool = False) -> dict | None:
        """Resolve a knowledge ID to its node (and optionally its full text)."""
        slug = slugify(knowledge_id)
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return None
        out = retrieval.get_node(slug)
        if out is None:
            return None
        if with_body:
            try:
                note, h = vault_store.read(node.path)
                out["body"] = note.render()
                out["hash"] = h
            except vault_store.VaultError:
                out["body"] = None
        return out

    def search(self, query: str, options: dict | None = None) -> list[dict]:
        options = options or {}
        return retrieval.search(
            query,
            limit=int(options.get("limit", 8)),
            layer=options.get("layer"),
            type_=options.get("type"),
            status=options.get("status"),
            include_superseded=bool(options.get("include_superseded", False)),
        )

    def get_relevant(self, context: str, options: dict | None = None) -> dict:
        options = options or {}
        return retrieval.get_relevant(
            context,
            limit=int(options.get("limit", 6)),
            layer=options.get("layer"),
            include_superseded=bool(options.get("include_superseded", False)),
        )

    def get_related(self, knowledge_id: str) -> dict:
        slug = slugify(knowledge_id)
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return {"id": slug, "found": False, "related": []}
        adj = idx.adjacency.get(slug, {"in": [], "out": []})
        inbound = [{"id": e.source, "relation": e.relation} for e in adj["in"]]
        outbound = [{"id": e.target, "relation": e.relation} for e in adj["out"]]
        return {"id": slug, "found": True, "outbound": outbound, "inbound": inbound}

    def find_neighbors(self, knowledge_id: str) -> list[str]:
        return ix.get().neighbors(knowledge_id)

    def find_path(self, source: str, target: str, max_depth: int = 4) -> list[str] | None:
        """Shortest undirected path between two nodes (BFS), or None."""
        idx = ix.get()
        s, t = slugify(source), slugify(target)
        if s not in idx.nodes or t not in idx.nodes:
            return None
        if s == t:
            return [s]
        prev: dict[str, str] = {s: s}
        depth: dict[str, int] = {s: 0}
        q: deque[str] = deque([s])
        while q:
            cur = q.popleft()
            if depth[cur] >= max_depth:
                continue
            for nbr in idx.neighbors(cur):
                if nbr in prev:
                    continue
                prev[nbr] = cur
                depth[nbr] = depth[cur] + 1
                if nbr == t:
                    path = [t]
                    while path[-1] != s:
                        path.append(prev[path[-1]])
                    return list(reversed(path))
                q.append(nbr)
        return None

    def find_duplicates(self, candidate) -> list[dict]:
        return lifecycle.find_duplicates(_as_candidate(candidate))

    def find_conflicts(self, candidate) -> list[dict]:
        v = lifecycle.decide(_as_candidate(candidate))
        if v.kind == "CONFLICT" and v.target:
            return [{"id": v.target, "reason": v.reasons}]
        return []

    def find_unknowns(self, topic: str = "") -> list[dict]:
        """Open unknowns (`## Unknown`, status open) optionally filtered by topic.

        `question` is the real question text pulled out of the section body (which
        opens with `status: open` and a `Question:` heading) rather than the raw
        section — otherwise downstream candidates read `"status: open\\nQuestion: …"`.
        `investigations` (the research runs that recorded the unknown) is returned
        so a caller can scope unknowns to its own run."""
        idx = ix.get()
        out = []
        for n in idx.nodes.values():
            if n.status != "open":
                continue
            hit = _note_has_section(n.path, "Unknown")
            if not hit:
                continue
            question, investigations = _parse_unknown_section(hit)
            if topic and topic.lower() not in (n.title + " " + question).lower():
                continue
            out.append({"id": n.id, "title": n.title, "updated": n.updated,
                        "question": question, "investigations": investigations})
        return out

    # ── write ────────────────────────────────────────────────────────────────
    def create_knowledge(self, *, title: str, text: str = "", id: str = "", layer: str = "", type: str = "",
                         sources: list[str] | None = None, aliases: list[str] | None = None,
                         tags: list[str] | None = None, kind: str = "concept",
                         contradicts: list[str] | None = None, supersedes: list[str] | None = None,
                         evidence: list[str] | None = None, task_id: str = "", research_id: str = "",
                         execution_id: str = "", source: str = "") -> dict:
        """Integrate a candidate fact — the spec §13 pipeline in one call.

        Runs the candidate through dedup + conflict detection, then takes the
        right action (create / enrich / relate / conflict / supersede / skip).
        """
        cand = lifecycle.Candidate(
            title=title, text=text, id=id, layer=layer, type=type, tags=tags or [],
            aliases=aliases or [], contradicts=contradicts or [], supersedes=supersedes or [],
        )
        v = lifecycle.decide(cand)
        ctx = {"task_id": task_id, "research_id": research_id, "execution_id": execution_id, "source": source}

        if v.kind == "DUPLICATE" and v.target:
            observability.emit("KNOWLEDGE_DUPLICATE", knowledge_id=v.target, detail=f"sim {v.score:.2f}", **ctx)
            return {"action": "DUPLICATE", "id": v.target, "reason": v.reasons}
        if v.kind == "CONFLICT" and v.target:
            return self._record_conflict(v.target, text, sources or [], evidence or [], **ctx)
        if v.kind == "SUPERSEDE" and v.target:
            new = self._create_new(cand, sources or [], evidence or [], kind, relation_hint=None, **ctx)
            self.supersede(v.target, new["id"], **ctx)
            return {"action": "SUPERSEDE", "id": new["id"], "superseded": v.target}
        if v.kind == "UPDATE" and v.target:
            return self._enrich(v.target, text, sources or [], evidence or [], **ctx)
        # NEW or RELATED -> create; wire the relation hint if present
        hint = v.related_hint if v.kind in ("NEW", "RELATED") else None
        new = self._create_new(cand, sources or [], evidence or [], kind, relation_hint=hint, **ctx)
        return {"action": "CREATE", "id": new["id"], "related_hint": hint}

    def update_knowledge(self, knowledge_id: str, *, text: str = "", sources: list[str] | None = None,
                         evidence: list[str] | None = None, task_id: str = "", source: str = "") -> dict:
        return self._enrich(slugify(knowledge_id), text, sources or [], evidence or [], task_id=task_id, source=source)

    def add_relation(self, source: str, relation: str, target: str, *, note: str = "",
                     task_id: str = "", source_ref: str = "") -> dict:
        """Add a typed relationship, writing the reciprocal edge too."""
        s, t = slugify(source), slugify(target)
        idx = ix.get()
        if s not in idx.nodes:
            return {"ok": False, "error": f"source not found: {s}"}
        section = M.RELATION_SECTION.get(relation, "Related (same layer)")
        line = f"- [[{t}]]" + (f" — {note}" if note else "")
        with vault_store.lock():
            self._append_link(s, section, t, line)
            recip = "related" if t not in idx.nodes else _inverse_for(relation)
            recip_section = M.RELATION_SECTION.get(recip, "Related (same layer)")
            recip_line = f"- [[{s}]]" + (f" — reciprocal of {s}'s {relation}" if note else "")
            if t in idx.nodes:
                self._append_link(t, recip_section, s, recip_line)
        _reindex()
        observability.emit("RELATION_CREATED", knowledge_id=s, source=source_ref,
                           detail=f"{s} {relation} {t}", task_id=task_id)
        return {"ok": True, "source": s, "relation": relation, "target": t,
                "section": section, "reciprocal": recip if t in idx.nodes else None}

    def remove_relation(self, source: str, target: str, *, task_id: str = "", source_ref: str = "") -> dict:
        s, t = slugify(source), slugify(target)
        removed = 0
        with vault_store.lock():
            removed += self._remove_link(s, t)
            removed += self._remove_link(t, s)
        _reindex()
        observability.emit("RELATION_REMOVED", knowledge_id=s, detail=f"{s} x {t}", source=source_ref, task_id=task_id)
        return {"ok": True, "removed": removed}

    def add_evidence(self, knowledge_id: str, evidence: list[str], *, task_id: str = "", source: str = "") -> dict:
        slug = slugify(knowledge_id)
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return {"ok": False, "error": f"not found: {slug}"}
        block = "\n".join(f"- {e}" for e in evidence)
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            before = note.render()
            note.append_to_section("Evidence", block)
            if note.render() == before:
                return {"ok": True, "id": slug, "changed": False}
            res = vault_store.write(node.path, note.render(), expect_hash=h)
        _reindex()
        observability.emit("EVIDENCE_ADDED", knowledge_id=slug, source=source, task_id=task_id,
                           detail=f"{len(evidence)} item(s)")
        return {"ok": True, "id": slug, "changed": res["changed"]}

    def verify(self, knowledge_id: str, evidence: list[str] | None = None, *, confidence: str = "high",
               task_id: str = "", source: str = "") -> dict:
        slug = slugify(knowledge_id)
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return {"ok": False, "error": f"not found: {slug}"}
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            note.set_fm("verified_at", self._today)
            note.set_fm("confidence", confidence)
            note.set_fm("updated", self._today)
            if evidence:
                note.append_to_section("Evidence", "\n".join(f"- {e}" for e in evidence))
            res = vault_store.write(node.path, note.render(), expect_hash=h)
        _reindex()
        observability.emit("KNOWLEDGE_VERIFIED", knowledge_id=slug, source=source, task_id=task_id,
                           detail=f"confidence {confidence}")
        return {"ok": True, "id": slug, "verified_at": self._today, "confidence": confidence, "changed": res["changed"]}

    def supersede(self, old_id: str, new_id: str, *, task_id: str = "", source: str = "") -> dict:
        """Mark `old_id` superseded by `new_id`. The old file is kept (history)."""
        old, new = slugify(old_id), slugify(new_id)
        idx = ix.get()
        node = idx.node(old)
        if node is None:
            return {"ok": False, "error": f"not found: {old}"}
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            note.set_fm("status", "superseded")
            note.set_fm("superseded_by", new)
            note.set_fm("updated", self._today)
            note.append_to_section("Notes", f"Superseded by [[{new}]] on {self._today}. This note is kept for history.")
            res = vault_store.write(node.path, note.render(), expect_hash=h)
        _reindex()
        observability.emit("KNOWLEDGE_SUPERSEDED", knowledge_id=old, source=source, task_id=task_id, detail=f"by {new}")
        return {"ok": True, "old": old, "new": new, "changed": res["changed"]}

    def create_unknown(self, *, question: str, id: str = "", investigations: list[str] | None = None,
                       sector: str = "concept", task_id: str = "", research_id: str = "",
                       source: str = "") -> dict:
        """Record an open question as a first-class gap node (`## Unknown`)."""
        slug = slugify(id or question)
        rel = f"{CONCEPT_DIR}/{slug}.md"
        if vault_store.exists(rel):
            return {"ok": True, "id": slug, "changed": False, "note": "already exists"}
        body = ["## What", "Open unknown — a question the graph cannot yet answer.", "## Unknown",
                "status: open", "", "Question:", question]
        if investigations:
            body.append("")
            body.append("Investigations:")
            body.extend(f"- {i}" for i in investigations)
        text = (
            f"---\nconcept: {slug}\ntype: {sector}\nlayer: open\ncreated: {self._today}\n"
            f"updated: {self._today}\nstatus: open\n---\n\n" + "\n".join(body) + "\n"
        )
        with vault_store.lock():
            vault_store.write(rel, text)
        _reindex()
        observability.emit("UNKNOWN_CREATED", knowledge_id=slug, source=source, task_id=task_id,
                           research_id=research_id, detail=question[:80])
        return {"ok": True, "id": slug, "path": rel, "changed": True}

    def resolve_unknown(self, unknown_id: str, *, answer: str = "", evidence: list[str] | None = None,
                        task_id: str = "", source: str = "") -> dict:
        """Promote an open unknown into a resolved knowledge node."""
        slug = slugify(unknown_id)
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return {"ok": False, "error": f"not found: {slug}"}
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            note.set_fm("status", "active")
            note.set_fm("updated", self._today)
            note.append_to_section("Unknown", f"RESOLVED {self._today}: {answer}")
            if evidence:
                note.append_to_section("Evidence", "\n".join(f"- {e}" for e in evidence))
            res = vault_store.write(node.path, note.render(), expect_hash=h)
        _reindex()
        observability.emit("UNKNOWN_RESOLVED", knowledge_id=slug, source=source, task_id=task_id, detail=answer[:80])
        return {"ok": True, "id": slug, "status": "active", "changed": res["changed"]}

    # ── maintenance ──────────────────────────────────────────────────────────
    def rebuild_index(self) -> dict:
        idx = ix.rebuild()
        observability.emit("INDEX_REBUILT", detail=f"{len(idx.nodes)} nodes / {len(idx.edges)} edges")
        return ix.stats(idx)

    def validate_graph(self) -> dict:
        """The health report the spec §20 asks for — all numbers from the vault."""
        idx = ix.get()
        broken: list[dict] = []
        orphans: list[str] = []
        missing_sources: list[str] = []
        conflicts: list[str] = []
        unknowns: list[str] = []
        unverified = 0
        superseded = 0
        for slug, node in idx.nodes.items():
            if node.degree == 0:
                orphans.append(slug)
            if node.sources == 0 and node.kind == "concept" and node.status != "open":
                missing_sources.append(slug)
            if node.status == "superseded" or node.superseded_by:
                superseded += 1
            if not node.verified_at:
                unverified += 1
            if _note_has_section(node.path, "Conflict"):
                conflicts.append(slug)
            if node.status == "open":
                unknowns.append(slug)
        for e in idx.dangling:
            broken.append({"source": e.source, "target": e.target})
        return {
            "nodes": len(idx.nodes),
            "relationships": len(idx.edges),
            "unverified": unverified,
            "verified": len(idx.nodes) - unverified,
            "conflicts": len(conflicts),
            "conflict_nodes": sorted(conflicts),
            "open_unknowns": len(unknowns),
            "unknown_nodes": sorted(unknowns),
            "broken_links": len(broken),
            "broken": broken[:50],
            "orphan_nodes": len(orphans),
            "orphans": sorted(orphans)[:50],
            "missing_sources": len(missing_sources),
            "missing_sources_nodes": sorted(missing_sources)[:50],
            "superseded": superseded,
            "dangling_index": len(idx.dangling),
        }

    def index_stats(self) -> dict:
        return ix.stats()

    # ── internals ────────────────────────────────────────────────────────────
    def _create_new(self, cand: lifecycle.Candidate, sources: list[str], evidence: list[str],
                    kind: str, relation_hint: str | None, **ctx) -> dict:
        slug = cand.slug()
        rel = f"{PROJECT_DIR if kind == 'project' else CONCEPT_DIR}/{slug}.md"
        sources = sources or ([f"user-paste {self._today}"] if not evidence else sources)
        builds_on = [f"[[{relation_hint}]] — related concept"] if relation_hint else None
        text = render_new_concept(
            slug=slug, type_=cand.type or "system", layer=cand.layer or "cross-cutting",
            created=self._today, updated=self._today, sources=sources, status="active",
            what=cand.text.strip() or "(pending)", why=cand.text.strip() or "(pending)",
            builds_on=builds_on, evidence=evidence or None,
        )
        with vault_store.lock():
            vault_store.write(rel, text)
        _reindex()
        observability.emit("KNOWLEDGE_CREATED", knowledge_id=slug, detail=f"kind {kind}", **ctx)
        if relation_hint:
            self.add_relation(slug, "related", relation_hint, task_id=ctx.get("task_id", ""), source_ref=ctx.get("source", ""))
        return {"id": slug, "path": rel}

    def _enrich(self, slug: str, text: str, sources: list[str], evidence: list[str], **ctx) -> dict:
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return {"action": "ERROR", "error": f"not found: {slug}"}
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            before = note.render()
            if text.strip():
                note.append_to_section("Notes", f"Update ({self._today}): {text.strip()}")
            for s in sources:
                note.append_fm_item("sources", s)
            if evidence:
                note.append_to_section("Evidence", "\n".join(f"- {e}" for e in evidence))
            note.set_fm("updated", self._today)
            after = note.render()
            if after == before:
                return {"action": "UPDATE", "id": slug, "changed": False}
            res = vault_store.write(node.path, after, expect_hash=h)
        _reindex()
        observability.emit("KNOWLEDGE_UPDATED", knowledge_id=slug, detail=f"{len(sources)} source(s)", **ctx)
        return {"action": "UPDATE", "id": slug, "changed": res["changed"]}

    def _record_conflict(self, target: str, text: str, sources: list[str], evidence: list[str], **ctx) -> dict:
        idx = ix.get()
        node = idx.node(target)
        if node is None:
            return {"action": "ERROR", "error": f"not found: {target}"}
        block = [
            "Status: UNRESOLVED",
            f"Observed: {self._today}",
            "",
            "Claim that conflicts with this note:",
            text.strip() or "(unspecified)",
        ]
        if evidence:
            block.append("")
            block.append("Evidence:")
            block.extend(f"- {e}" for e in evidence)
        if sources:
            block.append("")
            block.append("Sources: " + ", ".join(sources))
        with vault_store.lock():
            note, h = vault_store.read(node.path)
            note.append_to_section("Conflict", "\n".join(block))
            note.set_fm("updated", self._today)
            res = vault_store.write(node.path, note.render(), expect_hash=h)
        _reindex()
        observability.emit("KNOWLEDGE_CONFLICT", knowledge_id=target, detail=text[:80], **ctx)
        return {"action": "CONFLICT", "id": target, "status": "UNRESOLVED", "changed": res["changed"]}

    def _append_link(self, slug: str, section: str, target: str, line: str) -> None:
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return
        note, h = vault_store.read(node.path)
        if note.has_link_in_section(section, target):
            return
        note.append_to_section(section, line)
        note.set_fm("updated", self._today)
        vault_store.write(node.path, note.render(), expect_hash=h)

    def _remove_link(self, slug: str, target: str) -> int:
        idx = ix.get()
        node = idx.node(slug)
        if node is None:
            return 0
        note, h = vault_store.read(node.path)
        n = note.remove_link_everywhere(target)
        if n:
            note.set_fm("updated", self._today)
            vault_store.write(node.path, note.render(), expect_hash=h)
        return n


def _as_candidate(candidate) -> lifecycle.Candidate:
    if isinstance(candidate, lifecycle.Candidate):
        return candidate
    if isinstance(candidate, str):
        return lifecycle.Candidate(title=candidate, text=candidate)
    if isinstance(candidate, dict):
        return lifecycle.Candidate(
            title=str(candidate.get("title", candidate.get("id", ""))),
            text=str(candidate.get("text", "")),
            id=str(candidate.get("id", "")),
            layer=str(candidate.get("layer", "")),
            type=str(candidate.get("type", "")),
            contradicts=list(candidate.get("contradicts", []) or []),
            supersedes=list(candidate.get("supersedes", []) or []),
        )
    raise TypeError(f"cannot use {type(candidate)} as a candidate")


def _note_has_section(rel: str, section: str) -> str:
    try:
        raw = vault_store._read_path(rel, must_exist=False).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    note = Note(path=rel, raw=raw)
    s = note.section(section)
    return s.content().strip() if s else ""


# An unknown note's `## Unknown` body is written as:
#     status: open
#
#     Question:
#     <the question, possibly several lines>
#
#     Investigations:
#     - research:<run_id>
def _parse_unknown_section(body: str) -> tuple[str, list[str]]:
    """Pull the question text and the investigation pointers out of an `## Unknown`
    section body, so callers get the real question rather than the raw scaffolding."""
    lines = body.splitlines()
    question_lines: list[str] = []
    investigations: list[str] = []
    mode: str | None = None
    for line in lines:
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("question:"):
            mode = "q"
            tail = stripped.split(":", 1)[1].strip()
            if tail:
                question_lines.append(tail)
            continue
        if low.startswith("investigations:"):
            mode = "inv"
            continue
        if mode == "inv":
            if stripped.startswith("- "):
                investigations.append(stripped[2:].strip())
            continue
        if mode == "q" and stripped:
            question_lines.append(stripped)
    question = " ".join(question_lines).strip()
    return question, investigations


_default: KnowledgeManager | None = None


def default_manager() -> KnowledgeManager:
    global _default
    if _default is None:
        _default = KnowledgeManager()
    return _default
