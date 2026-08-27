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

    C --> C2["(optional) saripati onboard\n→ identity + companion persona"]
    C2 --> K
    K --> L["Host spawns: node .../cli.js mcp\n(or npx -y saripati mcp)"]
    L --> M["MCP process starts:\n1. resolvePaths()\n2. openDb()\n3. banner() → stderr\n4. warmup() — loads MiniLM model\n5. Register 12 tools\n6. StdioServerTransport.connect()\n7. JSON-RPC ready"]
    M --> N([SARIPATI live — tools available to host])
```

---

## 2. Process Lifecycle (MCP server)

```mermaid
stateDiagram-v2
    [*] --> Starting : Host spawns process

    Starting --> ModelLoading : openDb() succeeds\nstderr: banner() + "saripati: loading embedding model…"
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

    subgraph Edit
        E1([Obsidian edit]) -->|"import --md / import_md"| E2["parseEntryFile()"]
        E2 --> E3["3-way reconcile\n(db vs file vs md_sync base)"]
        E3 -->|"title/body changed"| E4["embed() → updateEntry()\nUPDATE entries + rebuild vec + fts"]
        E3 -->|"conflict"| E5([reported; DB untouched\nunless --force-md])
        E4 --> E6([Entry updated in place])
    end

    subgraph Browse
        B1([User]) -->|"opens localhost:4319"| B2[Dashboard]
        B2 -->|"GET /api/entries?q=..."| B3["ftsSearch() only\n(no embedder in UI)"]
        B3 --> B4([Entries listed])
    end

    C5 -.->|"read by"| R4
    C5 -.->|"read by"| B3
    C5 -.->|"edited via"| E2
```

**Entries are append-only through the *capture* tools** (`save_research`, `remember`) — those
never mutate an existing row. As of v0.2.0, entries **can** be edited or removed through the
Markdown sync path: `import --md` calls `updateEntry()` for a changed file (re-embedding and
rebuilding the vec + FTS rows atomically), and `import --md --prune` calls `deleteEntry()` for
entries whose files were removed. Both preserve the tri-table invariant inside one
transaction. There is still no *in-conversation* MCP tool that edits an entry's body — that
path is deliberately Obsidian-via-import.

---

## 4. Session Lifecycle

A "session" in SARIPATI is a digest record — not a live state. The pattern is:

```mermaid
sequenceDiagram
    participant AI as AI Host
    participant S as saripati

    Note over AI,S: Session START
    AI->>S: tools/call session_boot {}
    S-->>AI: {identity, latest_session, recent_entries[8], active_projects}
    Note over AI: Host adopts persona, reads context, resumes

    Note over AI,S: During session — any number of tool calls
    AI->>S: tools/call save_research / remember / recall / ...
    S-->>AI: results

    Note over AI,S: Session END
    AI->>S: tools/call session_save {title, summary, next_steps[]}
    S-->>AI: {id, next_steps}
    Note over S: Row inserted into sessions table
```

`session_boot` reads `getIdentity(db)` (the singleton persona/profile), `latestSessions(db, 1)`
(one row), `recentEntries(db, 8)` (eight most recent entries by `created_at DESC`), and
`listProjects(db, "active")`. It does not modify state. Multiple `session_save` calls
accumulate — there is no "current session" concept; each call appends a new row.

---

## 4b. Identity Lifecycle

```mermaid
flowchart TD
    A([saripati onboard]) --> B{flag?}
    B -->|"--print"| C["renderIdentity(getIdentity())"]
    B -->|"--reset"| D["clearIdentity() — delete singleton"]
    B -->|interactive / piped| E["5 steps: you → prefs → pick persona → customize → save"]
    E --> F["upsertIdentity(): scalars COALESCE, JSON merges (json_patch)"]
    F --> G([identity row id=1 written])
    G -.->|"read by"| H["session_boot · whoami"]
    G -.->|"exported as"| I["IDENTITY.md (import parses it back)"]
    J([identity_set tool]) --> F
