# SARIPATI — Architecture

## Overview

SARIPATI is a **local-first MCP (Model Context Protocol) server** that gives any AI host a
persistent, compounding knowledge vault. It runs as a child process spawned by the host,
communicates over stdio using JSON-RPC 2.0, and stores all state in a single SQLite file on
the user's machine. It runs no LLM and requires no API keys.

---

## System Context

```mermaid
C4Context
  title SARIPATI — System Context

  Person(user, "User", "Interacts with an AI host (Claude Code, Cursor, Windsurf, etc.)")
  System(host, "AI Host", "Claude Code / Cursor / Windsurf / Cline — spawns SARIPATI as an MCP server")
  System(saripati, "SARIPATI", "Local MCP knowledge vault — stores, embeds, and recalls research")
  SystemDb(vault, "vault.db", "SQLite database on the user's machine (~/.saripati/vault.db)")
  System(dashboard, "Dashboard", "Local HTTP read-only browser UI (saripati ui)")

  Rel(user, host, "Speaks to")
  Rel(host, saripati, "Spawns and calls tools via JSON-RPC over stdio")
  Rel(saripati, vault, "Reads and writes")
  Rel(dashboard, vault, "Reads (read-only)")
  Rel(user, dashboard, "Browses at http://localhost:4319")
```

---

## Component Architecture

```mermaid
graph TD
    subgraph HOST["AI Host Process"]
        H[Host AI]
    end

    subgraph SARIPATI["saripati mcp (child process)"]
        CLI[cli.ts — command dispatcher]
        SRV[mcp/server.ts — McpServer + StdioTransport]
        subgraph TOOLS["Tool Registrations"]
            TR[research.ts — save_research]
            TM[memory.ts — remember / recall]
            TS[session.ts — session_boot / session_save]
            TP[project.ts — project_upsert / project_list]
            TST[status.ts — corpus_status]
        end
        EMB[embed/embedder.ts — MiniLM-L6-v2 via @xenova/transformers]
        SRCH[search/hybrid.ts — Reciprocal Rank Fusion]
        subgraph DB["db/"]
            DBD[db.ts — openDb, WAL, sqlite-vec load]
            DBQ[queries.ts — insertEntry, vecSearch, ftsSearch, ...]
            DBS[schema.ts — SCHEMA_SQL, EMBEDDING_DIM=384]
        end
    end

    subgraph VAULT["~/.saripati/vault.db (SQLite)"]
        T1[(entries)]
        T2[(sources)]
        T3[(sessions)]
        T4[(projects)]
        VT[(vec_entries — sqlite-vec vec0)]
        FT[(fts_entries — FTS5)]
    end

    subgraph UI["saripati ui (separate process)"]
        UIS[ui/server.ts — Node http]
        UIW[ui/web.ts — embedded INDEX_HTML]
    end

    H -- "JSON-RPC over stdio" --> SRV
    CLI --> SRV
    SRV --> TOOLS
    TR --> EMB
    TM --> EMB
    TM --> SRCH
    TOOLS --> DBQ
    EMB --> DBQ
    SRCH --> DBQ
    DBQ --> DBD
    DBD --> DBS
    DBD --> T1
    DBD --> T2
    DBD --> T3
    DBD --> T4
    DBD --> VT
    DBD --> FT
    UIS --> DBQ
    UIS --> UIW
```

---

## Module Responsibilities

