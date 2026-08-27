import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { openDb } from "../db/db.js";
import { resolvePaths } from "../config.js";
import { upsertIdentity } from "../db/queries.js";
import { findPersona } from "../data/personas.js";
import { banner, caps, c, sym } from "../term/theme.js";

/**
 * `saripati setup` — one command to stand a vault up (replaces init + onboard).
 *
 *   saripati setup                 Create the vault, print the MCP snippet + detected hosts.
 *   saripati setup ./setup.md      Also read identity from the file's YAML frontmatter.
 *   saripati setup ./setup.md --write   Also merge the config into detected hosts.
 *   saripati setup --from <dir>    Use <dir> as the vault/data directory.
 *   saripati setup --dev           Emit a local (node dist) command instead of `npx saripati`.
 *
 * Writing to host configs is opt-in (--write) — we always print, never silently edit.
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
  if (existsSync(file)) {
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

/* -------------------------------------------------------------------------- */

type FmValue = string | string[];

/** A tolerant YAML-frontmatter subset: `key: value`, `[a, b]` arrays, and
 *  block lists (`key:` then `  - item`). No dependency. */
function parseFrontmatter(raw: string): Record<string, FmValue> {
  const text = raw.replace(/^﻿/, "");
  let header = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) header = text.slice(3, end);
  }
  const fm: Record<string, FmValue> = {};
  const lines = header.split(/\r?\n/);
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "")));
      }
      if (items.length) fm[key] = items;
    } else if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      fm[key] = unquote(val);
    }
  }
  return fm;
}

function asString(v: FmValue | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function asArray(v: FmValue | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Map setup.md frontmatter onto the identity row (+ optional companion preset). */
function applyIdentity(db: ReturnType<typeof openDb>, fm: Record<string, FmValue>): boolean {
  const name = asString(fm.name);
  const field = asString(fm.field);
  const skills = asArray(fm.skills);
  const language = asString(fm.language);
  const companionId = asString(fm.companion);
  const preset = companionId ? findPersona(companionId) : undefined;

  if (!name && !field && skills.length === 0 && !language && !preset) return false;

  upsertIdentity(db, {
    user_name: name ?? null,
    user_field: field ?? null,
    user_prefs: {
      ...(skills.length ? { skills } : {}),
      ...(language ? { language } : {}),
    },
    companion_name: preset?.companion_name ?? null,
    companion_role: preset?.companion_role ?? null,
    companion_tone: preset?.companion_tone ?? null,
    companion_config: preset?.companion_config ?? {},
  });
  return true;
}

export async function runSetup(argv: string[]): Promise<void> {
  // --from <dir> overrides the data directory before paths resolve.
  const from = flagValue(argv, "--from");
  if (from) process.env.SARIPATI_HOME = resolve(from);

  const setupFile = argv.find((a) => !a.startsWith("--") && /\.md$/i.test(a));
  const paths = resolvePaths(argv);
  const db = openDb(paths); // creates vault.db + applies schema/migrations
  const out = process.stdout;

  out.write(`\n${banner(undefined, caps(process.stdout))}\n`);
  out.write(`\nVault ready at:\n  ${paths.dbPath}\n`);

  // Identity from setup.md (optional).
  if (setupFile) {
    const full = resolve(setupFile);
    if (!existsSync(full)) {
      out.write(`\n  ${c.dim(sym.bullet)} setup file not found: ${full}\n`);
    } else {
      const applied = applyIdentity(db, parseFrontmatter(readFileSync(full, "utf8")));
      out.write(
        applied
          ? `\n  ${c.ok(sym.ok)} Identity loaded from ${setupFile}.\n`
          : `\n  ${c.dim(sym.bullet)} No identity fields found in ${setupFile}.\n`,
      );
    }
  }
  db.close();

  // MCP config snippet — always printed.
  const cfg = serverConfig(argv);
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
    out.write(`\nTo register automatically, re-run:  saripati setup --write [--host <id>]\n`);
    out.write(`Host ids: ${targets.map((t) => t.id).join(", ")}\n`);
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
      out.write(`  ${action}: ${t.label} → ${t.file}\n`);
    } catch (err) {
      out.write(`  skipped: ${t.label} — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  out.write(`\nDone. Restart your AI host to load SARIPATI.\n`);
}
