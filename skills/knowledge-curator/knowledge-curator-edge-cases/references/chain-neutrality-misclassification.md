# Production example: chain-neutrality misclassification (2026-06-27)

## Context

`inclusion-lists.md` (layer: platforms) had `[[chain-neutrality]]` in its `## Enables` section. Graph-walk created `chain-neutrality.md` at `layer: foundations`.

## The misclassification

Chain neutrality (foundations) is a LOWER-layer concept than inclusion lists (platforms). Per the finder-misclassification table:

| `## Enables` | C is LOWER than F | ❌ Wrong | Move to `## Builds on` |

The finder's placement was wrong because:
- When `inclusion-lists.md` was written, `chain-neutrality` didn't exist yet as a note with a defined layer
- The author guessed chain-neutrality was an UPPER-layer concept (perhaps market or applications) that inclusion lists "enable"
- In reality, chain neutrality is a foundational consensus property that inclusion lists MECHANICALLY ENFORCE — the direction is inverted

## The trap mechanism

The inverted-direction error is subtle because the relationship *sounds* correct in ordinary language: "inclusion lists *enable* chain neutrality." But the layer taxonomy requires a specific direction: lower-layer concepts ENABLE upper-layer mechanisms; upper-layer mechanisms BUILD ON lower-layer properties. Since chain neutrality is foundations and inclusion lists are platforms:
- **Correct:** chain-neutrality (foundations) ENABLES inclusion-lists (platforms) 
- **Incorrect:** inclusion-lists (platforms) ENABLES chain-neutrality (foundations)

## What should have happened (corrective action)

1. Load `graph-walk-finder-misclassification` before reciprocity step
2. Spot that inclusion-lists (platforms) has [[chain-neutrality]] (foundations) in `## Enables` → invalid per table
3. Move the link from inclusion-lists' `## Enables` to `## Builds on` with updated reasoning
4. Update inclusion-lists' `updated:` frontmatter date
5. Add reciprocal to chain-neutrality's `## Enables`

## Why the fix was missed (this is the real trap)

The graph-walk ran the reciprocity check and found one inbound link. Instead of running the finder-misclassification check first, it proceeded to reciprocate mechanically — adding `[[inclusion-lists]]` to chain-neutrality's `## Builds on` with a [CONFLICT] flag. This flagged the problem but didn't fix it. The finder note (inclusion-lists.md) retains a structurally incorrect section placement.

**Root cause:** The `graph-walk-finder-misclassification` skill was not loaded before the reciprocity step. Always load it and run its classification check table before reciprocating.

## What was done instead (partial workaround)

Since the CONFLICT was raised instead of moving the link, a "Reciprocal angle from [[chain-neutrality]]" paragraph was added to inclusion-lists.md's `## Why` section covering the compliance/regulatory reframing. The structural fix should be applied on the next pass.
