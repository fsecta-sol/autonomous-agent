#!/bin/bash
# graph_walker.sh — pre-check / wake gate for graph-walker cron
#
# Pattern: Hermes "wake gate" — if last stdout line is {"wakeAgent": false},
# the LLM is SKIPPED entirely for that cron tick. Otherwise script output
# is injected as context into the agent's prompt and the agent runs normally.
#
# Cron config (NO --no-agent flag):
#   hermes cron create "0 */6 * * *" \
#     --script graph_walker.sh \
#     --skill knowledge-curator \
#     --workdir ~/vault \
#     "<graph-walk prompt: identify deepest dangling ref, process it>"

set -euo pipefail

VAULT="${HERMES_VAULT:-/home/hermes/vault}"
CONCEPTS="$VAULT/03-Areas/concepts"

# Extract all [[wikilinks]] from concept notes; find which target concepts
# don't yet have files (= dangling refs).
DANGLING=$(
  grep -ohE '\[\[[^]|]+(\|[^]]+)?\]\]' "$CONCEPTS"/*.md 2>/dev/null \
    | sed -E 's/\[\[([^]|]+)(\|[^]]+)?\]\]/\1/' \
    | sort -u \
    | while read -r slug; do
        if [ -n "$slug" ] && [ ! -f "$CONCEPTS/$slug.md" ]; then
          echo "$slug"
        fi
      done
)

DANGLING_COUNT=$(echo "$DANGLING" | grep -c . || true)

if [ "$DANGLING_COUNT" -eq 0 ]; then
  # No dangling refs → wake gate skips the LLM. Zero token cost.
  echo '{"wakeAgent": false}'
  exit 0
fi

# Has dangling refs — emit context for the agent. Listing them helps the
# agent skip its own discovery step (it can directly pick from this list).
echo "Dangling concept refs detected ($DANGLING_COUNT):"
echo "$DANGLING" | head -20
