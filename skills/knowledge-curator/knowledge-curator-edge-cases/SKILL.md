---
name: knowledge-curator-edge-cases
description: "Documented pitfalls and special techniques for knowledge-curation workflows — concept inflation, reciprocity traps, and JS-heavy source extraction."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [knowledge-curator, graph-walk, reciprocity, concept-inflation, source-extraction, pitfalls]
    related_skills: [knowledge-curator, graph-walk, source-gathering-techniques]
---

# Knowledge Curator Edge Cases

This umbrella skill documents pitfalls, edge cases, and special techniques that arise during knowledge-curation and graph-walk workflows. The three sections below cover the most common classes of edge cases encountered in practice.

## Section A: Concept Inflation Detection

**Origin:** Absorbed from `concept-inflation-detection`.

Concept inflation is creating notes for terms that are not mechanisms — product names, deployment instances, or named standards that duplicate an existing mechanism note. However, EIP/ERC numbers are NOT automatically concept inflation — the vault already contains `eip-712.md`, `eip-1271.md`, `eip-2612.md`, and `eip-4788.md` as valid concept notes describing interface mechanisms.

### The test

Before writing any concept note, ask: **"Is this a noun of a mechanism/idea/dynamic, or a noun of a product/specification/deployment?"**

### EIP/ERC numbered refs — do NOT blanket-reject

A blanket "EIP/ERC numbers are spec cross-refs → reject" rule is **incorrect** for this vault. The vault already contains EIP-numbered concepts (eip-712, eip-1271, eip-2612, eip-4788) that describe specific interface mechanisms.

When evaluating an EIP/ERC-numbered candidate:

1. **Check the vault for precedent.** If the vault already has EIP-numbered concepts (it does), that's the pattern. Follow it unless there's a specific reason to diverge.
2. **Check if an existing note already covers the mechanism.** If the mechanism is fully described in another note, adding an EIP-numbered spec note might be inflation (e.g., creating both [[meta-transaction]] and [[eip-2771]] might be inflation since eip-2771 just specifies the interface for the same mechanism).
3. **Check if the EIP/ERC describes a distinct interface mechanism.** If it defines a specific encoding, interface, or protocol that other notes depend on via wikilinks, it's a valid concept. eip-7579 (execution mode encoding for modular smart accounts) is an example of a mechanism-named-by-spec-number that other notes (erc-7710-delegation) explicitly depend on.
4. **When in doubt, check what layer the ref appears in:**
   - Referenced in `## Builds on` of another concept → likely a valid prerequisite mechanism → ACCEPT
   - Referenced in `## Related (same layer)` of another concept → possibly covering the same ground → check for duplication

| Input | Verdict | Why |
|---|---|---|
| `eip-2771` | AMBIGUOUS — check duplication | Mechanism (meta-transaction) already exists as [[meta-transaction]]. Does eip-2771 add the interface spec that meta-transaction's "why" note doesn't cover? If meta-transaction already describes the forwarder pattern in detail, this may be inflation. |
| `eip-7579` | ACCEPT — interface mechanism | Execution mode encoding for modular smart accounts — a distinct bytes32 bitfield mechanism that [[erc-7710-delegation]] depends on in its Builds on section. No existing note covers this encoding format. |
| `erc-8226` | AMBIGUOUS — check duplication | Identity-bound spend mandate; compare with [[token-level-access-control]] which covers the general spend-mandate pattern. If erc-8226 adds the regulated/identity dimension not covered by token-level-access-control, it may be valid. |
| `eip-4844` | REJECT — proto-danksharding is covered by [[ethereum-scaling]] and [[data-availability]] | Blob transaction mechanism is part of [[ethereum-scaling]] and [[data-availability]]; the EIP describes a specific implementation path, not a new mechanism class. |
| `uniswap` | REJECT — product name | AMM mechanism is [[amm]]; Uniswap is an instance, not a concept |
| `ethereum` | REJECT — product/chain name | L1 architecture is [[l1-blockchain]]; Ethereum is a specific deployment |
| `meta-transaction` | ACCEPT — mechanism | Describes the why/how of off-chain intent → on-chain execution relay |
| `mev` | ACCEPT — mechanism | Describes the economic dynamic of value extraction from transaction ordering |

### Product-name refs — these ARE inflation

Product names (specific chains, DEXes, lending protocols, tokens, wallets, bridges) should NEVER become concept slugs. The reject list in the knowledge-curator skill's Hard Rules is authoritative — follow it strictly.

### When filtering during graph-walk or knowledge-curator

1. If the candidate concept matches an EIP/ERC number pattern, first check the vault for analogous EIP-numbered concepts. If they exist, accept the candidate unless the mechanism is clearly duplicated in an existing note.
2. If the candidate is a product name, always reject — extract the underlying mechanism as the concept and mention the product as an in-body example.
3. Record skipped refs in the daily log with reasoning so the human curator can verify.
4. If you create an EIP-numbered concept that was previously rejected by an earlier run, note the correction in the daily log with rationale.

### Why it matters

Concept inflation makes the graph harder to navigate without adding insight. But false negatives (rejecting valid concepts) leave dangling refs unresolved, breaking the graph's bidirectional connectivity. The test is not "is this an EIP number?" but "does this represent a mechanism not already covered by an existing note?" If the vault already has EIP-numbered concepts, rejecting a new one creates inconsistency that compounds over time.

