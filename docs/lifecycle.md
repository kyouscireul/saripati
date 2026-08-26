# SARIPATI — Lifecycle

## 1. Installation Lifecycle

```mermaid
flowchart TD
    A([User wants to install SARIPATI]) --> B{Distribution path}

    B -->|Tier 1 — recommended| C["npx saripati init"]
    B -->|Claude Code CLI native| D["claude mcp add saripati -s user\n-- npx -y saripati mcp"]
    B -->|Manual JSON edit| E["Edit host mcpServers config directly"]
    B -->|Tier 3 — binary| F["Download binary from GitHub Releases\nPoint host config at binary path"]

    C --> G["init command runs:\n1. resolvePaths()\n2. openDb() — creates vault.db + schema\n3. Prints config snippet\n4. Lists detected host config files"]
    G --> H{--write flag?}
    H -->|No| I["Prints snippet only\nUser edits host config manually"]
    H -->|Yes| J["mergeIntoHost() for each detected host:\n1. Read existing JSON (if any)\n2. Backup to .bak\n3. Merge mcpServers.saripati key\n4. Write back"]
    I --> K[Restart AI host]
    J --> K
    D --> K
    E --> K
    F --> K

    K --> L["Host spawns: node .../cli.js mcp\n(or npx -y saripati mcp)"]
    L --> M["MCP process starts:\n1. resolvePaths()\n2. openDb()\n3. warmup() — loads MiniLM model\n4. Register 8 tools\n5. StdioServerTransport.connect()\n6. JSON-RPC ready"]
    M --> N([SARIPATI live — tools available to host])
```

---

## 2. Process Lifecycle (MCP server)

```mermaid
stateDiagram-v2
    [*] --> Starting : Host spawns process

    Starting --> ModelLoading : openDb() succeeds\nstderr: "saripati: loading embedding model…"
    ModelLoading --> Ready : warmup() resolves\nstderr: "saripati: model ready."\nstderr: "saripati: MCP server ready (vault: ...)"
    ModelLoading --> Ready : warmup() fails (non-fatal)\nstderr: "saripati: warning — embedding model failed to preload"

    Ready --> HandlingTool : Host sends tools/call
    HandlingTool --> Ready : Tool completes, result sent

    Ready --> ShuttingDown : SIGINT or SIGTERM received
    ShuttingDown --> [*] : db.close() + process.exit(0)
```

**Note on warmup failure:** If the model fails to preload (e.g. no internet on first run,
corrupted cache), the server still starts. The first `recall`, `remember`, or `save_research`
call that needs the embedder will attempt to load it again at that point.

---

## 3. Entry Lifecycle

```mermaid
flowchart LR
    subgraph Create
        C1([AI Host]) -->|"tools/call save_research\nor remember"| C2[Tool handler]
        C2 --> C3["embed(text) → float[384]"]
        C3 --> C4["insertEntry() transaction:\nINSERT entries\nINSERT vec_entries\nINSERT fts_entries"]
        C4 --> C5([Entry persisted with id])
    end

    subgraph Recall
        R1([AI Host]) -->|"tools/call recall {query}"| R2[Tool handler]
        R2 --> R3["embed(query) → float[384]"]
        R3 --> R4["vecSearch() → VecHit[]\nftsSearch() → FtsHit[]"]
        R4 --> R5["RRF fusion → ranked id list"]
        R5 --> R6["getEntriesByIds() → EntryRow[]"]
        R6 --> R7([Results returned to host])
    end

    subgraph Browse
        B1([User]) -->|"opens localhost:4319"| B2[Dashboard]
        B2 -->|"GET /api/entries?q=..."| B3["ftsSearch() only\n(no embedder in UI)"]
        B3 --> B4([Entries listed])
    end

    C5 -.->|"read by"| R4
    C5 -.->|"read by"| B3
```

**Entries are never updated or deleted through MCP tools.** The vault is append-only for
entries. Once written, an entry's id, kind, title, body, embedding, and FTS index row are
permanent for the life of the database file.

---

## 4. Session Lifecycle

A "session" in SARIPATI is a digest record — not a live state. The pattern is:

```mermaid
sequenceDiagram
    participant AI as AI Host
    participant S as saripati

    Note over AI,S: Session START
    AI->>S: tools/call session_boot {}
    S-->>AI: {latest_session, recent_entries[8], active_projects}
    Note over AI: Host reads context and resumes

    Note over AI,S: During session — any number of tool calls
    AI->>S: tools/call save_research / remember / recall / ...
    S-->>AI: results

    Note over AI,S: Session END
    AI->>S: tools/call session_save {title, summary, next_steps[]}
    S-->>AI: {id, next_steps}
    Note over S: Row inserted into sessions table
```

