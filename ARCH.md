# ARCH.md — Blueprint Sistem Autonomous Agent

Doc ini fokus pada **gambar**: mesin apa saja, isinya apa, gimana mereka terhubung, gimana context dirakit tiap run, dan gimana flow agent dari cron tick sampai delivery. Untuk *kenapa*-nya (prinsip stateless, cron amnesia, judge konservatif), lihat [TLDR.md](TLDR.md).

---

## 1. Pandangan tinggi — tiga "tempat"

```
   ┌─────────────────┐                ┌──────────────────────┐
   │     LAPTOP      │                │   UBUNTU SERVER      │
   │  (kamu duduk)   │                │  (agent hidup)       │
   │                 │                │                      │
   │  ┌───────────┐  │   Syncthing    │  ┌────────────────┐  │
   │  │ Obsidian  │◄─┼────────────────┼─►│  vault/        │  │
   │  └─────▲─────┘  │  (bidirect)    │  │  (markdown)    │  │
   │        │        │                │  └───────▲────────┘  │
   │        │        │                │          │ R/W       │
   │  ┌─────▼─────┐  │                │  ┌───────▼────────┐  │
   │  │ Telegram  │◄─┼────────────────┼──┤ Hermes agent   │  │
   │  └───────────┘  │   [digest]     │  │                │  │
   │                 │                │  └───────▲────────┘  │
   │  ┌───────────┐  │     SSH        │          │           │
   │  │ Terminal  │──┼────────────────┼─►   admin/observe    │
   │  └───────────┘  │                │                      │
   └─────────────────┘                └──────────────────────┘
```

Tiga "tempat" — **dua mesin + satu shared filesystem**. Vault Obsidian itu sebenarnya folder markdown yang **ada di dua-duanya** (laptop & server) dan disinkronkan Syncthing. Itu yang bikin agent (di server) dan kamu (di laptop) bisa baca-tulis ke "otak bersama" yang sama.

---

## 2. Komponen per mesin

### 2.1 Laptop — interface manusia

```
LAPTOP
├── Obsidian app                ← UI baca/tulis notes, graph view
├── Syncthing client            ← auto-sync folder vault
├── Telegram client             ← receive digest/alert dari agent
├── SSH client                  ← admin server: hermes cron list, edit skills
├── ~/autonomous-agent/         ← repo clone (edit MISSION/ARCH/skills dari sini)
└── ~/vault/                    ← copy lokal, di-sync dari server
```

Peran: **observe + curate**. Kamu lihat apa yang agent kerjakan via Obsidian, terima ringkasan via Telegram, intervensi lewat SSH atau lewat edit langsung di vault.

### 2.2 Ubuntu server — agent hidup di sini

```
UBUNTU SERVER
│
├── ~/autonomous-agent/                     ← REPO (git, source of truth)
│   ├── MISSION.md / ARCH.md / TLDR.md      │  (versioned, kamu yang owns)
│   └── skills/<name>/SKILL.md              │
│                                           │
├── Hermes agent  ──────────────────────────┐
│   (lihat zoom-in di Bab 3)                │
│                                           │
├── ~/.hermes/                              │ ← runtime Hermes (opaque)
│   ├── config.yaml                         │   (TIDAK di-sync, TIDAK versioned)
│   ├── cron/jobs.json                      │
│   ├── cron/output/{job_id}/               │
│   ├── skills/                             │
│   │   └── <name> -> ~/autonomous-agent/skills/<name>   ← SYMLINK ke repo
│   ├── sessions/                           │
│   └── state.db (SQLite)                   │
│                                           │
├── ~/vault/                                │ ← shared brain
│   └── (Obsidian markdown files)           │   (DI-sync via Syncthing)
│                                           │
├── Syncthing daemon                        │
├── healthchecks ping (cron OS biasa)       │
└── systemd: hermes.service                 │
```

Peran: **execute + persist**. Hermes daemon nyala 24/7 (cron tick tiap 60s, idle saat tidak ada job due). Semua "ingatan" agent ada di sini — sebagian di-share ke laptop via vault, sebagian internal.

