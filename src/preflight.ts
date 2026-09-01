/**
 * SARIPATI — install/runtime preflight.
 *
 * The native surface is small but unforgiving, and its raw failures are
 * unreadable: a node-gyp dump, or a bare "no such vtable: vec0". This module
 * turns each into one framed, actionable sentence.
 *
 * Two checks:
 *   1. `checkPlatform()`  — static. Is this platform/arch covered by the
 *      prebuilt binaries we depend on? Runs before any native module loads.
 *   2. `explainNativeFailure()` — dynamic. Rescues a throw from opening the
 *      database or loading the vec0 extension and re-renders it with a fix.
 *
 * Safety contract (inherited from ../term/theme.ts and never broken):
 *   - Everything here writes to **stderr only**. `stdout` carries MCP JSON-RPC
 *     and must stay clean, so no diagnostic may ever reach it.
 *   - Rendering degrades to plain 7-bit ASCII off-TTY, via `caps(process.stderr)`.
 */

import { caps, frame, paint, symbols } from "./term/theme.js";

const ISSUES_URL = "https://github.com/kyouscireul/saripati/issues";

/** Lowest Node this package supports — keep in sync with package.json `engines`. */
export const MIN_NODE_MAJOR = 22;

/**
 * Platforms with a prebuilt `sqlite-vec` loadable extension, published as
 * per-platform optional dependencies of `sqlite-vec`.
 *
 * `better-sqlite3` v13 is N-API and bundles binaries for every platform below
 * *plus* win32-arm64 and musl, so it is not the limiting factor — `sqlite-vec`
 * is. Keep this list in step with sqlite-vec's `optionalDependencies`.
 */
const VEC_PLATFORMS = new Set([
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
]);

/** This machine, in the `platform-arch` form the prebuild matrices are keyed by. */
export function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}

/** Major version of the running Node, e.g. 22 from "v22.17.1". */
export function nodeMajor(): number {
  return Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
}

export interface PreflightIssue {
  title: string;
  /** What is wrong, in one sentence. */
  problem: string;
  /** What the user should do about it, in one sentence. */
  fix: string;
}

/**
 * Static environment check. Returns `null` when the environment is supported.
 *
 * Deliberately does NOT import any native module — this must be able to run and
 * report *before* the thing it is warning about would crash.
 */
export function checkPlatform(): PreflightIssue | null {
  const major = nodeMajor();
  if (major > 0 && major < MIN_NODE_MAJOR) {
    return {
      title: "unsupported node",
      problem: `SARIPATI needs Node ${MIN_NODE_MAJOR} or newer — this is Node ${process.versions.node}.`,
      fix: `Install Node ${MIN_NODE_MAJOR} LTS from https://nodejs.org (or 'nvm install ${MIN_NODE_MAJOR}'), then retry.`,
    };
  }

  const target = currentTarget();
  if (!VEC_PLATFORMS.has(target)) {
    return {
      title: "unsupported platform",
      problem: `No prebuilt sqlite-vec extension exists for ${target}, so semantic search cannot load.`,
      fix: `Run SARIPATI under an emulated x64 Node, or open an issue at ${ISSUES_URL}.`,
    };
  }

  return null;
}

/**
 * Turn a throw from `openDb()` into a `PreflightIssue`, if we recognise it.
 * Returns `null` for errors that are not about native loading, so ordinary
 * SQLite errors (a corrupt file, a bad path) keep their real message.
 */
export function explainNativeFailure(err: unknown): PreflightIssue | null {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const target = currentTarget();

  // ABI / missing-binding failures from better-sqlite3.
  if (
    /NODE_MODULE_VERSION|was compiled against a different Node|Could not locate the bindings file|MODULE_NOT_FOUND.*better.sqlite3|better_sqlite3\.node/i.test(
      msg,
    )
  ) {
    return {
      title: "native module failed to load",
      problem: `better-sqlite3 has no usable binary for Node ${process.versions.node} on ${target}.`,
      fix: `Reinstall on Node ${MIN_NODE_MAJOR} LTS: 'nvm use ${MIN_NODE_MAJOR}' then clear the npx cache and retry.`,
    };
  }

  // sqlite-vec extension load failure.
  if (/vec0|vec_version|loadExtension|not authorized|specified module could not be found/i.test(msg)) {
    return {
      title: "vector extension failed to load",
      problem: `The sqlite-vec (vec0) extension could not load on ${target}.`,
      fix: `Reinstall dependencies so the sqlite-vec-${target} package is present, or report ${target} at ${ISSUES_URL}.`,
    };
  }

  return null;
}

/** Render an issue as a framed block. Returns a string; the caller picks the stream. */
export function renderIssue(issue: PreflightIssue): string {
  const cap = caps(process.stderr);
  const p = paint(cap);
  const s = symbols(cap);
  // Honour the ASCII contract: no Unicode separator when Unicode is off.
  const sep = cap.unicode ? "·" : "-";
  const rows = [
    `${p.err(s.bullet)} ${issue.problem}`,
    `${p.ok(s.bullet)} ${issue.fix}`,
    "",
    `${p.dim(`node ${process.versions.node} ${sep} ${currentTarget()}`)}`,
  ];
  return frame(issue.title, rows, cap);
}

/**
 * Run the static check and, if it fails, print the diagnosis to **stderr**.
 * Returns true when the environment is usable.
 *
 * Non-fatal by design: an unsupported platform still lets `version` and `help`
 * work, and the dynamic rescue in `openDb()` catches the real crash if the user
 * pushes on anyway.
 */
export function preflight(): boolean {
  const issue = checkPlatform();
  if (!issue) return true;
  process.stderr.write(`${renderIssue(issue)}\n`);
  return false;
}
