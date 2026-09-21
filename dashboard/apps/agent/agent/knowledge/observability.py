"""Append-only JSONL log of knowledge operations.

Every lifecycle action writes one line here, so "which agent execution changed
this Markdown knowledge node?" is answerable after the fact. The fields mirror
the spec: operation, knowledge_id, task_id, research_id, execution_id,
timestamp, source. This is derived telemetry — losing the file costs nothing
(the Markdown still holds the knowledge), so writes are best-effort.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

from ..config import knowledge_log_path

_LOCK = threading.Lock()

# The vocabulary of operations the spec enumerates.
OPERATIONS = frozenset(
    {
        "KNOWLEDGE_CREATED",
        "KNOWLEDGE_UPDATED",
        "KNOWLEDGE_DUPLICATE",
        "KNOWLEDGE_CONFLICT",
        "KNOWLEDGE_SUPERSEDED",
        "KNOWLEDGE_VERIFIED",
        "KNOWLEDGE_ARCHIVED",
        "UNKNOWN_CREATED",
        "UNKNOWN_RESOLVED",
        "RELATION_CREATED",
        "RELATION_REMOVED",
        "EVIDENCE_ADDED",
        "INDEX_UPDATED",
        "INDEX_REBUILT",
    }
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def emit(
    operation: str,
    *,
    knowledge_id: str = "",
    task_id: str = "",
    research_id: str = "",
    execution_id: str = "",
    source: str = "",
    detail: str = "",
) -> dict:
    """Append one event. Returns the record (also handy for tests)."""
    rec = {
        "timestamp": now_iso(),
        "operation": operation,
        "knowledge_id": knowledge_id,
        "task_id": task_id,
        "research_id": research_id,
        "execution_id": execution_id,
        "source": source,
    }
    if detail:
        rec["detail"] = detail
    try:
        path = knowledge_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(rec, ensure_ascii=False)
        with _LOCK, open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # telemetry is best-effort; never fail a knowledge op over a log write
    return rec


def tail(limit: int = 50) -> list[dict]:
    """The most recent events, newest last (for a CLI/health view)."""
    path = knowledge_log_path()
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for line in lines[-max(1, limit):]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out
