/**
 * Bidirectional Markdown sync — the vault's `.db` projected to an Obsidian-
 * compatible `profile/` folder and reconciled back.
 *
 * Design invariants:
 *  - The `.db` stays the single portable source of truth; the folder is a
 *    projection. `md_sync.md_hash` is the 3-way merge base ("last agreed state").
 *  - `contentHash` normalizes identically in BOTH directions (CRLF→LF, trim,
 *    tags sorted). So an unedited export→import is a *stable no-op*, never a
 *    spurious re-embed of the corpus.
 *  - Each entry file carries a GEN_MARKER: everything below it is auto-derived
 *    (sources, links, backlinks) and is STRIPPED on import — only the human body
 *    above it round-trips. This keeps generated content out of the stored body.
 *  - Re-embedding is done here (async) and handed to the pure `updateEntry`,
 *    which keeps entries + vec + fts atomic.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import type { DB } from "../db/db.js";
import { ensureProfileDir, type Paths } from "../config.js";
import { embed } from "../embed/embedder.js";
import {
  allEntries,
  getEntry,
  insertEntry,
  updateEntry,
  deleteEntry,
  getIdentity,
  upsertIdentity,
  getSyncHash,
  upsertSyncHash,
  type EntryRow,
  type EntryKind,
  type EntryWithSources,
  type IdentityRow,
} from "../db/queries.js";

const GEN_MARKER = "<!-- sari:generated — auto-derived; edits below are ignored on import -->";
const IMPLICIT_LINK_CAP = 6; // cap shared-project / shared-tag edges to avoid a hairball
const KINDS = new Set<EntryKind>(["research", "note", "decision", "pattern"]);

/* --------------------------------------------------------------------------
 * Canonicalization — the shared normalization both directions agree on
 * ------------------------------------------------------------------------ */

/** Normalize free text so whitespace/line-ending noise never triggers a false diff. */
function norm(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

interface SyncFields {
  kind: string;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  confidence: number | null;
}

/** Deterministic serialization of the fields that define an entry's synced content. */
function canonicalContent(e: SyncFields): string {
  return JSON.stringify({
    kind: e.kind,
    title: norm(e.title),
    body: norm(e.body),
    tags: [...e.tags].map(String).sort(),
    project: e.project ?? null,
    confidence: e.confidence ?? null,
  });
}

/** 16-hex-char content hash — the merge base stored in md_sync. */
export function contentHash(e: SyncFields): string {
  return createHash("sha256").update(canonicalContent(e)).digest("hex").slice(0, 16);
}

/** Canonical text embedded on edit: title + body (title carries signal). */
function embedText(e: { title: string; body: string }): string {
  return `${norm(e.title)}\n\n${norm(e.body)}`;
}

/* --------------------------------------------------------------------------
 * Slugs + filenames
 * ------------------------------------------------------------------------ */

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return out || "untitled";
}

/** Stable, collision-free basename for an entry file: `{kind}_{slug}-{id}`. */
function basenameFor(kind: string, title: string, id: number): string {
  return `${kind}_${slugify(title)}-${id}`;
}

/* --------------------------------------------------------------------------
 * Link graph — the canonical rule shared by MD export and the (Phase 3) UI graph
 * ------------------------------------------------------------------------ */

export type EdgeType = "wikilink" | "project" | "tag";

export interface LinkNode {
  id: number;
  kind: EntryKind;
  title: string;
  basename: string;
  project: string | null;
  tags: string[];
  description: string;
}

export interface LinkEdge {
  to: LinkNode;
  type: EdgeType;
}

export interface LinkContext {
  nodes: LinkNode[];
  byId: Map<number, LinkNode>;
  byBasename: Map<string, LinkNode>;
  byTitleSlug: Map<string, LinkNode>;
}

/** Load the whole corpus into an in-memory link context once (export is O(N²) over this,
 *  fine at local-vault scale and far cheaper than re-querying per entry). */
