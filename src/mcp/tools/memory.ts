import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { insertEntry } from "../../db/queries.js";
import { hybridSearch } from "../../search/hybrid.js";
import { embed } from "../../embed/embedder.js";
import { jsonResult, deriveTitle, excerpt } from "./_result.js";

export function registerMemoryTools(server: McpServer, db: DB): void {
  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Capture a general piece of knowledge into the vault — a note, a decision, or a reusable " +
        "pattern. Use this for anything worth persisting that isn't formal research. Auto-embedded.",
      inputSchema: {
        content: z.string().min(1).describe("The knowledge to store. First line becomes the title."),
        kind: z
          .enum(["note", "decision", "pattern"])
          .optional()
          .describe("The kind of knowledge (default: note)."),
        tags: z.array(z.string()).optional().describe("Topic tags."),
        project: z.string().optional().describe("Associate with a project name."),
      },
    },
    async (args) => {
      const embedding = await embed(args.content);
      const id = insertEntry(
        db,
        {
          kind: args.kind ?? "note",
          title: deriveTitle(args.content),
          body: args.content,
          tags: args.tags ?? [],
          project: args.project ?? null,
        },
        embedding,
      );
      return jsonResult(`Remembered #${id} (${args.kind ?? "note"}).`, { id });
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Search the vault with hybrid semantic + keyword retrieval. Returns the most relevant " +
        "accumulated entries — research, notes, decisions, patterns — ranked by combined relevance.",
      inputSchema: {
        query: z.string().min(1).describe("What to look for. Natural language works well."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default: 8)."),
        kind: z
          .enum(["research", "note", "decision", "pattern"])
          .optional()
          .describe("Restrict to a single kind of entry."),
      },
    },
    async (args) => {
      const embedding = await embed(args.query);
      const hits = hybridSearch(db, embedding, args.query, {
        limit: args.limit ?? 8,
        kind: args.kind,
      });
      const results = hits.map((h) => ({
        id: h.entry.id,
        kind: h.entry.kind,
        title: h.entry.title,
        excerpt: excerpt(h.entry.body),
        tags: h.entry.tags,
        project: h.entry.project,
        confidence: h.entry.confidence,
        created_at: h.entry.created_at,
        score: Number(h.score.toFixed(5)),
        matched: [h.matchedVec ? "semantic" : null, h.matchedFts ? "keyword" : null].filter(Boolean),
      }));
      return jsonResult(
        `Recalled ${results.length} entr${results.length === 1 ? "y" : "ies"} for "${args.query}".`,
        results,
      );
    },
  );
}
