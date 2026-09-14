"""Run one sub-agent headless and return its final text.

A sub-agent is the orchestrator's way to delegate a slice of work: it is a fresh
LangGraph agent with the run's LLM, a role-shaped system prompt, and the same
tool set (minus `spawn_subagent`, so it cannot recurse). It runs to completion
with no browser stream — the orchestrator only sees the returned text.
"""

import asyncio
import logging

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool

from .llm import build_model
from .models import RunRequest

log = logging.getLogger("agent.subagent")

# The sub-agent gets a bounded tool budget of its own; it is meant to answer a
# focused goal, not run an open-ended loop.
SUBAGENT_RECURSION_LIMIT = 15


def _final_text(result: dict) -> str:
    """The sub-agent's last assistant message, as plain text."""
    for message in reversed(result.get("messages", [])):
        if isinstance(message, AIMessage):
            content = message.content
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                text = "".join(
                    b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
                )
                if text.strip():
                    return text
    return "(the sub-agent produced no text)"


async def run_subagent(
    req: RunRequest,
    role: str,
    goal: str,
    tools: list[BaseTool],
    timeout_s: float,
) -> tuple[str, bool]:
    """Run a sub-agent to completion. Returns (text, timed_out)."""
    prompt = (
        f"You are \"{role}\", a focused sub-agent working on one delegated goal inside a larger "
        f"research task. Do the work yourself using your tools; do not ask for clarification. "
        f"Return a concise, self-contained result the orchestrator can use directly.\n\nGoal: {goal}"
    )
    agent = create_agent(model=build_model(req), tools=tools, system_prompt=prompt)
    try:
        result = await asyncio.wait_for(
            agent.ainvoke(
                {"messages": [HumanMessage(content=goal)]},
                config={"recursion_limit": SUBAGENT_RECURSION_LIMIT},
            ),
            timeout=timeout_s,
        )
    except TimeoutError:
        log.warning("sub-agent %s timed out after %.0fs", role, timeout_s)
        return (f"The sub-agent \"{role}\" did not finish within {timeout_s:.0f}s.", True)
    except Exception as err:
        log.exception("sub-agent %s failed", role)
        return (f"The sub-agent \"{role}\" failed: {err}", True)
    return (_final_text(result), False)
