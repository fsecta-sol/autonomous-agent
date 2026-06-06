# Web Fetching Strategy — anti-bot & auth-walled sources

Riset untuk handle source-source crypto yang punya bot protection (Cloudflare Turnstile, fingerprinting) atau auth wall (Twitter/X logged-out view kosong).

**Status**: research + decision. Tidak ada install yet. Eksekusi ketika friction text-paste mulai jadi blocker.

---

## Problem recap

Agent perlu fetch URL saat user drop ke `00-Inbox/_knowledge/`. Source mainstream crypto research (Paradigm, Flashbots, ethresear.ch, vitalik.eth.limo, arxiv) **tidak ke-block** — simple HTTP fetch via Hermes default web tool sudah cukup. Lihat audit di [setup/telegram.md](telegram.md#concern-cloudflare-browsing--bot-protection).

Yang masalah:
1. **Twitter/X**: auth wall + bot detection. Logged-out view sekarang hampir kosong. URL `twitter.com/foo/status/123` gak fetch-able dari script tanpa login.
2. **CF-protected dashboards/sites**: Dune, Nansen, beberapa news media. Variable difficulty.
3. **Paywalled content**: TheBlock, beberapa Substack berbayar.

---

## Options surveyed (Juni 2026)

### 1. X MCP (Official Twitter/X MCP server)

- **What**: Official MCP server di [docs.x.com/tools/mcp](https://docs.x.com/tools/mcp). 200+ tools auto-generated dari OpenAPI X spec.
- **Auth**: OAuth 1.0a via browser consent flow. Butuh X Developer Account.
- **Capability**: search posts, create posts, user lookups, manage likes, dst. Comprehensive.
- **Cost (Juni 2026)**:
  - **Free tier**: very limited (basically untuk posting bot, bukan read firehose)
  - **Basic**: $100/bulan — ~10K posts read/month
  - **Pro**: $5000/bulan
- **Setup**: Python 3.9+, clone repo, configure OAuth, run di `localhost:8000/mcp`
- **For our use case**: cuma worth kalau lu **rela bayar $100/mo Basic minimum** dan butuh real-time monitoring spesifik akun crypto. Hobbyist research = overkill.

### 2. [Scrapling](https://github.com/d4vinci/Scrapling) (d4vinci)

- **What**: Python web scraping framework, BSD-3, 61.3k stars, latest v0.4.8 (Mei 2026 — actively maintained).
- **Anti-bot capability**:
  - Bypasses Cloudflare Turnstile **out-of-the-box**
  - TLS fingerprint impersonation (Chrome, Firefox)
  - Stealth headers + browser impersonation
  - DNS-over-HTTPS untuk proxy use
- **Multi-tier fetcher**:
  - `Fetcher` — HTTP-only, fast, dengan stealthy headers
  - `StealthyFetcher` — headless browser dengan fingerprint spoofing
  - `DynamicFetcher` — Playwright Chromium / Google Chrome full
  - `FetcherSession` / `StealthySession` / `DynamicSession` — persistent sessions
- **Performance**: parser comparable dengan Parsel, much faster dari BeautifulSoup
- **Cost**: free, BSD-3 (commercial use OK)
- **Twitter support**: ❌ generic only. Tidak punya Twitter integration. Tetap kena auth wall.
- **For our use case**: ✅ **rekomendasi utama** untuk CF-protected non-Twitter sites. Drop-in Python.

### 3. [CloakBrowser](https://github.com/CloakHQ/cloakbrowser) (CloakHQ)

- **What**: Real Chromium binary dengan 58 C++ source-level patches. Bukan fork undetected-chromedriver — modifikasi langsung di C++.
- **Bypass coverage** (verified per docs):
  - reCAPTCHA v3 (0.9 score)
  - Cloudflare Turnstile
  - FingerprintJS
  - BrowserScan
- **API**: Playwright-native. Swap satu line dari Playwright/Puppeteer.
- **Spoofing**: canvas, WebGL, audio, fonts, GPU reporting, WebRTC, CDP automation signals
- **Cost**: wrapper MIT, binary punya usage restrictions tapi free
- **Twitter support**: ❌ bypass bot ≠ bypass auth wall
- **Cons**: berat (Chromium binary, ratusan MB), platform-specific (Linux x64, Windows x64, macOS arm64/x64)
- **For our use case**: cadangan kalau Scrapling's StealthyFetcher gagal di site spesifik. Bukan default.

### 4. Alternative yang dipertimbangkan

| Tool | Verdict |
|---|---|
| **Nitter** (open Twitter frontend) | Most public instances mati 2024-2025. Self-hosted unreliable. **Skip.** |
| **twscrape / twikit / tweety-ns** | Python libs pakai user login session. Gray-area ToS, bisa ban akun. Skip kecuali risk-aware. |
| **rss-bridge / fivefilters** | RSS bridges convert Twitter ke RSS — pakai access method yang sama (mati juga). Skip. |
| **Tier 1 Twitter API tier (free)** | Posting only, gak ada bandwidth untuk read. Useless untuk research. |

---

## Recommended strategy — layered escalation

Default: **text-paste**. Eskalasi ke tooling cuma kalau friction nyata. YAGNI applied.

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 0 — Text paste (default)                                    │
│   - User copy text dari source di phone/desktop                  │
│   - Paste ke #inbox Telegram thread                              │
│   - Bot save verbatim → cron tick proses                         │
│   - Cost: $0, friction: medium, capability: 100% utk konten      │
│     yang user sudah liat                                         │
│   - Cocok untuk: Twitter, paywall yang user bisa akses,         │
│     screenshot OCR-ed nanti                                     │
└────────────────────┬────────────────────────────────────────────┘
                     │ user kasih URL only
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 — Hermes default HTTP fetch                               │
│   - Agent invoke web tool (built-in Hermes)                      │
│   - Cost: $0, capability: open-access sites                      │
│   - Cocok untuk: paradigm, flashbots, ethresear.ch, arxiv,       │
│     vitalik.eth.limo, EIPs, audit firm blogs                    │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP fetch returns CF challenge HTML / 403
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ TIER 2 — Scrapling StealthyFetcher (escalate)                    │
│   - Headless browser + fingerprint spoof                         │
│   - Cost: ~5-10s per fetch, Chromium memory                      │
│   - Cocok untuk: most CF-protected non-Twitter sites             │
└────────────────────┬────────────────────────────────────────────┘
                     │ Scrapling tetap blocked
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ TIER 3 — CloakBrowser (last resort)                              │
│   - Real Chromium dengan C++ patches                             │
│   - Cost: install heavier, regular updates                       │
│   - Cocok untuk: aggressive sites yang Scrapling gagal           │
└────────────────────┬────────────────────────────────────────────┘
                     │ All fetch methods fail (rare for non-Twitter)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ FALLBACK — Flag [NEEDS-MANUAL]                                   │
│   - Skill flag, daily log entry                                  │
│   - User intervention: paste text manual ke #inbox               │
└─────────────────────────────────────────────────────────────────┘
```

**Twitter shortcut**: skill kasih instruksi explicit untuk skip Twitter URLs dan flag `[NEEDS-TEXT]`. User paste text content sebagai gantinya.

---

## Integration plan dengan Hermes (kalau decide install Scrapling)

### Phase 1 — Standalone CLI utility

```bash
# Install di venv Hermes
source ~/.hermes/hermes-agent/venv/bin/activate
pip install scrapling
scrapling install   # download stealth deps (Playwright Chromium, etc)
```

Bikin script `scripts/fetch_url.sh` (di repo):

```bash
#!/bin/bash
# Wrapper: tier-1 HTTP first, fallback ke Scrapling StealthyFetcher
URL="$1"
TIMEOUT="${2:-30}"

source /home/hermes/.hermes/hermes-agent/venv/bin/activate

python3 - <<PY
import sys
url = "$URL"

# Tier 1: simple HTTP
import urllib.request
try:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
    })
    with urllib.request.urlopen(req, timeout=$TIMEOUT) as r:
        body = r.read().decode("utf-8", errors="ignore")
    if "Just a moment" in body or ("Cloudflare" in body[:5000] and "challenge" in body[:5000]):
        raise Exception("CF challenge detected, escalating")
    print(body)
    sys.exit(0)
