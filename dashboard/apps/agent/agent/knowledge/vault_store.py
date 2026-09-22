"""The ONLY writer to the vault. Protects the Markdown that is persistent state.

Because the vault is not a git repo, the safety guarantees a commit would give
come from here instead:

  * atomic writes      — temp file in the same dir + fsync + os.replace
  * backup snapshots   — the previous bytes are copied to `<stem>.<ts>.bak` (a
                         non-.md sibling, so Obsidian's graph ignores it and the
                         BM25 index never sees it) before any overwrite
  * optimistic locking — a caller may pass the hash it read; if the file changed
                         since, the write is refused (never clobber a peer)
  * an advisory lock   — one cross-process flock around the read-modify-write so
                         two concurrent agents cannot interleave
  * no deletion        — an update always leaves the old version recoverable

Paths are confined to the vault root; a path that escapes it is refused.
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from ..config import knowledge_lock_path, vault_root, vault_write_root
from .model import Note

ALLOWED_WRITE_EXT = {".md"}

# When set, note writes land under this root instead of the vault — a per-run
# staging workspace. Reads are read-through: a staged note shadows the vault's
# copy of the same path, but reads fall back to the vault so a run still sees all
# pre-existing knowledge. Set via `staging()`; inherited by awaits in the task.
_staging_root: ContextVar[Path | None] = ContextVar("vault_staging_root", default=None)


def write_root() -> Path:
    """The root writes currently land in — the staging workspace if one is active,
    otherwise `vault_write_root()` (the vault, unless overridden)."""
    return _staging_root.get() or vault_write_root()


def staging_root() -> Path | None:
    """The active staging workspace, or None when writes go to the vault."""
    return _staging_root.get()


@contextmanager
def staging(root: Path | str):
    """Scope note writes to `root` for the duration of the block.

    Reads stay read-through (staged note shadows the vault's), so knowledge the
    run creates is visible to it while the shared vault stays untouched."""
    resolved = Path(root).resolve()
    for folder in ("03-Areas/concepts", "02-Projects"):
        (resolved / folder).mkdir(parents=True, exist_ok=True)
    token = _staging_root.set(resolved)
    try:
        yield resolved
    finally:
        _staging_root.reset(token)


class VaultError(Exception):
    """A refused vault operation (escape, bad type, not found, conflict)."""


class ConcurrentModification(VaultError):
    """The file changed on disk since the caller read it."""


def file_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _resolve(rel: str, root: Path, *, must_exist: bool) -> Path:
    """Resolve a root-relative path, refusing escapes and non-.md targets."""
    if not isinstance(rel, str) or not rel.strip():
        raise VaultError("path is required")
    try:
        real_root = root.resolve(strict=True)
    except OSError as err:
        raise VaultError(f"root not found: {root}") from err

    candidate = Path(rel)
    if candidate.is_absolute():
        raise VaultError("path must be relative to the root")

    target = (real_root / rel)
    parent = target.parent.resolve()
    if parent != real_root and real_root not in parent.parents:
        raise VaultError("path escapes the root")
    if target.suffix.lower() not in ALLOWED_WRITE_EXT:
        raise VaultError(f"only .md notes may be written (got {target.suffix or 'none'})")
    if must_exist and not target.exists():
        raise VaultError(f"note not found: {rel}")
    if not must_exist and target.exists() and target.is_symlink():
        # never follow a symlink out of the root on write
        real = target.resolve()
        if real != real_root and real_root not in real.parents:
            raise VaultError("path escapes the root")
    return target


def _read_path(rel: str, *, must_exist: bool) -> Path:
    """Where a read resolves: a staged note shadows the vault's copy of the same
    path, but reads fall through to the vault so a run still sees all pre-existing
    knowledge. A staged workspace that does not exist yet simply holds nothing."""
    root = staging_root()
    if root is not None:
        try:
            staged = _resolve(rel, root, must_exist=False)
        except VaultError:
            staged = None
        if staged is not None and staged.exists():
            return staged
    return _resolve(rel, vault_root(), must_exist=must_exist)


def read(rel: str) -> tuple[Note, str]:
    """Read a note; return (Note, sha256-of-raw-bytes)."""
    path = _read_path(rel, must_exist=True)
    raw_bytes = path.read_bytes()
    raw = raw_bytes.decode("utf-8", errors="replace")
    return Note(path=str(path), raw=raw), file_hash(raw_bytes)


def exists(rel: str) -> bool:
    try:
        return _read_path(rel, must_exist=False).exists()
    except VaultError:
        return False


_LOCK_MUTEX = threading.RLock()
_lock_depth = 0
_lock_fh = None


@contextmanager
def lock(timeout_s: float = 20.0):
    """A cross-process advisory lock around a read-modify-write.

    Reentrant within the process: a manager method may hold the lock and still
    call `write()`, which locks again — only the outermost acquisition takes the
    cross-process flock, and nested ones just bump a depth counter. Without this
    a nested `flock` on a second fd would deadlock on itself.
    """
    global _lock_depth, _lock_fh
    with _LOCK_MUTEX:
        if _lock_depth == 0:
            lock_path = knowledge_lock_path()
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            fh = open(lock_path, "w")  # noqa: SIM115 — held open for the flock's lifetime
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        fh.close()
                        raise VaultError("could not acquire the knowledge write lock") from None
                    time.sleep(0.05)
            _lock_fh = fh
        _lock_depth += 1
    try:
        yield
    finally:
        with _LOCK_MUTEX:
            _lock_depth -= 1
            if _lock_depth == 0 and _lock_fh is not None:
                try:
                    fcntl.flock(_lock_fh, fcntl.LOCK_UN)
                finally:
                    _lock_fh.close()
                    _lock_fh = None


def _backup(path: Path) -> Path | None:
    """Copy the current file to a timestamped .bak beside it. Returns its path."""
    if not path.exists():
        return None
    ts = time.strftime("%Y%m%d%H%M%S")
    bak = path.with_name(f"{path.stem}.{ts}.bak")
    # avoid clobbering a same-second backup
    n = 1
    while bak.exists():
        bak = path.with_name(f"{path.stem}.{ts}-{n}.bak")
        n += 1
    shutil.copy2(path, bak)
    return bak


def write(
    rel: str,
    text: str,
    *,
    expect_hash: str | None = None,
    backup: bool = True,
) -> dict:
    """Atomically write `text` to a note, backing up the previous version.

    With `expect_hash` set, refuses the write if the file changed since it was
    read (ConcurrentModification), so a stale in-memory edit never clobbers a
    peer's write. A no-op (identical bytes) writes nothing and makes no backup.

    Under a staging workspace the target is the staged copy (copy-on-write): the
    "current" content compared against `expect_hash` is the read-through one, so
    the first edit of a pre-existing vault note is a create in the workspace, not
    a spurious conflict, and the vault original is left untouched.
    """
    path = _resolve(rel, write_root(), must_exist=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    new_bytes = text.encode("utf-8")

    with lock():
        current_path = _read_path(rel, must_exist=False)
        current = current_path.read_bytes() if current_path.exists() else None
        if current is not None:
            if current == new_bytes:
                return {"path": rel, "changed": False, "backup": None, "hash": file_hash(current)}
            if expect_hash is not None and file_hash(current) != expect_hash:
                raise ConcurrentModification(f"{rel} changed on disk since it was read")
            # back up only a file we actually overwrite (a fresh staged copy has none)
            bak = _backup(path) if (backup and path.exists()) else None
        else:
            if expect_hash is not None:
                raise ConcurrentModification(f"{rel} no longer exists")
            bak = None

        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".kw-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, path)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)

        return {
            "path": rel,
            "changed": True,
            "backup": str(bak) if bak else None,
            "hash": file_hash(new_bytes),
            "bytes": len(new_bytes),
        }