### 2.3 Vault Obsidian — shared brain

```
~/vault/
├── 00-Inbox/                   ← dump kasar dari agent, kamu sortir
├── 01-Daily/
│   └── 2026-05-29.md           ← digest harian (agent tulis, kamu baca)
├── 02-Projects/
│   └── crypto-research/
│       ├── _index.md           ← goal + success criteria (kamu tulis)
│       ├── watchlist.md        ← state aktif (agent maintain)
│       ├── patterns.md         ← declarative knowledge (agent + kamu)
│       ├── track-record.md     ← prediksi vs outcome (agent append)
│       └── runs/
│           └── 2026-05-29.md   ← log run lengkap hari ini (agent)
├── 03-Areas/                   ← knowledge lintas-project (kamu)
└── 04-Archive/                 ← runs lama yang sudah di-roll-up
```

Peran: **shared declarative memory**. Satu-satunya tempat agent & kamu **dua-duanya** baca-tulis ke file yang sama.

---

## 3. Zoom in — di dalam Hermes agent

```
                ┌────────────────────────────────────────┐
                │           HERMES AGENT                 │
                │                                        │
   tick 60s ──► │  ┌──────────────┐                      │
                │  │  Scheduler   │── reads jobs.json    │
                │  └──────┬───────┘                      │
                │         │ fire due job                 │
                │         ▼                              │
                │  ┌──────────────┐                      │
                │  │ Job runner   │                      │
                │  └──────┬───────┘                      │
                │         │ assembles context (Bab 4)    │
                │         ▼                              │
                │  ┌──────────────┐    ┌──────────────┐  │
                │  │ LLM session  │◄──►│  Tools       │  │
                │  │ (/goal loop) │    │  (read/write │  │
                │  └──────┬───────┘    │   web/shell) │  │
                │         │            └──────────────┘  │
                │         │ per-turn                     │
                │         ▼                              │
                │  ┌──────────────┐                      │
                │  │ Judge model  │── done? continue?    │
                │  └──────┬───────┘                      │
                │         │                              │
                │         ▼                              │
                │  ┌──────────────┐                      │
                │  │ Persist:     │                      │
                │  │ - output     │── ~/.hermes/cron/    │
                │  │ - state      │── state.db           │
                │  │ - delivery   │── Telegram           │
                │  └──────────────┘                      │
                └────────────────────────────────────────┘
```

### Yang Hermes butuh untuk hidup

| Kebutuhan | File / sumber | Diisi oleh |
|---|---|---|
| Provider LLM + fallback | `~/.hermes/config.yaml` | Kamu (sekali) |
| API credentials | `~/.hermes/config.yaml` atau env | Kamu (sekali) |
| Cron job definitions | `~/.hermes/cron/jobs.json` | `hermes cron create` |
| Procedural skills | `~/.hermes/skills/<name>/SKILL.md` | Kamu (sekali per skill) |
| Session/state persistence | `state.db` (SQLite) | Auto |
| Per-job output store | `~/.hermes/cron/output/{job_id}/` | Auto |
| Delivery channel | config (Telegram bot token) | Kamu (sekali) |
| Workdir per job | `--workdir` param tiap cron job | Kamu saat create |
| Tool allowlist | `enabled_toolsets` per job | Kamu saat create |

---

## 4. Context management — gimana prompt dirakit per run

Tiap kali job fire, Hermes merakit "prompt akhir" dari beberapa lapis. Urutannya **bukan random** — ini yang menentukan apa yang agent "ingat" tiap bangun.

