# SARIPATI — User Guide

## What It Is

SARIPATI is a **local-first MCP (Model Context Protocol) server** that gives any AI host
a persistent knowledge vault. You keep using whatever AI tool you already use — Claude Code,
Cursor, Windsurf, Cline, Continue. SARIPATI sits underneath it, providing 12 tools the AI
can call to **store and retrieve accumulated knowledge** across sessions.

It is not a chat app. It runs no LLM. It needs no API keys. Your entire knowledge base is
a single SQLite file on your machine.

---

## Installation

### Recommended — Claude Code CLI (user scope)

Registers SARIPATI for all your projects. First run downloads the ~90 MB embedding model.

```bash
claude mcp add saripati -s user -- npx -y saripati mcp
```

Verify:
```bash
claude mcp list          # saripati shows as connected
```

### Auto-config (Claude Desktop, Cursor, Windsurf)

Detects installed host config files and merges the SARIPATI entry. Backs up the existing
config to `.bak` before writing.

```bash
npx saripati init --write                      # all detected hosts
npx saripati init --write --host cursor        # one specific host
npx saripati init --write --host claude-desktop
npx saripati init --write --host windsurf
```

Available `--host` ids: `claude`, `cursor`, `windsurf`, `claude-desktop`

Without `--write`, `init` creates the vault and prints the config snippet without touching
any host file:
```bash
npx saripati init          # shows snippet + detected host paths
```

### Manual — add to any host's `mcpServers` config

```json
{
  "mcpServers": {
    "saripati": { "command": "npx", "args": ["-y", "saripati", "mcp"] }
  }
}
```

Config file locations:

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

The first time any tool is called that requires embeddings (`save_research`, `remember`,
`recall`), the MCP server downloads the `all-MiniLM-L6-v2` model (~90 MB) to
`~/.saripati/models/`. This happens **once only** — subsequent runs load it from disk and
work offline. Expect 30–60 seconds on first use depending on connection speed.

The vault database is created automatically at `~/.saripati/vault.db` on first use (or on
`saripati init`). No setup SQL needed.

---

## Onboarding — personalize your vault

Optional but recommended. `saripati onboard` captures who the vault serves so your AI host
can address you correctly and adopt a consistent voice.

```bash
npx saripati onboard          # interactive 5-step setup
npx saripati onboard --print  # show the current identity
npx saripati onboard --reset  # clear it
```

The five steps: **about you** (name, field) → **preferences** (skills, communication style,
address, language) → **pick a companion persona** (starter presets: *librarian*,
*research-assistant*, or *plain*) → **customize** (companion name / role / tone) → **save**.

It stores a singleton identity that `session_boot` and the `whoami` tool return at the start
of a session. Onboarding also works non-interactively for scripting:

```bash
printf '%s\n' 'Ada' 'Data Science' 'python, sql' 'concise' 'Ada' 'English' '2' 'Atlas' 'Research Assistant' 'Curious, rigorous' \
  | npx saripati onboard
```

---

## The 12 Tools

You do not call these tools directly. You speak to your AI host naturally; the host invokes
the appropriate tool.

### `save_research`

Store a structured research finding. The host AI does the web research with its own browsing
tools, then calls this to distill and persist the essence.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `topic` | Yes | The subject — becomes the entry title |
| `findings` | Yes | Array of strings, one per claim/finding |
| `sources` | No | Array of `{url?, title?, snippet?}` objects |
| `confidence` | No | Float 0.0–1.0 — your confidence in these findings |
| `tags` | No | Array of topic tags for clustering |
| `project` | No | Associate with a project name |

**Example prompt to your AI:**
> "Research current Lazada affiliate commission rates for electronics in Malaysia and save
> the findings to my vault under project propello."

---

### `remember`

Capture a note, decision, or reusable pattern. For anything worth persisting that is not
formal research.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `content` | Yes | Free text. The first line (up to 80 chars) becomes the title. |
| `kind` | No | `note` (default), `decision`, or `pattern` |
| `tags` | No | Array of topic tags |
| `project` | No | Associate with a project name |

**Example prompts:**
> "Remember that we decided Malaysia-first launch, Lazada + Shopee as primary affiliate
> networks, Amazon secondary."

> "Remember this pattern as kind=pattern: engine/template separation — pure engine produces
> a RenderedDocument; cosmetic template consumes it. No business logic in JSX."

