"""Small text utilities for the evaluator — tokenisation, overlap, similarity.

Kept local (not imported from `gaps`) so the evaluator has no dependency on the
gap detector's stoplist: evaluation and gap-finding answer different questions
and should be tunable independently.
"""

from __future__ import annotations

import re

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9-]{2,}")

# Function words only — the evaluator must NOT strip domain terms the way a
# success-criterion parser might, because it compares actual research text.
_STOP = {
    "the", "and", "for", "with", "how", "does", "did", "what", "why", "when", "which", "who", "whom",
    "into", "from", "that", "this", "these", "those", "are", "was", "were", "has", "have", "had",
    "can", "could", "would", "should", "not", "its", "it's", "their", "there", "here", "some", "any",
    "all", "each", "every", "other", "another", "more", "most", "less", "least", "such", "same",
    "about", "over", "under", "against", "between", "within", "without", "also", "then", "than",
    "them", "you", "your", "our", "but", "yet", "via", "per", "out", "off", "own", "so", "to", "of",
    "in", "on", "at", "by", "as", "is", "be", "it", "or", "an", "a", "we", "us", "if", "no", "yes",
}


def words(text: str) -> list[str]:
    return _WORD_RE.findall((text or "").lower())


def content_tokens(text: str) -> set[str]:
    """Lowercased content-bearing terms (function words removed)."""
    return {w for w in words(text) if w not in _STOP}


def norm(text: str) -> str:
    """Normalise for equality/containment comparisons."""
    return " ".join((text or "").lower().split())


def jaccard(a: str | set[str], b: str | set[str]) -> float:
    """Token-set Jaccard similarity in [0, 1]."""
    sa = a if isinstance(a, set) else content_tokens(a)
    sb = b if isinstance(b, set) else content_tokens(b)
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def overlap_ratio(query: str, text: str) -> float:
    """Fraction of the query's content terms present in `text` (0..1).

    Asymmetric on purpose: for relevance we ask "how much of what we wanted does
    this answer?" not "how similar are the two strings?".
    """
    q = content_tokens(query)
    if not q:
        return 0.0
    t = content_tokens(text)
    return len(q & t) / len(q)


def is_substantive(text: str, *, min_tokens: int = 3) -> bool:
    """Whether a statement carries enough content to be evaluated — length alone
    is not quality, but a two-word fragment cannot be a finding."""
    return len(content_tokens(text)) >= min_tokens


def clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def mean(values: list[float], default: float = 0.0) -> float:
    return sum(values) / len(values) if values else default
