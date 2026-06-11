# Research before extending companion skill

Sebelum implement companion v2 (combined mode, project routing, augmented retrieval, dst), riset existing patterns dulu. Banyak yang lu mau bangun sudah di-solve atau di-coba orang lain di field yang aktif. Tujuan dokumen ini: kasih taxonomy + keyword map biar lu bisa search efisien.

## What you're actually building

**Agentic RAG over Personal Knowledge Graph + self-improving curation.**

Breakdown:
- **RAG** (Retrieval Augmented Generation) — paradigm base: retrieve dari knowledge source dulu, baru generate grounded answer
- **Agentic** — agent decide sendiri kapan retrieve / kapan search / kapan curate (vs naive RAG one-shot retrieval)
- **Personal Knowledge Graph** — bukan generic web/DB, tapi structured personal notes (Obsidian, Roam) dengan wikilinks + layers
- **+ self-improving / auto-curate** — gap di vault → web research → write back to vault. Yang ini cutting-edge, less established

## Sub-fields yang relevan

| Sub-field | Relevan untuk |
|---|---|
| **RAG basics** | Vault-grounded answers, citation patterns |
| **Hybrid retrieval** | Combining keyword + semantic + graph traversal (wikilink follow) |
| **Query routing / classification** | Concept vs project vs combined mode detection |
| **Self-RAG / CRAG** | Self-reflective: agent evaluate retrieved content quality before answer |
| **GraphRAG** (Microsoft term) | Pakai structure graph (layers, wikilinks) untuk reasoning |
| **Active curation / knowledge distillation** | Auto-write-back gap detection |
| **PKM + AI** | Meta-category, personal knowledge management dengan LLM |
| **Conversational memory / session continuity** | Multi-turn context handling |

## Current state audit (snapshot)

Sebelum research diving, baseline: apa yang sudah resolved vs masih open di current system. Hindari research yang chase concerns yang sebenernya udah ke-handle. Update doc ini saat scale berubah (50+ concepts, 10+ projects).

### ✅ Resolved (evidence di current state)

| Concern | Why resolved |
|---|---|
| **Concept vs skill overlap** | Skills define HOW (procedural); concepts define WHAT (declarative). No file/rule overlap. |
| **Reciprocity / graph consistency** | Skill enforce bidirectional links. Audit: 0 dangling refs (post project-name filter). At 18 concepts scale, integrity solid. |
| **Web fetching reliability (non-Twitter)** | Scrapling + fetch_url.sh verified. Tier 1 covers most, Tier 2 untuk CF Turnstile. |
| **Auto-curate vs ask-permission** | Design decision dibuat (auto-curate via inbox handoff). Bukan open question. |
| **Token bloat di idle ticks** | Wake gate pattern. Idle cron = `wakeAgent: false` = 0 tokens. |

### 🟡 Partially mitigated

| Concern | Sekarang | Yang masih open |
|---|---|---|
| **Curation tax (auto-create)** | Skills: anti-pattern + reject list + status flags | No periodic quality re-check. At 100+ concepts, drift risk. |
| **Hallucination prevention** | Skills enforce citation, explicit "no fabrication" rules | No runtime check / eval — depends on agent compliance |
| **Active consumption / retrieval** | Companion v1 ada (vault lookup grep) | Naive keyword-only, no semantic / hybrid / graph traversal |
| **Routing project vs concept** | Companion v1 search both 02-Projects/ dan 03-Areas/ | Inbox handoff broken untuk project queries (planned for v2) |

### ❌ Still open (verified absent in current state)

| Concern | Evidence |
|---|---|
| **Versioning / temporal knowledge** | 0 concept notes punya `last_verified` / `verified_at` / `stale_after` field. No decay mechanism. |
| **Embedding-friendly metadata** | 0 concept notes punya `summary` / `keywords` / `centrality` frontmatter. Future RAG/embedding pipeline akan struggle. |
| **Retrieval quality (semantic)** | Hanya grep + read top matches. No vector / hybrid / re-rank. |
| **Recency vs durable distinction** | Companion design discussion ada, tapi implementasi nol di v1. |
| **Multi-modal** | ASCII diagrams only. No image/chart support. (Not blocking) |
| **Stale knowledge** | No mechanism untuk refresh, mark dirty, auto-deprecate. |
| **Self-edit hallucination compounding** | Agent enrich existing notes during reciprocity. No review gate. |

### 🟦 Not applicable (intentional design)

