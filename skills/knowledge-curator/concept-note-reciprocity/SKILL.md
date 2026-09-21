---
name: concept-note-reciprocity
description: Ensure bidirectional wikilinks across concept notes during graph-walk and knowledge-curator tasks. Covers Phase A (inbound links from existing notes to new concept) and Phase B (reciprocals for new concept's links to existing notes). Includes pitfalls for stale formatting corruption, finder-note misclassification, and same-layer sibling discovery.
---

# Concept Note Reciprocity

Reciprocity is the process of ensuring every wikilink in the knowledge graph is bidirectional. When concept C links to concept N, N must link back to C in the appropriate section. This skill covers both directions of the reciprocity flow and known pitfalls.

## Phase A — Inbound reciprocity (existing notes to C)

After writing a new concept note C, search for existing notes that already reference `[[C]]`:

1. **Search:** Search all files in `03-Areas/concepts/` for `[[<C-slug>]]` or alias variants
2. **Classify:** For each finder note N, determine which section `[[C]]` appears in (Builds on, Enables, Related, or inline body text)
3. **Reciprocate:** Use the classification table to add the reciprocal link in C's appropriate section

### Classification table

| Section in N | Reciprocal section in C | Reasoning template |
|---|---|---|
| `## Builds on` | `## Enables` | "C enables N because..." |
| `## Enables` | `## Builds on` | "C builds on N because..." |
| `## Related (same layer)` | `## Related (same layer)` | symmetric: "alternative/variant/contrast to N" |
| Inline body text (not in structured section) | No required reciprocal; optionally note in `## Notes` | "Referenced inline by [[N]]" |

## Phase B — Outbound reciprocity (C to existing notes)

For every link C makes to existing notes in its `## Builds on`, `## Enables`, or `## Related` sections, each target N must get a reciprocal `[[C]]` link back:

1. **Collect C's outgoing links** from its Builds on, Enables, and Related sections
2. **For each destination N, add a reciprocal** in the appropriate section:
   - If C puts N in `## Builds on` then N should get C in `## Enables` (or `## Related` if same layer)
   - If C puts N in `## Enables` then N should get C in `## Builds on` (or `## Related` if same layer)
   - If C puts N in `## Related (same layer)` then N should get C in `## Related (same layer)`
3. **Write reasoning** — bare `[[C]]` without a 1-sentence explanation fails the compound-understanding test

## Same-layer sibling reciprocity

When C is created at layer L, scan existing concepts also at layer L. If any are conceptually related (alternative, variant, complement, contrast), populate BOTH sides of `## Related` reciprocity.

Use the layer enum to filter — don't propose Related links across layers.

## Pitfalls

### 1. Stale formatting corruption in target notes

When patching an existing note N to add a reciprocal `[[C]]`, check for and clean up any `|-` prefixed lines in N. These are relics of bad previous patches — the patch tool accepts them silently, but they break Obsidian rendering (list items with leading pipe) and compound over time.

**Common corruption patterns:**
- `|- [[existing-concept]] — description` (leading pipe before hyphen)
- A duplicate entry under `|-` alongside the same (correct) entry
- A malformed entry under `|-` where the real entry exists correctly elsewhere

**Rule:** The agent touching the file owns any corruption it finds there. Fix it during the same edit.

### 2. Finder-note section misclassification

A dangling ref's link was placed before the concept existed, so the finder note N may have `[[C]]` in the wrong section. For example, N might list C in `## Related (same layer)` when C is actually at a different layer. Check N's layer and C's layer — if they differ, move the link to Builds on or Enables as appropriate, and flag `[CONFLICT]` if the relationship is logically impossible.

### 3. Reciprocity blocked by layer mismatch

If C cannot logically reciprocate N's link (e.g., N puts C in `## Builds on` but C is at the same layer as N or higher), this signals a classification mismatch in N. Do NOT force a reciprocal that breaks the layer taxonomy. Flag `[CONFLICT]` in the daily log.

### 4. Central concepts — more than 5 inbound refs

If C has more than 5 inbound references, add `centrality: high` to the frontmatter. List all inbound refs in the daily log for the user's awareness.
