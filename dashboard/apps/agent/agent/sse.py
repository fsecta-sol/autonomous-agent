"""The SSE envelope protocol — identical to what the old Node chat-engine emitted,
so the browser's `lib/llm-stream.ts` and every component keep working unchanged.

Envelopes:
  {"type":"text","text":…}                       a streamed answer delta
  {"type":"reasoning","text":…}                  a streamed reasoning delta
  {"type":"tool","phase":"start","name":…,"args":{…}}
  {"type":"tool","phase":"end","name":…,"result":"…","error":bool}
  {"type":"warning","message":…}                 a non-fatal notice
  {"type":"error","message":…}
  {"type":"done"}
"""

import json
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage


def frame(obj: dict[str, Any]) -> bytes:
    """Encode one envelope as an SSE `data:` frame."""
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


def keepalive() -> bytes:
    """An SSE comment frame, emitted while the run is silent.

    An idle SSE stream is dropped by intermediaries (the backend's upstream
    `fetch` has an undici body timeout; the browser-facing path has a proxy
    timeout), so a long tool round or sub-agent run — during which we emit no
    envelope at all — would otherwise be cut. Clients read only `data:` lines,
    so this frame is invisible to them.
    """
    return b": keepalive\n\n"


def _text_from_content(content: Any) -> str:
    """Extract plain text from a message chunk's content, which may be a string
    or a list of content blocks (reasoning/tool-call blocks have no plaintext)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("text", "text_delta"):
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def _reasoning_from_chunk(chunk: Any) -> str:
    """Best-effort reasoning delta. Providers expose it in a sibling field of
    `additional_kwargs` (e.g. `reasoning_content`), or as a reasoning content
    block. Absent → empty (reasoning simply doesn't render)."""
    kwargs = getattr(chunk, "additional_kwargs", None) or {}
    for key in ("reasoning_content", "reasoning"):
        val = kwargs.get(key)
        if isinstance(val, str) and val:
            return val
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") in ("reasoning", "reasoning_delta")
        ]
        return "".join(parts)
    return ""


async def run_envelopes(agent: Any, graph_input: Any, config: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """Drive the LangGraph agent and yield our envelope dicts.

    Text comes only from the `messages` stream mode; tool start/end come only
    from `updates`, so nothing is double-emitted. Reasoning is best-effort. A
    pause for approval surfaces as an `interrupt` envelope, after which the
    stream ends (the run is checkpointed; a later call resumes it).
    """
    # tool_call_id → tool name, so a ToolMessage can report which tool finished.
    call_names: dict[str, str] = {}

    async for mode, data in agent.astream(graph_input, stream_mode=["messages", "updates"], config=config):
        if mode == "messages":
            chunk, _meta = data
            # Only the model's own output streams as text — the `messages` mode
            # also carries ToolMessage chunks, which belong to tool `end` events.
            # (AIMessageChunk subclasses AIMessage, so this covers streaming too.)
            if not isinstance(chunk, AIMessage):
                continue
            reasoning = _reasoning_from_chunk(chunk)
            if reasoning:
                yield {"type": "reasoning", "text": reasoning}
            text = _text_from_content(getattr(chunk, "content", ""))
            if text:
                yield {"type": "text", "text": text}
            continue

        # mode == "updates": {node_name: {"messages": [BaseMessage, …]}}, or
        # {"__interrupt__": (Interrupt(value=…, id=…),)} when a node pauses.
        if INTERRUPT_KEY in (data or {}):
            for intr in data[INTERRUPT_KEY]:
                yield _interrupt_envelope(intr)
            continue

        for update in (data or {}).values():
            for msg in (update or {}).get("messages", []) or []:
                tool_calls = getattr(msg, "tool_calls", None)
                if tool_calls:
                    for call in tool_calls:
                        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
                        call_id = call.get("id") if isinstance(call, dict) else getattr(call, "id", None)
                        args = call.get("args") if isinstance(call, dict) else getattr(call, "args", None)
                        if call_id and name:
                            call_names[call_id] = name
                        yield {
                            "type": "tool",
                            "phase": "start",
                            "name": name or "tool",
                            "args": args if isinstance(args, dict) else {},
                        }
                    continue

                call_id = getattr(msg, "tool_call_id", None)
                if call_id:
                    name = getattr(msg, "name", None) or call_names.get(call_id, "tool")
                    result = getattr(msg, "content", "")
                    if not isinstance(result, str):
                        result = json.dumps(result, ensure_ascii=False)
                    status = getattr(msg, "status", None)
                    is_error = status == "error" or result.strip().startswith('{"error"')
                    yield {
                        "type": "tool",
                        "phase": "end",
                        "name": name,
                        "result": result,
                        "error": is_error,
                    }


INTERRUPT_KEY = "__interrupt__"


def _interrupt_envelope(intr: Any) -> dict[str, Any]:
    """Translate a LangGraph Interrupt into our `interrupt` envelope. The value
    is whatever the tool passed to `interrupt()` (see tools/terminal.py)."""
    value = getattr(intr, "value", None)
    payload = value if isinstance(value, dict) else {"message": str(value)}
    return {
        "type": "interrupt",
        "id": getattr(intr, "id", None),
        "tool": payload.get("tool"),
        "args": payload.get("args", {}),
        "message": payload.get("message", "Approval required."),
    }