export function buildLinkContext(db: DB): LinkContext {
  const nodes = allEntries(db).map<LinkNode>((e) => ({
    id: e.id,
    kind: e.kind,
    title: e.title,
    basename: basenameFor(e.kind, e.title, e.id),
    project: e.project,
    tags: e.tags,
    description: excerpt(e.body),
  }));
  const byId = new Map<number, LinkNode>();
  const byBasename = new Map<string, LinkNode>();
  const byTitleSlug = new Map<string, LinkNode>();
  for (const n of nodes) {
    byId.set(n.id, n);
    byBasename.set(n.basename, n);
    byTitleSlug.set(slugify(n.title), n); // last-writer-wins on title collisions (rare)
  }
  return { nodes, byId, byBasename, byTitleSlug };
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/**
 * Canonical link rule: (1) explicit `[[...]]` in the body resolved to entries,
 * plus (2) implicit edges from shared project and shared tags (capped). Strongest
 * edge type wins per target (wikilink > project > tag). Consumed by both the MD
 * writer and the Phase-3 graph, so the two can never disagree.
 */
export function deriveLinks(ctx: LinkContext, node: LinkNode, body: string): LinkEdge[] {
  const best = new Map<number, EdgeType>();
  const rank: Record<EdgeType, number> = { wikilink: 3, project: 2, tag: 1 };
  const consider = (id: number, type: EdgeType) => {
    if (id === node.id) return;
    const prev = best.get(id);
    if (!prev || rank[type] > rank[prev]) best.set(id, type);
  };

  // (1) explicit wikilinks — resolve by basename first, then by title slug.
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    const found = ctx.byBasename.get(target) ?? ctx.byTitleSlug.get(slugify(target));
    if (found) consider(found.id, "wikilink");
  }

  // (2) implicit edges — shared project, then shared tags, each capped.
  if (node.project) {
    let n = 0;
    for (const other of ctx.nodes) {
      if (other.project === node.project && other.id !== node.id) {
        consider(other.id, "project");
        if (++n >= IMPLICIT_LINK_CAP) break;
      }
    }
  }
  if (node.tags.length) {
    const mine = new Set(node.tags);
    let n = 0;
    for (const other of ctx.nodes) {
      if (other.id !== node.id && other.tags.some((t) => mine.has(t))) {
        consider(other.id, "tag");
        if (++n >= IMPLICIT_LINK_CAP) break;
      }
    }
  }

  return [...best.entries()].map(([id, type]) => ({ to: ctx.byId.get(id)!, type }));
}

/** Backlinks are the inverse of *explicit* wikilinks only (asymmetric, meaningful);
 *  implicit project/tag edges are symmetric and would just mirror the Links section. */
function computeBacklinks(ctx: LinkContext, bodies: Map<number, string>): Map<number, LinkNode[]> {
  const back = new Map<number, LinkNode[]>();
  for (const node of ctx.nodes) {
    const body = bodies.get(node.id) ?? "";
    for (const m of body.matchAll(WIKILINK_RE)) {
      const target = m[1].trim();
      const found = ctx.byBasename.get(target) ?? ctx.byTitleSlug.get(slugify(target));
      if (found && found.id !== node.id) {
        const list = back.get(found.id) ?? [];
        list.push(node);
        back.set(found.id, list);
      }
    }
  }
  return back;
}

