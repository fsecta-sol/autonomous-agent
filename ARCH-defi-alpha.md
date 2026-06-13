# ARCH-defi-alpha.md — Active curated-source scan & Alpha scanner (DeFi under the hood)

> Forward-design doc untuk dua mesin yang **belum dibangun**: **Active curated-source scanner** (FASE 2) dan **Alpha scanner / Pilar B** (FASE 4). Fokus: **DeFi under the hood** — mekanisme, code, on-chain state. BUKAN harga, BUKAN sosial, BUKAN sinyal. Baca [MISSION.md](MISSION.md) buat *kenapa* (north star + non-goals), [ARCH.md](ARCH.md) buat blueprint fisik sistem yang sudah jalan, [TLDR.md](TLDR.md) buat prinsip desain. Status tiap mesin ditandai 🔵 FASE-n.

---

## 0. Satu prinsip yang ngendaliin semua

> **Graph dipakai sebagai FILTER, bukan firehose dipakai sebagai sumber.**

Edge lu = pemahaman mekanisme yang lebih dalam dari market (north star). Dua mesin di doc ini cuma operasionalisasi satu kalimat itu:

- **Active scan** = mesin yang **mendalamkan** graph (ngubah sumber curated → konsep mekanisme).
- **Alpha scanner** = mesin yang **membelanjakan** graph (ngubah kandidat → tesis ter-grounding + track-record).

Kalau salah satu mulai fish dari noise mentah (Twitter trending, price pump, token baru random) → itu jebakan gambler yang MISSION.md Bab 7 larang. Guardrail keras:

```
1. Tiap klaim load-bearing WAJIB nunjuk artefak yang bisa dicek (baris code, tx hash,
   audit finding, source fetched). Nggak ada artefak = bukan klaim, itu tebakan → ditandai.
2. Reducible-to-graph atau tolak. Kalau sebuah play nggak bisa direduksi ke mekanisme
   yang SUDAH ada di graph → bukan "skip", tapi [NEEDS-CONCEPT] → suapin ke knowledge-curator.
   Scanner numbuhin graph sebagai efek samping, nggak gambling di luar pemahamannya.
3. Conviction = tesis falsifiable + kill-signal bernama, BUKAN persentase ngarang.
   Base rate cuma boleh dari track-record nyata (lihat Bab 5).
4. Delivery = reasoning, BUKAN "buy/sell". Non-goal MISSION.md Bab 6.
```

---

## 0.5 Gambaran besar — agent sekarang vs target

**Hari ini** (terverifikasi `ssh hermes`, 2026-06-13):
- **2 cron live**, dua-duanya `knowledge-curator` + wake-gate: `process-inbox-knowledge` (`*/30`), `graph-walker` (`0 */6`).
- **Graph: 33 concept.** Cluster DeFi-mekanisme lagi diisi — `amm`/`mev`/`erc-20`/`nft`/`dex-routing` ✅; `oracle`/`lending-protocol`/`liquidation`/`stablecoin`/`data-availability` baru masuk dari inbox.
- **Alpha infra** (watchlist / track-record / pattern base-rate): **BELUM ADA**.

Peta operasi penuh — `✅` live, `🔵` proposed. Knowledge engine **mbangun** edge; alpha engine **mbelanjain** edge; gerbang di antaranya = kematangan graph + track-record.

```
   KNOWLEDGE ENGINE (FASE 1-2)  ·  mbangun edge (ngisi the filter)
     ✅ process-inbox-knowledge   */30    drain _knowledge → concept notes
     ✅ graph-walker              0 */6   resolve dangling concept refs
     🔵 scan-curated-sources      06:00   curated → triage → seed   [MESIN 1]
   │
   │  ketiganya nyetor ke graph
   ▼
   ┌─ KNOWLEDGE GRAPH (03-Areas/concepts)  ·  THE FILTER
   │
   ▼
   ┌─ GERBANG KEMATANGAN   ◄── LU DI SINI (belum lewat)
   │     · graph 50+ di cluster DeFi
   │     · infra track-record ada
   │     · ≥1 pattern punya base rate
   ▼   lewat gerbang → nyalain:
   ALPHA ENGINE (FASE 4)  ·  mbelanjain edge (graph-grounded)
     🔵 alpha-scan      event   kandidat mekanis → graph-grounded filter   [MESIN 2]
     🔵 alpha-revisit   07:00   kill-signal fired? → outcome → base rate NYATA
   │
   ▼  ketemu mekanisme asing?
   [NEEDS-CONCEPT] ──► balik ke 00-Inbox/_knowledge/   (alpha NAMBAH edge, bukan ngabisin)
```

