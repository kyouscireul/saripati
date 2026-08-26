import type { DB } from "./db.js";
import { vecToBlob } from "./db.js";

export type EntryKind = "research" | "note" | "decision" | "pattern";
export type ProjectStatus = "active" | "parked" | "idea" | "archived";

export interface SourceInput {
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
}

export interface Source extends SourceInput {
  id: number;
  entry_id: number;
  accessed_at: string;
}

export interface EntryInput {
  kind: EntryKind;
  title: string;
  body: string;
  confidence?: number | null;
  tags?: string[];
  project?: string | null;
}

export interface EntryRow {
  id: number;
  kind: EntryKind;
  title: string;
  body: string;
  confidence: number | null;
  tags: string[];
  project: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntryWithSources extends EntryRow {
  sources: Source[];
}

interface RawEntryRow extends Omit<EntryRow, "tags"> {
  tags: string;
}

function hydrate(row: RawEntryRow): EntryRow {
  return { ...row, tags: safeParseArray(row.tags) };
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------------
 * Entries + sources
 * ------------------------------------------------------------------------ */

/**
 * Insert an entry plus its embedding (into vec_entries) and full-text row
 * (into fts_entries), all keyed by the new entry id. Returns the entry id.
 */
export function insertEntry(db: DB, input: EntryInput, embedding: number[]): number {
  const tags = JSON.stringify(input.tags ?? []);
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO entries (kind, title, body, confidence, tags, project)
         VALUES (@kind, @title, @body, @confidence, @tags, @project)`,
      )
      .run({
        kind: input.kind,
        title: input.title,
        body: input.body,
        confidence: input.confidence ?? null,
        tags,
        project: input.project ?? null,
      });
    const id = Number(info.lastInsertRowid);

    // vec0 requires a strict INTEGER rowid; better-sqlite3 binds plain JS numbers
    // as REAL, so pass a BigInt to force integer affinity.
    db.prepare(`INSERT INTO vec_entries (rowid, embedding) VALUES (?, ?)`).run(
      BigInt(id),
      vecToBlob(embedding),
    );
    db.prepare(`INSERT INTO fts_entries (rowid, title, body, tags) VALUES (?, ?, ?, ?)`).run(
      id,
      input.title,
      input.body,
      (input.tags ?? []).join(" "),
    );
    return id;
  });
  return tx();
}

export function insertSource(db: DB, entryId: number, src: SourceInput): number {
  const info = db
    .prepare(
      `INSERT INTO sources (entry_id, url, title, snippet)
       VALUES (@entry_id, @url, @title, @snippet)`,
    )
    .run({
      entry_id: entryId,
      url: src.url ?? null,
      title: src.title ?? null,
      snippet: src.snippet ?? null,
    });
  return Number(info.lastInsertRowid);
}

export function getSources(db: DB, entryId: number): Source[] {
  return db
    .prepare(`SELECT * FROM sources WHERE entry_id = ? ORDER BY id`)
    .all(entryId) as Source[];
}

export function getEntry(db: DB, id: number): EntryWithSources | null {
  const raw = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as RawEntryRow | undefined;
  if (!raw) return null;
  return { ...hydrate(raw), sources: getSources(db, id) };
}

export interface ListFilters {
  kind?: EntryKind;
  project?: string;
  since?: string; // ISO date/time lower bound (created_at >= since)
  limit?: number;
}

export function listEntries(db: DB, filters: ListFilters = {}): EntryRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.kind) {
    clauses.push(`kind = @kind`);
    params.kind = filters.kind;
  }
  if (filters.project) {
    clauses.push(`project = @project`);
    params.project = filters.project;
  }
  if (filters.since) {
    clauses.push(`created_at >= @since`);
    params.since = filters.since;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 500));
  const rows = db
    .prepare(`SELECT * FROM entries ${where} ORDER BY created_at DESC LIMIT ${limit}`)
    .all(params) as RawEntryRow[];
  return rows.map(hydrate);
}

export function recentEntries(db: DB, limit = 8): EntryRow[] {
  return listEntries(db, { limit });
}

/* --------------------------------------------------------------------------
 * Search primitives (consumed by search/hybrid.ts)
 * ------------------------------------------------------------------------ */

export interface VecHit {
  id: number;
  distance: number;
}

/** k-nearest neighbours by L2 distance over normalized embeddings (== cosine order). */
export function vecSearch(db: DB, embedding: number[], k: number): VecHit[] {
  return db
    .prepare(
      `SELECT rowid AS id, distance
         FROM vec_entries
        WHERE embedding MATCH ? AND k = ?
        ORDER BY distance`,
    )
    .all(vecToBlob(embedding), k) as VecHit[];
}

export interface FtsHit {
  id: number;
  score: number; // bm25 — lower is better
}

/** Build a safe FTS5 MATCH expression: alnum tokens OR-ed together, each quoted. */
function toMatchExpr(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function ftsSearch(db: DB, query: string, k: number): FtsHit[] {
  const expr = toMatchExpr(query);
  if (!expr) return [];
  return db
    .prepare(
      `SELECT rowid AS id, bm25(fts_entries) AS score
         FROM fts_entries
        WHERE fts_entries MATCH ?
        ORDER BY score
        LIMIT ?`,
    )
    .all(expr, k) as FtsHit[];
}

export function getEntriesByIds(db: DB, ids: number[]): Map<number, EntryRow> {
  const map = new Map<number, EntryRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM entries WHERE id IN (${placeholders})`)
    .all(...ids) as RawEntryRow[];
  for (const r of rows) map.set(r.id, hydrate(r));
  return map;
}

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

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* --------------------------------------------------------------------------
 * Corpus status
 * ------------------------------------------------------------------------ */

export interface CorpusStatus {
  total: number;
  byKind: Record<string, number>;
  topTags: { tag: string; count: number }[];
  projects: number;
  sessions: number;
  lastUpdated: string | null;
}

export function corpusStatus(db: DB): CorpusStatus {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM entries`).get() as { n: number }).n;

  const byKindRows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM entries GROUP BY kind`)
    .all() as { kind: string; n: number }[];
  const byKind: Record<string, number> = {};
  for (const r of byKindRows) byKind[r.kind] = r.n;

  // Tag frequency via json_each over each entry's tags array.
  const tagRows = db
    .prepare(
      `SELECT je.value AS tag, COUNT(*) AS n
         FROM entries, json_each(entries.tags) AS je
        GROUP BY je.value
        ORDER BY n DESC
        LIMIT 20`,
    )
    .all() as { tag: string; n: number }[];
  const topTags = tagRows.map((r) => ({ tag: r.tag, count: r.n }));

  const projects = (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;
  const sessions = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  const lastUpdated =
    (db.prepare(`SELECT MAX(updated_at) AS t FROM entries`).get() as { t: string | null }).t ?? null;

  return { total, byKind, topTags, projects, sessions, lastUpdated };
}