`session_boot` reads `latestSessions(db, 1)` (one row), `recentEntries(db, 8)` (eight most
recent entries by `created_at DESC`), and `listProjects(db, "active")`. It does not modify
state. Multiple `session_save` calls accumulate — there is no "current session" concept;
each call appends a new row.

---

## 5. Project Lifecycle

```mermaid
stateDiagram-v2
    [*] --> idea : project_upsert status=idea
    idea --> active : project_upsert status=active
    active --> parked : project_upsert status=parked
    parked --> active : project_upsert status=active
    active --> archived : project_upsert status=archived
    parked --> archived : project_upsert status=archived
    archived --> active : project_upsert status=active

    note right of active : session_boot returns\nactive projects only
```

`project_upsert` uses `INSERT ... ON CONFLICT(name) DO UPDATE`, so calling it with an
existing name performs an update. The `metadata` field is merged via SQLite's `json_patch()`
— passing `{"newKey": "val"}` adds that key without touching existing metadata fields.

---

## 6. Embedding Model Lifecycle

```mermaid
flowchart TD
    A([First embed call in this process]) --> B{"pipePromise\nnull?"}
    B -->|Yes — first time| C["resolvePaths() → modelCacheDir"]
    C --> D["env.cacheDir = modelCacheDir\nenv.allowLocalModels = false"]
    D --> E["pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')"]
    E --> F{Model in cache?}
    F -->|No — first run ever| G["Download ~90 MB ONNX model\nto ~/.saripati/models/"]
    F -->|Yes — subsequent runs| H["Load from disk"]
    G --> I([Pipeline ready])
    H --> I
    B -->|No — already loading/loaded| J["Await existing pipePromise"]
    J --> I
    I --> K["extractor(text, {pooling:'mean', normalize:true})"]
    K --> L["float[384] L2-normalized vector returned"]
```

The singleton `pipePromise` is module-level. In a running `saripati mcp` process,
the model is loaded exactly once (via `warmup()` at startup) and reused for every
subsequent `embed()` call. The warm model adds negligible latency per call.

---

## 7. Update / Release Lifecycle

```mermaid
flowchart TD
    A([Developer: make changes]) --> B["git commit + push to GitHub"]
    B --> C["CI runs on main:\nbuild + test (4 smoke tests must pass)"]
    C --> D{CI green?}
    D -->|No| A
    D -->|Yes| E["npm run build\nnpm test  -- manual pre-flight"]
    E --> F["npm version patch|minor|major\n(edits package.json, creates git tag)"]
    F --> G["git push --follow-tags"]
    G --> H["Release workflow triggers on tag v*"]
    H --> I["npm publish --access public\n(uses NPM_TOKEN secret)"]
    H --> J["bun --compile binaries × 3 OS\n(best-effort, fail-fast:false)"]
    I --> K([New version live on npm])
    J --> L([Binaries attached to GitHub Release])

    K --> M["Users: npx auto-fetches new version\non next invocation"]
```

**Version semantics:**
- `npm version patch` → `0.1.0 → 0.1.1` — bug fixes, no new tools
- `npm version minor` → `0.1.0 → 0.2.0` — new tools or features, backward-compatible
- `npm version major` → `0.1.0 → 1.0.0` — breaking schema or tool API changes

The `prepublishOnly` script (`npm run build && npm test`) runs automatically on every
`npm publish`, acting as a final gate.

---

## 8. Dashboard Lifecycle

The dashboard (`saripati ui`) is a separate, independent process — it can run alongside the
MCP server or independently. It opens the same SQLite file in **read-only mode** (all
queries are SELECTs; no writes). Because SQLite WAL mode allows concurrent readers, the
dashboard and the MCP server can operate simultaneously on the same vault file without
locking conflicts.

```mermaid
flowchart LR
    A([User: npx saripati ui]) --> B["resolvePaths()\nopenDb()"]
    B --> C["http.createServer() on port 4319\n(--port to override)"]
    C --> D["openBrowser() — spawn start/open/xdg-open"]
    D --> E([Browser opens localhost:4319])
    E --> F["GET /  → INDEX_HTML"]
    F --> G["Client JS: loadStatus() + loadEntries()"]
    G --> H["GET /api/status → corpusStatus()"]
    G --> I["GET /api/entries → listEntries() or ftsSearch()"]
    I -->|User clicks entry| J["GET /api/entry/:id → getEntry()"]
    I -->|User clicks Export| K["GET /api/export → toMarkdown() download"]
    A -->|Ctrl+C or SIGTERM| L["server.close() + db.close() + process.exit(0)"]
```

The dashboard **does not load the embedding model**. Search in the UI is FTS5 only — fast,
no latency, no model dependency. Semantic recall remains the AI host's job.
