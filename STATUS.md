# Current state & open issues

Live audit of system state — what works, what's broken, what's pending. Update when state changes; ground every entry in verified evidence (log line, file check, command output). Avoid speculation.

**Last snapshot**: 2026-06-24

---

## 🔴 Active bugs (verified, evidence recent)

### 1. opencode-go Broken pipe — graph-walker & scan-curated-sources failing ⚠️ NEW CRITICAL
**Evidence**: Both cron jobs errored today (2026-06-24) with `RuntimeError: [Errno 32] Broken pipe` after 3 retries from `opencode-go` provider (`deepseek-v4-flash`). 132 total Broken pipe occurrences in `agent.log`, 29 today. `graph-walker` at 06:06 WIB (3 retries, ~12,600 tokens burned), `scan-curated-sources` at 06:10 WIB (3 retries, ~6,647 tokens burned). Last successful graph-walker partial: 2026-06-21 (also failed that day). Last fully clean run unclear.

**Impact**: **High** — 2/4 cron jobs cannot do LLM work. `process-inbox-*` still appear `ok` only because inboxes are empty (wake-gate skips LLM). If inboxes had items, they'd likely fail too. System is effectively degraded to idle-only.

**Context**: This supersedes the old HTTP 404 intermittent bug (STATUS.md #2 from 2026-06-13). Model has switched from `deepseek-v4-pro` → `deepseek-v4-flash`. `opencode.ai/zen/go/v1/models` returns HTTP 200 from server right now (reachable at check time — intermittent). No fallback provider configured.

**Next step**: Configure fallback provider (`fallback_providers` in `~/.hermes/config.yaml`). If no alt provider available, diagnose opencode-go Broken pipe root cause (load balancer issue? connection pool exhaustion?).

### 2. Telegram API connectivity degraded — sustained unreachability ⚠️ ESCALATED from low-priority noise
**Evidence**: `gateway.log` 2026-06-24 08:52–09:00 WIB: `Primary api.telegram.org connection failed` + `Fallback IP 149.154.166.110 failed` repeated 10+ times in succession (~8 min sustained outage). Gateway eventually marked `Primary api.telegram.org path unreachable; using sticky fallback IP`. Also `Timed out` errors with 4/10 reconnect attempts. `curl https://api.telegram.org` returns HTTP 302 from server now (intermittent — was failing during the logged window).

**Impact**: **High** while active — cron delivery to Telegram unreliable, companion/ask thread non-functional, #inbox save non-functional. Gateway auto-recovers but gaps mean messages may be lost.

**Suspected cause**: Server outbound connectivity to Telegram infra degraded (not a Hermes bug). Either ISP-level block or Telegram server-side routing.

**Next step**: Check if this is server-network-wide (`ping api.telegram.org`, `mtr api.telegram.org`). If persistent, consider Telegram delivery workaround (email digest?).

### 3. System notif goes to group main, not thread 43
**Evidence**: Log `2026-06-10 16:43:54: Sent home-channel startup notification to telegram:-1003928226918` — no `:43` thread suffix. `.env` has `TELEGRAM_HOME_CHANNEL_THREAD_ID=43` but Hermes apparently not using it.

**Impact**: Medium — system notifications (gateway restart, shutdown) mixed into group main chat instead of dedicated thread.

**Suspected cause**: Either dotenv load doesn't propagate, or downstream code drops thread_id when formatting target. Source code verified `config.py:1296` reads the var, so it's set on `HomeChannel` object — issue must be in delivery path.

**Next step**: Add debug log to trace target.thread_id value at send time, OR experiment with setting via `hermes config set` instead of .env.

### 4. Companion v1 routing bug — project queries go to wrong inbox folder
**Evidence**: `skills/companion/SKILL.md` step 5b writes web-fallback inbox to `00-Inbox/_knowledge/`. No branch for project-named queries. User design discussion flagged the issue; skill not yet patched.

**Impact**: High once companion is actively used — tanya "what is Monad" in #ask → web research → write to `_knowledge/` → knowledge-curator pickup → violates Hard Rule #4 (now hardened reject) → silently rejected with `[REJECT-PROJECT]`. User answer delivered but no inbox handoff actually completes for projects.

**Next step**: Patch companion skill to route project queries → `00-Inbox/_projects/`. Part of v2 design but worth doing now as v1.5 since v2 is research-blocked.

### 5. Companion not verified end-to-end in #ask thread
**Evidence**: Channel_prompts configured for thread 26. Gateway active 6d+ uptime (systemd user unit). But NO "inbound message" entries from chat `-1003928226918:26` in `gateway.log` since setup. Bot privacy mode was `can_read_all_group_messages: false` last check. Telegram API connectivity issues (#2 above) make this unverifiable right now.

**Impact**: Unknown — design works in theory, but functional verification missing. Blocked by Telegram connectivity.

**Next step**: Resolve Telegram connectivity first (#2), then disable bot privacy mode via @BotFather, kick+re-add bot to group "axe cap", test "hi" in thread 26.

---

## 🟡 Pending decisions

### 6. Fallback provider still not configured ⚠️ ESCALATED
**Evidence**: `hermes config show` confirms no Anthropic, OpenRouter, or other provider configured. The Broken pipe errors (#1) are all hitting opencode-go with zero fallback. This was the recommended fix in the 2026-06-13 snapshot (#7) and was deferred.

**Decision needed**: Configure NOW — this is blocking 2/4 cron jobs. Options: Anthropic direct API key, OpenRouter, or any alt provider.

### 7. Companion v2 research phase
**State**: `skills/companion/RESEARCH.md` documents roadmap (5h reading, priorities A/B/C). Research not started.

**Decision needed**: When to start, who allocates the time. Companion v1 stays as-is until research completes. v1 functional verification blocked by #2 and #5 anyway.

### 8. Weekly usage limit risk on opencode-go
**Evidence**: Log `2026-06-08 graph-walker failed: HTTP 429: Weekly usage limit reached` on `qwen3.7-max`. Model since switched to `deepseek-v4-pro` → now `deepseek-v4-flash`. Unknown if quota shared across models or if Broken pipe (#1) is related to quota exhaustion.

**Decision needed**: Monitor and react when next hit, OR proactively configure fallback provider (same fix as #6).

---

## 🟢 Resolved (verified clean)

### 9. Graph-walker project-name filter working
**Evidence**: Current `graph_walker.sh` output: "filtered out project-name dangling refs (not concepts)". Script filter blocks project names from agent invocation.

### 10. Skill symlinks intact
**Evidence**: `ls -la ~/.hermes/skills/` (2026-06-24): symlinks for `companion`, `knowledge-curator`, `project-researcher`, `curator-triage` all pointing to repo. Also added `curator-triage` symlink (was missing in prior snapshot listing).

### 11. Hermes gateway running — 6d+ uptime
**Evidence**: `systemctl --user status hermes-gateway.service` (2026-06-24): active since Wed 2026-06-17, PID 742032, 409M memory, systemd linger enabled (survives logout). No system-level `hermes.service` file (never was; scheduler runs in-gateway). Additional `veil` profile gateway also running (PID 747289, since Jun 18).

### 12. Graph growth: 43 → ~93 concepts
**Evidence**: `ls ~/vault/03-Areas/concepts/*.md | wc -l` ≈ 93 concepts (2026-06-24). 5 projects in `02-Projects/` (bitcoin, ethereum, solana, base, lapis). Both inboxes (`_knowledge/`, `_projects/`) empty — no backlog.

### 13. Daily logs continuous
**Evidence**: `ls ~/vault/01-Daily/` shows daily `.txt` from 2026-06-15 through 2026-06-24 (10 consecutive days). Today's log shows graph-walker created `ethereum-scaling` + reciprocity before pipe broke.

---

## ⚠️ Unverified state

### 14. Bot privacy mode disabled
**Last known**: `can_read_all_group_messages: false`. User instructed to disable via @BotFather + kick+re-add bot. No subsequent confirmation that fix completed.

### 15. Bot token security
**State**: Bot token `7621415159:AAGCb...` was exposed in conversation log during diagnostic. User warned but no rotation reported.

---

## 🔵 Operational notes (low priority)

### 16. Dangling refs — 6 remaining
**Evidence**: `graph_walker.sh` output (2026-06-24): `agent-interoperability`, `eip-2771`, `eip-7579`, `erc-8226`, `treasury-subaccounts`, `trustless-dapps`. Most are EIP numbers (not mechanism nouns) or applications-layer concepts. graph-walker can't process these until Broken pipe (#1) resolved.

### 17. Model changed: deepseek-v4-pro → deepseek-v4-flash
**Evidence**: `hermes config show` (2026-06-24): `model: {'default': 'deepseek-v4-flash', 'provider': 'opencode-go'}`. Previous snapshot had `deepseek-v4-pro`.

### 18. Veil profile running as second gateway
**Evidence**: `systemctl --user status` shows veil profile gateway (PID 747289, since Jun 18) + `veil-tokenscan` + `veil-api` processes. Scripts `veil_discover.sh` and `veil_tick.sh` in `~/.hermes/scripts/`. Purpose/status unknown from this audit.

### 19. Telegram network errors (background noise)
**Evidence**: Persistent `get_updates timed out`, `Bootstrap delete Webhook timeout` in logs. Escalated to active bug #2 when sustained; otherwise Hermes auto-retries. Functional impact depends on duration.

---

## 🟢 Resolved (2026-07-15)

### 20. Vault-first mandate now applies to every chat channel, not just #ask
**Evidence**: Deployed and verified live on server (see [setup/vault-first-mandate.md](setup/vault-first-mandate.md)). `terminal.cwd` set to `/home/hermes/vault` in default profile `config.yaml`; new `vault/AGENTS.md` carries the baseline "check vault, cite `[[wikilink]]`, no vague authority" mandate; `hermes prompt-size --platform telegram|cli --json` confirms ~1785 bytes injected under `"context (AGENTS.md/cwd files)"` for both platforms (offline check, no API call). Dashboard converted from an unsupervised manual process (`pts/1`, running since 2026-07-02, cwd=`~`) to `hermes-dashboard.service` (systemd, `Restart=always`, `WorkingDirectory=/home/hermes/vault`) — confirmed cwd via `/proc/<pid>/cwd` after restart. Gateway restarted to pick up the new `terminal.cwd`. `veil` profile intentionally excluded (separate scope — signal/alpha scanning, not Q&A) per user decision.

**Follow-up noted, not yet actioned**: `hermes-gateway.service` is `disabled` in systemd (won't auto-start on full reboot, only survives via `Restart=always` while already running) — pre-existing, unrelated to this change.

---

## Recommended action order

**Immediate (blocking)**:
1. Configure fallback provider (#6) — unblocks graph-walker + scan-curated-sources (#1)
2. Diagnose opencode-go Broken pipe root cause (#1) — server-side or provider-side?

**Validate before any new feature**:
3. Fix Telegram API connectivity (#2) — check server outbound to api.telegram.org
4. Test companion in #ask thread 26 (#5) — blocked by #2
5. Re-check thread routing (#3) by triggering gateway restart and observing where notif lands

**Quick fixes (parallel to research)**:
6. Patch companion v1 routing bug (#4) — small skill edit, decouples from v2 research

**Background work**:
7. Companion v2 research phase per `skills/companion/RESEARCH.md` (#7)
8. Bot token rotation (#15)

---

## Update 2026-06-24

Snapshot after 11 days since last audit. Diff:

- **🔴 New critical bug: opencode-go Broken pipe** (#1). 132 occurrences total, both `graph-walker` and `scan-curated-sources` errored today (`RuntimeError: [Errno 32] Broken pipe` after 3 retries). `process-inbox-*` jobs still passing but only because inboxes are empty (wake-gate). This supersedes the old HTTP 404 intermittent. Fallback provider still not configured — now urgent.
- **🔴 Telegram API connectivity degraded** (#2, escalated from old #15). Sustained minutes-long windows where both `api.telegram.org` and fallback IPs are unreachable. Gateway eventually auto-recovers but delivery reliability unclear.
- **Graph mass growth: 43 → ~93 concepts** (#12). No backlog in either inbox. Graph-walker partially succeeded today (created `ethereum-scaling` + reciprocity before pipe broke). 6 dangling refs remain (#16).
- **Model changed**: `deepseek-v4-pro` → `deepseek-v4-flash` (#17).
- **New: veil profile** running as second gateway (#18) — scripts `veil_discover.sh`/`veil_tick.sh` in `~/.hermes/scripts/`.
- **Still open from last snapshot**: companion routing (#4), companion not verified (#5 — now blocked by Telegram), fallback provider (#6 — now critical), bot privacy (#14), bot token (#15).
- **Resolved from last snapshot**: `process-inbox-projects` cron (#5 old) still healthy (idle-only). graph-walker project-name filter (#9 old) working. Skill symlinks (#12 old) intact, now includes `curator-triage`. Reciprocity (#10 old) holding at 93-concept scale.

---

## Update 2026-06-13

Big session — graph restructure + 2 new subsystems. Diff:

- **Vault graph restructure** (commit 92ebc6e): unified `type` taxonomy on concepts + **archetype concepts** (`l1-blockchain`, `rollup`) that projects instance-link to. `bitcoin`/`ethereum`/`solana` now all appear under `l1-blockchain`'s `## Instances` (the "L1 Blockchain as a node" the user wanted). knowledge-curator + project-researcher skills updated to enforce it (archetype exception to Hard Rule #4; `## Category / Archetype` section + archetype reciprocity).
- **Active-scan subsystem (Mesin 1, FASE 2)** (commits 5df4d6d/00c4f53 + bugfixes): `scan-curated-sources` cron + `scan_sources.sh`/`parse_feed.py` (wake-gate, 14 verified DeFi-mechanism feeds, seen-ledger) + new `curator-triage` skill (mechanism-vs-noise gate → drop seed to `_knowledge/`). **End-to-end verified**: 3 ethresear items → 3 concepts (`mev-preconditions`, `post-quantum-signatures`, `consensus-weight-decay`) via scan→triage→curate. Design doc: `ARCH-defi-alpha.md`.
- **`process-inbox-projects` cron** (commit 277e434): resolves pending #5. Solana researched → `02-Projects/solana.md`.
- **Graph grew 18 → 43 concepts, 5 projects.** Added Solana mechanism cluster (proof-of-history, sealevel, account-model, spl-token, clob, bonding-curve, memecoin) + DeFi cluster (oracle, lending-protocol, liquidation, stablecoin, data-availability, merkle-tree, zk-proof, erc-20, nft).
- **Bugs fixed**: (a) knowledge-curator **skill collision** — nested `knowledge-curator/knowledge-curator/SKILL.md` cruft kept getting recreated in a loop (ambiguity → `skill_view` fails → agent `skill_manage create` → recreates); deleted, loop broken. (b) **Root 0-byte ghosts** (`lapis.md`, `solana.md` at vault root) — Obsidian creates an empty note at the default location (vault root) when an unresolved `[[link]]` is clicked during the window before the target note exists. Deleted both; self-resolves once target exists. Prevention: set Obsidian "default location for new notes" off vault-root.
- **Still open**: companion routing (#3) now has a real `_projects/` target (project cron exists) but skill still unpatched; fallback provider (#2/#7) still deferred.

---

## Update protocol

When state changes:
- Add evidence line (log timestamp, command output, file path) — never claim without source
- Move items between categories as status changes
- Append `## Update YYYY-MM-DD` section with diff summary if multiple changes in one session
- Keep entries terse (1-2 paragraphs). Detail belongs in linked docs (SKILL.md, setup/*).

When state doesn't change:
- Don't manufacture activity here. Stale-but-accurate beats fresh-but-fabricated.
