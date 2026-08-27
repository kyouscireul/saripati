import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import type { Paths } from "../../config.js";
import {
  insertEntry,
  insertSource,
  getIdentity,
  getEntriesByIds,
  vecSearch,
  type EntryKind,
} from "../../db/queries.js";
import { hybridSearch } from "../../search/hybrid.js";
import { embed } from "../../embed/embedder.js";
import { writeLastFetch } from "../../trace.js";
import { jsonResult, deriveTitle, excerpt } from "./_result.js";

const KINDS = ["research", "note", "decision", "pattern", "question", "memo", "intention"] as const;

/** Cosine-similarity floor above which a freshly saved entry is flagged as a
 *  potential conflict with an existing one. Overridable via companion_config. */
const DEFAULT_CONFLICT_THRESHOLD = 0.85;

/** Read per-vault recall tuning from the identity's companion_config. */
function readConfig(db: DB): { boosts?: Record<string, number>; threshold: number } {
  const cfg = getIdentity(db)?.companion_config ?? {};
  const rawBoost = (cfg as Record<string, unknown>).recall_boost;
  const boosts =
    rawBoost && typeof rawBoost === "object" ? (rawBoost as Record<string, number>) : undefined;
  const rawThresh = (cfg as Record<string, unknown>).conflict_threshold;
  const threshold = typeof rawThresh === "number" ? rawThresh : DEFAULT_CONFLICT_THRESHOLD;
  return { boosts, threshold };
}

/** Embeddings are L2-normalized, so for the vec0 L2 distance d, cosine = 1 − d²/2. */
function cosineFromL2(distance: number): number {
  return 1 - (distance * distance) / 2;
}

/**
 * Post-save conflict hook: find existing entries whose embedding sits above the
 * similarity threshold to the one just saved. Returns them so the agent can
 * decide to supersede, lower confidence, or link.
 */
