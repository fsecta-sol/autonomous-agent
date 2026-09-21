"""Parse and surgically edit one Markdown knowledge note.

The vault's notes are plain Markdown with a `---` frontmatter block and `##`
sections (see the knowledge-curator skill). We deliberately do NOT round-trip
through a YAML library: real notes carry URLs, em-dashes and `key: value`-shaped
lines inside `sources` that a generic parser mangles. Instead we keep the file as
an ordered list of line-blocks and mutate only the lines we mean to change, so an
edit produces a minimal, reviewable diff and every untouched byte survives.

A note looks like:

    ---
    concept: mev
    type: trading
    layer: market
    sources:
      - https://…
    status: active
    ---

    ## What
    …

    ## Why it exists / why it works
    …
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

SCHEMA_VERSION = 1

# Section headings used by the concept and project schemas. Order is not
# enforced; this is the vocabulary the manager recognises.
SECTION_ORDER = [
    "What",
    "Why it exists / why it works",
    "Builds on",
    "Enables",
    "Related (same layer)",
    "Diagram",
    "Real-world examples",
    "Instances",
    "Open questions",
    "Notes",
    "Sources",
    # Knowledge-Manager-added conventions (mirror the "Open questions" idiom):
    "Evidence",
    "Conflict",
    "Unknown",
]

# Which section a relationship type lives in on disk. No new on-disk format:
# the type is the *section*, exactly as the existing graph already works.
RELATION_SECTION = {
    "builds-on": "Builds on",
    "enables": "Enables",
    "related": "Related (same layer)",
    "depends_on": "Builds on",
    "part_of": "Builds on",
    "caused_by": "Builds on",
    "derived_from": "Builds on",
    "implements": "Enables",
    "supports": "Enables",
    "contradicts": "Related (same layer)",
    "supersedes": "Related (same layer)",
    "relates_to": "Related (same layer)",
}

# Relation types that mean "this note points at a lower layer" (Builds on) vs
# "upper layer" (Enables) vs "same layer" (Related).
BUILDS_ON_TYPES = {"builds-on", "depends_on", "part_of", "caused_by", "derived_from"}
ENABLES_TYPES = {"enables", "implements", "supports"}

WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]")
FRONTMATTER_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+):(.*)$")
SECTION_RE = re.compile(r"^##\s+(.*?)\s*$")
SLUG_RE = re.compile(r"[^a-z0-9]+")

# Longest slug kept verbatim. A note's filename is `<slug>.md`, so the cap must
# leave room for the `.md` (and any future suffix) well under the filesystem's
# 255-byte filename limit. Slugs are built from a title OR a whole research
# question, and a full question can run to hundreds of characters — a naive
# `slugify(question)` then produced a filename that `open()` rejected with
# [Errno 36] File name too long, silently dropping the note.
MAX_SLUG_LEN = 120
_SLUG_HASH_LEN = 8


def slugify(name: str) -> str:
    """Turn a title into the vault's filename convention (lowercase-kebab).

    Overlong inputs are truncated to `MAX_SLUG_LEN`, with a short hash of the
    full text appended so two different long inputs never collide onto one file
    (the truncated prefix alone would)."""
    slug = SLUG_RE.sub("-", name.strip().lower()).strip("-")
    if len(slug) <= MAX_SLUG_LEN:
        return slug
    digest = hashlib.sha1(slug.encode("utf-8")).hexdigest()[:_SLUG_HASH_LEN]
    head = slug[: MAX_SLUG_LEN - _SLUG_HASH_LEN - 1].rstrip("-")
    return f"{head}-{digest}"


def parse_wikilinks(text: str) -> list[tuple[str, str | None]]:
    """Every `[[target]]` / `[[target|alias]]` in `text` as (target, alias|None)."""
    out: list[tuple[str, str | None]] = []
    for m in WIKILINK_RE.finditer(text):
        target = m.group(1).strip()
        if target:
            out.append((target, (m.group(2).strip() if m.group(2) else None)))
    return out


# ── Frontmatter ──────────────────────────────────────────────────────────────


@dataclass
class Frontmatter:
    """The frontmatter block, modelled as ordered (key -> list-of-lines) entries.

    A top-level key is a line matching `^key:` at column 0; every following
    indented line (list item `  - x`, nested `  k: v`) belongs to it. This mirrors
    how the notes are actually written and survives URLs/em-dashes verbatim.
    """

    lines: list[str]  # inner content only (between the --- fences), no fences
    entries: list[tuple[str, list[str]]] = field(default_factory=list)

    @classmethod
    def parse(cls, inner: str) -> Frontmatter:
        lines = inner.split("\n")
        entries: list[tuple[str, list[str]]] = []
        for line in lines:
            m = FRONTMATTER_KEY_RE.match(line)
            if m and not line[:1].isspace():
                entries.append((m.group(1), [line]))
            elif entries:
                entries[-1][1].append(line)
            # a leading blank/comment line before any key is dropped (rare)
        return cls(lines=lines, entries=entries)

    def has(self, key: str) -> bool:
        return any(k == key for k, _ in self.entries)

    def get(self, key: str) -> str | None:
        """The scalar value of `key` (text after the colon), or None."""
        for k, block in self.entries:
            if k == key:
                return FRONTMATTER_KEY_RE.match(block[0]).group(2).strip()
        return None

    def get_list(self, key: str) -> list[str]:
        """Items of a block-style list key (`  - item`), else []."""
        for k, block in self.entries:
            if k == key:
                items = []
                for line in block[1:]:
                    s = line.strip()
                    if s.startswith("- "):
                        items.append(s[2:].strip())
                    elif s == "-":
                        items.append("")
                return items
        return []

    def scalars(self) -> dict[str, str]:
        """Cheap key->scalar map for keys whose value is a single line."""
        out: dict[str, str] = {}
        for k, block in self.entries:
            if len(block) == 1:
                out[k] = FRONTMATTER_KEY_RE.match(block[0]).group(2).strip()
        return out

    def set_scalar(self, key: str, value: str) -> None:
        """Set a scalar key, replacing its line in place (minimal diff) or
        appending a new line at the end of the block when it is absent."""
        for idx, (k, block) in enumerate(self.entries):
            if k == key:
                self.entries[idx] = (key, [f"{key}: {value}"])
                return
        self.entries.append((key, [f"{key}: {value}"]))

    def append_list_item(self, key: str, item: str) -> None:
        """Append `- item` to a block list, creating the key if absent."""
        for idx, (k, block) in enumerate(self.entries):
            if k == key:
                self.entries[idx] = (key, [*block, f"  - {item}"])
                return
        self.entries.append((key, [f"{key}:", f"  - {item}"]))

    def remove_list_item(self, key: str, item: str) -> bool:
        for idx, (k, block) in enumerate(self.entries):
            if k == key:
                kept = [block[0]]
                removed = False
                for line in block[1:]:
                    if line.strip() == f"- {item}":
                        removed = True
                        continue
                    kept.append(line)
                self.entries[idx] = (key, kept)
                return removed
        return False

    def remove(self, key: str) -> bool:
        for idx, (k, _) in enumerate(self.entries):
            if k == key:
                del self.entries[idx]
                return True
        return False

    def render(self) -> str:
        return "\n".join(line for _k, block in self.entries for line in block)


# ── Body sections ────────────────────────────────────────────────────────────


@dataclass
class Section:
    name: str
    lines: list[str]  # content lines AFTER the heading, up to the next `## `

    def content(self) -> str:
        return "\n".join(self.lines)

    def links(self) -> list[tuple[str, str | None]]:
        return parse_wikilinks("\n".join(self.lines))


class Note:
    """One parsed note.

    Fidelity is the point: an unedited note re-renders byte-for-byte (so an
    update to one section yields a minimal diff), because the body is kept as its
    exact line list and the frontmatter block is kept verbatim until a key is
    actually changed. Nothing is re-flowed or re-spaced.
    """

    def __init__(self, path: str | None, raw: str):
        self.path = path
        self._raw = raw
        self.dirty = False
        self.fm_dirty = False

        self.has_frontmatter = False
        self.fm_block_raw: str | None = None  # exact `---\n…\n---`
        self.fm_trailing = "\n\n"  # separator between closing fence and body
        self.frontmatter = Frontmatter.parse("")
        body = raw

        if raw.startswith(("---\n", "---\r\n")):
            nl = raw.find("\n")
            # The closing fence is the next `---` line AFTER the opening one, so
            # search from just past the first line (otherwise `^---$` matches the
            # opening fence at position 0 and no frontmatter is ever parsed).
            m = re.search(r"^---[ \t]*\r?$", raw[nl + 1 :], flags=re.MULTILINE)
            if m:
                body_start = nl + 1
                fence_start = body_start + m.start()
                fence_end = body_start + m.end()
                self.has_frontmatter = True
                self.fm_block_raw = raw[:fence_end]
                inner = raw[body_start:fence_start]
                inner = inner.removesuffix("\n")
                self.frontmatter = Frontmatter.parse(inner)
                rest = raw[fence_end:]
                # preserve the exact run of newlines before the first body char
                stripped = rest.lstrip("\n")
                self.fm_trailing = rest[: len(rest) - len(stripped)]
                body = stripped

        self.body_lines: list[str] = body.split("\n")

    # ── frontmatter access ──
    @property
    def frontmatter(self) -> Frontmatter:
        return self._fm

    @frontmatter.setter
    def frontmatter(self, value: Frontmatter) -> None:
        self._fm = value

    def fm(self, key: str) -> str | None:
        return self.frontmatter.get(key) if self.has_frontmatter else None

    # ── section view (recomputed from body_lines) ──
    def _bounds(self) -> list[tuple[str, int, int]]:
        """(name, heading-index, end-index-exclusive) for each `## ` section."""
        heads: list[tuple[str, int]] = []
        for i, line in enumerate(self.body_lines):
            m = SECTION_RE.match(line)
            if m:
                heads.append((m.group(1), i))
        out: list[tuple[str, int, int]] = []
        for j, (name, start) in enumerate(heads):
            end = heads[j + 1][1] if j + 1 < len(heads) else len(self.body_lines)
            out.append((name, start, end))
        return out

    @property
    def preamble(self) -> list[str]:
        b = self._bounds()
        first = b[0][1] if b else len(self.body_lines)
        return self.body_lines[:first]

    @property
    def sections(self) -> list[Section]:
        out: list[Section] = []
        for name, start, end in self._bounds():
            out.append(Section(name=name, lines=list(self.body_lines[start + 1 : end])))
        return out

    def section(self, name: str) -> Section | None:
        for s in self.sections:
            if s.name.lower() == name.lower():
                return s
        return None

    def section_names(self) -> list[str]:
        return [name for name, _, _ in self._bounds()]

    def all_links(self) -> list[tuple[str, str | None, str]]:
        out: list[tuple[str, str | None, str]] = []
        for name, start, end in self._bounds():
            block = "\n".join(self.body_lines[start + 1 : end])
            for target, alias in parse_wikilinks(block):
                out.append((target, alias, name))
        for target, alias in parse_wikilinks("\n".join(self.preamble)):
            out.append((target, alias, ""))
        return out

    def slug(self) -> str:
        for key in ("concept", "project", "id"):
            v = self.fm(key)
            if v:
                return slugify(v)
        if self.path:
            return slugify(self.path.rsplit("/", 1)[-1].rsplit(".", 1)[0])
        return ""

    # ── frontmatter edits ──
    def set_fm(self, key: str, value: str) -> None:
        self.frontmatter.set_scalar(key, value)
        self.fm_dirty = self.dirty = True

    def append_fm_item(self, key: str, item: str) -> None:
        if item in self.frontmatter.get_list(key):
            return
        self.frontmatter.append_list_item(key, item)
        self.fm_dirty = self.dirty = True

    def remove_fm_item(self, key: str, item: str) -> bool:
        ok = self.frontmatter.remove_list_item(key, item)
        self.fm_dirty = self.dirty = self.dirty or ok
        return ok

    def remove_fm(self, key: str) -> bool:
        ok = self.frontmatter.remove(key)
        self.fm_dirty = self.dirty = self.dirty or ok
        return ok

    # ── body edits (whole-line splices keep separators intact) ──
    def _section_span(self, name: str) -> tuple[int, int] | None:
        for n, start, end in self._bounds():
            if n.lower() == name.lower():
                return start, end
        return None

    def append_to_section(self, name: str, text: str) -> None:
        add = text.split("\n")
        span = self._section_span(name)
        if span is None:
            if self.body_lines and self.body_lines[-1].strip() != "":
                self.body_lines.append("")
            self.body_lines.append("## " + name)
            self.body_lines.append("")
            self.body_lines.extend(add)
            self.dirty = True
            return
        start, end = span
        # trim trailing blank lines inside the section, then insert a blank + text
        last = end
        while last - 1 > start and self.body_lines[last - 1].strip() == "":
            last -= 1
        self.body_lines[last:last] = ["", *add]
        self.dirty = True

    def has_link_in_section(self, name: str, target: str) -> bool:
        s = self.section(name)
        if not s:
            return False
        t = target.lower()
        return any(tgt.lower() == t for tgt, _ in s.links())

    def remove_link_everywhere(self, target: str) -> int:
        t = target.lower()
        kept: list[str] = []
        removed = 0
        for line in self.body_lines:
            if line.strip().startswith("-") and [x.lower() for x, _ in parse_wikilinks(line)] == [t]:
                removed += 1
                continue
            kept.append(line)
        self.body_lines = kept
        self.dirty = self.dirty or removed > 0
        return removed

    def render(self) -> str:
        if not self.dirty:
            return self._raw
        body = "\n".join(self.body_lines)
        if not self.has_frontmatter and not self.fm_dirty:
            return body
        if self.has_frontmatter and not self.fm_dirty:
            fm = self.fm_block_raw
        else:
            fm = "---\n" + self.frontmatter.render() + "\n---"
        trailing = self.fm_trailing if self.has_frontmatter else "\n\n"
        return fm + trailing + body


# ── Canonical serializer for NEW notes ───────────────────────────────────────


def render_new_concept(
    *,
    slug: str,
    type_: str,
    layer: str,
    created: str,
    updated: str,
    sources: list[str],
    status: str,
    what: str,
    why: str,
    builds_on: list[str] | None = None,
    enables: list[str] | None = None,
    related: list[str] | None = None,
    diagram: str | None = None,
    examples: list[str] | None = None,
    open_questions: list[str] | None = None,
    notes: str | None = None,
    evidence: list[str] | None = None,
) -> str:
    """Canonical concept-note text, matching the knowledge-curator schema."""
    fm = [
        "---",
        f"concept: {slug}",
        f"type: {type_}",
        f"layer: {layer}",
        f"created: {created}",
        f"updated: {updated}",
    ]
    if sources:
        fm.append("sources:")
        fm.extend(f"  - {s}" for s in sources)
    fm.append(f"status: {status}")
    fm.append("---")

    body: list[str] = ["## What", what, "", "## Why it exists / why it works", why]

    def link_section(title: str, items: list[str] | None) -> None:
        if not items:
            return
        body.extend(["", f"## {title}"])
        body.extend(f"- {it}" for it in items)

    link_section("Builds on", builds_on)
    link_section("Enables", enables)
    link_section("Related (same layer)", related)
    if diagram:
        body.extend(["", "## Diagram", "", diagram])
    link_section("Real-world examples", examples)
    link_section("Open questions", open_questions)
    if notes:
        body.extend(["", "## Notes", notes])
    link_section("Evidence", evidence)
    if sources:
        body.extend(["", "## Sources"])
        body.extend(f"- {s}" for s in sources)

    return "\n".join(fm) + "\n\n" + "\n".join(body) + "\n"
