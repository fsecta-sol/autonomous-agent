#!/bin/bash
# fetch_url.sh — layered web fetch with Cloudflare Turnstile bypass.
#
# Strategy:
#   Tier 1: Scrapling Fetcher (HTTP + TLS impersonation + stealthy headers).
#           Fast (~0.3-2s). Bypasses MANY CF Turnstile sites already (TLS
#           fingerprint + referer trick is surprisingly effective).
#   Tier 2: Scrapling StealthyFetcher with solve_cloudflare=True (browser).
#           Slower (~4-8s). Solves Turnstile challenges that defeat Tier 1.
#
# Auto-escalates from Tier 1 to Tier 2 ONLY when CF actually blocked the
# request (signaled by `cf-mitigated` response header or HTTP 403/503 with
# `server: cloudflare`). No flaky body-pattern guessing.
#
# For pages that need JS rendering (SPAs like app.uniswap.org), pass --stealth
# explicitly to skip Tier 1 — Tier 2's browser will execute JS.
#
# Usage:
#   fetch_url.sh [--stealth] <URL> [timeout_seconds]
#
# Outputs:
#   Page HTML to stdout.
#   Tier transitions and errors to stderr (lines start with "# ").
#
# Exit:
#   0 = success
#   1 = all tiers failed
#   2 = bad usage

set -euo pipefail

STEALTH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stealth) STEALTH=1; shift ;;
    --) shift; break ;;
    -*) echo "# unknown flag: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ $# -lt 1 ]; then
  echo "Usage: $0 [--stealth] <URL> [timeout_seconds]" >&2
  exit 2
fi

URL="$1"
TIMEOUT="${2:-30}"
HERMES_VENV="${HERMES_VENV:-/home/hermes/.hermes/hermes-agent/venv}"

if [ ! -d "$HERMES_VENV" ]; then
  echo "# error: Hermes venv not found at $HERMES_VENV" >&2
  exit 1
fi

"$HERMES_VENV/bin/python3" - "$URL" "$TIMEOUT" "$STEALTH" <<'PY'
import sys

url = sys.argv[1]
timeout = int(sys.argv[2])
force_stealth = sys.argv[3] == "1"

def is_cf_blocked(page):
    """Return True if CF explicitly mitigated this request (challenge served)."""
    try:
        headers = {k.lower(): v for k, v in dict(page.headers).items()}
    except Exception:
        return False
    if "cf-mitigated" in headers:
        return True
    status = getattr(page, "status", 0)
    server = headers.get("server", "").lower()
    if status in (403, 503, 429) and "cloudflare" in server:
        return True
    return False

# ===== Tier 1 (skip if --stealth) =====
if not force_stealth:
    try:
        from scrapling.fetchers import Fetcher
        page = Fetcher.get(url, stealthy_headers=True, timeout=timeout)
        if is_cf_blocked(page):
            print("# tier-1: CF challenge detected via headers, escalating to tier-2",
                  file=sys.stderr)
        else:
            sys.stdout.write(page.html_content)
            sys.exit(0)
    except Exception as e:
        print(f"# tier-1 failed: {type(e).__name__}: {e}", file=sys.stderr)
else:
    print("# tier-1 skipped (--stealth flag)", file=sys.stderr)

# ===== Tier 2: StealthyFetcher with solve_cloudflare =====
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(
        url,
        headless=True,
        solve_cloudflare=True,
        network_idle=True,
        timeout=timeout * 3000,  # milliseconds
    )
    sys.stdout.write(page.html_content)
    sys.exit(0)
except Exception as e:
    print(f"# tier-2 failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
PY
