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

import { banner, caps } from "./term/theme.js";

const USAGE = `Usage:
  saripati init    [--db <path>]  Create the vault and register it with your AI host
  saripati onboard                Set up your identity + optional companion persona
  saripati mcp     [--db <path>]  Start the MCP server (stdio) — hosts connect here
  saripati ui      [--port <n>]   Open the dashboard to browse and export the corpus
  saripati export  --md [--out d] Mirror the vault to an Obsidian-friendly folder
  saripati import  --md [--force-md] [--prune]   Reconcile Markdown edits back in
  saripati sync    [--force-md] [--prune]        Export then import in one pass
  saripati help                   Show this help

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
    case "init": {
      const { runInit } = await import("./commands/init.js");
      await runInit(rest);
      break;
    }
    case "onboard": {
      const { runOnboard } = await import("./commands/onboard.js");
      await runOnboard(rest);
      break;
    }
    case "export": {
      const { runExport } = await import("./commands/sync.js");
      await runExport(rest);
      break;
    }
    case "import": {
      const { runImport } = await import("./commands/sync.js");
      await runImport(rest);
      break;
    }
    case "sync": {
      const { runSync } = await import("./commands/sync.js");
      await runSync(rest);
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
