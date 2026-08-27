import type { DB } from "../db/db.js";
import {
  vecSearch,
  ftsSearch,
  getEntriesByIds,
  type EntryKind,
  type EntryRow,
} from "../db/queries.js";

/**
 * Hybrid retrieval: fuse semantic (sqlite-vec KNN) and lexical (FTS5 BM25)
 * result lists with Reciprocal Rank Fusion. RRF combines *rankings* rather than
 * raw scores, so we avoid trying to calibrate L2 distance against BM25 — a
 * notoriously fragile normalization. A hit near the top of either list, or
 * present in both, floats up.
 */

const RRF_K = 60;

/**
 * Default per-kind recall multipliers — the Steerer's priority signal. A memo
 * (the agent's note to its future self) outranks an equally-relevant note; open
 * questions and decisions float above raw research. Overridable per call, and
 * persisted per vault via identity.companion_config.recall_boost.
 */
export const DEFAULT_KIND_BOOST: Record<string, number> = {
  memo: 2.0,
  question: 1.5,
  decision: 1.3,
  intention: 1.3,
  pattern: 1.1,
  research: 1.0,
  note: 1.0,
};

export interface HybridResult {
  entry: EntryRow;
  score: number;
  matchedVec: boolean;
  matchedFts: boolean;
}

export interface HybridOptions {
  limit?: number;
  kind?: EntryKind;
  /** Include superseded/archived entries (excluded by default). */
  includeSuperseded?: boolean;
  /** Per-kind score multipliers, merged over DEFAULT_KIND_BOOST. */
  boosts?: Record<string, number>;
}

export function hybridSearch(
  db: DB,
  queryEmbedding: number[],
  queryText: string,
  options: HybridOptions = {},
): HybridResult[] {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 100));
  const candidateCount = Math.max(limit * 4, 20);

  const vhits = vecSearch(db, queryEmbedding, candidateCount);
  const fhits = ftsSearch(db, queryText, candidateCount);

  const scores = new Map<number, number>();
  const inVec = new Set<number>();
  const inFts = new Set<number>();

  vhits.forEach((h, rank) => {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + rank + 1));
    inVec.add(h.id);
  });
  fhits.forEach((h, rank) => {
    scores.set(h.id, (scores.get(h.id) ?? 0) + 1 / (RRF_K + rank + 1));
    inFts.add(h.id);
  });

  const ids = [...scores.keys()];
  const entryMap = getEntriesByIds(db, ids);
  const boosts = { ...DEFAULT_KIND_BOOST, ...(options.boosts ?? {}) };

  let results: HybridResult[] = ids
    .map((id) => {
      const entry = entryMap.get(id);
      if (!entry) return null;
      const base = scores.get(id) ?? 0;
      return {
        entry,
        score: base * (boosts[entry.kind] ?? 1.0),
        matchedVec: inVec.has(id),
        matchedFts: inFts.has(id),
      } satisfies HybridResult;
    })
    .filter((r): r is HybridResult => r !== null);

  // Superseded + archived entries are old truth — excluded from recall unless
  // the caller explicitly opts in (e.g. auditing decision history).
  if (!options.includeSuperseded) {
    results = results.filter((r) => r.entry.status === "active");
  }

  if (options.kind) {
    results = results.filter((r) => r.entry.kind === options.kind);
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
