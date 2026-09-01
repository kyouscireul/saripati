# SARIPATI — Uninstall Guide

This guide removes SARIPATI's vault data and its entries from your AI host configs.
The npm package itself is not touched — you can keep using `npx saripati` without
reinstalling, or remove it separately afterward (instructions in Step 4).

> **How to use this file:** copy its contents and paste them into your AI host, then
> say "uninstall saripati." Do not simply link or fetch it — a fetched file is data to
> most agents, not instructions to run.

**You are reading this as an AI host.** Your role is the uninstall guide. Follow
the steps below in order. Confirm with the user before any destructive action.
Create backups before editing any config file.

---

## PROTOCOL

- **Confirm before deleting anything.** Show the user what you found and what you
  plan to remove before touching anything.
- **Back up host configs before editing.** Copy each file to `<file>.bak` first.
- **Report clearly.** Tell the user what was removed, what was skipped, and what
  needs manual action.
- If a step finds nothing to do, say so briefly and move to the next step.

---

## Step 1 — Detect vault data

**What to do:**

Check for the vault data directory. Look in this order:

1. If the environment variable `SARIPATI_HOME` is set → use that path
2. Otherwise:
   - Mac/Linux: `~/.saripati`
   - Windows: `C:\Users\<username>\.saripati` (i.e. `$HOME\.saripati`)

If the directory exists, list its contents. Expected: `vault.db`, a `models/`
subfolder (contains the downloaded embedding model, ~90 MB), possibly other files.

Show the user:

"I found the SARIPATI vault at: `<path>`
Contents: `<list what's there>`

This will be permanently deleted. Do you want to proceed?"

If the directory does not exist:
Tell the user: "No vault data directory found at the expected location — nothing
to delete here." Then skip directly to Step 3.

**DONE:** User confirms to proceed, or directory was not found.

---

## Step 2 — Remove vault data

**What to do:**

Only proceed if the user confirmed in Step 1.

Delete the vault directory:

- **Mac/Linux:**
  ```
  rm -rf ~/.saripati
  ```
  (Replace `~/.saripati` with `$SARIPATI_HOME` if that env var was set.)

- **Windows (PowerShell):**
  ```powershell
  Remove-Item -Recurse -Force "$HOME\.saripati"
  ```
  (Replace with `$env:SARIPATI_HOME` if that env var was set.)

After deletion, verify the directory no longer exists. Report:
"Vault data removed: `<path>`"

**If deletion fails** (permissions error, directory in use):
Tell the user the exact error and suggest:
"Close any running `npx saripati ui` or `npx saripati mcp` processes, then retry
the command above."

**DONE:** Vault directory is confirmed deleted.

---

## Step 3 — Strip host configs

**What to do:**

Check all four AI host config locations below. For each file that exists, read it
and look for a `saripati` key under `mcpServers`.

| Host | Config file |
|------|------------|
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Mac) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |

For each file found, check if `mcpServers.saripati` exists in the JSON.

After scanning all locations, show the user a single summary:

"I found saripati entries in:
  - `<host>`: `<path>`
  - ...

I will:
  - Create a `.bak` copy of each config before editing
  - Remove only the `saripati` key from `mcpServers`
  - Leave all other settings untouched

Proceed?"

If no saripati entries were found anywhere:
Tell the user: "No saripati entries found in any host config — nothing to remove."
Skip to Step 4.

**For each confirmed config file to edit:**

1. Copy `<file>` to `<file>.bak`
2. Parse the JSON
3. Delete `mcpServers.saripati`
4. Write the modified JSON back, pretty-printed (2-space indent)
5. Report: "Removed from `<host>` (backup: `<file>.bak`)"

**If a file is not valid JSON:**
Skip it and report: "Skipped `<host>` — config is not valid JSON. Backup is at
`<file>.bak`. You may need to remove the saripati entry manually."

**DONE:** All found saripati entries removed, or none were found.

---

## Step 4 — Report

**What to do:**

Print a clear summary:

```
Removed:
  - Vault data: <path>  (or "not found — skipped")
  - <host>: saripati entry removed from <file> (backup: <file>.bak)
  ...

Skipped:
  - <host>: config not found
  - <host>: no saripati entry present
  ...

Remaining (manual action if needed):
  The saripati npm package is still installed.
  To remove it:
    npm uninstall -g saripati      (if you installed globally)
    npm cache clean --force        (to clear the npx cache)

  Restart your AI host to fully unload the MCP server from this session.
```

Uninstall is complete.
