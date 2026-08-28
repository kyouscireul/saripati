import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import {
  insertSession,
  latestSessions,
  recentEntries,
  listEntries,
  listProjects,
  getIdentity,
  unresolvedQuestions,
  activeIntentions,
  unreadMemos,
  lastEntryAtByProject,
  type EntryRow,
} from "../../db/queries.js";
import { bannerResult, jsonResult } from "./_result.js";

const DEFAULT_STALE_DAYS = 21;

/** A datetime('now')-format cutoff (UTC "YYYY-MM-DD HH:MM:SS") N days ago. */
function cutoff(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

function slim(e: EntryRow) {
  return { id: e.id, kind: e.kind, title: e.title, project: e.project, created_at: e.created_at };
}

export function registerSessionTools(server: McpServer, db: DB): void {
  server.registerTool(
    "on",
    {
      title: "Session on",
      description:
        "Start-of-session continuity load. Call this FIRST, every session, without being asked — " +
        "before doing any work. Returns the vault owner's identity (adopt the persona), the last " +
        "session digest, recent entries, active projects, and `nudges`: unresolved questions, active " +
        "intentions, unread memos (notes your past self left you), and stale projects. Surface the " +
        "nudges to the user proactively. If identity.user_prefs.focus is set, recent entries are " +
        "biased toward that project. Don't call it again mid-session.",
      inputSchema: {},
    },
    async () => {
      const identity = getIdentity(db);
      const session = latestSessions(db, 1)[0] ?? null;

      // Focus bias: if a focus project is set, lead with its recent entries.
      const focus = typeof identity?.user_prefs?.focus === "string" ? identity.user_prefs.focus : null;
      let recent: EntryRow[];
      if (focus) {
        const focused = listEntries(db, { project: focus, limit: 5 });
        const global = recentEntries(db, 8);
        const seen = new Set(focused.map((e) => e.id));
        recent = [...focused, ...global.filter((e) => !seen.has(e.id))].slice(0, 8);
      } else {
        recent = recentEntries(db, 8);
      }

      const projects = listProjects(db, "active");
      const staleDays =
        typeof identity?.companion_config?.stale_days === "number"
          ? (identity.companion_config.stale_days as number)
          : DEFAULT_STALE_DAYS;
      const lastByProject = lastEntryAtByProject(db);
      const staleAfter = cutoff(staleDays);
      const stale_projects = projects
        .filter((p) => {
          const last = lastByProject[p.name];
          return last && last < staleAfter; // touched before, but not lately
        })
        .map((p) => ({ name: p.name, stack: p.stack, last_entry_at: lastByProject[p.name] }));

      return bannerResult("Session context loaded.", {
        identity,
        focus,
        latest_session: session,
        recent_entries: recent.map(slim),
        active_projects: projects.map((p) => ({ name: p.name, stack: p.stack, status: p.status })),
        nudges: {
          unresolved_questions: unresolvedQuestions(db).map(slim),
          active_intentions: activeIntentions(db).map(slim),
          unread_memos: unreadMemos(db, session?.created_at ?? null).map(slim),
          stale_projects,
        },
      });
    },
  );

  server.registerTool(
    "off",
    {
      title: "Session off",
      description:
        "End-of-session digest. Call this when the session is wrapping up. Write the summary and " +
        "next steps YOURSELF from what happened — do not ask the user to dictate them. This is what " +
        "the next `on` resumes from, so be concrete about unfinished threads.",
      inputSchema: {
        title: z.string().min(1).describe("Short session title."),
        summary: z.string().min(1).describe("What happened this session — you write it."),
        next_steps: z.array(z.string()).optional().describe("Actionable follow-ups for next time."),
      },
    },
    async (args) => {
      const id = insertSession(db, args.title, args.summary, args.next_steps ?? []);
      return bannerResult(`Saved session #${id}: "${args.title}".`, {
        id,
        next_steps: args.next_steps ?? [],
      });
    },
  );
}
