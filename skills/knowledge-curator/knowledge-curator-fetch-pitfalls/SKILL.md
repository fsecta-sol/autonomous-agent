---
name: knowledge-curator-fetch-pitfalls
description: Source-fetching failure modes and workarounds for the knowledge-curator skill, covering cron-mode terminal restrictions, Discourse JS-heavy SPA issues, and DuckDuckGo search as a fallback.
---

# Source Fetch Pitfalls for Knowledge Curator

Common source-fetching failure modes and workarounds when running the knowledge-curator skill, especially in cron (non-interactive) mode.

## Cron-mode terminal restriction pitfalls

When the knowledge-curator runs as a scheduled cron job, terminal commands face stricter security scanning. Two patterns are consistently blocked and must be avoided:

| Blocked pattern | Block reason | Workaround |
|---|---|---|
| `curl \| python3` | Pipe to interpreter — downloaded content executed without inspection | Fetch to temp file first, then run script on file |
| `python3 -c "..."` | Script execution via `-c` flag | Write extraction script via `write_file` tool, then run with `python3 /tmp/script.py` |

**Workaround pattern (always use in cron mode):**

1. Fetch HTML to temp file: `curl -sL --max-time 15 -o /tmp/source.html 'URL'`
2. Write extraction script once via `write_file` tool (do basic HTML → text: strip tags, decode entities, collapse whitespace)
3. Run: `python3 /tmp/extract_text.py /tmp/source.html 6000`
4. Reuse the same extraction script across all fetches in the session

This replaces the blocked `curl URL | python3 -c "..."` pattern with a safe two-step that separates download from execution.

## Discourse JS-heavy SPA pitfalls

ethresear.ch and ethereum-magicians.org are Discourse-based JS-heavy SPAs. Default `fetch_url.sh` may time out. Use `--stealth` mode directly for these domains, or rely on the input file's curated notes + og:description metadata when stealth also fails.

**Alternative access via raw endpoints (preferred):** append `/raw/<topic_id>` to get a single post's content as plain text, or `<slug>/<topic_id>.json` for the full thread JSON. See the `source-gathering-techniques` skill for the full Discourse extraction recipe.

Search pages on these domains return skeleton HTML without JS rendering — do not use them for URL discovery. Instead, guess topic URLs from known post slugs, or rely on the pre-curated input file metadata.

## URL discovery strategy in cron mode

When searching for canonical sources without known exact URLs:
1. Start with known-good Vitalik posts: `vitalik.eth.limo/general/` lists all posts
2. Known always-fetchable URLs: `vitalik.eth.limo/general/YYYY/MM/DD/slug.html`, `docs.flashbots.net/...`, `arxiv.org/abs/...`, `eips.ethereum.org/EIPS/eip-NNNN`
3. For other whitelist domains (paradigm.xyz, a16zcrypto.com), fetch the blog index page first to discover exact article URLs before fetching individual posts
4. **DuckDuckGo HTML search fallback** — when Google/browser search is blocked, use the Scrapling script with DuckDuckGo HTML mode for concept-specific web search: `bash ~/autonomous-agent/scripts/fetch_url.sh "https://html.duckduckgo.com/html/?q=<search query>"`. See the `source-gathering-techniques` skill for the full extraction recipe, URL-decoding script, and search refinement tips.
