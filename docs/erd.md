# SARIPATI — Entity Relationship Diagram

All state lives in a single SQLite file (`~/.saripati/vault.db` by default).
There are five regular tables, two virtual tables (one per index), an embedded
string constant (`SCHEMA_SQL`) that defines the baseline schema, and a versioned
migration runner (`PRAGMA user_version`) that upgrades existing vaults on open.

> **v0.3.0** widened `entries.kind` to seven kinds and added lifecycle columns
> (`status`, `superseded_by`, `links`, `resolved`, `active`). The Markdown-sync
> `md_sync` table was retired. Existing vaults upgrade in place via migration 2
> (a safe table rebuild — SQLite cannot alter a CHECK constraint otherwise).

---

## ERD

```mermaid
erDiagram
    entries {
        INTEGER id PK "AUTOINCREMENT"
        TEXT    kind   "CHECK: research|note|decision|pattern|question|memo|intention"
        TEXT    title  "NOT NULL"
        TEXT    body   "NOT NULL"
        REAL    confidence "nullable — 0.0 to 1.0, or NULL = explicitly unknown"
        TEXT    tags   "JSON array TEXT, DEFAULT '[]'"
        TEXT    project "nullable FK-by-name to projects.name"
        TEXT    status "CHECK: active|superseded|archived, DEFAULT active"
        INTEGER superseded_by "nullable — id of the replacing entry"
        TEXT    links  "JSON array TEXT of {id,rel}, DEFAULT '[]'"
        INTEGER resolved "nullable 0/1 — for kind=question"
        INTEGER active   "nullable 0/1 — for kind=intention"
        TEXT    created_at "datetime('now') UTC"
        TEXT    updated_at "datetime('now') UTC"
    }

    sources {
        INTEGER id PK "AUTOINCREMENT"
        INTEGER entry_id FK "REFERENCES entries(id) ON DELETE CASCADE"
        TEXT    url      "nullable"
        TEXT    title    "nullable"
        TEXT    snippet  "nullable"
        TEXT    accessed_at "datetime('now') UTC"
    }

    sessions {
        INTEGER id PK "AUTOINCREMENT"
        TEXT    title      "NOT NULL"
        TEXT    summary    "NOT NULL"
        TEXT    next_steps "JSON array TEXT, DEFAULT '[]'"
        TEXT    created_at "datetime('now') UTC"
    }

    projects {
        INTEGER id PK "AUTOINCREMENT"
        TEXT    name         "UNIQUE NOT NULL — the natural key"
        TEXT    path         "nullable filesystem path"
        TEXT    stack        "nullable tech stack summary"
        TEXT    status       "CHECK: active|parked|idea|archived, DEFAULT active"
        TEXT    metadata     "JSON object TEXT, DEFAULT '{}'"
        TEXT    last_scanned "nullable ISO datetime"
        TEXT    created_at   "datetime('now') UTC"
        TEXT    updated_at   "datetime('now') UTC"
    }

    identity {
        INTEGER id PK "CHECK id = 1 — singleton row"
        TEXT    user_name        "nullable"
        TEXT    user_field       "nullable"
        TEXT    user_prefs       "JSON object TEXT, DEFAULT '{}'"
        TEXT    companion_name   "nullable"
        TEXT    companion_role   "nullable"
        TEXT    companion_tone   "nullable"
        TEXT    companion_config "JSON object TEXT, DEFAULT '{}'"
        TEXT    created_at "datetime('now') UTC"
        TEXT    updated_at "datetime('now') UTC"
    }

    vec_entries {
        INTEGER rowid     "== entries.id"
        BLOB    embedding "float[384] little-endian float32, L2-normalized"
    }

    fts_entries {
        INTEGER rowid "== entries.id"
        TEXT    title "mirrored from entries.title"
        TEXT    body  "mirrored from entries.body"
        TEXT    tags  "entries.tags array joined as space-separated string"
    }

    entries ||--o{ sources     : "has"
    entries ||--|| vec_entries : "has embedding (rowid sync)"
    entries ||--|| fts_entries : "has FTS index (rowid sync)"
```

---

## Table Notes

### `entries`

