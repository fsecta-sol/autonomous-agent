---
name: graph-walk-deepest-tiebreak
description: When multiple dangling refs are at the same layer with the same inbound count, use conceptual depth (proximity to cryptographic/foundational primitives) as the third-level tie-breaker.
---

# Conceptual Depth Tie-Breaker for Graph Walk

The main `graph-walk` skill's selection priority has two levels: (1) layer depth, (2) inbound wikilink count. When both are tied — e.g., three candidates all at `applications` layer with 1 inbound ref each — use conceptual depth as the third-level tie-breaker.

## Decision procedure

For each tied candidate, ask two questions:

**Q1: "Could this concept exist in its current form without cryptography?"**
- If NO (it fundamentally depends on digital-signatures, hash-functions, zk-proofs) → ranks DEEPER
- If YES (it's about economic incentives, market dynamics, legal frameworks, or application UX that happen to be on-chain) → ranks SHALLOWER

**Q2: "How much cryptographic/platform infrastructure is needed to explain what this concept IS?"**
- If the explanation requires discussing key pairs, signature schemes, consensus rules, or hash commitments → DEEPER
- If the explanation fits in purely economic/incentive/design terms → SHALLOWER

## Worked example (2026-06-28)

Three dangling refs, all `applications` layer, all with 1 inbound wikilink:

| Candidate | Why deeper/shallower |
|---|---|
| `digital-identity` | DEEPER — identity is fundamentally rooted in key management, digital signatures, hash commitments. Even though DID systems are deployed as applications, the concept cannot be explained without cryptographic primitives. |
| `real-world-assets` | SHALLOWER — tokenization of off-chain assets is about trust, custody, legal frameworks, and token standards. The mechanisms work with any digital signature scheme; the concept is not shaped by cryptographic constraints. |
| `stablecoin-design` | SHALLOWER — stablecoin peg mechanics are pure economic design (collateral ratios, arbitrage incentives, liquidation mechanisms). The concept is independent of the specific cryptographic primitives used to implement it. |

## Integration with main graph-walk skill

Load this skill alongside `graph-walk` when the pre-check script reports tied candidates. The selection priority becomes:

1. Layer depth first
2. Inbound wikilink count
3. Conceptual depth (this skill)
4. If still tied: pick the ref that unblocks the most `[NEEDS-LINK]` concepts

## Relationship to layer-placement-and-reciprocity skill

Conceptual depth considers the *intellectual dependencies* of a concept, not its layer tag. A concept placed at `applications` can still be "deeper" than another `applications` concept if it depends on more foundational ideas (cryptography, consensus) for its definition. The layer tag reflects *where the concept lives structurally*; conceptual depth reflects *how close to the metal its core mechanism is*.
