"""Connect to the agent's MCP servers and expose their tools.

The backend sends the enabled servers for a run (streamable HTTP); we connect
with langchain-mcp-adapters and return the tools it discovers. A server that
fails to connect is skipped — the run continues with whatever loaded."""

import logging

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from .models import McpServerTarget

log = logging.getLogger("agent.mcp")


async def load_mcp_tools(servers: list[McpServerTarget]) -> tuple[list[BaseTool], list[str]]:
    """Return (tools, warnings) for the enabled servers."""
    tools: list[BaseTool] = []
    warnings: list[str] = []
    if not servers:
        return tools, warnings

    connections: dict[str, dict] = {}
    for server in servers:
        conn: dict = {"transport": "streamable_http", "url": server.url}
        if server.apiKey:
            conn["headers"] = {"Authorization": f"Bearer {server.apiKey}"}
        connections[server.id] = conn

    client = MultiServerMCPClient(connections)
    for server in servers:
        try:
            server_tools = await client.get_tools(server_name=server.id)
            tools.extend(server_tools)
        except Exception as err:  # noqa: BLE001 — one bad server must not sink the run
            warnings.append(f'MCP server "{server.name}" unavailable: {err}')
            log.warning("MCP server %s failed: %s", server.name, err)
    return tools, warnings
