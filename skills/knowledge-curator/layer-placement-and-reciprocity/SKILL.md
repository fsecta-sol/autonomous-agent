---
name: layer-placement-and-reciprocity
description: Common pitfalls and verification procedures for correctly placing concepts across layers (Builds on / Enables / Related) and ensuring full bidirectional reciprocity in the knowledge graph.
category: knowledge-curator
---

# Layer Placement and Reciprocity Pitfalls

This skill catalogs the most common errors when placing concepts in the correct `## Builds on`, `## Enables`, or `## Related (same layer)` sections during concept note creation or enrichment, and provides verification procedures for reciprocity.

## The layer direction rule

The layer taxonomy (cryptography → foundations → platforms → applications → market) has a strict structural axis:

- **`## Builds on`**: points DOWN to a LOWER layer. Concept C at layer L lists concepts at layers below L.
- **`## Enables`**: points UP to a HIGHER layer. Concept C at layer L lists concepts at layers above L.
- **`## Related (same layer)`**: SAME layer only. Concepts at exactly layer L.

Cross-cutting is a special case — it must link to at least 2 different layers.

## Failure mode 1: Same-layer concepts in Builds on or Enables

**Error:** Placing a same-layer concept in `## Builds on` or `## Enables` instead of `## Related`.

**Example:** EIP-4788 (platforms) listing `smart-contracts` (also platforms) in Builds on. Both are `layer: platforms` — they belong in `## Related`.

**Fix:** Before writing any link, read the target concept's `layer:` frontmatter. If it matches C's layer, move it to `## Related`. Do NOT infer layer from the concept's name or domain.

**Common same-layer traps:**
- `bridge` is `layer: platforms`, NOT applications
- `smart-contracts` is `layer: platforms`
- `trustless-data-indexing` is `layer: platforms`

## Failure mode 2: Enables pointing downward

**Error:** Putting a lower-layer concept in `## Enables`.

**Example:** EIP-4788 (platforms) listing `light-client` (foundations) in Enables. Foundations is BELOW platforms. Enables only goes upward.

**Fix:** If C is at platforms and N is at foundations:
- If C depends on N → N goes in `## Builds on`
- If N depends on C → this doesn't happen with lower-layer N (you can't "enable" something below you). N doesn't belong in structured sections if there's no dependency in C's direction.
- If neither makes sense → omit N from structured sections entirely

## Failure mode 3: Sibling reciprocal trap

**Error:** Adding `[[sibling]]` to C's `## Related` but forgetting to add `[[C]]` back to sibling's `## Related`.

**Example:** eip-4788 adds `[[bridge]]` to Related, but `bridge.md` doesn't get `[[eip-4788]]` added back.

**Fix:** After adding a same-layer link from C → N, immediately open N and add the reciprocal link back. Verify by searching the vault for `[[C]]` after you're done.

## Reciprocity verification procedure

Run this AFTER writing C's outgoing links, BEFORE finalizing:

```
For each concept N in C's Builds on / Enables / Related:
  1. Read N's frontmatter layer line
  2. Confirm the layer relationship matches the section placement
  3. Add [[C]] to N's reciprocal section (1-sentence reasoning):
     - C in Builds on → N gets C in Enables ("C enables N because...")
     - C in Enables → N gets C in Builds on ("C builds on N because...")
     - C in Related → N gets C in Related ("C is sibling because...")
  4. For Related specifically: verify BOTH C→N and N→C exist
  5. If N already had a pre-existing [[C]] link that lacked 1-sentence
     reasoning, add reasoning to N's link now
```

## Reciprocity section mapping table

| Where `[[N]]` appears in C | Where `[[C]]` must appear in N | Reasoning template |
|---|---|---|
| `## Builds on` | `## Enables` | "C enables N because..." |
| `## Enables` | `## Builds on` | "C builds on N because..." |
| `## Related (same layer)` | `## Related (same layer)` | "Sibling: alternative/variant/complement" |
| Inline body text (not structured) | No required reciprocal | Optional note in C's `## Notes` |

## Cross-profile note

These skills (knowledge-curator, graph-walk) may live in a different Hermes profile than the one you're currently running under. To edit them directly, use `patch` with `cross_profile=True` targeting the SKILL.md file path, or switch profiles with `hermes -p <profile_name>`.