| "Concern" | Why N/A |
|---|---|
| **Scope mismatch vs Karpathy encyclopedia** | Narrow ke crypto by design. Bukan bug, fitur. |
| **Cross-corpus federation** | Single-user moat is the point. |
| **Multi-modal (image)** | ASCII chosen for portability + AI-readability. Not blocking. |

## Revised priority based on audit

Research yang paling impactful (urut ROI untuk current state + near-term scale):

**Priority A — highest impact:**
1. **Retrieval quality (semantic / hybrid)** — Khoj architecture, Smart Connections embedding. At companion scale, ini bottleneck untuk reply quality.
2. **Hallucination runtime check** — Anthropic Contextual Retrieval, Self-RAG decision tokens. Critical sebelum companion v2 di-trust at scale.

**Priority B — addresses known gaps:**
3. **Recency / versioning patterns** — research apakah ada PKM/RAG solution untuk fact-as-of-date, atau open problem.
4. **Embedding-friendly frontmatter** — cheap schema fix tapi worth tau pattern dari Khoj dulu sebelum commit.

**Priority C — nice-to-have:**
5. **GraphRAG multi-hop** — relevant nanti pas 50+ concepts ada multi-hop reasoning needs. Sekarang 18 concepts, low impact.

**Skip (not applicable to current scope):**
- Cross-corpus federation
- Multi-modal image generation
- Curation tax mitigation at scale (revisit when 100+ concepts)

## Keywords untuk Google search

**Primary**:
- `agentic RAG knowledge graph`
- `RAG over Obsidian` / `Obsidian LLM`
- `personal knowledge base chatbot`
- `self-improving RAG`
- `knowledge gap detection LLM`
- `second brain LLM chatbot`
- `graph RAG personal notes`

**Specific techniques**:
- `query routing LLM`
- `hybrid search retrieval`
- `Self-RAG paper` (Asai et al)
- `CRAG corrective RAG`
- `GraphRAG Microsoft`
- `RAG hallucination mitigation`

**Architecture**:
- `tool-using agent retrieval`
- `vector + graph retrieval`
- `conversational RAG memory`

## Twitter / X accounts to follow

| Account | Topik |
|---|---|
| `@simonw` (Simon Willison) | LLM + tools, hands-on; banyak post tentang RAG patterns |
| `@karpathy` | LLM fundamentals; relevant ke LLM Wiki framing |
| `@swyx` | DevX + AI engineering, kompilasi tool space |
| `@hwchase17` (Harrison Chase) | LangChain founder, RAG patterns |
| `@LangChainAI` | RAG cookbook + patterns |
| `@LanceMartinAI` | RAG patterns terutama agentic + hybrid |
| `@HamelHusain` | Practical LLM eval + retrieval |
| `@jerryjliu0` (Jerry Liu) | LlamaIndex founder, RAG depth |
| `@AnthropicAI` | Citations, contextual retrieval |

**Twitter search terms**:
- `RAG over notes`
- `Obsidian AI plugin`
- `second brain LLM`
- `personal RAG`
- `memory agent`

## Communities

| Forum | Apa yang dibahas |
|---|---|
| **r/ObsidianMD** | Obsidian + AI plugins, banyak diskusi smart-connections |
| **r/LocalLLaMA** | Local LLM tools, sometimes RAG patterns |
| **r/LangChain** | RAG implementation patterns |
| **r/PKMS** | Personal knowledge management, sometimes AI-enhanced |
| **LangChain Discord** | Real-time discussion patterns |
| **Hacker News** | Search "LLM" + "RAG" untuk quality vetting via discussion |

## Tools / projects worth studying (urut ROI)

### Direct analogs (mereka bangun similar things)

