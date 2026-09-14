"""Build the LangGraph agent for one run and stream it out as our SSE envelopes.

Long-horizon wiring: the graph is compiled with a checkpointer, and each run is
addressed by a `thread_id` (the chat session). That gives us, for free, a
durable per-session memory and runs that survive a restart — plus the plumbing
for human-in-the-loop approval (see `tools/terminal.py`).
"""

import logging
import os
import uuid
from collections.abc import AsyncIterator

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.types import Command

from .checkpointer import get_checkpointer
from .llm import build_model
from .mcp import load_mcp_tools
from .models import RunRequest
from .sse import run_envelopes
from .tools import build_tools
from .tools.spawn import SpawnBudget, make_spawn_tool

log = logging.getLogger("agent.graph")

# LangGraph counts node steps, not tool rounds. The old Node engine capped tool
# rounds at 4; after the move to LangGraph we let the framework's own limit
# govern and expose it as an env knob (pragmatic parity).
DEFAULT_RECURSION_LIMIT = int(os.environ.get("AGENT_RECURSION_LIMIT", "25"))

# The orchestrator's delegation tool. Present only when the run asks for it.
SPAWN_TOOL = "spawn_subagent"

# Tools a sub-agent must NOT receive: `spawn_subagent` (no recursion) and
# `run_command` (its approval interrupt needs an operator-facing thread, which a
# headless sub-agent has no way to satisfy).
SUBAGENT_EXCLUDED = {SPAWN_TOOL, "run_command"}


async def _collect_tools(req: RunRequest) -> tuple[list[BaseTool], list[str]]:
    """Assemble the orchestrator's tools, and the (narrower) sub-agent tool set.

    Returns (orchestrator_tools, warnings); the sub-agent set is stashed on the
    spawn tool's budget when the run enables delegation.
    """
    base = build_tools(req.tools, req.terminalMode, req.allowUnsandboxed, req.agentId)
    mcp_tools, warnings = await load_mcp_tools(req.mcp)
    all_tools = [*base, *mcp_tools]

    tools = list(all_tools)
    if SPAWN_TOOL in req.tools:
        subagent_tools = [t for t in all_tools if getattr(t, "name", "") not in SUBAGENT_EXCLUDED]
        tools.append(make_spawn_tool(req, subagent_tools, SpawnBudget()))
    return tools, warnings


def _history_messages(req: RunRequest) -> list:
    """The transcript as LangChain messages (the system prompt is passed to
    `create_agent(system_prompt=...)`, so it is not included here)."""
    messages: list = []
    for turn in req.history:
        messages.append(HumanMessage(content=turn.content) if turn.role == "user" else AIMessage(content=turn.content))
    return messages


async def _run_input(agent, req: RunRequest, config: RunnableConfig):
    """Decide the graph input for this call.

    - A resume continues a paused thread from the operator's decision.
    - Otherwise, if the thread already has state, only the newest turn is fed
      (LangGraph appends it); a fresh thread is seeded with the whole transcript.
      The seed path is also the migration for sessions created before
      checkpointing existed.
    """
    if req.resume is not None:
        return Command(resume=req.resume.decision)

    history = _history_messages(req)
    if not history:
        return {"messages": []}

    snapshot = await agent.aget_state(config)
    has_state = bool(snapshot.values.get("messages"))
    return {"messages": history[-1:] if has_state else history}


async def stream_run(req: RunRequest) -> AsyncIterator[dict]:
    """Run one agent turn and yield our envelope dicts.

    Emits the backend's pre-run warnings first, then the agent's stream.
    """
    for warning in req.warnings:
        yield {"type": "warning", "message": warning}

    try:
        tools, tool_warnings = await _collect_tools(req)
        for warning in tool_warnings:
            yield {"type": "warning", "message": warning}

        agent = create_agent(
            model=build_model(req),
            tools=tools,
            system_prompt=req.system,
            checkpointer=get_checkpointer(),
        )
        # A session is a durable thread; with no session id the run is ephemeral.
        thread_id = req.sessionId or f"ephemeral-{uuid.uuid4()}"
        config: RunnableConfig = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": DEFAULT_RECURSION_LIMIT,
        }
        graph_input = await _run_input(agent, req, config)
        async for envelope in run_envelopes(agent, graph_input, config):
            yield envelope
    except Exception as err:
        log.exception("run failed")
        yield {"type": "error", "message": str(err)}
    yield {"type": "done"}
