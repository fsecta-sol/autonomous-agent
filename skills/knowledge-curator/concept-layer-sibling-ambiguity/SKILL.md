---
name: concept-layer-sibling-ambiguity
description: Resolve ambiguous layer assignments when a dangling concept name overlaps with an existing sibling concept — avoid the trap of assuming same layer just because names share a prefix.
---

# Concept Layer Sibling Ambiguity

When a dangling ref `[[foo]]` coexists with an already-created `[[foo-<specifier>]]` (e.g., `foo-measurement`, `foo-implementation`, `foo-design`), the existing sibling's layer can mislead inference. The specific variant may be at a different layer than the broad concept.

## The pattern

A broad constraint concept often lives at `cross-cutting` while its concrete measurement/implementation variant sits at a lower layer.

| Broad concept | Layer | Specific variant | Layer |
|---|---|---|---|
| `[[sybil-resistance]]` | cross-cutting | `[[sybil-resistance-measurement]]` | foundations |
| `[[privacy]]` (hypothetical) | cross-cutting | `[[privacy-by-default]]` (existing) | platforms |

## Why this happens

The specific variant (measurement, implementation, standard) is a *concrete application* of the broad constraint, so it can be precisely placed in the layer taxonomy. The broad concept itself is a *constraint that spans all layers* — it constrains design decisions at every level from cryptography up through market. The specific variant is the operationalization of that constraint at one layer.

## Detection

Before inferring layer for a dangling ref `[[foo]]`:

1. **Search for prefix variants:** Run `search_files(pattern='[[foo[-]]')` in `03-Areas/concepts` to find any sibling concept with overlapping name. Grep for both `[[foo]]` and `[[foo-` to catch aliases.
2. **Compare frontmatter layers** of each sibling found. If one is at a specific layer and another is at cross-cutting, sibling ambiguity is in play.
3. **Read the finder note context** that references the dangling `[[foo]]`. If it discusses foo as a *general design constraint* alongside other cross-cutting concepts (game-theory, incentive-design), foo is likely cross-cutting. If it references a *specific measurement or mechanism*, it may share the sibling's layer.

## Resolution rules

1. **Topological test:** If the concept is a prerequisite (referenced in `## Builds on`) for finders at 3+ different layers, it's cross-cutting. If only relevant within one layer's finders, place it there.
2. **Read the finder note's prose around the wikilink.** The prose context is more informative than the section header alone. A finder in `## Builds on` of a cross-cutting note might still link to another cross-cutting concept if they discuss overlapping constraints.
3. **When uncertain: err toward cross-cutting** for broad constraint concepts. The graph is better served by a cross-cutting assignment that correctly captures the breadth than a narrow assignment that forces incorrect vertical links.
4. **Flag `[NEEDS-WHY]`** if the ambiguity cannot be resolved from available context, rather than guessing.

## Worked example

Dangling: `[[sybil-resistance]]`  
Existing sibling: `[[sybil-resistance-measurement]]` at `layer: foundations, type: fundamental`

Finder notes:
- `ossification-resistance.md` (cross-cutting) references `[[sybil-resistance]]` in both `## Builds on` and `## Related (same layer)` — suggesting sybil-resistance is both foundational to AND same-layer as ossification-resistance. Since ossification-resistance is cross-cutting, sybil-resistance is likely also cross-cutting.
- `game-theory.md` (cross-cutting), `incentive-design.md` (cross-cutting), `mechanism-design.md` (cross-cutting) all discuss Sybil resistance as a general design constraint alongside other cross-cutting concepts.

Resolution: `layer: cross-cutting, type: cross-cutting`. The specific `sybil-resistance-measurement` concept (foundations) is a concrete application of the broader Sybil resistance constraint — not a bound on its layer.

## Relationship to concept-layer-inference

This skill is a companion to `concept-layer-inference`. Use it as a secondary check when layer inference from section context alone produces an answer that conflicts with an existing sibling's layer. The core lookup table in `concept-layer-inference` remains the primary tool; this resolves the specific ambiguity case where overlapping concept names create a false bound.
