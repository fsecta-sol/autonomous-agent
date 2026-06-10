# Setup Telegram — #digest + #inbox

Plan untuk utilize Telegram bot yang sudah connected ke group thread. **Status sekarang**: bot ada, group ada, thread ada, belum dikonfigurasi delivery target / channel listener.

**Fokus saat ini**: dua thread aktif (`#digest` outbound, `#inbox` inbound). Sisanya (`#alerts`, `#ask`, `#weekly`) deferred sampai dua ini stabil.

---

## Thread layout (yang aktif sekarang)

| Thread | Tujuan | Arah | Status |
|---|---|---|---|
| **#digest** | Setiap cron job complete (yang ada output, bukan SILENT) → kirim ringkasan final response agent | Bot → User | ✅ active |
| **#inbox** | User paste tweet/URL/note dari HP → bot save verbatim ke `00-Inbox/_knowledge/from-tg-<timestamp>.md` → cron next tick proses | User → Bot | ✅ active |
| **#ask** | Q&A + ngobrol crypto. Vault lookup → kalau ada answer grounded; kalau gap → web research + auto-write ke `00-Inbox/_knowledge/` untuk curation. Skill: `companion`. | Bidirectional | 🟡 plan |

**Deferred** (tunggu kebutuhan beneran muncul):
- `#alerts` — failures, `[NEEDS-*]` flags, provider down
- `#weekly` — Senin meta-review (butuh skill `meta-reviewer`)

---

## Concern: Cloudflare browsing & bot protection

**Realita**: agent perlu fetch URL untuk source gathering. Banyak modern web pakai bot protection (Cloudflare Turnstile, CAPTCHA, TLS fingerprinting, JS challenges). Simple HTTP fetch dari Hermes bisa fail.

**Audit sumber crypto research yang kita pakai:**

| Source | CF protected? | Strategy |
|---|---|---|
| paradigm.xyz, flashbots.net, ethresear.ch, vitalik.eth.limo | ❌ open access | simple fetch OK |
| arxiv.org, EIPs (eips.ethereum.org) | ❌ | simple fetch OK |
| Substack research blogs (Bankless, Helius, etc) | ❌ atau minimal | simple fetch OK |
| Audit firm blogs (Trail of Bits, OpenZeppelin, Spearbit, Zellic) | ❌ | simple fetch OK |
| Dune/Nansen/EigenPhi dashboards | ⚠️ JS-heavy | API call (kalau ada) atau text-paste |
| **Twitter/X** | ✅ **hard blocked** | **text-paste mandatory** |
| News media (TheBlock, CoinDesk paywall) | ⚠️ variable | flag dan skip, atau text-paste |

**Verdict**: untuk crypto research mainstream, **CF jarang masalah**. Yang beneran problem cuma Twitter/X.

### Strategy: text-paste over URL

Default user behavior untuk #inbox:
- **Pasted text**: lu copy konten article/tweet, paste ke #inbox. Agent proses text directly, no fetch needed.
- **Plain URL**: lu paste URL doang. Agent fetch via Hermes web tool. Works untuk source open access.
- **URL ke Twitter/X**: explicitly avoid. Copy text dari tweet, paste sebagai text.

Skill `knowledge-curator` sudah handle dua mode (URL + paste). Yang perlu ditambah: instruksi explicit untuk Twitter URLs.

### Stealth browser — kapan dipertimbangkan

Tools yang bisa dipakai kalau text-paste gak cukup:

