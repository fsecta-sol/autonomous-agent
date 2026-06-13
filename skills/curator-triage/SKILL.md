---
name: curator-triage
description: Triage new items surfaced by the active curated-source scan (Mesin 1). For each item, decide if it illuminates a MECHANISM worth a concept note; if yes, drop a seed to 00-Inbox/_knowledge/ for the knowledge-curator pipeline to resolve; if no, discard. This skill does discovery + triage ONLY — it never writes concept notes itself. Use when the scan-curated-sources cron fires with a list of new items in context.
---

# Curator Triage (active-scan front door)

You are the **eyes** of the knowledge engine; `knowledge-curator` is the **hands**. The `scan_sources.sh` pre-check has already put a list of new items (title + URL + source) in your context. Your only job: decide which items are worth turning into knowledge, and for those, drop a **seed** into `00-Inbox/_knowledge/`. You do **NOT** write concept notes — the `process-inbox-knowledge` cron (knowledge-curator) resolves your seeds into full notes. Separation of concerns = one writing path, one quality standard.

**Path convention:** your working directory IS the vault root. Use paths like `00-Inbox/_knowledge/`, `01-Daily/` directly. Do NOT prepend `vault/`.

## The one triage test (mechanism vs noise)

For each item, fetch it and ask:

> **"Does this teach a MECHANISM — why something works or breaks — that reduces toward the crypto/DeFi knowledge graph?"**

- **KEEP** → research/design rationale, risk-parameter or oracle/collateral change, protocol invariant, MEV/consensus/cryptography mechanism, audit finding, exploit post-mortem (failure mechanism).
- **DISCARD** → price/market commentary, token-launch announcement, governance procedural noise (quorum/voting-logistics with no mechanism), partnership/marketing, conference recap, anything reducible to "X went up/down".

When unsure, lean DISCARD. A small tight graph beats a large mushy one (MISSION.md). Better to skip than to seed noise.

### DeFi-mechanism weighting

This engine is biased toward **DeFi under the hood**. Prioritise items about: oracle design/manipulation, lending collateral & liquidation params, AMM invariants & LP mechanics, stablecoin peg mechanics, MEV/PBS, bridging & data-availability, fee markets, restaking. Foundation/cryptography items (consensus, zk, signatures) are welcome but secondary. Pure-narrative/price items are out (that's the alpha layer's job later, and even there it's grounded — see ARCH-defi-alpha.md).

### Hard blacklist (never seed)

Price predictions, "buy/sell", influencer takes, exchange-blog marketing, news-媒体 rehashes (CoinDesk/Cointelegraph/Decrypt). If the item's substance is one of these, discard even if the source is whitelisted.

## Workflow per run

1. Read the scan list from context (each item: `- [source] TITLE` + URL).
2. For each item (process up to ~12 per run; if more, take the highest-signal and note the rest in the log):
   - **Fetch** the item: `bash ~/autonomous-agent/scripts/fetch_url.sh <URL>` (add `--stealth` for JS/SPA pages). For arXiv, the abstract page is enough — don't fetch the PDF.
   - **Apply the triage test.**
   - **KEEP** → write a seed file (schema below) to `00-Inbox/_knowledge/<concept-slug>.md`. The slug is the *mechanism*, not the article title (e.g. an Aave proposal to change an oracle → `oracle-manipulation` or `price-oracle`, not `aave-arfc-123`).
     - If a seed for that concept-slug already exists in `_knowledge/`, append your angle/source to it instead of overwriting.
   - **DISCARD** → do nothing except log it.
3. Append a run log to `01-Daily/YYYY-MM-DD.txt` under `## Active scan — <HH:MM>` (kept N, discarded M, with one-line reasons for kept items + the concept each maps to).
4. Emit a one-paragraph summary: N items triaged, K seeded (list concept slugs), M discarded.

Do NOT move or process the seeds further — `process-inbox-knowledge` will pick them up on its next tick.

## Seed schema (what you write to `00-Inbox/_knowledge/<slug>.md`)

Mirror the seed shape the knowledge-curator already expects. Concise — the curator does the deep work:

```
concept: <mechanism-slug>
type-hint: <fundamental | system | programming | concept | economy | trading | blockchain | cross-cutting>
why-to-nail: <1-2 sentences — the angle the eventual note must nail; the "why", not the "what">
connects (wire reciprocity): <[[existing-node]], [[...]] this should link to in the graph>
sources to fetch/verify:
- <the item URL you triaged>
- <any canonical source it cites, if obvious>
note: agent-queued via active-scan (curator-triage). <1-line: what in the item triggered the keep>
```

Keep `type-hint` consistent with the knowledge-curator Type Taxonomy. Suggest `connects` links to concepts you know exist (oracle, lending-protocol, amm, mev, etc.) so the curator's reciprocity step has a target — a wrong guess is fine, the curator verifies.

## Anti-patterns

- **Writing the concept note yourself.** Not your job. Seed only. If you find yourself writing `## Why it exists`, stop.
- **Seeding the article instead of the mechanism.** One item about an Aave oracle exploit → seed `oracle` (or `oracle-manipulation`), not `aave-exploit-aug`. Projects/articles are examples *inside* a concept, never the concept.
- **Seeding noise to hit a quota.** Zero seeds is a valid run if nothing was mechanism-worthy. The wake-gate already filtered "new"; you filter "worthy".
- **Re-seeding an existing concept with nothing new.** If `_knowledge/oracle.md` already queued the same angle, skip (the script's seen-ledger prevents re-emitting the same URL, but two different URLs can map to one concept — dedupe by angle).

## Relationship to other skills

- `scan_sources.sh` (pre-check) decides *what is new*. You decide *what is worthy*. `knowledge-curator` decides *how it's written*. `graph-walker` later fills any `[NEEDS-CONCEPT]` you imply.
- Extraction discipline (one input → one concept, mechanism-not-product, sources canonical) is inherited from [knowledge-curator](../knowledge-curator/SKILL.md) — re-read its Hard Rules #4 (no project-named concepts) and the Type Taxonomy if unsure how to slug something.