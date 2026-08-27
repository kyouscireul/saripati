import type { DB } from "../db.js";
import { vecToBlob } from "../db.js";
import { safeParseArray } from "./_json.js";

export type EntryKind =
  | "research"
  | "note"
  | "decision"
  | "pattern"
  | "question"
  | "memo"
  | "intention";

/** Lifecycle state — superseded/archived entries are deprioritized in recall. */
export type EntryStatus = "active" | "superseded" | "archived";

/** Typed relationship on an explicit entry-to-entry link. */
export type LinkRel = "because-of" | "supersedes" | "related" | "contradicts";

export interface EntryLink {
  id: number;
  rel: LinkRel;
}

/** Parse the `links` JSON column into a well-formed EntryLink[] (tolerant). */
function safeParseLinks(json: string): EntryLink[] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x === "object" && typeof x.id === "number" && typeof x.rel === "string")
      .map((x) => ({ id: x.id as number, rel: x.rel as LinkRel }));
  } catch {
    return [];
  }
}

/** SQLite stores booleans as INTEGER; NULL means "not applicable to this kind". */
function boolToInt(v: boolean | null | undefined): number | null {
  return v === undefined || v === null ? null : v ? 1 : 0;
}

function intToBool(v: number | null): boolean | null {
  return v === null ? null : v !== 0;
}

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
  status?: EntryStatus;
  superseded_by?: number | null;
  links?: EntryLink[];
  /** For kind='question': whether it has been answered. */
  resolved?: boolean | null;
  /** For kind='intention': whether the commitment is still live. */
  active?: boolean | null;
}

export interface EntryRow {
  id: number;
  kind: EntryKind;
  title: string;
  body: string;
  confidence: number | null;
  tags: string[];
  project: string | null;
  status: EntryStatus;
  superseded_by: number | null;
  links: EntryLink[];
  resolved: boolean | null;
  active: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface EntryWithSources extends EntryRow {
  sources: Source[];
}

interface RawEntryRow extends Omit<EntryRow, "tags" | "links" | "resolved" | "active"> {
  tags: string;
  links: string;
  resolved: number | null;
  active: number | null;
}

function hydrate(row: RawEntryRow): EntryRow {
  return {
    ...row,
    tags: safeParseArray(row.tags),
    links: safeParseLinks(row.links),
    resolved: intToBool(row.resolved),
    active: intToBool(row.active),
  };
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
        `INSERT INTO entries
           (kind, title, body, confidence, tags, project, status, superseded_by, links, resolved, active)
         VALUES
           (@kind, @title, @body, @confidence, @tags, @project, @status, @superseded_by, @links, @resolved, @active)`,
      )
      .run({
        kind: input.kind,
        title: input.title,
        body: input.body,
        confidence: input.confidence ?? null,
        tags,
        project: input.project ?? null,
        status: input.status ?? "active",
        superseded_by: input.superseded_by ?? null,
        links: JSON.stringify(input.links ?? []),
        resolved: boolToInt(input.resolved),
        active: boolToInt(input.active),
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
  status?: EntryStatus;
  superseded_by?: number | null;
  links?: EntryLink[];
  resolved?: boolean | null;
  active?: boolean | null;
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
    status: patch.status ?? current.status,
    superseded_by: patch.superseded_by !== undefined ? patch.superseded_by : current.superseded_by,
    links: patch.links ?? safeParseLinks(current.links),
    resolved: patch.resolved !== undefined ? patch.resolved : intToBool(current.resolved),
    active: patch.active !== undefined ? patch.active : intToBool(current.active),
  };
  const tagsJson = JSON.stringify(merged.tags);
  // Only title/body/tags feed the FTS row; lifecycle metadata (status, links,
  // resolved, active, superseded_by) never re-indexes or re-embeds.
  const ftsDirty =
    merged.title !== current.title || merged.body !== current.body || tagsJson !== current.tags;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE entries
          SET kind = @kind, title = @title, body = @body, confidence = @confidence,
              tags = @tags, project = @project, status = @status,
              superseded_by = @superseded_by, links = @links,
              resolved = @resolved, active = @active, updated_at = datetime('now')
        WHERE id = @id`,
    ).run({
      kind: merged.kind,
      title: merged.title,
      body: merged.body,
      confidence: merged.confidence ?? null,
      tags: tagsJson,
      project: merged.project ?? null,
      status: merged.status,
      superseded_by: merged.superseded_by ?? null,
      links: JSON.stringify(merged.links),
      resolved: boolToInt(merged.resolved),
      active: boolToInt(merged.active),
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
 * sources fall away via ON DELETE CASCADE; the vec/fts virtual tables carry no
 * foreign key, so they are cleared explicitly first.
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
 * Steerer signals — the nudges `on` (session_boot) surfaces proactively
 * ------------------------------------------------------------------------ */

/** Active questions still awaiting an answer (resolved is 0 or NULL). */
export function unresolvedQuestions(db: DB, limit = 20): EntryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM entries
        WHERE kind = 'question' AND status = 'active' AND (resolved IS NULL OR resolved = 0)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as RawEntryRow[];
  return rows.map(hydrate);
}

/** Live multi-session commitments (active = 1). */
export function activeIntentions(db: DB, limit = 20): EntryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM entries
        WHERE kind = 'intention' AND status = 'active' AND active = 1
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as RawEntryRow[];
  return rows.map(hydrate);
}

/** Agent-addressed memos, optionally only those created since a timestamp
 *  (approximates "unread since the last session"). */
export function unreadMemos(db: DB, sinceCreatedAt: string | null, limit = 20): EntryRow[] {
  const rows = (
    sinceCreatedAt
      ? db
          .prepare(
            `SELECT * FROM entries
              WHERE kind = 'memo' AND status = 'active' AND created_at > ?
              ORDER BY created_at DESC LIMIT ?`,
          )
          .all(sinceCreatedAt, limit)
      : db
          .prepare(
            `SELECT * FROM entries
              WHERE kind = 'memo' AND status = 'active'
              ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit)
  ) as RawEntryRow[];
  return rows.map(hydrate);
}

/** Most recent entry timestamp per project — the raw staleness signal. */
export function lastEntryAtByProject(db: DB): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT project, MAX(created_at) AS last
         FROM entries WHERE project IS NOT NULL GROUP BY project`,
    )
    .all() as { project: string; last: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.project] = r.last;
  return out;
}
