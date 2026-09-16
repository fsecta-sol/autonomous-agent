"""The process-wide LangGraph long-term memory store.

One `aiosqlite` connection + `AsyncSqliteStore`, opened at startup and shared by
every run. This is the *cross-session* memory: unlike the checkpointer (which
remembers one thread), the store keeps facts that outlive a chat — a token the
operator once researched, a decision they made — under a namespace, and can rank
them by similarity.

It is bound to the agent via `create_agent(store=...)`, so any node or tool can
reach it with `langgraph.config.get_store()`.
"""

import logging

import aiosqlite
from langgraph.store.sqlite.aio import AsyncSqliteStore

from .config import store_db_path

log = logging.getLogger("agent.store")

_conn: aiosqlite.Connection | None = None
_store: AsyncSqliteStore | None = None


async def init_store() -> AsyncSqliteStore:
    """Open the memory DB and ensure its schema. Idempotent."""
    global _conn, _store
    if _store is not None:
        return _store
    path = store_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None (autocommit): AsyncSqliteStore issues its own BEGIN/
    # COMMIT, so a driver-level transaction would collide with it.
    _conn = await aiosqlite.connect(str(path), isolation_level=None)
    store = AsyncSqliteStore(_conn)
    await store.setup()
    _store = store
    log.info("long-term memory store ready at %s", path)
    return store


async def close_store() -> None:
    global _conn, _store
    if _conn is not None:
        await _conn.close()
    _conn = None
    _store = None


def get_store() -> AsyncSqliteStore:
    if _store is None:
        raise RuntimeError("store not initialized")
    return _store
