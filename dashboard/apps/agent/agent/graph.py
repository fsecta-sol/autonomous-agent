"""Build the LangGraph agent for one run and stream it out as our SSE envelopes."""

import logging
import os
from collections.abc import AsyncIterator

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool
from langchain_openai import ChatOpenAI

from .mcp import load_mcp_tools
from .models import RunRequest
from .sse import run_envelopes
from .tools import build_tools

log = logging.getLogger("agent.graph")

# LangGraph counts node steps, not tool rounds. The old Node engine capped tool
# rounds at 4; after the move to LangGraph we let the framework's own limit
# govern and expose it as an env knob (pragmatic parity).
DEFAULT_RECURSION_LIMIT = int(os.environ.get("AGENT_RECURSION_LIMIT", "25"))


def _build_model(req: RunRequest) -> ChatOpenAI:
    """A chat model pointed at any OpenAI-compatible endpoint (per-agent creds)."""
    return ChatOpenAI(
        model=req.llm.model,
        base_url=req.llm.baseUrl,
        api_key=req.llm.apiKey,
        streaming=True,
        temperature=0,
    )


async def _collect_tools(req: RunRequest) -> tuple[list[BaseTool], list[str]]:
    builtins = build_tools(req.tools, req.terminalMode, req.allowUnsandboxed, req.agentId)
    mcp_tools, warnings = await load_mcp_tools(req.mcp)
    return [*builtins, *mcp_tools], warnings


def _build_messages(req: RunRequest) -> list:
    """History turns for the agent input. The system prompt is passed to
    `create_agent(system_prompt=...)`, so it is not repeated here."""
    messages: list = []
    for turn in req.history:
        messages.append(HumanMessage(content=turn.content) if turn.role == "user" else AIMessage(content=turn.content))
    return messages


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
            model=_build_model(req),
            tools=tools,
            system_prompt=req.system,
        )
        async for envelope in run_envelopes(agent, _build_messages(req), DEFAULT_RECURSION_LIMIT):
            yield envelope
    except Exception as err:
        log.exception("run failed")
        yield {"type": "error", "message": str(err)}
    yield {"type": "done"}
