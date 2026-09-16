"""The `batch_research` tool — parallel fan-out over a list of items.

The orchestrator calls this with a per-item task and a list of items; the tool
runs one sub-agent *per item* concurrently (via a LangGraph `StateGraph` with a
`Send` fan-out) and returns every result. This is the parallel counterpart to
`spawn_subagent`, whose calls are sequential: for "check these 30 addresses",
`batch_research` does them at once instead of one after another.

Results accumulate through an `Annotated[list, add]` reducer — without it, N
parallel nodes writing the same key would clobber each other and only the last
would survive.
"""

import json
from operator import add
from typing import Annotated, Any, TypedDict

from langchain_core.tools import BaseTool, tool
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from ..config import batch_concurrency, max_batch_items
from ..models import RunRequest
from ..subagent import run_subagent


class BatchState(TypedDict):
    """One fan-out run. `task`/`role` describe the work; `items` is the row set;
    `sample` is the single row a fan-out node handles; `results` is the reducer
    that collects every node's output."""

    task: str
    role: str
    items: list[dict[str, Any]]
    sample: dict[str, Any]
    results: Annotated[list[dict[str, Any]], add]


def _compose_goal(task: str, sample: dict[str, Any]) -> str:
    """The per-item goal a sub-agent receives: the shared task, plus this row."""
    return f"{task}\n\nThis item:\n{json.dumps(sample, ensure_ascii=False)}"


def _build_graph(req: RunRequest, subagent_tools: list[BaseTool], timeout_s: float):
    """Build the fan-out graph for one run. The sub-agents inherit the run's LLM
    and tools, exactly like a spawned sub-agent."""

    def fan_out(state: BatchState) -> list[Send]:
        return [
            Send("research_one", {"task": state["task"], "role": state["role"], "sample": item})
            for item in state["items"]
        ]

    async def research_one(state: BatchState) -> dict[str, Any]:
        sample = state.get("sample", {})
        goal = _compose_goal(state["task"], sample)
        text, timed_out = await run_subagent(req, state["role"], goal, subagent_tools, timeout_s)
        return {"results": [{"item": sample, "result": text, "timedOut": timed_out}]}

    graph = StateGraph(BatchState)
    graph.add_node("fan_out", lambda _state: {})  # routing node; the edge does the work
    graph.add_node("research_one", research_one)
    graph.add_edge(START, "fan_out")
    graph.add_conditional_edges("fan_out", fan_out, ["research_one"])
    graph.add_edge("research_one", END)
    return graph.compile()


def make_batch_tool(
    req: RunRequest,
    subagent_tools: list[BaseTool],
    timeout_s: float,
) -> BaseTool:
    """Build the orchestrator's `batch_research` tool for one run."""
    graph = _build_graph(req, subagent_tools, timeout_s)
    cap = max_batch_items()
    concurrency = batch_concurrency()

    @tool
    async def batch_research(task: str, items: list[dict], role: str = "researcher") -> str:
        """Run the same task over many items in parallel, one sub-agent per item.

        Use this instead of many `spawn_subagent` calls when the work is the same
        shape repeated across a list — e.g. "check the liquidity of each of these
        tokens", "summarize each of these articles". The calls run concurrently,
        so a list of 30 finishes in roughly the time of one.

        Args:
            task: The instruction each sub-agent must perform on its item. Be
                specific and self-contained; it is combined with each item.
            items: The list of items to process. Each item is a JSON object; it is
                passed verbatim to a sub-agent as "This item: {…}".
            role: A short role for the sub-agents, e.g. "token analyst".
        """
        if not items:
            return json.dumps({"error": "items is empty"}, ensure_ascii=False)
        capped = items[:cap]
        truncated = len(items) - len(capped)
        result = await graph.ainvoke(
            {"task": task, "role": role, "items": capped, "sample": {}, "results": []},
            # max_concurrency bounds how many fan-out nodes run at once; the
            # recursion budget must cover every parallel node plus the router.
            config={"max_concurrency": concurrency, "recursion_limit": 2 * len(capped) + 10},
        )
        payload: dict[str, Any] = {"results": result.get("results", []), "count": len(capped)}
        if truncated > 0:
            payload["truncated"] = f"{truncated} items omitted (cap {cap} per call)"
        return json.dumps(payload, ensure_ascii=False)

    return batch_research
