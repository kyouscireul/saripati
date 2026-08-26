import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { insertEntry, insertSource } from "../../db/queries.js";
import { embed } from "../../embed/embedder.js";
import { jsonResult } from "./_result.js";

export function registerResearchTools(server: McpServer, db: DB): void {
  server.registerTool(
    "save_research",
    {
      title: "Save research",
      description:
        "Persist a structured research finding into the vault so it compounds across sessions. " +
        "You (the host AI) do the web research with your own tools, then call this to store it: " +
        "a topic, the distilled findings, and the sources you drew from. Auto-embedded for later recall.",
      inputSchema: {
        topic: z.string().min(1).describe("The subject of this research — becomes the entry title."),
        findings: z
          .array(z.string().min(1))
          .min(1)
          .describe("Distilled claims/findings, one per item. Stored as a bulleted body."),
        sources: z
          .array(
            z.object({
              url: z.string().optional().describe("Source URL."),
              title: z.string().optional().describe("Source title."),
              snippet: z.string().optional().describe("Relevant quote/snippet."),
            }),
          )
          .optional()
          .describe("The sources backing these findings."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Your confidence in these findings, 0..1."),
        tags: z.array(z.string()).optional().describe("Topic tags for clustering/filtering."),
        project: z.string().optional().describe("Associate with a project name."),
      },
    },
    async (args) => {
      const body = args.findings.map((f) => `- ${f}`).join("\n");
      const embedding = await embed(`${args.topic}\n${args.findings.join("\n")}`);
      const id = insertEntry(
        db,
        {
          kind: "research",
          title: args.topic,
          body,
          confidence: args.confidence ?? null,
          tags: args.tags ?? [],
          project: args.project ?? null,
        },
        embedding,
      );
      const sources = args.sources ?? [];
      for (const s of sources) insertSource(db, id, s);

      return jsonResult(
        `Saved research #${id}: "${args.topic}" (${args.findings.length} findings, ${sources.length} sources).`,
        { id, findings: args.findings.length, sources: sources.length },
      );
    },
  );
}
