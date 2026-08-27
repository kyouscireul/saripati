import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DB } from "../../db/db.js";
import { getIdentity, upsertIdentity } from "../../db/queries.js";
import { jsonResult, textResult } from "./_result.js";

/**
 * Identity tools let a host load and shape "who am I working with" — the vault
 * owner's profile plus an optional AI-companion persona.
 */
export function registerIdentityTools(server: McpServer, db: DB): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Return the vault owner's identity: their profile/preferences and the configured AI " +
        "companion persona (if any). Use this to adopt the right voice and address the user " +
        "correctly. If empty, suggest running `saripati onboard`.",
      inputSchema: {},
    },
    async () => {
      const identity = getIdentity(db);
      if (!identity) {
        return textResult(
          "No identity set yet. Ask the user to run `saripati onboard`, or set it " +
            "conversationally with the identity_set tool.",
        );
      }
      return jsonResult("Vault identity loaded.", identity);
    },
  );

  server.registerTool(
    "identity_set",
    {
      title: "Set identity",
      description:
        "Create or update the vault owner's identity conversationally. Scalar fields are only " +
        "replaced when provided; user_prefs and companion_config objects are merged (JSON patch), " +
        "so you can build the persona incrementally across calls.",
      inputSchema: {
        user_name: z.string().optional().describe("The user's name."),
        user_field: z.string().optional().describe("The user's field or line of work."),
        user_prefs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Preferences object (skills, communication_style, address, language, …), merged."),
        companion_name: z.string().optional().describe("AI companion's name."),
        companion_role: z.string().optional().describe("AI companion's role."),
        companion_tone: z.string().optional().describe("AI companion's tone/voice."),
        companion_config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Extended persona config (traits, values, habits, protocols), merged."),
      },
    },
    async (args) => {
      const identity = upsertIdentity(db, {
        user_name: args.user_name ?? null,
        user_field: args.user_field ?? null,
        user_prefs: args.user_prefs,
        companion_name: args.companion_name ?? null,
        companion_role: args.companion_role ?? null,
        companion_tone: args.companion_tone ?? null,
        companion_config: args.companion_config,
      });
      return jsonResult("Identity updated.", identity);
    },
  );
}
