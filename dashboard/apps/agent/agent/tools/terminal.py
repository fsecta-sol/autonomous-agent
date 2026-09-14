"""run_command — execute a shell command. Port of the TS terminal.ts.

The mode is chosen by the OPERATOR in the agent's config, never by the model:
  sandbox     — unshare user+mount+pid+net namespaces, chroot into a minimal
                root with the system dirs bind-mounted read-only, a tmpfs /tmp,
                and a per-agent /work scratch. No network, no host filesystem.
  unsandboxed — a plain `bash -lc` as the service user, full FS + network.
                Refused unless the gate is set.

The mode is fixed server-side; a hostile prompt cannot select it.
"""

import logging
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

from langchain_core.tools import BaseTool, tool
from langgraph.types import interrupt

from ..config import scratch_dir
from .builtin import dumps

SANDBOX_TIMEOUT_S = 15
UNSANDBOXED_TIMEOUT_S = 30
MAX_OUTPUT_BYTES = 32_000
SANDBOX_ULIMITS = "ulimit -t 10 -f 10240 -u 256 2>/dev/null || true"

log = logging.getLogger("agent.terminal")

_SAFE_ID = re.compile(r"[^a-zA-Z0-9_-]")


def _work_dir(agent_id: str) -> Path:
    safe = _SAFE_ID.sub("_", agent_id or "anon")[:64] or "anon"
    directory = scratch_dir() / safe
    directory.mkdir(parents=True, exist_ok=True)
    return directory


# A fixed system PATH — the sandbox's helpers (unshare, mount, chroot) live in
# sbin/bin, so we never inherit a caller PATH that might omit them.
SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def _scrubbed_env(home: str) -> dict[str, str]:
    """Minimal, secret-free environment for both modes."""
    return {
        "PATH": SYSTEM_PATH,
        "HOME": home,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "TERM": "dumb",
    }


def _audit(agent_id: str, mode: str, command: str) -> None:
    one_line = " ".join(command.split())[:400]
    log.warning("[terminal] agent=%s mode=%s cmd=%r", agent_id or "?", mode, one_line)


def _collect(proc: subprocess.Popen, timeout_s: int) -> dict:
    """Run to completion with a hard timeout, capping combined output size."""
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        stdout, stderr = proc.communicate()

    out = (stdout or b"").decode("utf-8", errors="replace")
    err = (stderr or b"").decode("utf-8", errors="replace")
    truncated = len(out) + len(err) > MAX_OUTPUT_BYTES
    if truncated:
        out = out[:MAX_OUTPUT_BYTES]
        err = err[: max(0, MAX_OUTPUT_BYTES - len(out))]
    return {
        "code": proc.returncode,
        "stdout": out,
        "stderr": err,
        "truncated": truncated,
        "timedOut": timed_out,
    }


def _run_sandboxed(command: str, agent_id: str) -> dict:
    """Run inside unshare'd namespaces + chroot. Fails closed on setup error."""
    root = Path(tempfile.mkdtemp(prefix="dash-sbx-"))
    work = _work_dir(agent_id)
    cmd_file = work / f".cmd-{uuid.uuid4()}.sh"
    cmd_file.write_text(command, encoding="utf-8")
    os.chmod(cmd_file, 0o600)

    inner = "\n".join(
        [
            "set -e",
            'mkdir -p "$ROOT"/bin "$ROOT"/usr "$ROOT"/lib "$ROOT"/lib64 "$ROOT"/etc "$ROOT"/sbin "$ROOT"/tmp "$ROOT"/dev "$ROOT"/proc "$ROOT"/work',
            'for d in bin usr lib lib64 etc sbin; do if [ -d "/$d" ]; then mount --bind "/$d" "$ROOT/$d"; mount -o remount,ro,bind "$ROOT/$d" 2>/dev/null || true; fi; done',
            'mount -t tmpfs tmpfs "$ROOT/tmp" || exit 90',
            'mount -t proc proc "$ROOT/proc" 2>/dev/null || true',
            'mount --bind "$WORK" "$ROOT/work" || exit 91',
            "[ -e \"$ROOT/dev/null\" ] && mount --bind /dev/null \"$ROOT/dev/null\" 2>/dev/null || true",
            "[ -e \"$ROOT/dev/urandom\" ] && mount --bind /dev/urandom \"$ROOT/dev/urandom\" 2>/dev/null || true",
            "mount --bind /dev/null \"$ROOT/dev/null\" 2>/dev/null || true",
            f'exec chroot "$ROOT" /bin/bash -c \'cd /work && {SANDBOX_ULIMITS} && exec timeout {SANDBOX_TIMEOUT_S} bash /work/{cmd_file.name}\'',
        ]
    )

    env = {**_scrubbed_env("/work"), "ROOT": str(root), "WORK": str(work)}
    proc = subprocess.Popen(
        ["unshare", "--user", "--map-root-user", "--mount", "--pid", "--fork", "--net", "/bin/bash", "-c", inner],
        cwd=tempfile.gettempdir(),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        return _collect(proc, SANDBOX_TIMEOUT_S + 5)
    finally:
        subprocess.run(["rm", "-rf", str(root)], check=False)
        cmd_file.unlink(missing_ok=True)


def _run_unsandboxed(command: str, agent_id: str) -> dict:
    """Run directly as the service user — full FS + network access."""
    work = _work_dir(agent_id)
    cmd_file = work / f".cmd-{uuid.uuid4()}.sh"
    cmd_file.write_text(command, encoding="utf-8")
    os.chmod(cmd_file, 0o600)
    proc = subprocess.Popen(
        ["timeout", str(UNSANDBOXED_TIMEOUT_S), "bash", str(cmd_file)],
        cwd=str(work),
        env=_scrubbed_env(os.environ.get("HOME", "/home/hermes")),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        return _collect(proc, UNSANDBOXED_TIMEOUT_S + 5)
    finally:
        cmd_file.unlink(missing_ok=True)


def make_run_command(terminal_mode: str, allow_unsandboxed: bool, agent_id: str = "") -> BaseTool:
    """Build a run_command tool bound to this run's terminal policy."""

    @tool
    def run_command(command: str) -> str:
        """Run a shell command and return its output. Whether this executes
        sandboxed or with full access is fixed by the operator's configuration
        for this agent."""
        cmd = command or ""
        if not cmd.strip():
            return dumps({"error": "command is required"})

        mode = terminal_mode if terminal_mode in ("sandbox", "unsandboxed") else "off"
        if mode == "unsandboxed" and not allow_unsandboxed:
            mode = "sandbox"  # fail closed when the host gate is off

        if mode == "off":
            return dumps({"error": "terminal is disabled for this agent"})

        # Every command is approved by the operator before it runs. This pauses
        # the whole run; the graph checkpoints, and a later resume returns the
        # decision here. (The code above is pure, so node replay is harmless.)
        decision = interrupt(
            {
                "tool": "run_command",
                "args": {"command": cmd, "mode": mode},
                "message": f"Approve running this command ({mode})?",
            }
        )
        if decision != "approve":
            return dumps({"error": "command denied by operator", "denied": True})

        _audit(agent_id, mode, cmd)
        result = _run_unsandboxed(cmd, agent_id) if mode == "unsandboxed" else _run_sandboxed(cmd, agent_id)
        return dumps(
            {
                "mode": mode,
                "exitCode": result["code"],
                "timedOut": result["timedOut"],
                "truncated": result["truncated"],
                "stdout": result["stdout"],
                "stderr": result["stderr"],
            }
        )

    return run_command
