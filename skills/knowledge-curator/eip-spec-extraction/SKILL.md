---
name: eip-spec-extraction
description: Browser-based extraction technique for EIP/ERC specification pages — uses browser_navigate + browser_console(document.body.innerText) to get full spec text without temp files or HTML stripping. Companion to the source-gathering-techniques skill.
category: knowledge-curator
---

# EIP/ERC Specification Extraction via Browser Console

## When to use this

You need to read the full text of an EIP or ERC specification from `eips.ethereum.org/EIPS/eip-<N>` for a knowledge-curator or graph-walk task. The EIP page renders server-side (Jekyll static site), so the browser produces clean full text without JS dependency.

## Why not curl

The existing `source-gathering-techniques` skill documents curl + HTML-stripping for EIP pages, which works. The browser approach is an alternative that:

- Requires no temp files
- Requires no HTML-to-text extraction script
- Returns clean rendered text directly from `document.body.innerText`
- Works when CDNs block curl user-agents but allow browsers
- Handles code blocks, tables, and formatting natively (already rendered as text)

Use curl when browser tools are unavailable or slower (e.g., limited browser bandwidth). Use the browser approach when you want a clean one-step extraction.

## Technique

```python
# Step 1: Navigate to the EIP page
browser_navigate("https://eips.ethereum.org/EIPS/eip-<N>")

# Step 2: Extract the full text in chunks
# browser_snapshot(full=true) is TRUNCATED for pages >8K chars.
# Use browser_console with document.body.innerText instead.
result = browser_console(
    expression="document.body.innerText.substring(0, 15000)"
)
full_text = result["result"]

# Step 3: If the spec is >15KB, get the next chunk
if len(full_text) >= 14900:
    result2 = browser_console(
        expression="document.body.innerText.substring(15000, 30000)"
    )
    full_text += result2["result"]

# Step 4: Very long specs (>30KB) need a third chunk
if len(full_text) >= 29900:
    result3 = browser_console(
        expression="document.body.innerText.substring(30000)"
    )
    full_text += result3["result"]
```

## What you get

The extracted text includes all sections of the EIP/ERC specification:

- **Abstract** — one-paragraph summary of what the standard defines
- **Motivation** — why the standard exists, what gap it fills (primary source for the concept note's "Why it exists")
- **Specification** — full interface signatures, structs, events (Solidity pseudocode rendered as plain text)
- **Rationale** — design decisions and trade-offs (secondary source for "Why it exists", often contains the actual constraints)
- **Backwards Compatibility** — how it interacts with existing standards
- **Security Considerations** — known attack surfaces and mitigations
- **Reference Implementation** — if present, concrete code examples

## Known limitations

| Issue | Workaround |
|---|---|
| Spec >45KB (rare — EIPs are usually 10-25KB) | May need 4th chunk; check total length from `document.body.innerText.length` via browser_console |
| Table content rendered as space-separated text | Content is present but formatting is lost — sufficient for concept extraction but tables won't render as structured data |
| Code blocks render without syntax highlighting | Code is readable as plain text; interface signatures are complete and extractable |
| Ethereum Magicians discussion threads | These are Discourse SPAs — use `.json` API endpoint instead (see `source-gathering-techniques`) |

## Real example (from production)

For **ERC-8226 (Regulated Agent Mandate)**:
- Page size: ~14KB text (~22KB HTML)
- Extracted in one chunk (fit in 15KB)
- Contents included: abstract, motivation (3 problem conditions), two complete Solidity interfaces (IComplianceProvider + IAgentMandate with all structs, events, functions), integration pseudocode, rationale (7 distinct design decisions), backwards compatibility, security considerations (7 identified risks)
- The Ethereum Magicians thread (separate source) added open questions about custody model that the spec didn't cover

## When NOT to use this

- **Discourse forums** (ethresear.ch, ethereum-magicians.org): JS-heavy SPAs — use the JSON API (`/t/<slug>/<id>.json` for full thread, `/raw/<id>` for single post)
- **GitHub PRs or wikis**: Use `curl -sL` or the GitHub API — these are plain-text friendly
- **SPA dashboards** (Dune, EigenPhi): Use `fetch_url.sh --stealth` as documented in the knowledge-curator fetch fallback section
- **Pages requiring login or authentication**: Browser tools may not have session state; fetch manually or flag `[NEEDS-MANUAL]`
