# Setup graph-walker — autonomous graph expansion

Cron job kedua untuk knowledge curation. Sementara `process-inbox-knowledge` reaktif (proses input yang user drop), graph-walker proaktif: tiap N jam dia scan vault, pilih concept yang **paling dalam dan belum dibuat**, lalu tulis dari awal dengan canonical sources + reciprocity check.

**Tujuan utama:** graph compound sendiri. Lu drop satu concept, agent trace turun ke akar foundations/cryptography tanpa lu drop input lagi.

---

## Konsep

### Masalah yang dipecahkan

Inbox-only mode = graph cuma tumbuh saat user drop input. Realitanya:
- Tiap concept yang dibuat punya 3-5 forward wikilinks ke concept lain (`Builds on`, `Enables`)
- Concept-concept itu **tidak otomatis dibuat** — mereka jadi "dangling refs" di graph
- Tanpa intervensi, graph statis di concept yang lu sentuh manual

### Solusi: ancestry walking

Graph-walker setiap tick:
1. Scan semua concept yang sudah ada
2. Identifikasi dangling refs (wikilinks ke concept yang file-nya belum ada)
3. Hitung "depth" tiap dangling — seberapa dekat ke layer cryptography (root)
4. Pilih yang **paling dalam** (tie-break: paling banyak di-reference)
5. Proses seperti dia adalah input baru — fetch sources, tulis full concept note dengan diagram + examples + reciprocity

### Kenapa "deepest" priority bukan "most-referenced"?

Pemilihan deepest-first sengaja, supaya **foundation concept terisi sebelum higher-layer concept**. Ini memastikan setiap concept lapis atas punya complete ancestry traceable to crypto primitives:

```
Day 1: user drops MEV → mev.md created (market layer)
Day 2: graph-walker picks block-production (foundations, 1 hop deeper) → fills
Day 3: graph-walker picks consensus (foundations, deeper) → fills
Day 4: graph-walker picks hash-function (cryptography, deepest) → fills
       At this point, MEV's full ancestry chain traceable to math primitives
Day 5: graph-walker picks next dangling, e.g., mempool's ancestor
```

Filling top-down (market → cryptography) bikin lu punya **vertical slice complete** untuk satu domain sebelum branching. Versus most-referenced (yang horizontal-first) yang scatter graph evenly tanpa depth.

---

## Schedule rationale

Default: **`0 */6 * * *`** = setiap 6 jam (4 walks/hari).

Trade-off:
- Lebih cepat dari ini (tiap jam = 24/hari): boros token, risiko bikin terlalu banyak shallow notes
- Lebih lambat (sekali sehari): graph terasa stagnan, lu kebanyakan dropping manual

4 walks/hari = ~28 concept baru per minggu. Setelah 1 bulan, ~100 concept di graph. Itu critical mass dimana graph view di Obsidian mulai terasa "alive".

Adjust kalau:
- Token budget ketat → naikin ke 8-12h interval
- Lu drop banyak inputs harian + ingin graph density tinggi → turunin ke 2-3h
- Quality output mulai dilute (notes shallow, "neighbor walk" feels random) → naikin interval, evaluate skill

---

## Cron command

Jalankan di server hermes (setelah git pull untuk dapat skill terbaru):

```bash
hermes cron create "0 */6 * * *" \
  "You are running a graph-walk task. Step 1: list all wikilinks [[...]] across 03-Areas/concepts/*.md. Step 2: identify dangling refs — wikilinks pointing to concepts that do not yet have files. Step 3: for each dangling, estimate depth (closeness to cryptography layer based on context in source notes). Step 4: pick the deepest dangling; tie-break by most-referenced. Step 5: process the picked concept by following the knowledge-curator skill workflow as if it were dropped as input — fetch canonical sources, write full concept note with Diagram + Real-world examples sections, run reciprocity check, populate inbound link reciprocals. Step 6: append to today's daily log under '## Graph walk — <HH:MM>' with which concept was filled, depth estimate, and any [NEEDS-*] flags raised. If no dangling refs exist, output [SILENT]." \
  --skill knowledge-curator \
  --workdir ~/vault \
  --name "graph-walker"
```

Verifikasi:

```bash
hermes cron list
# harus tampak "graph-walker", next run jam berikutnya yang kelipatan 6 (00:00, 06:00, 12:00, 18:00)
```

---

## Prompt logic dijabarkan

Agent setiap tick eksekusi 6 step:

**Step 1 — Discovery.** Grep semua `[[...]]` pattern di `03-Areas/concepts/*.md`. Hasilnya list semua referenced concept slugs.

**Step 2 — Filter dangling.** Untuk tiap slug, cek apakah `03-Areas/concepts/<slug>.md` exists. Yang tidak = dangling.

