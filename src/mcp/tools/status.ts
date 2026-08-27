import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { corpusStatus, lastEntryAtByProject } from "../../db/queries.js";
import { jsonResult } from "./_result.js";

export function registerStatusTools(server: McpServer, db: DB): void {
  server.registerTool(
    "corpus",
    {
      title: "Corpus",
      description:
        "A map of what the vault holds: total entries, breakdown by kind, top topic tags, per-project " +
        "last-activity timestamps, and project/session counts. Call this at session start (after `on`) " +
        "to see what already exists before you query or research — so you build on the corpus instead " +
        "of duplicating it.",
      inputSchema: {},
    },
    async () => {
      const status = corpusStatus(db);
      return jsonResult(
        `Vault holds ${status.total} entr${status.total === 1 ? "y" : "ies"} across ${
          Object.keys(status.byKind).length
        } kind(s).`,
        { ...status, last_entry_at: lastEntryAtByProject(db) },
      );
    },
  );
}
