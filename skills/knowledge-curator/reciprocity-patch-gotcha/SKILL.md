---
name: reciprocity-patch-gotcha
description: Prevent silent data loss when patching concept notes for reciprocity — always re-read the full file before patching if you only have a partial view from a prior offset/limit read. The patch tool warns but the fuzzy matcher can still corrupt unseen content.
---

# Reciprocity Patch Tool Gotcha

## The trap

When adding reciprocal wikilinks to existing concept notes during reciprocity checks, you commonly read files with `offset`/`limit` pagination (e.g., to check their `## Enables` section). If you then `patch` the same file without re-reading it fully, **the patch tool's fuzzy matching can match against the wrong content** — silently removing or duplicating entries outside your visible window.

The tool emits a clear warning:
```
"was last read with offset/limit pagination (partial view). Re-read the whole file before overwriting it."
```

This warning is **blocking**. Do not proceed past it.

## The fix

Before any `patch` on a concept note N, if the last `read_file` call on N used `offset`/`limit`:

1. Call `read_file(path)` with no offset/limit first
2. Then proceed with the patch

This clears the partial-read guard and gives the fuzzy matcher the full file context.

## Why this matters in reciprocity

Reciprocity work is especially vulnerable to this trap because:
- You read many concept notes partially (just their `## Related` or `## Builds on` section)
- You then patch multiple files in sequence
- The corruption is silent — the patch succeeds, but an entry elsewhere in the file gets removed

Example (observed 2026-06-28): Patching `token-level-access-control.md` after reading only lines 11-30 caused `- [[erc-7710-delegation]]` to be silently removed from the `## Related` section (which was outside the read window). The patch matched against a nearby line and replaced the wrong content.

## When this does NOT apply

If you read the file fully (no offset/limit) before patching, the guard is not triggered and fuzzy matching has full context — proceed normally.
