"""Knowledge Manager — a lifecycle/intelligence layer *around* the operator's
Markdown knowledge graph (the Obsidian vault).

The Markdown notes remain the canonical, portable store; this package never
replaces them with a database. It reads them, understands their structure
(frontmatter, sections, wikilink relationships), and writes them back with
minimal, atomic, backed-up edits so the graph can evolve as the agent researches.

Layering (no langchain imports here — the package is importable and testable on
its own, so the E2E demo runs without the full agent runtime):

    model         — parse / surgically edit one note
    vault_store   — the ONLY writer: atomic write, .bak, lock, optimistic check
    index         — derived node/edge index, rebuildable from Markdown alone
    retrieval     — hybrid search / get_relevant
    lifecycle     — candidate -> NEW | UPDATE | RELATED | CONFLICT | DUPLICATE
    manager       — the KnowledgeManager facade (the public API)
    observability — append-only KNOWLEDGE_* event log
"""

__all__ = ["KnowledgeManager", "default_manager"]


def __getattr__(name: str):
    # Lazy so submodules (model, vault_store, …) import without pulling the
    # whole facade in; keeps the package importable during incremental builds.
    if name in __all__:
        from . import manager

        return getattr(manager, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
