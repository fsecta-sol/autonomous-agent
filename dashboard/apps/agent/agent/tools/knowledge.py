"""Agent-facing tools over the KnowledgeManager.

Thin wrappers: the intelligence lives in `agent.knowledge`. These exist so the
model can read from and, when enabled, write to the Markdown knowledge graph as
part of a run. The write tools follow the same opt-in convention as the memory
tools — off unless an agent enables them — because they change the operator's
persistent notes.

Read (safe, on by default elsewhere): knowledge_get, knowledge_relevant.
Write (opt-in): knowledge_upsert, knowledge_relate, knowledge_record,
knowledge_supersede, knowledge_health.
"""

from __future__ import annotations

from langchain_core.tools import BaseTool, tool

from .builtin import dumps


def _km():
    """The KnowledgeManager, imported lazily.

    `agent.tools` is imported (for its package __init__) while `agent.knowledge`
    is still initialising — the knowledge package reuses `tools.vault_index` for
    BM25. Importing the manager at module top would close that cycle; doing it on
    call keeps the dependency one-directional at import time.
    """
    from ..knowledge.manager import default_manager

    return default_manager()


# ── read ─────────────────────────────────────────────────────────────────────


@tool
def knowledge_get(knowledge_id: str, with_body: bool = False) -> str:
    """Read one node from the knowledge graph by its ID/slug (e.g. "mev").
    Returns its metadata and relations; set with_body=true to include the full
    note text. Use it to inspect what the graph already knows about a topic."""
    node = _km().get(knowledge_id, with_body=with_body)
    if node is None:
        return dumps({"found": False, "id": knowledge_id})
    return dumps({"found": True, **node})


@tool
def knowledge_relevant(context: str, limit: int = 6) -> str:
    """Retrieve the knowledge-graph nodes relevant to a task, with their source,
    confidence, verification status, relations and last-updated time. Call this
    BEFORE researching a topic so you reuse what the graph already knows instead
    of rediscovering it."""
    n = min(limit, 20) if isinstance(limit, int) and limit > 0 else 6
    result = _km().get_relevant(context, {"limit": n})
    return dumps({"count": result["count"], "nodes": result["nodes"], "context": result["rendered"]})


# ── write (opt-in) ───────────────────────────────────────────────────────────


@tool
def knowledge_upsert(
    title: str,
    text: str,
    layer: str = "",
    type: str = "",
    sources: list[str] | None = None,
    evidence: list[str] | None = None,
) -> str:
    """Integrate a durable fact into the knowledge graph — the full lifecycle in
    one call. The manager decides whether it is new, an enrichment, a duplicate,
    or a conflict, then updates the right Markdown note (never blindly appending).
    Provide `sources` (URLs) and, when applicable, `evidence`."""
    return dumps(
        _km().create_knowledge(
            title=title, text=text, layer=layer, type=type,
            sources=sources or [], evidence=evidence or [], source="agent",
        )
    )


@tool
def knowledge_relate(source: str, relation: str, target: str, note: str = "") -> str:
    """Add a typed relationship between two nodes and its reciprocal. `relation`
    is one of: builds-on, enables, related, depends_on, part_of, caused_by,
    implements, supports, contradicts, supersedes, derived_from."""
    return dumps(_km().add_relation(source, relation, target, note=note, source_ref="agent"))


@tool
def knowledge_record(
    kind: str,
    knowledge_id: str,
    detail: str = "",
    evidence: list[str] | None = None,
) -> str:
    """Record a lifecycle event on a node. `kind` is one of:
      evidence  — attach an evidence/provenance trail to the node
      verify    — mark the node verified now (sets confidence high)
      conflict  — record a contradiction against the node (does not overwrite it)
      unknown   — open a knowledge gap (question in `detail`)
      resolve   — resolve an open unknown (answer in `detail`)
    """
    km = _km()
    ev = evidence or []
    if kind == "evidence":
        return dumps(km.add_evidence(knowledge_id, ev, source="agent"))
    if kind == "verify":
        return dumps(km.verify(knowledge_id, ev, source="agent"))
    if kind == "conflict":
        return dumps(km.create_knowledge(title=knowledge_id, text=detail, contradicts=[knowledge_id], evidence=ev, source="agent"))
    if kind == "unknown":
        return dumps(km.create_unknown(question=detail or knowledge_id, id=knowledge_id, investigations=ev, source="agent"))
    if kind == "resolve":
        return dumps(km.resolve_unknown(knowledge_id, answer=detail, evidence=ev, source="agent"))
    return dumps({"ok": False, "error": f"unknown kind: {kind}"})


@tool
def knowledge_supersede(old_id: str, new_id: str) -> str:
    """Mark a node superseded by a newer one, preserving the old note for history
    (status: superseded, superseded_by: [[new_id]])."""
    return dumps(_km().supersede(old_id, new_id, source="agent"))


@tool
def knowledge_health() -> str:
    """Report the knowledge graph's health: node/relationship counts, unverified
    and verified notes, conflicts, open unknowns, broken links and orphans."""
    return dumps(_km().validate_graph())


READ_TOOLS: dict[str, BaseTool] = {
    "knowledge_get": knowledge_get,
    "knowledge_relevant": knowledge_relevant,
    "knowledge_health": knowledge_health,
}

WRITE_TOOLS: dict[str, BaseTool] = {
    "knowledge_upsert": knowledge_upsert,
    "knowledge_relate": knowledge_relate,
    "knowledge_record": knowledge_record,
    "knowledge_supersede": knowledge_supersede,
}

KNOWLEDGE_TOOLS: dict[str, BaseTool] = {**READ_TOOLS, **WRITE_TOOLS}
