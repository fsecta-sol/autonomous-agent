#!/bin/bash
# scan_sources.sh — pre-check / wake gate for the active curated-source scan (Mesin 1).
#
# Pattern: Hermes "wake gate" — if the LAST stdout line is {"wakeAgent": false},
# the LLM is SKIPPED for this tick. Otherwise stdout is injected as context and
# the agent runs with the attached --skill curator-triage.
#
# What it does:
#   1. Read curated feeds from scan_sources.conf
#   2. Fetch each via fetch_url.sh (scrapling; CF/Atom/RSS all fine)
#   3. Parse newest N items/source (RSS <item><link> or Atom <entry><id>)
#   4. Diff against the seen-ledger (~/.hermes/state/scan_seen.txt, server-only)
#   5. 0 new  -> {"wakeAgent": false}  (zero token)
#      N new  -> emit a context list of new items, and mark them seen (optimistic:
#                "we've shown these to the agent; don't show again")
#
# Modes:
#   scan_sources.sh            normal wake-gate run
#   scan_sources.sh --prime    mark ALL current feed items seen WITHOUT emitting
#                              (run once at setup so the first real run only
#                               catches genuinely new items, not a cold dump)
#
# Cron (NO --no-agent):
#   hermes cron create "0 6 * * *" "<triage prompt>" \
#     --script scan_sources.sh --skill curator-triage --workdir ~/vault --deliver telegram
#
# Symlinked from ~/.hermes/scripts/scan_sources.sh via thin wrapper.

set -euo pipefail

PRIME=0
[ "${1:-}" = "--prime" ] && PRIME=1

REPO="${HERMES_REPO:-$HOME/autonomous-agent}"
FETCH="$REPO/scripts/fetch_url.sh"
CONF="${SCAN_CONF:-$REPO/scripts/scan_sources.conf}"
STATE_DIR="${HERMES_STATE:-$HOME/.hermes/state}"
SEEN="$STATE_DIR/scan_seen.txt"
PER_SOURCE_MAX="${SCAN_PER_SOURCE_MAX:-5}"
TOTAL_MAX="${SCAN_TOTAL_MAX:-20}"
FETCH_TIMEOUT="${SCAN_FETCH_TIMEOUT:-25}"

mkdir -p "$STATE_DIR"
touch "$SEEN"

# Parser lives in a separate file so the feed XML can be piped on stdin
# (a heredoc `python3 - <<PY` would steal stdin for the program itself).
# Auto-detects Atom (<entry>) vs RSS (<item>); emits "url\ttitle" lines.
parse_feed() {
  python3 "$REPO/scripts/parse_feed.py" "$1"
}

emitted_urls=()
context_lines=()
count=0

# whitespace-only trim (NOT xargs — xargs does shell quote/paren parsing and
# chokes on comment lines like "# Academic (high-noise; ...)").
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

while IFS='|' read -r name url flags; do
  name="$(trim "${name:-}")"
  url="$(trim "${url:-}")"
  flags="$(trim "${flags:-}")"
  # skip comments / blanks
  case "$name" in ''|'#'*) continue ;; esac
  [ -z "$url" ] && continue

  stealth_arg=()
  [[ "$flags" == *stealth* ]] && stealth_arg=(--stealth)

  body="$(bash "$FETCH" "${stealth_arg[@]}" "$url" "$FETCH_TIMEOUT" 2>/dev/null || true)"
  [ -z "$body" ] && { echo "# scan: fetch empty: $name ($url)" >&2; continue; }

  while IFS=$'\t' read -r iurl ititle; do
    [ -z "$iurl" ] && continue
    if grep -Fxq "$iurl" "$SEEN"; then continue; fi
    emitted_urls+=("$iurl")
    [ "$PRIME" -eq 0 ] && context_lines+=("- [$name] ${ititle:-(no title)}"$'\n'"  $iurl")
    count=$((count + 1))
    [ "$PRIME" -eq 0 ] && [ "$count" -ge "$TOTAL_MAX" ] && break
  done < <(parse_feed "$PER_SOURCE_MAX" <<<"$body")

  [ "$PRIME" -eq 0 ] && [ "$count" -ge "$TOTAL_MAX" ] && break
done < "$CONF"

# --prime: just record everything seen, emit nothing actionable.
if [ "$PRIME" -eq 1 ]; then
  printf '%s\n' "${emitted_urls[@]:-}" | grep -v '^$' >> "$SEEN" || true
  sort -u "$SEEN" -o "$SEEN"
  echo "# primed: marked ${#emitted_urls[@]} current items as seen (no emit)" >&2
  echo '{"wakeAgent": false}'
  exit 0
fi

# No new items -> wake gate skips the LLM.
if [ "$count" -eq 0 ]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

# New items -> emit context for the triage agent, then mark them seen.
echo "Active scan: $count new mechanism-candidate item(s). For EACH, follow the"
echo "curator-triage skill: fetch it, decide if it illuminates a MECHANISM"
echo "reducible toward the crypto/DeFi graph; if yes drop a seed to"
echo "00-Inbox/_knowledge/, if no discard. Do NOT write concept notes yourself."
echo ""
printf '%s\n' "${context_lines[@]}"

printf '%s\n' "${emitted_urls[@]}" | grep -v '^$' >> "$SEEN" || true
sort -u "$SEEN" -o "$SEEN"