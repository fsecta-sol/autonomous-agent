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
from .config import subagent_timeout_s
from .llm import build_model
from .mcp import load_mcp_tools
from .middleware import tool_upstream_retry_middleware, upstream_retry_middleware
from .models import RunRequest
from .sse import run_envelopes
from .store import get_store
from .tools import build_tools
from .tools.batch import make_batch_tool
from .tools.spawn import SpawnBudget, make_spawn_tool

log = logging.getLogger("agent.graph")

# LangGraph counts node steps, not tool rounds. The old Node engine capped tool
# rounds at 4; after the move to LangGraph we let the framework's own limit
# govern and expose it as an env knob (pragmatic parity).
DEFAULT_RECURSION_LIMIT = int(os.environ.get("AGENT_RECURSION_LIMIT", "25"))

# Retry knobs. A flaky OpenAI-compatible endpoint (or an RPC/MCP tool) is the
# common failure; retrying a few times recovers most transient errors without
# failing the whole run. Applied as agents-v1 middleware, not node policies.
RETRY_MAX = int(os.environ.get("AGENT_RETRY_MAX", "2"))

# Result caching is OFF by default: the model node's cache key is a hash of its
# input messages, so two different sessions whose first turns are identical
# ("hi") would collide and the second would replay the first's cached answer.
# Enable it only when the deployment accepts that (e.g. a single-agent, single-
# user setup where identical inputs are genuinely a repeat).
CACHE_ENABLED = os.environ.get("AGENT_CACHE") == "1"

# The orchestrator's delegation tools. Present only when the run asks for them.
SPAWN_TOOL = "spawn_subagent"
BATCH_TOOL = "batch_research"

# Optional Context-Manager step: before the run, retrieve the knowledge-graph
# nodes relevant to the user's task and inject them into the system prompt, so
# the model starts grounded in accumulated knowledge (retaining source,
# confidence, verification status, relations). Off by default — the agent can
# always call `knowledge_relevant` itself; this just front-loads it.
PRECONTEXT_ENABLED = os.environ.get("AGENT_KNOWLEDGE_PRECONTEXT") == "1"
PRECONTEXT_LIMIT = int(os.environ.get("AGENT_KNOWLEDGE_PRECONTEXT_LIMIT", "6"))

# Tools a sub-agent must NOT receive: the delegation tools themselves (no
# recursion) and `run_command` (its approval interrupt needs an operator-facing
# thread, which a headless sub-agent has no way to satisfy).
SUBAGENT_EXCLUDED = {SPAWN_TOOL, BATCH_TOOL, "run_command"}


def _retry_middleware() -> list:
    """Retry middleware for a run's model and tool calls. See RETRY_MAX.

    Transient-only, raising on exhausted retries (`upstream_*_middleware`): the
    langchain defaults retry *any* exception and swallow failures into a normal
    reply/tool result, so a permanent upstream error would render as a healthy
    assistant message. That is the bug this wiring fixes."""
    if RETRY_MAX <= 0:
        return []
    return [
        upstream_retry_middleware(max_retries=RETRY_MAX),
        tool_upstream_retry_middleware(max_retries=RETRY_MAX),
    ]


def _cache():
    """The graph's result cache, or None (off by default — see CACHE_ENABLED)."""
    if not CACHE_ENABLED:
        return None
    from langgraph.cache.memory import InMemoryCache

    return InMemoryCache()



async def _collect_tools(req: RunRequest) -> tuple[list[BaseTool], list[str]]:
    """Assemble the orchestrator's tools, and the (narrower) sub-agent tool set.

    Returns (orchestrator_tools, warnings); the sub-agent set is stashed on the
    spawn tool's budget when the run enables delegation.
    """
    base = build_tools(
        req.tools, req.terminalMode, req.allowUnsandboxed, req.agentId, req.permissionMode
    )
    mcp_tools, warnings = await load_mcp_tools(req.mcp)
    all_tools = [*base, *mcp_tools]

    tools = list(all_tools)
    if SPAWN_TOOL in req.tools or BATCH_TOOL in req.tools:
        subagent_tools = [t for t in all_tools if getattr(t, "name", "") not in SUBAGENT_EXCLUDED]
    if SPAWN_TOOL in req.tools:
        tools.append(make_spawn_tool(req, subagent_tools, SpawnBudget()))
    if BATCH_TOOL in req.tools:
        tools.append(make_batch_tool(req, subagent_tools, subagent_timeout_s()))
    return tools, warnings


def _history_messages(req: RunRequest) -> list:
    """The transcript as LangChain messages (the system prompt is passed to
    `create_agent(system_prompt=...)`, so it is not included here)."""
    messages: list = []
    for turn in req.history:
        messages.append(HumanMessage(content=turn.content) if turn.role == "user" else AIMessage(content=turn.content))
    return messages


def _knowledge_precontext(req: RunRequest) -> str:
    """The retrieved-knowledge block for this task, or "" when disabled/empty.

    Uses the last user turn as the retrieval query and returns the Manager's
    rendered context (node + source + confidence + verification + relations),
    which the caller appends to the system prompt. Best-effort: any failure
    (empty vault, import error) simply yields no block, never breaking the run.
    """
    if not PRECONTEXT_ENABLED:
        return ""
    last_user = next((t.content for t in reversed(req.history) if t.role == "user"), "")
    if not last_user.strip():
        return ""
    try:
        from .knowledge.manager import default_manager

        result = default_manager().get_relevant(last_user, {"limit": PRECONTEXT_LIMIT})
        return result.get("rendered", "") if result.get("count") else ""
    except Exception:
        log.exception("knowledge pre-context failed")
        return ""


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

        system = req.system
        precontext = _knowledge_precontext(req)
        if precontext:
            system = f"{system}\n\n{precontext}"

        agent = create_agent(
            model=build_model(req),
            tools=tools,
            system_prompt=system,
            checkpointer=get_checkpointer(),
            store=get_store(),
            middleware=_retry_middleware(),
            cache=_cache(),
        )
        # A session is a durable thread; with no session id the run is ephemeral.
        thread_id = req.sessionId or f"ephemeral-{uuid.uuid4()}"
        config: RunnableConfig = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": DEFAULT_RECURSION_LIMIT,
        }
        graph_input = await _run_input(agent, req, config)
        async for envelope in run_envelopes(agent, graph_input, config, req.permissionMode):
            yield envelope
    except Exception as err:
        log.exception("run failed")
        yield {"type": "error", "message": str(err)}
    yield {"type": "done"}
