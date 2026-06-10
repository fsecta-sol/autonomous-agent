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

# Project-name blacklist — mirror knowledge-curator SKILL.md Hard Rule #4.
# Dangling refs matching these names are projects, NOT concepts, and should
# be routed to project-researcher via 00-Inbox/_projects/ instead. We surface
# them to stderr so user can manually drop a research request.
# IMPORTANT: keep this list in sync with skills/knowledge-curator/SKILL.md
PROJECT_NAMES_REGEX='^(bitcoin|ethereum|solana|avalanche|polygon|base|arbitrum|optimism|monad|sui|aptos|near|tempo|unichain|scroll|zksync|starknet|linea|mantle|blast|world-chain|uniswap|aerodrome|curve|balancer|pancakeswap|sushiswap|raydium|orca|aave|compound|morpho|spark|kamino|maker|frax|circle|tether|lido|rocket-pool|eigenlayer|etherfi|kelp|chainlink|pyth|redstone|wormhole|layerzero|hyperlane|axelar|metamask|coinbase|flashbots|mev-boost|suave|shutter)$'

# Extract all [[wikilinks]] from concept notes; find which target concepts
# don't yet have files (= dangling refs). Project-named refs are filtered
# out before passing to the agent.
ALL_DANGLING=$(
  grep -ohE '\[\[[^]|]+(\|[^]]+)?\]\]' "$CONCEPTS"/*.md 2>/dev/null \
    | sed -E 's/\[\[([^]|]+)(\|[^]]+)?\]\]/\1/' \
    | sort -u \
    | while read -r slug; do
        if [ -n "$slug" ] && [ ! -f "$CONCEPTS/$slug.md" ]; then
          echo "$slug"
        fi
      done
)

# Partition into concept-candidates (passed to agent) and project-routes
# (logged for user awareness, NOT passed to graph walk).
DANGLING=$(echo "$ALL_DANGLING" | grep -vE "$PROJECT_NAMES_REGEX" || true)
PROJECT_ROUTES=$(echo "$ALL_DANGLING" | grep -E "$PROJECT_NAMES_REGEX" || true)

# Surface filtered project refs to stderr (visible in cron output / logs)
if [ -n "$PROJECT_ROUTES" ]; then
    {
        echo ""
        echo "# graph_walker: filtered out project-name dangling refs (not concepts):"
        echo "$PROJECT_ROUTES" | sed 's/^/#   - /'
        echo "# To research these as projects, drop input to 00-Inbox/_projects/<slug>.md"
        echo "# and trigger project-researcher skill."
        echo ""
    } >&2
fi

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
