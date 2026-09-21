"""Run one sub-agent headless and return its final text.

A sub-agent is the orchestrator's way to delegate a slice of work: it is a fresh
LangGraph agent with the run's LLM, a role-shaped system prompt, and the same
tool set (minus `spawn_subagent`, so it cannot recurse). It runs to completion
with no browser stream — the orchestrator only sees the returned text.
"""

import asyncio
import json
import logging
from contextlib import suppress

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool

from .config import subagent_recursion_limit, subagent_retry_attempts
from .llm import build_model
from .middleware import upstream_retry_middleware
from .models import RunRequest
from .store import get_store

log = logging.getLogger("agent.subagent")

# The sub-agent gets a bounded tool budget of its own; it is meant to answer a
# focused goal, not run an open-ended loop. Tunable via AGENT_SUBAGENT_RECURSION_LIMIT
# so a deep-research sub-agent on a long-horizon run gets more tool rounds.
SUBAGENT_RECURSION_LIMIT = subagent_recursion_limit()

# Cap on how much of one tool result the durable trace keeps — a checkpoint of a
# long read is still legible without persisting megabytes.
_TRACE_TEXT_CAP = 600


def _text_of(message: AIMessage) -> str:
    """An assistant message's text, whatever content shape it uses."""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _final_text(result: dict) -> str:
    """The sub-agent's last assistant message, as plain text."""
    for message in reversed(result.get("messages", [])):
        if isinstance(message, AIMessage):
            text = _text_of(message).strip()
            if text:
                return text
    return "(the sub-agent produced no text)"


async def _drive_with_idle_timeout(
    agent, goal: str, *, idle_timeout_s: float
) -> tuple[dict | None, bool]:
    """Drive `agent` to completion under an *idle* timeout.

    The deadline resets on every streamed event, so a sub-agent that keeps making
    progress — streaming a long answer, a slow-but-returning fetch — may run far
    longer than `idle_timeout_s` in total; only a genuine stall (no event for that
    long: the upstream went dark, or a tool hung) trips it. A wall-clock cap is
    deliberately NOT used: a deep-research sub-agent legitimately works for many
    minutes, and a hard cap discarded that work wholesale (returned empty). Here a
    timeout returns the last completed super-step's state so the caller harvests
    partial work instead of losing it. Returns `(last_state_or_None, timed_out)`.
    """
    holder: dict = {"state": None, "error": None}
    queue: asyncio.Queue = asyncio.Queue()
    sentinel = object()

    async def consume() -> None:
        try:
            async for item in agent.astream(
                {"messages": [HumanMessage(content=goal)]},
                config={"recursion_limit": SUBAGENT_RECURSION_LIMIT},
                # "values" flushes a completed super-step's state (what we harvest);
                # "messages" emits per token, so a long-but-live model call keeps
                # resetting the idle deadline instead of looking stalled.
                stream_mode=["values", "messages"],
            ):
                if item[0] == "values":
                    holder["state"] = item[1]
                queue.put_nowait(None)
        except BaseException as err:  # noqa: BLE001 — surfaced by the driver below
            holder["error"] = err
        finally:
            queue.put_nowait(sentinel)

    task = asyncio.create_task(consume())
    timed_out = False
    try:
        while True:
            try:
                token = await asyncio.wait_for(queue.get(), timeout=idle_timeout_s)
            except TimeoutError:
                timed_out = True
                break
            if token is sentinel:
                break
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
    # An error only propagates when the run actually finished; a timeout cancels
    # the task, whose CancelledError we deliberately do not re-raise.
    if not timed_out and holder["error"] is not None:
        raise holder["error"]
    return holder["state"], timed_out


async def run_subagent_messages(
    req: RunRequest,
    role: str,
    goal: str,
    tools: list[BaseTool],
    timeout_s: float,
) -> tuple[str, bool, list]:
    """Run a sub-agent to completion and keep its full message trail.

    `timeout_s` is an *idle* limit, not a wall-clock cap: the deadline resets on
    every streamed event, so a sub-agent that keeps producing output is never cut
    off no matter how long it totals, and only a genuine stall stops it. Returns
    `(text, idle_timed_out, messages)`; the messages are the partial trail on a
    stall (never empty when any super-step completed), so a caller that wants a
    durable trace (the Research Executor) keeps what the sub-agent did rather than
    losing the whole iteration.
    """
    prompt = (
        f"You are \"{role}\", a focused sub-agent working on one delegated goal inside a larger "
        f"research task. Do the work yourself using your tools; do not ask for clarification. "
        f"Return a concise, self-contained result the orchestrator can use directly.\n\nGoal: {goal}"
    )
    agent = create_agent(
        model=build_model(req),
        tools=tools,
        system_prompt=prompt,
        store=get_store(),
        # Retry transient upstream failures (503/429/connection drops) here too —
        # the orchestrator graph has its own retry middleware, but a headless
        # sub-agent did not, so one 503 upstream failed a whole research iteration.
        middleware=[upstream_retry_middleware(max_retries=subagent_retry_attempts())],
    )
    try:
        state, timed_out = await _drive_with_idle_timeout(agent, goal, idle_timeout_s=timeout_s)
    except Exception as err:
        # A real failure (a permanent upstream error, or a transient one whose
        # retry budget was exhausted). Reported with timed_out=False so the caller
        # does not mislabel it as a stall.
        log.exception("sub-agent %s failed", role)
        return (f"The sub-agent \"{role}\" failed: {err}", False, [])

    messages = list((state or {}).get("messages", []))
    if timed_out:
        log.warning(
            "sub-agent %s stalled: no progress for %.0fs (harvested %d message(s))",
            role, timeout_s, len(messages),
        )
        text = (
            _final_text(state)
            if messages
            else f"The sub-agent \"{role}\" made no progress for {timeout_s:.0f}s and was stopped."
        )
        return (text, True, messages)
    return (_final_text(state or {}), False, messages)


def trace_from_messages(messages: list) -> list[dict]:
    """A compact, durable trace of a sub-agent run, in message order.

    One step per assistant turn (its `thought`, i.e. any text it emitted) and per
    tool result (`tool_result`), with the tool calls it decided to make recorded
    as `tool_call` steps. This is the sub-agent's observable activity — what it
    did and what came back — not its private chain-of-thought (models that expose
    reasoning expose it as content, which lands in `thought`).
    """
    steps: list[dict] = []
    for message in messages or []:
        if isinstance(message, AIMessage):
            text = _text_of(message).strip()
            if text:
                steps.append({"kind": "thought", "text": text[:_TRACE_TEXT_CAP]})
            for call in getattr(message, "tool_calls", None) or []:
                if not isinstance(call, dict):
                    continue
                args = call.get("args")
                steps.append(
                    {
                        "kind": "tool_call",
                        "name": str(call.get("name") or ""),
                        "args": json.dumps(args, ensure_ascii=False)[:_TRACE_TEXT_CAP] if args is not None else "",
                    }
                )
        elif isinstance(message, ToolMessage):
            steps.append(
                {
                    "kind": "tool_result",
                    "name": str(getattr(message, "name", "") or ""),
                    "text": str(message.content or "")[:_TRACE_TEXT_CAP],
                }
            )
    return steps


async def run_subagent(
    req: RunRequest,
    role: str,
    goal: str,
    tools: list[BaseTool],
    timeout_s: float,
) -> tuple[str, bool]:
    """Run a sub-agent to completion. Returns (text, timed_out)."""
    text, timed_out, _ = await run_subagent_messages(req, role, goal, tools, timeout_s)
    return (text, timed_out)
