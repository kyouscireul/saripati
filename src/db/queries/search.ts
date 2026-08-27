import type { DB } from "../db.js";
import { vecToBlob } from "../db.js";

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
export function toMatchExpr(query: string): string | null {
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
