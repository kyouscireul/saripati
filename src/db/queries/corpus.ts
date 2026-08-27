import type { DB } from "../db.js";

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