---

## Section B: Reciprocity Traps

**Origin:** Absorbed from `graph-walk-reciprocity-trap` (full production examples in `references/`).

During graph-walk reciprocity, mechanical application of the reciprocity table without layer-awareness or formatting hygiene creates three classes of errors documented below.

### Trap 1: Same-Layer Reciprocity

When a finder note at layer L places `[[C]]` in `## Enables` (or `## Builds on`) and C is also at layer L, the reciprocal shouldn't silently land in the counterpart section — it should be evaluated:

| Finder section | C's layer | Holds at same layer? | Correct reciprocal |
|---|---|---|---|
| `## Enables` | Same as finder | ❌ No — same-layer concepts don't "enable" each other | Move to `## Related` with reasoning that acknowledges the conceptual relationship but respects taxonomy |
| `## Builds on` | Same as finder | ❌ No | Move to `## Related` |

**Resolution pattern for same-layer:**
1. In C's concept note, add the reciprocal under `## Related` (not `## Builds on`) with reasoning that frames the relationship as conceptual framing, not foundational dependency.
2. Ensure C still satisfies Hard Rule #1 (vertical link mandatory) through at least one genuine cross-layer link in `## Builds on` or `## Enables`.
3. Optionally note the tension in the finder note's body.

### Trap 2: Inverted Direction (Misclassified Section)

When a finder note's author guessed wrong about the conceptual relationship direction. Example: `[[chain-neutrality]]` was placed in `## Enables` of `inclusion-lists`, but chain-neutrality is a LOWER-layer concept (foundations vs platforms). Per the misclassification table:

| Finder section | C is LOWER than F | ❌ Wrong | Move to `## Builds on` |

**Corrective action:**
1. Load the misclassification reference before the reciprocity step
2. Move the link from `## Enables` to `## Builds on` with updated reasoning
3. Update `updated:` frontmatter on the finder note
4. Add reciprocal in the new concept's `## Enables` section

**Tension alert:** The knowledge-curator skill's "don't delete existing content" rule may make you hesitate to move the link. Resolve by recognizing: graph-walk is different from regular enrichment — the finder note was written before C existed, so its section placement is inherently speculative. The misclassification fix is not deleting content; it's correcting a placeholder that was always expected to be wrong.

**Always verify each finder's section classification against both concepts' defined layers before the reciprocity step.**

### Trap 3: Stale Formatting Corruption in Target Notes

During reciprocity, patching target notes may reveal accumulated formatting rot — stale pipe-prefixed list items (`|- [[concept]]`), duplicate entries, or malformed markdown. These corruptions accumulate silently because the `patch` tool's fuzzy matching accepts them.

**Corrective action:**
1. Before applying a patch to add `[[C]]` to N, read N's target section and look for `|-` prefixed lines
2. If corruption exists, fix it in the same patch that adds the reciprocal — combine the reciprocal addition with the cleanup
3. Common patterns: duplicate entries (same concept listed correctly AND as a corrupted copy), malformed entries with pipe prefix
4. The agent touching the file owns any corruption it finds there. Leaving it for a future session means it metastasizes.

---

## Section C: JS-Heavy Documentation SPA Extraction

**Origin:** Absorbed from `js-docs-extraction`.

Many crypto-ecosystem documentation sites use JS-heavy frameworks (Next.js, Docusaurus, GitBook) that don't render well via curl or browser accessibility tree snapshots.

### When to use this technique

- `browser_navigate` loads the page but the snapshot is 1000+ elements deep
- The actual article content is nested under multiple deeply-nested divs
- `curl -sL` returns an empty shell (<20KB, no body content)
- The page loads without Cloudflare/403 challenges (if those appear, use fetch_url.sh instead)

### Technique

Combine `browser_navigate` with `browser_console` using a JavaScript expression:

1. `browser_navigate(url)` — loads the page and runs its JS
2. `browser_console(expression="document.querySelector('main').innerText")` — extracts rendered text

### Selector strategy (try in order)

| Selector | Typical use case |
|---|---|
| `document.querySelector('main').innerText` | Docusaurus, Next.js docs — most have a `<main>` semantic element |
| `document.querySelector('article').innerText` | Blog-style docs (Medium, Mirror) |
| `document.body.innerText` | Fallback — returns everything including nav/sidebar |
| `Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,code')).map(e=>e.innerText).join('\n')` | Targeted extraction — only content elements, no sidebar noise |

### Known-working sites

- `docs.openzeppelin.com/*` → `document.querySelector('main').innerText`
- `docs.flashbots.net/*` → `document.querySelector('main').innerText`
- `book.wormhole.com/*` → `document.querySelector('main').innerText`

### When NOT to use this technique

- If the site uses Cloudflare Turnstile or returns HTTP 403/503 → use `fetch_url.sh --stealth` (see knowledge-curator step 4)
- If the site is plain HTML (curl returns full content) → use curl directly
- If the page is a Discourse forum → use the `/raw/` or `.json` endpoints (see source-gathering-techniques skill)

### Integration with source-gathering-techniques

This technique is the browser-based complement to the curl/Discourse-API approaches documented in `source-gathering-techniques`. Load both when gathering sources for a knowledge-curator or graph-walk task.
