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
- **Visible.** A launch-on-demand dashboard makes the growing knowledge base browsable,
  searchable, and exportable.
- **Zero lock-in.** Local SQLite, MIT-licensed, no cloud account, no vendor.

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

## The tools

| Tool | What it does |
|------|--------------|
| `save_research` | Store a structured finding: topic, findings, sources, confidence, tags. |
| `remember` | Capture a note, decision, or reusable pattern. |
| `recall` | Hybrid semantic + keyword search over everything accumulated. |
| `corpus_status` | What the vault holds: counts, top topics, freshness. |
| `session_boot` | Load continuity — last session, recent entries, active projects. |
| `session_save` | Write a session digest with next steps. |
| `project_upsert` / `project_list` | A lightweight project registry (metadata merges). |

A typical flow: the AI does web research with its own tools → calls `save_research` →
next week you (or the AI) `recall` it → open the dashboard to review and export.

---

## The dashboard

```bash
npx saripati ui        # opens http://localhost:4319
```

Browse and search the corpus, inspect entries and their sources, see activity over time,
and export any filtered view to Markdown (print to PDF from your browser). Read-only; it
reads the same vault the MCP server writes.

---

## How it works

```
AI host (its own web tools)  ──stdio/MCP──▶  saripati mcp
                                                 │
                    embed (MiniLM 384d) ─────────┤
                    hybrid search (vec ∪ FTS5) ──┤
                                                 ▼
                                    ~/.saripati/vault.db  (SQLite)
                                                 ▲
                                    saripati ui ─┘ (read-only dashboard)
```

- **Storage:** SQLite via `better-sqlite3`.
- **Vectors:** `sqlite-vec` (vec0) — embeddings are L2-normalized so KNN ranks like cosine.
- **Keyword:** SQLite FTS5.
- **Fusion:** Reciprocal Rank Fusion combines the two rankings.
- **Embeddings:** `@xenova/transformers` running all-MiniLM-L6-v2 in-process.

Data lives in `~/.saripati/` by default (override with `SARIPATI_HOME` or `SARIPATI_DB`).

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
