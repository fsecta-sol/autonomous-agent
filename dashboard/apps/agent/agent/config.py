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


def vault_write_root() -> Path:
    """Root knowledge writes land in. Defaults to the vault itself.

    A research run stages its notes in a per-run workspace instead (see
    `vault_store.staging`), so a run that goes off-topic cannot dirty the shared
    vault; the notes are only promoted in once the run is done and vetted. This
    env var is the process-wide fallback for writers that are not a research run.
    """
    override = os.environ.get("VAULT_WRITE_ROOT")
    return Path(override).resolve() if override else vault_root()


def agent_workspaces_root() -> Path:
    """Root under which each research run gets an isolated write workspace."""
    return Path(os.environ.get("AGENT_WORKSPACES_DIR", str(data_dir() / "workspaces"))).resolve()


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


def data_dir() -> Path:
    """Writable data root owned by the agent (checkpoints, spawns, memory, and
    the Knowledge Manager's derived index + event log)."""
    default = Path(__file__).resolve().parent.parent / "data"
    return Path(os.environ.get("AGENT_DATA_DIR", str(default)))


def knowledge_index_path() -> Path:
    """Derived knowledge index. Rebuildable from the Markdown vault alone."""
    return Path(os.environ.get("AGENT_KNOWLEDGE_INDEX", str(data_dir() / "knowledge-index.json")))


def knowledge_log_path() -> Path:
    """Append-only JSONL of KNOWLEDGE_* operations (observability)."""
    return Path(os.environ.get("AGENT_KNOWLEDGE_LOG", str(data_dir() / "knowledge-log.jsonl")))


def knowledge_lock_path() -> Path:
    """Advisory lock guarding concurrent vault writes across processes."""
    return Path(os.environ.get("AGENT_KNOWLEDGE_LOCK", str(data_dir() / ".knowledge.lock")))


def research_db_path() -> Path:
    """SQLite database for the Research Loop's durable state: runs, iterations,
    candidates, attempts and the research event log. Owned by the agent,
    separate from the checkpoints/memory/spawn stores."""
    return Path(os.environ.get("AGENT_RESEARCH_DB", str(data_dir() / "research.db")))


def research_events_path() -> Path:
    """Append-only JSONL mirror of research events (observability)."""
    return Path(os.environ.get("AGENT_RESEARCH_LOG", str(data_dir() / "research-events.jsonl")))


def max_subagents() -> int:
    """Cap on sub-agents one orchestrator run may spawn (guards runaway cost)."""
    try:
        return max(0, int(os.environ.get("AGENT_MAX_SUBAGENTS", "6")))
    except ValueError:
        return 6


def subagent_timeout_s() -> float:
    """Per-sub-agent *idle* limit, in seconds — NOT a wall-clock cap.

    The sub-agent's deadline resets on every streamed event, so a sub-agent that
    keeps making progress (streaming a long answer, a slow-but-returning fetch)
    may run far longer than this in total; only a genuine stall — no progress for
    this long — stops it. Tune with `AGENT_SUBAGENT_TIMEOUT_S`."""
    try:
        return float(os.environ.get("AGENT_SUBAGENT_TIMEOUT_S", "300"))
    except ValueError:
        return 300.0


def subagent_recursion_limit() -> int:
    """Tool-round budget for a headless sub-agent (LangGraph recursion limit).
    The default suits a focused, quick delegation; a deep-research sub-agent on a
    long-horizon run needs more rounds before it hits the graph's stop condition."""
    try:
        return max(1, int(os.environ.get("AGENT_SUBAGENT_RECURSION_LIMIT", "15")))
    except ValueError:
        return 15


# Effectively-infinite retry budget for a sub-agent's model calls. The loop still
# ends because a sub-agent that makes no progress for `AGENT_SUBAGENT_TIMEOUT_S`
# (an idle limit, see `subagent_timeout_s`) is stopped, so "unbounded" here means
# "keep retrying a transient upstream error while the endpoint is still talking,
# not a fixed handful of times". Retry backoff sleeps emit no stream events, so a
# run of exhausted retries is itself what trips the idle limit.
_INFINITE_RETRIES = 10**9


def subagent_retry_attempts() -> int:
    """How many times a sub-agent retries a *transient* upstream error (a 503
    "model temporarily unavailable", a 429, a dropped connection). Set
    `AGENT_SUBAGENT_RETRY_ATTEMPTS` to a whole number, or to `inf`/`infinite`/`-1`
    for unbounded retry bounded only by the sub-agent's idle timeout. Permanent
    errors (auth, bad request) are never retried regardless of this value."""
    raw = os.environ.get("AGENT_SUBAGENT_RETRY_ATTEMPTS", str(_INFINITE_RETRIES)).strip().lower()
    if raw in ("inf", "infinite", "-1", "unlimited"):
        return _INFINITE_RETRIES
    try:
        return max(0, int(raw))
    except ValueError:
        return _INFINITE_RETRIES


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
