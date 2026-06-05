#!/bin/bash
# process_inbox.sh — pre-check / wake gate for knowledge-curator cron
#
# Pattern: Hermes "wake gate" — if last stdout line is {"wakeAgent": false},
# the LLM is SKIPPED entirely for that cron tick. Otherwise script output
# is injected as context into the agent's prompt and the agent runs normally
# (with the cron job's attached --skill knowledge-curator).
#
# Cron config (NO --no-agent flag):
#   hermes cron create "*/30 * * * *" \
#     --script process_inbox.sh \
#     --skill knowledge-curator \
#     --workdir ~/vault \
#     "Process all files in 00-Inbox/_knowledge/ following the
#      knowledge-curator skill. Summarize what was done."
#
# Symlinked from ~/.hermes/scripts/process_inbox.sh via thin wrapper.

set -euo pipefail

VAULT="${HERMES_VAULT:-/home/hermes/vault}"
INBOX="$VAULT/00-Inbox/_knowledge"

# Count visible (non-hidden) files. Filters .stfolder, .DS_Store, etc.
COUNT=$(find "$INBOX" -maxdepth 1 -type f ! -name ".*" 2>/dev/null | wc -l)

if [ "$COUNT" -eq 0 ]; then
  # Empty inbox → wake gate skips the LLM. Zero token cost.
  echo '{"wakeAgent": false}'
  exit 0
fi

# Has files — emit a brief context line that gets prepended to the agent's
# prompt. The agent's main prompt (from the cron job's positional argument)
# directs it to follow the knowledge-curator skill.
FILES=$(find "$INBOX" -maxdepth 1 -type f ! -name ".*" -printf "%f\n" 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
echo "Inbox state: $COUNT file(s) pending — $FILES"
