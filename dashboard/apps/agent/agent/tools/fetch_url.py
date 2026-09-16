"""fetch_url — read a public web page, with anti-bot escalation.

Two tiers, mirroring the operator's proven `scripts/fetch_url.sh` strategy:

  Tier 1 — `scrapling.Fetcher`: plain HTTP with a real browser TLS fingerprint
           and stealthy headers. Fast (~0.3-2s), clears many Cloudflare-fronted
           sites outright. Runs in-process.
  Tier 2 — `scrapling.StealthyFetcher`: a headless browser with fingerprint
           spoofing that can also *solve* a Cloudflare Turnstile/Interstitial
           challenge. Slower (a few seconds) and heavier. Runs as a subprocess so
           an over-budget fetch is *killable* — the Cloudflare solver loops up to
           3 hardcoded attempts with no exposed timeout, so a thread could not be
           stopped and would leak a browser.

Escalation is triggered only by an *actual* Cloudflare block — the `cf-mitigated`
response header, or a 403/503/429 whose `server` is cloudflare — never by guessing
at the body. A caller can force a tier with `mode`.

Content is returned as clean text: main-content Markdown for HTML, extracted text
for PDFs, decoded body for plain text. SSRF is guarded by hostname on the
requested URL (see `_is_blocked_host`); only GETs to http/https are allowed.
"""

import asyncio
import ipaddress
import json
import logging
import os
import shutil
import signal
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from langchain_core.tools import tool

from ..config import (
    fetch_browser_enabled,
    fetch_browser_timeout_s,
    fetch_cache_ttl_s,
    fetch_max_browsers,
    fetch_timeout_s,
)
from ._fetch_render import norm_headers, render_response
from .builtin import dumps

log = logging.getLogger("agent.tools.fetch_url")

MAX_TEXT_CHARS = 20_000
MAX_CACHE_ENTRIES = 128

_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal")

# statuses Cloudflare uses when it serves a challenge instead of the page
_CF_STATUSES = (403, 429, 503)

# The package root (dir containing the `agent` package), so the browser worker
# subprocess can import it regardless of the server's cwd.
_PKG_ROOT = str(Path(__file__).resolve().parents[2])


