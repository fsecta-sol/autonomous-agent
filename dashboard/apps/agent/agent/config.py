"""Process-level configuration for the agent service.

The agent is stateless per run: the backend sends persona, tools, MCP servers
and LLM credentials in the /run payload. Only what is specific to this process
lives here.
"""

import os
from pathlib import Path


def vault_root() -> Path:
    """Root of the notes vault the vault_* tools read."""
    return Path(os.environ.get("VAULT_ROOT", "/home/hermes/vault")).resolve()


def backend_internal_url() -> str:
    """Base URL of the backend's internal tool endpoints."""
    return os.environ.get("BACKEND_INTERNAL_URL", "http://127.0.0.1:3011").rstrip("/")


def internal_tool_token() -> str:
    """Shared secret presented to the backend's /internal/tools/* endpoints."""
    return os.environ.get("INTERNAL_TOOL_TOKEN", "")


def agent_port() -> int:
    try:
        return int(os.environ.get("AGENT_PORT", "8012"))
    except ValueError:
        return 8012


def terminal_allow_unsandboxed() -> bool:
    return os.environ.get("TERMINAL_ALLOW_UNSANDBOXED") == "1"


def scratch_dir() -> Path:
    """Per-agent writable scratch root for the terminal tool's work dirs."""
    default = Path(__file__).resolve().parent.parent / "data" / "terminal"
    return Path(os.environ.get("AGENT_SCRATCH_DIR", str(default)))