except Exception as e:
    print(f"# tier-1 failed: {e}", file=sys.stderr)

# Tier 2: Scrapling StealthyFetcher
try:
    from scrapling.fetchers import StealthyFetcher
    page = StealthyFetcher.fetch(url, headless=True)
    print(page.html_content)
    sys.exit(0)
except Exception as e:
    print(f"# tier-2 failed: {e}", file=sys.stderr)
    sys.exit(1)
PY
```

Thin wrapper ke `~/.hermes/scripts/fetch_url.sh` (sama pattern dengan process_inbox).

### Phase 2 — Agent integration

Update `skills/knowledge-curator/SKILL.md` step 4 (active source gathering): kalau default web tool gagal, agent fallback ke `terminal fetch_url.sh <URL>` via Bash. Skill bisa instruct tool fallback.

Atau Phase 3 — bikin Hermes plugin yang register Scrapling sebagai default web provider, replacing Hermes built-in. Lebih bersih tapi lebih effort.

---

## Triggers untuk eksekusi

Implement Scrapling ketika:

- Setelah 2+ minggu agent jalan, lu nemu **≥5 incidents** dimana Tier 1 fetch gagal di non-Twitter source yang lu butuh
- `[NEEDS-MANUAL]` flag muncul >3x/minggu di daily log
- Lu drop URL non-Twitter ke #inbox dan concept yang dihasilkan agent thin/lacking karena fetch failed

**Tidak implement** kalau:
- Friction text-paste manageable (lu rajin copy-text)
- Source yang lu konsumsi semua open-access
- Token cost dari fetch failures masih kecil

Implement X MCP ketika:
- Lu rela commit **$100+/bulan Basic tier**
- Use case spesifik: monitor specific KOL/researcher firehose harian, atau alpha hunting yang Twitter-first

CloakBrowser ketika:
- Scrapling StealthyFetcher gagal di site spesifik yang lu butuh > 3 kali
- Lu OK dengan install heavy + maintenance

---

## Cost-benefit summary

| Tier | Setup effort | Runtime cost per fetch | Coverage |
|---|---|---|---|
| 0 — Text paste | 0 (manual) | $0 | 100% jika user akses |
| 1 — HTTP default | 0 (sudah ada) | ~$0 | 70% sites |
| 2 — Scrapling | ~1 jam install + integration | ~5-10s per fetch | ~95% non-auth sites |
| 3 — CloakBrowser | ~2 jam install + tuning | ~10-20s per fetch | ~99% non-auth sites |
| X MCP | ~2 jam OAuth setup | $100+/mo + API rate limits | Twitter-only |

---

## Decision (Juni 2026)

**Sekarang**: stick dengan Tier 0 + 1. Text-paste untuk Twitter, default HTTP fetch untuk yang lain. Skill flag `[NEEDS-MANUAL]` untuk yang gagal.

**Re-evaluate**: kalau setelah 2 minggu pakai, friction text-paste atau coverage gap mulai nyata. Install Scrapling sebagai Phase 1 standalone CLI. Phase 2 agent integration nyusul.

**Skip permanently** (sampai ada kasus konkret): X MCP, CloakBrowser, Nitter, twscrape.

---

## Sources

- [X MCP documentation](https://docs.x.com/tools/mcp)
- [Scrapling GitHub (d4vinci/Scrapling)](https://github.com/d4vinci/Scrapling)
- [CloakBrowser GitHub (CloakHQ/cloakbrowser)](https://github.com/CloakHQ/cloakbrowser)
- Companion: [setup/telegram.md](telegram.md) untuk Cloudflare scoping awal dan text-paste strategy
- Companion: [skills/knowledge-curator/SKILL.md](../skills/knowledge-curator/SKILL.md) untuk active source gathering rules
