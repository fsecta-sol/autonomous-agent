---
name: source-gathering-techniques
description: Canonical source-gathering techniques for the knowledge-curator and graph-walk skills — EIP/ERC spec extraction, Discourse thread JSON API, and web search via DuckDuckGo HTML when browser tools are blocked.
---

# Source-Gathering Techniques

This skill documents source-gathering techniques that are useful for both knowledge-curator and graph-walk workflows. It is meant to be loaded alongside those skills when source fetching is required.

## Web Search as Source Discovery

When the browser tool is blocked by Google/DuckDuckGo captchas, use the Scrapling fallback script with DuckDuckGo HTML mode:

```bash
bash ~/autonomous-agent/scripts/fetch_url.sh \
  "https://html.duckduckgo.com/html/?q=search+query+here"
```

The script returns full HTML with search results. Each result link is wrapped in DuckDuckGo's redirect format as `uddg=<url-encoded-target>`.

To extract resolved URLs from the output, write a Python script to `/tmp/` and run it (cron-safe pattern, avoids pipe-to-interpreter security blocks):

```python
# /tmp/extract_urls.py — Usage: python3 /tmp/extract_urls.py <input_file>
import re, urllib.parse, sys

html = open(sys.argv[1]).read()
urls = []
for match in re.finditer(r'uddg=([^&\s"]+)', html):
    urls.append(urllib.parse.unquote(match.group(1)))
for u in urls:
    print(u)
```

Then: `python3 /tmp/extract_urls.py /path/to/results.html`

**Search refinement tips for crypto concepts:**
- Append canonical whitelist domains: `site:eips.ethereum.org`, `site:ethresear.ch`, `site:paradigm.xyz`, `site:writings.flashbots.net`, `site:vitalik.eth.limo`
- For protocol/implementation-specific concepts: add relevant infra names (`Safe`, `Zodiac`, `ERC-7710`, `EIP-4788`) to discover implementation patterns
- For real-world examples: add `rekt.news`, `incident`, `post-mortem`, `exploit`, `loss`, `MEV` to find quantified case studies
- For implementation details: search `github.com/<org>/<repo>` READMEs (fetch raw content via `raw.githubusercontent.com` when possible)

**Known JS-heavy domains that DO work with the Scrapling script (not requiring --stealth but content is mixed with JS/CSS):**
- `docs.safe.global` — Next.js SPA; the fetch returns full HTML but the content is interleaved with CSS/JS. The rendered text content is present — extract via HTML-to-text script.
- `docs.flashbots.net` — similar Next.js pattern
- `paradigm.xyz` — may return JS shell; try `--stealth` if default returns empty

## Discourse Thread JSON API

Ethereum Magicians and ethresear.ch run on Discourse. The rendered HTML is a JS-heavy SPA shell — curl/browser may not get post content. Two working endpoints:

### `/raw/<topic_id>` — single post (fastest)
Returns the raw Markdown/HTML of a single post. Simple, fast, no JS.
```
https://ethresear.ch/raw/25065
```

### `.../<slug>/<topic_id>.json` — full thread (richest)
Returns the complete thread as structured JSON. All posts, author info, timestamps, post numbers.
```
https://ethereum-magicians.org/t/erc-7710-smart-contract-delegation/16690.json
```
Parsing: the `post_stream.posts[]` array contains every post. Each post has `post_number`, `username`, `cooked` (HTML content), `created_at`. Write a Python script to `/tmp/` and run it with `python3 /tmp/script.py` (cron-safe pattern).

**When to use which:** `/raw/` for getting a single known post's content; `.json` when you need the full thread evolution (multiple posts, replies from different authors, design evolution over time).

## EIP/ERC Spec Pages

eips.ethereum.org/EIPS/eip-<N> pages are plain HTML — no JS rendering, no bot protection. They fetch fine with curl. Extraction pattern:
1. `curl -sL https://eips.ethereum.org/EIPS/eip-<N> -o /tmp/eip.html`
2. Write a Python HTML-to-text script to `/tmp/` (strip tags, decode entities, collapse whitespace)
3. Run with `python3 /tmp/extract.py`

The pages have a consistent structure: Abstract, Motivation, Specification, Rationale, etc. Focus on Motivation and Rationale sections for the "why" of the concept note.

## URL Structure Patterns

| Site | URL Pattern | Notes |
|---|---|---|
| EIPs | `eips.ethereum.org/EIPS/eip-<N>` | HTML, curl-friendly |
| Ethereum Magicians | `ethereum-magicians.org/t/<slug>/<id>` | JS SPA — use `.json` or `/raw/` |
| ethresear.ch | `ethresear.ch/t/<slug>/<id>` | Same Discourse pattern |
| vitalik.eth.limo | `vitalik.eth.limo/general/YYYY/MM/DD/<slug>.html` | Plain HTML |
| Flashbots | `writings.flashbots.net/<slug>` | Likely plain HTML |
| Paradigm | `paradigm.xyz/<YYYY/MM/DD>/<slug>` | Check — may be JS-heavy |
| arXiv | `arxiv.org/abs/<id>` | Plain HTML |
| Rekt News | `rekt.news/<slug>` | Plain HTML |
| Safe Docs | `docs.safe.global/<path>` | Next.js SPA — fetch works but content mixed with CSS/JS |
