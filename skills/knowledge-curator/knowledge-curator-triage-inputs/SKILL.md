---
name: knowledge-curator-triage-inputs
description: Workflow for handling curator-triage seeded input files in the knowledge-curator skill — pre-populated metadata (type-hint, why-to-nail, connects, concept) validation, slug correction, and the nascent concept examples gap. Companion to the main knowledge-curator skill, loaded when processing active-scan outputs.
---

# Handling Curator-Triage Seeded Inputs

The knowledge-curator skill often receives input files pre-seeded by the curator-triage (active-scan) pipeline. These files arrive with YAML-like metadata headers containing `concept`, `type-hint`, `why-to-nail`, and `connects` fields. This skill documents how to handle them — what to trust, what to override, and edge cases that arise.

## Rule: Metadata is Advisory, Not Authoritative

Curator-triage is a broad trawl — it identifies potentially interesting signals and seeds a first-pass concept name and type. It does NOT perform deep mechanism analysis or apply the knowledge-curator's hard rules. Treat all pre-populated fields as guesses that need your independent verification.

### The four fields to watch

```
concept: jaccard-swap               ← slug candidate (may violate Hard Rule #4)
type-hint: programming               ← type guess (may conflict with your analysis)
why-to-nail: Why minHash/LSH...      ← framing hint (good starting point, not final prose)
connects: [[nft]], [[dex-routing]]   ← suggested wikilinks (may violate layer taxonomy)
```

**`concept` field (potential project-name violation).** The triager often names the concept after the input source (a project, a protocol, a game). Apply the Hard Rule #4 decision procedure independently:
- "Is this a noun for a mechanism/idea/dynamic, or a noun for a product/deployment?"
- If it's a product name (e.g., `jaccard-swap`, `aerodrome`, `relic-safari`), extract the underlying mechanism and use that as the slug instead (e.g., `minhash-matching`).
- Document the slug correction in the daily log with reasoning.
- The triager's suggested slug is a starting point, never the final name.

**`type-hint` field (potential layer/type mismatch).** The triager may misclassify the concept's type — especially by labeling application-layer mechanisms as `programming`. Always perform your own layer/type analysis:
- Does the concept describe an application-layer matching mechanism? → `type: concept`, `layer: applications`
- Does it describe a platform execution technique? → `type: programming`, `layer: platforms`
- Use the Type Taxonomy table from the main skill to determine the right type based on what the concept IS, not what the triager guessed.
- If your conclusion differs, document the override in the daily log.

**`connects` field (suggested wikilinks without layer awareness).** The triager may suggest links without regard to layer taxonomy. For each suggested link:
1. Identify the target concept's layer (read its frontmatter if it exists)
2. Verify the layer relationship allows the link direction you intend (Builds on = lower → higher, Enables = higher → lower, Related = same layer)
3. Reject any suggested link that violates layer discipline (e.g., suggesting `[[dex-routing]]` as a connection when the new concept and dex-routing are both applications-layer and not conceptually related)
4. Flag rejected connections in the daily log.

**`why-to-nail` field (useful framing, not final prose).** The triager provides a high-level summary of what question the concept answers. Use it to orient your `## Why` research, but:
- Never copy it verbatim into the note body
- Expand with your own source-backed analysis (inline citations from canonical sources)
- The triager's phrasing is a direction, not a destination

## Nascent Concept Examples Gap

Hard Rule #8 in the main skill requires real-world examples with named incidents, dates, quantified impact, and source URLs for `market` and `applications` layer concepts. But a concept proposed 1 day ago has no incidents yet.

**When real-world incidents don't exist yet:**

1. List the reference implementation / prototype as the primary example, noting it is early-stage and providing its URL.
2. List the originating research proposal (forum post, hackmd, whitepaper) as a second example.
3. Append an explicit caveat: "No exploit/value-extraction incidents yet exist for this concept — it is early-stage. The first deployment to implement X will be the inaugural case study."
4. Flag with `[NASCEX]` in the daily log entry to track that examples are expected to accumulate.
5. In the `## Open questions` section, add a question about future incidents or applications.
6. If the concept has a prototype/game that demonstrates it, mention that with its URL as the best available evidence.

**Do NOT:**
- Fabricate metrics or pad with vaguely-related incidents from different domains
- Create exaggerated claims about potential impact
- Skip the examples section entirely (this violates Hard Rule #8)
- Use AI-generated case studies

## Worked Example: minhash-matching

The June 2026 session received a curator-triage output with:
- `concept: jaccard-swap` → REJECTED (project name). Corrected to `minhash-matching` (mechanism: MinHash-based set-similarity matching).
- `type-hint: programming` → OVERRIDDEN to `type: concept, layer: applications`. The mechanism is an application-layer matching primitive, not a programming technique.
- `connects: [[nft]], [[dex-routing]], [[hash-function]]` → ACCEPTED `[[nft]]` (same layer, Related) and `[[hash-function]]` (lower layer, Builds on). REJECTED `[[dex-routing]]` (same layer but not conceptually related — routing is about swap paths, not trait matching).

The why-to-nail framing was used as a starting point for `## Why` research: "Why minHash/LSH enables decentralized on-chain matching of structured assets (NFTs, RWAs) without a centralized orderbook" — this helped focus the source-gathering on MinHash compression, Jaccard similarity estimation, and marketplace fragmentation.

For real-world examples: because the concept was proposed June 22, 2026 (1 day before curation), no incidents existed. Used the Relic Safari reference implementation and the Ethereum Magicians research proposal as examples, with the caveat that the concept is early-stage. Flagged `[NASCEX]` in daily log.
