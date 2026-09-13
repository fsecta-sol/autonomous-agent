"""In-memory BM25 search over the notes vault. Faithful port of the old TS
vault-index.ts: the corpus is small, so the win is caching it and ranking with
BM25 (title > tag > body) rather than re-reading files per query. The index is
rebuilt lazily, and only when a cheap signature shows the vault changed."""

import math
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from ..config import vault_root

ALLOWED_EXT = {".md", ".txt"}
SKIP_DIRS = {".obsidian", ".git", ".stfolder", "node_modules"}

# BM25 constants and per-field weights: a title hit outranks a tag, a tag a body.
K1 = 1.2
B = 0.75
W_TITLE = 6
W_TAG = 4
W_BODY = 1
SNIPPET_PAD = 90

TOKEN_RE = re.compile(r"[a-z0-9]+")
FRONTMATTER_LINE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")
HEADING_RE = re.compile(r"^#\s+(.+)$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")

REVALIDATE_SECONDS = 2.0


@dataclass
class Doc:
    rel: str
    abs: str
    mtime: float
    title: str
    concept: str
    layer: str
    type: str
    status: str
    body: str


@dataclass
class Index:
    signature: str
    docs: list[Doc] = field(default_factory=list)
    # term -> doc id -> [title_count, tag_count, body_count]
    postings: dict[str, dict[int, list[int]]] = field(default_factory=dict)
    lengths: list[tuple[int, int, int]] = field(default_factory=list)
    avg: tuple[float, float, float] = (0.0, 0.0, 0.0)
    doc_count: int = 0


def tokenize(text: str) -> list[str]:
    return TOKEN_RE.findall(text.lower())


def _walk() -> list[tuple[str, str, float, int]]:
    """Walk the vault; return (abs, rel, mtime, size) for allowed note files."""
    root = vault_root()
    out: list[tuple[str, str, float, int]] = []
    if not root.is_dir():
        return out
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.name in SKIP_DIRS or (entry.name.startswith(".") and entry.is_dir()):
                continue
            try:
                if entry.is_dir():
                    stack.append(entry)
                elif entry.is_file() and entry.suffix.lower() in ALLOWED_EXT:
                    st = entry.stat()
                    out.append((str(entry), str(entry.relative_to(root)), st.st_mtime, st.st_size))
            except OSError:
                continue
    return out


def _signature(files: list[tuple[str, str, float, int]]) -> str:
    total = sum(f[3] for f in files)
    max_mtime = max((f[2] for f in files), default=0.0)
    return f"{len(files)}:{total}:{round(max_mtime)}"


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    meta: dict[str, str] = {}
    if not text.startswith("---"):
        return meta, text
    end = text.find("\n---", 3)
    if end == -1:
        return meta, text
    block = text[3:end]
    nl = text.find("\n", end + 1)
    body = text[nl + 1 :] if nl != -1 else ""
    for line in block.split("\n"):
        m = FRONTMATTER_LINE.match(line)
        if m:
            meta[m.group(1).lower()] = m.group(2).strip()
    return meta, body


def _title_of(body: str, rel: str) -> str:
    m = HEADING_RE.search(body)
    if m:
        return m.group(1).strip()
    return Path(rel).stem


