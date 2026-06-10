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

## Research path (urut ROI)

1. **~2 jam — Khoj deep dive**: Read GitHub README + architecture docs. Mereka udah solve banyak masalah yang lu akan temui (vault sync, multi-source, citation). Lihat what they got right and where they fall short.

2. **~1 jam — Smart Connections study**: Obsidian-native solution, ekosistemnya ramai. Lihat user feedback (apa yang user complain, apa yang useful).

3. **~1 jam — Self-RAG / CRAG paper skim**: Pahami self-reflection patterns. Bisa jadi inspiration untuk "vault has answer BUT incomplete" mode.

4. **~30 menit — GraphRAG blog (Microsoft)**: Lu punya graph structure (wikilinks, layers) — ada teknik leverage itu untuk reasoning yang lu mungkin belum apply.

5. **Ongoing — Twitter follow** dari list di atas. Patterns terbaru biasanya muncul di Twitter dulu sebelum jadi paper/lib.

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
