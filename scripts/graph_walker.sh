#!/bin/bash
# graph_walker.sh — preflight wrapper for graph-walker cron
#
# Runs every cron tick (default: 0 */6 * * *).
# Scans concept notes for wikilinks. If any link points to a non-existent
# concept file (dangling ref), invoke agent to walk + fill the deepest one.
# - No dangling refs → exit 0 silently. No LLM call.
# - Has dangling → invoke `hermes -z` one-shot with knowledge-curator skill.
#
# Symlinked from ~/.hermes/scripts/graph_walker.sh
# Invoked by cron job "graph-walker" with --no-agent --script.

set -euo pipefail

VAULT="${HERMES_VAULT:-/home/hermes/vault}"
CONCEPTS="$VAULT/03-Areas/concepts"
HERMES_VENV="${HERMES_VENV:-/home/hermes/.hermes/hermes-agent/venv}"

# Preflight: extract all wikilinks, find which have no corresponding file.
# - Matches [[slug]] and [[slug|alias]]
# - Strips the [[ ]] wrapper and the |alias suffix
# - For each unique slug, check if 03-Areas/concepts/<slug>.md exists
DANGLING_COUNT=$(
  grep -ohE '\[\[[^]|]+(\|[^]]+)?\]\]' "$CONCEPTS"/*.md 2>/dev/null \
    | sed -E 's/\[\[([^]|]+)(\|[^]]+)?\]\]/\1/' \
    | sort -u \
    | while read -r slug; do
        if [ -n "$slug" ] && [ ! -f "$CONCEPTS/$slug.md" ]; then
          echo "$slug"
        fi
      done \
    | wc -l
)

if [ "$DANGLING_COUNT" -eq 0 ]; then
  # All wikilinks resolve to existing files. No graph filling needed.
  exit 0
fi

# Dangling refs exist → invoke agent for graph walking.
# shellcheck disable=SC1091
source "$HERMES_VENV/bin/activate"
cd "$VAULT"

PROMPT=$(cat <<'EOF'
You are running a graph-walk task. Step 1: list all wikilinks [[...]] across 03-Areas/concepts/*.md. Step 2: identify dangling refs — wikilinks pointing to concepts that do not yet have files. Step 3: for each dangling, estimate depth (closeness to cryptography layer based on context in source notes). Step 4: pick the deepest dangling; tie-break by most-referenced. Step 5: process the picked concept by following the knowledge-curator skill workflow as if it were dropped as input — fetch canonical sources, write full concept note with Diagram + Real-world examples sections, run reciprocity check, populate inbound link reciprocals. Step 6: append to today's daily log under '## Graph walk — <HH:MM>' with which concept was filled, depth estimate, and any [NEEDS-*] flags raised.
EOF
)

exec hermes -z "$PROMPT" --skills knowledge-curator --yolo
