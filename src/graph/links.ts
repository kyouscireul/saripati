/**
 * Link graph — the canonical rule that turns the flat corpus into a graph.
 *
 * Two consumers rely on this exact rule so they can never disagree: the web
 * dashboard's `/api/graph` + `/api/backlinks` endpoints. Edges are (1) explicit
 * typed relations recorded via `entry_update`'s `links`, (2) explicit
 * `[[wikilinks]]` in an entry's body resolved to other entries, plus (3) implicit
 * edges from shared project and shared tags (capped). The strongest edge type
 * wins per target (relation > wikilink > project > tag).
 *
 * Extracted from the retired MD-sync engine in v0.3.0 — this is now the sole home
 * of the graph derivation logic.
 */

import type { DB } from "../db/db.js";
import { allEntries, type EntryKind, type EntryLink, type LinkRel } from "../db/queries.js";

const IMPLICIT_LINK_CAP = 6; // cap shared-project / shared-tag edges to avoid a hairball

/** URL-safe slug of a title (max 60 chars); used for basenames and title resolution. */
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

/** Stable, collision-free basename for an entry: `{kind}_{slug}-{id}`. */
export function basenameFor(kind: string, title: string, id: number): string {
  return `${kind}_${slugify(title)}-${id}`;
}

function excerpt(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export type EdgeType = "relation" | "wikilink" | "project" | "tag";

export interface LinkNode {
  id: number;
  kind: EntryKind;
  title: string;
  basename: string;
  project: string | null;
  tags: string[];
  description: string;
  links: EntryLink[];
}

export interface LinkEdge {
  to: LinkNode;
  type: EdgeType;
  /** For `relation` edges only: which typed relation the author asserted. */
  rel?: LinkRel;
}

export interface LinkContext {
  nodes: LinkNode[];
  byId: Map<number, LinkNode>;
  byBasename: Map<string, LinkNode>;
  byTitleSlug: Map<string, LinkNode>;
}

/** Load the whole corpus into an in-memory link context once (derivation is O(N²)
 *  over this, fine at local-vault scale and far cheaper than re-querying per entry). */
export function buildLinkContext(db: DB): LinkContext {
  const nodes = allEntries(db).map<LinkNode>((e) => ({
    id: e.id,
    kind: e.kind,
    title: e.title,
    basename: basenameFor(e.kind, e.title, e.id),
    project: e.project,
    tags: e.tags,
    description: excerpt(e.body),
    links: e.links,
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

export const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/**
 * Canonical link rule: (1) explicit typed relations from `entry_update`'s `links`,
 * (2) explicit `[[...]]` in the body resolved to entries, plus (3) implicit edges
 * from shared project and shared tags (capped). Strongest edge type wins per
 * target (relation > wikilink > project > tag).
 */
export function deriveLinks(ctx: LinkContext, node: LinkNode, body: string): LinkEdge[] {
  const best = new Map<number, { type: EdgeType; rel?: LinkRel }>();
  const rank: Record<EdgeType, number> = { relation: 4, wikilink: 3, project: 2, tag: 1 };
  const consider = (id: number, type: EdgeType, rel?: LinkRel) => {
    if (id === node.id) return;
    const prev = best.get(id);
    if (!prev || rank[type] > rank[prev.type]) best.set(id, { type, rel });
  };

  // (1) explicit typed relations — the author asserted these, so they outrank
  // everything derived. Dangling ids (the target was deleted; `entry_update`
  // does no referential check) must be dropped BEFORE consider(), or the
  // byId.get(id)! below would hand callers `{ to: undefined }`.
  for (const l of node.links) {
    if (!ctx.byId.has(l.id)) continue;
    consider(l.id, "relation", l.rel);
  }

  // (2) explicit wikilinks — resolve by basename first, then by title slug.
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    const found = ctx.byBasename.get(target) ?? ctx.byTitleSlug.get(slugify(target));
    if (found) consider(found.id, "wikilink");
  }

  // (3) implicit edges — shared project, then shared tags, each capped.
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

  return [...best.entries()].map(([id, v]) => ({ to: ctx.byId.get(id)!, type: v.type, rel: v.rel }));
}
