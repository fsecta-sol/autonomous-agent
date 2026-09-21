---
name: discourse-browser-extraction
description: Extract full article text from Discourse forum pages using browser_console DOM extraction — workaround for accessibility snapshot truncation. Companion to discourse-fetching-patterns. Use when browser_navigate + browser_snapshot truncates long Discourse posts.
---

# Discourse Browser Extraction

## Problem

`browser_navigate` on Discourse topics returns an accessibility-tree snapshot, but the snapshot **truncates at ~8000 chars** for long posts. This is too short for most governance proposals, technical specifications, and forum discussions.

## Solution: browser_console DOM extraction

After navigating, use `browser_console` with JavaScript DOM access to extract the full rendered text:

```
browser_navigate("https://research.lido.fi/t/penalty-framework-cmv2/11732")

# browser_snapshot is truncated — extract full text from the DOM
result = browser_console(
    expression='document.querySelector("article").innerText.substring(0, 3000)'
)
```

### For very long articles

Chunk in 3000-char increments:

```
# Chunk 1: 0-3000
result1 = browser_console(expression='document.querySelector("article").innerText.substring(0, 3000)')

# Chunk 2: 3000-6000
result2 = browser_console(expression='document.querySelector("article").innerText.substring(3000, 6000)')

# Chunk 3: 6000-9000
result3 = browser_console(expression='document.querySelector("article").innerText.substring(6000, 9000)')

# Chunk 4+: continue until the returned string is < 3000 chars
```

### What to target

- **`document.querySelector("article")`** targets the post body, not the full page (avoids sidebar, nav, and footer noise)
- **`document.body.innerText`** gets the entire page text (includes sidebar, nav, page metadata) — use only when `<article>` is not present or you need thread metadata

### When to use alternatives

| Approach | When | Method |
|---|---|---|
| browser_console + innerText | Long single-post content, snapshot truncated | `document.querySelector("article").innerText.chunk(0,3000)` |
| JSON API | Full thread with multiple replies, structured data | Append `.json` to topic URL |
| Raw endpoint | First-only plain text, minimal overhead | Append `/raw/<topic_id>` to base URL |
| curl + meta description | Quick triage summary | Check `<meta name="description">` in initial HTML |

## Relationship to other skills

- [discourse-fetching-patterns](../discourse-fetching-patterns/SKILL.md) — domain-level Discourse fetch strategies, instance-by-instance behavior table, JSON/raw endpoint patterns
- [eip-spec-extraction](../eip-spec-extraction/SKILL.md) — same browser_console technique applied to EIP/ERC spec pages (uses `document.body.innerText`)