```
┌─────────────────────────────────────────────────────────┐
│  PROMPT ASSEMBLY (per run)                              │
│                                                         │
│  [1] Base system prompt                                 │
│      └─ Hermes default (tools, format, safety)          │
│                                                         │
│  [2] Skill content                          ← PROCEDURAL│
│      └─ ~/.hermes/skills/crypto-research/SKILL.md       │
│         (cara kerja, urutan langkah, format output)     │
│                                                         │
│  [3] context_from output             ← WORKING (kemarin)│
│      └─ ~/.hermes/cron/output/<prev_job_id>/latest      │
│         (ringkasan run sebelumnya: "kemarin nyampe X")  │
│                                                         │
│  [4] Cron job prompt template                           │
│      └─ teks prompt yang kamu definisikan saat create   │
│         ("baca vault/.../patterns.md, lanjutkan...")    │
│                                                         │
│  ─── agent mulai turn ────────────────────────────      │
│                                                         │
│  [5] Tool reads (runtime)              ← DECLARATIVE    │
│      └─ Read('vault/02-Projects/.../_index.md')         │
│         Read('vault/02-Projects/.../patterns.md')       │
│         Read('vault/02-Projects/.../watchlist.md')      │
│                                                         │
│  [6] (multi-turn) tool results + judge prompts          │
└─────────────────────────────────────────────────────────┘
```

**Insight penting:** [1]–[4] otomatis dirakit Hermes saat fire. [5] adalah agent **secara aktif membaca** vault saat run — itu sebabnya prompt di [4] harus eksplisit memerintahkan baca file mana. Vault tidak otomatis "ada di context"; agent harus disuruh baca via skill atau prompt.

### Apa yang TIDAK masuk context

- `state.db` (episodic internal) — Hermes pakai untuk `/resume`, bukan untuk prompt.
- File vault lain yang tidak di-Read eksplisit — vault gede, masukin semua = boros token.
- Output cron job LAIN yang bukan `context_from` — isolasi antar goal.

---

## 5. Memory layers — peta lengkap

```
                 ┌───────────────────────────────────────┐
                 │           MEMORY STACK                │
                 ├───────────────────────────────────────┤
   FAST DECAY    │ Working (context_from)                │
       ▲         │   "kemarin sampai mana"               │
       │         │   → ~/.hermes/cron/output/            │
       │         ├───────────────────────────────────────┤
       │         │ Episodic internal (state_meta)        │
       │         │   "session log + goal state"          │
       │         │   → state.db                   │
       │         ├───────────────────────────────────────┤
       │         │ Episodic publik (daily/runs)          │
       │         │   "log run yang kamu juga bisa baca"  │
       │         │   → vault/01-Daily/, vault/.../runs/  │
       │         ├───────────────────────────────────────┤
       │         │ Declarative (wiki/patterns)           │
       │         │   "fakta domain yang awet"            │
       │         │   → vault/02-Projects/.../patterns.md │
       │         ├───────────────────────────────────────┤
       ▼         │ Procedural (skills)                   │
   SLOW DECAY    │   "cara kerja yang reusable"          │
                 │   → ~/.hermes/skills/<name>/          │
                 └───────────────────────────────────────┘
```

| Layer | Lokasi fisik | Mesin | Sync? | Yang nulis | Yang baca | Retensi |
|---|---|---|---|---|---|---|
| **Working** | `~/.hermes/cron/output/` | server | ❌ | Hermes auto | Hermes (next run via `context_from`) | overwrite tiap run |
| **Episodic internal** | `state.db` | server | ❌ | Hermes auto | Hermes `/resume`, FTS search | append-only |
| **Episodic publik** | `vault/01-Daily/`, `vault/.../runs/` | shared | ✅ | Agent | Kamu (Obsidian) | append, archive bulanan |
| **Declarative** | `vault/.../patterns.md`, `vault/03-Areas/` | shared | ✅ | Agent + kamu | Agent (R) + kamu (R/W) | edit-in-place, awet |
| **Procedural** | `~/.hermes/skills/<name>/` | server | ❌* | Kamu (manual) | Agent tiap run | edit jarang |

*Skills bisa di-symlink ke vault kalau mau editable dari Obsidian — tapi sumber kebenarannya tetap di `~/.hermes/skills/`.

