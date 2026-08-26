# SARIPATI — Entity Relationship Diagram

All state lives in a single SQLite file (`~/.saripati/vault.db` by default).
There are four regular tables, two virtual tables (one per index), and one
embedded string constant that defines the entire schema.

---

## ERD

```mermaid
erDiagram
    entries {
        INTEGER id PK "AUTOINCREMENT"
        TEXT    kind   "CHECK: research|note|decision|pattern"
        TEXT    title  "NOT NULL"
        TEXT    body   "NOT NULL"
        REAL    confidence "nullable — 0.0 to 1.0"
        TEXT    tags   "JSON array TEXT, DEFAULT '[]'"
        TEXT    project "nullable FK-by-name to projects.name"
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

| kind | created by | description |
|------|-----------|-------------|
| `research` | `save_research` | Structured finding: topic → findings list → sources |
| `note` | `remember` | Free-form text captured by the host AI |
| `decision` | `remember` | An explicit decision recorded for future recall |
| `pattern` | `remember` | A reusable solution or architectural pattern |

`tags` is stored as a JSON TEXT array (`["lazada","affiliate"]`). It is
parsed in JavaScript by `safeParseArray()` on every read — there is no
native array type in SQLite. `project` is an un-enforced soft reference to
`projects.name` (no foreign key constraint); deletion of a project row does
not cascade to entries.

Indexes:
- `entries_kind_idx` on `(kind)` — filter by kind in `listEntries`
- `entries_project_idx` on `(project)` — filter by project in `listEntries`
- `entries_created_idx` on `(created_at DESC)` — `recentEntries`, default sort

### `sources`

A source is a URL/title/snippet tuple backing a `research` entry. Governed
by `ON DELETE CASCADE` from `entries(id)` — deleting an entry removes its
sources automatically. One entry may have zero or many sources.

### `sessions`

Session digests written by `session_save`. `next_steps` is a JSON TEXT array
of strings. `session_boot` reads `latestSessions(db, 1)` to return the most
recent digest. Sessions are append-only; there is no update path.

### `projects`

A lightweight registry of projects, keyed by `name` (UNIQUE). `metadata` is
a JSON TEXT object that is **merged** on upsert via SQLite's `json_patch()`
function — this means calling `project_upsert` with a partial metadata object
adds or updates fields without wiping existing ones. `status` controls
filtering in `project_list` and in `session_boot` (which returns only
`active` projects).

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
| sessions | next_steps | `string[]` | `'["step 1","step 2"]'` |
| projects | metadata | `Record<string, unknown>` | `'{"key":"val"}'` |

All three are parsed with `try/catch` guards (`safeParseArray`, `safeParseObject`)
and return an empty array/object on malformed data — never throws at read time.

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

---

## Indexes Summary

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `entries_kind_idx` | entries | `(kind)` | Filter by entry kind |
| `entries_project_idx` | entries | `(project)` | Filter by project name |
| `entries_created_idx` | entries | `(created_at DESC)` | Recent-first listing |
| `sources_entry_idx` | sources | `(entry_id)` | Lookup sources by entry |
| `sessions_created_idx` | sessions | `(created_at DESC)` | Most-recent session |
| `vec_entries` | virtual | `embedding float[384]` | L2 KNN via sqlite-vec |
| `fts_entries` | virtual | `title, body, tags` | BM25 keyword search via FTS5 |