**Busur besarnya satu kalimat:** sekarang agent cuma **mbangun filter** (graph) lewat 2 cron knowledge; Mesin 1 mempercepat pengisian; begitu graph nembus gerbang kematangan, Mesin 2 mulai **mbelanjain** filter itu jadi tesis ber-track-record — dan tiap kali ketemu mekanisme asing, dia balik nyuapin graph (`[NEEDS-CONCEPT]`), jadi alpha **menambah** edge, bukan ngabisin. Detail tiap mesin di Bab 2-3, urutan nyalainnya di Bab 5.

---

## 1. Pipeline besar (satu gambar)

```
            CURATED SOURCES                         ON-CHAIN / CANDIDATES
        (research, audit, post-mortem)         (watched protocols, params, pools)
                  │                                          │
                  ▼                                          │
        ┌───────────────────────┐                            │
        │ MESIN 1: ACTIVE SCAN  │  (FASE 2)                  │
        │ scan_sources.sh       │                            │
        │ → triage mekanisme    │                            │
        │ → drop seed ke inbox  │                            │
        └──────────┬────────────┘                            │
                   │ seeds                                   │
                   ▼                                         │
        ┌────────────────────────┐                           │
        │ process-inbox-knowledge│ (SUDAH JALAN)             │
        │ knowledge-curator      │                           │
        │ → concept notes        │                           │
        └──────────┬─────────────┘                           │
                   │                                         │
                   ▼                                         ▼
        ╔═════════════════════════════════════════════════════════════╗
        ║         KNOWLEDGE GRAPH (03-Areas/concepts)                 ║
        ║   DeFi-mechanism cluster: oracle, lending, liquidation,     ║
        ║   amm, stablecoin, flash-loan, mev, points-farming, ...     ║
        ║   = THE FILTER                                              ║
        ╚═════════════════════════════┬═══════════════════════════════╝
                                      │ used as filter
                                      ▼
                          ┌────────────────────────┐
                          │ MESIN 2: ALPHA SCANNER │  (FASE 4 / Pilar B)
                          │ project-researcher     │
                          │ + graph-grounded gate  │
                          │ + conviction encoding  │
                          └──────────┬─────────────┘
                                     │
                  ┌──────────────────┼────────────────────┐
                  ▼                  ▼                    ▼
          [NEEDS-CONCEPT]      watchlist.md          pattern concept
          → balik ke graph     track-record.md       (base rate++)
          (numbuhin filter)    (the ledger)          (vibes-launch, ...)
                                     │
                                     ▼
                          revisit cron → kill-signal fired?
                          → update outcome → base rate jadi NYATA
```

Inti: **Mesin 1 → graph → Mesin 2 → (balik ke graph kalau bolong) → track-record → base rate → conviction berikutnya lebih kuat.** Itu loop compound-nya.

---

## 2. MESIN 1 — Active curated-source scanner 🔵 FASE 2

Tujuan: tiap pagi, baca **sumber kecil curated** yang bahas DeFi *under the hood*, saring yang ngejelasin **mekanisme**, drop jadi seed ke `00-Inbox/_knowledge/`. Mesin ini **nggak nulis concept note sendiri** — dia discovery + triage; penulisan tetap lewat `process-inbox-knowledge` (pemisahan tugas, satu jalur tulis).

### 2.1 Source whitelist (DeFi-mechanism-biased, <30)

Bias keras ke **mekanisme / code / audit / post-mortem**, downrank berita & harga.

