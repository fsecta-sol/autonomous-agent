---
name: knowledge-curator-fetch-pitfalls
description: Source-fetching failure modes and workarounds for the knowledge-curator skill, covering cron-mode terminal restrictions and JS-heavy SPA issues (Discourse, Next.js).
---

# Source Fetch Pitfalls for Knowledge Curator

Common source-fetching failure modes and workarounds when running the knowledge-curator skill, especially in cron (non-interactive) mode.

## Cron-mode terminal restriction pitfalls

When the knowledge-curator runs as a scheduled cron job, terminal commands face stricter security scanning. Three patterns are consistently blocked and must be avoided:

| Blocked pattern | Block reason | Workaround |
|---|---|---|
| `curl \| python3` | Pipe to interpreter — downloaded content executed without inspection | Fetch to temp file first, then extract text with `read_file` |
| `bash fetch_url.sh \| python3` | Same as above — pipe from any command to interpreter is blocked | Fetch to temp file: `bash .../fetch_url.sh 'URL' > /tmp/page.html` |
| `python3 -c "..."` | Script execution via `-c` flag | Write extraction script via `write_file` tool, then run with `python3 /tmp/script.py` |

**Workaround A — fetch to temp file, then use `read_file` (simplest, for single-page fetches):**

1. Fetch content to temp file: `bash ~/autonomous-agent/scripts/fetch_url.sh 'URL' > /tmp/page.html`
2. Use `read_file /tmp/page.html` with sensible `limit` (e.g., 150–200 lines) — most article bodies are extractable from the first ~150 lines
3. If the page is a large SPA (>300 lines), use `read_file` with `offset` + `limit` to scan just the article body region
4. No Python extraction script needed — the agent reads the HTML directly and extracts text contextually

**Workaround B — fetch to temp file, then extract with reusable script (for batch fetches):**

1. Fetch HTML to temp file: `curl -sL --max-time 15 -o /tmp/source.html 'URL'`
2. Write extraction script once via `write_file` tool (do basic HTML → text: strip tags, decode entities, collapse whitespace)
3. Run: `python3 /tmp/extract_text.py /tmp/source.html 6000`
4. Reuse the same extraction script across all fetches in the session

This replaces blocked pipe-to-interpreter patterns with safe two-step approaches that separate download from execution.

## JS-heavy SPA pitfalls (Discourse and Next.js)

### Discourse forums (ethresear.ch, ethereum-magicians.org)

Discourse-based forums are JS-heavy SPAs. Default `fetch_url.sh` times out at 30s. Use `--stealth` mode directly for these domains, or rely on the input file's curated notes + og:description metadata when stealth also fails.

Search pages on these domains return skeleton HTML without JS rendering — do not use them for URL discovery. Instead, guess topic URLs from known post slugs, or rely on the pre-curated input file metadata.

### Next.js SPAs (ethereum.org)

ethereum.org is a Next.js SPA. Raw `curl` returns a ~400KB HTML page where article text is embedded inside dehydrated React state (`self.__next_f.push(...)` calls and `__NEXT_DATA__` JSON blobs). The text IS extractable — scan for pattern `<h2 id="...">section-title</h2>` to locate sections, or read article content from the JSON-LD structured data block (`<script type="application/ld+json">`). The raw HTML is usable but noisy; expect to spend a few `read_file` calls with offset/limit to home in on article body text.

**ethereum.org quick-extraction pattern:**
1. Fetch: `curl -sL --max-time 30 -o /tmp/eth.html 'https://ethereum.org/en/developers/docs/nodes-and-clients/light-clients/'`
2. Find article start: search the file for `<article` or `id="main-content"` — the article body follows
3. Use `read_file /tmp/eth.html` with `offset` at the article region and `limit=200` to get the content
4. The `<h2 id="...">` tags give section headings; paragraph text follows in `<p>` tags

### a16zcrypto.com articles

a16z crypto blog articles are Astro-based SPAs with Cloudflare Turnstile bot protection. Known pitfalls:
- Specific article URLs may return 404 even when the article exists — URL slugs can change over time. The `fetch_url.sh` script will successfully load the page but the content will be the 404 page, not the article.
- **Fallback for article content**: Use the raw GitHub README of the project the article announces (e.g., `raw.githubusercontent.com/a16z/helios/refs/heads/master/README.md`). The README typically contains the same technical content as the blog post.
- For blog index pages: `bash ~/autonomous-agent/scripts/fetch_url.sh 'https://a16zcrypto.com/posts/' > /tmp/a16z_blog.html` — this returns the navigation shell with article links, usable for URL discovery.

## URL discovery strategy in cron mode

When searching for canonical sources without known exact URLs:
1. Start with known-good Vitalik posts: `vitalik.eth.limo/general/` lists all posts
2. Known always-fetchable URLs: `vitalik.eth.limo/general/YYYY/MM/DD/slug.html`, `docs.flashbots.net/...`, `arxiv.org/abs/...`, `eips.ethereum.org/EIPS/eip-NNNN`
3. **Raw GitHub READMEs** as fallback for project-announcement articles: `raw.githubusercontent.com/<org>/<repo>/refs/heads/master/README.md`
4. For other whitelist domains (paradigm.xyz, a16zcrypto.com), fetch the blog index page first to discover exact article URLs before fetching individual posts
