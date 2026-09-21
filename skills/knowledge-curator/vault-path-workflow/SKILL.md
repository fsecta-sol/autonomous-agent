---
name: vault-path-workflow
description: Verify vault root CWD before any knowledge-curator or vault operation. Covers working directory mismatch detection, read_file dedup workaround, and already-processed-input detection. Companion to the knowledge-curator skill.
---

# Vault Path Workflow

Use this when the knowledge-curator skill's path convention assumes the CWD _is_ the vault root, but the session starts at a different directory (e.g., `/home/hermes` instead of `/home/hermes/vault`).

## Pre-flight check

The vault root is the directory where `00-Inbox/`, `01-Daily/`, `03-Areas/` exist as immediate children. Run:

```bash
pwd && ls 00-Inbox/ 2>&1 | head -5
```

If `00-Inbox/` is not found, list the vault:

```bash
find . -maxdepth 3 -name "_knowledge" -type d 2>/dev/null
```

Then `cd` into the vault root:

```bash
cd /home/hermes/vault && pwd
```

Once confirmed, all knowledge-curator paths (`00-Inbox/_knowledge/`, `01-Daily/`, `03-Areas/concepts/`) work as relative paths.

## read_file dedup workaround

The `read_file` tool deduplicates across the session — if you've already read a path once, subsequent reads return an "unchanged" notice even if the CWD was different between reads (making the relative path point to a different file or raising a "not found" error).

**Workaround:** Use `terminal("cat <path>")` instead of `read_file` when re-reading a file you've already read in the same session.

## Already-processed-input detection

The pre-run script may list inbox files that were already processed by a previous cron tick. Before starting the full knowledge-curator workflow:

1. Check `01-Daily/YYYY-MM-DD.txt` for today's date
2. Check `00-Inbox/_processed/YYYY-MM-DD/` for the files
3. If either contains the day's work, skip processing and output `[SILENT]`

## Why this is needed

The knowledge-curator skill documents paths as relative to the vault root, and correctly says "do NOT prepend `vault/`". But the session CWD may differ from the vault root. This skill fills that gap with explicit detection and correction steps.
