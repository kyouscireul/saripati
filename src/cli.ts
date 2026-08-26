#!/usr/bin/env node
/**
 * SARIPATI — command dispatcher.
 *
 *   saripati init [--db <path>]   Create the vault + write host MCP config.
 *   saripati mcp  [--db <path>]   Run the MCP server over stdio (host connects here).
 *   saripati ui   [--port <n>]    Launch the local dashboard.
 *   saripati help                 Show this help.
 *
 * Subcommands are imported lazily so that `mcp` (the hot path) pays no cost for
 * the UI or init dependencies.
 */

const HELP = `saripati — a local-first, compounding knowledge vault for any AI host

Usage:
  saripati init [--db <path>]     Create the vault and register it with your AI host
  saripati mcp  [--db <path>]     Start the MCP server (stdio) — hosts connect here
  saripati ui   [--port <n>]      Open the dashboard to browse and export the corpus
  saripati help                   Show this help

Environment:
  SARIPATI_HOME   Data directory (default: ~/.saripati)
  SARIPATI_DB     Vault database path (default: <SARIPATI_HOME>/vault.db)
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "init": {
      const { runInit } = await import("./commands/init.js");
      await runInit(rest);
      break;
    }
    case "mcp": {
      const { runMcp } = await import("./mcp/server.js");
      await runMcp(rest);
      break;
    }
    case "ui": {
      const { runUi } = await import("./ui/server.js");
      await runUi(rest);
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`saripati: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