The central knowledge unit. `kind` is a discriminator:

| kind | description |
|------|-------------|
| `research` | Structured finding: topic → findings list → sources (`vault` with `findings`) |
| `note` | Free-form text captured by the host AI |
| `decision` | An explicit decision recorded for future recall |
| `pattern` | A reusable solution or architectural pattern |
| `question` | An open question; `resolved` tracks whether it's answered. Surfaced by `on`. |
| `memo` | The agent's note to its future self; surfaced first by `on`. |
| `intention` | A multi-session commitment; `active` tracks whether it's live. |

All kinds are created through the combined `vault` save tool. **Lifecycle:** `status`
(`active`/`superseded`/`archived`) governs recall — superseded/archived entries are
excluded from default results (retrievable with `include_superseded`). `superseded_by`
points to the replacing entry; `links` holds explicit typed edges (`{id, rel}` where rel ∈
`because-of·supersedes·related·contradicts`).

`tags` and `links` are stored as JSON TEXT arrays, parsed in JavaScript on every read —
there is no native array type in SQLite. `project` is an un-enforced soft reference to
`projects.name` (no foreign key constraint); deletion of a project row does not cascade to
entries.

Indexes:
- `entries_kind_idx` on `(kind)` — filter by kind in `listEntries`
- `entries_project_idx` on `(project)` — filter by project in `listEntries`
- `entries_created_idx` on `(created_at DESC)` — `recentEntries`, default sort
- `entries_status_idx` on `(status)` — exclude superseded/archived in recall

### `sources`

A source is a URL/title/snippet tuple backing a `research` entry. Governed
by `ON DELETE CASCADE` from `entries(id)` — deleting an entry removes its
sources automatically. One entry may have zero or many sources.

### `sessions`

Session digests written by `off`. `next_steps` is a JSON TEXT array of strings.
`on` reads `latestSessions(db, 1)` to return the most recent digest (and uses its
`created_at` as the "unread memos since" cutoff). Sessions are append-only.

### `projects`

A lightweight registry of projects, keyed by `name` (UNIQUE). `metadata` is
a JSON TEXT object that is **merged** on upsert via SQLite's `json_patch()`
function — this means calling `project_update` with a partial metadata object
adds or updates fields without wiping existing ones. `status` controls
filtering in `project_list` and in `on` (which returns only `active` projects,
and flags those with no recent entries as `stale_projects`).

### `identity` (singleton — who the vault serves)

A single row (`CHECK (id = 1)`) holding the vault owner's profile and an optional
AI-companion persona. Scalar fields (`user_name`, `user_field`, `companion_name`,
`companion_role`, `companion_tone`) sit beside two JSON TEXT objects: `user_prefs`
(skills, communication style, address, language) and `companion_config` (extended
persona — traits, values, habits, and vault tuning like `recall_boost`,
`conflict_threshold`, `stale_days`). Written by `saripati setup` and the
`identity_set` MCP tool. `upsertIdentity` mirrors `upsertProject`: scalar fields
replace via `COALESCE` (a partial update preserves prior values) while the JSON
objects **merge** via `json_patch()`, so the persona can be built incrementally.
`getIdentity` returns it; `on` embeds it and reads `user_prefs.focus` to bias recall.

### `vec_entries` (virtual — sqlite-vec vec0)

A virtual table managed by the `sqlite-vec` extension. `rowid` is kept equal
to `entries.id` (both are inserted in the same `db.transaction()`). The
`embedding` column holds a 384-element `float32` array serialized as a
little-endian BLOB by `vecToBlob()`.

**Normalization invariant:** embeddings are L2-normalized before insert.
Because `vec_entries` uses default L2 KNN, ranking by L2 distance over
normalized vectors is equivalent to ranking by cosine similarity. The
application never has to switch distance metrics.

`vec_entries` is **not** backed by a B-tree index. It is a specialized
structure maintained by sqlite-vec. Direct SQL `SELECT` against it requires
a `WHERE embedding MATCH ? AND k = ?` clause.

### `fts_entries` (virtual — SQLite FTS5)

