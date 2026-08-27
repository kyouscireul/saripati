/**
 * Retrieval trace — a tiny, ephemeral record of the most recent `vault` recall,
 * so the dashboard can show the user what the agent actually retrieved.
 *
 * The MCP server (which runs recall) and the UI server are separate processes,
 * so the trace crosses the boundary via a small JSON file in the data dir. It is
 * deliberately NOT in the vault DB — it is throwaway observability, overwritten
 * on every recall, and every read/write is best-effort (never fatal).
 */

import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

export interface LastFetch {
  query: string;
  at: string; // ISO timestamp
  results: { id: number; title: string; kind: string; score: number }[];
}

function traceFile(dataDir: string): string {
  return join(dataDir, "last-fetch.json");
}

export function writeLastFetch(dataDir: string, fetch: LastFetch): void {
  try {
    writeFileSync(traceFile(dataDir), JSON.stringify(fetch), "utf8");
  } catch {
    /* observability only — never break a recall over a trace write */
  }
}

export function readLastFetch(dataDir: string): LastFetch | null {
  try {
    return JSON.parse(readFileSync(traceFile(dataDir), "utf8")) as LastFetch;
  } catch {
    return null;
  }
}
