import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { corpusStatus } from "../../db/queries.js";
import { jsonResult } from "./_result.js";

export function registerStatusTools(server: McpServer, db: DB): void {
  server.registerTool(
    "corpus_status",
    {
      title: "Corpus status",
      description:
        "Report what the vault currently holds: total entries, breakdown by kind, top topic tags, " +
        "project and session counts, and when it was last updated. Use it to gauge coverage and freshness.",
      inputSchema: {},
    },
    async () => {
      const status = corpusStatus(db);
      return jsonResult(
        `Vault holds ${status.total} entr${status.total === 1 ? "y" : "ies"} across ${
          Object.keys(status.byKind).length
        } kind(s).`,
        status,
      );
    },
  );
}
