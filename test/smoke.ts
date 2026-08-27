/**
 * SARIPATI smoke test — exercises the full stack end to end against a temp vault:
 *   1. embedder: 384-dim, unit-normalized, semantically ordered
 *   2. data + hybrid recall: a paraphrased query surfaces the right entry
 *   3. corpus_status accounting
 *   4. MCP loop: all 8 tools register and a recall round-trips through the SDK
 *
 * Run: npm test   (exits non-zero on any failed assertion)
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/db/db.js";
import {
  insertEntry,
  corpusStatus,
  getIdentity,
  upsertIdentity,
  clearIdentity,
  updateEntry,
  getEntry,
  allEntries,
  ftsSearch,
} from "../src/db/queries.js";
import { exportVault, importVault, slugify } from "../src/sync/md.js";
import { hybridSearch } from "../src/search/hybrid.js";
import { embed } from "../src/embed/embedder.js";
import { registerResearchTools } from "../src/mcp/tools/research.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerSessionTools } from "../src/mcp/tools/session.js";
import { registerProjectTools } from "../src/mcp/tools/project.js";
import { registerStatusTools } from "../src/mcp/tools/status.js";
import { registerIdentityTools } from "../src/mcp/tools/identity.js";
import { registerSyncTools } from "../src/mcp/tools/sync.js";
import { paint, banner, frame, report, caps, type Caps } from "../src/term/theme.js";

const profileDir = join(tmpdir(), `saripati-smoke-profile-${Date.now()}`);
const paths = {
  dataDir: tmpdir(),
  dbPath: join(tmpdir(), `saripati-smoke-${Date.now()}.db`),
  modelCacheDir: join(tmpdir(), "saripati-models"),
  profileDir,
  memoryDir: join(profileDir, "memory"),
};

function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[[0-9;]*m/;
const stripLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

async function main(): Promise<void> {
  // 0. Presentation layer (theme) — pure, no model needed -----------------
  const plain: Caps = { color: false, unicode: false };
  const colored: Caps = { color: true, unicode: true };

  // Colour is opt-out-safe: off → passthrough; on → wrapped in escapes.
  assert.equal(paint(plain).amber("x"), "x", "plain caps must not colour");
  assert.ok(ESC.test(paint(colored).amber("x")), "colour caps must emit escapes");

  // Degraded output is clean 7-bit ASCII — no escape codes, ASCII box glyphs.
  const plainBanner = banner("9.9.9", plain);
  assert.ok(!ESC.test(plainBanner), "plain banner must contain no escape codes");
  assert.ok(plainBanner.includes("+") && plainBanner.includes("S A R I P A T I"), "plain banner uses ASCII box + wordmark");
  assert.ok(banner("9.9.9", plain).includes("9.9.9"), "banner shows the given version");
  assert.ok(ESC.test(banner("9.9.9", colored)), "coloured banner must emit escapes");

  // frame() rows are padded to a single, consistent visible width.
  const fr = frame("t", ["short", "a longer row here"], plain).split("\n");
  const widths = new Set(fr.map(stripLen));
  assert.equal(widths.size, 1, "all frame lines share one visible width");

  // report() renders every count and never throws on tone mapping.
  const rep = report("sync", { created: 2, updated: 1, conflicted: 0 }, plain);
  assert.ok(rep.includes("created") && rep.includes("conflicted"), "report lists all counts");

  // caps() degrades a non-TTY stream to plain ASCII (the pipe/CI path).
  const piped = caps({ isTTY: false } as NodeJS.WriteStream);
  assert.equal(piped.color, false, "non-TTY stream must disable colour");
  assert.equal(piped.unicode, false, "non-TTY stream must disable Unicode");
  console.log("  ✓ theme: colour/Unicode degrade to clean ASCII off-TTY; frame aligns");

  // 1. Embedder ------------------------------------------------------------
  const a = await embed("Lazada affiliate commission rates for electronics in Malaysia");
  const b = await embed("Commission earnings on Lazada gadgets in the Malaysian market");
  const c = await embed("How to bake sourdough bread at home");
  assert.equal(a.length, 384, "embedding must be 384-dim");
  assert.ok(Math.abs(Math.sqrt(dot(a, a)) - 1) < 1e-3, "embedding must be unit-normalized");
  assert.ok(dot(a, b) > dot(a, c), "related pair must score higher than unrelated");
  console.log("  ✓ embedder: 384-dim, normalized, semantically ordered");

  // 2. Data + hybrid recall -----------------------------------------------
  const db = openDb(paths);
  const researchId = insertEntry(
    db,
    { kind: "research", title: "Lazada affiliate commission trends", body: "Rates rose 4-6% for electronics.", tags: ["lazada"], project: "propello" },
    a,
  );
  insertEntry(
    db,
    { kind: "note", title: "Sourdough baking", body: "Hydration and starter tips.", tags: ["food"] },
    c,
  );
  const q = await embed("commission earnings on Lazada gadgets");
  const hits = hybridSearch(db, q, "commission earnings Lazada gadgets", { limit: 5 });
  assert.ok(hits.length >= 1, "recall must return results");
  assert.equal(hits[0].entry.id, researchId, "paraphrased query must rank the Lazada entry first");
  console.log("  ✓ hybrid recall: paraphrase surfaces the right entry first");

  // 3. corpus_status -------------------------------------------------------
  const status = corpusStatus(db);
  assert.equal(status.total, 2, "corpus should hold 2 entries");
  assert.equal(status.byKind.research, 1);
  assert.equal(status.byKind.note, 1);
  console.log("  ✓ corpus_status: accounting correct");

  // 3b. Identity round-trip (singleton, incremental merge) -----------------
  assert.equal(getIdentity(db), null, "identity starts empty");
  upsertIdentity(db, {
    user_name: "Kyou",
    user_field: "Software Engineering",
    user_prefs: { language: "English", skills: ["supabase"] },
    companion_name: "Sage",
    companion_role: "Librarian",
  });
  // A second partial upsert must MERGE prefs, not replace the row.
  const merged = upsertIdentity(db, { user_prefs: { address: "by name" } });
  assert.equal(merged.id, 1, "identity is a singleton at id 1");
  assert.equal(merged.user_name, "Kyou", "scalar fields survive a partial upsert");
  assert.equal(merged.companion_name, "Sage", "companion survives a partial upsert");
  assert.equal(merged.user_prefs.language, "English", "json_patch keeps prior prefs");
  assert.equal(merged.user_prefs.address, "by name", "json_patch adds new prefs");
  console.log("  ✓ identity: singleton round-trip, prefs merge (json_patch)");

  // 3c. Markdown bidirectional sync ---------------------------------------
  const researchFile = join(paths.memoryDir, `research_${slugify("Lazada affiliate commission trends")}-${researchId}.md`);

  // Export writes one file per entry + the index.
  const exp = exportVault(db, paths);
  assert.equal(exp.written, 2, "export writes a file per entry");
  assert.ok(existsSync(researchFile), "entry file exists after export");
  assert.ok(existsSync(join(paths.profileDir, "MEMORY.md")), "index written");

  // Unedited re-import is a STABLE no-op — never a spurious re-embed.
  const noop = await importVault(db, paths);
  assert.equal(noop.created + noop.updated + noop.conflicted, 0, "unedited import changes nothing");
  assert.equal(noop.unchanged, 2, "both entries unchanged");

  // Edit a body in the folder → import re-embeds AND rebuilds the FTS row.
  const edited = readFileSync(researchFile, "utf8").replaceAll(
    "Rates rose 4-6% for electronics.",
    "Quarterly uplift: twelve percent growth in Q3 gadgets.",
  );
  writeFileSync(researchFile, edited, "utf8");
  const imp = await importVault(db, paths);
  assert.equal(imp.updated, 1, "edited entry is updated");
  assert.equal(imp.conflicted, 0, "clean edit is not a conflict");
  const reloaded = getEntry(db, researchId)!;
  assert.ok(reloaded.body.includes("Quarterly"), "DB body reflects the edit");
  assert.ok(
    ftsSearch(db, "Quarterly", 5).some((h) => h.id === researchId),
    "FTS row rebuilt: new token is searchable",
  );
  assert.ok(
    !ftsSearch(db, "rose", 5).some((h) => h.id === researchId),
    "FTS row rebuilt: old token no longer matches",
  );

  // A hand-created file (no id) is inserted and back-filled to a canonical name.
  const handFile = join(paths.memoryDir, "my-hand-note.md");
  writeFileSync(
    handFile,
    ['---', 'type: note', 'title: "Manual idea"', 'tags: [handmade]', '---', '# Manual idea', '', 'A note written by hand in Obsidian.', ''].join("\n"),
    "utf8",
  );
  const impNew = await importVault(db, paths);
  assert.equal(impNew.created, 1, "hand-created file is inserted");
  const manual = allEntries(db).find((e) => e.title === "Manual idea");
  assert.ok(manual, "inserted entry exists in the DB");
  const canonical = join(paths.memoryDir, `note_${slugify("Manual idea")}-${manual!.id}.md`);
  assert.ok(existsSync(canonical), "file renamed to canonical, id back-filled");
  assert.ok(!existsSync(handFile), "original hand filename removed");

  // Conflict: DB and the same file both diverge from the merge base.
  updateEntry(db, researchId, { body: "DB divergent change." }, await embed("DB divergent change."));
  writeFileSync(
    researchFile,
    readFileSync(researchFile, "utf8").replaceAll(
      "Quarterly uplift: twelve percent growth in Q3 gadgets.",
      "MD divergent change.",
    ),
    "utf8",
  );
  const conflict = await importVault(db, paths);
  assert.equal(conflict.conflicted, 1, "both-sides edit is a conflict");
  assert.equal(getEntry(db, researchId)!.body, "DB divergent change.", "conflict leaves the DB untouched");
  const forced = await importVault(db, paths, { forceMd: true });
  assert.equal(forced.updated, 1, "--force-md resolves the conflict");
  assert.equal(getEntry(db, researchId)!.body, "MD divergent change.", "Markdown wins under --force-md");
  console.log("  ✓ md sync: no-op stable, edit re-embeds+re-indexes, back-fill, conflict + force");

  // 4. MCP loop ------------------------------------------------------------
  const server = new McpServer({ name: "saripati", version: "0.1.0" });
  registerResearchTools(server, db);
  registerMemoryTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerStatusTools(server, db);
  registerIdentityTools(server, db);
  registerSyncTools(server, db, paths);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "corpus_status",
    "export_md",
    "identity_set",
    "import_md",
    "project_list",
    "project_upsert",
    "recall",
    "remember",
    "save_research",
    "session_boot",
    "session_save",
    "whoami",
  ], "all 12 tools must register");
  const recall = (await client.callTool({ name: "recall", arguments: { query: "Lazada commission" } })) as {
    content: { text: string }[];
  };
  assert.ok(recall.content[0].text.includes("Lazada"), "MCP recall must return the Lazada entry");

  // whoami reflects the identity set above; session_boot embeds it.
  const who = (await client.callTool({ name: "whoami", arguments: {} })) as { content: { text: string }[] };
  assert.ok(who.content[0].text.includes("Kyou"), "whoami must return the identity");
  const boot = (await client.callTool({ name: "session_boot", arguments: {} })) as { content: { text: string }[] };
  const bootPayload = JSON.parse(boot.content[0].text.split("\n\n").slice(1).join("\n\n"));
  assert.equal(bootPayload.identity.user_name, "Kyou", "session_boot payload must include identity");
  console.log("  ✓ MCP loop: 12 tools register, whoami + session_boot carry identity");

  clearIdentity(db);
  assert.equal(getIdentity(db), null, "clearIdentity empties the singleton");

  await client.close();
  await server.close();
  db.close();
  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
