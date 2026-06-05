# Setup cron jobs — wake gate pre-check pattern

Tutorial untuk kedua cron job di sistem ini (`process-inbox-knowledge` dan `graph-walker`), pakai **Hermes wake gate pattern**: cron tick jalankan shell script ringan, agent (LLM) cuma di-invoke kalau script tidak emit `{"wakeAgent": false}` sebagai line terakhir.

**Kenapa pattern ini:** cron tick reguler tanpa preflight bakar ~20K input tokens per tick walau gak ada kerjaan (skill content selalu loaded). Pada interval `*/30 * * * *` = 48 tick/hari = jika setengahnya idle = **~480K tokens dibakar untuk nge-ngomong [SILENT]**. Wake gate bikin tick idle = bash exit + `wakeAgent: false` = **zero tokens** (LLM skip total).

---

## Wake gate pattern (built-in Hermes)

Hermes' cron scheduler eksekusi `--script` dulu, baca stdout-nya. Kalau **line terakhir** stdout adalah JSON `{"wakeAgent": false}`, agent diskip dan tick berakhir tanpa LLM call.

```
┌─────────────────────────────────────────────────────────────┐
│ Cron tick                                                    │
│  (--script <script>.sh --skill knowledge-curator)            │
│                                                              │
│  ┌──────────────────────────────────────────────┐           │
│  │ <script>.sh                                  │           │
│  │  - cek kondisi (inbox / dangling refs)       │           │
│  │  - kosong? → echo '{"wakeAgent": false}'     │           │
│  │  - ada?    → echo "Status: <count> pending"  │           │
│  └─────────────────┬────────────────────────────┘           │
│                    │                                         │
│   Hermes parse last line of stdout                          │
│                    │                                         │
│        ┌───────────┴───────────┐                            │
│        │                       │                            │
│  {"wakeAgent": false}     anything else                     │
│        │                       │                            │
│        ▼                       ▼                            │
│  SKIP agent              Invoke agent normally              │
│  (zero tokens)           (script stdout injected to prompt) │
└─────────────────────────────────────────────────────────────┘
```

**Catatan**: cron job TIDAK pakai `--no-agent` flag. Skill di-attach lewat `--skill knowledge-curator`. Cron prompt jadi main instruction agent. Script stdout (non-gate output) ke-prepend ke prompt sebagai context.

---

## Persyaratan

1. Scripts ada di repo: [scripts/process_inbox.sh](../scripts/process_inbox.sh), [scripts/graph_walker.sh](../scripts/graph_walker.sh)
2. Symlinked ke `~/.hermes/scripts/` di server biar Hermes cron bisa nge-trigger
3. Executable bit aktif (cek dengan `ls -la`)
4. Hermes venv path: `~/.hermes/hermes-agent/venv` (default lokasi install)

Kalau venv lu di tempat lain, set env var `HERMES_VENV` di cron, atau edit script-nya.

---

## Setup di server

**Penting**: Hermes punya path-traversal security check — symlink ke luar `~/.hermes/scripts/` akan **ditolak** dengan error `Script path escapes the scripts directory via traversal`. Pakai **thin wrapper** pattern: file beneran (bukan symlink) di `~/.hermes/scripts/` yang `exec` ke repo.

```bash
ssh hermes
cd ~/autonomous-agent
git pull   # ambil script terbaru dari repo

mkdir -p ~/.hermes/scripts

# Thin wrapper: file regular yang exec ke repo
cat > ~/.hermes/scripts/process_inbox.sh << 'WRAPPER'
#!/bin/bash
exec ~/autonomous-agent/scripts/process_inbox.sh "$@"
WRAPPER

cat > ~/.hermes/scripts/graph_walker.sh << 'WRAPPER'
#!/bin/bash
exec ~/autonomous-agent/scripts/graph_walker.sh "$@"
WRAPPER

chmod +x ~/.hermes/scripts/*.sh

# Verify (harus tampak file biasa, BUKAN symlink l-)
ls -la ~/.hermes/scripts/
cat ~/.hermes/scripts/process_inbox.sh
```

