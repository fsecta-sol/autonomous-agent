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


def store_db_path() -> Path:
    """SQLite database for LangGraph long-term memory (cross-session facts).
    Owned by the agent, separate from the checkpoint DB and the backend's DB."""
    default = Path(__file__).resolve().parent.parent / "data" / "memory.db"
    return Path(os.environ.get("AGENT_STORE_DB", str(default)))


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


def max_batch_items() -> int:
    """Cap on how many items one `batch_research` call may fan out (cost guard)."""
    try:
        return max(1, int(os.environ.get("AGENT_MAX_BATCH", "24")))
    except ValueError:
        return 24


def batch_concurrency() -> int:
    """How many batch fan-out sub-agents may run at once. Bounds load on the
    upstream endpoint and the tool/backends."""
    try:
        return max(1, int(os.environ.get("AGENT_BATCH_CONCURRENCY", "6")))
    except ValueError:
        return 6


def stream_chunk_timeout_s() -> float | None:
    """Content-silence timeout (seconds) for a streaming model response, or None
    to disable.

    Disabled by default. langchain-openai's own default is 120s, but it measures
    the gap between *parsed content chunks* and is deliberately NOT reset by SSE
    keepalive comments — so a reasoning model that thinks for minutes before its
    first token, on a connection that is genuinely healthy, trips it (the
    `chunks_received=0` abort). This agent is long-horizon on exactly such an
    endpoint, so the watchdog is off; a truly dead peer is still caught by the
    transport-level TCP timeout. Set AGENT_STREAM_CHUNK_TIMEOUT_S to a positive
    number to re-enable a bounded check.
    """
    raw = os.environ.get("AGENT_STREAM_CHUNK_TIMEOUT_S", "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def fetch_timeout_s() -> float:
    """Per-request timeout for the fast HTTP fetch tier (seconds)."""
    try:
        return float(os.environ.get("AGENT_FETCH_TIMEOUT_S", "20"))
    except ValueError:
        return 20.0


def fetch_browser_timeout_s() -> float:
    """Hard wall-clock cap for the browser tier (seconds). The browser launches,
    waits for network idle, and may solve a Cloudflare challenge; this is the
    ceiling on all of that, after which the fetch is abandoned. A cold headful
    solve runs ~10-30s, so the default leaves headroom."""
    try:
        return float(os.environ.get("AGENT_FETCH_BROWSER_TIMEOUT_S", "60"))
    except ValueError:
        return 60.0


def fetch_max_browsers() -> int:
    """How many browser-tier fetches may run at once. Bounds memory/CPU when
    `batch_research` fans out over many blocked URLs."""
    try:
        return max(1, int(os.environ.get("AGENT_FETCH_MAX_BROWSERS", "2")))
    except ValueError:
        return 2


def fetch_browser_enabled() -> bool:
    """Kill switch for the browser tier. When off, fetch_url never launches a
    browser — it returns the fast tier's result (or the CF-block error)."""
    return os.environ.get("AGENT_FETCH_BROWSER", "1") != "0"


def fetch_cache_ttl_s() -> float:
    """How long a successful fetch is cached (seconds). A URL fetched again
    inside this window — e.g. two sub-agents hitting the same source — is served
    from memory instead of re-fetched. 0 disables caching."""
    try:
        return float(os.environ.get("AGENT_FETCH_CACHE_TTL_S", "300"))
    except ValueError:
        return 300.0
