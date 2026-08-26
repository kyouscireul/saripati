/**
 * The SARIPATI vault schema, embedded as a string so it travels with the
 * single-file binary (Tier 3) without a separate .sql asset to copy.
 *
 * Design notes:
 *  - `entries` is the discriminated core knowledge unit (research/note/decision/pattern).
 *  - `vec_entries` (sqlite-vec vec0) and `fts_entries` (FTS5) are kept in sync
 *    manually from queries.ts, keyed by rowid == entries.id. Embeddings are
 *    L2-normalized before insert, so vec0's default L2 KNN ranks identically to cosine.
 *  - JSON is stored as TEXT (tags arrays, next_steps, project metadata) and parsed in JS.
 *  - Timestamps are ISO-ish UTC strings via datetime('now').
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('research','note','decision','pattern')),
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  confidence  REAL,
  tags        TEXT    NOT NULL DEFAULT '[]',
  project     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS entries_kind_idx    ON entries(kind);
CREATE INDEX IF NOT EXISTS entries_project_idx ON entries(project);
CREATE INDEX IF NOT EXISTS entries_created_idx ON entries(created_at DESC);

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  url         TEXT,
  title       TEXT,
  snippet     TEXT,
  accessed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sources_entry_idx ON sources(entry_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  next_steps  TEXT    NOT NULL DEFAULT '[]',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sessions_created_idx ON sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,
  path         TEXT,
  stack        TEXT,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','parked','idea','archived')),
  metadata     TEXT    NOT NULL DEFAULT '{}',
  last_scanned TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
  embedding float[384]
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_entries USING fts5(
  title, body, tags
);
`;

/** Embedding dimensionality produced by the bundled all-MiniLM-L6-v2 model. */
export const EMBEDDING_DIM = 384;
