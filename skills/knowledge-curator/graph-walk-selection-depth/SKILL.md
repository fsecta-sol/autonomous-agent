---
name: graph-walk-selection-depth
description: Companion to graph-walk — when multiple dangling refs at different implied layers, use section context to determine which is deepest before consulting the layer taxonomy.
category: knowledge-curator
---

# Graph-Walk: Depth Selection via Section Context

When the pre-check script reports multiple dangling refs, you must pick the deepest one first. The main `graph-walk` skill's layer-depth priority is the right tool — but it requires knowing each candidate's layer, which is inferred from context (since the concept doesn't exist yet).

## Depth by section type (quick heuristic)

Before doing full layer inference via `concept-layer-inference`, use the finder note's section context for a rapid depth comparison:

| Section where `[[dangling]]` appears | Implied depth relative to finder |
|---|---|
| Finder's `## Builds on` | **Deeper** (one layer below finder) |
| Finder's `## Enables` | **Shallower** (one layer above finder) |
| Finder's `## Related (same layer)` | **Same layer** as finder |
| Finder's inline body text | Ambiguous — need full inference |

**Decision rule:** Between any two dangling refs, the one in `## Builds on` of any note is ALWAYS deeper than any candidate in `## Related` or inline text. A ref in `## Enables` is ALWAYS shallower than any candidate in `## Related` or inline text.

Only when two candidates at the SAME section type need disambiguation should you consult `concept-layer-inference` for full triangulation.

## Worked example (2026-07-12)

Three dangling refs:

| Slug | Finder note | Finder section | Finder layer | Implied depth |
|---|---|---|---|---|
| `stablecoin-peg` | stablecoin-redemption-mechanics | `## Builds on` | market | **lowest** (applications) |
| `crisis-behavior` | stablecoin-redemption-mechanics | `## Related (same layer)` | market | same as market |
| `liquidity-provider-economics` | protocol-fee-mechanisms | `## Related (same layer)` | market | same as market |

Result: `stablecoin-peg` is in `## Builds on` → one layer below market (applications). The other two are at market layer (same as their finders). Applications < market in the taxonomy, so `stablecoin-peg` is deepest.

## When section and finder-layer conflict

Rare case: a ref in `## Builds on` of a `foundations`-layer finder (would imply cryptography) combined with a ref in `## Enables` of a `market`-layer finder (would imply applications to market). In this case:
1. The `## Builds on` ref is deeper (cryptography) than the `## Enables` ref (applications/market)
2. Cryptography is lower than applications in the taxonomy
3. Pick the `## Builds on` ref

If both refs are at the same depth despite different section types (e.g., `## Builds on` of market → applications, and `## Enables` of platforms → applications), both are at the same layer — revert to tie-breakers: inbound count, then conceptual depth (`graph-walk-deepest-tiebreak`).
