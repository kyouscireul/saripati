#!/usr/bin/env node
/**
 * SARIPATI — cold-install check.
 *
 * `npm test` runs against the working tree and therefore proves nothing about
 * what a stranger receives. This script walks the actual front door:
 *
 *   npm pack  →  install the tarball into a temp dir OUTSIDE the repo
 *             →  drive the installed package only, never src/ or dist/
 *
 * Install scripts are deliberately left ENABLED — running them is the point.
 * The failure this catches is the one that cost a real install: a native
 * dependency with no usable binary for the running Node.
 *
 * Run locally with `npm run test:install`; CI runs it on every OS x Node cell.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const IS_WIN = process.platform === "win32";

let failures = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m, detail) => {
  failures++;
  console.log(`  FAIL  ${m}`);
  if (detail) console.log(String(detail).split("\n").map((l) => `        ${l}`).join("\n"));
};

/**
 * Run a command, returning stdout/stderr separately so we can police the channels.
 *
 * `shell` is scoped to npm alone: npm is a .cmd shim on Windows and needs it,
 * but running `process.execPath` through cmd breaks on the space in
 * "C:\Program Files\nodejs".
 */
function run(cmd, args, opts = {}) {
  const base = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts };
  if (IS_WIN && cmd === "npm") {
    // Node 24 deprecates (DEP0190) passing an args array alongside shell:true,
    // so hand the shell one pre-quoted command string instead.
    const line = [cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" ");
    return execSync(line, base);
  }
  return execFileSync(cmd, args, base);
}

const workdir = mkdtempSync(join(tmpdir(), "saripati-cold-"));
const home = join(workdir, "home");
console.log(`\ncold-install check — ${PKG.name}@${PKG.version}`);
console.log(`  node ${process.versions.node} · ${process.platform}-${process.arch}`);
console.log(`  workdir ${workdir}\n`);

try {
  // -- 1. Pack -------------------------------------------------------------
  const packed = run("npm", ["pack", "--pack-destination", workdir, "--silent"], { cwd: REPO })
    .trim()
    .split("\n")
    .pop()
    .trim();
  const tarball = join(workdir, packed);
  if (!existsSync(tarball)) throw new Error(`npm pack produced no tarball (got "${packed}")`);
  pass(`packed ${packed}`);

  // -- 2. Install the tarball, scripts enabled -----------------------------
  run("npm", ["init", "-y"], { cwd: workdir });
  run("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel", "error"], {
    cwd: workdir,
  });
  pass("installed from tarball with install scripts enabled");

  const installed = join(workdir, "node_modules", "saripati");
  const cli = join(installed, "dist", "cli.js");
  if (!existsSync(cli)) throw new Error("dist/cli.js missing from the published tarball");

  // The single most valuable assertion here: nothing compiled at install time.
  const bs3 = join(workdir, "node_modules", "better-sqlite3");
  const builtFromSource =
    existsSync(join(bs3, "build")) && readdirSync(join(bs3, "build")).length > 0;
  if (builtFromSource) {
    fail("native dependency compiled from source (no prebuilt binary for this Node)");
  } else {
    pass("no native compilation — prebuilt binaries used");
  }

  const env = { ...process.env, SARIPATI_HOME: home, NO_COLOR: "1" };

  // -- 3. version ----------------------------------------------------------
  const version = run(process.execPath, [cli, "version"], { cwd: workdir, env }).trim();
  if (version === PKG.version) pass(`version reports ${version}`);
  else fail(`version mismatch: expected ${PKG.version}, got "${version}"`);

  // -- 4. setup creates a vault -------------------------------------------
  run(process.execPath, [cli, "setup"], { cwd: workdir, env });
  const dbPath = join(home, "vault.db");
  if (existsSync(dbPath)) pass("setup created the vault database");
  else fail(`setup did not create a vault at ${dbPath}`);

  // -- 5. MCP handshake over stdio ----------------------------------------
  const handshake = await mcpHandshake(cli, workdir, env);
  if (handshake.tools.length === 9) pass(`MCP handshake registered ${handshake.tools.length} tools`);
  else fail(`expected 9 MCP tools, got ${handshake.tools.length}`, handshake.tools.join(", "));

  if (handshake.stdoutClean) pass("stdout carried JSON-RPC only");
  else fail("non-JSON-RPC output leaked onto stdout", handshake.dirty);
} catch (err) {
  fail("cold install threw", err instanceof Error ? (err.stderr || err.message) : String(err));
} finally {
  // Windows holds file handles briefly after a child exits, so retry — and never
  // let a cleanup failure decide the verdict of the check.
  try {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.log(`  note  could not remove ${workdir} (${err.code ?? "error"}) — safe to delete`);
  }
}

console.log(failures === 0 ? "\ncold-install check passed.\n" : `\ncold-install check FAILED (${failures}).\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Speak MCP to the installed server over stdio: initialize, then tools/list.
 * Also records whether anything that is not JSON-RPC reached stdout — the
 * contract the whole presentation layer is built around.
 */
async function mcpHandshake(cli, cwd, env) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [cli, "mcp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const dirty = [];
    const tools = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      const settle = () =>
        resolveP({ tools, stdoutClean: dirty.length === 0, dirty: dirty.join("\n") });
      // Wait for the child to actually exit: until it does, it holds the vault
      // file open and the temp dir cannot be removed on Windows.
      child.once("exit", settle);
      child.kill();
      setTimeout(settle, 5_000).unref?.();
    };

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          dirty.push(line); // anything unparseable here would corrupt the host
          continue;
        }
        if (msg.id === 1) {
          send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
          send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          for (const t of msg.result?.tools ?? []) tools.push(t.name);
          finish();
        }
      }
    });

    child.on("error", finish);
    // The first vault open may download the embedding model; give it room.
    setTimeout(finish, 180_000).unref?.();

    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cold-install-check", version: "1.0.0" },
      },
    });
  });
}

function send(child, msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}
