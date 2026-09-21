---
name: project-input-edge-cases
description: "Handle inbox inputs that name projects rather than mechanisms — disambiguate bare project names, marketing landing-page URLs, and already-covered mechanisms."
---

# Project Input Edge Cases

This skill documents three patterns where a knowledge-curator inbox input names a project (specific chain, protocol, token) rather than a mechanism. Each has a specific resolution path that avoids concept inflation while respecting the workflow.

## Pattern 1: URL resolves to a product/marketing landing page

The main skill's input type table classifies URLs as "article/blog" → fetch + extract concepts. But many project URLs point to marketing landing pages (Webflow, Framer, Next.js marketing SPAs) that contain only feature lists and taglines, not mechanism research.

**Detection:** After fetching, if the page reads like a press release ("The first X-native blockchain purpose-built for Y") with no technical depth, no design rationale, no mechanism explanation — it's a marketing page, not research.

**Resolution:**
1. Apply the blacklist rule from the main skill's step 4: marketing/landing pages are not canonical sources. Since the input itself IS the landing page, treat the entire input as a disguised project reference.
2. Extract whatever mechanism is hinted at (e.g., ARC's "stablecoin-native gas" → mechanism `stablecoin-denominated-fees`).
3. Check the vault: does an existing concept already cover this mechanism? ([[account-abstraction]] covers paymaster ERC-20 gas, [[fee-market-dynamics]] covers fee currencies, [[stablecoin]] covers stablecoin design). If yes → no new concept warranted.
4. If the extracted mechanism is too thin to stand as a concept (reads as a product feature rather than a mechanism "why"), reject as concept inflation.
5. Mark `[REJECT-PROJECT]` in the daily log with: the URL, what it resolved to, the mechanism considered, and why it was rejected.

**Example:** `arc-chain.md` → URL `https://arc.io` → Circle's stablecoin-native L1 landing page. Extracted mechanism (stablecoin-denominated fees) already covered by [[account-abstraction]] (paymasters abstracting gas payment to ERC-20 tokens) and [[fee-market-dynamics]] (fee currency design choices). → `[REJECT-PROJECT]`.

## Pattern 2: Bare project name, no URL or content

An inbox file contains only the project name (< 50 chars total, no URL, no description). Example: `robinhood-chain.md` with content "robinhood chain — Robinhood Chain".

**Detection:** After reading, if total content is ≤ a single line identifying a project with no URL, no links, no analysis, no mechanism description.

**Resolution:**
1. Attempt 1–2 quick web searches to identify what mechanism the project illustrates. Do NOT over-invest — this is a seed, not your job to fully research.
2. If the project is clearly a specific chain/protocol per the reject list (specific L1, L2, DEX, etc.) AND no crisp mechanism noun emerges from what you find ("exchange-run-l2" is a business trend/pattern, not a mechanism with a "why"), reject it.
3. Mark `[REJECT-PROJECT]` in the daily log with: the input name, what little was found, and why no mechanism was extracted.
4. Note that the user may have intended more context, or that this could route to the project-researcher skill.
5. Do NOT create a concept note speculatively from a name alone — that is concept inflation.

**Example:** `robinhood-chain.md` → "robinhood chain — Robinhood Chain" only. Web search reveals it's an "AI-native Layer 2" by Robinhood. This is a specific L2 deployment (reject list). The mechanism would be "exchange-run-l2" which is a business strategy, not a mechanism with a "why." → `[REJECT-PROJECT]`.

## Pattern 3: Extracted mechanism is already covered in the vault

Hard rule #4 says "extract the mechanism a project illustrates and write that concept note." Sometimes the extraction succeeds but the mechanism already exists in the vault.

**Detection:** After extracting the mechanism candidate and slugging it, check the vault. Either the exact slug exists, or an existing concept covers the same "why" from a different framing with overlapping scope.

**Resolution:**
1. If the mechanism is already covered, do NOT create a duplicate concept.
2. Optionally, consider whether the project provides a notable instance for that concept's `## Real-world examples` section — only if it adds a novel angle or quantified incident not already documented.
3. Document in daily log: "Input X → underlying mechanism [[existing-concept]] already covered; no new concept warranted. Consider adding as an example if the project provides a novel case study."

## Common thread

All three traps lead to the same failure mode: **concept inflation from a project input**. Whether the input is a bare name, a marketing URL, or a project whose mechanism is already documented, the result is the same — reject the project as a concept slug, and don't create a dubious thin concept just to satisfy "extract the mechanism." The workflow's intent is to find genuine new mechanisms; when none exists, rejecting cleanly is more valuable than speculating.

## Relationship to main Knowledge Curator skill

This skill supplements Hard Rule #4 (REJECT-PROJECT) and the Input Types table (URL handling) in the main knowledge-curator skill. It fills the gap where neither rule tells you what to do when extraction from a project input fails or when the URL is a disguised project reference. Load this when processing inbox inputs whose names or URLs suggest a project rather than a research article.