def _build(files: list[tuple[str, str, float, int]]) -> Index:
    docs: list[Doc] = []
    for abs_path, rel, mtime, _size in files:
        try:
            raw = Path(abs_path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta, body = _parse_frontmatter(raw)
        docs.append(
            Doc(
                rel=rel,
                abs=abs_path,
                mtime=mtime,
                title=_title_of(body, rel),
                concept=meta.get("concept", ""),
                layer=meta.get("layer", ""),
                type=meta.get("type", ""),
                status=meta.get("status", ""),
                body=body,
            )
        )

    postings: dict[str, dict[int, list[int]]] = {}
    lengths: list[tuple[int, int, int]] = []
    sum_title = sum_tag = sum_body = 0
    for doc_id, doc in enumerate(docs):
        title_toks = tokenize(doc.title)
        tag_toks = tokenize(f"{doc.concept} {doc.layer} {doc.type}")
        body_toks = tokenize(doc.body)
        lengths.append((len(title_toks), len(tag_toks), len(body_toks)))
        sum_title += len(title_toks)
        sum_tag += len(tag_toks)
        sum_body += len(body_toks)

        for field_idx, toks in enumerate((title_toks, tag_toks, body_toks)):
            for term in toks:
                by_doc = postings.setdefault(term, {})
                counts = by_doc.setdefault(doc_id, [0, 0, 0])
                counts[field_idx] += 1

    n = len(docs) or 1
    return Index(
        signature=_signature(files),
        docs=docs,
        postings=postings,
        lengths=lengths,
        avg=(sum_title / n, sum_tag / n, sum_body / n),
        doc_count=len(docs),
    )


_index: Index | None = None
_checked_at = 0.0


def get_index() -> Index:
    """The index. Within the revalidate window it is returned with no disk I/O;
    otherwise the vault is re-walked and rebuilt only if its signature changed."""
    global _index, _checked_at
    now = time.monotonic()
    if _index is not None and now - _checked_at < REVALIDATE_SECONDS:
        return _index
    files = _walk()
    sig = _signature(files)
    _checked_at = now
    if _index is not None and _index.signature == sig:
        return _index
    _index = _build(files)
    return _index


def _bm25(tf: int, length: int, avg_len: float, idf: float) -> float:
    if tf == 0:
        return 0.0
    norm = (1 - B + B * (length / avg_len)) if avg_len > 0 else 1.0
    return idf * ((tf * (K1 + 1)) / (tf + K1 * norm))


def _snippet_around(body: str, terms: Iterable[str]) -> str:
    lower = body.lower()
    at = -1
    for t in terms:
        i = lower.find(t)
        if i != -1 and (at == -1 or i < at):
            at = i
    if at == -1:
        start = 0
        stripped = body.lstrip()
        start = len(body) - len(stripped) if stripped else 0
        return " ".join(body[start : start + SNIPPET_PAD * 2].split())
    frm = max(0, at - SNIPPET_PAD)
    to = min(len(body), at + SNIPPET_PAD)
    prefix = "…" if frm > 0 else ""
    suffix = "…" if to < len(body) else ""
    return prefix + " ".join(body[frm:to].split()) + suffix


def search(query: str, limit: int = 8) -> list[dict]:
    idx = get_index()
    phrases: list[str] = []

    def _strip_phrases(match: re.Match) -> str:
        q = match.group(1).strip().lower()
        if q:
            phrases.append(q)
        return " "

    without = re.sub(r'"([^"]+)"', _strip_phrases, query)
    terms = list(dict.fromkeys(tokenize(without)))
    if not terms and not phrases:
        return []

    scores: dict[int, float] = {}
    for term in terms:
        by_doc = idx.postings.get(term)
        if not by_doc:
            continue
        df = len(by_doc)
        idf = math.log(1 + (idx.doc_count - df + 0.5) / (df + 0.5))
        for doc_id, counts in by_doc.items():
            lt, lg, lb = idx.lengths[doc_id]
            s = (
                W_TITLE * _bm25(counts[0], lt, idx.avg[0], idf)
                + W_TAG * _bm25(counts[1], lg, idx.avg[1], idf)
                + W_BODY * _bm25(counts[2], lb, idx.avg[2], idf)
            )
            scores[doc_id] = scores.get(doc_id, 0.0) + s

    candidates = list(scores.keys())
    if phrases:
        ok: list[int] = []
        for doc_id in candidates or range(len(idx.docs)):
            doc = idx.docs[doc_id]
            hay = f"{doc.title}\n{doc.concept} {doc.layer} {doc.type}\n{doc.body}".lower()
            hits = 0
            all_present = True
            for p in phrases:
                count = hay.count(p)
                if count == 0:
                    all_present = False
                    break
                hits += count
            if all_present:
                ok.append(doc_id)
                scores[doc_id] = scores.get(doc_id, 0.0) + hits
        candidates = ok

    candidates.sort(key=lambda d: scores.get(d, 0.0), reverse=True)
    out: list[dict] = []
    for doc_id in candidates[: max(1, limit)]:
        d = idx.docs[doc_id]
        out.append(
            {
                "path": d.rel,
                "title": d.title,
                "concept": d.concept,
                "layer": d.layer,
                "type": d.type,
                "status": d.status,
                "score": round(scores.get(doc_id, 0.0) * 100) / 100,
                "snippet": _snippet_around(d.body, [*terms, *phrases]),
            }
        )
    return out


def list_docs(folder: str | None = None) -> list[dict]:
    idx = get_index()
    prefix = folder.strip("/") if folder else ""
    result = []
    for d in idx.docs:
        if prefix and not (d.rel == prefix or d.rel.startswith(prefix + "/")):
            continue
        result.append({"path": d.rel, "size": len(d.body.encode("utf-8"))})
    result.sort(key=lambda x: x["path"])
    return result


def read_doc(rel: str) -> Doc:
    idx = get_index()
    key = rel.lstrip("/")
    for d in idx.docs:
        if d.rel == key or d.rel == key + ".md" or d.rel == key + ".txt":
            return d
    raise KeyError(f"note not found: {rel}")


def links(rel: str) -> dict:
    idx = get_index()
    doc = read_doc(rel)
    mine = next(d for d in idx.docs if d.rel == doc.rel)
    out = list(dict.fromkeys(m.group(1).strip() for m in WIKILINK_RE.finditer(mine.body)))

    wanted = {mine.title.lower(), re.sub(r"\.(md|txt)$", "", doc.rel, flags=re.IGNORECASE).lower()}
    inbound = []
    for d in idx.docs:
        if d.rel == mine.rel:
            continue
        for m in WIKILINK_RE.finditer(d.body):
            if m.group(1).strip().lower() in wanted:
                inbound.append({"path": d.rel, "title": d.title})
                break
    return {"out": out, "in": inbound}
