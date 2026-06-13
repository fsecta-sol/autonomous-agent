#!/bin/bash
# process_projects.sh — pre-check / wake gate for the project-researcher cron.
#
# Symmetric to process_inbox.sh, but drains 00-Inbox/_projects/ (project
# research requests) instead of _knowledge/. If the last stdout line is
# {"wakeAgent": false}, the LLM is SKIPPED (zero token). Otherwise stdout is
# injected as context and the agent runs with --skill project-researcher.
#
# Cron (NO --no-agent):
#   hermes cron create "*/30 * * * *" \
#     "Process all files in 00-Inbox/_projects/ following the project-researcher
#      skill. Summarize what was researched." \
#     --script process_projects.sh --skill project-researcher \
#     --workdir ~/vault --deliver telegram
#
# Symlinked from ~/.hermes/scripts/process_projects.sh via thin wrapper.

set -euo pipefail

VAULT="${HERMES_VAULT:-/home/hermes/vault}"
INBOX="$VAULT/00-Inbox/_projects"

# Count visible (non-hidden) files. Filters .stfolder, .DS_Store, etc.
COUNT=$(find "$INBOX" -maxdepth 1 -type f ! -name ".*" 2>/dev/null | wc -l)

if [ "$COUNT" -eq 0 ]; then
  # Empty inbox → wake gate skips the LLM. Zero token cost.
  echo '{"wakeAgent": false}'
  exit 0
fi

# Has requests — emit a brief context line prepended to the agent's prompt.
FILES=$(find "$INBOX" -maxdepth 1 -type f ! -name ".*" -printf "%f\n" 2>/dev/null | tr '\n' ', ' | sed 's/, $//')
echo "Project inbox: $COUNT request(s) pending — $FILES"