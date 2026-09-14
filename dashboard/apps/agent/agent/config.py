"""Process-level configuration for the agent service.

The agent stays DB-agnostic: the backend sends persona, tools, MCP servers and
LLM credentials in the /run payload. What lives here is only what is specific to
this process — including the *checkpoint* store, which the agent owns so runs
can pause (for approval) and survive a restart.
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


def checkpoint_db_path() -> Path:
    """SQLite database for LangGraph checkpoints (thread state). Owned by the
    agent, separate from the backend's application DB."""
    default = Path(__file__).resolve().parent.parent / "data" / "checkpoints.db"
    return Path(os.environ.get("AGENT_CKPT_DB", str(default)))


def spawn_log_db_path() -> Path:
    """SQLite database for sub-agent spawn events (timestamps for the UI)."""
    default = Path(__file__).resolve().parent.parent / "data" / "spawns.db"
    return Path(os.environ.get("AGENT_SPAWN_DB", str(default)))


def max_subagents() -> int:
    """Cap on sub-agents one orchestrator run may spawn (guards runaway cost)."""
    try:
        return max(0, int(os.environ.get("AGENT_MAX_SUBAGENTS", "6")))
    except ValueError:
        return 6


def subagent_timeout_s() -> float:
    """Per-sub-agent wall-clock limit, in seconds. Generous by default because
    a sub-agent on a slow endpoint may make several model calls."""
    try:
        return float(os.environ.get("AGENT_SUBAGENT_TIMEOUT_S", "300"))
    except ValueError:
        return 300.0
