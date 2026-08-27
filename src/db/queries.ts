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

export interface EntryPatch {
  kind?: EntryKind;
  title?: string;
  body?: string;
  confidence?: number | null;
  tags?: string[];
  project?: string | null;
}

/**
 * Update an existing entry while keeping vec_entries + fts_entries in lockstep.
 *
 * All three tables are mutated inside ONE transaction, so a concurrent reader
 * never observes a torn state (the tri-table invariant insertEntry establishes).
 * Re-embedding is the caller's responsibility (this module stays sync + pure):
 * pass `embedding` whenever title/body changed so the vector reflects the new
 * content; omit it for metadata-only edits. The vector row is only rewritten
 * when an embedding is supplied, and the FTS row only when title/body/tags
 * actually changed — metadata-only edits touch neither index. Returns the
 * updated row, or null if the id does not exist.
 */
export function updateEntry(
  db: DB,
  id: number,
  patch: EntryPatch,
  embedding?: number[],
): EntryRow | null {
  const current = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as RawEntryRow | undefined;
  if (!current) return null;

  const merged = {
    kind: patch.kind ?? current.kind,
    title: patch.title ?? current.title,
    body: patch.body ?? current.body,
    confidence: patch.confidence !== undefined ? patch.confidence : current.confidence,
    tags: patch.tags ?? safeParseArray(current.tags),
    project: patch.project !== undefined ? patch.project : current.project,
  };
  const tagsJson = JSON.stringify(merged.tags);
  const ftsDirty =
    merged.title !== current.title || merged.body !== current.body || tagsJson !== current.tags;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE entries
          SET kind = @kind, title = @title, body = @body, confidence = @confidence,
              tags = @tags, project = @project, updated_at = datetime('now')
        WHERE id = @id`,
    ).run({
      kind: merged.kind,
      title: merged.title,
      body: merged.body,
      confidence: merged.confidence ?? null,
      tags: tagsJson,
      project: merged.project ?? null,
      id,
    });

    if (embedding) {
      // vec0 keys on an INTEGER rowid; bind BigInt to force integer affinity.
      db.prepare(`DELETE FROM vec_entries WHERE rowid = ?`).run(BigInt(id));
      db.prepare(`INSERT INTO vec_entries (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(id),
        vecToBlob(embedding),
      );
    }
    if (ftsDirty) {
      db.prepare(`DELETE FROM fts_entries WHERE rowid = ?`).run(id);
      db.prepare(`INSERT INTO fts_entries (rowid, title, body, tags) VALUES (?, ?, ?, ?)`).run(
        id,
        merged.title,
        merged.body,
        merged.tags.join(" "),
      );
    }
  });
  tx();

  const fresh = db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as RawEntryRow;
  return hydrate(fresh);
}

/**
 * Delete an entry and every index/child row that hangs off it, atomically.
 * sources + md_sync fall away via ON DELETE CASCADE; the vec/fts virtual tables
 * carry no foreign key, so they are cleared explicitly first.
 */
export function deleteEntry(db: DB, id: number): boolean {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM vec_entries WHERE rowid = ?`).run(BigInt(id));
    db.prepare(`DELETE FROM fts_entries WHERE rowid = ?`).run(id);
    return db.prepare(`DELETE FROM entries WHERE id = ?`).run(id).changes;
  });
  return tx() > 0;
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

/** Every entry, oldest first — the whole-corpus view export and link-graph need. */
export function allEntries(db: DB): EntryRow[] {
  const rows = db.prepare(`SELECT * FROM entries ORDER BY id`).all() as RawEntryRow[];
  return rows.map(hydrate);
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
 * Identity (singleton — who this vault belongs to + optional AI companion)
 * ------------------------------------------------------------------------ */

export interface IdentityInput {
  user_name?: string | null;
  user_field?: string | null;
  user_prefs?: Record<string, unknown>;
  companion_name?: string | null;
  companion_role?: string | null;
  companion_tone?: string | null;
  companion_config?: Record<string, unknown>;
}

export interface IdentityRow {
  id: number;
  user_name: string | null;
  user_field: string | null;
  user_prefs: Record<string, unknown>;
  companion_name: string | null;
  companion_role: string | null;
  companion_tone: string | null;
  companion_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface RawIdentityRow extends Omit<IdentityRow, "user_prefs" | "companion_config"> {
  user_prefs: string;
  companion_config: string;
}

function hydrateIdentity(raw: RawIdentityRow): IdentityRow {
  return {
    ...raw,
    user_prefs: safeParseObject(raw.user_prefs),
    companion_config: safeParseObject(raw.companion_config),
  };
}

export function getIdentity(db: DB): IdentityRow | null {
  const raw = db.prepare(`SELECT * FROM identity WHERE id = 1`).get() as RawIdentityRow | undefined;
  return raw ? hydrateIdentity(raw) : null;
}

/**
 * Insert or update the singleton identity row. Scalar fields are only replaced
 * when provided (COALESCE); the JSON prefs/config objects are merged (json_patch)
 * so callers can build the persona incrementally — mirrors upsertProject.
 */
export function upsertIdentity(db: DB, input: IdentityInput): IdentityRow {
  db.prepare(
    `INSERT INTO identity
       (id, user_name, user_field, user_prefs, companion_name, companion_role, companion_tone, companion_config, updated_at)
     VALUES
       (1, @user_name, @user_field, @user_prefs, @companion_name, @companion_role, @companion_tone, @companion_config, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       user_name        = COALESCE(excluded.user_name, identity.user_name),
       user_field       = COALESCE(excluded.user_field, identity.user_field),
       user_prefs       = json_patch(identity.user_prefs, excluded.user_prefs),
       companion_name   = COALESCE(excluded.companion_name, identity.companion_name),
       companion_role   = COALESCE(excluded.companion_role, identity.companion_role),
       companion_tone   = COALESCE(excluded.companion_tone, identity.companion_tone),
       companion_config = json_patch(identity.companion_config, excluded.companion_config),
       updated_at       = datetime('now')`,
  ).run({
    user_name: input.user_name ?? null,
    user_field: input.user_field ?? null,
    user_prefs: JSON.stringify(input.user_prefs ?? {}),
    companion_name: input.companion_name ?? null,
    companion_role: input.companion_role ?? null,
    companion_tone: input.companion_tone ?? null,
    companion_config: JSON.stringify(input.companion_config ?? {}),
  });
  return getIdentity(db)!;
}

/** Clear the singleton identity row (used by `saripati onboard --reset`). */
export function clearIdentity(db: DB): void {
  db.prepare(`DELETE FROM identity WHERE id = 1`).run();
}

/* --------------------------------------------------------------------------
 * MD sync manifest — the 3-way merge base for bidirectional Markdown sync
 * ------------------------------------------------------------------------ */

/** The last-synced content hash for an entry, or null if never synced. */
export function getSyncHash(db: DB, entryId: number): string | null {
  const r = db.prepare(`SELECT md_hash FROM md_sync WHERE entry_id = ?`).get(entryId) as
    | { md_hash: string }
    | undefined;
  return r?.md_hash ?? null;
}

/** Record (or refresh) the merge base after a successful export/import. */
export function upsertSyncHash(db: DB, entryId: number, hash: string): void {
  db.prepare(
    `INSERT INTO md_sync (entry_id, md_hash, synced_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(entry_id) DO UPDATE SET md_hash = excluded.md_hash, synced_at = datetime('now')`,
  ).run(entryId, hash);
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