**Step 3 — Depth estimation.** Baca context dimana slug di-reference. Kalau muncul di `## Builds on` dari concept yang sudah ada di layer X, dia kemungkinan di layer X-1 atau lebih dalam. Heuristik:
- Referenced di `Builds on` dari market-layer concept → kemungkinan platforms/foundations layer
- Referenced di `Builds on` dari foundations → kemungkinan cryptography
- Referenced di `Enables` → kemungkinan lebih atas (jarang dangling, biasanya yang baru ke-create)

**Step 4 — Pick.** Deepest first. Kalau tie, banyak reference (most-needed) jadi tie-breaker. Output: 1 concept slug.

**Step 5 — Process.** Treat slug seperti input baru. Jalankan workflow lengkap skill knowledge-curator dari step 4 (active source gathering) sampai step 10 (reciprocity check). Reciprocity check sangat penting di sini — concept yang baru dibuat HARUS punya `## Enables` yang reference back ke concept lapis atas yang nge-ref dia.

**Step 6 — Log.** Append ke daily log section `## Graph walk — <time>` dengan format mirip inbox processing log.

---

## Verification setelah pertama kali jalan

Setelah graph-walker run pertama (tunggu sampai 6h interval pertama atau trigger manual):

```bash
# 1. Cek file baru di concepts/
ls -la ~/vault/03-Areas/concepts/
# Harus ada satu concept baru selain mev.md, mempool.md

# 2. Baca concept baru — verifikasi schema lengkap
cat ~/vault/03-Areas/concepts/<new-concept>.md
# Cek: frontmatter ✓, 2+ canonical sources ✓, Diagram ✓, Builds on/Enables/Related ✓

# 3. Verifikasi reciprocity berjalan
grep -l "[[<new-concept>]]" ~/vault/03-Areas/concepts/*.md
# Concept yang nge-ref harus ke-update juga (atau setidaknya keep aligned)

# 4. Baca daily log
cat ~/vault/01-Daily/$(date +%Y-%m-%d).md
# Harus ada section "## Graph walk — HH:MM" dengan summary
```

---

## Tuning

| Symptom | Action |
|---|---|
| Notes terlalu shallow / generic | Skill perlu di-tighten lagi. Cek apakah depth estimation di Step 3 akurat — kalau agent pilih dangling yang konteks-nya terlalu tipis, notes hasil bakal lemah |
| Graph "drift" — concept ke-fill far from area lu peduliin | Drop manual inputs ke neighborhood yang lu prioritize. Graph-walker biased toward dangling existing, jadi area dengan banyak concept seedling-nya akan dapat priority |
| Token cost meledak | Naikkan interval (`0 */12 * * *` = 2x/hari). Atau pause: `hermes cron disable graph-walker` |
| Banyak [CONFLICT] flags | Layer taxonomy mismatch. Cek apakah skill rules tentang reciprocity classification masuk akal untuk situation yang ke-flag |
| Reciprocity gak konsisten | Verifikasi SKILL.md updated dengan Reciprocity rules. `cat ~/.hermes/skills/knowledge-curator/SKILL.md \| grep -A 5 "Reciprocity rules"` — kalau gak muncul, git pull belum sinkron |

---

## Failure modes

1. **Loop reference**: A links B, B links A. Both dangling. Graph-walker pick A, fill A, reciprocity adds A→B in B's would-be Enables. But B isn't created yet. Result: A.md complete but still references dangling B. Next walk picks B → fills B → reciprocity check adds B→A which already exists. Loop resolves naturally. **Tidak masalah.**

2. **Concept yang gak ada canonical source**: Misal slug `[[narrative-cycle]]` — concept market-layer abstract. Mungkin gak ada paper Paradigm/Flashbots tentang ini. Skill rule mandatekan canonical source, jadi agent flag `[NEEDS-SOURCE]` dan skip. Daily log report this. **User intervention needed** — kasih input manual atau accept dangling stay.

3. **Layer misclassification cascade**: Agent salah klasifikasi layer concept baru, reciprocity ngebawa link yang salah arah (e.g., concept platforms di-Enables ke market yang seharusnya di Builds on). Risk: graph integrity rusak. Mitigation: skill anti-pattern explicit melarang silent skip; kalau ragu, flag `[CONFLICT]`.

4. **Cron tick coincide dengan inbox processing**: Dua cron jalan barengan. Hermes harusnya serialize (single session per skill), tapi kalau race condition, dua run bisa nulis concept yang sama. Risk: conflict file. Mitigation: schedule offset (graph-walker di menit 00, inbox di menit 30) — sudah otomatis dengan default schedules.

---

## Disable / pause

Kalau perlu pause sementara (misal lu bulk reorganize vault):

```bash
hermes cron disable graph-walker
# atau pakai job_id:
hermes cron disable <job_id>
```

Re-enable:

```bash
hermes cron enable graph-walker
```

Delete permanen:

```bash
hermes cron delete graph-walker
```

---

*Companion: lihat [skills/knowledge-curator/SKILL.md](../skills/knowledge-curator/SKILL.md) untuk procedural rules yang graph-walker pakai. Lihat [MISSION.md](../MISSION.md#9-roadmap) untuk posisi graph-walker di roadmap (Fase 2).*
