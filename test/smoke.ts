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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { openDb } from "../src/db/db.js";
import { SCHEMA_VERSION } from "../src/db/migrations.js";
import {
  insertEntry,
  updateEntry,
  getEntry,
  corpusStatus,
  getIdentity,
  upsertIdentity,
  clearIdentity,
  unresolvedQuestions,
  activeIntentions,
  unreadMemos,
} from "../src/db/queries.js";
import { hybridSearch } from "../src/search/hybrid.js";
import { buildLinkContext, deriveLinks, basenameFor } from "../src/graph/links.js";
import { readLastFetch } from "../src/trace.js";
import { embed } from "../src/embed/embedder.js";
import { registerVaultTool } from "../src/mcp/tools/vault.js";
import { registerEntryTools } from "../src/mcp/tools/entry.js";
import { registerSessionTools } from "../src/mcp/tools/session.js";
import { registerProjectTools } from "../src/mcp/tools/project.js";
import { registerStatusTools } from "../src/mcp/tools/status.js";
import { registerIdentityTools } from "../src/mcp/tools/identity.js";
import { paint, banner, frame, report, caps, type Caps } from "../src/term/theme.js";

const paths = {
  dataDir: tmpdir(),
  dbPath: join(tmpdir(), `saripati-smoke-${Date.now()}.db`),
  modelCacheDir: join(tmpdir(), "saripati-models"),
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

  // 0b. Legacy-vault migration — a v0.2.0 DB upgrades in place on openDb ----
  {
    const legacyPath = join(tmpdir(), `saripati-legacy-${Date.now()}.db`);
    const legacy = new Database(legacyPath);
    sqliteVec.load(legacy);
    legacy.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('research','note','decision','pattern')),
        title TEXT NOT NULL, body TEXT NOT NULL, confidence REAL,
        tags TEXT NOT NULL DEFAULT '[]', project TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE VIRTUAL TABLE vec_entries USING vec0(embedding float[384]);
      CREATE VIRTUAL TABLE fts_entries USING fts5(title, body, tags);
      INSERT INTO entries (kind, title, body) VALUES ('note', 'Legacy note', 'kept across upgrade');
    `);
    legacy.pragma("user_version = 0");
    legacy.close();

    const up = openDb({ dataDir: tmpdir(), dbPath: legacyPath, modelCacheDir: join(tmpdir(), "saripati-models") });
    assert.equal(
      Number(up.pragma("user_version", { simple: true })),
      SCHEMA_VERSION,
      "legacy DB upgraded to current schema version",
    );
    const cols = (up.prepare(`PRAGMA table_info(entries)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ["status", "superseded_by", "links", "resolved", "active"]) {
      assert.ok(cols.includes(c), `legacy upgrade adds column ${c}`);
    }
    assert.ok(
      up.prepare(`SELECT 1 FROM entries WHERE title = 'Legacy note'`).get(),
      "legacy row survives the table rebuild",
    );
    // The widened CHECK now accepts the new kinds.
    up.prepare(`INSERT INTO entries (kind, title, body) VALUES ('question', 'q', 'b')`).run();
    up.close();
    console.log("  ✓ migration: v0.2.0 vault upgrades in place, data preserved");
  }

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

  // Migrations: openDb stamps the DB to the current schema version.
  assert.equal(
    Number(db.pragma("user_version", { simple: true })),
    SCHEMA_VERSION,
    "openDb runs migrations up to SCHEMA_VERSION",
  );

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

  // 3a. Link graph (extracted from the retired MD engine; powers /api/graph) ---
  {
    // A third entry that shares the "lazada" tag with the research entry → a tag edge.
    const relatedId = insertEntry(
      db,
      { kind: "note", title: "Lazada seller onboarding", body: "Checklist for new sellers.", tags: ["lazada"] },
      await embed("Lazada seller onboarding checklist"),
    );
    const ctx = buildLinkContext(db);
    assert.equal(ctx.nodes.length, 3, "link context holds every entry");
    const research = ctx.byId.get(researchId)!;
    assert.equal(research.basename, basenameFor("research", "Lazada affiliate commission trends", researchId), "basename rule stable");
    const edges = deriveLinks(ctx, research, "Rates rose 4-6% for electronics.");
    // Keep this block links-free: a typed link between these fixtures would
    // outrank the shared-tag edge and this assertion would flip to "relation".
    assert.ok(edges.some((e) => e.to.id === relatedId && e.type === "tag"), "shared tag derives a tag edge");

    // 3a1. Typed relations (entry_update `links`) become the strongest edge ----
    // Append new fixtures AFTER this block — the nodes.length check above is exact.
    updateEntry(db, relatedId, { links: [{ id: researchId, rel: "supersedes" }] });
    const ctx2 = buildLinkContext(db);
    const rel = ctx2.byId.get(relatedId)!;
    assert.deepEqual(rel.links, [{ id: researchId, rel: "supersedes" }], "link context carries hydrated links");
    const relEdges = deriveLinks(ctx2, rel, "").filter((e) => e.to.id === researchId);
    assert.equal(relEdges.length, 1, "one edge per target — relation absorbs the redundant tag edge");
    assert.equal(relEdges[0].type, "relation", "explicit typed link outranks a shared-tag edge");
    assert.equal(relEdges[0].rel, "supersedes", "the specific rel rides along on the edge");

    // Dangling ids (the target was deleted) and self-links must vanish, never
    // surface as `{ to: undefined }` — /api/graph reads link.to.project directly.
    updateEntry(db, relatedId, { links: [{ id: 999999, rel: "related" }, { id: relatedId, rel: "related" }] });
    const ctx3 = buildLinkContext(db);
    const e3 = deriveLinks(ctx3, ctx3.byId.get(relatedId)!, "");
    assert.ok(e3.every((e) => e.to && e.to.id !== relatedId), "dangling ids and self-links produce no edge");
    assert.ok(e3.every((e) => e.type !== "relation"), "no relation edge survives from dangling/self links");

    updateEntry(db, relatedId, { links: [] }); // restore — later sections re-read the corpus
  }
  console.log("  ✓ link graph: buildLinkContext + deriveLinks (shared-tag edge)");
  console.log("  ✓ typed relations: relation outranks tag, rel preserved, dangling/self dropped");

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

  // 3d. New kinds + lifecycle columns (v0.3.0 schema) ----------------------
  {
    const qId = insertEntry(
      db,
      { kind: "question", title: "Which affiliate network pays fastest?", body: "Open question on payout latency.", resolved: false },
      await embed("affiliate network payout latency question"),
    );
    const mId = insertEntry(
      db,
      { kind: "memo", title: "Ask Kyou about the Hunter.io key", body: "Confirm the API key next session." },
      await embed("memo confirm hunter api key next session"),
    );
    const iId = insertEntry(
      db,
      { kind: "intention", title: "Ship Propello Stage 2", body: "A commitment spanning sessions.", active: true },
      await embed("intention ship propello stage two"),
    );

    const q = getEntry(db, qId)!;
    assert.equal(q.kind, "question", "question kind persists");
    assert.equal(q.resolved, false, "question round-trips resolved=false");
    assert.equal(q.active, null, "non-intention keeps active=null");
    assert.equal(q.status, "active", "new entries default to status=active");
    assert.deepEqual(q.links, [], "links default to an empty array");
    assert.equal(getEntry(db, iId)!.active, true, "intention round-trips active=true");

    // Metadata-only update must NOT re-embed: the entry stays recallable.
    const upd = updateEntry(db, qId, { resolved: true, confidence: null })!;
    assert.equal(upd.resolved, true, "resolved flips via metadata update");
    assert.equal(upd.body, q.body, "metadata update leaves body intact");
    const stillThere = hybridSearch(db, await embed("affiliate network payout latency"), "affiliate payout latency", { limit: 8 });
    assert.ok(stillThere.some((h) => h.entry.id === qId), "embedding preserved across metadata-only update");

    // Status + superseded_by transition round-trips.
    const sup = updateEntry(db, mId, { status: "superseded", superseded_by: iId })!;
    assert.equal(sup.status, "superseded", "status transitions to superseded");
    assert.equal(sup.superseded_by, iId, "superseded_by records the replacement id");
    console.log("  ✓ new kinds: question/memo/intention round-trip; metadata update keeps embedding");
  }

  // 3e. Recall: superseded exclusion + per-kind boost ----------------------
  {
    const decOldId = insertEntry(
      db,
      { kind: "decision", title: "Use SQLite for the widget cache", body: "Chose SQLite for the widget cache layer." },
      await embed("widget cache storage decision sqlite"),
    );
    const decNewId = insertEntry(
      db,
      { kind: "decision", title: "Use Redis for the widget cache", body: "Superseding: switched the widget cache to Redis." },
      await embed("widget cache storage decision redis"),
    );
    updateEntry(db, decOldId, { status: "superseded", superseded_by: decNewId });

    const cacheQ = await embed("what did we choose for the widget cache");
    const def = hybridSearch(db, cacheQ, "widget cache decision", { limit: 10 });
    assert.ok(!def.some((h) => h.entry.id === decOldId), "superseded decision excluded from default recall");
    assert.ok(def.some((h) => h.entry.id === decNewId), "current decision still recalled");
    const withOld = hybridSearch(db, cacheQ, "widget cache decision", { limit: 10, includeSuperseded: true });
    assert.ok(withOld.some((h) => h.entry.id === decOldId), "includeSuperseded surfaces the old decision");

    // Kind boost: an equally-relevant memo outranks a note by default.
    const noteId = insertEntry(
      db,
      { kind: "note", title: "Deploy checklist alpha", body: "Steps to deploy the alpha build safely." },
      await embed("deploy checklist alpha build steps"),
    );
    const memoId = insertEntry(
      db,
      { kind: "memo", title: "Deploy checklist alpha", body: "Steps to deploy the alpha build safely." },
      await embed("deploy checklist alpha build steps"),
    );
    const dq = await embed("deploy checklist alpha build steps");
    const ranked = hybridSearch(db, dq, "deploy checklist alpha build steps", { limit: 10 });
    const mi = ranked.findIndex((h) => h.entry.id === memoId);
    const ni = ranked.findIndex((h) => h.entry.id === noteId);
    assert.ok(mi !== -1 && ni !== -1 && mi < ni, "memo outranks an equally-relevant note (default boost)");

    const overridden = hybridSearch(db, dq, "deploy checklist alpha build steps", { limit: 10, boosts: { note: 5.0 } });
    assert.ok(
      overridden.findIndex((h) => h.entry.id === noteId) < overridden.findIndex((h) => h.entry.id === memoId),
      "per-call boosts override flips the ranking",
    );
    console.log("  ✓ recall: superseded excluded by default; kind boost + override");
  }

  // 3f. Steerer nudge queries — the substance the /api/nudges endpoint wires --
  {
    // Self-contained fixtures so this section is independent of earlier mutations.
    const openQId = insertEntry(
      db,
      { kind: "question", title: "Do we support multi-currency payouts?", body: "Still undecided.", resolved: false },
      await embed("multi currency payout support open question"),
    );
    const answeredQId = insertEntry(
      db,
      { kind: "question", title: "Which DB for the cache?", body: "Answered: Redis.", resolved: true },
      await embed("cache database choice answered redis"),
    );
    const liveIntentId = insertEntry(
      db,
      { kind: "intention", title: "Publish v0.3.1 Steerer Console", body: "Ship the UI pass.", active: true },
      await embed("intention publish steerer console ui"),
    );
    const doneIntentId = insertEntry(
      db,
      { kind: "intention", title: "Publish v0.3.0", body: "Already shipped.", active: false },
      await embed("intention publish v0.3.0 shipped"),
    );
    const freshMemoId = insertEntry(
      db,
      { kind: "memo", title: "Wire the Steer tab into the dashboard", body: "Reminder to self." },
      await embed("memo wire steer tab dashboard reminder"),
    );

    const openQs = unresolvedQuestions(db);
    assert.ok(openQs.some((e) => e.id === openQId), "unresolvedQuestions surfaces the open question");
    assert.ok(!openQs.some((e) => e.id === answeredQId), "unresolvedQuestions excludes the answered one");

    const intents = activeIntentions(db);
    assert.ok(intents.some((e) => e.id === liveIntentId), "activeIntentions surfaces the live intention");
    assert.ok(!intents.some((e) => e.id === doneIntentId), "activeIntentions excludes the inactive one");

    // A memo created after a cutoff is 'unread'; one before it is not.
    const before = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    const recentMemos = unreadMemos(db, before);
    assert.ok(recentMemos.some((e) => e.id === freshMemoId), "unreadMemos surfaces a memo newer than the cutoff");
    const futureCut = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19).replace("T", " ");
    assert.ok(!unreadMemos(db, futureCut).some((e) => e.id === freshMemoId), "unreadMemos honors the since-cutoff");

    // Marking the open question resolved drops it from the nudge (dashboard toggle path).
    updateEntry(db, openQId, { resolved: true });
    assert.ok(!unresolvedQuestions(db).some((e) => e.id === openQId), "resolving a question clears the nudge");
    console.log("  ✓ nudges: unresolved questions / active intentions / unread memos filter correctly");
  }

  // 4. MCP loop ------------------------------------------------------------
  const server = new McpServer({ name: "saripati", version: "0.1.0" });
  registerVaultTool(server, db, paths);
  registerEntryTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerStatusTools(server, db);
  registerIdentityTools(server, db);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "corpus",
    "entry_update",
    "identity_set",
    "off",
    "on",
    "project_list",
    "project_update",
    "vault",
    "whoami",
  ], "all 9 tools must register");

  // vault recall path.
  const recall = (await client.callTool({ name: "vault", arguments: { query: "Lazada commission" } })) as {
    content: { text: string }[];
  };
  assert.ok(recall.content[0].text.includes("Lazada"), "vault recall must return the Lazada entry");

  // Retrieval trace: the recall above must have written a last-fetch record.
  const trace = readLastFetch(paths.dataDir);
  assert.ok(trace && trace.query === "Lazada commission", "vault recall writes a retrieval trace");
  assert.ok(Array.isArray(trace!.results), "trace carries the retrieved result list");

  // vault save path + post-save conflict detection. Save a decision, then save
  // an identical one — the near-duplicate must be flagged (cosine ≈ 1.0).
  const dupText = "Redis is our chosen cache for hot marketplace keys.";
  await client.callTool({ name: "vault", arguments: { content: dupText, kind: "decision" } });
  const dup = (await client.callTool({ name: "vault", arguments: { content: dupText, kind: "decision" } })) as {
    content: { text: string }[];
  };
  const dupPayload = JSON.parse(dup.content[0].text.split("\n\n").at(-1)!);
  assert.ok(dupPayload.saved?.id, "vault save returns the new id");
  assert.ok(Array.isArray(dupPayload.conflicts) && dupPayload.conflicts.length >= 1, "near-duplicate save flags a conflict");

  // entry_update resolves it: supersede the duplicate; recall then drops it.
  await client.callTool({ name: "entry_update", arguments: { id: dupPayload.saved.id, status: "superseded", superseded_by: dupPayload.conflicts[0].id } });
  const after = (await client.callTool({ name: "vault", arguments: { query: dupText } })) as { content: { text: string }[] };
  const afterResults = JSON.parse(after.content[0].text.split("\n\n").at(-1)!) as { id: number }[];
  assert.ok(!afterResults.some((r) => r.id === dupPayload.saved.id), "superseded duplicate excluded from recall");
  console.log("  ✓ vault: recall + save, conflict detection, entry_update supersede");

  // whoami reflects the identity set above; `on` embeds it and surfaces nudges.
  const who = (await client.callTool({ name: "whoami", arguments: {} })) as { content: { text: string }[] };
  assert.ok(who.content[0].text.includes("Kyou"), "whoami must return the identity");
  const boot = (await client.callTool({ name: "on", arguments: {} })) as { content: { text: string }[] };
  const bootPayload = JSON.parse(boot.content[0].text.split("\n\n").at(-1)!);
  assert.equal(bootPayload.identity.user_name, "Kyou", "on payload must include identity");
  // Nudges: the active intention inserted earlier must surface.
  assert.ok(
    bootPayload.nudges.active_intentions.some((e: { title: string }) => e.title === "Ship Propello Stage 2"),
    "on surfaces active intentions as a nudge",
  );
  assert.ok(Array.isArray(bootPayload.nudges.unread_memos), "on payload carries the nudges block");
  console.log("  ✓ MCP loop: 9 tools register, on carries identity + nudges");

  // Focus bias: set a focus project, `on` leads recent entries with it.
  await client.callTool({ name: "identity_set", arguments: { user_prefs: { focus: "propello" } } });
  const focused = (await client.callTool({ name: "on", arguments: {} })) as { content: { text: string }[] };
  const focusedPayload = JSON.parse(focused.content[0].text.split("\n\n").at(-1)!);
  assert.equal(focusedPayload.focus, "propello", "on echoes the active focus");
  assert.equal(focusedPayload.recent_entries[0].project, "propello", "focus biases recent entries to the project");
  console.log("  ✓ on: focus bias leads recent entries with the focused project");

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
