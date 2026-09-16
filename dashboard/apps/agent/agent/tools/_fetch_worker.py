"""The browser-tier fetch, run as a killable subprocess.

`StealthyFetcher`'s Cloudflare solver loops up to 3 hardcoded attempts with its
own waits, and no exposed timeout bounds it — a challenge it can't clear runs for
two minutes. As a plain thread it could not be stopped (a browser thread ignores
cancellation), so an over-budget fetch would leak a browser. Run as a subprocess
instead and the parent gets a hard kill, the same isolation `fetch_url.sh` uses.

Headless is the difference between solving and not: Cloudflare's managed/
interstitial Turnstile detects a headless browser and never clears, so this runs
*headful*. With no `DISPLAY` the parent wraps us in `xvfb-run`, which provides a
virtual display; if one is already set we use it. Headless is only a last resort
when neither is available (a challenge then usually cannot be solved).

Invoked as `python -m agent.tools._fetch_worker <url> <timeout_ms>`. Prints one
JSON line: the render payload on success, or {"error": ...} on failure.
"""

import json
import os
import sys


def main() -> None:
    url = sys.argv[1]
    timeout_ms = int(sys.argv[2])
    # Headful when a display is available (under xvfb-run, DISPLAY is set).
    headless = not bool(os.environ.get("DISPLAY"))
    try:
        from scrapling.fetchers import StealthyFetcher

        from ._fetch_render import norm_headers, render_response

        response = StealthyFetcher.fetch(
            url,
            headless=headless,
            solve_cloudflare=True,
            network_idle=True,
            timeout=timeout_ms,
        )
        status = int(getattr(response, "status", 0) or 0)
        headers = norm_headers(response)
        if not (200 <= status < 300):
            cf = "blocked by Cloudflare" if "cloudflare" in headers.get("server", "").lower() else f"HTTP {status}"
            print(json.dumps({"status": status, "error": cf}))
            return
        payload = render_response(response, getattr(response, "url", url))
        print(json.dumps({"status": status, **payload}))
    except Exception as err:  # noqa: BLE001 — the parent reads this as a string, never a traceback
        print(json.dumps({"status": 0, "error": f"browser fetch failed: {err}"}))


if __name__ == "__main__":
    main()
