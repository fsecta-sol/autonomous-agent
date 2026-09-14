# Setup — vault-first mandate on every channel

**Goal**: every chat that reaches Hermes — Telegram (any thread), dashboard chat, or any future
platform — must ground its answers in the Obsidian vault, not just the `#ask` thread via
`companion`'s `channel_prompts` entry. Deployed 2026-07-15 directly on the server (see STATUS.md).

## Why this works

Two Hermes mechanisms, neither of which needs a per-channel/per-thread config entry:

1. **`terminal.cwd`** (`~/.hermes/config.yaml`) sets the default working directory for the
   messaging gateway (all Telegram/Discord/Slack channels not otherwise overridden by
   `channel_prompts`). It also governs the CLI/TUI when the process is launched from that
   directory — which is why the dashboard's embedded `hermes --tui` picks it up too (see below).
2. **Project context files** (`AGENTS.md`, priority: `.hermes.md` → `AGENTS.md` → `CLAUDE.md` →
   `.cursorrules`, first match wins) auto-load into the system prompt on every session whose
   workdir resolves into that directory tree — no explicit `--skills` flag needed. Verify with
   `hermes prompt-size --platform <telegram|cli> --json` (offline, no API call) — look at the
   `"context (AGENTS.md/cwd files)"` section size.

`companion` skill (`skills/companion/SKILL.md`) is unchanged in what it *does* — it's still the
full workflow (reply format, citation rules, inbox handoff schema). What changed is that its
"Operating principle" is now also injected as a short baseline mandate on every channel via
`vault/AGENTS.md`, instead of only reaching the agent when `channel_prompts` explicitly lists
`companion` in `skills:` for a specific thread.

## What was changed on the server

### 1. `~/.hermes/config.yaml` (default profile only — `veil` profile intentionally untouched)

```bash
hermes config set terminal.cwd /home/hermes/vault
```

Was `cwd: .` (relative — resolved to `~/.hermes` for the gateway service, `~` for the
manually-launched dashboard). Now an absolute path, so it's identical regardless of which
directory the process happened to start in.

### 2. `/home/hermes/vault/AGENTS.md` (new file, vault-side, not git-tracked — vault is
Syncthing data, not this repo)

Canonical content (keep this file and the deployed copy in sync manually if edited):

```markdown
# Vault-first grounding (applies to every session running in this workdir)

This directory (`/home/hermes/vault`) is the personal knowledge graph — the
system of record for crypto/blockchain understanding. Any conversational
reply, regardless of which channel it arrived on (Telegram thread, dashboard
chat, or any future platform), follows this rule:

1. **Vault first.** Before answering a substantive question, check
   `03-Areas/concepts/*.md` and `02-Projects/*.md` for relevant content.
   Use `grep -li "<keyword>" 03-Areas/concepts/*.md 02-Projects/*.md` or a
   direct filename lookup (`ls 03-Areas/concepts/<slug>.md`).
2. **Cite or flag the gap.** If the vault has the answer, cite every claim
   with `[[wikilink]]`. If it doesn't, say so explicitly — do quick web
   research if useful, and mark that part of the reply as web-sourced
   (URL, not wikilink). Never mix an uncited claim in with cited ones.
3. **No vague authority.** Do not answer a substantive crypto/blockchain
   question from training knowledge alone without checking the vault first.
4. **Surface gaps for curation.** When a real gap surfaces, write a
   curation request to `00-Inbox/_knowledge/q-<topic-slug>-<timestamp>.md`
   so `knowledge-curator` creates a proper concept note on the next cron
   tick. Schema and full workflow: see the `companion` skill.
5. **Full workflow.** For reply formatting, citation rules, and the inbox
   schema in detail, follow the `companion` skill end to end.

This does not apply to non-conversational automation (cron jobs, save-only
inbox threads) — those already run their own explicit skill/prompt and
should follow that instead of this file.
```

### 3. Dashboard converted from ad-hoc process to a systemd user service

Previously `hermes dashboard --host 0.0.0.0 --port 9119 --insecure --tui` ran manually in a
`pts/` terminal session (started 2026-07-02, no crash recovery, cwd = `~` so it never saw
`AGENTS.md`). Replaced with `~/.config/systemd/user/hermes-dashboard.service`:

```ini
[Unit]
Description=Hermes Agent Dashboard - Web UI
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/home/hermes/.hermes/hermes-agent/venv/bin/hermes dashboard --host 0.0.0.0 --port 9119 --insecure --tui
WorkingDirectory=/home/hermes/vault
Environment="PATH=/home/hermes/.hermes/hermes-agent/venv/bin:/home/hermes/.hermes/hermes-agent/node_modules/.bin:/home/hermes/.hermes/node/bin:/home/hermes/.local/bin:/home/hermes/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="VIRTUAL_ENV=/home/hermes/.hermes/hermes-agent/venv"
Environment="HERMES_HOME=/home/hermes/.hermes"
Restart=always
RestartSec=5
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=60
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now hermes-dashboard.service
```

Same `--host 0.0.0.0 --port 9119 --insecure` flags preserved as-is (not a security review of
those flags — just carried over from the working manual invocation).

### 4. Gateway restarted to pick up the new `terminal.cwd`

```bash
systemctl --user restart hermes-gateway.service
```

`veil` profile's gateway (`hermes-gateway-veil.service`) was **not** touched — that profile is
scoped to signal/alpha scanning (`tg-listener.service`), not companion-style Q&A, per user
decision 2026-07-15.

## Verification performed

```bash
hermes prompt-size --platform telegram --json   # "context (AGENTS.md/cwd files)": ~1785 bytes
hermes prompt-size --platform cli --json        # same — confirms dashboard's `hermes --tui` sees it too
systemctl --user status hermes-dashboard.service   # active, cwd = /home/hermes/vault (checked via /proc/<pid>/cwd)
systemctl --user status hermes-gateway.service     # active after restart
```

No live Telegram/dashboard message was sent to verify end-to-end (would burn tokens and the
Telegram connectivity bug in STATUS.md #2 makes that flaky) — `prompt-size` confirms injection
into the system prompt without an API call, which is the load-bearing mechanism.

## Known gaps / follow-ups

- `hermes-gateway.service` itself is `disabled` (not `enabled`) in systemd — it was started
  manually at some point and has stayed up via `Restart=always`, but **will not auto-start on a
  full server reboot**. Pre-existing condition, not introduced by this change. Worth
  `systemctl --user enable hermes-gateway.service` separately if reboot survival matters.
- Dashboard is bound to `0.0.0.0:9119` with `--insecure` (Portal OAuth gate skipped, relying on
  `dashboard.basic_auth` in config.yaml). Not evaluated here — flagging only because this setup
  now makes that dashboard a documented, supervised service rather than an easy-to-forget manual
  process.
- If a `#digest`- or `#inbox`-style narrow-purpose thread is added later, its explicit
  `channel_prompts` entry (with its own `skills: []` or minimal skill list) still overrides the
  AGENTS.md baseline for that thread, same as today — nothing about this change forces those
  threads into vault-answering behavior.
