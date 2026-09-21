"""Additive, backed-up migration of the vault to the Knowledge Manager's schema.

The Markdown KG already carries most of what the manager needs. This migration
fills ONLY the small set of optional fields that are missing, and never rewrites
a note's content:

  * `id:`  — set to the slug where absent (identity is already the filename, so
             this is a no-op in effect, but makes the id explicit and resolvable)
  * `aliases:` — left untouched unless the caller supplies a map

Run modes: plan (dry-run, the default) → apply → validate. Applying is
idempotent: a second run finds nothing to change. Every file it touches is backed
up first (the vault is not git, so backups are the safety net).

Report shape (spec §26): files changed, nodes created, relationships discovered,
duplicate candidates, malformed nodes, unresolved references.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import vault_root
from . import index as ix
from . import observability, vault_store
from .model import Note


@dataclass
class Plan:
    files: list[str] = field(default_factory=list)
    malformed: list[str] = field(default_factory=list)
    unresolved_refs: list[dict] = field(default_factory=list)
    nodes_created: int = 0
    relationships: int = 0

    def report(self) -> dict:
        return {
            "files_to_change": len(self.files),
            "files": self.files[:100],
            "nodes_created": self.nodes_created,
            "relationships_discovered": self.relationships,
            "malformed_nodes": self.malformed,
            "unresolved_references": len(self.unresolved_refs),
            "unresolved_sample": self.unresolved_refs[:25],
        }


def _all_notes() -> list[str]:
    root = vault_root()
    out: list[str] = []
    for folder in (ix.CONCEPT_DIR, ix.PROJECT_DIR):
        d = root / folder
        if d.is_dir():
            out.extend(sorted(str(p.relative_to(root)) for p in d.glob("*.md")))
    return out


def plan() -> Plan:
    """Dry run: what would change, and is anything malformed?"""
    root = vault_root()
    p = Plan()
    idx = ix.get()
    p.nodes_created = len(idx.nodes)
    p.relationships = len(idx.edges)
    p.unresolved_refs = [{"source": e.source, "target": e.target, "section": e.section} for e in idx.dangling]

    for rel in _all_notes():
        try:
            raw = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            p.malformed.append(rel)
            continue
        note = Note(path=rel, raw=raw)
        if not note.has_frontmatter:
            p.malformed.append(rel)
            continue
        slug = note.slug()
        if not slug:
            p.malformed.append(rel)
            continue
        if note.fm("id") is None:
            p.files.append(rel)
    return p


def apply(*, backup: bool = True) -> dict:
    """Apply the additive migration. Idempotent; backs up before writing."""
    root = vault_root()
    changed: list[str] = []
    for rel in _all_notes():
        try:
            raw = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        note = Note(path=rel, raw=raw)
        if not note.has_frontmatter:
            continue
        slug = note.slug()
        if not slug:
            continue
        before = note.render()
        if note.fm("id") is None:
            note.set_fm("id", slug)
        after = note.render()
        if after == before:
            continue
        vault_store.write(rel, after, backup=backup)
        changed.append(rel)

    ix.invalidate()
    result = validate()
    observability.emit("INDEX_REBUILT", detail=f"migration applied to {len(changed)} file(s)")
    return {"changed": len(changed), "changed_files": changed[:100], "validation": result}


def validate() -> dict:
    """Post-migration validation: parse everything, confirm ids resolve."""
    root = vault_root()
    malformed: list[str] = []
    missing_id: list[str] = []
    for rel in _all_notes():
        try:
            raw = (root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            malformed.append(rel)
            continue
        note = Note(path=rel, raw=raw)
        if not note.has_frontmatter or not note.slug():
            malformed.append(rel)
        elif note.fm("id") is None:
            missing_id.append(rel)
    idx = ix.rebuild()
    return {
        "ok": not malformed and not missing_id,
        "total_notes": len(_all_notes()),
        "malformed": malformed,
        "missing_id": missing_id,
        "nodes": len(idx.nodes),
        "edges": len(idx.edges),
        "dangling": len(idx.dangling),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Knowledge Manager vault migration")
    ap.add_argument("mode", choices=["plan", "apply", "validate"], nargs="?", default="plan")
    ap.add_argument("--no-backup", action="store_true", help="skip .bak snapshots (not recommended)")
    args = ap.parse_args(argv)

    if args.mode == "plan":
        print(json.dumps(plan().report(), indent=2, ensure_ascii=False))
    elif args.mode == "apply":
        print(json.dumps(apply(backup=not args.no_backup), indent=2, ensure_ascii=False))
    else:
        print(json.dumps(validate(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
