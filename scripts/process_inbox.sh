#!/bin/bash
# process_inbox.sh — preflight wrapper for knowledge-curator cron
#
# Runs every cron tick. Checks vault/00-Inbox/_knowledge/ for visible files.
# - Empty inbox → exit 0 silently. No LLM call, zero token cost.
# - Files present → invoke `hermes -z` one-shot with knowledge-curator skill.
#
# Symlinked from ~/.hermes/scripts/process_inbox.sh
# Invoked by cron job "process-inbox-knowledge" with --no-agent --script.

set -euo pipefail

VAULT="${HERMES_VAULT:-/home/hermes/vault}"
INBOX="$VAULT/00-Inbox/_knowledge"
HERMES_VENV="${HERMES_VENV:-/home/hermes/.hermes/hermes-agent/venv}"

# Preflight: count visible (non-hidden) files in inbox.
# Filters out .stfolder, .stignore, .DS_Store, etc.
COUNT=$(find "$INBOX" -maxdepth 1 -type f ! -name ".*" 2>/dev/null | wc -l)

if [ "$COUNT" -eq 0 ]; then
  # Silent exit — no LLM call, no delivery, no log entry beyond cron tick.
  exit 0
fi

# Inbox has visible files → invoke agent one-shot.
# shellcheck disable=SC1091
source "$HERMES_VENV/bin/activate"
cd "$VAULT"

exec hermes -z "Drain 00-Inbox/_knowledge/. Follow the knowledge-curator skill exactly. After done, summarize counts (N inputs processed, M new concepts, K enriched) and list any [NEEDS-*] flags raised." \
  --skills knowledge-curator \
  --yolo
