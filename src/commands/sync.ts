import { resolve, join } from "node:path";
import { openDb } from "../db/db.js";
import { resolvePaths, type Paths } from "../config.js";
import { exportVault, importVault, syncVault } from "../sync/md.js";
import { report, frame, caps, c, sym } from "../term/theme.js";
import type { EntryKind } from "../db/queries.js";

/**
 * Markdown mirror commands:
 *   saripati export --md [--out <dir>] [--kind <k>] [--project <p>]
 *   saripati import --md [--force-md] [--prune]
 *   saripati sync        [--force-md] [--prune]
 */

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

/** Optionally redirect the Markdown mirror to a custom directory (--out). */
function withOut(paths: Paths, argv: string[]): Paths {
  const out = flagValue(argv, "--out");
  if (!out) return paths;
  const profileDir = resolve(out);
  return { ...paths, profileDir, memoryDir: join(profileDir, "memory") };
}

const KIND_SET = new Set<EntryKind>(["research", "note", "decision", "pattern"]);

export async function runExport(argv: string[]): Promise<void> {
  const cap = caps(process.stdout);
  const paths = withOut(resolvePaths(argv), argv);
  const db = openDb(paths);
  try {
    const kindArg = flagValue(argv, "--kind") as EntryKind | undefined;
    const kind = kindArg && KIND_SET.has(kindArg) ? kindArg : undefined;
    const project = flagValue(argv, "--project");

    const res = exportVault(db, paths, { kind, project });
    process.stdout.write(
      `\n${report("export → md", { written: res.written, identity: res.identity ? 1 : 0 }, cap)}\n`,
    );
    process.stdout.write(`  ${c.dim(sym.arrow)} ${c.dim(paths.profileDir)}\n`);
  } finally {
    db.close();
  }
}

export async function runImport(argv: string[]): Promise<void> {
  const cap = caps(process.stdout);
  const paths = withOut(resolvePaths(argv), argv);
  const db = openDb(paths);
  try {
    const res = await importVault(db, paths, {
      forceMd: argv.includes("--force-md"),
      prune: argv.includes("--prune"),
    });
    printImport(res, cap);
  } finally {
    db.close();
  }
}

export async function runSync(argv: string[]): Promise<void> {
  const cap = caps(process.stdout);
  const paths = withOut(resolvePaths(argv), argv);
  const db = openDb(paths);
  try {
    const { exported, imported } = await syncVault(db, paths, {
      forceMd: argv.includes("--force-md"),
      prune: argv.includes("--prune"),
    });
    process.stdout.write(
      `\n${report("sync · exported", { written: exported.written }, cap)}\n`,
    );
    printImport(imported, cap);
  } finally {
    db.close();
  }
}

function printImport(
  res: Awaited<ReturnType<typeof importVault>>,
  cap: ReturnType<typeof caps>,
): void {
  process.stdout.write(
    `\n${report("import ← md", {
      created: res.created,
      updated: res.updated,
      unchanged: res.unchanged,
      conflicted: res.conflicted,
      orphaned: res.orphaned,
      pruned: res.pruned,
      identity: res.identity ? 1 : 0,
    }, cap)}\n`,
  );
  if (res.conflicts.length) {
    const rows = res.conflicts.map((f) => `${c.err(sym.err)} ${f}`);
    rows.push(c.dim(`re-run with --force-md to let Markdown win`));
    process.stdout.write(`\n${frame("conflicts", rows, cap)}\n`);
  }
}
