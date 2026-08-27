import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";
import { warmup } from "../embed/embedder.js";
import { registerVaultTool } from "./tools/vault.js";
import { registerEntryTools } from "./tools/entry.js";
import { registerSessionTools } from "./tools/session.js";
import { registerProjectTools } from "./tools/project.js";
import { registerStatusTools } from "./tools/status.js";
import { registerIdentityTools } from "./tools/identity.js";
import { banner, caps, VERSION } from "../term/theme.js";

/**
 * Run the SARIPATI MCP server over stdio. This is the process an AI host spawns
 * and speaks JSON-RPC to.
 *
 * IMPORTANT: stdout is reserved for the JSON-RPC channel. All diagnostics go to
 * stderr, and the embedding model is warmed up BEFORE the transport connects so
 * any model-load output cannot corrupt the protocol stream.
 */
export async function runMcp(argv: string[] = []): Promise<void> {
  const paths = resolvePaths(argv);
  const db = openDb(paths);

  // Wordmark to stderr ONLY — stdout is the JSON-RPC transport and must stay pure.
  process.stderr.write(`${banner(VERSION, caps(process.stderr))}\n`);

  // Front-load the model so the first tool call is fast and no load output
  // races the protocol handshake. Non-fatal if it fails (recall/save will retry).
  // First run downloads ~90 MB and can stall 30–60s silently, so emit an
  // elapsed-time heartbeat to stderr — otherwise users assume it hung.
  const loadStart = Date.now();
  process.stderr.write("saripati: loading embedding model…\n");
  const heartbeat = setInterval(() => {
    process.stderr.write(`saripati: loading embedding model… (${Math.round((Date.now() - loadStart) / 1000)}s)\n`);
  }, 12_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  try {
    await warmup();
    process.stderr.write(`saripati: model ready (${Math.round((Date.now() - loadStart) / 1000)}s).\n`);
  } catch (err) {
    process.stderr.write(
      `saripati: warning — embedding model failed to preload: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  } finally {
    clearInterval(heartbeat);
  }

  const server = new McpServer({ name: "saripati", version: VERSION });

  registerVaultTool(server, db, paths);
  registerEntryTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerStatusTools(server, db);
  registerIdentityTools(server, db);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`saripati: MCP server ready (vault: ${paths.dbPath}).\n`);

  const shutdown = () => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