---

### `recall`

Hybrid semantic + keyword search over everything in the vault. Paraphrases work — you do
not have to use the exact words that were stored.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `query` | Yes | Natural language question or keywords |
| `limit` | No | Max results, 1–50 (default 8) |
| `kind` | No | Restrict to `research`, `note`, `decision`, or `pattern` |

**Example prompts:**
> "What do I have in my vault about affiliate payouts?"

> "Recall any decisions I've made about the tech stack for propello."

> "What patterns are saved about frontend architecture?"

The result includes `matchedVec` (semantic) and `matchedFts` (keyword) booleans per result
so you can see which retrieval leg surfaced each hit.

---

### `session_boot`

Load continuity context at the start of a work session. Returns:
- Your **identity** (profile + companion persona), if set
- The most recent session digest (title, summary, next steps)
- The 8 most recently created entries
- All projects with status `active`

**No parameters.** Call this at the start of any session to resume where you left off.

**Example prompt:**
> "Boot my session — what was I working on?"

---

### `session_save`

Write a session digest. Future `session_boot` calls return this as the latest session.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Short session title |
| `summary` | Yes | What happened this session |
| `next_steps` | No | Array of strings — actionable follow-ups |

**Example prompt:**
> "Save this session: we built the analytics agent, fixed Instagram impressions, documented
> the Twitter OAuth gap. Next steps: test Shopee adapter, wire real Supabase."

---

### `corpus_status`

Report what the vault currently holds. Useful to check coverage before a research session
or to gauge how much the corpus has grown.

**No parameters.**

Returns: total entry count, count by kind, top 20 tags by frequency, project count, session
count, last-updated timestamp.

**Example prompt:**
> "What's in my vault? Give me a status report."

---

### `project_upsert`

Register or update a project. Metadata is **merged** on upsert — calling with partial
metadata adds new fields without removing existing ones.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique project name (the key) |
| `path` | No | Filesystem path |
| `stack` | No | Tech stack summary |
| `status` | No | `active` (default), `parked`, `idea`, `archived` |
| `metadata` | No | Arbitrary JSON object, merged into existing |

**Example prompt:**
> "Register project propello, path E:/PROJECTS/propello, stack Next.js + Supabase, status
> active, metadata phase: Stage 2."

---

### `project_list`

List projects in the registry, optionally filtered by status.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| `status` | No | Filter by `active`, `parked`, `idea`, or `archived` |

**Example prompt:**
> "List all my active projects from the vault."

---

### `whoami`

Return the vault owner's identity — profile, preferences, and the configured AI-companion
persona. A host can call this to adopt the right voice and address you correctly. If empty,
it suggests running `saripati onboard`.

**No parameters.**

**Example prompt:**
> "Who am I, according to the vault? Load my profile and adopt my companion persona."

---

### `identity_set`

Create or update the identity conversationally. Scalar fields are only replaced when provided;
`user_prefs` and `companion_config` objects are **merged** (JSON patch), so the persona can be
built incrementally across calls.

**Parameters (all optional):**
| Param | Description |
|-------|-------------|
| `user_name` / `user_field` | Your name and line of work |
| `user_prefs` | Object: skills, communication_style, address, language, … (merged) |
| `companion_name` / `companion_role` / `companion_tone` | The AI companion's persona |
| `companion_config` | Extended persona object: traits, values, habits (merged) |

**Example prompt:**
> "Set my address preference to 'Wanderer' and add 'laravel' to my skills."

---

### `export_md`

Project the vault to its Obsidian-compatible Markdown folder (`IDENTITY.md`, `MEMORY.md`, and
one file per entry with wikilinks + backlinks). Optionally filter by kind or project.

**Parameters (all optional):** `kind` (research/note/decision/pattern), `project`.

**Example prompt:**
> "Export my vault to Markdown so I can browse it in Obsidian."

---

### `import_md`

Reconcile hand edits in the Markdown folder back into the vault (re-embedding changed
entries). Reports created / updated / unchanged / conflicted / orphaned.

**Parameters (all optional):**
| Param | Description |
|-------|-------------|
| `force_md` | On conflict, let the Markdown edit win |
| `prune` | Delete vault entries whose Markdown files were removed |

