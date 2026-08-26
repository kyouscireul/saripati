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
import { openDb } from "../src/db/db.js";
import { insertEntry, corpusStatus } from "../src/db/queries.js";
import { hybridSearch } from "../src/search/hybrid.js";
import { embed } from "../src/embed/embedder.js";
import { registerResearchTools } from "../src/mcp/tools/research.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerSessionTools } from "../src/mcp/tools/session.js";
import { registerProjectTools } from "../src/mcp/tools/project.js";
import { registerStatusTools } from "../src/mcp/tools/status.js";

const paths = {
  dataDir: tmpdir(),
  dbPath: join(tmpdir(), `saripati-smoke-${Date.now()}.db`),
  modelCacheDir: join(tmpdir(), "saripati-models"),
};

function dot(a: number[], b: number[]): number {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

async function main(): Promise<void> {
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

  // 4. MCP loop ------------------------------------------------------------
  const server = new McpServer({ name: "saripati", version: "0.1.0" });
  registerResearchTools(server, db);
  registerMemoryTools(server, db);
  registerSessionTools(server, db);
  registerProjectTools(server, db);
  registerStatusTools(server, db);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "corpus_status",
    "project_list",
    "project_upsert",
    "recall",
    "remember",
    "save_research",
    "session_boot",
    "session_save",
  ], "all 8 tools must register");
  const recall = (await client.callTool({ name: "recall", arguments: { query: "Lazada commission" } })) as {
    content: { text: string }[];
  };
  assert.ok(recall.content[0].text.includes("Lazada"), "MCP recall must return the Lazada entry");
  console.log("  ✓ MCP loop: 8 tools register, recall round-trips");

  await client.close();
  await server.close();
  db.close();
  console.log("\nAll smoke tests passed.");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