| Kategori | Sumber | Kenapa (under-the-hood) |
|---|---|---|
| Research | paradigm.xyz, a16zcrypto.com, flashbots writings, ethresear.ch, vitalik.eth.limo | desain mekanisme dari sumbernya |
| DeFi-spesifik | protocol eng-blogs (Uniswap/Aave/Curve/Morpho), Delphi/Messari research | invariant, risk param, tokenomics mekanis |
| Audit | Trail of Bits, Spearbit, OpenZeppelin, Zellic, Cantina | failure mode di level code |
| Post-mortem | rekt.news, protocol incident reports | mekanisme yang BENERAN patah (case study emas) |
| Spec | eips.ethereum.org, governance forums (param changes) | perubahan mekanis yang ngegerakin sistem |
| On-chain mech | L2BEAT (trust assumptions), DefiLlama (TVL mech), Dune | sinyal mekanisme, bukan harga |
| Academic | **arXiv** — API query `search_query=all:blockchain&sortBy=submittedDate&sortOrder=descending` (sweet-spot kategori `cs.CR` + `cs.DC`) | riset mekanisme terdalam (zk-proof, konsensus, MEV theory, AMM/oracle math) sebelum jadi narasi mainstream |

> **Catatan arXiv (anti noise):** API-nya bersih (Atom XML, no auth, stabil buat `scan_sources.sh`) tapi query `blockchain` all-fields **sangat noisy** — banyak paper tangensial (supply-chain, IoT, "blockchain for X"). Triage WAJIB ketat: keep cuma yang ngejelasin mekanisme reducible ke graph crypto/DeFi (consensus, cryptography, MEV, AMM, DA, bridging); buang sisanya. Pertimbangkan persempit ke kategori `cat:cs.CR` / `cat:cs.DC` biar hit-rate naik. Treat seperti ethresear.ch: high-ceiling, high-noise.

Blacklist (MISSION.md Bab 7): CoinDesk/Cointelegraph/Decrypt sbg sumber primer, influencer threads, exchange-blog marketing, "X pump 50%".

### 2.2 Flow (wake-gate, konsisten sama cron existing)

```
06:00 cron tick  (--script scan_sources.sh --skill curator-triage --workdir ~/vault)
  │
  ▼
scan_sources.sh  (pre-check / wake gate)
  - fetch tiap feed (RSS/sitemap; Twitter-list via fetch_url.sh --stealth kalau perlu)
  - diff vs seen-ledger  ~/.hermes/state/scan_seen.json   (server-only, BUKAN vault)
  - 0 item baru → echo '{"wakeAgent": false}'   → LLM skip, zero token
  - N item baru → emit "New: <N> — <judul + url>"
  │
  ▼ (agent invoked)
TRIAGE (skill curator-triage — thin skill di atas knowledge-curator's extraction discipline)
  untuk tiap item:
    ┌─ Apakah ini ngejelasin MEKANISME? (oracle design, liquidation param,
    │  AMM invariant, MEV vector, emission/points mechanic, exploit root-cause)
    │     YES → tulis seed ke 00-Inbox/_knowledge/<concept-slug>.md
    │            (format seed: concept + angle "why" + connects [[..]] + sources)
    │     NO  (price/berita/announcement/vibes) → discard, catat di runs/ log
    └─ update seen-ledger
  │
  ▼
(tick berikutnya) process-inbox-knowledge → knowledge-curator → concept note penuh
```

### 2.3 Keputusan desain

- **Kenapa drop seed, bukan tulis langsung?** Satu jalur penulisan (knowledge-curator) = satu standar kualitas + reciprocity + type-taxonomy. Scan = mata, curator = tangan. Decoupled, gampang di-debug.
- **Seen-ledger di `~/.hermes/state/`**, bukan vault — itu state mesin, bukan knowledge (ARCH.md Bab 5: "kalau state agent yang lu gak perlu lihat, biarkan di ~/.hermes/").
- **Triage = gerbang anti generic-wiki.** Tanpa triage, active scan ngubah graph jadi RSS dump (anti-pattern MISSION.md). Triage maksa "mekanisme atau buang".
- **Skill `curator-triage`** tipis: cuma keputusan keep/discard + nulis seed. Extraction rules diwarisi dari [knowledge-curator](skills/knowledge-curator/SKILL.md).

---

## 3. MESIN 2 — Alpha scanner / Pilar B 🔵 FASE 4

Tujuan: pakai graph buat **bedah peluang DeFi di level mekanisme** dan ngeluarin **tesis ter-grounding + kill-signal**, dilog ke track-record. Reaktif dulu, otonom belakangan (Bab 6).

