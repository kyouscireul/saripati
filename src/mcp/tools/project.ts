import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { upsertProject, listProjects } from "../../db/queries.js";
import { jsonResult } from "./_result.js";

export function registerProjectTools(server: McpServer, db: DB): void {
  server.registerTool(
    "project_upsert",
    {
      title: "Upsert project",
      description:
        "Register or update a project in the vault's registry. Metadata is merged (JSON patch), so " +
        "you can add fields incrementally across calls.",
      inputSchema: {
        name: z.string().min(1).describe("Unique project name (the key)."),
        path: z.string().optional().describe("Filesystem path."),
        stack: z.string().optional().describe("Tech stack summary."),
        status: z
          .enum(["active", "parked", "idea", "archived"])
          .optional()
          .describe("Project status (default: active)."),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary metadata object, merged into existing."),
      },
    },
    async (args) => {
      const project = upsertProject(db, {
        name: args.name,
        path: args.path ?? null,
        stack: args.stack ?? null,
        status: args.status,
        metadata: args.metadata,
      });
      return jsonResult(`Upserted project "${project.name}".`, project);
    },
  );

  server.registerTool(
    "project_list",
    {
      title: "List projects",
      description: "List projects in the registry, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["active", "parked", "idea", "archived"])
          .optional()
          .describe("Filter by status."),
      },
    },
    async (args) => {
      const projects = listProjects(db, args.status);
      return jsonResult(`${projects.length} project(s).`, projects);
    },
  );
}
