---
name: graph-walk-false-positives
description: Filter false positive dangling refs and use browser navigation as a source-gathering fallback during graph-walk cron sessions.
---

# Graph Walk False Positives & Source Fallbacks

Two pitfalls that recur during graph-walk cron sessions, not yet covered by the main graph-walk or source-gathering-techniques skills.

## False Positive: `[[#Section]]` Internal Section Links

**Problem.** The pre-check script flags `[[#Open questions]]`, `[[#Why it exists]]`, and similar internal section wikilinks as dangling concept refs. These are NOT concept slugs — they are Obsidian-style wikilinks pointing to a heading (`##`, `###`) within the **same file**.

**Detection.** Check the dangling ref list from the pre-check script. Any ref starting with `#` is an internal section link:

```
Dangling concept refs detected (2):
#Open questions              ← FALSE POSITIVE (starts with #)
regenerative-finance         ← REAL DANGLING REF
```

**Action.**
1. Verify the `#`-prefixed ref matches a heading in the source file
2. Skip it — no concept note needed
3. Note in daily log: "N ignored (`#X` — internal section ref, not a concept)"
4. Process remaining real dangling refs normally

**How they arise.** A concept note that links to its own `## Open questions` section using `[[#Open questions]]` in Obsidian creates a wikilink that the pre-check script misidentifies as a cross-concept reference.

## Browser Fallback for GitBook / Next.js Doc Sites

**Problem.** `fetch_url.sh` returns JS-heavy SPA shells for GitBook-based documentation (`docs.klimadao.finance`, `docs.toucan.earth`) or sites like `docs.safe.global` and `docs.flashbots.net`. The `--stealth` mode may be blocked by security rules or time out.

**Solution.** Use browser navigation instead — it renders the JS and returns clean text content in the accessibility snapshot.

**Workflow.**
1. `browser_navigate(url)` — opens the page, returns a snapshot with the rendered structure
2. `browser_click(ref)` — click sidebar/table-of-contents links to reach the specific section
3. `browser_snapshot(full=true)` — get full rendered text content
4. The content is already plain text, not raw HTML — no stripping needed

**Tested domains where this works:**
- `docs.klimadao.finance` (GitBook)
- `docs.toucan.earth` (GitBook)
- `docs.safe.global` (Next.js)
- `docs.flashbots.net` (Next.js)
- Any `*.gitbook.io` or GitBook custom domain

**When NOT to use browser fallback:**
- Plain-text endpoints (.md, .txt, .json, raw.githubusercontent.com) — just curl
- `fetch_url.sh` already works fine — browser is slower
- Paywalled content (Medium, Substack) — server-side, not fixable with browser. Mark `[NEEDS-MANUAL]`.

**Medium paywall note.** Medium articles are paywalled at the server level — neither `fetch_url.sh` nor browser navigation can extract article text. Look for a free cross-post (Mirror, personal blog). If none exists, mark `[NEEDS-MANUAL]`.
