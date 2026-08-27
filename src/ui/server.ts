import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
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
  getIdentity,
  allEntries,
  updateEntry,
  type EntryKind,
  type EntryRow,
} from "../db/queries.js";
import { buildLinkContext, deriveLinks } from "../sync/md.js";
import { embed } from "../embed/embedder.js";
import { hybridSearch } from "../search/hybrid.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function readUi(name: string): string {
  return readFileSync(join(__dir, name), "utf8");
}

function resolveVendor(pkg: string): string {
  return _require.resolve(pkg);
}

// Vendor ESM files for the browser dashboard.
// Each package's CJS entry and browser-ESM entry share the same directory —
// only the filename suffix differs (.js → .module.js). Path-separator-safe.
function moduleFrom(cjsPath: string): string {
  return cjsPath.replace(/\.js$/, ".module.js");
}

const VENDOR: Record<string, string> = {
  "/vendor/preact.js": moduleFrom(resolveVendor("preact")),
  "/vendor/hooks.js": moduleFrom(resolveVendor("preact/hooks")),
  "/vendor/htm.js": moduleFrom(resolveVendor("htm")),
};

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

async function searchEntries(
  db: DB,
  q: string | null,
  kind: EntryKind | undefined,
  tag: string | null,
  project: string | null,
  limit: number,
  semantic: boolean = false,
) {
  let rows: EntryRow[] = [];
  if (q && q.trim()) {
    const trimmed = q.trim();
    if (semantic) {
      try {
        const queryEmbedding = await embed(trimmed);
        const hybridHits = hybridSearch(db, queryEmbedding, trimmed, { kind, limit: limit * 2 });
        rows = hybridHits.map((h) => h.entry);
      } catch {
        const hits = ftsSearch(db, trimmed, limit * 2);
        const map = getEntriesByIds(db, hits.map((h) => h.id));
        rows = hits.map((h) => map.get(h.id)).filter((e): e is NonNullable<typeof e> => !!e);
      }
    } else {
      const hits = ftsSearch(db, trimmed, limit * 2);
      const map = getEntriesByIds(db, hits.map((h) => h.id));
      rows = hits.map((h) => map.get(h.id)).filter((e): e is NonNullable<typeof e> => !!e);
    }
  } else {
    rows = listEntries(db, { kind, project: project ?? undefined, limit: (tag || project) ? 500 : limit });
  }

  if (kind) rows = rows.filter((e) => e.kind === kind);
  if (tag) rows = rows.filter((e) => e.tags.includes(tag));
  if (project) rows = rows.filter((e) => e.project === project);
  return rows.slice(0, limit);
}

