import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { updateEntry, type EntryKind, type EntryLink } from "../../db/queries.js";
import { jsonResult } from "./_result.js";

const KINDS = ["research", "note", "decision", "pattern", "question", "memo", "intention"] as const;
const RELS = ["because-of", "supersedes", "related", "contradicts"] as const;

export function registerEntryTools(server: McpServer, db: DB): void {
  server.registerTool(
    "entry_update",
    {
      title: "Update entry",
      description:
        "Mutate an existing entry's metadata — the other half of the conflict loop. After vault " +
        "flags a conflict, call this to resolve it: mark the older entry status='superseded' with " +
        "superseded_by set to the newer id, lower a confidence, retag, change kind, resolve a " +
        "question (resolved=true), close an intention (active=false), or add explicit typed links. " +
        "This is metadata-only: it never edits the body and never re-embeds, so recall stays stable.",
      inputSchema: {
        id: z.number().int().describe("The entry id to update (required)."),
        status: z.enum(["active", "superseded", "archived"]).optional().describe("Lifecycle state."),
        confidence: z.number().min(0).max(1).nullable().optional().describe("Confidence 0..1, or null for unknown."),
        superseded_by: z.number().int().nullable().optional().describe("Id of the entry that replaces this one."),
        tags: z.array(z.string()).optional().describe("Replace the tag set."),
        kind: z.enum(KINDS).optional().describe("Reclassify the entry."),
        resolved: z.boolean().nullable().optional().describe("For kind=question: mark answered/open."),
        active: z.boolean().nullable().optional().describe("For kind=intention: mark live/closed."),
        links: z
          .array(z.object({ id: z.number().int(), rel: z.enum(RELS) }))
          .optional()
          .describe("Explicit typed links to other entries (replaces the set)."),
      },
    },
    async (args) => {
      const { id, ...patch } = args;
      const updated = updateEntry(db, id, {
        status: patch.status,
        confidence: patch.confidence,
        superseded_by: patch.superseded_by,
        tags: patch.tags,
        kind: patch.kind as EntryKind | undefined,
        resolved: patch.resolved,
        active: patch.active,
        links: patch.links as EntryLink[] | undefined,
      });
      if (!updated) return jsonResult(`No entry #${id}.`, { updated: null });
      return jsonResult(`Updated entry #${id} (${updated.kind}, status=${updated.status}).`, { updated });
    },
  );
}
