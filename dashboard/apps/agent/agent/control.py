"""Control-plane operations on a thread's checkpoint history — time travel.

Two things the run graph can't expose directly, because each `/run` builds a
throwaway graph: listing a thread's saved checkpoints, and forking a thread back
to a past one ("rewind"). Both only touch the checkpointer, so they need no
model — a minimal `messages`-only graph sharing the same saver is enough, and its
channel schema is a subset of the run agent's `AgentState`.
"""

import logging
from typing import Annotated, Any, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .checkpointer import get_checkpointer

log = logging.getLogger("agent.control")

# How many characters of a message to preview in history listings.
_PREVIEW_CHARS = 160

# The control graph's single node. Its writer never runs a value in a rewind, so
# its name only matters as the `as_node` we pass to `aupdate_state`.
_NOOP_NODE = "noop"


class ControlState(TypedDict):
    """The run agent's persisted channel, and nothing else."""

    messages: Annotated[list, add_messages]


_compiled: Any = None


def _control_graph():
    """A one-node graph sharing the process checkpointer, compiled once. It never
    runs a node — it exists only so `aget_state_history` / `aupdate_state` have a
    graph to operate through."""
    global _compiled
    if _compiled is None:
        graph = StateGraph(ControlState)
        graph.add_node(_NOOP_NODE, lambda _state: {})
        graph.add_edge(START, _NOOP_NODE)
        graph.add_edge(_NOOP_NODE, END)
        _compiled = graph.compile(checkpointer=get_checkpointer())
    return _compiled


def _preview(message: BaseMessage) -> str:
    content = message.content
    if isinstance(content, list):
        content = "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    text = str(content or "").strip().replace("\n", " ")
    return text[:_PREVIEW_CHARS] + ("…" if len(text) > _PREVIEW_CHARS else "")


def _summarize(tuple_: Any) -> dict[str, Any]:
    """One history entry: its checkpoint id, the step it represents, and a preview
    of the last message in that state (so the UI can list steps meaningfully)."""
    messages = (tuple_.values or {}).get("messages", []) or []
    last = messages[-1] if messages else None
    return {
        "checkpointId": (tuple_.config or {}).get("configurable", {}).get("checkpoint_id"),
        "step": (tuple_.metadata or {}).get("step"),
        "messageCount": len(messages),
        "lastRole": getattr(last, "type", None),
        "preview": _preview(last) if last is not None else "",
    }


async def list_history(thread_id: str, limit: int = 50) -> list[dict[str, Any]]:
    """The thread's checkpoints, newest first."""
    app = _control_graph()
    config = {"configurable": {"thread_id": thread_id}}
    out: list[dict[str, Any]] = []
    async for tuple_ in app.aget_state_history(config, limit=limit):
        out.append(_summarize(tuple_))
    return out


async def rewind_to(thread_id: str, checkpoint_id: str) -> dict[str, Any]:
    """Fork the thread so its head is the given past checkpoint. Messages after it
    are dropped; the next run continues from there. `checkpoint_id` must be one of
    this thread's own checkpoints (else no-op with ok=False)."""
    app = _control_graph()
    base = {"configurable": {"thread_id": thread_id}}
    target = None
    async for tuple_ in app.aget_state_history(base):
        if (tuple_.config or {}).get("configurable", {}).get("checkpoint_id") == checkpoint_id:
            target = tuple_
            break
    if target is None:
        return {"ok": False, "error": "checkpoint not found for this thread"}

    # values=None forks the chain to `target` without changing its state. as_node
    # is required: the thread was written by the run agent (its `model`/`tools`
    # nodes), which don't exist in this control graph, so LangGraph can't infer
    # the writer. Our noop node writes nothing, so the fork is a pure truncation.
    await app.aupdate_state(target.config, None, as_node=_NOOP_NODE)
    head = await app.aget_state(base)
    return {"ok": True, "messageCount": len((head.values or {}).get("messages", []) or [])}
