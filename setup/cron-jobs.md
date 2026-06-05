# Setup cron jobs — preflight + agent pattern

Tutorial untuk kedua cron job di sistem ini (`process-inbox-knowledge` dan `graph-walker`), pakai pola **preflight script wrapper**: cron tick jalankan shell script ringan dulu, LLM cuma dipanggil kalau ada kerjaan beneran.

**Kenapa pattern ini:** cron tick reguler tanpa preflight bakar ~20K input tokens per tick walau gak ada kerjaan (skill content selalu loaded). Pada interval `*/30 * * * *` = 48 tick/hari = jika setengahnya idle = **~480K tokens dibakar untuk nge-ngomong [SILENT]**. Preflight pattern bikin tick idle = bash exit 0 = **zero tokens**.

---

## Bagaimana pattern-nya bekerja

```
┌─────────────────────────────────────────────────────────────┐
│ Cron tick                                                    │
│  (--no-agent --script <script>.sh)                          │
│                                                              │
│  ┌──────────────────────────────────────────────┐           │
│  │ <script>.sh                                  │           │
│  │  - cek kondisi (inbox / dangling refs)       │           │
│  │  - kosong? → exit 0  (NO LLM)                │           │
│  │  - ada? → exec hermes -z --skills knowledge- │           │
│  │           curator                            │           │
│  └──────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

Cron job sendiri pakai `--no-agent`, jadi cron tick **tidak invoke LLM**. LLM cuma dipanggil oleh script via `hermes -z` (one-shot mode) kalau kondisi terpenuhi.

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

### 2. Bikin process-inbox-knowledge dengan preflight

```bash
hermes cron create "*/30 * * * *" \
  --no-agent \
  --script process_inbox.sh \
  --workdir ~/vault \
  --deliver telegram \
  --name "process-inbox-knowledge"
```

Catatan: `--workdir` tetap diset karena script ngambil $VAULT default, plus jadi cwd default kalau script salah. `--deliver telegram` bikin hermes -z output di-forward ke channel telegram.

### 3. Bikin graph-walker dengan preflight

```bash
hermes cron create "0 */6 * * *" \
  --no-agent \
  --script graph_walker.sh \
  --workdir ~/vault \
  --deliver telegram \
  --name "graph-walker"
```

### 4. Verify

```bash
hermes cron list
# Harus tampak dua jobs aktif, schedule benar, "no_agent: true" di details
```

---

## Logic detail per script

### process_inbox.sh

1. `find ~/vault/00-Inbox/_knowledge -maxdepth 1 -type f ! -name ".*"` — count visible files
2. Count = 0 → `exit 0` (Hermes record silent tick, no delivery, no LLM)
3. Count > 0 → `source venv && exec hermes -z "<drain prompt>" --skills knowledge-curator --yolo`

**Edge case handled:** filter hidden files (`.stfolder`, `.stignore`, `.DS_Store`) dari Syncthing dan macOS biar tidak salah-trigger.

### graph_walker.sh

1. `grep -ohE '\[\[[^]|]+(\|[^]]+)?\]\]'` — extract semua wikilink dari semua concept .md
2. `sed` strip `[[ ]]` wrapper dan `|alias` suffix
3. Untuk tiap unique slug, cek apakah `concepts/<slug>.md` exists
4. Hitung yang non-existent (dangling)
5. 0 dangling → `exit 0` (graph "complete", no walk)
6. ≥1 dangling → invoke agent dengan walk prompt

**Edge case:** kalau concepts/ kosong (graph baru), grep return empty, dangling count = 0 → no walk. Skill akan idle sampai user drop input pertama via inbox.

---

## Testing

### Test process-inbox preflight (cheap path)

```bash
# 1. Pastiin inbox kosong
ls ~/vault/00-Inbox/_knowledge/   # harus kosong (kecuali .stfolder)

# 2. Trigger cron manually
source ~/.hermes/hermes-agent/venv/bin/activate
hermes cron tick   # process semua due jobs sekali

# 3. Cek: process_inbox harus exit 0 tanpa LLM call
tail -20 ~/.hermes/logs/agent.log
# Tidak boleh ada entri "API call" untuk job process-inbox-knowledge
```

### Test process-inbox happy path (LLM jalan)

```bash
# 1. Drop test input
echo "Test input." > ~/vault/00-Inbox/_knowledge/test.md

# 2. Trigger
hermes cron tick

# 3. Cek: hermes -z spawned, agent processed
tail -50 ~/.hermes/logs/agent.log | grep -E "API call|knowledge-curator"

# 4. Cek output
ls ~/vault/03-Areas/concepts/   # concept baru harus muncul
```

### Test graph-walker preflight

```bash
# Kalau concepts/ ada beberapa file dengan wikilinks dangling:
bash ~/.hermes/scripts/graph_walker.sh
echo "exit code: $?"
# Kalau ada dangling: hermes -z trigger, full output muncul
# Kalau gak ada: silent, exit 0
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

### Rollback ke pola lama (kalau preflight bermasalah)

```bash
hermes cron delete process-inbox-knowledge
hermes cron create "*/30 * * * *" \
  "Drain 00-Inbox/_knowledge/. If empty, output [SILENT]. Otherwise follow knowledge-curator skill." \
  --skill knowledge-curator \
  --workdir ~/vault \
  --name "process-inbox-knowledge"
```

Sama untuk graph-walker (lihat git history `setup/graph-walker.md` deleted commit untuk command originalnya).

---

## Failure modes

1. **Script path salah**: cron tick gagal, `last_status: "error"` di jobs.json. Cek `hermes cron list` dan `~/.hermes/logs/agent.log` untuk error script not found. Re-verify symlink.

2. **Venv path salah**: script run, source gagal, exit dengan error. Set `HERMES_VENV` env var atau edit script default.

3. **Hermes -z command not found di venv**: kemungkinan venv broken. Re-install Hermes atau cek `which hermes` dengan venv activated.

4. **Cron tick infinite loop kalau hermes -z error**: tidak akan infinite — hermes -z gagal → exec replace shell → cron job marked error → next tick fresh. Aman.

5. **Script edit conflict via Syncthing**: scripts di-symlink dari repo, BUKAN dari vault. Syncthing tidak menyentuh. Edit selalu via git → push → server pull.

---

*Companion: lihat [skills/knowledge-curator/SKILL.md](../skills/knowledge-curator/SKILL.md) untuk procedural rules yang skill follow. Lihat [MISSION.md](../MISSION.md#9-roadmap) untuk posisi cron jobs di roadmap.*
