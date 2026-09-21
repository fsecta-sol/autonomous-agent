---
name: batch-curator-triage-processing
description: Optimized pipeline for processing 3+ curator-triage seeded input files in a single knowledge-curator run — parallel source fetching, batch concept creation, unified reciprocity sweep, and consolidated daily log.
---

# Batch Curator-Triage Processing

When the knowledge-curator cron fires and finds 3+ curator-triage seeded files in `00-Inbox/_knowledge/`, use this batch pipeline to reduce tool roundtrips by ~60% compared to sequential per-file processing.

## When to use

- 3+ files in `00-Inbox/_knowledge/` with YAML frontmatter from curator-triage (active-scan pipeline)
- Each file has `concept:`, `type-hint:`, `why-to-nail:`, `connects:`, and `sources to fetch/verify:` fields

## Batch pipeline (end-to-end)

### Phase 1: Gather (all reads, zero writes)

1. **Read ALL input files** in one batch. Each is lightweight YAML frontmatter — read them all before any source fetching.
2. **Check ALL concept slugs** against existing `03-Areas/concepts/` — note which exist (enrich) vs. new (create).
3. **Read ALL existing concepts** that any new concept references in its `connects:` field — you'll need their layer frontmatter for vertical link placement.
4. **Collect ALL unique source URLs** across all input files. Deduplicate (same URL may appear in multiple seeds).

### Phase 2: Fetch (parallel sources)

5. **Fetch ALL unique sources in parallel** using `bash ~/autonomous-agent/scripts/fetch_url.sh <URL>`. For Discourse-based forums (ethresear.ch, ethereum-magicians.org, collective.flashbots.net), also try the `.json` endpoint (append `.json` to the URL) for structured post content. For arXiv, fetch the abstract page (not the PDF).
6. Extract content from each source. For Discourse forums, the post content is in `post_stream.posts[0].cooked` in the `.json` response, or in the `<noscript>` section of the HTML.

### Phase 3: Create (batch writes)

7. **Create ALL new concept notes** in batches of 3-4 parallel `write_file` calls. Each note follows the Concept Note Schema from `knowledge-curator` with:
   - `## Why` expanded from `why-to-nail` framing + source-backed analysis
   - `## Builds on` / `## Enables` derived from `connects:` list, verified against layer taxonomy
   - ASCII diagram for mechanisms with flow/actors/state transitions
   - Real-world examples sourced from fetched content (whitelist sources)
8. For existing concepts that match a seed, enrich them (add sources, expand Why, update timestamp).

### Phase 4: Reciprocity (single sweep)

9. **Run ONE reciprocity sweep** for all new concepts:
   - **Phase A (inbound):** Search ALL new slugs at once: `search_files(pattern="[[slug1]] OR [[slug2]] OR...", path="03-Areas/concepts")`. Since all notes are being created simultaneously, inbound refs from other new notes won't exist yet.
   - **Phase B (outbound):** For each existing concept N that new concepts link to, check if N already has reciprocal `[[C]]` links. Batch-read all N files, then batch-patch.
   - **Same-layer sibling discovery:** For each new concept at layer L, scan existing concepts also at layer L. Add `## Related` reciprocals where conceptually related.

### Phase 5: Persist

10. **Move ALL input files** to `00-Inbox/_processed/YYYY-MM-DD/` with `.md` → `.txt` extension flip:
    ```bash
    for f in slug1 slug2 slug3; do
      mv "00-Inbox/_knowledge/${f}.md" "00-Inbox/_processed/YYYY-MM-DD/${f}.txt"
    done
    ```
11. **Write ONE daily log** covering all processed inputs, new concepts, enrichments, and any flags.

## Optimization principles

- **Read everything before writing anything.** Reading all inputs, existing concepts, and source content in parallel phases minimizes tool roundtrips.
- **Deduplicate source fetches.** If 3 seeds reference the same ethresear.ch post, fetch it once.
- **Batch by type of operation.** All `write_file` → all `patch` → all `mv` — not interleaved per-file.
- **Skip reciprocity Phase A (inbound).** When creating 5+ new concepts simultaneously, none of them can have inbound refs from each other. The only inbound refs would be from existing concepts, which Phase B handles. Explicitly skip the inbound sweep to save rounds.

## Pitfalls

- **Layer checks compound in batches.** When processing 7 concepts with 5+ links each, it's easy to miss a layer mismatch. Always verify each link's direction against both concepts' `layer:` frontmatter.
- **Identical slugs across seeds.** If two seeds suggest the same slug, merge them (use the earlier seed's body, add the later seed's source URL).
- **Discourse JSON endpoint failures.** Some Discourse instances block the `.json` endpoint for anonymous users. Fall back to `fetch_url.sh` and extract from `<noscript>` section or `browser_navigate`.
- **Don't forget the daily log format.** Use `.txt` extension, list each input with result emoji: ✅ created, ✅ enriched, ⚠️ flagged.

## Related skills

- `knowledge-curator` — Main skill for processing inbox inputs (concept schema, layer taxonomy, hard rules)
- `knowledge-curator-triage-inputs` — Handling curator-triage seed metadata (why-to-nail, type-hint, connects)
- `batch-reciprocity-workflow` — Batch reciprocity optimization (narrower scope: reciprocity only)
- `outbound-reciprocity` — Phase B reciprocal for single concept
- `discourse-fetching-patterns` — Discourse forum fetch behavior by instance
- `source-gathering-techniques` — JSON API and raw endpoint patterns for forum extraction