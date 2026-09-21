---
name: graph-walk-container-misclassification
description: When a framework/container concept (e.g., memory-layer) lists a component mechanism (e.g., inclusion-lists) in Builds on or Enables, but they are at the same layer. Detects and fixes this specific finder-note misclassification pattern during graph-walk reciprocity checks.
category: knowledge-curator
---

# Graph-Walk: Container-Concept Same-Layer Misclassification

A concrete sub-pattern of the general finder-note section misclassification problem. This skill captures a recurring case where the classification table in `graph-walk-finder-misclassification` applies but the trigger is subtle because the finder's reasoning *sounds* correct.

## The Pattern

A framework/container concept F (e.g., `memory-layer`, layer: platforms) lists a component/instance concept C (e.g., `inclusion-lists`, layer: platforms) in F's `## Enables` section, with reasoning like "C is a mechanism within F's framework." Because F provides the conceptual home for C, the forward-direction reasoning *feels* enabling. But the layer-direction rule is mechanical: same layer → `## Related`, not `## Enables`.

## Diagnosis

This pattern fires when ALL of these are true:
1. F is a higher-abstraction concept (framework, taxonomy, container) — often a newly proposed protocol layer or architectural category
2. C is a concrete mechanism that instantiates or fits within F's abstraction
3. C's `layer:` (determined during graph-walk creation) equals F's `layer:`
4. F's link to `[[C]]` is in `## Enables` or `## Builds on`

## Fix (both directions)

1. Move `[[C]]` in F from `## Enables` → `## Related (same layer)`. Keep the reasoning verbatim — the semantics are correct, only the section was wrong.
2. If the reciprocal was already added to C's `## Builds on` (because the standard Enables→Builds on reciprocity rule was applied), move it from `## Builds on` → `## Related (same layer)` in C as well.
3. Optionally reframe: "C and F are both [layer] concepts; C is a component mechanism within F's [domain] framework."

## Real example

memory-layer.md (layer: platforms) had:
```
## Enables
- [[inclusion-lists]] — FOCIL is a memory-layer mechanism...
- [[mev]] — ...
```

After graph-walk resolved inclusion-lists at layer: platforms (same as memory-layer):
- `[[inclusion-lists]]` → moved from memory-layer's `## Enables` to its `## Related (same layer)`
- `[[memory-layer]]` → moved from inclusion-lists's `## Builds on` to its `## Related (same layer)`
- The mev link stayed in `## Enables` (correct — mev is layer: market, which is HIGHER than memory-layer's platforms)

## Key lesson

Do not trust the "feeling" of a relationship. The layer-direction rule is mechanical: compare frontmatter `layer:` values. If they match, the link belongs in `## Related (same layer)` — regardless of whether the link describes an "enabling" relationship.

## See also

- `graph-walk-finder-misclassification` — general finder-note misclassification workflow
- `layer-placement-and-reciprocity` — common pitfalls in layer placement