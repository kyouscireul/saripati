# SARIPATI — Lifecycle

## 1. Installation Lifecycle

```mermaid
flowchart TD
    A([User wants to install SARIPATI]) --> B{Distribution path}

    B -->|Recommended| C["Open ONBOARD.md in AI host\n(AI orchestrates setup conversationally)"]
    B -->|Manual CLI| C2["npx saripati setup ./setup.md --write"]
    B -->|Claude Code CLI native| D["claude mcp add saripati -s user\n-- npx -y saripati mcp"]
    B -->|Manual JSON edit| E["Edit host mcpServers config directly"]

    C --> C2
    C2 --> G["setup command runs:\n1. resolvePaths() (--from override)\n2. openDb() — vault.db + migrations\n3. parse setup.md frontmatter → upsertIdentity\n4. Print config snippet + detected hosts"]
    G --> H{--write flag?}
    H -->|No| I["Prints snippet only\nUser edits host config manually"]
    H -->|Yes| J["mergeIntoHost() for each detected host:\n1. Read existing JSON (if any)\n2. Backup to .bak\n3. Merge mcpServers.saripati key\n4. Write back"]
    I --> K[Restart AI host]
    J --> K
    D --> K
    E --> K

    K --> L["Host spawns: node .../cli.js mcp\n(or npx -y saripati mcp)"]
    L --> M["MCP process starts:\n1. resolvePaths()\n2. openDb() + runMigrations()\n3. banner() → stderr\n4. warmup() — loads MiniLM (heartbeat)\n5. Register 9 tools\n6. StdioServerTransport.connect()\n7. JSON-RPC ready"]
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
corrupted cache), the server still starts. The first `vault` call that needs the embedder
will attempt to load it again at that point. During load, an elapsed-time heartbeat is written
to stderr every ~12s so the process never looks hung.

---

## 3. Entry Lifecycle

```mermaid
flowchart LR
    subgraph Create
        C1([AI Host]) -->|"tools/call vault\n{findings|content}"| C2[vault handler]
        C2 --> C3["embed(title+body) → float[384]"]
        C3 --> C4["insertEntry() transaction:\nINSERT entries\nINSERT vec_entries\nINSERT fts_entries"]
        C4 --> C4b["detectConflicts() — vec check\nvs the new entry"]
        C4b --> C5([Entry persisted + conflicts?])
    end

    subgraph Recall
        R1([AI Host]) -->|"tools/call vault {query}"| R2[vault handler]
        R2 --> R3["embed(query) → float[384]"]
        R3 --> R4["vecSearch() + ftsSearch()"]
        R4 --> R5["RRF × per-kind boost;\ndrop superseded/archived"]
        R5 --> R6["getEntriesByIds() → EntryRow[]"]
        R6 --> R6b["writeLastFetch() — UI trace"]
        R6b --> R7([Results returned to host])
    end

    subgraph Lifecycle
        E1([AI Host]) -->|"tools/call entry_update {id,...}"| E2["updateEntry() — metadata only"]
        E2 --> E3["status=superseded / superseded_by\nresolved / active / tags / links"]
        E3 --> E6([Entry mutated; no re-embed])
    end

    subgraph Browse
        B1([User]) -->|"opens localhost:4319"| B2[Dashboard]
        B2 -->|"GET /api/entries?q=..."| B3["hybrid or FTS search"]
        B3 --> B4([Entries listed])
    end

    C5 -.->|"read by"| R4
    C5 -.->|"read by"| B3
    C5 -.->|"superseded via"| E2
```

**Entries are append-only through `vault` saves** — a save never mutates an existing row, but
it *does* run a conflict check and hand back near-duplicates. Lifecycle changes go through
`entry_update` (metadata-only: status, `superseded_by`, `links`, `resolved`, `active`, tags,
kind) — it never touches the body and never re-embeds. Only a title/body change (not exposed
as an in-conversation tool) would re-embed; `deleteEntry()` remains internal. All paths
preserve the tri-table invariant inside one transaction.

---

## 4. Session Lifecycle

A "session" in SARIPATI is a digest record — not a live state. The pattern is:

```mermaid
sequenceDiagram
    participant AI as AI Host
    participant S as saripati

    Note over AI,S: Session START
    AI->>S: tools/call on {}
    S-->>AI: {identity, focus, latest_session, recent_entries[8], active_projects, nudges}
    Note over AI: Host adopts persona, surfaces nudges, resumes

    Note over AI,S: During session — any number of tool calls
    AI->>S: tools/call vault / entry_update / corpus / ...
    S-->>AI: results

    Note over AI,S: Session END
    AI->>S: tools/call off {title, summary, next_steps[]}
    S-->>AI: {id, next_steps}
    Note over S: Row inserted into sessions table
