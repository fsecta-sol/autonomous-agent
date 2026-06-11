# Current state & open issues

Live audit of system state — what works, what's broken, what's pending. Update when state changes; ground every entry in verified evidence (log line, file check, command output). Avoid speculation.

**Last snapshot**: 2026-06-11

---

## 🔴 Active bugs (verified, evidence recent)

### 1. System notif goes to group main, not thread 43
**Evidence**: Log `2026-06-10 16:43:54: Sent home-channel startup notification to telegram:-1003928226918` — no `:43` thread suffix. `.env` has `TELEGRAM_HOME_CHANNEL_THREAD_ID=43` but Hermes apparently not using it.

**Impact**: Medium — system notifications (gateway restart, shutdown) mixed into group main chat instead of dedicated thread.

**Suspected cause**: Either dotenv load doesn't propagate, or downstream code drops thread_id when formatting target. Source code verified `config.py:1296` reads the var, so it's set on `HomeChannel` object — issue must be in delivery path.

**Next step**: Add debug log to trace target.thread_id value at send time, OR experiment with setting via `hermes config set` instead of .env.

### 2. opencode-go intermittent HTTP 404
**Evidence**: 3 subagent failures on 2026-06-10 14:26 — all `HTTP 404 — Not Found | opencode` after 3 retries. Model recently switched from `qwen3.7-max` to `deepseek-v4-pro`; intermittent persists across models.

**Impact**: Medium — agent tasks can interrupt mid-flow, partial output. Especially affects subagent-spawning workflows (project-researcher, sometimes graph-walker).

**Suspected cause**: OpenCode load balancer routes random requests to website 404 handler instead of API backend. Same root cause we diagnosed in earlier session.

**Next step**: Configure fallback provider (`fallback_providers` in config.yaml) — Anthropic direct, OpenRouter, or any alt provider user has access to. Setup discussed but deferred.

### 3. Companion v1 routing bug — project queries go to wrong inbox folder
**Evidence**: `skills/companion/SKILL.md` step 5b writes web-fallback inbox to `00-Inbox/_knowledge/`. No branch for project-named queries. User design discussion (this conversation) flagged the issue; skill not yet patched.

**Impact**: High once companion is actively used — tanya "what is Monad" in #ask → web research → write to `_knowledge/` → knowledge-curator pickup → violates Hard Rule #4 (now hardened reject) → silently rejected with `[REJECT-PROJECT]`. User answer delivered but no inbox handoff actually completes for projects.

**Next step**: Patch companion skill to route project queries → `00-Inbox/_projects/`. Part of v2 design but worth doing now as v1.5 since v2 is research-blocked.

### 4. Companion not verified end-to-end in #ask thread
**Evidence**: Channel_prompts configured for thread 26 (`hermes config show` confirms). Gateway active 1d+ uptime. But NO "inbound message" entries from chat `-1003928226918:26` in `gateway.log` since setup. Bot privacy mode was `can_read_all_group_messages: false` last check.

**Impact**: Unknown — design works in theory, but functional verification missing.

**Next step**: Disable bot privacy mode via @BotFather (if not done), kick+re-add bot to group "axe cap", test "hi" in thread 26, verify inbound message + companion response.

---

## 🟡 Pending decisions

### 5. `process-inbox-projects` cron job
**State**: Skill `project-researcher` deployed & symlinked. Manual `hermes -z` trigger works (Base tested successfully). No cron job for auto-process.

**Decision needed**: Auto-process via cron (every 4-6h with wake gate script), or stay manual until pattern stabilizes?

**Last guidance**: User leaned "manual dulu sampai pattern jelas" — still valid?

### 6. Companion v2 research phase
**State**: `skills/companion/RESEARCH.md` documents roadmap (5h reading, priorities A/B/C). Research not started.

**Decision needed**: When to start, who allocates the time. Companion v1 stays as-is until research completes.

### 7. Weekly usage limit risk on opencode-go
**Evidence**: Log `2026-06-08 graph-walker failed: HTTP 429: Weekly usage limit reached. Resets in 56min` on `qwen3.7-max`. Model since switched to `deepseek-v4-pro` — unknown if shares quota.

**Decision needed**: Monitor and react when next hit, OR proactively configure fallback provider.

---

## 🟢 Resolved (verified clean)

### 8. Duplicate `base.md` cleaned
**Evidence**: `ls ~/vault/03-Areas/concepts/base.md` returns nothing on both server and laptop. Only `02-Projects/base.md` remains.

### 9. Graph-walker project-name filter working
**Evidence**: User test output: `# graph_walker: filtered out project-name dangling refs (not concepts): - base` and `{"wakeAgent": false}`. Script filter blocks project names from agent invocation.

### 10. Reciprocity / 0 dangling refs (current scale)
**Evidence**: Audit grep across `03-Areas/concepts/*.md` — 0 dangling wikilinks (post-filter). At 18 concepts scale, graph integrity solid.

### 11. Cron jobs healthy
**Evidence**: `hermes cron list` — `process-inbox-knowledge` last run 2026-06-11 18:00, status "ok". `graph-walker` last run same, status "ok".

### 12. Skill symlinks intact
**Evidence**: `ls -la ~/.hermes/skills/` shows symlinks for `companion`, `knowledge-curator`, `project-researcher` all pointing to repo.

---

## ⚠️ Unverified state

### 13. Bot privacy mode disabled
**Last known**: `can_read_all_group_messages: false`. User instructed to disable via @BotFather + kick+re-add bot. No subsequent confirmation that fix completed.

### 14. Bot token security
**State**: Bot token `7621415159:AAGCb...` was exposed in conversation log during diagnostic. User warned but no rotation reported.

---

## 🔵 Operational noise (low priority)

### 15. Telegram network errors
**Evidence**: 4-7 occurrences of `get_updates timed out`, `Bootstrap delete Webhook timeout` over 7d window. Hermes auto-retries; no functional impact observed.

---

## Recommended action order

**Validate before any new feature**:
1. Test companion in #ask thread 26 (#4) — sends "hi", verifies bot privacy mode fix (#13)
2. Re-check #1 by triggering gateway restart and observing where notif lands

**Quick fixes (parallel to research)**:
3. Patch companion v1 routing bug (#3) — small skill edit, decouples from v2 research
4. Configure fallback provider (#7) — addresses #2 intermittents too

**Background work**:
5. Companion v2 research phase per `skills/companion/RESEARCH.md` (#6)
6. Decision on `process-inbox-projects` cron (#5)

---

## Update protocol

When state changes:
- Add evidence line (log timestamp, command output, file path) — never claim without source
- Move items between categories as status changes
- Append `## Update YYYY-MM-DD` section with diff summary if multiple changes in one session
- Keep entries terse (1-2 paragraphs). Detail belongs in linked docs (SKILL.md, setup/*).

When state doesn't change:
- Don't manufacture activity here. Stale-but-accurate beats fresh-but-fabricated.