def _is_blocked_host(hostname: str) -> bool:
    """Block obvious SSRF targets. (Full DNS-rebind protection is out of scope.)"""
    h = hostname.lower().strip("[]")
    if h == "localhost" or h.endswith(_BLOCKED_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_unspecified


def _looks_cf_blocked(status: int, headers: dict[str, str]) -> bool:
    """True when Cloudflare explicitly challenged/blocked this response."""
    if "cf-mitigated" in headers:
        return True
    return status in _CF_STATUSES and "cloudflare" in headers.get("server", "").lower()


# --- cache -------------------------------------------------------------------

_cache: dict[str, tuple[float, dict]] = {}


def _cache_get(url: str) -> dict | None:
    entry = _cache.get(url)
    if entry and entry[0] > time.time():
        return entry[1]
    if entry:
        _cache.pop(url, None)
    return None


def _cache_put(url: str, payload: dict, ttl: float) -> None:
    if ttl <= 0:
        return
    if len(_cache) >= MAX_CACHE_ENTRIES:
        # drop the oldest-ish entry; a full LRU is overkill for this cache
        _cache.pop(next(iter(_cache)), None)
    _cache[url] = (time.time() + ttl, payload)


# --- browser concurrency guard ----------------------------------------------

_browser_sem: asyncio.Semaphore | None = None


def _browser_semaphore() -> asyncio.Semaphore:
    global _browser_sem
    if _browser_sem is None:
        _browser_sem = asyncio.Semaphore(fetch_max_browsers())
    return _browser_sem


def _ok(status: int) -> bool:
    return 200 <= status < 300


# --- fetch tiers -------------------------------------------------------------


def _fetch_fast(url: str, timeout: float):
    from scrapling.fetchers import Fetcher

    return Fetcher.get(url, stealthy_headers=True, timeout=timeout)


async def _run_fast(url: str) -> tuple[int, dict | None, dict[str, str]]:
    """Tier 1, in-process. Returns (status, payload_or_None, headers)."""
    response = await asyncio.to_thread(_fetch_fast, url, fetch_timeout_s())
    headers = norm_headers(response)
    status = int(getattr(response, "status", 0) or 0)
    if not _ok(status):
        return status, None, headers
    return status, render_response(response, getattr(response, "url", url)), headers


def _browser_cmd() -> list[str]:
    """The worker command. Wrapped in `xvfb-run` when there's no display: the
    worker runs headful (Cloudflare's Turnstile detects headless), and xvfb-run
    gives it a virtual display."""
    base = [sys.executable, "-m", "agent.tools._fetch_worker"]
    if not os.environ.get("DISPLAY") and shutil.which("xvfb-run"):
        return ["xvfb-run", "-a", *base]
    return base


async def _run_browser(url: str) -> dict:
    """Tier 2, as a hard-killable subprocess bounded by the wall-clock cap."""
    cap = fetch_browser_timeout_s()
    env = {**os.environ, "PYTHONPATH": _PKG_ROOT + os.pathsep + os.environ.get("PYTHONPATH", "")}
    async with _browser_semaphore():
        proc = await asyncio.create_subprocess_exec(
            *_browser_cmd(),
            url,
            str(int(cap * 1000)),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=_PKG_ROOT,
            # Own process group, so a timeout can kill the whole tree
            # (xvfb-run + Xvfb + chromium), not just the launcher.
            start_new_session=True,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=cap)
        except TimeoutError:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                proc.kill()
            await proc.wait()
            return {"status": 0, "error": f"browser timed out after {cap:.0f}s"}
    if err:
        log.debug("browser worker stderr: %s", err.decode("utf-8", "replace")[-500:])
    for line in reversed(out.decode("utf-8", "replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {"status": 0, "error": "browser worker returned no result"}


async def _fetch(url: str, mode: str) -> dict:
    """The tiered fetch. Returns the payload dict (may carry an `error`)."""
    if mode in ("auto", "fast"):
        try:
            status, payload, headers = await _run_fast(url)
            if payload is not None:
                return {"status": status, "tier": "http", **payload}
            blocked = _looks_cf_blocked(status, headers)
            if mode == "fast" or not blocked or not fetch_browser_enabled():
                reason = "blocked by Cloudflare" if blocked else f"HTTP {status}"
                return {"status": status, "tier": "http", "error": reason}
            log.info("fetch_url: CF block (status %s), escalating to browser tier", status)
        except Exception as err:  # noqa: BLE001 — returned to the caller as a fetch error
            # Browser escalation is reserved for an explicit Cloudflare signal.
            # DNS failures, TLS errors, and dead domains cannot be fixed by a
            # browser and launching one for them wastes a slot and minutes.
            return {"status": 0, "error": f"fetch failed: {err}"}

    if not fetch_browser_enabled():
        return {"status": 0, "error": "browser tier is disabled"}

    try:
        result = await _run_browser(url)
    except Exception as err:  # noqa: BLE001 — surfaced to the caller as an error string
        return {"status": 0, "error": f"browser fetch failed: {err}"}
    return {**result, "tier": "browser"}


@tool
async def fetch_url(url: str, mode: str = "auto") -> str:
    """Fetch a public web page and return its text content (HTML stripped,
    truncated). Use to read documentation or articles the user references by URL.

    Handles Cloudflare-protected pages automatically: it tries a fast HTTP fetch
    first and escalates to a headless browser that can solve a Cloudflare
    challenge when the fast tier is blocked. An SPA that needs JavaScript to
    render also needs the browser tier — pass mode="browser".

    Args:
        url: The page to fetch (http or https).
        mode: "auto" (fast, escalate to browser on a Cloudflare block),
            "fast" (HTTP only), or "browser" (force the headless browser).
    """
    raw = (url or "").strip()
    if not raw:
        return dumps({"error": "url is required"})
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        return dumps({"error": "only http and https are allowed"})
    if not parsed.hostname or _is_blocked_host(parsed.hostname):
        return dumps({"error": "that host is not reachable"})

    mode = mode if mode in ("auto", "fast", "browser") else "auto"
    # Only the auto path is cached: it is the default and most common, and a
    # forced-browser result should not be replayed for a fast request.
    if mode == "auto":
        cached = _cache_get(raw)
        if cached is not None:
            return dumps({**cached, "cached": True})

    payload = await _fetch(raw, mode)
    if "error" in payload:
        return dumps({"url": raw, "error": payload["error"], "status": payload.get("status")})

    text = payload.get("text", "")
    result = {
        "url": raw,
        "status": payload.get("status"),
        "tier": payload.get("tier"),
        "contentType": payload.get("contentType", ""),
        "truncated": len(text) > MAX_TEXT_CHARS,
        "text": text[:MAX_TEXT_CHARS],
    }
    if mode == "auto":
        _cache_put(raw, result, fetch_cache_ttl_s())
    return dumps(result)