**Example prompt:**
> "I edited some notes in Obsidian — import the changes back into the vault."

---

## The Markdown Mirror

Beyond the dashboard, SARIPATI can mirror the whole vault to a **human-editable**
Obsidian folder and pull edits back. The `.db` stays the source of truth; the folder is a
synced projection.

```bash
npx saripati export --md                    # DB → ~/.saripati/profile/
npx saripati export --md --out ./my-vault   # export to a custom directory
npx saripati export --md --kind research    # filter by kind or --project <name>
npx saripati import --md                     # reconcile edits back into the DB
npx saripati import --md --force-md          # on conflict, Markdown wins
npx saripati import --md --prune             # delete DB entries whose files were removed
npx saripati sync                            # export then import in one pass
```

**Layout** (`~/.saripati/profile/`):
- `IDENTITY.md` — your persona, round-trips back on import
- `MEMORY.md` — an index of every entry, grouped by kind, with `[[wikilinks]]`
- `memory/{kind}_{slug}-{id}.md` — one file per entry: frontmatter, body, sources, links,
  backlinks. The `id` in frontmatter is the join key.

**How reconcile decides** (per file, using the `md_sync` merge base):
- Only the **file** changed → the entry is updated and re-embedded.
- Only the **DB** changed → skipped (the next export refreshes the file).
- **Both** changed since last sync → reported as a **conflict**; the DB is left untouched
  unless you pass `--force-md`.
- A **new** hand-created file (no `id`) → inserted, then renamed to a canonical filename with
  its assigned `id` back-filled.
- An **orphan** (DB entry with no file) → reported; deleted only with `--prune`.

An unedited `export → import` changes nothing (every entry reports `unchanged`) — editing in
Obsidian and re-importing is the only thing that mutates the vault through this path.

> **`--prune` caution:** it makes the DB match the folder exactly. If you exported a *filtered*
> view first, the folder is partial — pruning would treat the absent entries as deletions.

---

## The Dashboard

A local browser UI with four tabs and two themes. Runs independently alongside the MCP
server or standalone — opens the same vault file (WAL mode allows concurrent readers).

```bash
npx saripati ui                  # default port 4319 — write + semantic ON by default
npx saripati ui --no-write       # disable in-browser tag/kind editing
npx saripati ui --no-semantic    # FTS keyword only — faster cold start, no model load
npx saripati ui --port 8080      # custom port
npx saripati ui --no-open        # don't auto-open browser
```

Built on **Preact 10 + HTM** (no CDN, no bundler — vendor files served locally at `/vendor/*.js`).

**Entries tab** (default)
- Hybrid semantic + keyword search (on by default; toggle the `--semantic` pill per query)
- Kind chips filter by entry type; `@project` tag on each row is clickable to filter by project
- Tag filter active state shown as a dismissible pill
- Persistent corpus stats footer: entries · projects · sessions · last updated
- Selecting an entry shows detail on the right (markdown body, confidence bar, tags, sources, backlinks)
- A **sessions panel** (240px) appears beside the entry detail showing the last 5 session digests
- Corpus status (kind bars, total counts) shown when no entry is selected
- Export button downloads the current filtered view as Markdown

**Graph tab**
- Canvas force-graph with **continuous physics and thermal noise** — nodes drift gently forever
- Nodes coloured by kind (amber=research, green=decision, gold=pattern, grey=note)
- Edges coloured by type (amber=wikilink, green=project, grey=tag)
- **Drag** a node to rearrange — releases back into the physics flow; stays on the graph
- **Click** a node (< 8px movement) to open it in the Entries tab
- Pre-warmed on load (120 silent physics steps before first frame) to prevent the initial blast
- "reset layout" re-warms from a fresh circle

**Tags tab**
- All tags ranked by frequency, rendered as proportional bars
- Click any tag → sets tag filter on the Entries tab

**Identity tab**
- Profile card: name, field, skills, communication style, address, language
- Companion persona card: name, role, tone, trait chips
- Latest session card: title, summary, next steps (up to 3 shown)
- **Session history**: up to 4 prior sessions with truncated summaries and next steps

**Theme**
- Defaults to **light** (warm parchment `#F5F4EF`, amber `#D97800`)
- Header pill switches to **dark** (`#0F0F0F`, amber `#FF9E00`)
- Preference persists in `localStorage`

