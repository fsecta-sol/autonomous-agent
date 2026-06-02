# Arsitektur Agent Autonomous — Versi Hermes Agent

Dokumen ini memetakan desain agent autonomous jangka panjang ke fitur-fitur yang sudah ada di [Hermes Agent](https://github.com/NousResearch/hermes-agent). Intinya: kamu tidak membangun arsitektur dari nol — kamu mengonfigurasi lapisan di atas framework yang sudah lengkap.

---

## 1. Prinsip dasar

Tiga kenyataan teknis yang membentuk seluruh desain. Ini berlaku baik di desain dari-nol maupun di Hermes:

- **LLM itu stateless.** Model tidak mengingat apa pun antar panggilan. "Mikir berhari-hari" mustahil dilakukan di dalam model — yang berhari-hari adalah sistem di luarnya. Model hanya dipanggil sebentar untuk satu keputusan, lalu lupa.
- **Proses yang nyala terus itu rapuh.** Mati lampu, reboot, OOM kill — proses maraton pasti mati di suatu titik. Maka default agent harus *mati*, bukan hidup. Ketahanan datang dari kemampuan dibangunkan ulang dengan ingatan utuh di disk.
- **Limit usage itu ritme, bukan halangan.** Kalau agent default-nya mati dan dibangunkan berkala, "kena limit" cukup berarti: run ini lewat, coba lagi nanti. Tidak perlu logika pause/resume yang ribet.

Konsekuensi dari ketiganya: **bukan satu proses panjang, tapi banyak proses pendek yang berbagi satu ingatan di disk.** Hermes mengimplementasikan ini secara harfiah.

---

## 2. Peta: desain konseptual → komponen Hermes

| Komponen konseptual | Implementasi di Hermes | Lokasi |
|---|---|---|
| Scheduler / heartbeat | cron scheduler (tick tiap 60 detik) | `cron/`, `~/.hermes/cron/jobs.json` |
| Working memory (state file) | output file + `context_from` antar job | `~/.hermes/cron/output/{job_id}/` |
| Episodic memory (riwayat diringkas) | `SessionDB.state_meta`, trajectory compressor | `hermes_state.py`, `trajectory_compressor.py` |
| Semantic memory (cari balik) | FTS5 session search + LLM summarization | built-in |
| Loop reason→act→reflect | `/goal` loop + judge model | built-in |
| Guardrail / kemampuan berhenti | judge konservatif + turn budget + command approval | built-in |
| Retry pada rate limit | fallback provider + credential rotation | `config.yaml` |
| Memori prosedural (cara kerja) | Skills, di-attach ke cron job | `skills/`, `~/.hermes/skills/` |

Hampir semua yang perlu dirancang manual di desain dari-nol sudah jadi di Hermes. Tugasmu adalah merangkainya, bukan membangunnya.

---

## 3. Dua jalur "jalan terus" — perbedaan yang menentukan

Hermes punya **dua mekanisme berbeda** untuk berjalan tanpa di-prompt ulang. Untuk goal jangka panjang, kamu kemungkinan butuh keduanya, dengan peran berbeda.

### Jalur A — `/goal`: iterasi dalam satu sesi

Kamu memberi goal, agent kerja satu turn, lalu judge model mengecek apakah goal terpenuhi. Kalau belum, Hermes otomatis menyuapi continuation prompt ke sesi yang sama dan terus bekerja sampai goal tercapai, kamu pause/clear, atau turn budget habis (default 20 turn).

- Cocok untuk task yang bisa selesai dalam satu sesi panjang.
- Bukan untuk rentang berhari-hari — itu peran cron.
- Disebut "Ralph loop"; terinspirasi dari Codex CLI.

```text
/goal Perbaiki semua lint error di src/ dan pastikan `ruff check` lolos
```

### Jalur B — cron: denyut lintas hari

Tiap job berjalan di sesi agent *fresh* tanpa memori run sebelumnya, dibangunkan scheduler yang tick tiap 60 detik. Ini implementasi harfiah dari "default mati, bangun berkala". Untuk goal yang span-nya berhari/bulan, cron adalah tulang punggungnya.

```bash
hermes cron create "every 1d at 09:00" \
  "<prompt self-contained berisi seluruh konteks goal>" \
  --skill <skill-cara-kerja> \
  --workdir /home/me/projects/goal-x
```

### Cara menyatukan untuk goal berhari-hari

> **cron yang memanggil, `/goal` yang mengiterasi di tiap panggilan.**

cron membangunkan agent tiap hari (atau tiap N jam). Tiap kali bangun, agent mengerjakan satu fase goal sampai judge bilang fase itu kelar, lalu tidur lagi. Besok lanjut fase berikutnya. **cron adalah jantungnya, `/goal` adalah ototnya per-sesi.**

---

## 4. Masalah krusial: cron itu amnesia

Jebakan terbesar, dan langsung berhubungan dengan desain memory.

Cron job berjalan di sesi yang benar-benar fresh — prompt harus berisi *semua* yang dibutuhkan agent yang tidak disediakan oleh skill. Artinya run hari ke-2 tidak otomatis tahu apa yang dilakukan run hari ke-1. Tanpa jembatan, agent terjebak Groundhog Day: mengulang hari pertama terus-menerus.

Hermes menyediakan tiga jembatan ingatan — persis tiga lapis memory di desain konseptual, tinggal pasang:

### Lapis 1 — Working memory: `context_from`

Prompt job B otomatis mendapat output terakhir job A di-prepend sebagai konteks saat runtime. Buat job "lanjutkan goal" yang `context_from`-nya menunjuk output run kemarin. Penyimpanannya pakai atomic file write, jadi interrupt tidak meninggalkan file setengah jadi (trik tulis-tmp-lalu-rename, sudah diimplementasikan).

```python
cronjob(
    action="create",
    schedule="0 9 * * *",
    context_from="<job_id_run_sebelumnya>",
    prompt="Baca progress di atas, lanjutkan goal dari titik itu.",
    name="Lanjutkan goal X",
)
```

### Lapis 2 — Episodic memory: `SessionDB.state_meta`

`/goal` menyimpan state-nya keyed by `goal:<session_id>`. Set goal, tutup laptop, kembali besok, `/resume` — goal masih berdiri persis seperti ditinggalkan (active, paused, atau done).

### Lapis 3 — Semantic memory: session search (opsional)

FTS5 session search dengan LLM summarization untuk cross-session recall. Pakai hanya kalau goal-mu butuh mencari fakta spesifik dari ratusan run lalu. Untuk kebanyakan goal, Lapis 1 + 2 sudah cukup. Jangan pasang ini di awal hanya karena terlihat canggih.

---

## 5. Skills — memori prosedural (kunci untuk goal berulang)

cron bisa meng-attach satu atau beberapa skill ke sebuah job; skill di-load sebelum prompt berjalan. Manfaatnya: scheduled agent mewarisi workflow reusable tanpa harus menjejalkan teks skill penuh ke dalam prompt cron.

Untuk goal autonomous-mu: **cara mengerjakan goal** — langkah, hal yang dicek, format output — ditulis sekali sebagai skill, lalu di-attach ke cron job. Tiap run fresh otomatis "tahu cara kerjanya" lewat skill, meskipun lupa kejadian spesifik run kemarin.

Dua jenis memori yang berbeda dan dua-duanya diperlukan:

- **Skill = memori prosedural** (cara melakukan).
- **`context_from` = memori episodik** (apa yang sudah terjadi).

```bash
hermes cron create "every 1d at 09:00" \
  "Lanjutkan goal X. Progress kemarin ada di konteks." \
  --skill cara-kerja-goal-x \
  --add-skill maps
```

---

## 6. Limit usage — sudah dijawab di level provider

Hermes menangani ini lebih elegan dari pola "exit lalu retry" manual. Cron job mewarisi fallback provider dan credential pool rotation: kalau API key utama kena rate-limit atau provider error, cron agent bisa fallback ke provider alternatif atau rotate ke credential berikutnya. Kena limit tidak membuat run gagal total — dia ganti jalur.

```yaml
# ~/.hermes/config.yaml
fallback_providers:
  - provider: openrouter
    model: <model-cadangan>
```

Plus prinsip "gratis nungguin" tetap berlaku di level infrastruktur: backend serverless (Daytona, Modal) hibernate saat idle dan bangun saat dibutuhkan, biaya nyaris nol antar-sesi.

---

## 7. Guardrail — yang membuatmu berani meninggalkannya jalan

Yang membuat agent autonomous bisa dipercaya berjalan unattended bukan kepatuhannya, tapi kemampuannya berhenti di saat yang tepat. Hermes menjahit ini ke inti loop:

- **Judge konservatif.** Goal ditandai done hanya kalau respons eksplisit mengonfirmasi selesai — atau kalau goal mustahil/terblokir (diperlakukan DONE dengan alasan blok, supaya tidak membakar budget di task yang tak tercapai). Ini rem otomatis untuk skenario "mengulang kesalahan selamanya".
- **Turn budget.** Backstop kalau judge salah; auto-pause di 20 turn (configurable lewat `goals.max_turns`).
- **`[SILENT]` untuk job monitoring.** Kalau respons diawali `[SILENT]`, pengiriman ditahan — berguna untuk job yang hanya melapor saat ada yang salah.
- **Command approval & container isolation.** Lapisan keamanan eksekusi (lihat docs Security).
- **Prompt scanning.** Prompt cron dipindai pola prompt-injection dan credential-exfiltration saat dibuat/di-update.

> Catatan desain: "jangan nolak, jalanin dulu" adalah kebalikan dari yang membuat agent autonomous aman. Hermes secara sengaja memilih agent yang *bisa berhenti* — judge konservatifnya adalah fitur, bukan keterbatasan.

---

## 8. Mapping akhir

Goal jangka panjangmu diterjemahkan menjadi:

1. **Teks `/goal`** dengan kriteria sukses yang terukur.
2. Dipanggil oleh **cron job** harian (atau tiap N jam) — denyut lintas hari.
3. Di-attach **skill** berisi cara kerja goal — memori prosedural reusable.
4. Dijembatani **`context_from`** agar tiap run ingat progress run sebelumnya.
5. Dijaga **judge + turn budget + command approval** agar berhenti di saat yang tepat.
6. Tahan limit lewat **fallback provider + credential rotation**.

---

## 9. Kerangka konkret (template)

```bash
# 1. Tulis skill berisi CARA mengerjakan goal (sekali saja)
#    → ~/.hermes/skills/goal-x/SKILL.md

# 2. Buat cron job harian yang menjalankan /goal, attach skill,
#    dan ambil progress kemarin lewat context_from
hermes cron create "0 9 * * *" \
  "Goal: <objektif + kriteria sukses terukur>. \
   Batasan keras: <hal yang TIDAK boleh dilanggar>. \
   Progress sebelumnya ada di konteks di atas. \
   Kerjakan satu fase, simpan hasil ke ~/.hermes/data/goal-x/progress.md, \
   lalu ringkas apa yang dicapai dan apa langkah berikutnya." \
  --skill goal-x \
  --workdir /home/me/projects/goal-x \
  --name "goal-x-daily"

# 3. (setelah job pertama jalan, ambil ID-nya)
hermes cron list

# 4. Edit job agar context_from menunjuk ke dirinya sendiri (self-chain)
hermes cron edit <job_id> --context-from <job_id>
```

Checklist sebelum melepasnya jalan:

- [ ] Goal punya **kriteria sukses terukur** (judge butuh ini untuk bilang "done").
- [ ] Goal punya **batasan keras** eksplisit di prompt.
- [ ] **Skill** berisi cara kerja sudah ditulis dan di-attach.
- [ ] **`context_from`** terpasang agar progress nyambung antar hari.
- [ ] **Toolset dibatasi** (`enabled_toolsets`) — jangan bawa semua tool ke tiap run (boros & berisiko).
- [ ] **Fallback provider** dikonfigurasi untuk ketahanan limit.
- [ ] **Delivery** diarahkan ke channel yang kamu pantau (mis. `telegram`), pakai `[SILENT]` jika hanya ingin lapor saat ada masalah.

---

*Disusun berdasarkan dokumentasi Hermes Agent (fitur cron & persistent goals) dan repositori NousResearch/hermes-agent.*