function toMarkdown(db: DB, filterLabel: string, entries: ReturnType<typeof listEntries>): string {
  const lines: string[] = [`# SARIPATI Export — ${filterLabel}`, `Generated ${new Date().toISOString()}`, ""];
  for (const e of entries) {
    lines.push(`## ${e.title}`);
    lines.push(`*${e.kind}${e.project ? ` · ${e.project}` : ""} · ${e.created_at}*`);
    if (e.tags.length) lines.push(`Tags: ${e.tags.map((t) => `\`${t}\``).join(", ")}`);
    lines.push("", e.body);
    const full = getEntry(db, e.id);
    if (full?.sources.length) {
      lines.push("", "**Sources:**");
      for (const s of full.sources) {
        const t = s.title ?? s.url ?? "source";
        lines.push(`- ${s.url ? `[${t}](${s.url})` : t}${s.snippet ? ` — ${s.snippet}` : ""}`);
      }
    }
    lines.push("", "---", "");
  }
  return lines.join("\n");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handle(
  db: DB,
  req: IncomingMessage,
  res: ServerResponse,
  writeMode: boolean,
  semanticMode: boolean,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(readUi("web.html"));
    }

    if (VENDOR[p]) {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "max-age=86400" });
      return void res.end(readFileSync(VENDOR[p], "utf8"));
    }

    if (p === "/api/config") return json(res, 200, { writeMode, semanticMode });

    if (p === "/api/status")
      return json(res, 200, { ...corpusStatus(db), timeline: timeline(db), sessions_recent: latestSessions(db, 5) });

    if (p === "/api/identity") return json(res, 200, getIdentity(db));

    if (p === "/api/tags")
      return json(res, 200, db.prepare(
        `SELECT je.value AS tag, COUNT(*) AS count FROM entries, json_each(entries.tags) AS je GROUP BY je.value ORDER BY count DESC`,
      ).all());

    if (p === "/api/graph") {
      const ctx = buildLinkContext(db);
      const bodies = new Map(allEntries(db).map((e) => [e.id, e.body]));
      const seen = new Set<string>();
      const edges: { from: number; to: number; type: string }[] = [];
      for (const node of ctx.nodes.slice(0, 300)) {
        for (const link of deriveLinks(ctx, node, bodies.get(node.id) ?? "")) {
          const key = `${Math.min(node.id, link.to.id)}:${Math.max(node.id, link.to.id)}:${link.type}`;
          if (!seen.has(key)) { seen.add(key); edges.push({ from: node.id, to: link.to.id, type: link.type }); }
        }
      }
      return json(res, 200, { nodes: ctx.nodes.slice(0, 300), edges: edges.slice(0, 600) });
    }

    const blMatch = p.match(/^\/api\/backlinks\/(\d+)$/);
    if (blMatch) {
      const targetId = Number(blMatch[1]);
      const ctx = buildLinkContext(db);
      const bodies = new Map(allEntries(db).map((e) => [e.id, e.body]));
      return json(res, 200, ctx.nodes.filter((node) => {
        if (node.id === targetId) return false;
        return deriveLinks(ctx, node, bodies.get(node.id) ?? "").some(
          (l) => l.to.id === targetId && l.type === "wikilink",
        );
      }));
    }

    if (p === "/api/entries") {
      const q = url.searchParams.get("q");
      const kind = parseKind(url.searchParams.get("kind"));
      const tag = url.searchParams.get("tag");
      const project = url.searchParams.get("project");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
      const useSemantic = semanticMode || url.searchParams.get("semantic") === "1" || url.searchParams.get("semantic") === "true";
      const entries = await searchEntries(db, q, kind, tag, project, limit, useSemantic);
      return json(res, 200, entries);
    }

    const ematch = p.match(/^\/api\/entry\/(\d+)$/);
    if (ematch) {
      const id = Number(ematch[1]);
      if (method === "GET") {
        const entry = getEntry(db, id);
        return entry ? json(res, 200, entry) : json(res, 404, { error: "not found" });
      }
      if (method === "PATCH" && writeMode) {
        let patch: { tags?: string[]; kind?: string } = {};
        try { patch = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        if (patch.kind && !(KINDS as string[]).includes(patch.kind)) return json(res, 400, { error: "invalid kind" });
        const updated = updateEntry(db, id, {
          tags: Array.isArray(patch.tags) ? patch.tags.map(String) : undefined,
          kind: patch.kind as EntryKind | undefined,
        });
        return updated ? json(res, 200, updated) : json(res, 404, { error: "not found" });
      }
      if (method === "PATCH" && !writeMode) return json(res, 403, { error: "start with --write to enable editing" });
      return json(res, 405, { error: "method not allowed" });
    }

    if (p === "/api/export") {
      const kind = parseKind(url.searchParams.get("kind"));
      const tag = url.searchParams.get("tag");
      const q = url.searchParams.get("q");
      const entries = await searchEntries(db, q, kind, tag, null, 1000, semanticMode);
      const label = [q ? `"${q}"` : null, kind, tag ? `#${tag}` : null].filter(Boolean).join(" · ") || "all entries";
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="saripati-export.md"` });
      return void res.end(toMarkdown(db, label, entries));
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
  } catch { /* best-effort */ }
}

export async function runUi(argv: string[] = []): Promise<void> {
  const portIdx = argv.indexOf("--port");
  const port = portIdx !== -1 ? Number(argv[portIdx + 1]) || 4319 : 4319;
  const noOpen = argv.includes("--no-open");
  const writeMode = !argv.includes("--no-write"); // on by default; pass --no-write to disable
  const semanticMode = !argv.includes("--no-semantic"); // on by default; pass --no-semantic to disable

  const paths = resolvePaths(argv);
  const db = openDb(paths);

  const server = createServer((req, res) => {
    handle(db, req, res, writeMode, semanticMode).catch((err) => json(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));

  const u = `http://localhost:${port}`;
  const flags = [writeMode && "--write", semanticMode && "--semantic"].filter(Boolean).join(" ");
  process.stdout.write("\nSARIPATI dashboard → " + u + "\n  vault: " + paths.dbPath + (flags ? "\n  flags: " + flags : "") + "\n  (Ctrl+C to stop)\n");
  if (!noOpen) openBrowser(u);

  const shutdown = () => { server.close(); db.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