| Module | File | Responsibility |
|--------|------|----------------|
| CLI dispatcher | `src/cli.ts` | Parses `process.argv`, lazy-imports the right subcommand |
| Path resolution | `src/config.ts` | Resolves `dataDir`, `dbPath`, `modelCacheDir` from env/flags |
| Database open | `src/db/db.ts` | Opens SQLite, sets WAL + FK pragmas, loads sqlite-vec extension, applies schema |
| Schema | `src/db/schema.ts` | Embedded `SCHEMA_SQL` string; defines `EMBEDDING_DIM = 384` |
| Queries | `src/db/queries.ts` | All SQL: insertEntry (atomic 3-table tx), vecSearch, ftsSearch, upsertProject, etc. |
| Embedder | `src/embed/embedder.ts` | Singleton pipeline: `Xenova/all-MiniLM-L6-v2`, mean-pool + L2-normalize → 384-dim float[] |
| Hybrid search | `src/search/hybrid.ts` | RRF fusion of vec KNN + FTS5 BM25, `RRF_K = 60` |
| MCP server | `src/mcp/server.ts` | Warms model before transport connects, registers all tools, stdio transport, SIGINT/SIGTERM shutdown |
| Tool: research | `src/mcp/tools/research.ts` | `save_research` — embeds, inserts entry + sources |
| Tool: memory | `src/mcp/tools/memory.ts` | `remember` (embed + insert), `recall` (embed + hybridSearch) |
| Tool: session | `src/mcp/tools/session.ts` | `session_boot` (last session + recent entries + active projects), `session_save` |
| Tool: project | `src/mcp/tools/project.ts` | `project_upsert` (JSON-patch merge on conflict), `project_list` |
| Tool: status | `src/mcp/tools/status.ts` | `corpus_status` — aggregates counts, byKind, topTags (json_each), lastUpdated |
| Result helpers | `src/mcp/tools/_result.ts` | `jsonResult`, `textResult`, `deriveTitle`, `excerpt` |
| UI server | `src/ui/server.ts` | Node `http.createServer`, serves `INDEX_HTML` + JSON API endpoints, opens browser |
| UI HTML | `src/ui/web.ts` | Exports `INDEX_HTML` — zero-build, self-contained vanilla JS/CSS |

---

## Data Flow: Write Path (`save_research` / `remember`)

```mermaid
sequenceDiagram
    participant Host as AI Host
    participant MCP as saripati mcp
    participant Emb as embedder.ts
    participant DB as queries.ts (SQLite tx)

    Host->>MCP: tools/call save_research {topic, findings, sources, tags, project}
    MCP->>Emb: embed(topic + findings joined)
    Emb-->>MCP: float[384] (L2-normalized)
    MCP->>DB: insertEntry() — BEGIN TRANSACTION
    DB->>DB: INSERT INTO entries (kind, title, body, ...)
    DB->>DB: INSERT INTO vec_entries (rowid=id, embedding=blob)
    DB->>DB: INSERT INTO fts_entries (rowid=id, title, body, tags)
    DB-->>MCP: entry id
    MCP->>DB: insertSource() × N (for each source)
    DB-->>MCP: source ids
    MCP-->>Host: {content: [{type:"text", text:"Saved research #N ..."}]}
```

**Key invariant:** `insertEntry` is a single `db.transaction()` — `entries`, `vec_entries`,
and `fts_entries` rows are always inserted atomically. If any step fails, all three roll back.

---

## Data Flow: Read Path (`recall`)

```mermaid
sequenceDiagram
    participant Host as AI Host
    participant MCP as saripati mcp
    participant Emb as embedder.ts
    participant Srch as hybrid.ts
    participant DB as queries.ts

    Host->>MCP: tools/call recall {query, limit?, kind?}
    MCP->>Emb: embed(query)
    Emb-->>MCP: float[384]
    MCP->>Srch: hybridSearch(db, embedding, queryText, {limit, kind})
    Srch->>DB: vecSearch(embedding, candidateCount) → VecHit[]
    Srch->>DB: ftsSearch(queryText, candidateCount) → FtsHit[]
    Srch->>Srch: RRF fusion: score[id] += 1 / (60 + rank + 1)
    Srch->>DB: getEntriesByIds(merged id set)
    Srch-->>MCP: HybridResult[] sorted by score desc
    MCP-->>Host: {content: [{type:"text", text:"Recalled N entries..."}]}
```

`candidateCount = max(limit × 4, 20)` — both vec and FTS legs fetch 4× the requested limit
before fusion, then the fused set is sorted and sliced.

---

## Hybrid Search: Reciprocal Rank Fusion

RRF avoids normalizing incompatible score scales (L2 distance vs BM25) by combining
**rankings** rather than raw scores.