**Kenapa pattern ini work:**
- File di `~/.hermes/scripts/` regular file → Hermes path-traversal check pass
- Eksekusi `exec ~/autonomous-agent/...` adalah behavior bash internal, bukan urusan Hermes security
- Edit script di repo → `git push` → server `git pull` → wrapper tetap exec ke versi terbaru, gak perlu re-create wrapper

**Kalau lu nambah script baru ke repo nanti**: tambahin satu wrapper file lagi di `~/.hermes/scripts/` dengan pola yang sama.

---

## Migration: ganti cron jobs lama dengan preflight version

### 1. Hapus cron jobs lama

```bash
hermes cron list  # catat job IDs
hermes cron delete <process-inbox-job-id>
hermes cron delete <graph-walker-job-id>
```

### 2. Bikin process-inbox-knowledge dengan wake gate

**Penting argparse order**: prompt adalah positional argument, harus dikasih **langsung setelah schedule**, baru flags. Order: `cron create <schedule> <prompt> --flags...`. Kalau prompt ditaruh setelah flags, argparse ke-reject "unrecognized arguments".

```bash
hermes cron create "*/30 * * * *" \
  "Process all files currently in 00-Inbox/_knowledge/ following the knowledge-curator skill exactly. After done, summarize counts (N inputs processed, M new concepts, K enriched) and list any [NEEDS-*] flags raised." \
  --script process_inbox.sh \
  --skill knowledge-curator \
  --workdir ~/vault \
  --deliver telegram \
  --name "process-inbox-knowledge"
```

**Tidak ada `--no-agent`**. Skill di-attach via `--skill`, cron prompt jadi instruction utama agent. Script `process_inbox.sh` jalan dulu sebagai pre-check; output stdout-nya ke-inject sebagai context (di-prepend) ke prompt.

### 3. Bikin graph-walker dengan wake gate

```bash
hermes cron create "0 */6 * * *" \
  "You are running a graph-walk task. The pre-check script has already listed dangling refs in the context above. Pick the deepest one (closest to cryptography layer based on context in source notes); tie-break by most-referenced. Process it by following the knowledge-curator skill workflow — fetch canonical sources, write full concept note with Diagram + Real-world examples sections, run reciprocity check, populate inbound link reciprocals. Append to today's daily log under '## Graph walk — <HH:MM>'." \
  --script graph_walker.sh \
  --skill knowledge-curator \
  --workdir ~/vault \
  --deliver telegram \
  --name "graph-walker"
```

Script `graph_walker.sh` pre-extract dangling ref list, agent terima list langsung sebagai context — gak perlu ulang discovery sendiri.

### 4. Verify

```bash
hermes cron list
# Harus tampak dua jobs aktif, schedule benar, "no_agent: true" di details
```

---

## Logic detail per script

### process_inbox.sh

1. `find ~/vault/00-Inbox/_knowledge -maxdepth 1 -type f ! -name ".*"` — count visible files
2. Count = 0 → output `{"wakeAgent": false}` → Hermes skip agent (no LLM call)
3. Count > 0 → output "Inbox state: N file(s) pending — file1, file2" → agent invoked with this context prepended to cron prompt

**Edge case handled:** filter hidden files (`.stfolder`, `.stignore`, `.DS_Store`) dari Syncthing dan macOS biar tidak salah-trigger.

### graph_walker.sh

1. `grep -ohE '\[\[[^]|]+(\|[^]]+)?\]\]'` — extract semua wikilink dari semua concept .md
2. `sed` strip `[[ ]]` wrapper dan `|alias` suffix
3. Untuk tiap unique slug, cek apakah `concepts/<slug>.md` exists
4. Hitung yang non-existent (dangling)
5. 0 dangling → output `{"wakeAgent": false}` → agent skip
6. ≥1 dangling → output "Dangling concept refs detected: <list>" → agent invoked, picks deepest from list

**Edge case:** kalau concepts/ kosong (graph baru), grep return empty, dangling count = 0 → no walk. Skill akan idle sampai user drop input pertama via inbox.

---

## Testing

### Test pre-check script langsung

```bash
# Inbox kosong → harus output wake gate JSON
ls ~/vault/00-Inbox/_knowledge/
bash ~/.hermes/scripts/process_inbox.sh
# Expected output: {"wakeAgent": false}

# Inbox ada isi → harus output status (non-gate)
echo "test" > ~/vault/00-Inbox/_knowledge/test.md
bash ~/.hermes/scripts/process_inbox.sh
# Expected output: Inbox state: 1 file(s) pending — test.md
```

