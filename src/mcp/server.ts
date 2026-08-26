import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";
import { warmup } from "../embed/embedder.js";
import { registerResearchTools } from "./tools/research.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerSessionTools } from "./tools/session.js";
import { registerProjectTools } from "./tools/project.js";
import { registerStatusTools } from "./tools/status.js";

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

  // Front-load the model so the first tool call is fast and no load output
  // races the protocol handshake. Non-fatal if it fails (recall/save will retry).
  try {
    process.stderr.write("saripati: loading embedding model…\n");
    await warmup();
    process.stderr.write("saripati: model ready.\n");
  } catch (err) {
    process.stderr.write(
      `saripati: warning — embedding model failed to preload: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }

  const server = new McpServer({ name: "saripati", version: "0.1.0" });

  registerResearchTools(server, db);
  registerMemoryTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerStatusTools(server, db);

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
