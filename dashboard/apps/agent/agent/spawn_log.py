"""A small event log of sub-agent spawns, keyed by orchestrator session.

The checkpoint records *that* a spawn happened (and its result), but not when —
and the visualization needs real per-spawn timestamps (start/finish, duration).
This log fills exactly that gap. A short-lived connection per call is fine: spawns
are infrequent.
"""

import logging
import time
import uuid
from pathlib import Path

import aiosqlite

from .config import spawn_log_db_path

log = logging.getLogger("agent.spawn_log")

_DDL = """
CREATE TABLE IF NOT EXISTS spawn_events (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  role        TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,            -- running | done | timed_out | error
  started_at  REAL NOT NULL,
  finished_at REAL,
  result      TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS spawn_thread_idx ON spawn_events(thread_id, started_at);
"""


async def _connect() -> aiosqlite.Connection:
    path: Path = spawn_log_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = await aiosqlite.connect(str(path))
    await conn.executescript(_DDL)
    return conn


async def record_start(thread_id: str, role: str, goal: str) -> str:
    """Log a spawn's beginning; returns its id (to pass to `record_end`)."""
    event_id = uuid.uuid4().hex
    conn = await _connect()
    try:
        await conn.execute(
            "INSERT INTO spawn_events (id, thread_id, role, goal, status, started_at) VALUES (?,?,?,?,?,?)",
            (event_id, thread_id, role, goal, "running", time.time()),
        )
        await conn.commit()
    finally:
        await conn.close()
    return event_id


async def record_end(event_id: str, status: str, result: str | None = None, error: str | None = None) -> None:
    """Log a spawn's completion (status: done | timed_out | error)."""
    conn = await _connect()
    try:
        await conn.execute(
            "UPDATE spawn_events SET status=?, finished_at=?, result=?, error=? WHERE id=?",
            (status, time.time(), result, error, event_id),
        )
        await conn.commit()
    finally:
        await conn.close()


async def list_spawns(thread_id: str) -> list[dict]:
    """Every spawn recorded for a session, oldest first."""
    conn = await _connect()
    try:
        conn.row_factory = aiosqlite.Row
        cursor = await conn.execute(
            "SELECT id, role, goal, status, started_at, finished_at, result, error "
            "FROM spawn_events WHERE thread_id=? ORDER BY started_at ASC",
            (thread_id,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await conn.close()
