"""Safe resolution of vault-relative paths. Port of the old TS vault-path.ts.

Refuses anything that escapes the vault root, resolves symlinks, and only
allows readable note types (.md / .txt)."""

from pathlib import Path

from ..config import vault_root

ALLOWED_EXT = {".md", ".txt"}

# A single note larger than this is truncated when read.
MAX_FILE_BYTES = 200_000


class VaultPathError(Exception):
    pass


def resolve_vault_path(rel: object) -> Path:
    """Resolve a vault-relative path to an absolute one, refusing escapes."""
    if not isinstance(rel, str) or not rel.strip():
        raise VaultPathError("path is required")

    root = vault_root()
    try:
        real_root = root.resolve(strict=True)
    except OSError:
        raise VaultPathError("vault root not found")

    candidate = Path(rel)
    if candidate.is_absolute():
        raise VaultPathError("path must be relative to the vault")

    abs_path = (root / rel).resolve()
    if abs_path != real_root and real_root not in abs_path.parents:
        raise VaultPathError("path escapes the vault")

    # Re-check after resolving symlinks: a link inside the vault can point out.
    try:
        real = abs_path.resolve(strict=True)
    except OSError:
        raise VaultPathError("file not found")
    if real != real_root and real_root not in real.parents:
        raise VaultPathError("path escapes the vault")

    ext = real.suffix.lower()
    if ext not in ALLOWED_EXT:
        raise VaultPathError(f"unsupported file type: {ext or '(none)'}")
    return real
