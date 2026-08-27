# SARIPATI

**A local-first, provider-agnostic knowledge vault for any AI host.**

> *sari pati* (Malay) — the essence, the concentrated extract.

Most AI tools start every conversation cold. SARIPATI is the memory layer that sits
*underneath* whatever AI you already use — Claude Code, Cursor, Windsurf, Cline, Continue —
and lets knowledge **compound** across sessions. The AI researches with its own tools; you
call SARIPATI to distill and store the essence. Weeks later, it recalls it semantically.

It is **not** a chat app. It runs no LLM and needs no API keys. Your entire knowledge base
is a single SQLite file on your own machine.

---

## Why

- **Compounding, not disposable.** Research done in a session persists and accumulates by
  topic — the corpus grows every time the agent runs, not only when you take notes.
- **Semantic recall, local.** Bundled embeddings (all-MiniLM-L6-v2) power hybrid
  semantic + keyword search entirely on-device.
- **Knows who it serves.** An optional identity + AI-companion persona (`saripati onboard`)
  loads at session start, so any host can adopt the right voice and address you correctly.
- **Obsidian-compatible.** Mirror the whole vault to a human-editable Markdown folder —
  wikilinks, backlinks, an index — then edit in Obsidian and reconcile changes *back* in.
- **Visible.** A launch-on-demand dashboard makes the growing knowledge base browsable,
  searchable, and exportable.
- **Zero lock-in.** Local SQLite, MIT-licensed, no cloud account, no vendor, zero runtime
  dependencies beyond the embedding + storage engines.

## Non-goals

- Not a chat app or LLM wrapper — it does not run or require an LLM.
- No cloud dependency required.
- Not tied to any single AI host or provider.

---

## Install

### 1. `npx` (recommended)

```bash
npx saripati init          # create the vault, print the config, detect your host
npx saripati init --write  # also register SARIPATI with detected hosts
npx saripati onboard       # (optional) set up your identity + companion persona
```

Then your host connects by **package name** — no folder path, nothing to break:

```json
{
  "mcpServers": {
    "saripati": { "command": "npx", "args": ["-y", "saripati", "mcp"] }
  }
}
```

Restart your AI host. The first `recall`/`save` downloads the ~90 MB embedding model once,
then works offline forever.

### 2. Single binary (no Node required)

Download `saripati` for your platform from the
[Releases](https://github.com/kyou/saripati/releases) page and point your host config at it.

---

## The tools (12)

| Tool | What it does |
|------|--------------|
| `save_research` | Store a structured finding: topic, findings, sources, confidence, tags. |
| `remember` | Capture a note, decision, or reusable pattern. |
| `recall` | Hybrid semantic + keyword search over everything accumulated. |
| `corpus_status` | What the vault holds: counts, top topics, freshness. |
| `session_boot` | Load continuity — **identity**, last session, recent entries, active projects. |
| `session_save` | Write a session digest with next steps. |
| `project_upsert` / `project_list` | A lightweight project registry (metadata merges). |
| `whoami` | Return the vault owner's identity + companion persona. |
| `identity_set` | Create/update identity conversationally (fields merge). |
| `export_md` / `import_md` | Project the vault to Markdown and reconcile edits back. |

A typical flow: the AI does web research with its own tools → calls `save_research` →
next week you (or the AI) `recall` it → open the dashboard to review and export.

---

## Identity — who the vault serves

```bash
npx saripati onboard          # interactive setup (also: --print, --reset)
```

A friendly, five-step setup captures your name, field, working preferences, and an optional
AI-companion persona (pick a starter — *librarian*, *research-assistant*, *plain* — and
customize). It is stored in a singleton `identity` row. From then on, `session_boot` and the
`whoami` tool hand your host that context at the start of a session, so it addresses you
correctly and adopts the right voice. Onboarding is scriptable (`printf ... | saripati
onboard`) as well as interactive.

---

## Markdown mirror — edit in Obsidian, reconcile back

SARIPATI projects the vault to an Obsidian-compatible folder and pulls hand edits back in —
the `.db` stays the single source of truth; the folder is a synced projection.

```bash
npx saripati export --md      # DB → profile/ (IDENTITY.md, MEMORY.md, memory/*.md)
npx saripati import --md      # profile/ → DB (re-embeds changed entries)
npx saripati sync             # export then import in one pass
```

- **`profile/memory/{kind}_{slug}-{id}.md`** — one file per entry: YAML frontmatter, body,
  sources, `[[wikilinks]]`, and a backlinks section. `MEMORY.md` is the index; `IDENTITY.md`
  mirrors your persona.
- **Bidirectional & safe.** An unedited round-trip is a no-op (nothing re-embeds). A body
  edit re-embeds and re-indexes that entry atomically. When *both* the DB and a file change
  since the last sync, `import` reports a **conflict** and leaves the DB untouched —
  `--force-md` lets Markdown win. `--prune` deletes vault entries whose files were removed.
- Hand-create a note (no `id`) in Obsidian → `import` inserts it and back-fills a canonical
  filename + id.

---

## The dashboard

```bash
npx saripati ui                  # opens http://localhost:4319 (write + semantic on by default)
npx saripati ui --no-write       # disable in-browser editing
npx saripati ui --no-semantic    # FTS only — faster cold start, no model load
npx saripati ui --port 8080      # custom port
```

A local browser UI built on **Preact 10 + HTM** (no CDN, no bundler — vendor files served at `/vendor/*.js`). Four tabs, two themes (light default · dark via header pill):

| Tab | What it shows |
|-----|--------------|
| **Entries** | Semantic+keyword search · kind chips · `@project` filter · tag filter · persistent corpus stats footer · entry detail (markdown body, sources, backlinks) + sessions panel on the right |
| **Graph** | Continuous physics force-graph with thermal drift — drag to rearrange (stays on graph), click to open entry |
| **Tags** | All tags ranked by frequency · click to filter Entries tab |
| **Identity** | Profile card · companion persona · latest session · session history (up to 5) |

Write mode and semantic search are **on by default**. Use `--no-write` / `--no-semantic` to disable.

---

## How it works

```
AI host (its own web tools)  ──stdio/MCP──▶  saripati mcp
                                                 │
                    embed (MiniLM 384d) ─────────┤
                    hybrid search (vec ∪ FTS5) ──┤
                                                 ▼
                                    ~/.saripati/vault.db  (SQLite)
                                    ▲            ▲
                    saripati ui ────┘            └──── saripati export/import --md
                    (read-only dashboard)             ↕ profile/ (Obsidian-compatible)
```

- **Storage:** SQLite via `better-sqlite3`.
- **Vectors:** `sqlite-vec` (vec0) — embeddings are L2-normalized so KNN ranks like cosine.
- **Keyword:** SQLite FTS5.
- **Fusion:** Reciprocal Rank Fusion combines the two rankings.
- **Embeddings:** `@xenova/transformers` running all-MiniLM-L6-v2 in-process.
- **Markdown mirror:** hand-rolled, zero-dependency export/import with a `md_sync` merge base.
- **Terminal voice:** a small zero-dep presentation layer (`src/term/theme.ts`) — the framed
  `◈ SARIPATI` wordmark and status frames — degrades to plain ASCII off-TTY and never touches
  the JSON-RPC channel (banners go to stderr).

Data lives in `~/.saripati/` by default (override with `SARIPATI_HOME` or `SARIPATI_DB`).
The Markdown mirror lives in `~/.saripati/profile/`.

---

## Develop

```bash
npm install
npm run build      # tsc → dist/
npm test           # end-to-end smoke test
npm run dev -- mcp # run from source via tsx
```

## License

MIT © Kyou
