# Production example: agent-interoperability (2026-06-27)

## Context
`verifiable-agent-computation.md` (layer: platforms) had `[[agent-interoperability]]` in its `## Enables` section. Graph-walk created `agent-interoperability.md` at `layer: platforms`.

## The mistake
Both notes are at `platforms` layer. Per the misclassification table, same-layer links belong in `## Related`, not `## Enables` or `## Builds on`. The finder's placement was wrong because the author guessed agent-interoperability was a higher-layer (applications) concept.

## What should have happened
1. Load `graph-walk-finder-misclassification` before reciprocity step
2. Spot that VAC (platforms) → agent-interoperability (platforms) is same-layer
3. Move the link in VAC from `## Enables` to `## Related (same layer)` with updated reasoning
4. Then add reciprocal to agent-interoperability's `## Related` section (not `## Builds on`)

## Why it was easy to miss
The reciprocity instructions say "classify which section the link appears in" — this reads like passive observation. The missing mental step is validation: confirm the section is correct given BOTH layers, not just record where the link happens to be.
