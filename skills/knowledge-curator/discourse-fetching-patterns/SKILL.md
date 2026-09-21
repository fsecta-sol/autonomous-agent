---
name: discourse-fetching-patterns
description: Domain-specific fetch patterns for Discourse-based crypto/DeFi forums — which instances serve crawler HTML vs JS-only, meta-description availability, and fallback strategies for content extraction during curation.
---

# Discourse Fetching Patterns

Many crypto/DeFi knowledge sources are on Discourse-based forums. Not all Discourse instances are equal — their initial HTML varies significantly, which affects how you fetch them.

## Instance-by-instance behavior

| Domain | Initial HTML has `<meta name="description">`? | curl fetch works? | Best approach |
|---|---|---|---|
| ethresear.ch | Yes (crawler-friendly mode) | Yes | curl or browser_navigate |
| ethereum-magicians.org | **No** (JS-rendered only) | Times out | browser_navigate |
| governance.aave.com | Sometimes (og:description) | Times out | browser_navigate |
| forum.skyeco.com | Sometimes | Times out | browser_navigate |
| forum.morpho.org | Varies | Times out | browser_navigate |
| collective.flashbots.net | Varies | Times out | browser_navigate |
| research.lido.fi | Varies | Times out | browser_navigate |
| gov.uniswap.org | Varies | Times out | browser_navigate |

## General rule

**browser_navigate works reliably across ALL Discourse instances.** When in doubt, use it — it always renders the JS and returns an accessibility-tree snapshot with post content.

## Fallback: meta-description extraction (domain-dependent)

The sed pattern `sed -n 's/.*<meta name="description" content="\([^"]*\)".*/\1/p'` extracts the page summary from `<meta name="description">` in initial HTML. This works ONLY for instances that include these tags in initial HTML (e.g., ethresear.ch). It FAILS for JS-only instances like ethereum-magicians.org.

## Faster alternative: Discourse JSON API endpoint

Every Discourse topic has a `.json` endpoint: append `.json` to any topic URL (e.g., `.../28908.json`). Returns structured JSON with:
- `title`, `excerpt` (plain text), `tags`
- Full post bodies in `post_stream.posts[].cooked`
- Post count, view count, timestamps

In cron mode, avoid pipe-to-python security triggers:
1. Fetch to temp file: `curl -sL -o /tmp/page.json 'URL.json'`
2. Read via `read_file` or a standalone extraction script

## Raw endpoint alternative

Some Discourse instances also support `/raw/<topic_id>` or `/t/slug/topic_id.raw` for plain-text post body (first post only). This is even lighter than `.json` but may not include thread metadata.