### 3.1 Candidate intake (mekanisme, BUKAN harga)

Sinyal yang ngundang analisis = **event mekanis**, bukan gerakan harga:

| Sumber kandidat | Sinyal | Bukan |
|---|---|---|
| User drop | `00-Inbox/_projects/<slug>.md` | — |
| Active-scan flag | sumber nyebut protokol/mekanisme baru | — |
| On-chain watch | kontrak verified baru di protokol yang di-watch; governance proposal nyentuh risk param (collateral factor, oracle source, fee); audit baru terbit; event admin-key/upgrade; shift likuiditas/TVL ekstrem di pool yang di-track | ❌ "token X +50%" |

### 3.2 Graph-grounded filter (gerbang utama)

```
KANDIDAT
  │
  ▼
project-researcher (ALPHA / HYBRID mode) — baca CODE + on-chain dulu
  │
  ▼
REDUCIBLE-TO-GRAPH?  bisa direduksi ke mekanisme yang SUDAH ada di graph?
  │
  ├─ TIDAK (ada mekanisme yang graph belum punya)
  │     → [NEEDS-CONCEPT] → drop seed ke _knowledge/ → PARK kandidat
  │       (jangan analisis sesuatu yang lu sendiri belum paham mekanismenya)
  │
  └─ YA → lanjut
        │
        ▼
   GAP ANALYSIS (narasi vs realita mekanisme)  ← jantung edge, sudah ada di project-researcher
        │
        ▼
   5-QUESTION ADVANTAGE FRAMEWORK
        │   3+ "unclear/no" → [NO-EDGE] → catat pattern → STOP (jangan yapping)
        ▼
   CONVICTION ENCODING (Bab 4)
        │
        ▼
   tulis ke watchlist.md + track-record.md  +  update pattern concept base rate
        │
        ▼
   deliver REASONING ke Telegram (tesis + kill-signal, BUKAN "buy/sell")
```

Insight: gerbang `[NEEDS-CONCEPT]` itu yang bikin scanner **nggak bisa** gambling di luar pemahaman — kalau dia ketemu mekanisme asing, dia *belajar dulu* (numbuhin graph), bukan nebak.

### 3.3 Yang dibaca (DeFi under the hood — checklist mekanis)

Scanner BUKAN ngeliat chart. Dia baca:

- **Oracle**: sumber harga (Chainlink feed / on-chain TWAP), bisa di-manipulasi flash-loan? → [[oracle]]
- **Collateral & liquidation**: collateral factor, liquidation threshold/bonus, bad-debt handling → [[lending-protocol]], [[liquidation]]
- **AMM invariant**: constant-product/stableswap/weighted, fee tier, konsentrasi LP, single-LP rug surface → [[amm]]
- **Value capture / emission**: fee routing, token emission, points/airdrop mechanic, siapa nge-extract → [[mev]], points-farming
- **Trust surface**: `onlyOwner`/upgradeable/multisig/guardian, timelock, admin keys → siapa bisa rug
- **Token standard baseline**: standar ERC-20/NFT = baseline; rug risk pindah ke ownership/likuiditas → [[erc-20]], [[nft]]

### 3.4 Output: watchlist & track-record (infra yang HILANG sekarang)

ARCH.md ngebayangin ini tapi vault sekarang masih flat. Struktur target:

```
02-Projects/
  _alpha/
    watchlist.md          ← call aktif: slug, tesis 1-baris, kill-signal, entry-state, tanggal
    track-record.md       ← call closed: outcome, kill-signal fired?, hit-rate PER PATTERN
    runs/YYYY-MM-DD.md     ← log run scanner (apa di-scan, apa di-skip & kenapa)
  <slug>.md               ← project note penuh (project-researcher), di-link dari watchlist
03-Areas/concepts/
  vibes-launch.md, ...    ← PATTERN sebagai concept (type: trading); base rate diakumulasi di sini
```

### 3.5 Revisit loop (mesin kejujuran)

