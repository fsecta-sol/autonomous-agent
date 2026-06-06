# Web Fetching Strategy — anti-bot & auth-walled sources

Riset untuk handle source-source crypto yang punya bot protection (Cloudflare Turnstile, fingerprinting) atau auth wall (Twitter/X logged-out view kosong).

**Status**: **Scrapling tested + verified (2026-06-06)**. Tier 2 (StealthyFetcher dengan `solve_cloudflare=True`) berhasil bypass Cloudflare Turnstile pada test lab + real-world crypto site. Install di Hermes venv selesai. **Integration ke skill belum** — masih opsional.

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

## Test results — 2026-06-06

Test eksplisit untuk validate klaim Scrapling "Bypasses Cloudflare Turnstile out-of-the-box".

### Setup

Install Scrapling di `~/.hermes/hermes-agent/venv` ada **nuansa** — `scrapling install` (auto setup CLI) **gagal** karena salah panggil system Python alih-alih venv Python. Manual install sequence:

```bash
# 1. venv-nya gak punya pip — bootstrap dulu
~/.hermes/hermes-agent/venv/bin/python3 -m ensurepip --upgrade

# 2. Install scrapling + optional runtime deps yang tidak ke-auto-pull
~/.hermes/hermes-agent/venv/bin/python3 -m pip install \
  scrapling playwright camoufox patchright msgspec "curl_cffi[binary]"

# 3. Download Playwright Chromium binary
~/.hermes/hermes-agent/venv/bin/python3 -m playwright install chromium

# 4. System libs (Chromium butuh — fail tanpa ini dengan libcups.so.2 error)
sudo ~/.hermes/hermes-agent/venv/bin/python3 -m playwright install-deps chromium
```

Total disk footprint: ~600MB (Chromium binary dominasinya).

### Test 1 — nowsecure.nl (lab anti-bot, aggressive CF Turnstile)

| Tier | Method | Result | Elapsed |
|---|---|---|---|
| Baseline | `urllib` no stealth | Challenge page served | <1s |
| 1 | `Fetcher.get(stealthy_headers=True)` | ❌ Challenge page served (no bypass) | 0.3s |
| 2 | `StealthyFetcher.fetch(headless=True)` (no `solve_cloudflare`) | ❌ Challenge page served (no bypass) | 8s |
| **2b** | **`StealthyFetcher.fetch(solve_cloudflare=True)`** | ✅ **Bypassed**, real content delivered | **4s** |

Tier 2b log:
```
INFO: The turnstile version discovered is "embedded"
INFO: Cloudflare captcha is solved
```

Body title `nowsecure.nl`, visible content `NOWSECURE by nodriver` (actual site content, not challenge).

### Test 2 — dexscreener.com/solana (real crypto site, CF behind)

| Tier | Method | Result | Elapsed |
|---|---|---|---|
| 1 | `Fetcher.get(stealthy_headers=True)` | ✅ Works, 1.3MB real content | **0.3s** |
| 2 | `StealthyFetcher.fetch(solve_cloudflare=True)` | ✅ Works (Scrapling log: "No Cloudflare challenge found") | 8s |

DexScreener gak trigger Turnstile untuk landing page logged-out — Tier 1 cheap path cukup. Confirms layered escalation rationale.

### Verdict

- ✅ Scrapling klaim **valid** dengan caveat: `solve_cloudflare=True` parameter wajib di Tier 2; default StealthyFetcher saja tidak bypass.
- ✅ HTTP-only Tier 1 work untuk site CF-behind tapi tidak aktif memaksa Turnstile (mayoritas sites).
- ❌ HTTP-only Tier 1 **tidak cukup** untuk site dengan Turnstile aktif.
- Layered strategy (Tier 1 dulu, escalate Tier 2 kalau CF challenge terdeteksi di response) **viable** dan cost-efficient.

---

## Layered fetch — reference implementation

Snippet Python untuk wrapper script atau skill tool fallback:

