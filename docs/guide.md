# SARIPATI — User Guide

## What It Is

SARIPATI is a **local-first MCP (Model Context Protocol) server** that gives any AI host
a persistent knowledge vault. You keep using whatever AI tool you already use — Claude Code,
Cursor, Windsurf, Cline, Continue. SARIPATI sits underneath it, providing **9 tools** the AI
can call to store, retrieve, and steer accumulated knowledge across sessions.

It is not a chat app. It runs no LLM. It needs no API keys. Your entire knowledge base is
a single SQLite file on your machine.

---

## Installation

### One command — `saripati setup`

```bash
npx saripati setup                      # create the vault, print config + detected hosts
npx saripati setup ./setup.md           # also load identity from a template file
npx saripati setup ./setup.md --write   # also register with detected hosts
npx saripati setup --write --host cursor  # register a single host
```

Grab [`setup.md`](../setup.md), fill in the four identity fields at the top, and point
`setup` at it. Available `--host` ids: `claude`, `cursor`, `windsurf`, `claude-desktop`.
Writing to host configs is **opt-in** (`--write`) — the snippet is always printed, never
written silently; existing configs are backed up to `.bak` first.

### Claude Code CLI (user scope)

```bash
claude mcp add saripati -s user -- npx -y saripati mcp
claude mcp list          # saripati shows as connected
```

### Manual — add to any host's `mcpServers` config

```json
{
  "mcpServers": {
    "saripati": { "command": "npx", "args": ["-y", "saripati", "mcp"] }
  }
}
```

