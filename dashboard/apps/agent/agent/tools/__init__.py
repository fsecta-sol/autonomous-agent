"""Builtin tools the agent can run in-process, keyed by the names the backend
catalog declares. `run_command` is gated by the terminal mode; `list_agents` and
`knowledge_search` are *not* here — they are remote callbacks to the backend."""

from langchain_core.tools import BaseTool

from .builtin import BUILTIN_TOOLS
from .fetch_url import fetch_url
from .remote import REMOTE_TOOLS
from .terminal import make_run_command
from .vault import vault_links, vault_list, vault_read, vault_search

STATIC_TOOLS: dict[str, BaseTool] = {
    **BUILTIN_TOOLS,
    **REMOTE_TOOLS,
    "fetch_url": fetch_url,
    "vault_search": vault_search,
    "vault_read": vault_read,
    "vault_list": vault_list,
    "vault_links": vault_links,
}


def build_tools(names: list[str], terminal_mode: str, allow_unsandboxed: bool, agent_id: str = "") -> list[BaseTool]:
    """Resolve the builtin tools for a run. `run_command` is added only when the
    agent's terminal mode is not "off"."""
    tools: list[BaseTool] = []
    for name in names:
        if name == "run_command":
            if terminal_mode != "off":
                tools.append(make_run_command(terminal_mode, allow_unsandboxed, agent_id))
            continue
        tool = STATIC_TOOLS.get(name)
        if tool is not None:
            tools.append(tool)
    return tools