```python
from scrapling.fetchers import Fetcher, StealthyFetcher

CF_CHALLENGE_MARKERS = (
    "just a moment",
    "checking your browser",
    "verifying you are human",
    "verify you are",
)

def fetch_smart(url: str, timeout: int = 30) -> str:
    """Layered fetch: HTTP first (~0.3s), escalate to stealth browser
    with Turnstile solver only if CF challenge detected (~4-8s)."""
    
    # Tier 1: HTTP + TLS impersonation + stealthy headers
    try:
        page = Fetcher.get(url, stealthy_headers=True, timeout=timeout)
        body_lower = page.html_content.lower()
        if not any(m in body_lower for m in CF_CHALLENGE_MARKERS):
            return page.html_content
    except Exception:
        pass  # fall through to Tier 2
    
    # Tier 2: StealthyFetcher with Cloudflare solver
    page = StealthyFetcher.fetch(
        url,
        headless=True,
        solve_cloudflare=True,
        network_idle=True,
        timeout=90_000,  # ms
    )
    return page.html_content
```

Disimpan nanti di `scripts/lib/fetch_smart.py` atau di-inline ke wrapper script.

---

## Decision (Juni 2026 — updated post-test)

**Sekarang**: Scrapling **installed di Hermes venv** dan diverifikasi work untuk Turnstile bypass. Integration ke skill masih opsional — bisa dieksekusi atau ditunda.

**Skip permanently** (sampai ada kasus konkret): X MCP (overkill untuk hobbyist), CloakBrowser (cukup Scrapling), Nitter (mati), twscrape (risk akun ban).

---

## Next plan (post-verification)

Tiga arah, urut effort low → high:

### A. Stop here — research-only, no agent integration
- Doc ini sudah update dengan capabilities verified
- Scrapling tetap installed di venv (ready saat dibutuhkan)
- Skill knowledge-curator gak diubah
- Kalau di kemudian hari ada use case spesifik (mis. monitor satu site CF-protected), tinggal grab `fetch_smart` snippet di atas

**Trigger lanjut**: kalau setelah 2 minggu agent jalan, `[NEEDS-MANUAL]` flag muncul >3x karena CF block

### B. Standalone CLI wrapper (recommended)
- Bikin `scripts/fetch_url.sh` (di repo) + thin wrapper di `~/.hermes/scripts/`
- Implement layered fetch dari snippet di atas
- Bisa dipanggil manual: `bash ~/.hermes/scripts/fetch_url.sh <URL>`
- Bisa dipanggil agent via terminal tool (kalau skill explicit instruct)
- Skill **belum** di-update — manual escalation only
- Effort: ~30 menit (write script + commit + symlink + smoke test)

**Trigger lanjut ke C**: kalau setelah pakai 1-2 minggu manual, lu confidence cukup

### C. Full integration ke skill
- Update `skills/knowledge-curator/SKILL.md` step 4 (active source gathering)
- Add fallback rule: kalau default web tool fail dengan CF challenge marker, agent invoke `terminal bash fetch_url.sh <URL>`
- Agent otomatis escalate tanpa user intervention
- Effort: ~1 jam (skill edit + push + test loop dengan inbox drop URL CF-protected)
- Risk: agent over-trigger StealthyFetcher (8s) bahkan untuk site yang Tier 1 work. Mitigasi: skill instruction explicit "only use fetch_url.sh as fallback, not first attempt"

**Stay at C indefinitely** kecuali ada kebutuhan parallel (multiple URLs concurrently → bikin pool), atau Scrapling sendiri update breaking changes.

---

---

## Sources

- [X MCP documentation](https://docs.x.com/tools/mcp)
- [Scrapling GitHub (d4vinci/Scrapling)](https://github.com/d4vinci/Scrapling)
- [CloakBrowser GitHub (CloakHQ/cloakbrowser)](https://github.com/CloakHQ/cloakbrowser)
- Companion: [setup/telegram.md](telegram.md) untuk Cloudflare scoping awal dan text-paste strategy
- Companion: [skills/knowledge-curator/SKILL.md](../skills/knowledge-curator/SKILL.md) untuk active source gathering rules
