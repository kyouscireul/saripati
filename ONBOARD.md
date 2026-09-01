# SARIPATI — Onboarding Guide

SARIPATI is a local-first MCP knowledge vault. It gives your AI host a persistent,
compounding memory across sessions. It runs no LLM and needs no API keys — it is pure
storage and retrieval, built on SQLite.

> **How to use this file:** copy its contents and paste them into your AI host, then
> say "set up saripati." Do not simply link or fetch it — most agents treat a fetched
> file as data to summarise rather than instructions to run, so linking usually gets
> you a description of the install instead of the install.

**You are reading this as an AI host (Claude Code, Cursor, Windsurf, etc.).** Your role
in this file is the onboarding guide. The user in front of you wants to set SARIPATI up.
Follow the steps below to orchestrate the entire installation conversationally.

---

## PROTOCOL

Read this before starting:

- Follow the steps in strict order. Do not skip any step, even if the user seems
  impatient or already familiar with the process.
- Each step ends with a **DONE condition**. Only advance when it is met.
- Handle errors inline — guidance is given in each step. Do not abort unless the
  situation is truly unrecoverable.
- You are talking to the user throughout. Keep it conversational. Explain what you
  are doing before you do it.

---

## Step 1 — Prerequisites

**What to do:**

Tell the user: "Let me check your environment before we start."

Run both commands in the user's shell:

```
node --version
npx --version
```

Interpret the results:

- `node --version` returns `v22.x.x` or higher → pass
- `node --version` returns v21 or lower, or command not found → tell the user:
  "You need Node.js 22 or higher. Download the LTS build from https://nodejs.org,
  install it, then restart your terminal and come back here."
- `npx --version` returns any version string → pass
- `npx --version` not found but node is installed → tell the user:
  "npx comes bundled with Node.js. Try running `npm install -g npm` to restore it."

Do not proceed to Step 2 until both checks pass.

**DONE:** `node --version` ≥ 22 and `npx --version` responds.

---

## Step 2 — Identity collection

**What to do:**

Tell the user: "Now I'll ask you a few quick questions to personalize your vault.
Answer however feels natural — this is just your profile, nothing is locked in."

Ask the five questions below **one at a time**. Wait for each answer before asking
the next. Do not present them as a form or list.

**Q1:** "What's your name? This is how your AI companion will address you."
→ Collect as: `name`

**Q2:** "What's your field or main line of work?
For example: Software Engineering, Data Science, Freelance Design, Academic Research."
→ Collect as: `field`

**Q3:** "What are your main skills or tools? List a few, comma-separated.
For example: TypeScript, React, PostgreSQL — or whatever fits your work."
→ Collect as: `skills` (a comma-separated list)

**Q4:** "What language do you work in? (Press Enter to keep the default: English)"
→ Collect as: `language`. If the user skips or says nothing, default to `English`.

**Q5:** "Would you like an AI companion persona alongside the vault, or just the plain
vault? Here are the three options:

1. **Plain** — no companion, just the vault. Clean and neutral.
2. **Librarian** — a stoic, precise archivist named Sage. Calm, academic tone.
   Values accuracy, continuity, clarity.
3. **Research Assistant** — a curious, rigorous partner named Atlas. Asks sharpening
   questions, always cites evidence, prefers primary sources.

Type 1, 2, or 3 — or just say plain, librarian, or research-assistant."
→ Collect as: `companion`. Map to one of: `plain` | `librarian` | `research-assistant`
  If the user says "none" or "no companion", use `plain`.

**DONE:** You have values for all five fields (language and companion may be defaulted).

---

## Step 3 — Generate setup.md

**What to do:**

Write a file named `setup.md` in the current working directory with the collected
answers filled in. Use **this exact template** — replace the bracketed placeholders
with the user's answers:

