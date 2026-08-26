# SARIPATI — User Guide

## What It Is

SARIPATI is a **local-first MCP (Model Context Protocol) server** that gives any AI host
a persistent knowledge vault. You keep using whatever AI tool you already use — Claude Code,
Cursor, Windsurf, Cline, Continue. SARIPATI sits underneath it, providing 8 tools the AI
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

## The 8 Tools

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

## The Dashboard

The dashboard is a read-only browser UI over the same vault. It runs independently — you
can open it while the MCP server is running, or standalone.

```bash
npx saripati ui             # default port 4319
npx saripati ui --port 8080 # custom port
npx saripati ui --no-open   # don't auto-open browser
```

**Features:**
- Filter entries by kind (research / note / decision / pattern)
- Click any tag to set it as the search query
- FTS keyword search (same BM25 engine as the MCP tools — no embedder, instant)
- Activity bar chart — entry count per day, last 30 days
- Click any entry to view full body, tags, sources, and metadata
- **Export to Markdown** — downloads the current filtered view as a `.md` file

Search in the dashboard is **keyword-only** (FTS5). Semantic paraphrase recall is only
available through the AI host's `recall` tool call.

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
  npx saripati ui → browse, search, and export the growing corpus
```

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
npm test               # 4-case smoke suite must pass

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
- Only one writer (MCP server) at a time. The dashboard is read-only. A second MCP server
  instance would conflict — ensure only one is running per vault file.

**First tool call very slow**
- Normal — the ~90 MB model is downloading. Subsequent calls are fast. Warm the model at
  server start with `warmup()` (already called in `mcp/server.ts` automatically).

**"saripati not found" in host**
- The host may have launched before `npx` cached the package. Try running
  `npx -y saripati help` once in a terminal to prime the cache, then restart the host.
