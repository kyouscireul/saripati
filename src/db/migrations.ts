/**
 * Schema migrations — versioned, forward-only upgrades tracked via
 * `PRAGMA user_version`.
 *
 * Why this exists: `SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS`, which is
 * idempotent but NOT migrational — it never alters an existing table. A vault
 * created by v0.2.0 would silently miss any column a later release adds. The
 * runner below closes that gap: on every `openDb`, it reads the DB's
 * `user_version` and applies each pending numbered migration in order, in a
 * transaction, then stamps the new version.
 *
 * Rules:
 *  - `SCHEMA_SQL` stays the *baseline* (v0.2.0) shape for brand-new vaults.
 *    Everything that changed since is expressed here as a migration, so this
 *    file is the single source of truth for "what changed and when".
 *  - Migrations are forward-only and must be idempotent-safe against a fresh DB
 *    (a new vault runs SCHEMA_SQL then every migration, so migration N must
 *    cope with the baseline shape).
 *  - Foreign keys are disabled around the run: SQLite's safe table-rebuild
 *    procedure (needed to widen CHECK constraints) requires it, and the toggle
 *    cannot happen inside a transaction.
 */

import type { DB } from "./db.js";

/** The schema version this build expects. Bump when adding a migration. */
export const SCHEMA_VERSION = 2;

/**
 * Numbered migrations. Version 1 is the v0.2.0 baseline — a no-op, because
 * SCHEMA_SQL already produces that shape. Later releases append 2, 3, …
 */
export const MIGRATIONS: Record<number, (db: DB) => void> = {
  1: () => {
    /* baseline — v0.2.0 schema, created by SCHEMA_SQL. Nothing to do. */
  },

  // v0.3.0 — the Steerer schema. Widen the `kind` CHECK to the seven kinds and
  // add the lifecycle columns (status, superseded_by, links, resolved, active).
  // SQLite can't DROP/ALTER a CHECK constraint in place, so this is the safe
  // 12-step table rebuild. The runner has already turned foreign_keys OFF, so
  // dropping `entries` won't cascade into `sources`; ids are copied verbatim,
  // keeping the vec_entries / fts_entries rows (keyed by id) valid.
  2: (db) => {
    db.exec(`
      CREATE TABLE entries_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT    NOT NULL CHECK (kind IN
                        ('research','note','decision','pattern','question','memo','intention')),
        title         TEXT    NOT NULL,
        body          TEXT    NOT NULL,
        confidence    REAL,
        tags          TEXT    NOT NULL DEFAULT '[]',
        project       TEXT,
        status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','superseded','archived')),
        superseded_by INTEGER,
        links         TEXT    NOT NULL DEFAULT '[]',
        resolved      INTEGER,   -- 0/1 for kind='question', else NULL
        active        INTEGER,   -- 0/1 for kind='intention', else NULL
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO entries_new
        (id, kind, title, body, confidence, tags, project, created_at, updated_at)
        SELECT id, kind, title, body, confidence, tags, project, created_at, updated_at
          FROM entries;

      DROP TABLE entries;
      ALTER TABLE entries_new RENAME TO entries;

      CREATE INDEX IF NOT EXISTS entries_kind_idx    ON entries(kind);
      CREATE INDEX IF NOT EXISTS entries_project_idx ON entries(project);
      CREATE INDEX IF NOT EXISTS entries_created_idx ON entries(created_at DESC);
      CREATE INDEX IF NOT EXISTS entries_status_idx  ON entries(status);
    `);
  },
};

/** Read an integer PRAGMA value (better-sqlite3 simple mode). */
function pragmaInt(db: DB, name: string): number {
  return Number(db.pragma(name, { simple: true })) || 0;
}

/**
 * Bring `db` up to SCHEMA_VERSION by running every pending migration in order.
 * Each migration runs in its own transaction and bumps `user_version` on
 * success, so an interrupted upgrade resumes cleanly from the last good step.
 */
export function runMigrations(db: DB): void {
  const current = pragmaInt(db, "user_version");
  if (current >= SCHEMA_VERSION) return;

  const hadForeignKeys = pragmaInt(db, "foreign_keys") === 1;
  if (hadForeignKeys) db.pragma("foreign_keys = OFF"); // must be toggled outside a transaction

  try {
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      const migrate = MIGRATIONS[v];
      const tx = db.transaction(() => {
        if (migrate) migrate(db);
        // PRAGMA user_version does not accept bound parameters; the loop bound
        // is a trusted integer, so interpolation is safe here.
        db.pragma(`user_version = ${v}`);
      });
      tx();
    }
  } finally {
    if (hadForeignKeys) db.pragma("foreign_keys = ON");
  }
}
