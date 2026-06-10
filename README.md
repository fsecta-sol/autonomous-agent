# autonomous-agent

> Personal autonomous agent untuk crypto / blockchain research & knowledge curation.
> **North star:** create my own edge in crypto through compound understanding.
> Wealth as by-product, not target.

---

## Apa ini

Sistem agent yang jalan 24/7 di server Ubuntu, dibangun di atas [Hermes Agent](https://github.com/NousResearch/hermes-agent). Tiap hari agent menyerap input crypto (artikel, tweet, paper, pertanyaan) dan menumbuhkan **knowledge graph personal** di Obsidian vault — bukan sebagai aggregator berita, tapi sebagai mesin pembangun pengertian struktural yang dipakai untuk mengenali peluang lebih dini dari rata-rata pasar.

Default sistem: **mati, dibangunkan cron berkala.** Stateless. Ingatan ada di disk, bukan di proses. Tahan reboot, tahan limit, tahan ditinggal berhari-hari.

---

## Dokumen

| File | Isi |
|---|---|
| [MISSION.md](MISSION.md) | Kenapa project ini ada. North star, dua pilar, roadmap, success metrics, non-goals. **Dibaca pertama.** |
| [ARCH.md](ARCH.md) | Blueprint fisik: topologi mesin, komponen, context assembly, memory layers, flow per run, deployment via git. |
| [TLDR.md](TLDR.md) | Prinsip teknis dari Hermes Agent: stateless, cron amnesia, judge konservatif, fallback provider. |
| [setup/sync-pipeline.md](setup/sync-pipeline.md) | Tutorial end-to-end pipeline: SSH topology, Syncthing pairing, share folder vault, Obsidian-in-WSL install + shortcut. |
| [setup/cron-jobs.md](setup/cron-jobs.md) | Cron job setup dengan preflight pattern: shell wrapper cek kondisi dulu, LLM dipanggil hanya kalau ada kerjaan (saves ~480K tokens/hari di idle ticks). |
| [setup/telegram.md](setup/telegram.md) | Telegram bot utilization: #digest (cron output delivery) + #inbox (paste dari HP → save ke `00-Inbox/`). Includes Cloudflare/Twitter scoping (text-paste strategy). |
| [setup/web-fetching.md](setup/web-fetching.md) | Anti-bot & auth-walled source strategy: surveys X MCP, Scrapling, CloakBrowser. Layered escalation Tier 0 (text-paste) → Tier 3 (CloakBrowser). Triggers untuk implement. |
| [scripts/](scripts/) | Preflight scripts (`process_inbox.sh`, `graph_walker.sh`) yang di-symlink ke `~/.hermes/scripts/` di server. |
| [skills/knowledge-curator/](skills/knowledge-curator/SKILL.md) | Inbox-driven concept curation: input → web sources → schema-enforced concept notes with reciprocity. |
| [skills/project-researcher/](skills/project-researcher/SKILL.md) | Project deep-dive: whitepaper + docs + code + CA verified deployment → project notes with gap analysis, advantage framework, graph integration. |
| [skills/companion/](skills/companion/SKILL.md) | Telegram #ask chat: vault lookup → grounded answer, vault gap → web research + auto-curate inbox handoff. |
| [skills/](skills/) | Skills root (above) — di-symlink ke `~/.hermes/skills/` di server. |

---

## Stack

- **Agent runtime:** [Hermes Agent](https://github.com/NousResearch/hermes-agent) — cron-based, stateless per-run, persistent state di SQLite
- **Knowledge store:** [Obsidian](https://obsidian.md/) vault — plain markdown, wikilink, graph view
- **Sync:** [Syncthing](https://syncthing.net/) — vault bidirectional laptop ↔ server
- **Delivery:** Telegram (daily digest + alert)
- **Version control:** git → GitHub
- **Heartbeat:** [healthchecks.io](https://healthchecks.io/) (external liveness monitor)

---

## Topologi singkat

Tiga "rumah" terpisah di server (detail di [ARCH.md](ARCH.md#7-tiga-rumah--deployment-via-git)):

```
~/autonomous-agent/   ← REPO desain (git, source of truth)
~/.hermes/            ← RUNTIME Hermes (opaque, internal state)
~/vault/              ← WORKING DATA (Obsidian, shared via Syncthing)
```

Bridge antar rumah lewat symlink: `~/.hermes/skills/<name> -> ~/autonomous-agent/skills/<name>`.

---

## Status

| Fase | Output | Status |
|---|---|---|
| **0** — Foundation | Docs (MISSION/ARCH/TLDR/README/setup), skill `knowledge-curator` deployed, vault skeleton, Syncthing aktif, Obsidian-in-WSL | ✅ complete (2026-06-03) |
| **1** — Knowledge curator passive | `process-inbox-knowledge` cron jalan, 10+ konsep di graph, reciprocity verified | 🟡 in progress (2/10 — `mev`, `mempool`) |
| **2** — Knowledge curator active | `scan-curated-sources` (RSS + Twitter list curated) + `graph-walker` cron | ⚪ |
| **3** — Stabilize | 50+ konsep ter-link, ritme harian terbentuk | ⚪ |
| **4** — Alpha scanner | Pilar B nyala dengan reasoning dari graph | ⚪ |

---

## Quick start

Untuk deployment lengkap, lihat [ARCH.md Bab 7](ARCH.md#7-tiga-rumah--deployment-via-git). Singkatnya:

```bash
# Di server
git clone <repo-url> ~/autonomous-agent
mkdir -p ~/vault/{00-Inbox/_knowledge,00-Inbox/_processed,01-Daily,02-Projects,03-Areas/concepts,04-Archive}
ln -s ~/autonomous-agent/skills/knowledge-curator ~/.hermes/skills/knowledge-curator

# Bikin cron job pertama
hermes cron create "*/30 * * * *" \
  "Drain 00-Inbox/_knowledge/. If empty, output [SILENT]. Otherwise follow knowledge-curator skill." \
  --skill knowledge-curator \
  --workdir ~/vault \
  --name "process-inbox-knowledge"
```

Test loop: drop file ke `~/vault/00-Inbox/_knowledge/`, tunggu ≤30 menit, cek output di `~/vault/03-Areas/concepts/` + Telegram.

---

## Non-goals

Sistem ini **bukan**:

- ❌ Trading bot — tidak terhubung ke API exchange manapun
- ❌ Signal service — tidak ada "buy/sell" alerts
- ❌ News aggregator — input mentah dicerna jadi konsep, bukan dilempar ulang
- ❌ Generic crypto wiki — graph ini personal, framing pribadi yang jadi moat

Detail di [MISSION.md Bab 6](MISSION.md#6-non-goals).

---

## Lisensi

Personal project. No license granted.
