---
name: batch-reciprocity-workflow
description: Batch optimization for processing reciprocity across multiple new concepts simultaneously. Use when creating 2+ concept notes that reference existing concepts, to reduce tool roundtrips by ~50%.
category: knowledge-curator
---

# Batch Reciprocity Workflow

Optimization for the Phase B (outbound) reciprocity step when creating multiple new concepts simultaneously. Reduces tool roundtrips by ~50% compared to per-concept sequential processing.

## When to use

You are creating **2+ new concepts simultaneously** and each references **5+ existing concepts**. For a single concept with few references, the standard sequential approach in `outbound-reciprocity` is fine.

## Workflow

### Step 1: Collect all references from all new concepts

For each new concept C1, C2, C3..., extract ALL `[[N]]` references from `## Builds on`, `## Enables`, and `## Related` sections. Group by expected reciprocal section and merge into a deduplicated master list:

```
Master list:
  Need reciprocal in ## Enables
    (because C put N in ## Builds on):
    - target-a, target-b, ...
  Need reciprocal in ## Builds on
    (because C put N in ## Enables):
    - target-c, target-d, ...
  Need reciprocal in ## Related
    (because C put N in ## Related):
    - target-e, target-f, ...
```

### Step 2: Read ALL target files once

For each unique target N, read its `## Enables`, `## Builds on`, and `## Related` sections. Record:
- What already exists (to avoid duplicates)
- Where to insert each new reciprocal (after which existing entry)
- Any stale formatting (`|-` prefixed lines, duplicate entries) that needs cleanup

**Batch ALL reads before ANY writes.** This is the key optimization — reading one file per tool call adds up fast.

### Step 3: Verify layer relationships before writing

For each C→N reference, cross-check both concepts' layer frontmatter:

| C's layer | N's layer | Correct reciprocal section for N |
|---|---|---|
| Any | Lower | `## Enables` |
| Any | Higher | `## Builds on` |
| Any | Same | `## Related` |

**If C had N in a section that conflicts with N's actual layer, fix C first.** This prevents cascading misclassification errors.

### Step 4: Batch-patch all targets

Apply all patches in parallel batches. Each patch must:
1. Add `[[C]]` with 1-sentence reasoning written from N's perspective
2. Fix any stale formatting (`|-` prefix corruption) found in Step 2, in the same edit

### Step 5: Spot-check

Re-read 2-3 patched files to verify correct rendering. Check:
- Reasoning complete (not bare `[[C]]`)
- No formatting breakage
- Section correct per layer relationship

## Real example from 2026-06-30

3 new concepts (sybil-resistance-measurement, program-obfuscation, state-access-patterns) needed 22 reciprocal patches across 22 existing target concepts.

**With batch approach:**
- 22 read_file calls (Step 2) + 22 patch calls (Step 4) + 2 spot-check reads = 46 calls

**Sequential approach would have been:**
- ~66 reads + ~22 writes = ~88 calls (each concept requires reading all targets from scratch)

**Key savings:** Deduplication of targets that appear in multiple new concepts' references (e.g., hash-function was referenced by both program-obfuscation and state-access-patterns), and reading all sections in one pass instead of per-concept.

## Pitfalls

### Layer direction errors compound in batches

When processing many C→N relationships in parallel, it's easy to miss that C put a same-layer concept in `## Builds on` or `## Enables` instead of `## Related`. Each reciprocal must be individually verified against both concepts' layers.

**Detection**: For each C→N reference, read both concepts' `layer:` frontmatter. If same layer, the reciprocal MUST go in `## Related`, regardless of where C placed the reference.

### Stale formatting spreads in batch patches

The more patches you apply, the more corrupted files you may encounter. Always inspect each target section for `|-` prefixed lines before patching. Fix them in the same edit. A file that receives 2+ separate patches without cleanup accumulates garbage.

### Reciprocal reasoning must be from N's perspective

Each reciprocal `[[C]]` added to N must explain the relationship from N's point of view. Don't copy C's reasoning verbatim — invert or reframe it. Example:

- C's reasoning: "N provides the foundational X that C uses for Y"
- N's reciprocal: "C applies X to achieve Y, making the abstract primitive concrete"

## Related skills

- `outbound-reciprocity` — Phase B procedure for a single concept
- `concept-note-reciprocity` — Full reciprocity procedure (both phases)
- `layer-placement-and-reciprocity` — Layer placement rules
- `knowledge-curator` — Main skill for processing inbox inputs
