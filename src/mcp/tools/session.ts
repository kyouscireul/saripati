import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { insertSession, latestSessions, recentEntries, listProjects, getIdentity } from "../../db/queries.js";
import { jsonResult } from "./_result.js";

export function registerSessionTools(server: McpServer, db: DB): void {
  server.registerTool(
    "session_boot",
    {
      title: "Session boot",
      description:
        "Load continuity context at the start of a work session: the vault owner's identity, the " +
        "most recent session digest, recently captured entries, and active projects. Call this " +
        "first to adopt the right persona and pick up where you left off.",
      inputSchema: {},
    },
    async () => {
      const identity = getIdentity(db);
      const session = latestSessions(db, 1)[0] ?? null;
      const recent = recentEntries(db, 8).map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        project: e.project,
        created_at: e.created_at,
      }));
      const projects = listProjects(db, "active").map((p) => ({
        name: p.name,
        stack: p.stack,
        status: p.status,
      }));
      return jsonResult("Session context loaded.", {
        identity,
        latest_session: session,
        recent_entries: recent,
        active_projects: projects,
      });
    },
  );

  server.registerTool(
    "session_save",
    {
      title: "Session save",
      description:
        "Write a session digest to the vault — what was accomplished and what comes next — so the " +
        "next session can resume via session_boot.",
      inputSchema: {
        title: z.string().min(1).describe("Short session title."),
        summary: z.string().min(1).describe("What happened this session."),
        next_steps: z.array(z.string()).optional().describe("Actionable follow-ups for next time."),
      },
    },
    async (args) => {
      const id = insertSession(db, args.title, args.summary, args.next_steps ?? []);
      return jsonResult(`Saved session #${id}: "${args.title}".`, {
        id,
        next_steps: args.next_steps ?? [],
      });
    },
  );
}