```
revisit cron (harian/mingguan)
  untuk tiap call OPEN di watchlist:
    - kill-signal udah fired? → close, catat outcome di track-record
    - outcome materialized? → ukur vs tesis
  → update base rate pattern terkait
  (DI SINI angka probabilitas berhenti ngarang: "60/25/12/3" jadi
   "dari N play pattern X yang di-track, hit-rate Loot-tier = Y%")
```

---

## 4. Conviction discipline (load-bearing — ini yang misahin alpha dari judi)

Disalin dari prinsip anti-yapping/anti-halusinasi. Tiap output Mesin 2 WAJIB:

1. **Tiga-tingkat klaim**: tag tiap klaim load-bearing — `OBSERVED` (gw baca di code/on-chain) / `INFERRED` (nyusul logis) / `ASSUMED` (belum diverif → WAJIB ditandai).
2. **Verify-or-flag, jangan diisi**: fakta nggak keverif → `[UNVERIFIED]`/`[NEEDS-MANUAL]`, bukan angka plausibel.
3. **Reconcile-or-flag**: angka yang nggak nyambung (mis. claimed APY vs on-chain fee revenue) = `CONFLICT` yang wajib diselesaikan, bukan ditambal "either/or".
4. **Larang false precision**: persentase tanpa reference class = dilarang. Sitir base rate dari track-record, atau label "prior ilustratif, bukan data".
5. **Tesis falsifiable + kill-signal bernama**: bukan "mungkin pump". Tapi "Tesis: X. Berlaku sampai SINYAL Y. Kalau Y → tesis mati, exit."
6. **Panjang = fungsi bukti**: 3/5 unclear → `[NO-EDGE]`, berhenti.

---

## 5. Sequencing & prasyarat (JANGAN bangun kecepetan)

MISSION.md bener: Pilar B kecepetan = signal aggregator tanpa konteks. Urutan wajib:

```
SEKARANG (FASE 1→2): perdalam graph di cluster DeFi-mekanisme.
   prasyarat lanjut: graph ~50+ konsep, cluster oracle/lending/liquidation/
   stablecoin/amm/mev/points ke-isi & ter-link.
        │
        ▼
FASE 2: bangun MESIN 1 (active scan) → ngebut-in graph ke 50+.
        │
        ▼
BRIDGE: bangun infra track-record (Bab 3.4) — REAKTIF dulu.
   Tiap user drop alpha play (kayak lapis) → project-researcher →
   log ke watchlist/track-record + setor pattern. Belum otonom.
   prasyarat lanjut: ≥5-10 play ke-track dengan outcome → base rate NYATA.
        │
        ▼
FASE 4: baru nyalain MESIN 2 otonom (on-chain candidate intake + filter).
   Karena base rate udah ada, conviction-nya terukur, bukan ngarang.
```

Tanda lu udah siap geser ke alpha: **lu bisa baca sebuah play dan TIAP klaim mekanisnya nyangkut ke node yang sudah ada di graph.** Sekarang belum (oracle/lending/stablecoin masih baru diproses dari inbox).

---

## 6. Ringkasan cron (target akhir)

| Cron | Schedule | Skill | Script (wake-gate) | Status |
|---|---|---|---|---|
| process-inbox-knowledge | `*/30 * * * *` | knowledge-curator | process_inbox.sh | ✅ jalan |
| graph-walker | `0 */6 * * *` | knowledge-curator | graph_walker.sh | ✅ jalan |
| **scan-curated-sources** | `0 6 * * *` | curator-triage | scan_sources.sh | 🔵 FASE 2 |
| **alpha-revisit** | `0 7 * * *` (atau mingguan) | alpha-scanner | revisit_watchlist.sh | 🔵 FASE 4 |
| **alpha-scan** | event/on-chain-triggered | alpha-scanner | alpha_intake.sh | 🔵 FASE 4 |

Semua ikut pola wake-gate (ARCH.md / [setup/cron-jobs.md](setup/cron-jobs.md)): script pre-check murah, LLM cuma jalan kalau ada kerjaan nyata.

---

*Companion: [MISSION.md](MISSION.md) (kenapa + non-goals), [ARCH.md](ARCH.md) (blueprint fisik), [setup/cron-jobs.md](setup/cron-jobs.md) (pola wake-gate). Doc ini = forward-design; tandai 🔵 = belum dibangun. Update status pas tiap mesin live.*