**Aturan tegas:** kalau itu **state agent yang kamu gak perlu lihat**, biarkan di `~/.hermes/` (server-only). Kalau itu **knowledge bersama**, taruh di vault. Jangan campur.

---

## 6. Flow agent per run

```
T+0:00  ┌─────────────────────────────────────────┐
        │ Hermes scheduler tick (tiap 60s)        │
        │ → cek jobs.json, ada yg due?            │
        └──────────────┬──────────────────────────┘
                       │ ya, fire "crypto-research-daily"
                       ▼
T+0:01  ┌─────────────────────────────────────────┐
        │ Job runner mulai                        │
        │ - load skill (procedural)               │
        │ - load context_from (working memory)    │
        │ - rakit prompt (Bab 4)                  │
        │ - spawn LLM session                     │
        └──────────────┬──────────────────────────┘
                       │
                       ▼
T+0:05  ┌─────────────────────────────────────────┐
        │ Agent turn 1                            │
        │ - Read vault/02-Projects/.../_index.md  │
        │ - Read vault/.../patterns.md            │
        │ - Read vault/.../watchlist.md           │
        │ → tahu goal, tahu pattern, tahu state   │
        └──────────────┬──────────────────────────┘
                       │
                       ▼
T+0:10  ┌─────────────────────────────────────────┐
        │ Agent turn 2-N (kerja sesungguhnya)     │
        │ - fetch data (API, web)                 │
        │ - filter, analisis                      │
        │ - Write vault/.../runs/2026-05-29.md    │
        │ - Edit vault/.../watchlist.md           │
        │ - Append vault/.../patterns.md (if new) │
        └──────────────┬──────────────────────────┘
                       │
                       ▼
T+0:15  ┌─────────────────────────────────────────┐
        │ Judge model: goal phase done?           │
        │ - ya → finalize                         │
        │ - belum → continuation prompt, ulang    │
        │ - blocked → mark DONE (with reason)     │
        └──────────────┬──────────────────────────┘
                       │ done
                       ▼
T+0:16  ┌─────────────────────────────────────────┐
        │ Persist                                 │
        │ - tulis ringkasan ke output store       │
        │   (jadi context_from BESOK)             │
        │ - update state.db                │
        │ - kirim delivery ke Telegram            │
        │   (atau [SILENT] kalau gak ada highlight)│
        └──────────────┬──────────────────────────┘
                       │
                       ▼
T+0:17  ┌─────────────────────────────────────────┐
        │ Syncthing deteksi vault berubah         │
        │ → push ke laptop dalam detik            │
        │ → Obsidian di laptop refresh otomatis   │
        └─────────────────────────────────────────┘

T+12h   (kamu buka laptop malam hari, lihat Telegram digest
         + buka Obsidian baca 01-Daily/2026-05-29.md)

T+24h   (cron tick lagi, siklus mulai dari awal —
         context_from sekarang = output run kemarin)
```

---

## 7. Tiga rumah & deployment via git

Server punya **tiga folder yang ownership-nya beda** — pisahkan tegas, jangan dicampur.

| Rumah | Lokasi | Owner | Versioned? | Sifat |
|---|---|---|---|---|
| **Repo desain** | `~/autonomous-agent/` | kamu (git) | git | source of truth: MISSION, ARCH, skills/ |
| **Runtime Hermes** | `~/.hermes/` | Hermes daemon | tidak | state.db, sessions, cron jobs, output |
| **Working data** | `~/vault/` | shared (kamu + agent) | Syncthing | knowledge graph, runs, daily notes |

Tiga prinsip pemisahan:

1. **Repo desain = source.** Edit-able di laptop atau server (lewat git). Hermes upgrade / reset / pindah tidak menyentuh ini. Lu yang owns penuh.
2. **Runtime Hermes = opaque.** Treat sebagai black box. Jangan edit langsung. Backup periodik untuk disaster recovery, bukan untuk dipakai sehari-hari.
3. **Vault = working data.** Tempat kamu dan agent betul-betul kolaborasi. Bukan source code, bukan runtime — data hidup.