```
score(id) = Σ  1 / (RRF_K + rank_i + 1)
            i ∈ {vec, fts} if id appears in that list
```

- `RRF_K = 60` (standard RRF constant, reduces sensitivity to rank-1 outliers)
- rank is 0-indexed within each list
- An entry appearing in **both** lists scores at least `2 / (60 + 1)` ≈ 0.033 — double any
  rank-0 single-list entry's contribution
- `matchedVec` and `matchedFts` booleans are returned per result so the host can see which
  leg(s) produced each hit

---

## Embedding Layer

- **Model:** `Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (ONNX runtime, in-process)
- **Dimensionality:** 384
- **Pooling:** mean-pool over token embeddings
- **Normalization:** L2-normalized → stored as normalized vectors
- **Storage consequence:** because vectors are L2-normalized, `vec_entries`'s default L2 KNN
  distance ranking is equivalent to cosine similarity ranking (L2 on normalized = cosine)
- **Cache:** downloaded once to `<dataDir>/models`, reused offline
- **Singleton:** `pipePromise` is module-level; only one pipeline is ever constructed per process
- **Warmup:** `mcp/server.ts` calls `warmup()` before the transport connects — model load
  output goes to stderr only, never corrupting the JSON-RPC stdout stream

---

## SQLite Configuration

```sql
PRAGMA journal_mode = WAL;    -- concurrent readers while writer is active
PRAGMA foreign_keys = ON;     -- sources.entry_id → entries.id ON DELETE CASCADE
```

`sqlite-vec` is loaded as a dynamic extension via `sqliteVec.load(db)` on every connection
open, wiring the `vec0` virtual table module into that connection.

---

## Stdio Protocol

The host spawns `saripati mcp` (or `npx -y saripati mcp`) as a child process. Communication
is **JSON-RPC 2.0** messages, one per line, over the process's stdin/stdout pair.

```
Host            saripati mcp process
 │                      │
 │── initialize ───────▶│  (protocolVersion, capabilities, clientInfo)
 │◀── result ───────────│  (serverInfo: {name:"saripati", version:"0.1.0"})
 │                      │
 │── tools/list ────────▶│
 │◀── result ───────────│  (8 tool descriptors with inputSchema)
 │                      │
 │── tools/call ────────▶│  (name, arguments)
 │◀── result ───────────│  (content: [{type:"text", text:"..."}])
```

**stdout = JSON-RPC only.** All diagnostic output (model loading, vault path) goes to stderr.

---

## Distribution Tiers

| Tier | Install | Notes |
|------|---------|-------|
| 1 — npm | `npx -y saripati mcp` | Primary path. `npx` fetches on first use, caches locally. |
| 2 — init auto-config | `npx -y saripati init --write` | Writes `mcpServers.saripati` into detected host configs, backs up existing file. |
| 3 — binary | GitHub Release assets | `bun --compile` single-file binaries. Native addon bundling (better-sqlite3, onnxruntime-node) is **unverified**. Treat as best-effort. |

Host detection in `init` scans for: `~/.claude.json` (Claude Code), `~/.cursor/mcp.json`
(Cursor), `~/.codeium/windsurf/mcp_config.json` (Windsurf),
`%APPDATA%/Claude/claude_desktop_config.json` (Claude Desktop).

---

## CI / Release Pipeline

```mermaid
graph LR
    subgraph CI["CI (push to main / PR)"]
        C1[checkout] --> C2[setup-node@20]
        C2 --> C3[cache MiniLM model]
        C3 --> C4[npm ci]
        C4 --> C5[npm run build]
        C5 --> C6[npm test]
    end

    subgraph REL["Release (push tag v*)"]
        R1[npm-publish job] --> R2[npm publish --access public]
        R3[binaries matrix] --> R4[bun build --compile × 3 OS]
        R4 --> R5[GitHub Release assets]
    end
```

Release triggers on any tag matching `v*`. The npm publish job uses `NODE_AUTH_TOKEN` from
repository secrets. The binaries job has `fail-fast: false` — a binary build failure does
not block the npm publish.