### Test cron tick (cheap path)

```bash
# Pastiin inbox kosong
rm -f ~/vault/00-Inbox/_knowledge/test.md

source ~/.hermes/hermes-agent/venv/bin/activate
hermes cron run process-inbox-knowledge

# Cek log: harus tampak "wake gate" decision, tidak ada API call entry
tail -30 ~/.hermes/logs/agent.log | grep -iE "wake|silent|API call|knowledge-curator"
```

### Test cron tick (happy path)

```bash
echo "Test input about MEV." > ~/vault/00-Inbox/_knowledge/test.md
hermes cron run process-inbox-knowledge

# Tunggu beberapa menit (agent processing bisa 60-180s)
# Cek output
ls ~/vault/03-Areas/concepts/   # concept baru harus muncul atau enrichment
cat ~/vault/01-Daily/$(date +%Y-%m-%d).md  # daily log entry
```

### Test graph_walker pre-check

```bash
bash ~/.hermes/scripts/graph_walker.sh
echo "exit code: $?"
# Kalau ada dangling refs: output list, exit 0
# Kalau gak ada: {"wakeAgent": false}, exit 0
```

---

## Monitoring & rollback

### Cek apakah savings beneran terjadi

```bash
# Sebelum patch: hitung [SILENT] entry per hari
grep "\[SILENT\]" ~/.hermes/logs/agent.log | grep -oE "^[0-9]{4}-[0-9]{2}-[0-9]{2}" | sort | uniq -c

# Setelah patch: SILENT entry harus turun drastis (preflight skips before LLM)
# API call count untuk process-inbox-knowledge cron juga turun
grep "cron_<job-id>" ~/.hermes/logs/agent.log | grep "API call" | wc -l
```

### Rollback ke pola lama (no script, prompt-only)

```bash
hermes cron delete process-inbox-knowledge
hermes cron create "*/30 * * * *" \
  "Drain 00-Inbox/_knowledge/. If empty, output [SILENT]. Otherwise follow knowledge-curator skill." \
  --skill knowledge-curator \
  --workdir ~/vault \
  --name "process-inbox-knowledge"
```

Konsekuensi: tiap tick = LLM call (skill loaded), ~20K input tokens per tick walau gak ada kerjaan. Rollback ini cuma kalau wake gate script ada bug yang gak bisa di-debug cepat.

---

## Failure modes

1. **Script path salah**: cron tick gagal, `last_status: "error"` di jobs.json. Cek `hermes cron list` dan `~/.hermes/logs/agent.log` untuk error script not found. Re-verify thin wrapper di `~/.hermes/scripts/`.

2. **Wake gate JSON di-parse salah**: script harus output `{"wakeAgent": false}` PERSIS di line terakhir stdout (no trailing whitespace/newlines after). Hermes parse line terakhir non-empty. Kalau script print apa-apa setelah JSON, gate gagal trigger, agent invoked anyway.

3. **Agent timeout setelah wake gate fire**: agent run normal (60-300s tergantung kerjaan). Bukan limited oleh 120s script timeout — itu hanya untuk pre-check script execution. Agent timeout ada di `agent.gateway_timeout: 1800` (30 min).

4. **Script timeout limit (120s default)**: kalau script lu sendiri butuh > 120s untuk pre-check (mis. grep besar di vault gede), naikkan dengan tambahan di `~/.hermes/config.yaml`:
   ```yaml
   cron:
     script_timeout_seconds: 300
   ```
   Atau set env var `HERMES_CRON_SCRIPT_TIMEOUT=300` di systemd unit Hermes.

5. **Script edit conflict via Syncthing**: scripts di-symlink dari repo via thin wrapper, BUKAN dari vault. Syncthing tidak menyentuh. Edit selalu via git → push → server pull.

---

*Companion: lihat [skills/knowledge-curator/SKILL.md](../skills/knowledge-curator/SKILL.md) untuk procedural rules yang skill follow. Lihat [MISSION.md](../MISSION.md#9-roadmap) untuk posisi cron jobs di roadmap.*
