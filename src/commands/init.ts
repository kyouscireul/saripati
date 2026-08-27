import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";

/**
 * `saripati init` — create the vault and help register it with an AI host.
 *
 *   saripati init                 Create vault, print the config snippet + detected hosts.
 *   saripati init --write         Also merge the config into every detected host file.
 *   saripati init --write --host cursor   Write to a single host.
 *   saripati init --dev           Emit a local (node dist) command instead of `npx saripati`.
 *
 * Writing is opt-in (--write) so we never silently modify a live host config.
 */

interface HostTarget {
  id: string;
  label: string;
  file: string;
}

function hostTargets(): HostTarget[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  return [
    { id: "claude", label: "Claude Code", file: join(home, ".claude.json") },
    { id: "cursor", label: "Cursor", file: join(home, ".cursor", "mcp.json") },
    { id: "windsurf", label: "Windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json") },
    { id: "claude-desktop", label: "Claude Desktop", file: join(appData, "Claude", "claude_desktop_config.json") },
  ];
}

function serverConfig(argv: string[]): { command: string; args: string[] } {
  if (argv.includes("--dev")) {
    // Local development: point at the built CLI in this repo.
    const cliPath = join(process.cwd(), "dist", "cli.js");
    return { command: process.execPath, args: [cliPath, "mcp"] };
  }
  return { command: "npx", args: ["-y", "saripati", "mcp"] };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function mergeIntoHost(file: string, cfg: { command: string; args: string[] }): "created" | "updated" {
  let json: Record<string, unknown> = {};
  const existed = existsSync(file);
  if (existed) {
    try {
      json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`Existing config at ${file} is not valid JSON; refusing to overwrite.`);
    }
    copyFileSync(file, `${file}.bak`);
  }
  const servers = (json.mcpServers ??= {}) as Record<string, unknown>;
  const isUpdate = "saripati" in servers;
  servers.saripati = cfg;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  return isUpdate ? "updated" : "created";
}

export async function runInit(argv: string[]): Promise<void> {
  const paths = resolvePaths(argv);
  const db = openDb(paths); // creates vault.db + schema
  db.close();

  const cfg = serverConfig(argv);
  const out = process.stdout;

  out.write(`\nSARIPATI vault ready at:\n  ${paths.dbPath}\n`);
  out.write(`\nMCP server config (add under "mcpServers"):\n\n`);
  out.write(`${JSON.stringify({ saripati: cfg }, null, 2)}\n\n`);

  const targets = hostTargets();
  const wantWrite = argv.includes("--write");
  const onlyHost = flagValue(argv, "--host");

  if (!wantWrite) {
    out.write(`Detected host config locations:\n`);
    for (const t of targets) {
      out.write(`  [${existsSync(t.file) ? "found" : "     "}] ${t.label.padEnd(15)} ${t.file}\n`);
    }
    out.write(`\nTo register automatically, re-run:  saripati init --write [--host <id>]\n`);
    out.write(`Host ids: ${targets.map((t) => t.id).join(", ")}\n`);
    out.write(`\nNext, personalize your vault:  saripati onboard\n`);
    return;
  }

  const chosen = onlyHost
    ? targets.filter((t) => t.id === onlyHost)
    : targets.filter((t) => existsSync(t.file));

  if (chosen.length === 0) {
    out.write(
      onlyHost
        ? `No host matched id "${onlyHost}". Valid ids: ${targets.map((t) => t.id).join(", ")}\n`
        : `No existing host configs detected. Specify one with --host <id>.\n`,
    );
    return;
  }

  for (const t of chosen) {
    try {
      const action = mergeIntoHost(t.file, cfg);
      out.write(`  ${action === "created" ? "created" : "updated"}: ${t.label} → ${t.file}\n`);
    } catch (err) {
      out.write(`  skipped: ${t.label} — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  out.write(`\nDone. Restart your AI host to load SARIPATI.\n`);
}