function excerpt(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/* --------------------------------------------------------------------------
 * Frontmatter — a small, tolerant YAML subset (no dependency)
 * ------------------------------------------------------------------------ */

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

type FmValue = string | string[];

function serializeFrontmatter(fields: Array<[string, unknown]>): string {
  const lines = ["---"];
  for (const [k, v] of fields) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: [${v.map((x) => quote(String(x))).join(", ")}]`);
    } else if (typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${quote(String(v))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Split a file into frontmatter map + body. Tolerant of hand-created files
 *  (missing frontmatter) and of Obsidian block-list arrays. */
function parseFrontmatter(raw: string): { fm: Record<string, FmValue>; body: string } {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text };

  const header = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, FmValue> = {};
  const lines = header.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === "") {
      // Possibly an Obsidian block list: `key:` then `  - item` lines.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      }
      if (items.length) fm[key] = items;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s))
        .filter((s) => s !== "");
    } else {
      fm[key] = unquote(val);
    }
  }
  return { fm, body };
}

function fmString(fm: Record<string, FmValue>, key: string): string | undefined {
  const v = fm[key];
  return typeof v === "string" ? v : undefined;
}

function fmArray(fm: Record<string, FmValue>, key: string): string[] {
  const v = fm[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

/* --------------------------------------------------------------------------
 * Entry <-> Markdown
 * ------------------------------------------------------------------------ */

function entryToMarkdown(
  entry: EntryWithSources,
  links: LinkEdge[],
  backlinks: LinkNode[],
): string {
  const fm = serializeFrontmatter([
    ["name", slugify(entry.title)],
    ["title", entry.title],
    ["type", entry.kind],
    ["id", entry.id],
    ["project", entry.project],
    ["tags", entry.tags],
    ["confidence", entry.confidence],
    ["created", entry.created_at],
    ["updated", entry.updated_at],
    ["description", excerpt(entry.body)],
  ]);

  const parts = [fm, "", `# ${entry.title}`, "", norm(entry.body), "", GEN_MARKER, ""];

  if (entry.sources.length) {
    parts.push("## Sources", "");
    for (const s of entry.sources) {
      const label = s.title || s.url || "source";
      const link = s.url ? `[${label}](${s.url})` : label;
      parts.push(`- ${link}${s.snippet ? ` — ${s.snippet}` : ""}`);
    }
    parts.push("");
  }
  if (links.length) {
    parts.push("## Links", "");
    for (const e of links) parts.push(`- [[${e.to.basename}|${e.to.title}]] _(${e.type})_`);
    parts.push("");
  }
  if (backlinks.length) {
    parts.push("## Backlinks", "");
    for (const n of backlinks) parts.push(`- [[${n.basename}|${n.title}]]`);
    parts.push("");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

export interface ParsedEntry {
  id: number | null;
  kind: EntryKind;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  confidence: number | null;
}

/** Recover an entry from a Markdown file: frontmatter + the human body above the
 *  GEN_MARKER, with the H1 title line stripped. */
export function parseEntryFile(raw: string): ParsedEntry {
  const { fm, body } = parseFrontmatter(raw);

  // Cut everything from the generated marker onward.
  const markerIdx = body.indexOf(GEN_MARKER);
  let content = markerIdx === -1 ? body : body.slice(0, markerIdx);

  // Capture an H1 (fallback title) then strip that first heading line.
  const h1 = /^\s*#\s+(.+?)\s*$/m.exec(content);
  content = content.replace(/^\s*#\s+.*(?:\r?\n)+/, "");

  const idRaw = fmString(fm, "id");
  const id = idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : null;
  const kindRaw = (fmString(fm, "type") ?? "note") as EntryKind;
  const confRaw = fmString(fm, "confidence");

  return {
    id,
    kind: KINDS.has(kindRaw) ? kindRaw : "note",
    title: fmString(fm, "title") ?? h1?.[1] ?? "Untitled",
    body: norm(content),
    tags: fmArray(fm, "tags"),
    project: fmString(fm, "project") ?? null,
    confidence: confRaw && !Number.isNaN(Number(confRaw)) ? Number(confRaw) : null,
  };
}

function parsedToInput(p: ParsedEntry) {
  return {
    kind: p.kind,
    title: p.title,
    body: p.body,
    confidence: p.confidence,
    tags: p.tags,
    project: p.project,
  };
}

/* --------------------------------------------------------------------------
 * Identity <-> Markdown
 * ------------------------------------------------------------------------ */

function identityToMarkdown(identity: IdentityRow): string {
  const fm = serializeFrontmatter([
    ["user_name", identity.user_name],
    ["user_field", identity.user_field],
    ["companion_name", identity.companion_name],
    ["companion_role", identity.companion_role],
    ["companion_tone", identity.companion_tone],
  ]);
  return (
    [
      fm,
      "",
      "# Identity",
      "",
      "The person this vault belongs to, and the AI companion that tends it.",
      "",
      "## Preferences",
      "",
      "```json",
      JSON.stringify(identity.user_prefs ?? {}, null, 2),
      "```",
      "",
      "## Companion Config",
      "",
      "```json",
      JSON.stringify(identity.companion_config ?? {}, null, 2),
      "```",
      "",
    ].join("\n")
  );
}

function parseIdentityMd(raw: string): Parameters<typeof upsertIdentity>[1] | null {
  const { fm, body } = parseFrontmatter(raw);
  const jsonBlocks = [...body.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((m) => {
    try {
      return JSON.parse(m[1]) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const input = {
    user_name: fmString(fm, "user_name") ?? null,
    user_field: fmString(fm, "user_field") ?? null,
    companion_name: fmString(fm, "companion_name") ?? null,
    companion_role: fmString(fm, "companion_role") ?? null,
    companion_tone: fmString(fm, "companion_tone") ?? null,
    user_prefs: jsonBlocks[0],
    companion_config: jsonBlocks[1],
  };
  const hasAny =
    input.user_name || input.user_field || input.companion_name || jsonBlocks.length > 0;
  return hasAny ? input : null;
}

/* --------------------------------------------------------------------------
 * MEMORY.md — the index
 * ------------------------------------------------------------------------ */

function buildMemoryIndex(ctx: LinkContext, identity: IdentityRow | null): string {
  const owner = identity?.user_name ? `${identity.user_name}'s vault` : "SARIPATI vault";
  const lines = [`# ${owner} — Memory Index`, "", `${ctx.nodes.length} entries.`, ""];
  const order: EntryKind[] = ["research", "note", "decision", "pattern"];
  for (const kind of order) {
    const group = ctx.nodes.filter((n) => n.kind === kind);
    if (!group.length) continue;
    lines.push(`## ${kind} (${group.length})`, "");
    for (const n of group) lines.push(`- [[${n.basename}|${n.title}]] — ${n.description}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/* --------------------------------------------------------------------------
 * Export  (DB → MD)
 * ------------------------------------------------------------------------ */

export interface ExportFilters {
  kind?: EntryKind;
  project?: string;
}

export interface ExportReport {
  written: number;
  identity: boolean;
  [k: string]: number | boolean;
}

export function exportVault(db: DB, paths: Paths, filters: ExportFilters = {}): ExportReport {
  ensureProfileDir(paths);
  const ctx = buildLinkContext(db);
  const bodies = new Map<number, string>(allEntries(db).map((e) => [e.id, e.body]));
  const backlinks = computeBacklinks(ctx, bodies);

  const selected = ctx.nodes.filter(
    (n) => (!filters.kind || n.kind === filters.kind) && (!filters.project || n.project === filters.project),
  );
  const selectedIds = new Set(selected.map((n) => n.id));

  let written = 0;
  for (const node of selected) {
    const entry = getEntry(db, node.id);
    if (!entry) continue;
    // When filtering, keep links/backlinks within the exported set (no dangling files).
    const filtering = Boolean(filters.kind || filters.project);
    let links = deriveLinks(ctx, node, entry.body);
    let back = backlinks.get(node.id) ?? [];
    if (filtering) {
      links = links.filter((e) => selectedIds.has(e.to.id));
      back = back.filter((n) => selectedIds.has(n.id));
    }
    writeFileSync(join(paths.memoryDir, `${node.basename}.md`), entryToMarkdown(entry, links, back), "utf8");
    upsertSyncHash(db, node.id, contentHash(entry));
    written++;
  }

  const identity = getIdentity(db);
  if (identity) writeFileSync(join(paths.profileDir, "IDENTITY.md"), identityToMarkdown(identity), "utf8");
  writeFileSync(join(paths.profileDir, "MEMORY.md"), buildMemoryIndex(ctx, identity), "utf8");

  return { written, identity: Boolean(identity) };
}

/* --------------------------------------------------------------------------
 * Import  (MD → DB, 3-way reconcile)
 * ------------------------------------------------------------------------ */

export interface ImportOptions {
  forceMd?: boolean;
  prune?: boolean;
}

export interface ImportReport {
  created: number;
  updated: number;
  conflicted: number;
  unchanged: number;
  orphaned: number;
  pruned: number;
  identity: boolean;
  conflicts: string[];
}

export async function importVault(db: DB, paths: Paths, opts: ImportOptions = {}): Promise<ImportReport> {
  const report: ImportReport = {
    created: 0,
    updated: 0,
    conflicted: 0,
    unchanged: 0,
    orphaned: 0,
    pruned: 0,
    identity: false,
    conflicts: [],
  };
  if (!existsSync(paths.memoryDir)) return report;

  const files = readdirSync(paths.memoryDir).filter((f) => f.toLowerCase().endsWith(".md"));
  const seen = new Set<number>();

  for (const file of files) {
    const full = join(paths.memoryDir, file);
    const parsed = parseEntryFile(readFileSync(full, "utf8"));

    // --- new file (hand-created, or stale id) → insert + back-fill id -------
    const dbEntry = parsed.id !== null ? getEntry(db, parsed.id) : null;
    if (parsed.id === null || !dbEntry) {
      const embedding = await embed(embedText(parsed));
      const newId = insertEntry(db, parsedToInput(parsed), embedding);
      seen.add(newId);
      const entry = getEntry(db, newId)!;
      upsertSyncHash(db, newId, contentHash(entry));
      // Re-render with the assigned id and move to the canonical filename.
      const canonical = `${basenameFor(entry.kind, entry.title, newId)}.md`;
      writeFileSync(full, entryToMarkdown(entry, [], []), "utf8");
      if (file !== canonical) renameSync(full, join(paths.memoryDir, canonical));
      report.created++;
      continue;
    }

    // --- existing entry → 3-way reconcile ----------------------------------
    const id = parsed.id!;
    seen.add(id);
    const mdHash = contentHash(parsed);
    const dbHash = contentHash(dbEntry);
    const base = getSyncHash(db, id);

    if (mdHash === base) {
      report.unchanged++;
      continue; // MD unchanged since last sync (DB drift, if any, is export's job)
    }
    if (base === null && mdHash === dbHash) {
      upsertSyncHash(db, id, mdHash); // never synced but already identical → adopt base
      report.unchanged++;
      continue;
    }

    const bothChanged = base !== null ? dbHash !== base && mdHash !== base : mdHash !== dbHash;
    if (bothChanged && !opts.forceMd) {
      report.conflicted++;
      report.conflicts.push(file);
      continue;
    }

    // Apply MD → DB. Re-embed only when the semantic content actually changed.
    const semanticChanged = norm(parsed.title) !== norm(dbEntry.title) || norm(parsed.body) !== norm(dbEntry.body);
    const embedding = semanticChanged ? await embed(embedText(parsed)) : undefined;
    updateEntry(db, id, parsedToInput(parsed), embedding);
    upsertSyncHash(db, id, mdHash);
    report.updated++;
  }

  // --- orphans: DB entries with no file ------------------------------------
  const orphans = allEntries(db).filter((e) => !seen.has(e.id));
  if (opts.prune) {
    for (const o of orphans) if (deleteEntry(db, o.id)) report.pruned++;
  } else {
    report.orphaned = orphans.length;
  }

  // --- identity ------------------------------------------------------------
  const identityFile = join(paths.profileDir, "IDENTITY.md");
  if (existsSync(identityFile)) {
    const input = parseIdentityMd(readFileSync(identityFile, "utf8"));
    if (input) {
      upsertIdentity(db, input);
      report.identity = true;
    }
  }

  return report;
}

/** Convenience: export the DB to MD, then reconcile MD back in one pass. */
export async function syncVault(db: DB, paths: Paths, opts: ImportOptions = {}): Promise<{ exported: ExportReport; imported: ImportReport }> {
  const exported = exportVault(db, paths);
  const imported = await importVault(db, paths, opts);
  return { exported, imported };
}
