import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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
  unresolvedQuestions,
  activeIntentions,
  unreadMemos,
  lastEntryAtByProject,
  listProjects,
  type EntryKind,
  type EntryStatus,
  type EntryRow,
} from "../db/queries.js";
import { buildLinkContext, deriveLinks } from "../graph/links.js";
import { embed } from "../embed/embedder.js";
import { hybridSearch } from "../search/hybrid.js";
import { readLastFetch } from "../trace.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function readUi(name: string): string {
  return readFileSync(join(__dir, name), "utf8");
}

// Vendor ESM files for the browser dashboard. Production serves the copies the
// build vendored into dist/vendor/ (so preact/htm need not be runtime deps). In
// dev (tsx, no build) dist/vendor is absent, so fall back to resolving the ESM
// entry from node_modules — each package's CJS and ESM entries share a directory
// and differ only by the .js → .module.js suffix.
function moduleFrom(cjsPath: string): string {
  return cjsPath.replace(/\.js$/, ".module.js");
}

function vendorPath(bundled: string, pkg: string): string {
  const local = join(__dir, "..", "vendor", bundled);
  return existsSync(local) ? local : moduleFrom(_require.resolve(pkg));
}

const VENDOR: Record<string, string> = {
  "/vendor/preact.js": vendorPath("preact.module.js", "preact"),
  "/vendor/hooks.js": vendorPath("hooks.module.js", "preact/hooks"),
  "/vendor/htm.js": vendorPath("htm.module.js", "htm"),
};

const KINDS: EntryKind[] = [
  "research",
  "note",
  "decision",
  "pattern",
  "question",
  "memo",
  "intention",
];

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function parseKind(v: string | null): EntryKind | undefined {
  return v && (KINDS as string[]).includes(v) ? (v as EntryKind) : undefined;
}

const STATUSES: EntryStatus[] = ["active", "superseded", "archived"];
function parseStatus(v: string | null): EntryStatus | undefined {
  return v && (STATUSES as string[]).includes(v) ? (v as EntryStatus) : undefined;
}