- [d4vinci/Scrapling](https://github.com/d4vinci/Scrapling) — Python lib, stealth scraping dengan anti-bot bypasses
- [CloakHQ/cloakbrowser](https://github.com/CloakHQ/cloakbrowser) — stealth browser (Playwright fork)

**Tidak diinstall sekarang. Dipertimbangkan kalau:**
- Setelah 2 minggu pakai, friction text-paste lebih buruk dari ekspektasi
- Sering nemu source yang URL-only dan beneran blocked (di luar Twitter)
- Cost stealth browser install (dependencies, maintenance) sepadan dengan friction yang dihilangkan

YAGNI applied. Default text-paste dulu.

### Skill update (kalau dibutuhkan)

Tambah ke `skills/knowledge-curator/SKILL.md` di anti-pattern:

```
- **Twitter URLs**: do not attempt to fetch twitter.com or x.com URLs. They are
  always bot-blocked. If input is a tweet URL with no accompanying text, flag
  [NEEDS-TEXT] and skip. User should paste text content instead of URL.
```

(Not added yet — wait until first Twitter URL drop happens to verify behavior.)

---

## Setup #digest (outbound)

Approach: route `--deliver` flag di existing cron jobs ke thread Telegram.

### Step 1 — Dapatkan chat_id dan thread_id

Di Telegram:
1. Buka thread #digest yang lu pilih
2. Forward salah satu message dari thread → ke [@userinfobot](https://t.me/userinfobot) atau [@RawDataBot](https://t.me/RawDataBot)
3. Bot reply dengan JSON: catat `chat.id` (group, negative number, mis `-1001234567890`) dan `message_thread_id` (mis `17585`)

### Step 2 — Test send manual

```bash
ssh hermes
source ~/.hermes/hermes-agent/venv/bin/activate

# List available targets
hermes send --list telegram

# Test kirim ke thread
hermes send -t telegram:-1001234567890:17585 "Test from hermes setup"
```

Message muncul di #digest thread → format target benar.

### Step 3 — Update cron jobs

```bash
hermes cron edit process-inbox-knowledge --deliver telegram:-1001234567890:17585
hermes cron edit graph-walker --deliver telegram:-1001234567890:17585

# Verify
hermes cron list | grep -A 2 deliver
```

### Step 4 — Test loop

```bash
echo "Test input for digest delivery" > ~/vault/00-Inbox/_knowledge/test-digest.md
hermes cron run process-inbox-knowledge
# Wait ~30s untuk agent process + delivery
# Message muncul di #digest thread dengan final agent response
```

---

## Setup #ask (chat agent — Q&A + auto-curate)

Pattern: gateway always-on listener + channel_prompts route message → `companion` skill (vault lookup first, web fallback with inbox handoff).

### Step 1 — Dapatkan thread_id untuk #ask

Sama cara dengan thread_id #digest dan #inbox: forward salah satu message dari thread #ask ke [@userinfobot](https://t.me/userinfobot), catat `message_thread_id`.

### Step 2 — Symlink skill (kalau belum)

```bash
ssh hermes
ln -sf ~/autonomous-agent/skills/companion ~/.hermes/skills/companion
```

### Step 3 — Konfigurasi channel_prompts

Edit `~/.hermes/config.yaml`. Tambah entry untuk #ask thread:

```yaml
telegram:
  reactions: false
  allowed_chats: '-1003928226918'
  channel_prompts:
    '-1003928226918:<inbox-thread-id>':
      # ... existing inbox config ...
    '-1003928226918:<ask-thread-id>':         # NEW
      prompt: |
        You are responding to a Telegram chat in the #ask thread.
        Follow the companion skill exactly. The user's message is the
        latest entry in this thread's conversation; Hermes maintains
        session continuity per thread automatically — reference earlier
        Q&As when natural.
        
        Workflow: vault search first (03-Areas/concepts/, 02-Projects/),
        narrow read top 2-3 matches. If vault sufficient → reply grounded
        with [[wikilink]] citations. If vault gap → web research via
        fetch_url.sh, reply with web citations, AND write curation request
        to 00-Inbox/_knowledge/q-<topic>-<timestamp>.md so knowledge-curator
        creates a proper concept note next cron tick. Always cite. Never
        fabricate.
      workdir: /home/hermes/vault
      skills: [companion]
```

### Step 4 — Restart gateway

```bash
hermes gateway restart
hermes gateway status
```

### Step 5 — Test loop

Di Telegram #ask thread:
1. Tanya pertanyaan yang lu yakin vault punya jawaban (mis. "apa itu MEV").
2. Bot reply dengan grounded answer + `[[wikilink]]` citations dalam ~10-30s.
3. Lalu tanya pertanyaan yang lu yakin vault gap (mis. "apa itu account abstraction" — kalau belum ada di concepts).
4. Bot reply dengan web sources + ack "saya tambahin ke inbox".
5. Verify di server: `ls ~/vault/00-Inbox/_knowledge/q-*` — file curation request muncul.
6. Tunggu next cron tick (≤30 menit) — concept note baru muncul di `~/vault/03-Areas/concepts/`.

### Cost estimate

| Action | LLM cost estimate |
|---|---|
| #ask reply (vault has answer) | ~10-20K tokens (vault search + read + synthesis) |
| #ask reply (vault gap + web fallback) | ~30-50K tokens (web fetch + synthesis + inbox write) |
| Subsequent knowledge-curator processing of inbox file | ~30-60K tokens (sama dengan normal inbox flow) |

Total per Q&A yang trigger curation: ~60-110K tokens. Mahal-ish, tapi yang dapet adalah answer ke user PLUS concept note durable. ROI tinggi kalau lu memang tanya yang belum di graph.

---

## Setup #inbox (inbound)

Approach: `hermes gateway` listen, `channel_prompts` route message dari thread #inbox → minimal agent invocation yang save content to file.

### Step 1 — Pastikan gateway running

```bash
ssh hermes
source ~/.hermes/hermes-agent/venv/bin/activate
hermes gateway status

# Kalau belum jalan
hermes gateway install   # systemd service, sekali aja
hermes gateway start
hermes gateway status   # harus "running"
```

### Step 2 — Konfigurasi allowed_chats + channel_prompts

Edit `~/.hermes/config.yaml`:

```yaml
telegram:
  reactions: false
  # Group ID yang lu allow bot listen
  allowed_chats: '-1001234567890'
  channel_prompts:
    # Per-thread routing. Key format: 'chat_id:thread_id'
    '-1001234567890:17585':
      prompt: |
        You receive a message from the user via the #inbox Telegram thread.
        Your ONLY job: save the message content verbatim to a new file at
        00-Inbox/_knowledge/from-tg-{TIMESTAMP}.md where {TIMESTAMP} is the
        current local time as YYYY-MM-DD-HHMMSS.
        
        After successful file write, reply with exactly: "[SAVED] <filename>"
        
        Do NOT process, summarize, classify, or interpret the content.
        Do NOT invoke any other skill. Pure save-and-confirm.
        
        Use the file write tool only. Maximum 2 tool calls (write + reply).
      workdir: /home/hermes/vault
      skills: []
```

**Ganti `17585` dengan thread_id #inbox lu** (beda dari #digest).

### Step 3 — Restart gateway untuk apply

```bash
hermes gateway restart
hermes gateway status
```

### Step 4 — Test loop

Di Telegram, di thread #inbox:
1. Paste: "MEV searchers exploit pending tx visibility in public mempools."
2. Tunggu beberapa detik, bot reply: `[SAVED] from-tg-2026-06-05-201530.md`
3. Verify di server:
   ```bash
   ls ~/vault/00-Inbox/_knowledge/
   cat ~/vault/00-Inbox/_knowledge/from-tg-*.md
   ```
4. Tunggu cron tick berikutnya (max 30 min) — `process_inbox.sh` detect file, knowledge-curator process, concept enrichment atau new concept, delivered ke #digest thread

---

## Cost estimate per workflow

| Action | LLM cost estimate |
|---|---|
| #digest delivery (per cron job complete with output) | $0, reuses existing agent response |
| #inbox message → save | ~2K tokens input + ~50 output (minimal prompt + 2 tool calls) |
| #inbox saved file → knowledge-curator processing | ~30-60K tokens (full skill + active source gathering) |

**Per Telegram drop → finished concept**: ~35K tokens. Acceptable for content that gets durable value (vs ephemeral chat).

**Per SILENT cron tick**: 0 tokens (preflight short-circuits).

---

## Failure modes & rollback

### #digest

- **`hermes send` returns error "platform not configured"**: bot token / chat_id belum benar di `~/.hermes/.env` atau config. Re-run `hermes gateway setup`.
- **Message gak muncul di thread**: target format salah. Cek `hermes send --list telegram` output, samakan format ke `--deliver`.
- **Rollback**: `hermes cron edit <name> --deliver local`.

### #inbox

- **Bot gak respond**: gateway gak running (`hermes gateway status`), atau `allowed_chats` belum include group ID.
- **Bot respond tapi gak save file**: workdir salah, permission, atau prompt-nya gak nge-trigger file write tool. Cek `~/.hermes/logs/agent.log` filtered by session ID.
- **Bot save tapi cron gak proses file**: filename mengandung char yang `process_inbox.sh` filter (`.` di depan?). Cek find command di script.
- **Rollback**: hapus `channel_prompts` entry, `hermes gateway restart`. Bot ignore messages di thread itu.

### Cloudflare-blocked URL drop

- Agent fetch fails, returns HTML challenge page or 403
- Skill flag `[NEEDS-FETCH]` atau `[NEEDS-MANUAL]`
- User intervention: paste text content directly to #inbox sebagai gantinya
- Long-term: kalau pattern berulang, install stealth browser tools dan refactor web fetcher

---

## Next iteration triggers

Reconsider scope kalau:

- Lu sering bypass #inbox karena friction text-paste lebih buruk dari ekspektasi → install Scrapling/Cloakbrowser
- Notif di #digest jadi spam (terlalu banyak detail) → bikin skill `digest-condenser` yang ringkas hasil cron sebelum delivery
- Lu pengen liat ringkasan minggu-ke-minggu → tambah `#weekly` thread + cron `meta-reviewer`
- Mulai sering tanya "apa ini" sambil ingin jawab dari graph sendiri → activate `#ask` thread + skill `q-answerer`

---

*Companion: [setup/cron-jobs.md](cron-jobs.md) untuk cron schedule. [MISSION.md](../MISSION.md) untuk konteks north star.*
