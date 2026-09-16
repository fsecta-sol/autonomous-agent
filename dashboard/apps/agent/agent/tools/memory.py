"""Long-term memory tools — the agent's *cross-session* memory.

Unlike the checkpointer (which remembers one chat thread), these tools read and
write the process-wide `AsyncSqliteStore`, so a fact saved in one session is
available in the next. Namespaced per agent, so two agents keep separate memory.

Search is keyword-ranked in-process rather than vector-ranked: the run's LLM is
an arbitrary OpenAI-compatible endpoint with no guaranteed embeddings route, so a
semantic index can't be assumed. Ranking by token overlap works everywhere.
"""

import json
import uuid
from datetime import datetime, timezone

from langchain_core.tools import BaseTool, tool
from langgraph.config import get_store

# Newest-first page size for a namespace scan. Well above any realistic memory
# count per agent; ranking happens here, not in SQL.
_SCAN_LIMIT = 1000


def _namespace(agent_id: str) -> tuple[str, str]:
    return ("memory", agent_id or "default")


def _tokens(text: str) -> list[str]:
    return [t for t in "".join(c.lower() if c.isalnum() else " " for c in text).split() if t]


def _rank(items: list, query: str, limit: int) -> list:
    """Rank memories by how many distinct query tokens they contain (exact
    whole-phrase match breaks ties). No embeddings required."""
    q = _tokens(query)
    qset = set(q)
    phrase = query.strip().lower()
    scored: list[tuple[float, object]] = []
    for it in items:
        blob = (str(it.value.get("text", "")) + " " + " ".join(it.value.get("tags", []) or [])).lower()
        toks = set(_tokens(blob))
        overlap = len(qset & toks)
        if overlap == 0:
            continue
        score = overlap + (1.0 if phrase and phrase in blob else 0.0)
        scored.append((score, it))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [it for _score, it in scored[:limit]]


def make_memory_tools(agent_id: str) -> dict[str, BaseTool]:
    """Build the memory tools for one agent, scoped to its namespace."""
    ns = _namespace(agent_id)

    @tool
    async def memory_save(text: str, tags: list[str] | None = None) -> str:
        """Save a durable fact to long-term memory, remembered across future chats.

        Use this for things worth carrying forward: a conclusion you reached, a
        decision the operator made, a source you found reliable. Keep `text` a
        single self-contained statement.

        Args:
            text: The fact to remember, as one clear sentence or short paragraph.
            tags: Optional keywords to make the fact easier to find later.
        """
        store = get_store()
        key = uuid.uuid4().hex
        await store.aput(
            ns,
            key,
            {
                "text": text,
                "tags": tags or [],
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return json.dumps({"saved": True, "key": key}, ensure_ascii=False)

    @tool
    async def memory_search(query: str, limit: int = 5) -> str:
        """Search long-term memory for facts saved in this or earlier chats.

        Use this before starting research on a subject, to recall what was already
        established and avoid redoing work.

        Args:
            query: What to look for, in natural language or keywords.
            limit: Maximum number of memories to return.
        """
        store = get_store()
        items = await store.asearch(ns, limit=_SCAN_LIMIT)
        top = _rank(list(items), query, max(1, limit))
        return json.dumps(
            {
                "matches": [
                    {"key": it.key, "text": it.value.get("text", ""), "tags": it.value.get("tags", [])}
                    for it in top
                ]
            },
            ensure_ascii=False,
        )

    @tool
    async def memory_forget(key: str) -> str:
        """Delete one memory by its key (as returned by memory_save or memory_search)."""
        store = get_store()
        await store.adelete(ns, key)
        return json.dumps({"forgot": key}, ensure_ascii=False)

    return {"memory_save": memory_save, "memory_search": memory_search, "memory_forget": memory_forget}