// Staleness cutoff — mirrors the `on` MCP tool (src/mcp/tools/session.ts) so the
// dashboard's "stale projects" agrees with what the agent is nudged about. A
// datetime('now')-format cutoff (UTC "YYYY-MM-DD HH:MM:SS") N days ago.
const DEFAULT_STALE_DAYS = 21;
function staleCutoff(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
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
  status: EntryStatus | undefined = undefined,
  offset: number = 0,
) {
  let rows: EntryRow[] = [];
  if (q && q.trim()) {
    const trimmed = q.trim();
    if (semantic) {
      try {
        const queryEmbedding = await embed(trimmed);
        // Superseded/archived are excluded from recall by default; if the user is
        // explicitly browsing a non-active status, opt them back in so the filter
        // below has rows to match.
        const includeSuperseded = status !== undefined && status !== "active";
        const hybridHits = hybridSearch(db, queryEmbedding, trimmed, { kind, limit: limit * 2, includeSuperseded });
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
    // tag/project/non-active-status are JS-filtered after the SQL query, so we
    // need a full fetch (500 cap) with no offset to avoid missing matching rows.
    const jsFiltered = !!(tag || project || (status && status !== "active"));
    rows = listEntries(db, { kind, project: project ?? undefined, limit: jsFiltered ? 500 : limit, offset: jsFiltered ? 0 : offset });
  }

  if (kind) rows = rows.filter((e) => e.kind === kind);
  if (tag) rows = rows.filter((e) => e.tags.includes(tag));
  if (project) rows = rows.filter((e) => e.project === project);
  if (status) rows = rows.filter((e) => e.status === status);
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
  dataDir: string,
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

    if (p === "/api/last-fetch") return json(res, 200, readLastFetch(dataDir));

    // The steerer signals the `on` tool emits to the agent, surfaced to the human.
    // Mirrors the tool's `nudges` block (src/mcp/tools/session.ts) EXCEPT it returns
    // full EntryRows, not the tool's slim() projection — the dashboard needs kind /
    // created_at / project for chips without a second fetch. Keep the two in step.
    if (p === "/api/nudges") {
      const identity = getIdentity(db);
      const session = latestSessions(db, 1)[0] ?? null;
      const staleDays =
        typeof identity?.companion_config?.stale_days === "number"
          ? (identity.companion_config.stale_days as number)
          : DEFAULT_STALE_DAYS;
      const staleAfter = staleCutoff(staleDays);
      const lastByProject = lastEntryAtByProject(db);
      const stale_projects = listProjects(db, "active")
        .filter((proj) => {
          const last = lastByProject[proj.name];
          return last && last < staleAfter; // touched before, but not lately
        })
        .map((proj) => ({ name: proj.name, stack: proj.stack, last_entry_at: lastByProject[proj.name] }));
      return json(res, 200, {
        unresolved_questions: unresolvedQuestions(db, 20),
        active_intentions: activeIntentions(db, 20),
        unread_memos: unreadMemos(db, session?.created_at ?? null, 20),
        stale_projects,
      });
    }

    if (p === "/api/status")
      return json(res, 200, { ...corpusStatus(db), timeline: timeline(db), sessions_recent: latestSessions(db, 5) });

    if (p === "/api/identity") return json(res, 200, getIdentity(db));

    if (p === "/api/tags")
      return json(res, 200, db.prepare(
        `SELECT je.value AS tag, COUNT(*) AS count FROM entries, json_each(entries.tags) AS je GROUP BY je.value ORDER BY count DESC`,
      ).all());

    if (p === "/api/graph") {
      const NODE_CAP = 150;
      const ctx = buildLinkContext(db);

      // Count how often each tag appears across all nodes so we can skip
      // ubiquitous tags (e.g. "es-memory" on 1000 entries) that collapse
      // everything into a hairball.  Any tag on > 25 % of the visible nodes
      // is treated as noise and excluded from tag-type edge creation.
      const tagFreq = new Map<string, number>();
      for (const n of ctx.nodes) for (const t of n.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
      const rareThreshold = Math.ceil(Math.min(ctx.nodes.length, NODE_CAP) * 0.25);

      // A tag can be rare corpus-wide yet saturate one small project (e.g. every
      // entry in an 8-entry project tagged "internship") — that still forms a
      // local hairball even though the vault-wide check above passes. Scope a
      // second rarity check to same-project pairs so a tag must be rare both
      // vault-wide AND within the shared project to keep a "tag" edge.
      const projectTagFreq = new Map<string, Map<string, number>>();
      const projectNodeCount = new Map<string, number>();
      for (const n of ctx.nodes) {
        if (!n.project) continue;
        projectNodeCount.set(n.project, (projectNodeCount.get(n.project) ?? 0) + 1);
        let freq = projectTagFreq.get(n.project);
        if (!freq) projectTagFreq.set(n.project, (freq = new Map()));
        for (const t of n.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
      }
      const projectRareThreshold = (project: string) =>
        Math.ceil((projectNodeCount.get(project) ?? 0) * 0.25);

      const bodies = new Map(allEntries(db).map((e) => [e.id, e.body]));
      const edgeOrd: Record<string, number> = { relation: 0, wikilink: 1, project: 2, tag: 3 };
      const byPair = new Map<string, { from: number; to: number; type: string; rel?: string }>();
      for (const node of ctx.nodes.slice(0, NODE_CAP)) {
        for (const link of deriveLinks(ctx, node, bodies.get(node.id) ?? "")) {
          if (link.type === "tag") {
            // Only keep tag edges where the two nodes share at least one tag
            // that's rare vault-wide, and (if they're in the same project)
            // also rare within that project.
            const sameProject = node.project && link.to.project && node.project === link.to.project;
            const hasRare = node.tags.some((t) => {
              if (!link.to.tags.includes(t)) return false;
              if ((tagFreq.get(t) ?? 0) > rareThreshold) return false;
              if (!sameProject) return true;
              const projFreq = projectTagFreq.get(node.project!)?.get(t) ?? 0;
              return projFreq <= projectRareThreshold(node.project!);
            });
            if (!hasRare) continue;
          }
          // Strongest type wins per PAIR, not just per derivation. deriveLinks
          // already absorbs weaker types within one node's own edges, but the
          // other endpoint derives independently — so A→B "project" and
          // B→A "relation" both arrive, and the pair would draw twice with the
          // weaker line painting over the stronger one.
          const key = `${Math.min(node.id, link.to.id)}:${Math.max(node.id, link.to.id)}`;
          const prev = byPair.get(key);
          if (!prev || edgeOrd[link.type] < edgeOrd[prev.type]) {
            byPair.set(key, { from: node.id, to: link.to.id, type: link.type, rel: link.rel });
          }
        }
      }
      // Edges accumulate in ascending node-id order, so a large vault can spend
      // the whole 600 budget on old entries' tag edges before reaching a single
      // author-asserted relation. Sort by rank so the cap drops the least
      // meaningful edges first.
      const edges = [...byPair.values()].sort(
        (a, b) => (edgeOrd[a.type] ?? 9) - (edgeOrd[b.type] ?? 9),
      );
      return json(res, 200, { nodes: ctx.nodes.slice(0, NODE_CAP), edges: edges.slice(0, 600) });
    }

    const blMatch = p.match(/^\/api\/backlinks\/(\d+)$/);
    if (blMatch) {
      const targetId = Number(blMatch[1]);
      const ctx = buildLinkContext(db);
      const bodies = new Map(allEntries(db).map((e) => [e.id, e.body]));
      return json(res, 200, ctx.nodes.filter((node) => {
        if (node.id === targetId) return false;
        // Explicit references only — wikilinks and author-asserted typed
        // relations. Must include "relation": deriveLinks keeps the strongest
        // type per target, so an entry that both wikilinks and typed-links the
        // same target reports "relation", and a wikilink-only filter would
        // silently drop that backlink.
        return deriveLinks(ctx, node, bodies.get(node.id) ?? "").some(
          (l) => l.to.id === targetId && (l.type === "wikilink" || l.type === "relation"),
        );
      }));
    }

    if (p === "/api/entries") {
      const q = url.searchParams.get("q");
      const kind = parseKind(url.searchParams.get("kind"));
      const tag = url.searchParams.get("tag");
      const project = url.searchParams.get("project");
      const entryStatus = parseStatus(url.searchParams.get("status"));
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      const useSemantic = semanticMode || url.searchParams.get("semantic") === "1" || url.searchParams.get("semantic") === "true";
      const entries = await searchEntries(db, q, kind, tag, project, limit, useSemantic, entryStatus, offset);
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
        let patch: {
          tags?: string[];
          kind?: string;
          status?: string;
          superseded_by?: number | null;
          resolved?: boolean | null;
          active?: boolean | null;
        } = {};
        try { patch = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        if (patch.kind && !(KINDS as string[]).includes(patch.kind)) return json(res, 400, { error: "invalid kind" });
        if (patch.status && !(STATUSES as string[]).includes(patch.status)) return json(res, 400, { error: "invalid status" });
        if (patch.superseded_by !== undefined && patch.superseded_by !== null && typeof patch.superseded_by !== "number")
          return json(res, 400, { error: "invalid superseded_by" });
        if (patch.resolved !== undefined && patch.resolved !== null && typeof patch.resolved !== "boolean")
          return json(res, 400, { error: "invalid resolved" });
        if (patch.active !== undefined && patch.active !== null && typeof patch.active !== "boolean")
          return json(res, 400, { error: "invalid active" });
        const updated = updateEntry(db, id, {
          tags: Array.isArray(patch.tags) ? patch.tags.map(String) : undefined,
          kind: patch.kind as EntryKind | undefined,
          status: patch.status as EntryStatus | undefined,
          superseded_by: patch.superseded_by,
          resolved: patch.resolved,
          active: patch.active,
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
  const writeMode = argv.includes("--write"); // read-only by default; pass --write to enable edits
  const semanticMode = !argv.includes("--no-semantic"); // on by default; pass --no-semantic to disable

  const paths = resolvePaths(argv);
  const db = openDb(paths);

  const server = createServer((req, res) => {
    handle(db, req, res, writeMode, semanticMode, paths.dataDir).catch((err) => json(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));

  const u = `http://localhost:${port}`;
  const mode = writeMode ? "read-write (--write)" : "read-only (pass --write to edit)";
  const flags = [semanticMode && "--semantic"].filter(Boolean).join(" ");
  process.stdout.write(
    "\nSARIPATI dashboard → " + u + "\n  vault: " + paths.dbPath + "\n  mode: " + mode +
      (flags ? "\n  flags: " + flags : "") + "\n  (Ctrl+C to stop)\n",
  );
  if (!noOpen) openBrowser(u);

  const shutdown = () => { server.close(); db.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
