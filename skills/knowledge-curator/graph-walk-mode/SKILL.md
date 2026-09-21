---
name: graph-walk-mode
description: Dangling ref resolution mode of knowledge-curator — triggered by pre-check script rather than inbox files. Load alongside knowledge-curator when the context includes "Dangling concept refs detected" rather than inbox files.
---

# Graph Walk Mode

This skill documents the graph-walk entry point, which the knowledge-curator skill's "When to run" section omits. Use when a pre-check script lists dangling refs instead of inbox files being present.

## What's different from inbox mode

| Aspect | Inbox mode | Graph walk mode |
|---|---|---|
| Trigger | Files in `00-Inbox/_knowledge/` | Pre-check script injects "Dangling concept refs detected" |
| Input source | Inbox file content + web-fetched sources | Source notes (finder notes) + web-fetched sources |
| File movement | Move input to `_processed/YYYY-MM-DD/<base>.txt` | No-op — no inbox file to move |
| Daily log header | `## Knowledge curation — HH:MM` | `## Graph walk — HH:MM` |
| SILENT rule | Output `[SILENT]` if inbox empty | Always report (pre-check script already confirmed dangling refs exist) |

## What's the same as inbox mode

- Concept Note Schema (frontmatter, sections, diagram, examples)
- Active source gathering mandatory (whitelist/blacklist)
- Hard rules (vertical links, no projects, no trading signals)
- Reciprocity check (grep vault for inbound refs, populate reciprocals)
- Layer Taxonomy and Type Taxonomy
- Same-layer sibling scanning
- Daily log file (`01-Daily/YYYY-MM-DD.txt`)

## Layer inference from section context

When a dangling ref `[[X]]` appears in a finder note N, the section it appears in reveals X's layer relationship to N:

| Section in N | X is at __ layer vs N | Reciprocal section in X |
|---|---|---|
| `## Builds on` | Lower | `## Enables` |
| `## Enables` | Higher | `## Builds on` |
| `## Related (same layer)` | Same | `## Related (same layer)` |
| Inline body / `## Notes` | Ambiguous | No mandatory reciprocal |

Cross-reference with N's frontmatter `layer:` field to get X's precise layer. See `concept-layer-inference` skill for the full inference table.

## Typical workflow

1. Grep for `[[<slug>]]` in `03-Areas/concepts/*.md` to find all finder notes
2. Read each finder note — note which section the ref appears in
3. Use the section↔layer relationship table above to determine X's layer and type
4. Gather canonical sources (same whitelist as knowledge-curator)
5. Write concept note following Concept Note Schema with Diagram + Examples
6. Run reciprocity check: add reciprocal links to all finder notes, enrich finder notes if needed
7. Add same-layer sibling links to related existing concepts
8. Append to `01-Daily/YYYY-MM-DD.txt` under `## Graph walk`

## Dangling ref queue management

The pre-check script may report multiple dangling refs. When this happens, process only the **deepest** one (closest to cryptography layer) per run, using the section-context heuristic to resolve implied layer before consulting the explicit layer taxonomy. Tie-break by most inbound references. Leave the rest for future graph-walk runs — note them in the daily log under a "Remaining" list.
