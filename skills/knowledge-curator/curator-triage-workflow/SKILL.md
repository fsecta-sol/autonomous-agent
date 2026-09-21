---
name: curator-triage-workflow
description: Practical workflow extensions for the curator-triage skill — two-pass batching for large scan runs, pre-run state checks (inbox, concept map, daily log format), and connects-link verification. Load as a companion to curator-triage when the scan list has 15+ items or you need to avoid seed collisions.
---

# Curator Triage Workflow (companion to curator-triage)

**Load this skill alongside curator-triage** when running an active-scan triage. It adds three pre-checks and a two-pass triage pattern that the base skill assumes but doesn't spell out. If the curator-triage skill's `## Workflow per run` section already includes these, this companion is redundant — skip it.

## Pre-checks (run once before triaging)

Always run these three checks before fetching any items. They batch into one turn and prevent the most common quality errors.

### 1. Inbox state check
List `00-Inbox/_knowledge/` to see which concept-slugs are already queued. Then when you write a seed, you know whether you're creating new or appending to existing.

**Why:** The curator-triage skill says to "append instead of overwrite" if a seed exists — but you can't do that if you don't know what's there. One search call at the start prevents slug collisions.

### 2. Existing concepts map
List `03-Areas/concepts/` to collect all existing concept slugs. Use the results to pick precise `connects` targets in your seeds (e.g. `[[mev]]`, `[[pbs]]`, `[[tee]]`, `[[proof-of-stake]]`).

**Why:** The base skill says "suggest connects links to concepts you know exist" — searching the directory turns "guess" into "verified". A wrong guess is fine, but a verified link saves the curator a round-trip.

### 3. Daily log format detection
The vault may use `.md` or `.txt` for daily logs. Search `01-Daily/` for the target date — prefer whichever extension exists. If neither exists, create `YYYY-MM-DD.md` (newer convention). Match the existing format.

**Why:** The base skill hardcodes `.txt` in its workflow step 3, but the actual vault (at time of writing) uses `.md` for current dates. Checking first prevents writing to the wrong file.

## Two-pass triage for large batches (15+ items)

When the scan list is large, sequential deep-fetch of every item wastes resources. Use a two-pass approach:

### Pass 1: Rapid title pre-sort
Scan every item's title and source label. Apply the mechanism-vs-noise test by title alone. Categories:

- **Clear KEEP** — titles with mechanism keywords (incentive-compatibility, state-minimization, invariant, miscompilation, gas-sponsorship, oracle-design, etc.)
- **Clear DISCARD** — newsletters ("MEV Letter #N"), meeting minutes (ACDC, ACDT, PQ-Interop), procedural governance (supply-cap adjustments, routine parameter changes), macro/political posts, broad surveys/surveys
- **Borderline** — needs deep-fetch to decide

Document your initial call per item. You'll log your final decision after Pass 2.

### Pass 2: Deep fetch of KEEP candidates only
For the Pass-1 KEEPs (and borderlines you're genuinely uncertain about), fetch using the appropriate method per curator-triage's fetching pitfalls. Batch independent fetches (multiple `browser_navigate` calls in one turn).

**After deep-fetch**, apply the full triage test. Some Pass-1 KEEPs will flip to DISCARD when full content reveals the item is broader or shallower than the title suggested. Log why.

## Connects link verification

When writing seeds, for each `connects` entry:

1. Cross-reference against the concept map from pre-check #2.
2. Favor links that are **actually present** in `03-Areas/concepts/`.
3. If you need to reference a concept that doesn't exist yet, use a `[[concept-slug]]` anyway — the curator will create it during reciprocity. But prefer existing notes.

This avoids dead links in the seed and gives the curator concrete reciprocity targets to wire up.

## Seed quality checklist

Before finishing a seed, verify:
- [ ] **Slug is the mechanism**, not the article title or project name
- [ ] **Existing connections verified** against `03-Areas/concepts/`
- [ ] **Not duplicating** an existing seed in `00-Inbox/_knowledge/`
- [ ] **Daily log format** matches the existing file (`.md` vs `.txt`)
- [ ] **`why-to-nail`** captures the "why" (mechanism angle), not the "what" (summary)

## Pitfall: curator-triage in non-default profile

The `curator-triage` SKILL.md may live in a different Hermes profile (e.g., `veil`) than the one you're running in. If `skill_manage(action='patch')` fails with "not found in active profile", the skill belongs to another profile. In this mode (skill-review), you cannot modify it with skill_manage. Workarounds:

- Focus on saving improvements to **this companion skill** and memory instead.
- The background curator can consolidate companion-into-base later if the profile barrier is resolved.

## Relationship to other skills

- [curator-triage](../curator-triage/SKILL.md) — base triage skill with mechanism test, fetching pitfalls, seed schema, and anti-patterns.
- [knowledge-curator-triage-inputs](../knowledge-curator-triage-inputs/SKILL.md) — validates and processes seeds after triage.
- [knowledge-curator-fetch-pitfalls](../knowledge-curator-fetch-pitfalls/SKILL.md) — additional fetch failure patterns.
