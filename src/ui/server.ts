import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { DB } from "../db/db.js";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";
import {
  corpusStatus,
  listEntries,
  ftsSearch,
  getEntriesByIds,
  getEntry,
  latestSessions,
  type EntryKind,
} from "../db/queries.js";
import { INDEX_HTML } from "./web.js";

/**
 * `saripati ui` — a launch-on-demand local dashboard over the same vault the MCP
 * server writes. Read-only. Search here is keyword (FTS) only, so the UI never
 * needs to load the embedding model — semantic recall stays the AI's job.
 */

const KINDS: EntryKind[] = ["research", "note", "decision", "pattern"];

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function parseKind(v: string | null): EntryKind | undefined {
  return v && (KINDS as string[]).includes(v) ? (v as EntryKind) : undefined;
}

function timeline(db: DB): { day: string; count: number }[] {
  return db
    .prepare(
      `SELECT substr(created_at,1,10) AS day, COUNT(*) AS count
         FROM entries GROUP BY day ORDER BY day DESC LIMIT 30`,
    )
    .all() as { day: string; count: number }[];
}

function searchEntries(
  db: DB,
  q: string | null,
  kind: EntryKind | undefined,
  project: string | null,
  limit: number,
) {
  if (q && q.trim()) {
    const hits = ftsSearch(db, q, limit);
    const map = getEntriesByIds(db, hits.map((h) => h.id));
    return hits
      .map((h) => map.get(h.id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .filter((e) => (kind ? e.kind === kind : true))
      .filter((e) => (project ? e.project === project : true));
  }
  return listEntries(db, { kind, project: project ?? undefined, limit });
}

function toMarkdown(db: DB, filterLabel: string, entries: ReturnType<typeof listEntries>): string {
  const lines: string[] = [];
  lines.push(`# SARIPATI Export — ${filterLabel}`);
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(`${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  lines.push("");
  for (const e of entries) {
    const conf = e.confidence != null ? ` · confidence ${e.confidence}` : "";
    lines.push(`## ${e.title}`);
    lines.push(`*${e.kind}${e.project ? ` · ${e.project}` : ""}${conf} · ${e.created_at}*`);
    if (e.tags.length) lines.push(`Tags: ${e.tags.map((t) => `\`${t}\``).join(", ")}`);
    lines.push("");
    lines.push(e.body);
    const full = getEntry(db, e.id);
    if (full && full.sources.length) {
      lines.push("");
      lines.push("**Sources:**");
      for (const s of full.sources) {
        const title = s.title ?? s.url ?? "source";
        const link = s.url ? `[${title}](${s.url})` : title;
        lines.push(`- ${link}${s.snippet ? ` — ${s.snippet}` : ""}`);
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function handle(db: DB, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }

    if (path === "/api/status") {
      json(res, 200, { ...corpusStatus(db), timeline: timeline(db), sessions_recent: latestSessions(db, 5) });
      return;
    }

    if (path === "/api/entries") {
      const q = url.searchParams.get("q");
      const kind = parseKind(url.searchParams.get("kind"));
      const project = url.searchParams.get("project");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      json(res, 200, searchEntries(db, q, kind, project, limit));
      return;
    }

    const entryMatch = path.match(/^\/api\/entry\/(\d+)$/);
    if (entryMatch) {
      const entry = getEntry(db, Number(entryMatch[1]));
      if (!entry) return json(res, 404, { error: "not found" });
      return json(res, 200, entry);
    }

    if (path === "/api/export") {
      const kind = parseKind(url.searchParams.get("kind"));
      const project = url.searchParams.get("project");
      const q = url.searchParams.get("q");
      const entries = searchEntries(db, q, kind, project, 1000);
      const label =
        [q ? `"${q}"` : null, kind, project].filter(Boolean).join(" · ") || "all entries";
      const md = toMarkdown(db, label, entries);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="saripati-export.md"`,
      });
      res.end(md);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function openBrowser(u: string): void {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [u], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [u], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

export async function runUi(argv: string[] = []): Promise<void> {
  const portIdx = argv.indexOf("--port");
  const port = portIdx !== -1 ? Number(argv[portIdx + 1]) || 4319 : 4319;
  const noOpen = argv.includes("--no-open");

  const paths = resolvePaths(argv);
  const db = openDb(paths);

  const server = createServer((req, res) => handle(db, req, res));
  await new Promise<void>((resolve) => server.listen(port, resolve));

  const u = `http://localhost:${port}`;
  process.stdout.write(`\nSARIPATI dashboard → ${u}\n  vault: ${paths.dbPath}\n  (Ctrl+C to stop)\n`);
  if (!noOpen) openBrowser(u);

  const shutdown = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
