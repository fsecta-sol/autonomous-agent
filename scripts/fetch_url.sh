#!/bin/bash
# fetch_url.sh — layered web fetch with Cloudflare Turnstile bypass.
#
# Strategy:
#   Tier 1: Scrapling Fetcher (HTTP + TLS impersonation + stealthy headers).
#           Fast (~0.3s). Works for non-aggressive sites.
#   Tier 2: Scrapling StealthyFetcher with solve_cloudflare=True (browser).
#           Slower (~4-8s). Solves Turnstile challenges.
#
# Detects CF challenge via response body markers, escalates only when needed.
#
# Usage:
#   ./fetch_url.sh <URL> [timeout_seconds]
#
# Outputs:
#   Page HTML to stdout (final body, after any escalation).
#   Tier transitions and errors to stderr (lines start with "# ").
#
# Exit:
#   0 = success (HTML written to stdout)
#   1 = all tiers failed
#   2 = bad usage

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <URL> [timeout_seconds]" >&2
  exit 2
fi

URL="$1"
TIMEOUT="${2:-30}"
HERMES_VENV="${HERMES_VENV:-/home/hermes/.hermes/hermes-agent/venv}"

if [ ! -d "$HERMES_VENV" ]; then
  echo "# error: Hermes venv not found at $HERMES_VENV" >&2
  echo "# set HERMES_VENV env var to override" >&2
  exit 1
fi

# Run python in the venv. Pass URL+timeout as argv to avoid quoting hell.
"$HERMES_VENV/bin/python3" - "$URL" "$TIMEOUT" <<'PY'
import sys

url = sys.argv[1]
timeout = int(sys.argv[2])

CF_CHALLENGE_MARKERS = (
    "just a moment",
    "checking your browser",
    "verifying you are human",
    "verify you are",
)

def looks_like_challenge(html: str) -> bool:
    body = html.lower()
    return any(m in body for m in CF_CHALLENGE_MARKERS)

# ===== Tier 1: HTTP Fetcher (TLS impersonation, stealth headers) =====
try:
    from scrapling.fetchers import Fetcher
    page = Fetcher.get(url, stealthy_headers=True, timeout=timeout)
    html = page.html_content
    if not looks_like_challenge(html):
        sys.stdout.write(html)
        sys.exit(0)
    print("# tier-1: CF challenge detected in response body, escalating to tier-2",
          file=sys.stderr)
except Exception as e:
    print(f"# tier-1 failed: {type(e).__name__}: {e}", file=sys.stderr)

# ===== Tier 2: StealthyFetcher with solve_cloudflare=True =====
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(
        url,
        headless=True,
        solve_cloudflare=True,
        network_idle=True,
        timeout=timeout * 3000,  # milliseconds; browser needs more headroom
    )
    sys.stdout.write(page.html_content)
    sys.exit(0)
except Exception as e:
    print(f"# tier-2 failed: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
PY
