import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Central resolution of where SARIPATI keeps its state.
 *
 * Precedence for the vault database:
 *   1. --db <path> CLI flag
 *   2. SARIPATI_DB environment variable
 *   3. <dataDir>/vault.db  (default)
 *
 * Data directory precedence:
 *   1. SARIPATI_HOME environment variable
 *   2. ~/.saripati            (default)
 */

export interface Paths {
  dataDir: string;
  dbPath: string;
  modelCacheDir: string;
  /** Obsidian-compatible Markdown mirror of the vault (created on demand by export/import). */
  profileDir: string;
  /** One Markdown file per entry, under profileDir. */
  memoryDir: string;
}

function parseDbFlag(argv: string[]): string | undefined {
  const i = argv.indexOf("--db");
  if (i !== -1 && argv[i + 1]) return resolve(argv[i + 1]);
  const inline = argv.find((a) => a.startsWith("--db="));
  if (inline) return resolve(inline.slice("--db=".length));
  return undefined;
}

export function resolvePaths(argv: string[] = process.argv.slice(2)): Paths {
  const dataDir = process.env.SARIPATI_HOME
    ? resolve(process.env.SARIPATI_HOME)
    : join(homedir(), ".saripati");

  const dbPath =
    parseDbFlag(argv) ??
    (process.env.SARIPATI_DB ? resolve(process.env.SARIPATI_DB) : join(dataDir, "vault.db"));

  const modelCacheDir = join(dataDir, "models");
  const profileDir = join(dataDir, "profile");
  const memoryDir = join(profileDir, "memory");

  return { dataDir, dbPath, modelCacheDir, profileDir, memoryDir };
}

/** Create the Markdown mirror directories. Called only by export/import — the
 *  MCP hot path never pays for this. */
export function ensureProfileDir(paths: Paths): void {
  mkdirSync(paths.memoryDir, { recursive: true }); // recursive → also creates profileDir
}

export function ensureDataDir(paths: Paths): void {
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.modelCacheDir, { recursive: true });
}
