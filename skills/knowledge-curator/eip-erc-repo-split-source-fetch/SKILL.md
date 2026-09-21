---
name: eip-erc-repo-split-source-fetch
description: Technique for fetching EIP/ERC specification sources when the standard eips.ethereum.org URL returns 404 due to the ERC repo migration from ethereum/EIPs to ethereum/ercs. Companion to source-gathering-techniques and eip-spec-extraction.
---

# EIP/ERC Repo-Split Source Fetching

## Problem

When fetching canonical EIP/ERC specification sources for knowledge-curator or graph-walk work, `eips.ethereum.org/EIPS/eip-<N>` returns a 404 page for ERC-numbered specs. This happens because ERCs have been migrated from the `ethereum/EIPs` repository to the new `ethereum/ercs` repository. The EIP site only serves EIPs (Core/Networking/Interface), not ERCs.

## Solution

For ERC-numbered specs, use the raw GitHub markdown URL from the new repository:

```
curl -sL https://raw.githubusercontent.com/ethereum/ercs/master/ERCS/erc-<N>.md
```

This returns the full spec as clean markdown — no HTML stripping needed, unlike the EIP site's rendered HTML.

## Lookup priority

1. **ERCs:** `raw.githubusercontent.com/ethereum/ercs/master/ERCS/erc-<N>.md` — new canonical location, returns clean markdown
2. **Fallback (old repo):** `raw.githubusercontent.com/ethereum/EIPs/master/EIPS/eip-<N>.md` — returns `status: Moved` with redirect stub pointing to the new URL
3. **EIPs (Core/Networking/Interface):** `eips.ethereum.org/EIPS/eip-<N>` — still works for specs that haven't been migrated

## When even raw GitHub fails

If both the new and old raw GitHub URLs return 404, the spec may be very new (Draft status, not yet merged to master). Fall back to the Ethereum Magicians discussion thread via the `.json` API endpoint (see `source-gathering-techniques` skill's Discourse section), and note the Draft status in the concept note's Sources section.

## Example

This technique was discovered while resolving the `[[erc-3009]]` dangling ref. The standard EIP site returned 404. The raw GitHub URL `raw.githubusercontent.com/ethereum/ercs/master/ERCS/erc-3009.md` returned the full 800-line specification including Abstract, Motivation, Specification, Rationale, Security Considerations, and reference implementation — all as clean markdown.
