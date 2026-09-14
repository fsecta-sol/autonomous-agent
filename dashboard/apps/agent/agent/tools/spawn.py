"""The `spawn_subagent` tool — how an orchestrator delegates a slice of work.

The orchestrator calls this tool with a role and a goal; the tool runs a fresh
LangGraph sub-agent headless and returns its final text. It is a factory (like
`make_run_command`) because it closes over the run's LLM, the sub-agent tool set,
and a shared spawn budget.
"""

import json
from dataclasses import dataclass, field

from langchain_core.tools import BaseTool, tool

from ..config import max_subagents, subagent_timeout_s
from ..models import RunRequest
from ..spawn_log import record_end, record_start
from ..subagent import run_subagent


@dataclass
class SpawnBudget:
    """Shared, per-run spawn accounting. One instance per orchestrator run."""

    used: int = 0
    roles: list[str] = field(default_factory=list)


def make_spawn_tool(
    req: RunRequest,
    subagent_tools: list[BaseTool],
    budget: SpawnBudget,
) -> BaseTool:
    """Build the orchestrator's `spawn_subagent` tool for one run.

    `subagent_tools` is the tool set a sub-agent may use — the run's tools minus
    `spawn_subagent` itself, so sub-agents cannot recurse.
    """
    cap = max_subagents()
    timeout_s = subagent_timeout_s()

    @tool
    async def spawn_subagent(role: str, goal: str) -> str:
        """Delegate a focused piece of work to a sub-agent and get its result back.

        Use this to decompose or parallelize a task: e.g. one sub-agent gathers
        sources, another checks a specific relationship. Each sub-agent works only
        from the goal you give it, so include everything it needs in `goal`.

        Args:
            role: A short role for the sub-agent, e.g. "source scout".
            goal: The specific, self-contained task this sub-agent must accomplish.
        """
        if budget.used >= cap:
            return json.dumps(
                {
                    "error": f"sub-agent budget exhausted ({cap} per run). Do the remaining work yourself.",
                    "spawned": budget.roles,
                },
                ensure_ascii=False,
            )
        budget.used += 1
        budget.roles.append(role)

        # Log start/finish so the UI has real timestamps (the checkpoint only
        # records that a spawn happened, not when).
        event_id = await record_start(req.sessionId or f"ephemeral:{req.agentId}", role, goal)
        text, timed_out = await run_subagent(req, role, goal, subagent_tools, timeout_s)
        await record_end(event_id, "timed_out" if timed_out else "done", result=text)
        return json.dumps({"role": role, "timedOut": timed_out, "result": text}, ensure_ascii=False)

    return spawn_subagent
