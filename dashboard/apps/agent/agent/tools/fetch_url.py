"""fetch_url — read a public web page. Port of the TS builtin fetch_url:
SSRF-guarded by hostname, size- and time-capped, HTML stripped to text."""

import ipaddress
import re
from urllib.parse import urlparse

import httpx
from langchain_core.tools import tool

from .builtin import dumps

FETCH_TIMEOUT_SECONDS = 10.0
MAX_BYTES = 200_000
MAX_TEXT_CHARS = 20_000

_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal")
_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"<script[\s\S]*?</script>", re.IGNORECASE)
_STYLE_RE = re.compile(r"<style[\s\S]*?</style>", re.IGNORECASE)


def _is_blocked_host(hostname: str) -> bool:
    """Block obvious SSRF targets. (Full DNS-rebind protection is out of scope.)"""
    h = hostname.lower().strip("[]")
    if h == "localhost" or h.endswith(_BLOCKED_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_unspecified
    )


def _strip_html(text: str) -> str:
    text = _SCRIPT_RE.sub(" ", text)
    text = _STYLE_RE.sub(" ", text)
    text = _TAG_RE.sub(" ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    text = re.sub(r"[ \t\f\v]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


@tool
def fetch_url(url: str) -> str:
    """Fetch a public web page over http/https and return its text content (HTML
    stripped, truncated). Use to read documentation or articles the user
    references by URL."""
    raw = (url or "").strip()
    if not raw:
        return dumps({"error": "url is required"})
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        return dumps({"error": "only http and https are allowed"})
    if not parsed.hostname or _is_blocked_host(parsed.hostname):
        return dumps({"error": "that host is not reachable"})

    try:
        with httpx.Client(follow_redirects=True, timeout=FETCH_TIMEOUT_SECONDS) as client:
            res = client.get(
                raw,
                headers={"User-Agent": "dashboard-agent/1.0", "Accept": "text/html,text/plain,*/*"},
            )
    except httpx.HTTPError as err:
        return dumps({"error": f"fetch failed: {err}"})

    if res.status_code >= 400:
        return dumps({"error": f"HTTP {res.status_code}", "url": raw})

    body = res.content[:MAX_BYTES]
    truncated = len(res.content) > MAX_BYTES
    content_type = res.headers.get("content-type", "")
    text = body.decode("utf-8", errors="replace")
    if "html" in content_type:
        text = _strip_html(text)
    return dumps(
        {
            "url": raw,
            "contentType": content_type,
            "truncated": truncated,
            "text": text[:MAX_TEXT_CHARS],
        }
    )
