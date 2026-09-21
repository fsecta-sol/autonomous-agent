---
name: outbound-reciprocity
description: Phase B of the reciprocity procedure — when a new concept C links to existing concepts in Builds on / Enables / Related, each destination N needs a reciprocal [[C]] link back. This fills the gap in the main knowledge-curator skill's procedure (which covers Phase A / inbound only).
category: knowledge-curator
---

# Outbound Reciprocity (Phase B)

When creating a new concept C, the main knowledge-curator skill's reciprocity procedure (steps 1–4) covers **Phase A**: find notes that link TO C and add reciprocals in C. But Hard Rule #9 says **every** wikilink must be reciprocated — including C's own `## Builds on`, `## Enables`, and `## Related` links pointing outward to existing concepts. This is **Phase B**: ensure every concept N that C links to gets a reciprocal `[[C]]` link back.

## Procedure

1. **Collect C's outgoing wikilinks.** Read C's `## Builds on`, `## Enables`, `## Related` sections. Extract every `[[<slug>]]` reference.

2. **For each destination N**, check the section mapping:

   | Section in C | Reciprocal section in N | Reasoning template |
   |---|---|---|
   | `## Builds on` | `## Enables` | "C enables N because... (invert C's reasoning)" |
   | `## Enables` | `## Builds on` | "C builds on N because... (invert C's reasoning)" |
   | `## Related (same layer)` | `## Related (same layer)` | "Sibling: alternative/variant/complement to C" |

3. **Already satisfied?** If N already has `[[C]]` with 1-sentence reasoning, skip.

4. **Missing reciprocal?** Add `[[C]]` to N's appropriate section with reasoning written from N's perspective. Invert or reframe C's own reasoning about the relationship.

5. **Dangling destination?** If N has no concept file yet, skip — the future graph-walk that creates N will find C's forward link and add the reciprocal then. Note in daily log.

## Worked example: eip-712 outbound reciprocity

Created eip-712 (platforms, programming). Its outgoing links required 8 reciprocals added to existing notes:

| Outgoing link from eip-712 | Section | Reciprocal added to N's | Reasoning |
|---|---|---|---|
| `[[digital-signature]]` | Builds on | `## Enables` | eip-712 is built on ECDSA ecrecover |
| `[[hash-function]]` | Builds on | `## Enables` | eip-712 uses keccak256 at every level |
| `[[smart-contracts]]` | Builds on | `## Enables` | contracts consume EIP-712 signatures |
| `[[eip-1271]]` | Enables | `## Builds on` | EIP-712 provides message format for EIP-1271 |
| `[[permit2]]` | Enables | `## Builds on` | Permit2 uses EIP-712 typed structs |
| `[[account-abstraction]]` | Enables | `## Builds on` | UserOps use EIP-712 signing |
| `[[erc-7710-delegation]]` | Enables | `## Builds on` | delegation proofs are EIP-712 |
| `[[access-control]]` | Related | `## Related` | EIP-712 is transport for delegation |
| `[[meta-transaction]]` | Enables | (skip) | dangling ref — no concept file yet |
| `[[eip-2612]]` | Enables + Related | (skip) | already had [[eip-712]] with reasoning |

Total: 8 files modified, 2 skipped, 1 dangling.

## Pitfalls

- **Don't skip outbound reciprocity.** The anti-pattern "One-way links" applies symmetrically. Concept C linking to N without N linking back to C is still a one-way link — just from the other direction.
- **Don't add bare reciprocal links.** Every `[[C]]` entry in N must have 1-sentence reasoning explaining the relationship from N's perspective.
- **Layer mismatch check.** Before adding the reciprocal, verify N's layer matches the section. A same-layer link in Builds on indicates a layer classification error.
