---
name: knowledge-curator-discourse-pitfall
description: Discourse source fetch workaround for knowledge-curator skill — ethresear.ch and ethereum-magicians.org are JS-heavy SPAs but the /raw/ endpoint works.
---

# Discourse Source Fetch Pitfall

ethresear.ch and ethereum-magicians.org are Discourse-based JS-heavy SPAs. The default topic page HTML is an SPA shell — actual post content is loaded by client-side JavaScript and won't appear in `fetch_url.sh` output. Two workarounds:

**Preferred: `/raw/` endpoint.** Discourse exposes every post at `https://<forum>/raw/<topic_id>`. This returns the full post content as plain text without any JS rendering — faster and more reliable than `--stealth`. Example: `https://ethresear.ch/raw/25065` returns the complete post body. Find the topic ID from the URL slug (the numeric part before the title slug).

**Fallback: `--stealth` mode.** If the `/raw/` endpoint returns empty (rare — some private/restricted topics), use `bash ~/autonomous-agent/scripts/fetch_url.sh --stealth <URL>` (~11s, headless Chromium).