```
---
name:        [name]
field:       [field]
skills:      [[skill1, skill2, skill3]]
language:    [language]
companion:   [companion]
---

# SARIPATI — Setup

SARIPATI is a local-first, provider-agnostic MCP knowledge vault. It runs no LLM
and needs no API keys — it gives whatever AI host you use a persistent, compounding
memory. The identity above tells the vault who it belongs to.

## 1. Register with your AI host

Add this to your host's MCP config (works for Claude Code, Claude Desktop, Cursor,
Windsurf, and any MCP-compatible host):

\`\`\`json
{
  "mcpServers": {
    "saripati": {
      "command": "npx",
      "args": ["-y", "saripati", "mcp"]
    }
  }
}
\`\`\`

`npx saripati setup ./setup.md --write` will attempt to merge this into every
detected host automatically (it always prints the snippet first — it never edits
a config silently).

## 2. Tell your agent the protocol

Paste this into your host's system prompt / rules so the agent uses the vault well:

> You have a SARIPATI knowledge vault. Call `on` at the very start of every session
> to load continuity and surface nudges (open questions, active intentions, unread
> memos, stale projects). Before answering anything that may have been researched or
> decided before, `vault` recall first. The moment a decision is made, a finding is
> confirmed, or a pattern emerges, `vault` save it — don't wait to be asked. When the
> vault flags a conflict on save, resolve it with `entry_update` (supersede or link).
> Call `off` at session end and write the digest yourself.

## 3. Browse it

`npx saripati ui` opens a local dashboard (read-only by default; add `--write` to edit).
```

Notes on the template:
- The `skills` field uses inline array format: `[skill1, skill2, skill3]` — keep the
  square brackets, separate skills with commas.
- The `companion` field must be one of the three exact values: `plain`, `librarian`,
  `research-assistant`.

After writing the file, tell the user: "I've written setup.md to your working
directory with your details. Running setup now."

**DONE:** `setup.md` exists in the working directory with all five fields filled in.

---

## Step 4 — Run setup

**What to do:**

Run this command:

```
npx saripati setup ./setup.md --write
```

Read the output carefully and report back to the user:

- If it prints `Vault ready at: ...` → confirm the vault path to the user.
- If it prints `Identity loaded from setup.md` → confirm their identity was saved.
- If it prints host config lines like `updated: Claude Code → ~/.claude.json` →
  tell the user which hosts were configured automatically.
- If it prints `No existing host configs detected` → tell the user:
  "No host configs were detected automatically. You'll need to add the MCP config
  manually. Here it is — paste it under `mcpServers` in your host's MCP settings:"
  Then show:
  ```json
  {
    "mcpServers": {
      "saripati": {
        "command": "npx",
        "args": ["-y", "saripati", "mcp"]
      }
    }
  }
  ```

**If the command fails entirely:**

Option A — try the global install fallback:
```
npm install -g saripati
saripati setup ./setup.md --write
```

Option B — if that also fails, tell the user:
"Something went wrong with the install. Add the MCP config manually (shown above),
then file an issue at https://github.com/kyouscireul/saripati with the error output."

**DONE:** Command exits successfully and vault path is confirmed.

---

## Step 5 — System prompt

**What to do:**

Tell the user: "One last thing — paste this into your AI host's system prompt so
it knows to use the vault every session. I'll wait for you to confirm it's done."

Show the following block in a fenced code block (for easy copy):

```
You have a SARIPATI knowledge vault. Call `on` at the very start of every session
to load continuity and surface nudges (open questions, active intentions, unread
memos, stale projects). Before answering anything that may have been researched or
decided before, `vault` recall first. The moment a decision is made, a finding is
confirmed, or a pattern emerges, `vault` save it — don't wait to be asked. When the
vault flags a conflict on save, resolve it with `entry_update` (supersede or link).
Call `off` at session end and write the digest yourself.
```

Where to paste it, by host:

- **Claude Code**: open Settings (gear icon) → System Prompt
- **Claude Desktop**: open Settings → Custom Instructions
- **Cursor**: open Settings → Rules for AI
- **Windsurf**: open Settings → Cascade Instructions
- **Any other host**: look for "system prompt", "rules", or "instructions" in settings

Wait for the user to say they've pasted it before continuing to Step 6.

**DONE:** User confirms the system prompt is in place.

---

## Step 6 — Done

**What to do:**

Tell the user:

"SARIPATI is set up. Here's what happens next:

**Restart your AI host** — MCP servers load at startup, so the vault won't be live
until you restart.

After restart, in any new session:
- Your assistant will call `on` automatically and load your identity, last session,
  and any nudges (open questions, live intentions, unread memos).
- During the session: `vault` saves findings and recalls them. `entry_update` resolves
  conflicts. `off` closes the session with a digest your assistant writes itself.
- Browse your vault any time: run `npx saripati ui` in any terminal.

To update your identity later, just ask your assistant to update it and it will use
the `identity_set` tool. To uninstall, open UNINSTALL.md in your AI host."

Onboarding is complete. No further action needed.