### Bridge: symlink skill dari repo ke Hermes

```bash
ln -s ~/autonomous-agent/skills/<skill-name> ~/.hermes/skills/<skill-name>
```

Hasilnya: edit `SKILL.md` di repo → langsung apply ke Hermes saat job berikutnya fire. Tidak perlu copy ulang. Tambah skill baru? Tambah `ln -s` lagi. Hapus skill? `unlink` (repo aman).

### Workflow git: edit di mana saja

```
   LAPTOP                                  UBUNTU SERVER
   ──────                                  ─────────────

   ~/autonomous-agent/      git push       ~/autonomous-agent/
       (edit skill/doc) ──────────► GitHub ──────► (git pull)
                              ▲                          │
                              │                          │ symlink
                              │  git push                ▼
                              │  (edit dari ssh)   ~/.hermes/skills/
                              └────────────────         (Hermes consume)
```

Konvensi yang disarankan: edit di laptop (editor favorit + Obsidian), `git push`, server `git pull`. Atau setup auto-pull di server:

```bash
# crontab -e (cron OS biasa, di luar Hermes)
*/10 * * * * cd ~/autonomous-agent && git pull --quiet
```

### Backup strategy per rumah

| Rumah | Backup mechanism | Frequency |
|---|---|---|
| `~/autonomous-agent/` | `git push` ke GitHub | per-edit |
| `~/vault/` | Syncthing → laptop | real-time |
| `~/.hermes/` | rsync ke laptop/cloud storage | mingguan (disaster recovery only) |

Tiga jenis data, tiga strategi — sesuai sifat dan ownership.

---

## 8. Data flow antar mesin

```
                    ARAH ALIRAN DATA

  LAPTOP                              UBUNTU SERVER
  ──────                              ─────────────

  Obsidian edit ───── Syncthing ────► vault/ (server)
                       (bidir)         │
                                       │ Read by agent
                                       ▼
  Obsidian read ◄──── Syncthing ─────  vault/ (server)
                       (bidir)         ▲
                                       │ Write by agent
                                       │
                                       Hermes job
                                       │
  Telegram      ◄────────────────────  delivery
                                       │
                                       │
  Terminal      ─────── SSH ─────────► hermes cron list
  (admin)                              edit skills
                                       view logs
```

### Yang harus disetel sekali

1. **Syncthing**: install di laptop & server, share folder `~/vault/`.
2. **Hermes systemd unit**: `hermes.service` di server biar auto-restart kalau crash/reboot.
3. **Telegram bot**: bot token + chat ID di `~/.hermes/config.yaml`.
4. **Healthchecks.io**: bikin check, dapat UUID, masukin ke cron OS biasa (`*/30 * * * * curl https://hc-ping.com/<uuid>`).
5. **SSH key**: laptop → server, no password.
6. **Backup**: `rsync ~/.hermes/` ke laptop tiap minggu (disaster recovery, bukan operational).

---

## 9. Ringkasan visual

```
   APA AGENT INGAT?            DI MANA?              UMUR?
   ─────────────────           ────────              ─────
   Cara kerja                  skills/               bulanan+
   Pengetahuan domain          vault/patterns.md     mingguan+
   "Kemarin nyampe mana"       cron/output/          1 run
   Session log                 state.db       append
   Log run lengkap             vault/runs/           append→archive

   APA KAMU LIHAT?             DI MANA?              KAPAN?
   ───────────────             ────────              ──────
   Digest singkat              Telegram              tiap selesai run
   Detail run                  Obsidian daily note   kapan aja
   State project               Obsidian watchlist    kapan aja
   Pattern terkumpul           Obsidian patterns.md  kapan aja
   Graph relasi                Obsidian graph view   kapan aja
   Admin/debug                 SSH → server          kapan aja
```

---

*Companion doc: lihat [TLDR.md](TLDR.md) untuk prinsip desain (stateless, cron amnesia, judge, guardrail) — dokumen ini hanya membahas blueprint fisik & flow.*
