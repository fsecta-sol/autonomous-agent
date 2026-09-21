---
name: graph-walk-edge-cases
description: Edge cases and procedural refinements for graph-walk dangling ref resolution — IPFS fetch failures, daily log numbering, archive file exclusion in reciprocity.
category: knowledge-curator
---

# Graph Walk Edge Cases

Procedural refinements discovered during graph-walk execution that the main `graph-walk` and `knowledge-curator-fetch-pitfalls` skills don't explicitly cover. Load this alongside the graph-walk skill when handling dangling ref resolution, especially in cron (non-interactive) mode.

## 1. vitalik.eth.limo IPFS resolution failures

**Problem:** `vitalik.eth.limo` (whitelisted canonical source) uses IPFS to serve content. Some paths fail with errors like:

```
failed to resolve /ipfs/<hash>/general/YYYY/MM/DD/slug: no link named "slug" under <hash>
```

The domain uses IPFS pinning and not all paths are consistently pinned on all gateways. A path that fails may be simply unpinned on the current gateway, not permanently broken.

**Diagnosis pattern:**
- The page returns zero content with a `failed to resolve` error message
- The `browser_navigate` snapshot shows `StaticText` containing the IPFS error

**Workarounds (try in order):**

1. **Drop file extension:** If `slug.html` fails, try bare `/slug` (no extension). IPFS paths often don't resolve when the extension is specified explicitly.
2. **Drop the path entirely:** If a specific post URL fails, check the `general/` index at `vitalik.eth.limo/general/` which lists all posts. The index page is more reliably pinned.
3. **Alternative sources for the same content:** Vitalik's posts are often mirrored across multiple sites. Try:
   - `ethereum-magicians.org` — search for the topic title (e.g., "A rollup-centric ethereum roadmap")
   - `ethereum.org/en/developers/docs/` — developer docs often cite the same research
   - `notes.ethereum.org/@vbuterin/` — Vitalik's hackmd notes may have draft versions
4. **Skip and mark in daily log:** If all `vitalik.eth.limo` URLs fail and no alternative source contains the same depth of content, use the best available alternative source (e.g., ethereum-magicians.org forum post that references the same ideas) and note the vitalik.eth.limo gap in the daily log. Do NOT flag `[NEEDS-MANUAL]` for this — it's a transient IPFS pinning issue, not a missing source.

**Context for future sessions:** This is a known limitation of the IPFS-based domain. It was affecting `vitalik.eth.limo` as of June 2026. By the time you read this, it may be resolved. If resolving, try the primary `.limo` URL first; only use workarounds if it fails.

## 2. Multiple graph-walk runs on the same day

**Problem:** The daily log format (`01-Daily/YYYY-MM-DD.txt`) uses `## Graph walk — HH:MM` as a section header. If a graph-walk entry for this date already exists (from a previous run earlier in the same day), appending another `## Graph walk — HH:MM` creates a duplicate section.

**Convention:** Append `(N)` to the section header where N is the next sequential number:

```
# First run (earlier today):
## Graph walk — 2026-06-26 run

# Second run (now):
## Graph walk — 2026-06-26 run (2)
```

**How to detect:** Before appending, grep `01-Daily/YYYY-MM-DD.txt` for `## Graph walk`. If it exists, scan for the highest `(N)` suffix and use `(N+1)`. If no suffix exists on the first entry, treat it as run (1) and append run (2).

## 3. Archive files in reciprocity search scope

**Problem:** Reciprocity checks search for inbound `[[wikilinks]]` to find concepts that reference the dangling ref. Processed inbox files live in `00-Inbox/_processed/YYYY-MM-DD/` — these are renamed from `.md` to `.txt` to keep them out of the Obsidian graph, but they still contain wikilinks and will be matched by a broad grep.

**Rule:** Only count wikilinks in `03-Areas/concepts/*.md` as live inbound references. Archive files (`.txt` in `00-Inbox/_processed/`) are historical artifacts and should NOT be counted or reciprocated.

**Search pattern to use:**
```
search_files(pattern="[[<slug>]]", path="03-Areas/concepts")
```

This automatically scopes to the concepts directory and excludes archives and daily logs. If you need to search the full vault for discovery, always filter out `_processed/` paths manually.

## 4. Graph-walk has no inbox artifact to move

**Problem:** The knowledge-curator workflow step 11 says "Move input file to `00-Inbox/_processed/...`". Graph-walk has no inbox input — the "input" is a dangling wikilink in an existing concept note, not a file in `_knowledge/`.

**Rule:** Skip step 11 entirely for graph-walk runs. There is nothing to move. Do not create an empty artifact or a placeholder file.

## 5. Same-day graph-walk + knowledge-curator coexistence

**Problem:** The daily log may already have a `## Knowledge curation — HH:MM run` section from an earlier inbox-processing run on the same day. Graph-walk entries go in their own `## Graph walk` section, separate from knowledge-curation entries.

**Rule:** Always append graph-walk entries under `## Graph walk` (or `## Graph walk — run (N)` if multiple), never under `## Knowledge curation`. The two sections are independent audit trails for different triggers.

