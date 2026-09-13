"""Tools whose data lives in the backend (the knowledge graph and the swarm
roster). Rather than duplicating the graph/roster logic here, the agent calls
the backend's internal endpoints, which own that data."""

import httpx
from langchain_core.tools import BaseTool, tool

from ..config import backend_internal_url, internal_tool_token
from .builtin import dumps

_CALL_TIMEOUT_S = 15.0


async def _call(tool_name: str, args: dict) -> str:
    """POST to the backend's internal tool endpoint and return its `result`."""
    token = internal_tool_token()
    if not token:
        return dumps({"error": "internal tools are not configured on this deployment"})
    url = f"{backend_internal_url()}/internal/tools/{tool_name}"
    try:
        async with httpx.AsyncClient(timeout=_CALL_TIMEOUT_S) as client:
            res = await client.post(
                url,
                json={"args": args},
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as err:
        return dumps({"error": f"backend unreachable: {err}"})
    if res.status_code >= 400:
        return dumps({"error": f"backend HTTP {res.status_code}"})
    try:
        return res.json().get("result", "")
    except ValueError:
        return dumps({"error": "backend returned a non-JSON body"})


@tool
async def knowledge_search(query: str, limit: int = 8) -> str:
    """Search the workspace knowledge graph for concepts whose title matches a
    query. Returns matching concepts with their layer, type and degree. Use this
    before answering questions about concepts the workspace tracks."""
    return await _call("knowledge_search", {"query": query, "limit": limit})


@tool
async def list_agents() -> str:
    """List the research swarm's agents, their roles, and what each is currently
    working on."""
    return await _call("list_agents", {})


REMOTE_TOOLS: dict[str, BaseTool] = {
    "knowledge_search": knowledge_search,
    "list_agents": list_agents,
}
