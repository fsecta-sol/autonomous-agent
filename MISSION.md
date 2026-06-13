# MISSION.md — Kenapa agent ini ada

> Doc ini dibaca **pertama** kalau kamu kembali ke project ini setelah lama. Jawabannya: ngapain gw bangun ini, untuk siapa, dan apa yang gw kejar. Untuk *gimana* sistemnya secara fisik, lihat [ARCH.md](ARCH.md). Untuk *kenapa* desain teknisnya, lihat [TLDR.md](TLDR.md).

---

## 1. North star

> **Create my own edge in crypto through compound understanding.**

Satu kalimat. Tiga kata kunci yang harus diingat:

- **My own** — bukan ngikutin influencer, KOL, signal group. Edge yang gak punya replika di Twitter karena dibangun dari framing personal kamu.
- **Edge** — keunggulan struktural. Bukan luck, bukan timing, bukan akses orang dalam. Pengertian yang lebih dalam dari rata-rata pasar.
- **Compound understanding** — pengertian yang ditambah hari demi hari, bukan dipanen sekali pakai. Tiap konsep baru di-link ke yang lama. Bulan ke-12 jauh lebih dalam dari bulan ke-1.

---

## 2. Thesis

Orang kaya dari crypto ada di dua kategori:

1. **Lucky early** — beli BTC 2013, ETH ICO, kena memecoin random di awal. Tidak reproducible. Lewat sudah lewat.
2. **Structural edge** — pengertian + jaringan + infrastruktur + kesabaran lintas cycle. Yang ini **bisa dibangun**.

Satu-satunya jalur yang masuk akal sekarang adalah #2. Agent ini = mesin yang bantu bangun edge struktural lebih cepat dari kalau dilakukan manual.

**Wealth jadi by-product dari edge, bukan target langsung.** Mengejar wealth langsung tanpa edge = gambling, dan agent yang dibangun untuk gambling cepat jadi sampah (FOMO, sinyal Twitter, pump chasing).

---

## 3. Domain map — yang harus dipahami dalam

Crypto bukan kumpulan konsep acak; ini stack. Tiap perubahan di lapis atas selalu bisa ditelusuri ke lapis bawah. "Kenapa X" = panah vertikal turun.

```
                  ┌──────────────────────────────┐
                  │  MARKET / ALPHA / CYCLE      │  ← di sini uang
                  │  memecoin · ponzi · trends   │     mengalir
                  │  cycle · narrative · MEV     │
                  └──────────────┬───────────────┘
                                 │ enabled by
                                 ▼
                  ┌──────────────────────────────┐
                  │  APPLICATIONS                │
                  │  dapp · token · coin         │  ← apa yang dibangun
                  │  defi · nft · stablecoin     │
                  └──────────────┬───────────────┘
                                 │ run on
                                 ▼
                  ┌──────────────────────────────┐
                  │  PROGRAMMABLE BLOCKCHAINS    │
                  │  ethereum · solana · L2      │  ← platform
                  │  smart contracts             │
                  └──────────────┬───────────────┘
                                 │ extend
                                 ▼
                  ┌──────────────────────────────┐
                  │  FOUNDATIONS / CONSENSUS     │
                  │  bitcoin · PoW · PoS         │  ← mekanisme
                  │  mining · staking            │
                  └──────────────┬───────────────┘
                                 │ built on
                                 ▼
                  ┌──────────────────────────────┐
                  │  CRYPTOGRAPHY                │
                  │  hash · signature · merkle   │  ← math fundamental
                  └──────────────────────────────┘

  CROSS-CUTTING — nempel di semua lapis:
  ┌─────────────────────────────────────────────┐
  │  MONEY / ECONOMICS                          │
  │  monetary theory · incentive design ·       │
  │  game theory · network effects · reflexivity│
  └─────────────────────────────────────────────┘

  PROGRAMMING — nempel di lapis 2–4:
  ┌─────────────────────────────────────────────┐
  │  solidity · rust · move · MEV · audit       │
  └─────────────────────────────────────────────┘
```

**Aturan emas knowledge graph:** tiap concept note **wajib punya minimal satu panah vertikal** — link ke konsep di lapis lain. Note tanpa panah = trivia, bukan edge.

---

## 4. Dua pilar

### Pilar A — Knowledge curator (FASE 1, sekarang)

Tujuan: bangun knowledge graph crypto personal yang **menjawab "kenapa"** — bukan cuma "apa".

Input dua jalur:

- **Passive** — kamu drop artikel / tweet / link / pertanyaan ke `vault/00-Inbox/`. Agent cerna, ekstrak konsep, link ke graph yang sudah ada.
- **Active** — agent baca sumber curated tiap pagi (RSS researcher pilihan, Twitter list <30 akun signal-tinggi), proses top item.

Output: `vault/03-Areas/concepts/<concept>.md` — satu konsep per file, di-link dengan `[[wikilink]]` ke konsep terkait. Bahasa: **Inggris** (untuk portabilitas + langauge learning).

### Pilar B — Alpha scanner (FASE 4, setelah graph cukup)

