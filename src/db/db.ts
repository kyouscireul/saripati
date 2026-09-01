import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SCHEMA_SQL } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { ensureDataDir, resolvePaths, type Paths } from "../config.js";
import { explainNativeFailure, renderIssue } from "../preflight.js";

export type DB = Database.Database;

/**
 * Open (creating if needed) the vault database, load the sqlite-vec extension,
 * and apply the schema idempotently. Safe to call from any command.
 */
export function openDb(paths?: Paths): DB {
  const p = paths ?? resolvePaths();
  ensureDataDir(p);
  mkdirSync(dirname(p.dbPath), { recursive: true });

  // The two native steps. A failure here is almost always an install problem,
  // not a data problem, so translate it into one actionable line on stderr
  // before rethrowing — never onto stdout, which carries MCP JSON-RPC.
  let db: DB;
  try {
    db = new Database(p.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    // sqlite-vec ships a loadable extension; this wires vec0 into this connection.
    sqliteVec.load(db);
  } catch (err) {
    const issue = explainNativeFailure(err);
    if (issue) process.stderr.write(`${renderIssue(issue)}\n`);
    throw err;
  }

  db.exec(SCHEMA_SQL);

  // Bring existing (and fresh) vaults up to the current schema version.
  runMigrations(db);
  return db;
}

/** Serialize a numeric vector into the little-endian float32 BLOB vec0 expects. */
export function vecToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}
