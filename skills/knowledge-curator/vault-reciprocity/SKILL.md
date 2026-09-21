---
name: vault-reciprocity
description: Ensure bidirectional wikilinks in an Obsidian concept vault. Every new note that links to existing notes must have its links reciprocated — the target notes must link back in the section appropriate to the layer relationship. Run this whenever you create a new concept note or add a new wikilink to an existing note.
---

# Vault Reciprocity

Every wikilink in the concept vault must be bidirectional. A note that links to another without being linked back creates a dead end in the graph — you can navigate forward but not backward, which defeats the purpose of compound understanding.

## When to run

- **After creating a new concept note** that contains `## Builds on`, `## Enables`, or `## Related` linking to existing notes
- **After enriching an existing note** by adding a new wikilink to another existing note
- NOT for inline body mentions (those don't require structured reciprocals, though a `## Notes` mention is polite)

## Procedure

### Phase 1: Identify C's outgoing links and their targets

For each concept note C (the new or modified note):

1. **Extract all structured wikilinks.** From C's `## Builds on`, `## Enables`, and `## Related (same layer)` sections, list every `[[N]]` reference. These are the targets N that need reciprocals.

2. **Read each N's frontmatter** to confirm its layer and type:
   - Use `read_file(path="03-Areas/concepts/<N-slug>.md", limit=10)` to get the frontmatter
   - Note N's `layer:` field — this determines which section the reciprocal goes in

### Phase 2: Determine reciprocal section

| If C has N in... | Then N needs C in... |
|---|---|
| `## Builds on` | N's `## Enables` (C is something N enables) |
| `## Enables` | N's `## Builds on` (C builds on N) |
| `## Related (same layer)` | N's `## Related (same layer)` (symmetric sibling relationship) |

When C and N are the SAME layer and you're adding Builds on or Enables reciprocals, double-check: same-layer links should go in `## Related`, not Builds on/Enables. Only cross-layer links go in Builds on/Enables.

### Phase 3: Locate the insertion point in N

For each N:

1. **Find the target section:** `search_files(path="03-Areas/concepts/<N-slug>.md", pattern="## Enables|## Builds on|## Related", context=3, output_mode="content")`
2. **Read a small window** around the match (offset=line-2, limit=10 lines) to see the existing list items and their formatting
3. **Note the exact content** of the line before your insertion point — this becomes the `old_string` for your patch

### Phase 4: Patch with reasoned reciprocal

Add `[[C]]` to N's section with a 1-sentence reasoning string explaining the link from N's perspective:

```
- [[C]] — <reasoning from N's perspective>
```

**Reasoning is mandatory.** A bare `[[C]]` without reason fails the compound-understanding test.

Format examples:

- In a `## Enables` section: `- [[ossification-resistance]] — block production ossification is the primary problem that ossification resistance targets; the framework proposes collaborative block production as the alternative to solo proposer monopolies`
- In a `## Related (same layer)` section: `- [[ossification-resistance]] — ossification resistance is a specific incentive design that adds a fourth primitive (collaboration-diversity weighting) to the reward/penalty/commitment palette`

### Phase 5: One-sentence enrichment (optional)

If C reveals a perspective that retro-improves N's `## Why it exists / why it works`, append a paragraph:
> "Reciprocal angle from [[C]]: <the new perspective>"

Only do this when C genuinely adds explanatory depth that N is missing. Most reciprocals are just the link + reasoning — no body enrichment needed.

## Pitfalls

### `|` continuation marker ambiguity

Obsidian concept files use `|` as a YAML continuation prefix in multiline list items. The `read_file` output format (`LINE_NUM|CONTENT`) makes it ambiguous whether content starts with `|` or the pipe is the line number separator.

**How to avoid:** Always read 3-5 lines around your target insertion point using `offset` and `limit`. The content you see after `LINE_NUM| ` IS the file content. If a line appears as `47||- [[something]]`, the actual file content is `|- [[something]]` — the first `|` is the line number separator.

When crafting the old_string for patch, use the content as it actually appears in the file (without the line number prefix). If you accidentally include an extra `|`, the patch will corrupt the line.

**Fix if corrupted:** Read the broken file, identify the extra pipe, re-patch to remove it. The pattern `||-` should be `|-` for continuation lines.

### Cross-layer link misplacement

If C and N are at different layers and you add the reciprocal to N's `## Related` section instead of `## Enables`/`## Builds on`, the layer taxonomy breaks. Always verify layer from frontmatter before writing.

### Overwriting instead of appending

Use `patch` (find-and-replace), not `write_file`, to add reciprocals. `write_file` overwrites the entire file, destroying existing content. The `patch` tool with proper old_string and new_string safely inserts a new line.

## Example

C = `ossification-resistance` (layer: cross-cutting)
N = `block-production` (layer: foundations)

C's Builds on has `[[block-production]]` → reciprocal goes in N's `## Enables`:

```
## Enables
- [[mev]] — ...
- [[ossification-resistance]] — block production ossification (mining pools, builder cartels, staking pool dominance) is the primary problem that ossification resistance targets; the Zhang & Venkatakrishnan framework proposes collaborative block production as the alternative to solo proposer monopolies, directly addressing the coalition dynamics of block building
- [[light-client]] — ...
```
