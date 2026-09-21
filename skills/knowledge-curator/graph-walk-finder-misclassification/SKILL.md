---
name: graph-walk-finder-misclassification
description: When resolving a dangling concept ref via graph-walk, the finder notes that linked to it may have the link in the wrong section because the concept didn't exist yet. Fix these misclassifications during the reciprocity check.
category: knowledge-curator
---

# Graph-Walk: Finder-Note Section Misclassification

When a graph-walk creates concept C (which previously existed only as a dangling `[[C]]` ref), every finder note that linked to C was written BEFORE C existed. The finder's author had to guess C's layer from context alone — and that guess may be wrong. Now that C has a defined `layer:` in its frontmatter, the graph-walk must verify and fix the finder's section classification.

## The trigger

This is always worth checking during a graph-walk reciprocity step. The finder note cannot have known C's layer at the time of writing, so section placement is speculative by definition.

## The layer-direction rule (refresher)

| Section | Points |
|---|---|
| `## Builds on` | DOWN to lower layer |
| `## Enables` | UP to higher layer |
| `## Related (same layer)` | SAME layer only |

## Classification check table

For each finder note F that has `[[C]]` in one of its structured sections, read C's `layer:` and F's `layer:` and compare:

| Where `[[C]]` appears in F | C's layer vs F's layer | Correct? | Fix |
|---|---|---|---|
| `## Builds on` | C is LOWER than F | ✅ Correct | No action needed |
| `## Builds on` | C is SAME as F | ❌ Wrong | Move to `## Related` |
| `## Builds on` | C is HIGHER than F | ❌ Wrong | Move to `## Enables` |
| `## Enables` | C is HIGHER than F | ✅ Correct | No action needed |
| `## Enables` | C is SAME as F | ❌ Wrong | Move to `## Related` |
| `## Enables` | C is LOWER than F | ❌ Wrong | Move to `## Builds on` |
| `## Related` | C is SAME as F | ✅ Correct | No action needed |
| `## Related` | C is LOWER than F | ❌ Wrong | Move to `## Builds on` |
| `## Related` | C is HIGHER than F | ❌ Wrong | Move to `## Enables` |

## How to fix

1. **Move the link** from the wrong section to the correct one in the finder note F.
2. **Rewrite the reasoning sentence** to match the new section's semantics:
   - Builds on: "C provides the [mechanism/foundation] that F builds on because..."
   - Enables: "F enables C because..." (from C's perspective) or "C is an application of F" (from F's perspective)
   - Related: "C and F are both [domain] mechanisms; C is [contrast/alternative/complement] to F..."
3. **Clean up artifacts.** Removing a bullet may leave a double-blank-line gap between the preceding and following sections. Check and collapse.
4. **Add the reciprocal link** in C's corresponding section (e.g., if F's `[[C]]` was moved to `## Builds on`, add `[[F]]` to C's `## Enables` with reasoning).

## Worked example from production

`treasury-subaccounts.md` (layer: applications) had `[[spend-mandate]]` in its `## Related (same layer)` section. Graph-walk created `spend-mandate.md` at `layer: platforms`. Since spend-mandate is LOWER than treasury-subaccounts, the link should be in `## Builds on`.

**Before fix:**
```
## Related (same layer)
- [[access-control]] — ...
- [[spend-mandate]] — the bounded delegation at the heart of treasury sub-accounts is a form of spend mandate
```

**After fix:** link moved to `## Builds on` with updated reasoning:
```
## Builds on
- ...
- [[spend-mandate]] — the bounded delegation at the heart of treasury sub-accounts is an instantiation of the spend mandate pattern applied to organizational treasury management
```

Reciprocal added to `spend-mandate.md`'s `## Enables`:
```
- [[treasury-subaccounts]] — treasury sub-accounts are an organizational application of spend mandates
```

## Common failure mode: patch tool escape-drift with Unicode quotes

When patching files that contain Unicode/smart quotes (e.g. `"` and `"` or `'` and `'`) — common in Obsidian markdown with auto-correct enabled — the patch tool may reject the edit with "Escape-drift detected" error. The fix: re-read the file with `read_file()` and use the EXACT bytes from the output (including the exact quote characters) in the `old_string` and `new_string` parameters. Do not substitute ASCII approximations.

## Integration

This skill is a companion to `graph-walk` (which covers the main workflow). Load both when resolving dangling refs. The classification check should run between step 5 (write concept note) and step 7 (daily log) of the main graph-walk workflow.