| Tool | What & lesson |
|---|---|
| **[Khoj](https://khoj.dev)** ([GitHub](https://github.com/khoj-ai/khoj)) | Open source AI second brain. **Closest analog**. Multi-source (notes + web), local + cloud LLM. **Worth deep dive.** |
| **[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)** | Obsidian plugin doing semantic + RAG over vault. Active community, user feedback worth reading. |
| **NotebookLM** (Google) | RAG over user-uploaded docs. UI/UX patterns worth seeing. |
| **Claude Projects** | File-based RAG di consumer product. Citation patterns. |
| **[Quartz](https://quartz.jzhao.xyz/)** | Static site generator for Obsidian. Not RAG itself, but ecosystem patterns. |
| **Mem.ai** | AI-native PKM commercial. UX patterns. |
| **Reflect** ([reflect.app](https://reflect.app)) | AI note-taking. UX inspiration. |

### Architectural papers / blog posts

- **"Retrieval-Augmented Generation"** (Lewis et al, 2020) — foundational RAG paper
- **"Self-RAG"** (Asai et al) — self-reflective retrieval
- **"GraphRAG"** (Microsoft, Edge et al, 2024) — graph-structured RAG
- **Anthropic blog: "Contextual Retrieval"** — recent technique untuk reduce hallucination
- **Simon Willison's blog** ([simonwillison.net](https://simonwillison.net)) — practical RAG posts ongoing

### Untuk auto-curate pattern specifically (paling novel di desainmu)

- Search: `knowledge distillation from conversation`
- Search: `active learning LLM agent`
- Cari: `self-improving knowledge base`
- Concept related: `machine teaching`

## Research path (urut ROI — aligned dengan audit priorities)

1. **~2 jam — Khoj deep dive** [addresses Priority A1 + A2 + B4]: Read GitHub README + architecture docs. Lihat retrieval strategy (hybrid?), citation/grounding mechanism, frontmatter/metadata schema, multi-source orchestration. Mereka closest analog.

2. **~30 menit — Anthropic Contextual Retrieval blog** [addresses Priority A2]: Latest technique untuk reduce hallucination. Quick read, high signal.

3. **~1 jam — Self-RAG / CRAG paper skim** [addresses Priority A2]: Self-reflection patterns. Decision tokens approach worth understanding sebelum companion v2.

4. **~1 jam — Smart Connections study** [addresses Priority A1 + B4]: Obsidian-native, embedding-based. User feedback di GitHub issues + r/ObsidianMD shows pain points.

5. **~30 menit — Research recency / versioning patterns** [addresses Priority B3]: Google "stale fact LLM", "temporal knowledge base". Mungkin open problem; document state-of-the-art.

6. **~30 menit — GraphRAG blog (Microsoft)** [addresses Priority C5]: Read overview, defer deep dive sampai 50+ concepts.

7. **Ongoing — Twitter follow** dari accounts list. Patterns terbaru biasanya di Twitter dulu sebelum paper/lib.

## What to look for during research

Bawa concrete questions ke setiap source:

- **Khoj**: gimana mereka handle vault sync? Multi-LLM provider strategy?
- **Smart Connections**: chunking strategy untuk Obsidian notes? Citation format?
- **Self-RAG**: kapan agent decide "retrieval gak cukup, butuh lebih"?
- **GraphRAG**: gimana graph structure di-leverage di retrieval step?
- **Khoj + others**: gimana mereka handle hallucination? Citation enforcement?
- **All**: cost optimization patterns (caching, lazy loading)?
- **All**: failure mode handling (vault gak ada answer + web gagal)?

## Notes / findings (user fills in)

Tulis temuan lu di sini saat baca. Anything yang challenge desain awal companion v2, atau pattern baru yang worth adopt.

### Khoj
- (to be filled)

### Smart Connections
- (to be filled)

### Self-RAG / CRAG
- (to be filled)

### GraphRAG
- (to be filled)

### Other findings
- (to be filled)

## Companion v2 design decisions (post-research)

After research, refine companion v2 design:

- [ ] Combined mode trigger heuristics validated/refined
- [ ] Project vs concept routing strategy confirmed atau diganti
- [ ] Retrieval approach: keyword grep only (current), atau add semantic/embedding?
- [ ] Citation format: wikilink only, atau juga show source content snippets?
- [ ] Self-reflection step (Self-RAG style): yes/no?
- [ ] Graph traversal: follow wikilinks dari retrieved notes (1-hop expansion)?
- [ ] Auto-curate threshold: when to write inbox vs not?

## Companion v1 → v2 timeline (loose)

- Research phase: ~5 jam total reading
- Design refinement: ~1 jam doc write
- Skill update: ~1-2 jam edit + commit
- Test + iterate: ongoing

**Tidak ada deadline**. Lu test companion v1 dulu di Telegram, lihat friction nyata, baru research-driven update ke v2 dengan vocabulary + patterns yang udah established di field.

---

*Companion: lihat [skills/companion/SKILL.md](SKILL.md) untuk v1 current state. Lihat [setup/telegram.md](../../setup/telegram.md) untuk activation + config.*