```

The `identity` row is a singleton (`CHECK (id = 1)`). `upsertIdentity` replaces scalar fields
only when provided and **merges** the `user_prefs` / `companion_config` JSON via `json_patch`,
so a host can build the persona incrementally across `identity_set` calls. Onboarding works on
a TTY (readline) or piped (buffered lines) — the same flow, scriptable for CI.

---

## 4c. Markdown Sync Lifecycle

```mermaid
sequenceDiagram
    participant U as User / Host
    participant S as saripati
    participant O as Obsidian

    Note over U,S: Export (DB → MD)
    U->>S: export --md  /  export_md
    S->>S: buildLinkContext + deriveLinks + backlinks
    S->>O: write IDENTITY.md, MEMORY.md, memory/*.md
    S->>S: upsertSyncHash(id, contentHash) — set merge base

    Note over O: User edits a note body in Obsidian

    Note over U,S: Import (MD → DB, 3-way reconcile)
    U->>S: import --md [--force-md] [--prune]
    S->>S: for each file — compare db/file/base hashes
    alt only file changed
        S->>S: embed() + updateEntry() — re-embed, rebuild vec+fts
    else both changed
        S-->>U: conflict (DB untouched) unless --force-md
    else no id (hand-created)
        S->>S: insertEntry() + back-fill id + rename canonical
    end
    S->>S: refresh md_sync base for reconciled entries
```

An unedited export→import reports every entry `unchanged` — the merge base makes it a stable
no-op. `sync` runs export then import in one pass.

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
    B --> C["CI runs on main:\nbuild + test (7 smoke tests must pass)"]
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
MCP server or independently. It opens the same SQLite file; PATCH is always live (write mode
is on by default). SQLite WAL allows concurrent readers with no locking conflicts.

Built on **Preact 10 + HTM** (no CDN, no bundler). Vendor files resolved via CJS path +
`.module.js` suffix and served at `/vendor/preact.js`, `/vendor/hooks.js`, `/vendor/htm.js`.
An `<script type="importmap">` in the HTML resolves the bare `"preact"` specifier used by
`hooks.module.js` in the browser.

Flags are **opt-out** (both on by default):
- **`--no-write`**: disables `PATCH /api/entry/:id` (tags + kind editing).
- **`--no-semantic`**: disables hybrid search — FTS keyword only, no model load.

```mermaid
flowchart LR
    A([User: npx saripati ui]) --> B["resolvePaths()\nopenDb()\nwrite=!--no-write, semantic=!--no-semantic"]
    B --> C["resolveVendor() — preact/hooks/htm .module.js paths\nhttp.createServer() on port 4319"]
    C --> D["openBrowser()"]
    D --> E([Browser opens localhost:4319])
    E --> F["GET / → web.html (Preact 10 + HTM, importmap)\nGET /vendor/*.js → node_modules ESM files"]
    F --> G["fetch /api/config → {writeMode, semanticMode}\nfetch /api/status → corpus + sessions_recent[5]\nfetch /api/entries → initial list"]

    G -->|Entries tab| H["GET /api/entries?q=&kind=&tag=&project=&semantic=1\nGET /api/entry/:id → detail\nGET /api/backlinks/:id → backlinks\nSessions panel ← status.sessions_recent"]
    G -->|Graph tab| I["GET /api/graph → {nodes≤300, edges≤600 via deriveLinks}\nContinuous physics + thermal noise RAF\n120-step pre-warm before first frame"]
    G -->|Tags tab| J["GET /api/tags → [{tag, count}]\nClick → @project or #tag filter on Entries tab"]
    G -->|Identity tab| K["GET /api/identity + /api/status\nHistory: sessions_recent[0] + sessions_recent[1..4]"]

    H -->|write=true| L["PATCH /api/entry/:id {tags?, kind?}\n→ updateEntry() tri-table atomic"]
    H -->|Export btn| M["GET /api/export?q=&kind=&tag= → Markdown download"]
    A -->|Ctrl+C or SIGTERM| N["server.close() + db.close() + process.exit(0)"]
```

**Theme:** Light by default (`data-theme="light"`, `#F5F4EF` bg). Header pill switches to dark.
Persisted in `localStorage`. Graph canvas colours read `data-theme` attribute on each frame.

**Graph physics:** The RAF loop never stops. `physicsStep()` applies repulsion, spring forces,
gravity, and thermal noise (NOISE=0.18) every frame. DAMP=0.88 prevents runaway. Nodes start
on a circle (radius 42% of viewport), pre-warmed 120 ticks (no noise) before first render to
prevent the initial blast. Drag: `dragStart` position recorded; mouseup with < 8px travel = click
(navigates to entry); ≥ 8px = drag release (stays on graph, physics resumes).

**Sessions panel:** Rendered beside the entry detail (240px fixed-width column) using
`status.sessions_recent` already in the `/api/status` response — no extra API call.
