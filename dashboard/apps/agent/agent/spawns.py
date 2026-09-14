"""Extract the spawn tree of an orchestrator thread from its checkpoint.

Sub-agent spawns live only in the LangGraph checkpoint (the backend's `messages`
table stores plain text). A spawn appears as an `AIMessage.tool_calls` entry
named `spawn_subagent`, whose matching `ToolMessage` carries the sub-agent's
result. This walks the thread's message log and pairs them.
"""

import json
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage

SPAWN_TOOL = "spawn_subagent"


def extract_spawns(messages: list[Any]) -> list[dict]:
    """Ordered spawns in a thread: {id, role, goal, result, timedOut, status}."""
    spawns: list[dict] = []
    by_call_id: dict[str, dict] = {}

    for message in messages:
        if isinstance(message, AIMessage):
            for call in getattr(message, "tool_calls", None) or []:
                name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
                if name != SPAWN_TOOL:
                    continue
                args = call.get("args") if isinstance(call, dict) else getattr(call, "args", None)
                args = args if isinstance(args, dict) else {}
                call_id = call.get("id") if isinstance(call, dict) else getattr(call, "id", None)
                entry = {
                    "id": call_id,
                    "role": str(args.get("role", "sub-agent")),
                    "goal": str(args.get("goal", "")),
                    "result": None,
                    "timedOut": False,
                    "status": "running",
                }
                spawns.append(entry)
                if call_id:
                    by_call_id[call_id] = entry

        elif isinstance(message, ToolMessage):
            entry = by_call_id.get(getattr(message, "tool_call_id", "") or "")
            if entry is None:
                continue
            content = message.content
            try:
                payload = json.loads(content) if isinstance(content, str) else content
            except (ValueError, TypeError):
                payload = None
            if isinstance(payload, dict) and "result" in payload:
                entry["result"] = payload.get("result")
                entry["timedOut"] = bool(payload.get("timedOut"))
                entry["role"] = str(payload.get("role", entry["role"]))
                entry["status"] = "timed_out" if entry["timedOut"] else "done"
            else:
                entry["result"] = content if isinstance(content, str) else json.dumps(content)
                entry["status"] = "done"

    # A spawn whose call never got a tool result is still "running".
    return spawns
