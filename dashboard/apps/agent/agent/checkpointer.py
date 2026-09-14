"""The process-wide LangGraph checkpointer.

One `aiosqlite` connection + `AsyncSqliteSaver`, opened at startup and shared by
every run. This is what makes a thread (one chat session) durable: a run that
pauses for approval — or the service restarting mid-run — leaves state on disk
that the next `/run` on the same `thread_id` resumes from.
"""

import logging

import aiosqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from .config import checkpoint_db_path

log = logging.getLogger("agent.checkpointer")

_conn: aiosqlite.Connection | None = None
_saver: AsyncSqliteSaver | None = None


async def init_checkpointer() -> AsyncSqliteSaver:
    """Open the checkpoint DB and ensure its schema. Idempotent."""
    global _conn, _saver
    if _saver is not None:
        return _saver
    path = checkpoint_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(str(path))
    saver = AsyncSqliteSaver(_conn)
    await saver.setup()
    _saver = saver
    log.info("checkpoint store ready at %s", path)
    return saver


async def close_checkpointer() -> None:
    global _conn, _saver
    if _conn is not None:
        await _conn.close()
    _conn = None
    _saver = None


def get_checkpointer() -> AsyncSqliteSaver:
    if _saver is None:
        raise RuntimeError("checkpointer not initialized")
    return _saver
