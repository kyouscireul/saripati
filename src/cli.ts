#!/usr/bin/env node
/**
 * SARIPATI — command dispatcher.
 *
 *   saripati setup [setup.md]     Create the vault + identity, print host MCP config.
 *   saripati mcp   [--db <path>]  Run the MCP server over stdio (host connects here).
 *   saripati ui    [--port <n>]   Launch the local dashboard.
 *   saripati help                 Show this help.
 *
 * Subcommands are imported lazily so that `mcp` (the hot path) pays no cost for
 * the UI or setup dependencies.
 */

import { banner, caps } from "./term/theme.js";

const USAGE = `Usage:
  saripati setup   [setup.md] [--write]  Create the vault + identity, print the host config
  saripati mcp     [--db <path>]         Start the MCP server (stdio) — hosts connect here
  saripati ui      [--port <n>]          Open the dashboard to browse the corpus
  saripati help                          Show this help

Environment:
  SARIPATI_HOME   Data directory (default: ~/.saripati)
  SARIPATI_DB     Vault database path (default: <SARIPATI_HOME>/vault.db)
`;

/** Full help screen: the wordmark over usage. Rendered for stdout. */
function helpScreen(): string {
  return `${banner(undefined, caps(process.stdout))}\n\n${USAGE}`;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "setup": {
      const { runSetup } = await import("./commands/setup.js");
      await runSetup(rest);
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
      process.stdout.write(`${helpScreen()}\n`);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`saripati: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
