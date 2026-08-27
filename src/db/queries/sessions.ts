import type { DB } from "../db.js";
import { safeParseArray } from "./_json.js";

/* --------------------------------------------------------------------------
 * Sessions
 * ------------------------------------------------------------------------ */

export interface SessionRow {
  id: number;
  title: string;
  summary: string;
  next_steps: string[];
  created_at: string;
}

interface RawSessionRow extends Omit<SessionRow, "next_steps"> {
  next_steps: string;
}

export function insertSession(
  db: DB,
  title: string,
  summary: string,
  nextSteps: string[] = [],
): number {
  const info = db
    .prepare(`INSERT INTO sessions (title, summary, next_steps) VALUES (?, ?, ?)`)
    .run(title, summary, JSON.stringify(nextSteps));
  return Number(info.lastInsertRowid);
}

export function latestSessions(db: DB, limit = 1): SessionRow[] {
  const rows = db
    .prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RawSessionRow[];
  return rows.map((r) => ({ ...r, next_steps: safeParseArray(r.next_steps) }));
}