A full-text search index over three columns: `title`, `body`, and `tags`
(tags are joined into a space-separated string at insert time). BM25 scoring
is used via `bm25(fts_entries)`. Lower BM25 scores are **better** (more
relevant). `ftsSearch()` reverses this convention by sorting ascending before
returning results.

FTS queries are built in `toMatchExpr()` by extracting Unicode letter/number
tokens and OR-ing them with double-quote quoting — `"commission" OR "Lazada"`.
This avoids FTS5 operator injection.

---

## JSON Columns

| Table | Column | Type | Serialized as |
|-------|--------|------|---------------|
| entries | tags | `string[]` | `'["a","b"]'` |
| entries | links | `{id,rel}[]` | `'[{"id":4,"rel":"supersedes"}]'` |
| sessions | next_steps | `string[]` | `'["step 1","step 2"]'` |
| projects | metadata | `Record<string, unknown>` | `'{"key":"val"}'` |
| identity | user_prefs | `Record<string, unknown>` | `'{"language":"English"}'` |
| identity | companion_config | `Record<string, unknown>` | `'{"values":["clarity"]}'` |

All are parsed with `try/catch` guards (`safeParseArray`, `safeParseObject`)
and return an empty array/object on malformed data — never throws at read time.
The two `identity` JSON columns are **merged** on write via SQLite `json_patch()`.

---

## Write Atomicity

`insertEntry()` wraps three inserts in a single `db.transaction()`:

```
BEGIN
  INSERT INTO entries          → produces id
  INSERT INTO vec_entries      → rowid = BigInt(id), embedding = blob
  INSERT INTO fts_entries      → rowid = id, title/body/tags
COMMIT
```

If any of the three fails (e.g. sqlite-vec extension not loaded), the entire
transaction rolls back. The three indexes are always consistent with the
entries table.

Note: `better-sqlite3` requires `BigInt(id)` for the `vec_entries` rowid
because it binds plain JS `number` as SQLite `REAL`, which breaks vec0's
strict integer rowid requirement.

### `updateEntry()` — the same invariant, on the edit path

`updateEntry()` preserves the tri-table invariant inside one `db.transaction()`,
touching each index **only when needed**:

```
BEGIN
  UPDATE entries SET kind/title/body/confidence/tags/project/status/
                     superseded_by/links/resolved/active, updated_at=now
  if embedding supplied (title/body changed):   -- caller re-embeds
      DELETE FROM vec_entries WHERE rowid = BigInt(id)
      INSERT INTO vec_entries (rowid, embedding)
  if title/body/tags changed:
      DELETE FROM fts_entries WHERE rowid = id
      INSERT INTO fts_entries (rowid, title, body, tags)
COMMIT
```

Lifecycle metadata (`status`, `superseded_by`, `links`, `resolved`, `active`) never
re-indexes or re-embeds — the `entry_update` tool is metadata-only by design. Only a
title/body change re-embeds, and re-embedding is the caller's job (`queries.ts` stays
synchronous and pure; the `vault` tool computes the vector).

### `deleteEntry()` — cascade + explicit index cleanup

`sources` falls away via `ON DELETE CASCADE`; the two virtual tables carry no foreign
key, so they are cleared explicitly first, all in one transaction:

```
BEGIN
  DELETE FROM vec_entries WHERE rowid = BigInt(id)
  DELETE FROM fts_entries WHERE rowid = id
  DELETE FROM entries WHERE id = id        -- cascades sources
COMMIT
```

---

## Indexes Summary

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `entries_kind_idx` | entries | `(kind)` | Filter by entry kind |
| `entries_project_idx` | entries | `(project)` | Filter by project name |
| `entries_created_idx` | entries | `(created_at DESC)` | Recent-first listing |
| `entries_status_idx` | entries | `(status)` | Exclude superseded/archived in recall |
| `sources_entry_idx` | sources | `(entry_id)` | Lookup sources by entry |
| `sessions_created_idx` | sessions | `(created_at DESC)` | Most-recent session |
| `vec_entries` | virtual | `embedding float[384]` | L2 KNN via sqlite-vec |
| `fts_entries` | virtual | `title, body, tags` | BM25 keyword search via FTS5 |
