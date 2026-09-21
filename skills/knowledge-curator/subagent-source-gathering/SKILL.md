---
name: subagent-source-gathering
description: Use delegate_task subagents for parallel multi-source research gathering during knowledge-curator and graph-walk workflows — reduces sequential fetch failures, isolates security-blocked patterns, and returns structured summaries.
---

# Subagent Source Gathering

When a concept note requires fetching from 3+ whitlist sources (Paradigm, Flashbots, ethresear.ch, EIPs, Maker whitepaper, ArXiv), **delegate the entire source-fetching job to a subagent** via `delegate_task` rather than fetching URLs one-by-one.

## When to use

- Concept needs research from 3+ separate URLs
- Some sources are likely to fail (404, Cloudflare, JS-SPA, PDF extraction)
- The "why" questions are clear enough to articulate in the delegation context
- You are working in cron mode and want to avoid security blocks on pipe-to-interpreter patterns

## Pattern

```python
delegate_task(
    goal="Research canonical sources on <concept>. I need detailed content about: <specific questions>. Fetch and extract content from the following sources: <URL1>, <URL2>, <URL3>...",
    context="This is for a personal crypto knowledge graph. We're creating a concept note <concept> at the <layer> layer. The concept is about: <definition>.",
    toolsets=["web", "terminal"]
)
```

The `web` + `terminal` toolsets give the subagent:
- The same `fetch_url.sh` script (handles Cloudflare, can use --stealth for JS-SPAs)
- curl/wget for plain-HTML sources (EIPs, ArXiv, rekt.news)
- PDF extraction capability
- Ability to try multiple URL patterns if the first fails

## What the subagent returns

A structured summary covering:
- Which URLs succeeded and what content they provided (mechanisms, design insights, trade-offs)
- Which URLs failed and why (404, Cloudflare, JS-SPA, timeout)
- A synthesis of key findings organized by mechanism/question

## What you must verify after

The subagent's summary is **self-reported, not independently verified**. After receiving it:
1. Check that claimed source URLs actually exist (open one or two to confirm)
2. Extract specific case-study numbers, dates, and quotes from the most important source(s) by fetching directly
3. If the subagent claims a PDF was extracted, verify the key claims are faithful to the source

## Pitfalls

- **Summary too thin:** If the subagent returns a shallow summary, you may still need direct fetches for specific sections. This happens when the goal/context were underspecified — be very specific about what mechanism questions the sources should answer.
- **Phantom sources:** The subagent may claim a URL worked when it actually returned a 404 page (the subagent reads the 404 HTML as if it's the article). Always spot-check the most important claim.
- **Over-delegation:** For concepts needing only 1-2 sources, direct fetch is faster and more reliable. The subagent overhead (~5 seconds setup + 30-60 seconds execution) only pays off for 3+ sources or when failures are expected.
