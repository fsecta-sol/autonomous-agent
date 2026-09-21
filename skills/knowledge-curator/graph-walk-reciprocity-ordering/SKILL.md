---
name: graph-walk-reciprocity-ordering
description: Companion to graph-walk — fixes the workflow ordering where the main graph-walk skill's reciprocity grep runs after writing reciprocal sections. Load alongside graph-walk when resolving dangling refs.
category: knowledge-curator
---

# Graph-Walk: Reciprocity Grep Ordering

The main `graph-walk` skill instructs you to write the concept note including reciprocal links (step 5) before running the reciprocity grep to discover inbound references (step 6). This is a latent ordering problem: you cannot correctly populate `## Enables` and `## Related` reciprocals until you know which finder notes reference the new slug and in which sections.

## Corrected workflow order

When the graph-walk skill says to "Write the concept note" (step 5), split it into three phases:

### Phase A — Write the body (before reciprocity grep)
Write these sections of the concept note, which do NOT depend on reciprocal links:
- Frontmatter (concept, type, layer, created/updated, sources, status)
- `## What` and `## Why it exists / why it works`
- `## Diagram` (if applicable)
- `## Real-world examples` (if applicable)
- `## Open questions`, `## Notes`, `## Sources`

Do NOT write `## Builds on`, `## Enables`, or `## Related` yet.

### Phase B — Reciprocity grep
Run the grep BEFORE writing reciprocal sections:
```
search_files(pattern="[[<slug>]]", path="03-Areas/concepts")
```
For each finder note, classify which section the `[[<slug>]]` appears in:
- `## Builds on` → C's reciprocal goes in `## Enables` with reasoning "C enables N because..."
- `## Enables` → C's reciprocal goes in `## Builds on` with reasoning "C builds on N because..."
- `## Related (same layer)` → C's reciprocal goes in `## Related` with symmetric reasoning
- Inline → no required reciprocal, but note in `## Notes`

Also scan existing concepts at the same `layer:` for potential same-layer siblings.

### Phase C — Write reciprocal sections
Now add `## Builds on`, `## Enables`, and `## Related` to the concept note based on the grep results. This way you write each section exactly once with the correct information.

## Finder-note reasoning accuracy

When a finder note's link to C was written before C existed, its reasoning may contain minor factual errors about C (wrong invariant type, imprecise description, etc.). During reconciliation:

1. Check each finder note's reasoning sentence for accuracy against C's now-complete body.
2. If inaccurate, leave a `<!-- corrected from: ... -->` comment inline (do not delete the old text). Example:
   ```
   - [[augmented-bonding-curves]] — concrete application of AMD to bonding curves,
     where exit tributes + vesting create structural and economic invariants
     around the conservation law
     <!-- corrected from: exit tributes are economic, vesting is temporal (not structural);
          see augmented-bonding-curves.md ## Why for correct invariant types -->
   ```
3. This is distinct from section misclassification (where the link is in the wrong section entirely) — handle section misclassifications via `graph-walk-finder-misclassification`.

## Why this matters

Writing reciprocal links before the grep produces two failure modes:
- **Over-engineering:** you guess at which finders reference C and add reciprocal links for notes that don't actually reference it, bloating the concept note with unnecessary links
- **Omission:** you miss a finder because you didn't grep, resulting in a one-way link (C references N but N has no reciprocal back to C)