function detectConflicts(db: DB, newId: number, embedding: number[], threshold: number) {
  const hits = vecSearch(db, embedding, 6)
    .filter((h) => h.id !== newId)
    .map((h) => ({ id: h.id, similarity: cosineFromL2(h.distance) }))
    .filter((h) => h.similarity >= threshold);
  if (hits.length === 0) return [];
  const map = getEntriesByIds(db, hits.map((h) => h.id));
  return hits
    .map((h) => {
      const e = map.get(h.id);
      return e ? { id: e.id, title: e.title, kind: e.kind, similarity: Number(h.similarity.toFixed(4)) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

export function registerVaultTool(server: McpServer, db: DB, paths?: Paths): void {
  server.registerTool(
    "vault",
    {
      title: "Vault",
      description:
        "The one door to durable knowledge — save to it and recall from it. Intent is inferred from " +
        "the fields you pass:\n" +
        "• RECALL: pass `query` alone. Do this BEFORE answering anything that may have been " +
        "researched or decided before — don't rehash from scratch.\n" +
        "• SAVE research: pass `findings` (+ optional `topic`, `sources`). SAVE a note/decision/etc: " +
        "pass `content` with a `kind`. Do this PROACTIVELY the moment a decision is made, a finding " +
        "is confirmed, or a reusable pattern emerges — don't wait to be told.\n" +
        "Every save runs a conflict check and returns any near-duplicate or contradicting entries so " +
        "you can supersede or link them (see entry_update). Superseded/archived entries are excluded " +
        "from recall unless you pass include_superseded.",
      inputSchema: {
        // --- recall ---------------------------------------------------------
        query: z.string().optional().describe("Recall: what to look for (natural language). Pass this alone to search."),
        limit: z.number().int().min(1).max(50).optional().describe("Recall: max results (default 8)."),
        include_superseded: z.boolean().optional().describe("Recall: also return superseded/archived entries."),
        // --- save -----------------------------------------------------------
        content: z.string().optional().describe("Save: free-form note/decision/pattern/question/memo/intention body."),
        findings: z.array(z.string().min(1)).optional().describe("Save research: distilled findings, one per item."),
        topic: z.string().optional().describe("Save research: the title for a findings entry."),
        sources: z
          .array(
            z.object({
              url: z.string().optional(),
              title: z.string().optional(),
              snippet: z.string().optional(),
            }),
          )
          .optional()
          .describe("Save research: the sources backing the findings."),
        kind: z.enum(KINDS).optional().describe("Save: entry kind (default note for `content`; research for `findings`)."),
        confidence: z.number().min(0).max(1).nullable().optional().describe("Save: confidence 0..1, or null for explicitly unknown."),
        tags: z.array(z.string()).optional().describe("Save/recall: topic tags."),
        project: z.string().optional().describe("Save/recall: associate with (or filter to) a project."),
        resolved: z.boolean().optional().describe("Save kind=question: whether it is already answered."),
        active: z.boolean().optional().describe("Save kind=intention: whether the commitment is live (default true)."),
      },
    },
    async (args) => {
      const isSave = Boolean(args.content && args.content.trim()) || Boolean(args.findings && args.findings.length);

      // ---------------------------------------------------------------- SAVE
      if (isSave) {
        const { threshold } = readConfig(db);
        let id: number;
        let title: string;
        let kind: EntryKind;
        let embedding: number[];

        if (args.findings && args.findings.length) {
          kind = "research";
          title = args.topic ?? deriveTitle(args.findings[0]);
          const body = args.findings.map((f) => `- ${f}`).join("\n");
          embedding = await embed(`${title}\n${args.findings.join("\n")}`);
          id = insertEntry(
            db,
            { kind, title, body, confidence: args.confidence ?? null, tags: args.tags ?? [], project: args.project ?? null },
            embedding,
          );
          for (const s of args.sources ?? []) insertSource(db, id, s);
        } else {
          const content = args.content!;
          kind = args.kind ?? "note";
          title = deriveTitle(content);
          embedding = await embed(content);
          id = insertEntry(
            db,
            {
              kind,
              title,
              body: content,
              confidence: args.confidence ?? null,
              tags: args.tags ?? [],
              project: args.project ?? null,
              resolved: kind === "question" ? args.resolved ?? false : undefined,
              active: kind === "intention" ? args.active ?? true : undefined,
            },
            embedding,
          );
        }

        const conflicts = detectConflicts(db, id, embedding, threshold);
        const summary =
          `Saved ${kind} #${id}: "${title}".` +
          (conflicts.length ? ` ⚠ ${conflicts.length} possible conflict(s) — review and link/supersede.` : "");
        return jsonResult(summary, { saved: { id, title, kind }, ...(conflicts.length ? { conflicts } : {}) });
      }

      // -------------------------------------------------------------- RECALL
      if (!args.query || !args.query.trim()) {
        return jsonResult("Nothing to do — pass `query` to recall, or `content`/`findings` to save.", {
          saved: null,
          results: [],
        });
      }

      const { boosts } = readConfig(db);
      const embedding = await embed(args.query);
      const hits = hybridSearch(db, embedding, args.query, {
        limit: args.limit ?? 8,
        kind: args.kind,
        includeSuperseded: args.include_superseded,
        boosts,
      });
      const results = hits.map((h) => ({
        id: h.entry.id,
        kind: h.entry.kind,
        title: h.entry.title,
        excerpt: excerpt(h.entry.body),
        tags: h.entry.tags,
        project: h.entry.project,
        status: h.entry.status,
        confidence: h.entry.confidence,
        created_at: h.entry.created_at,
        score: Number(h.score.toFixed(5)),
        matched: [h.matchedVec ? "semantic" : null, h.matchedFts ? "keyword" : null].filter(Boolean),
      }));
      // Record the trace so the dashboard can show what was just retrieved.
      if (paths) {
        writeLastFetch(paths.dataDir, {
          query: args.query,
          at: new Date().toISOString(),
          results: results.map((r) => ({ id: r.id, title: r.title, kind: r.kind, score: r.score })),
        });
      }
      return jsonResult(
        `Recalled ${results.length} entr${results.length === 1 ? "y" : "ies"} for "${args.query}".`,
        results,
      );
    },
  );
}
