---
name: concept-layer-inference
description: Determine a concept's layer and type from finder-note context before the concept exists — essential for graph-walk dangling ref resolution and for placing new concepts in the correct Builds on / Enables / Related sections during knowledge-curator work.
---

# Concept Layer Inference

When creating or placing a concept in the vault's knowledge graph, you must assign exactly one `layer` and one `type` (see Layer Taxonomy and Type Taxonomy). But when the concept doesn't exist yet — as in graph-walk dangling ref resolution — you can't read its frontmatter. You must **infer** its layer from the context in which it's referenced by existing notes (finder notes).

## Core inference table

The relationship between finder note → dangling concept is determined by the section where the wikilink appears:

| Finder's section containing `[[dangling]]` | Layer relationship | Reciprocal section in dangling (when created) |
|---|---|---|
| Finder's `## Builds on` | Dangling is **BELOW** finder | `## Enables` → link back to finder |
| Finder's `## Enables` | Dangling is **ABOVE** finder | `## Builds on` → link back to finder |
| Finder's `## Related` | Dangling is **SAME** as finder | `## Related` → link back to finder |
| Finder's inline body text | Ambiguous — read prose | No required reciprocal |

Then cross-reference with the finder's known layer to triangulate:

| Finder layer + section | Inferred layer for dangling |
|---|---|
| `platforms` + `## Builds on` | `cryptography` or `foundations` |
| `platforms` + `## Enables` | `applications` or `market` |
| `applications` + `## Builds on` | `platforms` or `foundations` |
| `applications` + `## Enables` | `market` or `cross-cutting` |
| `foundations` + `## Builds on` | `cryptography` |
| `cross-cutting` + any section | Treat cross-cutting as unbounded; check other finders for tighter bound |

## Multiple finders at different layers

When a dangling ref appears in multiple finders at different layers, use the **lowest-layer finder** to establish the deepest bound:

- Finder A (platforms, `## Enables`) + Finder B (applications, `## Enables`) → dangling is at `applications` (bounded by the lower finder A's "above platforms" → at least applications)
- Finder A (platforms, `## Builds on`) + Finder B (applications, `## Related`) → dangling is at `foundations` (bounded by the lower finder A's "below platforms" → foundations or cryptography)

## Tie-breaking for depth

When multiple dangling candidates resolve to the same inferred layer:

1. **Most inbound references wins** — grep count of `[[<slug>]]` across the vault
2. **Lowest finder's layer as anchor** — the candidate whose lowest finder is deeper wins (connects more fundamental primitives to applications)
3. **Cryptographic density** — the candidate whose finder context references more cryptographic primitives (merkle-tree, digital-signature, hash-function, zk-proof, commitment-scheme) is likely deeper, because it's structurally closer to the cryptography layer

## Type inference from layer

Once layer is determined, use the Type Taxonomy mapping to set `type:`. Default mapping:

| Inferred layer | Most likely type | Check for exception |
|---|---|---|
| `cryptography` | `fundamental` | — |
| `foundations` | `fundamental` or `system` | If infra/architecture → `system` |
| `platforms` | `system` or `programming` | If execution/contracts → `programming`; if chain archetype → `blockchain` |
| `applications` | `concept` | If cross-chain/infra → `concept` or `system` |
| `market` | `economy` or `trading` | If value dynamics → `economy`; if narrative/behavior → `trading` |
| `cross-cutting` | `cross-cutting` | — |

## Verification

After creating the dangling concept and assigning its layer, verify by checking that the section mapping (Builds on / Enables / Related) between the new concept and all its finders is structurally consistent:
- New concept and finder in Builds on ↔ Enables pair → confirm one is below the other
- New concept and finder in Related → confirm same layer
- If any pair breaks the taxonomy, either the layer assignment or the section choice is wrong
