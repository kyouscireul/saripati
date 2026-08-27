import type { DB } from "../db.js";
import { safeParseObject } from "./_json.js";

export type ProjectStatus = "active" | "parked" | "idea" | "archived";

/* --------------------------------------------------------------------------
 * Projects
 * ------------------------------------------------------------------------ */

export interface ProjectInput {
  name: string;
  path?: string | null;
  stack?: string | null;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
  last_scanned?: string | null;
}

export interface ProjectRow {
  id: number;
  name: string;
  path: string | null;
  stack: string | null;
  status: ProjectStatus;
  metadata: Record<string, unknown>;
  last_scanned: string | null;
  created_at: string;
  updated_at: string;
}

interface RawProjectRow extends Omit<ProjectRow, "metadata"> {
  metadata: string;
}

export function upsertProject(db: DB, input: ProjectInput): ProjectRow {
  db.prepare(
    `INSERT INTO projects (name, path, stack, status, metadata, last_scanned, updated_at)
     VALUES (@name, @path, @stack, @status, @metadata, @last_scanned, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET
       path         = COALESCE(excluded.path, projects.path),
       stack        = COALESCE(excluded.stack, projects.stack),
       status       = excluded.status,
       metadata     = json_patch(projects.metadata, excluded.metadata),
       last_scanned = COALESCE(excluded.last_scanned, projects.last_scanned),
       updated_at   = datetime('now')`,
  ).run({
    name: input.name,
    path: input.path ?? null,
    stack: input.stack ?? null,
    status: input.status ?? "active",
    metadata: JSON.stringify(input.metadata ?? {}),
    last_scanned: input.last_scanned ?? null,
  });
  const raw = db.prepare(`SELECT * FROM projects WHERE name = ?`).get(input.name) as RawProjectRow;
  return { ...raw, metadata: safeParseObject(raw.metadata) };
}

export function listProjects(db: DB, status?: ProjectStatus): ProjectRow[] {
  const rows = (
    status
      ? db.prepare(`SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC`).all(status)
      : db.prepare(`SELECT * FROM projects ORDER BY updated_at DESC`).all()
  ) as RawProjectRow[];
  return rows.map((r) => ({ ...r, metadata: safeParseObject(r.metadata) }));
}