```

`on` reads `getIdentity(db)` (the singleton persona/profile — including `user_prefs.focus`,
which biases recent entries), `latestSessions(db, 1)`, `recentEntries(db, 8)`, and
`listProjects(db, "active")`. It also computes **nudges**: `unresolvedQuestions`,
`activeIntentions`, `unreadMemos` (created since the last session), and `stale_projects`. It
does not modify state. Multiple `off` calls accumulate — each appends a new session row.

---

## 4b. Identity Lifecycle

```mermaid
flowchart TD
    A([saripati setup ./setup.md]) --> E["parse YAML frontmatter\nname · field · skills · language · companion"]
    E --> F["upsertIdentity(): scalars COALESCE, JSON merges (json_patch)"]
    F --> G([identity row id=1 written])
    G -.->|"read by"| H["on · whoami"]
    J([identity_set tool]) --> F
```

The `identity` row is a singleton (`CHECK (id = 1)`). `upsertIdentity` replaces scalar fields
only when provided and **merges** the `user_prefs` / `companion_config` JSON via `json_patch`,
so a host can build the persona incrementally across `identity_set` calls — including vault
tuning like `recall_boost`, `conflict_threshold`, `stale_days`, and `focus`.

---

## 5. Project Lifecycle

```mermaid
stateDiagram-v2
    [*] --> idea : project_update status=idea
    idea --> active : project_update status=active
    active --> parked : project_update status=parked
    parked --> active : project_update status=active
    active --> archived : project_update status=archived
    parked --> archived : project_update status=archived
    archived --> active : project_update status=active

    note right of active : on returns active projects only\n(flags stale ones as a nudge)
```

`project_update` uses `INSERT ... ON CONFLICT(name) DO UPDATE`, so calling it with an
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
    B --> C["CI runs on main:\nbuild + test (smoke suite must pass)"]
    C --> D{CI green?}
    D -->|No| A
    D -->|Yes| E["npm run build\nnpm test  -- manual pre-flight"]
    E --> F["npm version patch|minor|major\n(edits package.json, creates git tag)"]
    F --> G["git push --follow-tags"]
    G --> H["npm publish --access public\n--ignore-scripts --otp=<code>"]
    H --> K([New version live on npm])
    K --> M["Users: npx auto-fetches new version\non next invocation"]
```

**Version semantics:**
- `npm version patch` → bug fixes, no new tools
- `npm version minor` → new tools or features (e.g. `0.2.0 → 0.3.0`)
- `npm version major` → breaking schema or tool API changes

Publishing is done manually with a fresh OTP (the npm account uses TOTP 2FA);
`--ignore-scripts` keeps the OTP inside its ~30-second window after a manual `build` + `test`.
Single-file binaries were removed in v0.3.0 (native addons can't be bundled cleanly).

---

## 8. Dashboard Lifecycle

The dashboard (`saripati ui`) is a separate, independent process — it can run alongside the
MCP server or independently. It opens the same SQLite file and is **read-only by default**;
PATCH is enabled only with `--write`. SQLite WAL allows concurrent readers with no locking.

Built on **Preact 10 + HTM** (no CDN, no bundler). The ESM bundles are **vendored into the
package** (`dist/vendor/*.module.js`, copied at build time) and served at `/vendor/preact.js`,
`/vendor/hooks.js`, `/vendor/htm.js`; in dev (no build) the server falls back to resolving them
from `node_modules`. So `preact`/`htm` are devDependencies, absent from production installs.

Flags:
- **`--write`**: enables `PATCH /api/entry/:id` (tags + kind editing). Off by default.
- **`--no-semantic`**: disables hybrid search — FTS keyword only, no model load.

```mermaid
flowchart LR
    A([User: npx saripati ui]) --> B["resolvePaths()\nopenDb()\nwrite=--write, semantic=!--no-semantic"]
    B --> C["vendorPath() — dist/vendor/*.module.js (or node_modules in dev)\nhttp.createServer() on port 4319"]
    C --> D["openBrowser()"]
    D --> E([Browser opens localhost:4319])
    E --> F["GET / → web.html (Preact 10 + HTM, importmap)\nGET /vendor/*.js → vendored ESM"]
    F --> G["fetch /api/config → {writeMode, semanticMode}\nfetch /api/status → corpus + sessions_recent[5]\nfetch /api/last-fetch → agent's last recall\nfetch /api/entries → initial list"]

    G -->|Entries tab| H["GET /api/entries?q=&kind=&tag=&project=&semantic=1\nGET /api/entry/:id → detail (+ status badge)\nGET /api/backlinks/:id → backlinks"]
    G -->|Graph tab| I["GET /api/graph → {nodes≤150, edges≤600 via deriveLinks}\nStrongest type per pair: relation > wikilink > project > tag\nPhysics RAF: noise seeding → run to convergence → auto-fit once"]
    G -->|Tags tab| J["GET /api/tags → [{tag, count}]"]
    G -->|Identity tab| K["GET /api/identity + /api/status"]

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
