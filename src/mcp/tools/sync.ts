import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import type { Paths } from "../../config.js";
import { exportVault, importVault } from "../../sync/md.js";
import { jsonResult } from "./_result.js";

/**
 * Markdown-mirror tools, so a host can project the vault to an Obsidian-friendly
 * folder and reconcile hand edits back — without leaving the conversation.
 */
export function registerSyncTools(server: McpServer, db: DB, paths: Paths): void {
  server.registerTool(
    "export_md",
    {
      title: "Export to Markdown",
      description:
        "Project the vault to its Obsidian-compatible Markdown folder (IDENTITY.md, MEMORY.md, and " +
        "one file per entry with wikilinks + backlinks). Optionally filter by kind or project.",
      inputSchema: {
        kind: z.enum(["research", "note", "decision", "pattern"]).optional().describe("Only export this kind."),
        project: z.string().optional().describe("Only export entries in this project."),
      },
    },
    async (args) => {
      const res = exportVault(db, paths, { kind: args.kind, project: args.project });
      return jsonResult(`Exported ${res.written} entr${res.written === 1 ? "y" : "ies"} to Markdown.`, {
        ...res,
        dir: paths.profileDir,
      });
    },
  );

  server.registerTool(
    "import_md",
    {
      title: "Import from Markdown",
      description:
        "Reconcile hand edits in the Markdown folder back into the vault (re-embedding changed " +
        "entries). Reports created/updated/unchanged/conflicted/orphaned. Set force_md to let " +
        "Markdown win conflicts; set prune to delete vault entries whose files were removed.",
      inputSchema: {
        force_md: z.boolean().optional().describe("On conflict, let the Markdown edit win."),
        prune: z.boolean().optional().describe("Delete vault entries that have no Markdown file."),
      },
    },
    async (args) => {
      const res = await importVault(db, paths, { forceMd: args.force_md, prune: args.prune });
      return jsonResult(
        `Import: ${res.created} created, ${res.updated} updated, ${res.conflicted} conflicted.`,
        res,
      );
    },
  );
}