**Write mode** (on by default, disable with `--no-write`)
- `×` on tag chips removes them; `+ tag` input adds new ones (Enter to commit)
- Kind selector dropdown reclassifies entries
- Body edits: intentionally UI-disabled — edit in Obsidian, then `saripati import --md`

**Semantic mode** (on by default, disable with `--no-semantic`)
- Hybrid semantic + keyword (RRF) on every search
- Toggle the `--semantic` pill in the search bar to switch to FTS per query
- Model lazy-loads on first semantic query (~90 MB, one-time download)

> Pass `--no-semantic` when you want instant cold start with no model overhead.

---

## Typical Daily Flow

```
Morning start:
  You: "Boot my session."
  AI:  calls session_boot → shows last session digest + recent entries

During work:
  You: "Research X and save it."
  AI:  browses, then calls save_research → entry stored + embedded

  You: "Remember we decided Y."
  AI:  calls remember(kind=decision) → decision stored

Mid-session recall:
  You: "What do we have on X?"
  AI:  calls recall → returns ranked results from vault

End of session:
  You: "Save this session — we did A, B, C. Next steps: D, E."
  AI:  calls session_save → digest written

Anytime:
  npx saripati ui        → browse and search the growing corpus
  npx saripati sync      → mirror to Obsidian, reconcile any hand edits back
```

(One-time: `npx saripati onboard` to set your identity + companion persona.)

---

## Custom Vault Location

By default the vault is at `~/.saripati/vault.db`. Override it:

```bash
# Per-context vault (e.g. work vs personal)
SARIPATI_HOME=/path/to/workdir npx saripati mcp

# Direct path override
SARIPATI_DB=/path/to/custom.db npx saripati mcp

# Via CLI flag (init and mcp)
npx saripati mcp --db /path/to/custom.db
```

Precedence: `--db` flag > `SARIPATI_DB` env > `<SARIPATI_HOME>/vault.db` > `~/.saripati/vault.db`

---

## Backup

The vault is a single SQLite file. Back it up by copying:

```bash
cp ~/.saripati/vault.db ~/backups/vault-$(date +%Y%m%d).db
```

The WAL journal (`vault.db-wal`, `vault.db-shm`) may exist alongside the main file while
the MCP server or dashboard is running. For a safe backup while the server is running,
use SQLite's online backup (e.g. `sqlite3 vault.db ".backup backup.db"`).

---

## Publishing Updates (for SARIPATI developers)

```bash
# 1. Edit code, write tests if needed
npm run build          # TypeScript → dist/
npm test               # smoke suite must pass (theme, embedder, recall,
                       # corpus_status, identity, md sync, MCP loop)

# 2. Commit and push
git add -p
git commit -m "feat: ..."
git push

# 3. Bump version (edits package.json + creates git tag automatically)
npm version patch      # 0.1.0 → 0.1.1  (fixes)
npm version minor      # 0.1.0 → 0.2.0  (new features)
npm version major      # 0.1.0 → 1.0.0  (breaking changes)

# 4. Push with tag to trigger the Release workflow
git push --follow-tags

# OR: publish manually with OTP (if workflow not configured)
npm run build
npm test
npm publish --access public --ignore-scripts --otp=<6-digit-code>
```

`--ignore-scripts` skips the auto-rebuild during publish — use it when you have already
run `build` and `test` manually, to keep your OTP inside its 30-second window.

---

## Troubleshooting

**Tools not showing up in host**
- Restart the host (it re-reads MCP config on start).
- Verify with `claude mcp list` or check the host's MCP panel.
- Ensure Node ≥ 18 is on PATH: `node --version`.

**"Embedding dim mismatch" error**
- The model cache may be corrupted. Delete `~/.saripati/models/` and restart the MCP server.

**Database locked error**
- Only one writer at a time per vault file. The dashboard and MCP server can coexist (SQLite
  WAL mode allows concurrent reads). Two MCP server instances on the same vault would conflict.

**First tool call very slow**
- Normal — the ~90 MB model is downloading. Subsequent calls are fast. Warm the model at
  server start with `warmup()` (already called in `mcp/server.ts` automatically).

**"saripati not found" in host**
- The host may have launched before `npx` cached the package. Try running
  `npx -y saripati help` once in a terminal to prime the cache, then restart the host.