Tujuan: pakai knowledge graph yang sudah dibangun untuk **filter peluang** — bukan untuk fish dari noise mentah.

Belum dibangun. Build setelah Pilar A berjalan 4-6 minggu dan graph sudah punya 50+ konsep ter-link. Membangun ini terlalu cepat = membangun signal aggregator tanpa konteks = jebakan gambler mindset.

> Arsitektur + flow detail (active curated-source scan FASE 2 → graph → alpha scanner FASE 4, fokus **DeFi under the hood**: mekanisme/code/on-chain, bukan harga) ada di [ARCH-defi-alpha.md](ARCH-defi-alpha.md). Intinya: graph dipakai sebagai *filter*, dan alpha play numbuhin graph (`[NEEDS-CONCEPT]`) sebagai efek samping — bukan gambling di luar pemahaman.

---

## 5. Success metrics

| Timeframe | Success indicator |
|---|---|
| **Bulan 1** | 30+ konsep di graph, semua punya minimal 1 wikilink vertikal |
| **Bulan 3** | Bisa jawab "kenapa X" dari graph sendiri tanpa googling untuk 80% pertanyaan crypto rutin |
| **Bulan 6** | Pilar B jalan, watchlist mingguan terbentuk dengan reasoning eksplisit (bukan vibes) |
| **Bulan 12** | Track record alpha pick dengan hit rate terukur. Knowledge moat yang gak punya replika di Twitter. |

Metric yang **sengaja TIDAK diukur** dulu: PnL, follower count, jumlah pick yang viral. Itu lagging indicators yang bikin sistem mengejar hal salah.

---

## 6. Non-goals

Yang sistem ini **bukan**:

- ❌ **Trading bot** — tidak ada API exchange terhubung, tidak ada eksekusi otomatis. Pernah.
- ❌ **Signal service** — tidak ada "buy X sell Y" alert ke Telegram. Watchlist boleh, tapi dengan reasoning, bukan sinyal.
- ❌ **News aggregator** — RSS reader sudah banyak; ini bukan itu. Input mentah cuma menarik kalau dicerna jadi konsep.
- ❌ **Generic crypto wiki** — graph ini personal: framing kamu, pertanyaan kamu, konteks kamu. Kalau apa yang ditulis agent persis Investopedia, gak ada edge.

---

## 7. Anti-pattern yang harus dihindari

- **Chasing pump.** Kalau agent mulai sering kirim "X naik 50% hari ini", sistem mulai deviasi. Pump bukan signal — *kenapa* pump itu signal.
- **Knowledge tanpa "kenapa".** Note "Solana fast" tanpa link ke parallel execution / Sealevel / consensus = sampah. Tiap concept minimal satu panah vertikal.
- **Graph yang gak pernah dibaca.** Kalau 2 minggu kamu gak buka Obsidian, sistem jadi dump file. Weekly review wajib.
- **Active scan yang serakah.** Twitter firehose dan RSS 50+ sumber = noise. Active scan **harus dari sumber curated kecil** (lihat Pilar A).
- **Mengejar metrics yang salah.** Lihat Bab 5 — tidak ngukur PnL/follower dulu karena itu mengganggu compound learning.

---

## 8. Ritme operasional

3 lapis cron (detail di [ARCH.md](ARCH.md) Bab 6):

```
PASSIVE (inbox watchers)    — every 30 min — react to your drop
ACTIVE  (curated scans)     — 06:00 daily  — process curated sources
META    (digest + review)   — 21:00 daily, Mon 08:00 — keep system honest
```

Peran kamu sebagai operator:

- **Pagi/siang/malam** — drop input ke `00-Inbox/` saat nemu sesuatu menarik
- **Sebelum tidur** — baca Telegram digest
- **Tiap Senin** — buka Obsidian, baca weekly review, prune/curate graph

Kalau ritme ini gak terjadi 2 minggu berturut-turut, **sistem dianggap unhealthy** — bukan agent yang salah, tapi engagement-mu yang turun. Pertimbangkan pause goal.

---

## 9. Roadmap

| Fase | Durasi target | Output | Status |
|---|---|---|---|
| **0** — Foundation | 1 minggu | MISSION+ARCH+TLDR final, vault skeleton, Syncthing nyala, Obsidian-in-WSL siap, skill `knowledge-curator` pertama deployed | ✅ complete (2026-06-03) |
| **1** — Knowledge curator passive | 1-2 minggu | `process-inbox-knowledge` jalan, 10+ konsep di graph, reciprocity verified | 🟡 in progress (2/10 — `mev.md`, `mempool.md`) |
| **2** — Knowledge curator active | 1-2 minggu | `scan-curated-sources` jalan, sumber RSS+Twitter list dipilih | ⚪ |
| **3** — Stabilize | 4 minggu | 50+ konsep, ritme harian terbentuk, graph view padat | ⚪ |
| **4** — Alpha scanner | start setelah Fase 3 | Pilar B nyala dengan reasoning dari graph | ⚪ |

---

*North star: **create my own edge in crypto through compound understanding**. Wealth jadi by-product, bukan target. Ulang baca tiap Senin pagi sebelum review.*
