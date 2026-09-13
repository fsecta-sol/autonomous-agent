"""Read-only access to the operator's notes vault. Port of the TS vault.ts.

The vault is the system of record, so nothing here writes. Every path goes
through `resolve_vault_path`, which refuses anything that escapes the root."""

from pathlib import Path

from langchain_core.tools import tool

from .builtin import dumps
from .vault_index import links, list_docs, search
from .vault_path import MAX_FILE_BYTES, VaultPathError, resolve_vault_path


@tool
def vault_search(query: str, limit: int = 8) -> str:
    """Search the operator's notes vault. Returns the best-matching notes ranked
    by relevance, each with its path, title, frontmatter (concept/layer/type/status)
    and a text snippet. Quote a phrase ("exact words") to require it verbatim. Use
    this before answering questions about concepts, projects, or research the vault
    tracks."""
    q = query.strip()
    if not q:
        return dumps({"error": "query is required"})
    n = min(limit, 25) if isinstance(limit, int) and limit > 0 else 8
    return dumps({"query": q, "matches": search(q, n)})


@tool
def vault_read(path: str) -> str:
    """Read one note from the operator's vault by its vault-relative path (as
    returned by vault_search or vault_list). Returns the note's full text."""
    rel = path or ""
    if not rel.strip():
        return dumps({"error": "path is required"})
    try:
        abs_path = resolve_vault_path(rel)
    except VaultPathError as err:
        return dumps({"error": str(err)})
    try:
        raw = Path(abs_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return dumps({"error": "could not read that file"})
    truncated = len(raw) > MAX_FILE_BYTES
    text = raw[:MAX_FILE_BYTES] if truncated else raw
    return dumps({"path": rel, "truncated": truncated, "text": text})


@tool
def vault_list(folder: str = "") -> str:
    """List notes in the operator's vault, optionally restricted to a folder
    prefix. Returns vault-relative paths and sizes. Use it to survey what a
    folder contains."""
    files = list_docs(folder or None)
    cap = 200
    return dumps({"count": len(files), "files": files[:cap], "truncated": len(files) > cap})


@tool
def vault_links(path: str) -> str:
    """Given a note's vault-relative path, return the notes it links to (outgoing
    [[wikilinks]]) and the notes that link back to it (incoming). Use it to walk
    the knowledge graph from a note."""
    rel = path or ""
    if not rel.strip():
        return dumps({"error": "path is required"})
    try:
        result = links(rel)
    except (KeyError, OSError) as err:
        return dumps({"error": str(err) or "could not read that note"})
    return dumps({"path": rel, **result})