| Host | File |
|------|------|
| Claude Code | `~/.claude.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

Restart the host after editing.

---

## First Run

The first time a tool that needs embeddings runs (`vault`), the MCP server downloads the
`all-MiniLM-L6-v2` model (~90 MB) to `~/.saripati/models/`, with an elapsed-time heartbeat on
stderr so you can see it working. This happens **once** — later runs load from disk and work
offline. The vault database is created automatically at `~/.saripati/vault.db`; existing
vaults from older versions upgrade in place (a migration runner adds new columns on open).

---

## Identity — personalize your vault

`setup ./setup.md` reads a small YAML frontmatter:

```yaml
---
name:      Your Name
field:     Software Engineering
skills:    [supabase, next.js, laravel]
language:  English
companion: librarian     # plain | librarian | research-assistant
---
```

It is stored in a singleton `identity` row that `on` and `whoami` return at session start,
so the host addresses you correctly and adopts the right voice. Update it any time with the
`identity_set` tool (fields merge).

---

## The 9 Tools

You do not call these directly — you speak to your AI host naturally and it invokes them.

### `on`  — start every session

Load continuity, unprompted, before doing work. Returns your **identity**, the last session
digest, recent entries, active projects, and **nudges**:

- `unresolved_questions` — open `question` entries
- `active_intentions` — live `intention` commitments
- `unread_memos` — memos the agent left for its future self, created since the last session
- `stale_projects` — active projects with no entries in >21 days (tunable via
  `companion_config.stale_days`)

If `user_prefs.focus` is set, recent entries are biased toward that project. **No parameters.**

### `off`  — end every session

Write a session digest (`title`, `summary`, `next_steps`). Write it yourself from what
happened — don't ask the user to dictate it. The next `on` resumes from it.

### `vault`  — save and recall (the one door)

Intent is inferred from the fields you pass:

| Intent | Pass | Notes |
|--------|------|-------|
| **Recall** | `query` (+ `limit`, `kind`, `include_superseded`) | Hybrid semantic + keyword; superseded/archived excluded unless `include_superseded`. |
| **Save research** | `findings` (+ `topic`, `sources`) | Stored as a `research` entry. |
| **Save anything else** | `content` (+ `kind`) | `note` (default), `decision`, `pattern`, `question`, `memo`, `intention`. |

Common fields: `confidence` (0..1 or `null` for explicitly unknown), `tags`, `project`,
`resolved` (for questions), `active` (for intentions). **Every save runs a conflict check** —
if a near-duplicate or contradiction exists, the response includes a `conflicts` list.

### `entry_update`  — resolve conflicts, manage lifecycle

Metadata-only (never edits the body, never re-embeds). Use it to close the conflict loop:

| Param | Purpose |
|-------|---------|
| `id` | The entry to update (required) |
| `status` | `active` · `superseded` · `archived` |
| `superseded_by` | Id of the entry that replaces this one |
| `confidence` | 0..1 or `null` |
| `kind` / `tags` | Reclassify / retag |
| `resolved` / `active` | Answer a question / close an intention |
| `links` | Explicit typed links: `{ id, rel }` where rel ∈ `because-of·supersedes·related·contradicts` |

### `corpus`  — what already exists

Counts, breakdown by kind, top tags, per-project `last_entry_at`, and session count. Call it
at session start (after `on`) to build on the corpus instead of duplicating it. **No params.**

### `project_update` / `project_list`

A lightweight project registry. `project_update` upserts by `name` (metadata merges via JSON
patch); `project_list` lists, optionally filtered by `status`.

### `whoami` / `identity_set`

`whoami` returns the identity + companion persona. `identity_set` creates/updates it — scalar
fields replace when provided; `user_prefs` and `companion_config` merge. Encode your own
tuning here, e.g. `identity_set({ companion_config: { recall_boost: { memo: 3.0 }, stale_days: 30 } })`.

---

## The Steerer model

- **Kinds:** `research · note · decision · pattern · question · memo · intention`.
- **Status:** `active · superseded · archived` — superseded/archived entries leave default
  recall so old decisions aren't cited as current truth.
- **Per-kind boost:** memo > question > decision/intention > pattern > research/note, tunable
  via `companion_config.recall_boost`.
- **Conflict detection:** every `vault` save is checked against the corpus; contradictions
  come back so the agent can `entry_update` them (supersede / link / lower confidence).

---

## The Dashboard

```bash
npx saripati ui                  # http://localhost:4319 — READ-ONLY by default
npx saripati ui --write          # enable in-browser tag/kind editing
npx saripati ui --no-semantic    # FTS keyword only — faster cold start, no model load
npx saripati ui --port 8080      # custom port
npx saripati ui --no-open        # don't auto-open the browser
```

Built on **Preact 10 + HTM** — no CDN, no bundler; the ESM bundles are vendored into the
package and served at `/vendor/*.js`. Tabs: **Entries** (hybrid search, kind chips,
`@project`/tag filters, entry detail with sources + backlinks and a lifecycle-status badge),
**Graph** (physics force-graph over derived links — wikilink/project/tag edges), **Tags**,
**Identity** (profile · companion · session history). A `/api/last-fetch` endpoint exposes
the agent's most recent recall for observability.

**Editing is off by default.** Pass `--write` to allow tag/kind mutations (a PATCH without
`--write` returns 403). Body edits are not offered in the UI.

---

## Typical Daily Flow

```
Start:   You: "Start my session."   AI: on → identity + last session + nudges
Work:    You: "Research X and save it."   AI: vault(findings=…) → stored + conflict-checked
         You: "We decided Y."              AI: vault(content=…, kind=decision)
Recall:  You: "What do we have on X?"      AI: vault(query=…) → ranked results
Resolve: (vault flags a conflict)          AI: entry_update(status=superseded, superseded_by=…)
End:     You: "Wrap up."                    AI: off(summary, next_steps) — written by the AI
Anytime: npx saripati ui   → browse and search the growing corpus
```

(One-time: `npx saripati setup ./setup.md` to create the vault and set your identity.)

---

## Custom Vault Location

```bash
SARIPATI_HOME=/path/to/workdir npx saripati mcp   # per-context vault (work vs personal)
SARIPATI_DB=/path/to/custom.db  npx saripati mcp   # direct path override
npx saripati mcp --db /path/to/custom.db           # via CLI flag
npx saripati setup --from /path/to/workdir         # set the vault dir at setup time
```

Precedence: `--db` flag > `SARIPATI_DB` > `<SARIPATI_HOME>/vault.db` > `~/.saripati/vault.db`.

---

## Backup

The vault is a single SQLite file:

```bash
cp ~/.saripati/vault.db ~/backups/vault-$(date +%Y%m%d).db
```

While the server/dashboard runs, a WAL journal (`vault.db-wal`, `vault.db-shm`) may sit
alongside it. For a hot backup use SQLite's online backup: `sqlite3 vault.db ".backup backup.db"`.

---

## Publishing Updates (for SARIPATI developers)

```bash
npm run build          # TypeScript → dist/ (+ vendored UI bundles)
npm test               # smoke suite must pass (theme, migration, embedder, recall,
                       # link graph, identity, new kinds, vault + conflicts, MCP loop)
git add -p && git commit -m "feat: ..." && git push
npm version minor      # 0.2.0 → 0.3.0
git push --follow-tags
npm publish --access public --ignore-scripts --otp=<6-digit-code>
```

`--ignore-scripts` skips the auto-rebuild during publish — use it after running `build` and
`test` manually, to keep the OTP inside its ~30-second window.

---

## Troubleshooting

**Tools not showing up in host** — restart the host (it re-reads MCP config on start); verify
with `claude mcp list`; ensure Node ≥ 18 (`node --version`).

**"Embedding dim mismatch"** — the model cache may be corrupted. Delete `~/.saripati/models/`
and restart.

**Database locked** — one writer per vault file. The dashboard and MCP server coexist (WAL
allows concurrent reads); two MCP instances on one vault conflict.

**First tool call very slow** — normal; the ~90 MB model is downloading (watch the heartbeat).
Subsequent calls are fast.

**"saripati not found" in host** — run `npx -y saripati help` once to prime the npx cache, then
restart the host.
