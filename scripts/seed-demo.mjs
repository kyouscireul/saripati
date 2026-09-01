#!/usr/bin/env node
/**
 * SARIPATI — demo corpus seeder.
 *
 * Builds a synthetic but organic-looking vault for screenshots and demos. It is
 * NOT sample data for users to keep: every entry here is invented, and it writes
 * to its own SARIPATI_HOME so a real vault is never touched.
 *
 *   node scripts/seed-demo.mjs [--home <dir>] [--force]
 *
 * Default home: <repo>/.demo-vault (gitignored). Refuses a non-empty vault
 * without --force, and always refuses the default ~/.saripati.
 *
 * Why it exists: the honest failure mode of a demo vault is looking imported.
 * A thousand entries all stamped within one hour, every kind the same, nothing
 * superseded, no open questions — that renders a Steer tab with nothing to
 * steer. So this seeds all seven kinds, a real lifecycle (superseded/archived
 * with superseded_by set), resolved and unresolved questions, live and closed
 * intentions, memos newer than the last session (which is what makes them
 * "unread"), typed relations and wikilinks for graph edges, sources for
 * provenance, and timestamps scattered across five months in working bursts.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const REPO = resolve(import.meta.dirname, "..");
const homeFlag = args.indexOf("--home");
const HOME = homeFlag !== -1 ? resolve(args[homeFlag + 1]) : join(REPO, ".demo-vault");
const FORCE = args.includes("--force");

const realHome = join(process.env.HOME || process.env.USERPROFILE || "", ".saripati");
if (resolve(HOME) === resolve(realHome)) {
  console.error(`refusing to seed the default vault at ${realHome}.\nPass --home <dir> to choose a demo location.`);
  process.exit(1);
}

process.env.SARIPATI_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const dbFile = join(HOME, "vault.db");
if (existsSync(dbFile)) {
  if (!FORCE) {
    console.error(`${dbFile} already exists. Re-run with --force to rebuild it from scratch.`);
    process.exit(1);
  }
  for (const suffix of ["", "-shm", "-wal"]) rmSync(dbFile + suffix, { force: true });
}

const { openDb } = await import("../dist/db/db.js");
const { insertEntry, insertSource, updateEntry, upsertProject, upsertIdentity, insertSession } =
  await import("../dist/db/queries.js");
const { embed, warmup } = await import("../dist/embed/embedder.js");
const { writeLastFetch } = await import("../dist/trace.js");

/* --------------------------------------------------------------------------
 * Time. Entries land in bursts on weekdays, the way real work does, rather
 * than smeared evenly across the calendar.
 * ------------------------------------------------------------------------ */

const NOW = new Date("2026-09-01T09:00:00Z");
const DAY = 86_400_000;

/** `daysAgo` -> a SQLite datetime string, nudged onto a plausible working hour. */
function stamp(daysAgo, hour = 10, minute = 0) {
  const d = new Date(NOW.getTime() - daysAgo * DAY);
  // Drag weekend work back to Friday — the corpus should look like a job.
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(hour, minute, Math.floor(Math.random() * 60), 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/* --------------------------------------------------------------------------
 * Projects
 * ------------------------------------------------------------------------ */

const PROJECTS = [
  { name: "atlas-api", stack: "Go 1.23 · Postgres 16 · Redis", path: "~/work/atlas-api",
    metadata: { role: "billing + entitlements service", team: "platform" } },
  { name: "northwind-web", stack: "Next.js 15 · React 19 · TypeScript", path: "~/work/northwind-web",
    metadata: { role: "customer storefront", team: "web" } },
  { name: "tidepool", stack: "Python 3.12 · Airflow · dbt · Snowflake", path: "~/work/tidepool",
    metadata: { role: "analytics pipeline", team: "data" } },
  { name: "ledger-core", stack: "Rust · Postgres · Kafka", path: "~/work/ledger-core",
    metadata: { role: "double-entry ledger", team: "payments" } },
  { name: "sentry-ops", stack: "Terraform · Kubernetes · Grafana", path: "~/work/sentry-ops",
    metadata: { role: "infrastructure + observability", team: "platform" } },
  { name: "cartographer", stack: "React Native · Expo 54 · SQLite", path: "~/work/cartographer",
    metadata: { role: "field survey app", team: "mobile" } },
  { name: "glasshouse", stack: "TypeScript · Style Dictionary · Storybook", path: "~/work/glasshouse",
    metadata: { role: "design system + tokens", team: "web" }, status: "parked" },
];

/* --------------------------------------------------------------------------
 * The corpus.
 *
 * [kind, daysAgo, project, title, body, tags, extras?]
 * extras: { confidence, status, supersededBy (title), resolved, active,
 *           links: [[title, rel]], sources: [{url,title,snippet}] }
 * ------------------------------------------------------------------------ */

const E = [];
const add = (kind, daysAgo, project, title, body, tags, extras = {}) =>
  E.push({ kind, daysAgo, project, title, body, tags, ...extras });

/* ---- atlas-api ---------------------------------------------------------- */
add("research", 148, "atlas-api", "Postgres advisory locks vs SELECT FOR UPDATE for job claiming",
  "Advisory locks are cheaper when the contended resource is not a row: no tuple lock, no bloat from repeated updates. pg_try_advisory_xact_lock releases automatically at transaction end, which removes the leak risk of the session-scoped variant. SELECT FOR UPDATE SKIP LOCKED remains simpler when the queue genuinely is a table.",
  ["postgres", "concurrency", "locking"],
  { confidence: 0.8, sources: [
    { url: "https://www.postgresql.org/docs/16/explicit-locking.html", title: "PostgreSQL: Explicit Locking" },
    { url: "https://www.enterprisedb.com/blog/what-postgres-advisory-locks", title: "What are advisory locks?" }] });

add("decision", 146, "atlas-api", "Claim billing jobs with SKIP LOCKED, not advisory locks",
  "Going with SELECT ... FOR UPDATE SKIP LOCKED. The queue is already a table we need for auditing, so the advisory-lock indirection buys nothing and costs observability — you cannot see who holds an advisory lock in pg_locks by business key. Revisit if contention exceeds ~2k claims/sec.",
  ["postgres", "concurrency", "queue"], { confidence: 0.9 });

add("research", 141, "atlas-api", "Idempotency keys need a stored response, not just a uniqueness check",
  "Rejecting a duplicate key with 409 is wrong: the client retrying after a timeout has no way to learn the original outcome. Stripe's model stores the full serialized response against the key and replays it. The key must also be scoped per-endpoint, or a retried POST can collide with an unrelated call.",
  ["idempotency", "api-design", "retries"],
  { confidence: 0.85, sources: [{ url: "https://stripe.com/docs/api/idempotent_requests", title: "Stripe: Idempotent Requests" }] });

add("decision", 139, "atlas-api", "Store idempotent responses for 24h, keyed by endpoint + key",
  "Response body, status and headers persisted in idempotency_records with a 24h TTL, swept nightly. Chose 24h because our longest client retry budget is 6h and the table is cheap. Replays return the stored response verbatim with Idempotent-Replay: true.",
  ["idempotency", "api-design", "postgres"],
  { confidence: 0.9, links: [["Idempotency keys need a stored response, not just a uniqueness check", "because-of"]] });

add("pattern", 137, "atlas-api", "Outbox table + CDC beats dual writes, every time",
  "Write the domain change and the event row in one transaction, then let a separate reader ship the event. Removes the 'wrote to DB, failed to publish' hole entirely without distributed transactions. Cost is one more table and an at-least-once consumer contract, which you needed anyway — see [[Exactly-once delivery does not exist; exactly-once processing does]].",
  ["kafka", "events", "postgres", "reliability"], { confidence: 0.95 });

add("question", 134, "atlas-api", "Should entitlements be denormalized onto the subscription row?",
  "Every authorization check currently joins three tables. Denormalizing would make reads trivial but introduces a fan-out write whenever a plan changes. Unclear whether plan changes are rare enough to justify it — need actual numbers before deciding.",
  ["postgres", "performance", "entitlements"], { resolved: false });

add("note", 131, "atlas-api", "pgbouncer transaction mode breaks prepared statements",
  "Spent an afternoon on intermittent 'prepared statement s1 already exists'. In transaction pooling, a connection is handed to a different client mid-session, so the server-side prepared statement cache no longer matches. Either use session mode or disable prepared statements in the driver.",
  ["postgres", "pgbouncer", "pooling"], { confidence: 0.95 });

add("decision", 130, "atlas-api", "Disable implicit prepared statements in the Go driver",
  "Setting default_query_exec_mode=exec on pgx rather than moving pgbouncer to session mode. Session mode would cap us at the Postgres max_connections we are trying to escape. Measured cost of losing prepared statements: about 4% on p50, acceptable.",
  ["postgres", "pgbouncer", "go", "pooling"],
  { confidence: 0.85, links: [["pgbouncer transaction mode breaks prepared statements", "because-of"]] });

add("research", 122, "atlas-api", "Rate limiting: token bucket vs sliding window log vs sliding window counter",
  "Token bucket allows bursts by design and needs two numbers per key. Sliding window log is exact but O(requests) memory. The sliding window counter approximates the log with two fixed windows and a weighted blend — one Redis hash per key, bounded memory, error under 1% at our traffic shape.",
  ["rate-limiting", "redis", "algorithms"],
  { confidence: 0.8, sources: [{ url: "https://blog.cloudflare.com/counting-things-a-lot-of-different-things/", title: "Cloudflare: Counting things" }] });

add("decision", 120, "atlas-api", "Sliding window counter in Redis for public API limits",
  "One Lua script, one hash per API key, atomic. Rejected token bucket because burst tolerance is exactly what we are trying to remove for the public tier. Internal service-to-service traffic stays unlimited and is governed by quotas instead.",
  ["rate-limiting", "redis"], { confidence: 0.9,
    links: [["Rate limiting: token bucket vs sliding window log vs sliding window counter", "because-of"]] });

add("note", 116, "atlas-api", "Redis Lua scripts are atomic but not transactional across shards",
  "A script touching two keys is only atomic if both hash to the same slot. Using a hash tag like {apikey:123} to force co-location. Learned this when the limiter silently degraded in the clustered staging environment but worked locally on a single node.",
  ["redis", "rate-limiting", "clustering"]);

add("research", 108, "atlas-api", "Postgres partial indexes for soft-deleted rows",
  "A partial index WHERE deleted_at IS NULL is dramatically smaller than the full index when most rows are live, and the planner uses it for any query carrying the same predicate. The predicate has to match syntactically, which is easy to get wrong through an ORM that rewrites conditions. Related to the locality argument in [[UUID v7 is time-ordered and fixes the v4 index locality problem]].",
  ["postgres", "indexing", "performance"], { confidence: 0.85 });

add("decision", 104, "atlas-api", "Soft delete via deleted_at plus partial indexes on every hot table",
  "Hard deletes lose the audit trail we are contractually required to keep for seven years. Every hot-path index becomes partial on deleted_at IS NULL, and the repository layer appends the predicate centrally so nobody can forget it.",
  ["postgres", "indexing", "compliance"],
  { confidence: 0.85, links: [["Postgres partial indexes for soft-deleted rows", "because-of"]] });

add("intention", 96, "atlas-api", "Get p99 on POST /v1/charges under 250ms before the Q4 launch",
  "Currently 410ms, dominated by the entitlements join and a synchronous audit write. Plan: move the audit write to the outbox, then revisit the join. Tracking weekly.",
  ["performance", "latency"], { active: true });

add("research", 92, "atlas-api", "Go 1.22 changed loop variable semantics — the classic goroutine bug is gone",
  "Per-iteration scoping means the old `for _, v := range xs { go func(){ use(v) }() }` capture bug no longer occurs in modules declaring go >= 1.22. Worth knowing when reading older code: the fix (shadowing v inside the loop) is now redundant but harmless.",
  ["go", "concurrency"], { confidence: 0.9,
    sources: [{ url: "https://go.dev/blog/loopvar-preview", title: "Go: Fixing for loops in Go 1.22" }] });

add("memo", 88, "atlas-api", "The entitlements cache invalidation is a landmine — read before touching",
  "Note to self: the cache is keyed by account, but plan changes invalidate by plan. There is a fan-out in webhook_handler.go:212 that nobody documented. If you change either key shape, that function must change with it.",
  ["caching", "entitlements", "gotcha"]);

add("question", 74, "atlas-api", "Is the audit log actually queried by anyone, or just written?",
  "We pay a synchronous write on every mutation for it. If compliance only ever exports it in bulk, an async pipeline would be strictly better. Asked legal, waiting.",
  ["compliance", "performance"], { resolved: false });

add("note", 61, "atlas-api", "EXPLAIN (ANALYZE, BUFFERS) is the only form worth running",
  "Without BUFFERS you cannot tell a cold cache from a bad plan. Shared hit vs read tells you immediately whether the second run will be fast. Added it to the team's query-review checklist.",
  ["postgres", "performance", "debugging"]);

add("research", 44, "atlas-api", "Postgres 16 parallel hash join improvements on partitioned tables",
  "Partitionwise joins now parallelize where 15 serialized. On our charges table partitioned by month, a six-month aggregate dropped from 12s to 3.4s with no query change. Requires enable_partitionwise_join = on, which is still off by default.",
  ["postgres", "performance", "partitioning"], { confidence: 0.8 });

add("decision", 41, "atlas-api", "Turn on enable_partitionwise_join in production",
  "Measured on a replica against a week of real query traffic: no regressions, several large wins. Planning time increases slightly on tables with many partitions, which does not affect us at twelve.",
  ["postgres", "performance", "partitioning"],
  { confidence: 0.9, links: [["Postgres 16 parallel hash join improvements on partitioned tables", "because-of"]] });

add("question", 24, "atlas-api", "Do we need a read replica before Q4, or is the primary fine?",
  "Read load is 70% of the total but the primary sits at 40% CPU. A replica adds failover complexity and replication lag semantics to reason about. Leaning no, want a load projection first.",
  ["postgres", "scaling", "capacity"], { resolved: false });

add("memo", 6, "atlas-api", "Before touching the charges partition scheme, read the Q3 postmortem",
  "The detach-and-drop we ran in July locked the parent for four minutes because we forgot DETACH CONCURRENTLY. Same trap is waiting in the archive job.",
  ["postgres", "partitioning", "gotcha"]);

/* ---- northwind-web ------------------------------------------------------ */
add("research", 144, "northwind-web", "React Server Components: what actually crosses the network",
  "Only the serialized render output and client component props cross. A large dependency imported in a server component genuinely never reaches the bundle, which is the whole point. The trap is a 'use client' boundary placed too high — everything below it is client code again.",
  ["react", "rsc", "performance"], { confidence: 0.85 });

add("pattern", 142, "northwind-web", "Push 'use client' to the leaves, never the layout",
  "Interactive leaf, server everything above it. A single 'use client' on a layout silently converts the whole subtree and undoes every RSC benefit while still looking correct. Enforced with an ESLint rule limiting which directories may carry the directive — the same enforcement instinct as [[Every feature flag gets an expiry date; CI fails 30 days past it]].",
  ["react", "rsc", "architecture"], { confidence: 0.9 });

add("note", 138, "northwind-web", "Next.js fetch caching defaults changed again in 15",
  "fetch is no longer cached by default; you opt in with cache: 'force-cache'. Several of our 'fast' pages were fast only because of the old implicit cache. Audited every fetch call and annotated intent explicitly.",
  ["nextjs", "caching"], { confidence: 0.9 });

add("research", 129, "northwind-web", "Core Web Vitals: INP replaced FID and it is much harder to game",
  "INP measures the worst interaction latency across the whole visit, not just the first. Long tasks during hydration that FID never saw now show up plainly. The fix is almost always less JavaScript, not faster JavaScript.",
  ["performance", "web-vitals", "frontend"],
  { confidence: 0.85, sources: [{ url: "https://web.dev/articles/inp", title: "web.dev: Interaction to Next Paint" }] });

add("decision", 126, "northwind-web", "Budget: 180KB of JS on the product page, enforced in CI",
  "size-limit fails the build above the budget. Picked 180KB because that is what the current page costs minus the two libraries we already agreed to remove. A budget you set above your current size does nothing.",
  ["performance", "ci", "frontend"],
  { confidence: 0.9, links: [["Core Web Vitals: INP replaced FID and it is much harder to game", "because-of"]] });

add("research", 118, "northwind-web", "date-fns vs Temporal vs Intl for a storefront",
  "Almost everything we do is formatting, which Intl already does natively in every target browser with zero bytes. Temporal is still behind a flag in two of our four targets. date-fns was 22KB of our budget for four function calls.",
  ["javascript", "i18n", "performance", "dependencies"], { confidence: 0.8 });

add("decision", 117, "northwind-web", "Drop date-fns for Intl.DateTimeFormat",
  "22KB recovered for four call sites. Wrote a six-line formatter wrapper so the call sites did not change shape. Keeping date-fns in the admin app where the arithmetic is genuinely complex.",
  ["javascript", "i18n", "dependencies"],
  { confidence: 0.9, links: [["date-fns vs Temporal vs Intl for a storefront", "because-of"]] });

add("note", 112, "northwind-web", "Safari still needs the -webkit prefix for backdrop-filter",
  "The unprefixed property has been supported for a while but the prefixed one is still required on iOS below 18. Autoprefixer handles it; our Tailwind arbitrary values bypassed autoprefixer entirely, which is how it shipped broken.",
  ["css", "safari", "frontend"]);

add("question", 106, "northwind-web", "Is the A/B framework worth the 40KB it costs on every page?",
  "We run about one experiment a quarter. The library ships a full statistics engine to the client for something the server could decide. Suspect a cookie and a server component would cover the real use case.",
  ["performance", "experimentation", "dependencies"], { resolved: false });

add("research", 98, "northwind-web", "Image formats in 2026: AVIF is finally the default choice",
  "AVIF now has universal support across our targets and beats WebP by roughly 25% at equal perceptual quality on photographic content. Encode time is still 5-10x WebP, which only matters if you encode on request rather than at build.",
  ["images", "performance", "frontend"], { confidence: 0.85 });

add("decision", 96, "northwind-web", "Serve AVIF with a WebP fallback, encode at build time",
  "Build-time encoding makes the CPU cost irrelevant. Keeping the WebP fallback for one more release purely for the long tail of embedded browsers in partner apps.",
  ["images", "performance"], { confidence: 0.9,
    links: [["Image formats in 2026: AVIF is finally the default choice", "because-of"]] });

add("pattern", 84, "northwind-web", "Colocate loading and error UI with the route, not the component",
  "Route-level loading.tsx and error.tsx give you a boundary that matches what the user actually navigated to. Component-level spinners produce a page that flickers in six places at once and reads as broken.",
  ["react", "nextjs", "ux"], { confidence: 0.85 });

add("intention", 78, "northwind-web", "Ship the checkout accessibility audit fixes before Black Friday",
  "Fourteen findings from the external audit, three of them blocking for keyboard-only users. Working through them one per week; the focus-trap rewrite is the big one.",
  ["accessibility", "checkout"], { active: true });

add("note", 66, "northwind-web", "aria-live regions do not announce if the node is added with the content already in it",
  "The region must exist in the DOM first and be mutated afterwards. React's reconciliation happily does the wrong thing here if the region is conditionally rendered. Render the empty region always, write into it later.",
  ["accessibility", "react"], { confidence: 0.9 });

add("research", 52, "northwind-web", "Streaming SSR: what Suspense boundaries actually buy",
  "The shell reaches the browser before slow data resolves, so LCP tracks the shell rather than the slowest query. This only helps if the slow thing is genuinely below the fold — a Suspense boundary around the hero makes the metric worse, not better.",
  ["react", "rsc", "performance"], { confidence: 0.8 });

add("question", 33, "northwind-web", "Why is TTFB 300ms worse in Sydney than Frankfurt?",
  "Same edge provider, same origin. Suspect the origin shield placement rather than the edge itself. Have not ruled out a DNS resolution difference.",
  ["performance", "cdn", "latency"], { resolved: false });

add("memo", 4, "northwind-web", "The Tailwind v4 upgrade branch is 80% done and will rot",
  "Blocked only on the arbitrary-value syntax change in three components. If nobody picks it up within a month the merge conflicts will make it cheaper to redo than to rebase.",
  ["tailwind", "tech-debt"]);

/* ---- tidepool ----------------------------------------------------------- */
add("research", 133, "tidepool", "Airflow dynamic task mapping vs generating DAGs at parse time",
  "Task mapping keeps one DAG and expands at run time, so the scheduler parse loop stays fast. Generating N DAGs at parse time makes the scheduler re-import them constantly and is the usual cause of a slow Airflow UI.",
  ["airflow", "orchestration", "python"], { confidence: 0.85 });

add("decision", 132, "tidepool", "One DAG with dynamic mapping per source, not a DAG per tenant",
  "We had 240 generated DAGs and a 90-second scheduler loop. Collapsing to seven mapped DAGs brought the loop to 4 seconds. Loses per-tenant DAG-level pause, which we replaced with a variable check in the first task.",
  ["airflow", "orchestration", "performance"],
  { confidence: 0.9, links: [["Airflow dynamic task mapping vs generating DAGs at parse time", "because-of"]] });

add("pattern", 128, "tidepool", "Every pipeline stage writes to a new partition, never in place",
  "Immutable partitions make a failed run a no-op rather than a corruption. Reprocessing is a rerun, not a repair. Costs storage, which is the cheapest thing in the stack. The same instinct as [[Append-only tables plus a materialized balance, never an UPDATE on money]].",
  ["data-engineering", "idempotency", "architecture"], { confidence: 0.95 });

add("research", 121, "tidepool", "dbt incremental models: merge vs delete+insert vs insert_overwrite",
  "insert_overwrite on a partitioned table is the only strategy that is genuinely idempotent for a backfill, because it replaces whole partitions. merge leaves rows behind when the source shrinks. delete+insert is fine but takes a longer lock.",
  ["dbt", "data-engineering", "sql"], { confidence: 0.85 });

add("decision", 119, "tidepool", "Standardize on insert_overwrite for all daily incremental models",
  "Backfills were producing subtly different numbers than the original runs under merge. Uniform strategy means a backfill is provably the same operation as the original load.",
  ["dbt", "data-engineering"], { confidence: 0.9,
    links: [["dbt incremental models: merge vs delete+insert vs insert_overwrite", "because-of"]] });

add("note", 114, "tidepool", "Snowflake clustering keys do not help a table under ~1TB",
  "Automatic clustering costs credits continuously and the micro-partition pruning on a small table is already good. Removed the key from four tables and saw no query regression and a visible credit drop.",
  ["snowflake", "cost", "performance"], { confidence: 0.85 });

add("research", 102, "tidepool", "Late-arriving data breaks every naive watermark",
  "A fixed watermark either drops late records or waits forever. The practical answer is a bounded lateness window plus a periodic reprocess of the trailing N days, accepting that the last N days are provisional and labelling them as such in the UI.",
  ["streaming", "data-engineering", "correctness"], { confidence: 0.8 });

add("decision", 100, "tidepool", "Trailing 3-day reprocess window, marked provisional downstream",
  "Chose 3 days because 99.4% of late records in the last quarter arrived within 62 hours. Dashboards grey out the provisional range instead of showing numbers that will change.",
  ["streaming", "data-engineering", "ux"],
  { confidence: 0.85, links: [["Late-arriving data breaks every naive watermark", "because-of"]] });

add("question", 87, "tidepool", "Should the ingestion layer own schema evolution, or should dbt?",
  "Currently split, which means a new column sometimes appears in staging and sometimes gets dropped silently. Both options are defensible; the split one is not.",
  ["dbt", "schema", "data-engineering"], { resolved: false });

add("note", 71, "tidepool", "Airflow's `catchup=True` default has caused three incidents",
  "Deploying a DAG with a start_date months in the past immediately schedules every missed interval. Set catchup=False in the default args and opt in per DAG where a real backfill is wanted.",
  ["airflow", "gotcha", "orchestration"], { confidence: 0.95 });

add("intention", 58, "tidepool", "Cut the nightly warehouse bill by 30% before the budget review",
  "Two levers identified: dropping clustering on small tables (done) and pruning the twelve unused marts nobody has queried in 90 days. Third lever, warehouse right-sizing, still unmeasured.",
  ["cost", "snowflake"], { active: true });

add("research", 37, "tidepool", "Data contracts: the useful part is the CI check, not the YAML",
  "The schema document is only worth writing if something fails a build when reality diverges. Teams that adopt the format without the enforcement end up with documentation that lies more confidently than none at all. Compare [[Storybook is documentation that compiles, which is why it stays true]].",
  ["data-engineering", "testing", "process"], { confidence: 0.75 });

add("memo", 3, "tidepool", "The Snowflake credit spike on the 14th was us, not the vendor",
  "Traced to the backfill I ran without setting a warehouse size. Finance already asked once; have the answer ready before the budget review.",
  ["cost", "snowflake"]);

/* ---- ledger-core -------------------------------------------------------- */
add("pattern", 143, "ledger-core", "Money is an integer of minor units, never a float, never a decimal string",
  "Store an int64 of cents plus an ISO-4217 currency code. Floats lose cents; decimal strings push parsing into every consumer. The only place a decimal appears is the display boundary. A specific case of [[Make the illegal state unrepresentable before you validate against it]].",
  ["money", "correctness", "architecture"], { confidence: 1.0 });

add("research", 140, "ledger-core", "Double-entry means every transaction sums to zero, and that is the whole invariant",
  "Every posting has balanced debits and credits. Enforcing sum = 0 as a database constraint over the postings of a transaction catches an entire category of bug at write time rather than at month-end reconciliation.",
  ["accounting", "correctness", "postgres"], { confidence: 0.95 });

add("decision", 136, "ledger-core", "Enforce the zero-sum invariant with a deferred constraint trigger",
  "A deferred trigger checks the sum at COMMIT, which allows postings to be inserted one at a time within the transaction. An immediate constraint would force building the whole transaction in memory first.",
  ["postgres", "accounting", "correctness"],
  { confidence: 0.9, links: [["Double-entry means every transaction sums to zero, and that is the whole invariant", "because-of"]] });

add("research", 125, "ledger-core", "Exactly-once delivery does not exist; exactly-once processing does",
  "The network cannot promise a message arrives once. What you can build is an idempotent consumer plus at-least-once delivery, which is observationally identical and vastly simpler. Every 'exactly-once' product claim decomposes into this.",
  ["kafka", "distributed-systems", "idempotency"], { confidence: 0.95 });

add("note", 111, "ledger-core", "Kafka consumer rebalances during a long poll look exactly like data loss",
  "max.poll.interval.ms exceeded means the broker evicts the consumer mid-batch and hands the partition elsewhere. Offsets look like they skipped. They did not — the work was reassigned. Shrink the batch or extend the interval.",
  ["kafka", "gotcha", "debugging"], { confidence: 0.9 });

add("research", 94, "ledger-core", "Rust: when Arc<Mutex<T>> is the wrong answer",
  "If the contention is on a queue rather than shared mutable state, a channel removes the lock entirely and the ownership model does the reasoning for you. Reach for Arc<Mutex> when several tasks genuinely need the same mutable thing, not as the default shape.",
  ["rust", "concurrency"], { confidence: 0.8 });

add("question", 82, "ledger-core", "Can we reconcile against the bank statement automatically, or is fuzzy matching unavoidable?",
  "Reference fields are populated by counterparties and are wrong often enough that exact matching leaves ~4% unmatched. Fuzzy matching risks false positives on money, which is unacceptable. Possibly a human queue is the correct design.",
  ["reconciliation", "accounting"], { resolved: false });

add("decision", 68, "ledger-core", "Unmatched settlements go to a human review queue, not a fuzzy matcher",
  "4% of volume is roughly 40 items a day, which one person clears in under an hour. A false positive on money costs more than an hour. Revisit only if volume grows 10x.",
  ["reconciliation", "accounting", "ops"],
  { confidence: 0.85, links: [["Can we reconcile against the bank statement automatically, or is fuzzy matching unavoidable?", "related"]] });

add("intention", 47, "ledger-core", "Get the ledger reconciled to the cent for the FY close",
  "Currently 11 cents out across the year, which is almost certainly a rounding rule difference on FX conversions rather than a lost transaction. Tracing month by month.",
  ["accounting", "reconciliation"], { active: true });

add("pattern", 29, "ledger-core", "Append-only tables plus a materialized balance, never an UPDATE on money",
  "The balance is a projection you can rebuild; the postings are the truth. Any design where the current balance is the source of truth loses history the moment someone writes a bad UPDATE.",
  ["accounting", "architecture", "postgres"], { confidence: 0.95 });

/* ---- sentry-ops --------------------------------------------------------- */
add("research", 135, "sentry-ops", "Terraform state locking: DynamoDB vs S3 native locking",
  "S3 now supports conditional writes, so the separate DynamoDB lock table is no longer required. One less resource to provision and one less thing to get out of sync with the bucket's lifecycle policy.",
  ["terraform", "aws", "infrastructure"], { confidence: 0.85 });

add("decision", 133, "sentry-ops", "Move state locking to S3 conditional writes, retire the lock table",
  "Removed four DynamoDB tables across environments. Migration is a backend block change plus one init -migrate-state; verified on staging first.",
  ["terraform", "aws"], { confidence: 0.9,
    links: [["Terraform state locking: DynamoDB vs S3 native locking", "because-of"]] });

add("pattern", 127, "sentry-ops", "One Terraform state per blast radius, not per environment",
  "A single prod state means every apply risks everything. Splitting by blast radius — network, data, compute, edge — keeps a bad plan contained. Cross-state references via remote state outputs, sparingly.",
  ["terraform", "architecture", "infrastructure"], { confidence: 0.9 });

add("research", 115, "sentry-ops", "Kubernetes resource requests matter far more than limits",
  "Requests drive scheduling and are what actually prevents noisy-neighbour starvation. CPU limits mostly cause throttling that looks like a mysterious latency cliff. Memory limits are worth setting; CPU limits usually are not. Found it the way [[The postmortem question that actually works: what made this hard to see?]] suggests — by asking why it was invisible.",
  ["kubernetes", "performance", "infrastructure"],
  { confidence: 0.85, sources: [{ url: "https://home.robusta.dev/blog/stop-using-cpu-limits", title: "Stop using CPU limits on Kubernetes" }] });

add("decision", 113, "sentry-ops", "Set memory limits, drop CPU limits, always set both requests",
  "Removed CPU limits across the platform namespace after reproducing throttling at 40% utilisation. p99 improved 22% with no change to scheduling behaviour.",
  ["kubernetes", "performance"], { confidence: 0.9,
    links: [["Kubernetes resource requests matter far more than limits", "because-of"]] });

add("note", 105, "sentry-ops", "A Grafana dashboard nobody opens is a liability, not an asset",
  "Deleted 31 of 47 dashboards. The remaining 16 are linked from runbooks and have owners. The deleted ones were mostly duplicates built during incidents and never revisited.",
  ["observability", "grafana", "process"]);

add("research", 97, "sentry-ops", "SLO burn-rate alerts beat threshold alerts on every axis",
  "A threshold alert fires on a spike that does not matter and stays silent through a slow bleed that does. Burn rate ties the page to the error budget, so the alert means 'you will miss the SLO' rather than 'a number moved'. Pairs with [[Every alert links to a runbook, or it does not get to page]].",
  ["observability", "alerting", "sre"],
  { confidence: 0.9, sources: [{ url: "https://sre.google/workbook/alerting-on-slos/", title: "Google SRE Workbook: Alerting on SLOs" }] });

add("decision", 95, "sentry-ops", "Replace all latency threshold pages with multi-window burn-rate alerts",
  "Two windows: 1h at 14.4x for the fast burn page, 6h at 6x for the ticket. Paging volume dropped 60% in the first month and we caught the slow degradation in the search tier that thresholds had missed for weeks.",
  ["observability", "alerting", "sre"],
  { confidence: 0.9, links: [["SLO burn-rate alerts beat threshold alerts on every axis", "because-of"]] });

add("pattern", 90, "sentry-ops", "Every alert links to a runbook, or it does not get to page",
  "Enforced in the alert-rule CI check: a rule without a runbook annotation fails the build. Removes the 3am 'what does this even mean' problem structurally rather than culturally.",
  ["observability", "alerting", "process"], { confidence: 0.9 });

add("question", 76, "sentry-ops", "Are we paying for log retention nobody uses beyond 14 days?",
  "Retention is 90 days across the board. Sampling the query audit suggests almost nothing reaches past two weeks except the compliance export, which has its own archive.",
  ["cost", "observability"], { resolved: false });

add("research", 55, "sentry-ops", "OpenTelemetry: the collector is the part that matters",
  "SDK choice is largely interchangeable; the collector is where sampling, redaction and fan-out to multiple backends actually happen. Running it as a gateway rather than a sidecar made vendor migration a config change instead of a redeploy.",
  ["observability", "tracing", "opentelemetry"], { confidence: 0.85 });

add("note", 39, "sentry-ops", "Tail sampling needs the whole trace in one collector",
  "Load balancing by trace ID is not optional — a round-robin collector fleet sees fragments and makes sampling decisions on incomplete traces. The loadbalancing exporter exists exactly for this.",
  ["observability", "tracing", "opentelemetry", "gotcha"], { confidence: 0.9 });

add("intention", 21, "sentry-ops", "Get every production service onto trace context propagation by year end",
  "Nine of fourteen done. The two Rust services need a middleware that does not exist yet; the three legacy PHP endpoints may not be worth it.",
  ["observability", "tracing"], { active: true });

/* ---- cartographer ------------------------------------------------------- */
add("research", 123, "cartographer", "Offline-first sync: CRDTs vs last-write-wins vs operational transform",
  "For a form-filling app, per-field last-write-wins with a vector clock is usually sufficient and is two orders of magnitude simpler than a CRDT library. CRDTs earn their complexity when users edit the same text concurrently, which surveyors do not.",
  ["offline-first", "sync", "mobile"], { confidence: 0.8 });

add("decision", 121, "cartographer", "Per-field last-write-wins with a device clock, no CRDT",
  "Conflicts are rare (one surveyor per site) and per-field granularity makes the rare conflict invisible. Revisit if we add collaborative editing, which is not on the roadmap.",
  ["offline-first", "sync", "mobile"],
  { confidence: 0.85, links: [["Offline-first sync: CRDTs vs last-write-wins vs operational transform", "because-of"]] });

add("note", 110, "cartographer", "Expo SQLite writes block the JS thread on large transactions",
  "A 4000-row insert froze the UI for 1.8s. Chunking into 500-row transactions with a yield between them keeps the frame budget intact at the cost of a slightly longer total.",
  ["expo", "sqlite", "mobile", "performance"], { confidence: 0.85 });

add("research", 99, "cartographer", "Background location on iOS: what actually survives suspension",
  "Significant-change monitoring survives; standard location updates do not without the background mode and a visible justification at review. Region monitoring is the reliable middle ground and costs far less battery.",
  ["ios", "mobile", "location"], { confidence: 0.75 });

add("decision", 93, "cartographer", "Use region monitoring, not continuous location updates",
  "Battery drain in the field trial was the top complaint. Region monitoring covers the actual requirement — knowing when a surveyor arrives at a site — without a continuous GPS fix.",
  ["ios", "mobile", "location", "battery"],
  { confidence: 0.9, links: [["Background location on iOS: what actually survives suspension", "because-of"]] });

add("question", 86, "cartographer", "Do we need a native module for photo compression, or is expo-image-manipulator enough?",
  "Manipulator handles resize fine but gives no control over JPEG chroma subsampling, and our uploads are still 2.4MB average. Unclear whether the extra 400KB matters on the connections surveyors actually have.",
  ["mobile", "images", "expo"], { resolved: false });

add("pattern", 72, "cartographer", "Queue mutations locally, reconcile on reconnect, never block the UI on the network",
  "Every write is applied optimistically to the local database and appended to an outbox. The network layer drains the outbox whenever connectivity allows. The UI never knows or cares whether the device is online. Structurally identical to [[Outbox table + CDC beats dual writes, every time]], just with a worse network.",
  ["offline-first", "mobile", "architecture"], { confidence: 0.95 });

add("note", 49, "cartographer", "React Native's New Architecture broke two of our four native deps",
  "Both were unmaintained wrappers around iOS APIs we call twice. Replaced with 40 lines of direct native code rather than waiting for the maintainers.",
  ["react-native", "mobile", "dependencies"]);

add("intention", 27, "cartographer", "Get the field app usable with zero bars for a full working day",
  "Sync and photo queue both handled. Remaining gap is the map tiles — currently requires a pre-download the surveyors forget to run.",
  ["offline-first", "mobile"], { active: true });

/* ---- glasshouse (paused project — drives the stale-project nudge) ------- */
add("research", 145, "glasshouse", "Design tokens: three tiers beat two",
  "Primitive, semantic, component. Two-tier systems collapse under theming because the semantic layer ends up doing two jobs. The third tier costs indirection but is what makes a dark theme a token swap rather than a rewrite.",
  ["design-systems", "design-tokens"], { confidence: 0.85 });

add("decision", 139, "glasshouse", "Three-tier tokens, generated by Style Dictionary into CSS vars and TS",
  "One source of truth in JSON, two build outputs. Designers edit the primitives, engineers consume the semantic layer, and nobody hand-writes a hex code.",
  ["design-systems", "design-tokens", "tooling"],
  { confidence: 0.9, links: [["Design tokens: three tiers beat two", "because-of"]] });

add("note", 130, "glasshouse", "Storybook is documentation that compiles, which is why it stays true",
  "Prose docs about a component drift within a sprint. A story that renders the component fails visibly when the component changes. Prefer a story over a paragraph wherever both would work.",
  ["design-systems", "storybook", "documentation"]);

add("pattern", 124, "glasshouse", "Name tokens by role, never by appearance",
  "color-danger, not color-red. The day danger becomes orange, an appearance-named token is either wrong or a lie everywhere it is used. This is the single highest-leverage naming rule in a design system.",
  ["design-systems", "design-tokens", "naming"], { confidence: 0.95 });

add("question", 109, "glasshouse", "Is the component library worth maintaining for two consuming apps?",
  "Overhead is roughly a day a week. Two apps might be under the threshold where a shared library beats copy-paste with discipline. Would change immediately at four apps.",
  ["design-systems", "process"], { resolved: false });

/* ---- cross-cutting: superseded chain + archived + resolved questions ---- */
add("decision", 150, "atlas-api", "Use UUID v4 primary keys everywhere",
  "Globally unique, no coordination, safe to generate client-side. Going with v4 across all new tables for consistency with the existing services.",
  ["postgres", "identifiers", "architecture"],
  { confidence: 0.7, status: "superseded", supersededBy: "Switch to UUID v7 for all new primary keys" });

add("research", 89, "atlas-api", "UUID v7 is time-ordered and fixes the v4 index locality problem",
  "Random v4 keys scatter inserts across the whole B-tree, causing page splits and terrible cache behaviour at scale. v7 embeds a millisecond timestamp in the high bits, so inserts are append-mostly while staying globally unique.",
  ["postgres", "identifiers", "indexing", "performance"],
  { confidence: 0.9, sources: [{ url: "https://datatracker.ietf.org/doc/rfc9562/", title: "RFC 9562: UUID formats" }] });

add("decision", 85, "atlas-api", "Switch to UUID v7 for all new primary keys",
  "Measured a 30% improvement in insert throughput on the charges table and a substantially smaller index. Existing v4 columns stay as they are — a migration would cost more than it returns.",
  ["postgres", "identifiers", "indexing"],
  { confidence: 0.9, links: [["UUID v7 is time-ordered and fixes the v4 index locality problem", "because-of"],
                             ["Use UUID v4 primary keys everywhere", "supersedes"]] });

add("decision", 147, "northwind-web", "Adopt Recoil for cross-page client state",
  "Atom model fits our shape better than Redux boilerplate and the React team's involvement is reassuring.",
  ["react", "state-management"],
  { confidence: 0.6, status: "superseded", supersededBy: "Move client state to Zustand, delete the Recoil layer" });

add("decision", 91, "northwind-web", "Move client state to Zustand, delete the Recoil layer",
  "Recoil went unmaintained and the RSC migration reduced client state to roughly four values. Zustand covers it in 40 lines with no provider and no experimental API surface.",
  ["react", "state-management", "dependencies"],
  { confidence: 0.9, links: [["Adopt Recoil for cross-page client state", "supersedes"]] });

add("note", 149, "sentry-ops", "Jenkins pipeline notes for the nightly build",
  "Recording the agent labels and the shared-library version pinning so the next person does not have to reverse-engineer it.",
  ["ci", "jenkins"], { status: "archived" });

add("note", 145, "sentry-ops", "Nagios check definitions for the legacy fleet",
  "Kept for reference until the last legacy host is decommissioned.",
  ["observability", "legacy"], { status: "archived" });

add("research", 144, "tidepool", "Evaluating Luigi as the orchestrator",
  "Dependency model is clean but the scheduler is single-process and the community has largely moved on. Documenting the evaluation for the record.",
  ["orchestration", "python"], { status: "archived", confidence: 0.5 });

add("question", 138, "ledger-core", "Should the ledger store FX rates, or reference a rates service?",
  "Storing the rate used at posting time makes a transaction reproducible forever. A service lookup is always current but makes history unreproducible.",
  ["accounting", "fx", "architecture"], { resolved: true });

add("decision", 136, "ledger-core", "Store the FX rate on the posting, not a reference to a rates service",
  "A ledger entry must be reproducible years later. Storing the rate makes the transaction self-contained; the rates service remains the source at write time only.",
  ["accounting", "fx", "correctness"],
  { confidence: 0.95, links: [["Should the ledger store FX rates, or reference a rates service?", "because-of"]] });

add("question", 126, "northwind-web", "Is Tailwind's utility churn a real maintenance cost for us?",
  "Answered by the v4 upgrade: the churn is real but concentrated in arbitrary values, which we use in 11 places. Manageable.",
  ["tailwind", "css", "tech-debt"], { resolved: true });

add("question", 118, "sentry-ops", "Can we run the collector as a sidecar instead of a gateway?",
  "Answered: no, tail sampling needs whole traces in one process, which sidecars cannot provide.",
  ["observability", "opentelemetry"], { resolved: true });

add("question", 103, "tidepool", "Does anyone still query the v1 marts?",
  "Answered by the query audit: twelve marts had zero queries in 90 days. Scheduled for removal.",
  ["snowflake", "cost"], { resolved: true });

add("question", 64, "cartographer", "Is Expo's managed workflow still a constraint for us?",
  "Answered: config plugins cover everything we needed a bare workflow for. Staying managed.",
  ["expo", "mobile"], { resolved: true });

add("intention", 132, "glasshouse", "Publish the token package to the internal registry",
  "Done — v1.0.0 published and consumed by both apps.",
  ["design-systems", "tooling"], { active: false });

add("intention", 107, "atlas-api", "Remove the last synchronous webhook call from the charge path",
  "Done — moved to the outbox in the same change that fixed the audit write.",
  ["performance", "events"], { active: false });

add("intention", 79, "tidepool", "Get dbt test coverage above 80% on the core marts",
  "Done — 84%, mostly not_null and relationships tests that should have existed from the start.",
  ["dbt", "testing"], { active: false });

/* ---- cross-project notes, patterns, and wikilinked entries ------------- */
add("pattern", 101, null, "Write the failing test before the fix, even when the fix is obvious",
  "An obvious fix with no test is a fix you cannot prove and cannot defend against the next refactor. The test is the artifact; the fix is the easy part. This has never once cost more than it returned. Its packaging-level cousin is [[Test what a stranger receives, not what your working tree contains]].",
  ["testing", "process", "discipline"], { confidence: 0.95 });

add("pattern", 80, null, "A comment should explain why, never what",
  "The code already says what. A comment restating it goes stale the moment the code changes and then actively lies. The valuable comment is the one recording a constraint, a rejected alternative, or a trap.",
  ["code-quality", "documentation", "process"], { confidence: 0.9 });

add("note", 77, null, "The postmortem question that actually works: what made this hard to see?",
  "Not 'what went wrong' — that produces a timeline. 'What made this hard to see' produces the observability gap, which is the thing you can actually fix. Borrowed from the [[SLO burn-rate alerts beat threshold alerts on every axis]] discussion.",
  ["incident-response", "process", "sre"], { confidence: 0.85 });

add("research", 63, null, "Feature flags become permanent unless removal has an owner and a date",
  "Median flag lifetime in published studies is far longer than intended, and each one doubles a code path. The teams that keep it under control put an expiry date on the flag at creation and fail CI when it passes.",
  ["feature-flags", "tech-debt", "process"], { confidence: 0.8 });

add("decision", 60, null, "Every feature flag gets an expiry date; CI fails 30 days past it",
  "Cheapest possible enforcement of [[Feature flags become permanent unless removal has an owner and a date]]. Eleven stale flags removed in the first sweep.",
  ["feature-flags", "ci", "tech-debt"],
  { confidence: 0.9, links: [["Feature flags become permanent unless removal has an owner and a date", "because-of"]] });

add("note", 54, null, "Retries without jitter turn one outage into a synchronized stampede",
  "Exponential backoff alone still aligns every client on the same schedule. Full jitter — sleep a random value between zero and the backoff — is the version that actually spreads load. See also [[Exactly-once delivery does not exist; exactly-once processing does]].",
  ["retries", "distributed-systems", "reliability"], { confidence: 0.9 });

add("pattern", 46, null, "Make the illegal state unrepresentable before you validate against it",
  "A type that cannot hold a bad value removes the validation and the test and the bug together. Validation is what you fall back to when the type system cannot express the constraint, not the first tool to reach for.",
  ["type-safety", "correctness", "architecture"], { confidence: 0.9 });

add("research", 42, null, "Code review latency matters more than code review depth",
  "A review that arrives in an hour changes the code; one that arrives in two days arrives after the author has moved on and gets rubber-stamped. Teams that cut median review latency see quality improve even with shorter reviews.",
  ["process", "code-review", "team"], { confidence: 0.75 });

add("note", 35, null, "Postgres is usually the answer before Kafka, Redis, or Elasticsearch",
  "LISTEN/NOTIFY, SKIP LOCKED, full-text search and JSONB cover a startling amount of what people add a second system for — [[Claim billing jobs with SKIP LOCKED, not advisory locks]] is the case in point. Add the specialised system when Postgres measurably stops being enough, not when the architecture diagram looks lonely.",
  ["postgres", "architecture", "simplicity"], { confidence: 0.85 });

add("research", 31, null, "Conventional commits pay off only when something consumes them",
  "The format alone is bureaucracy. It becomes valuable the moment a changelog generator or a release-version bump reads it, at which point the discipline is self-enforcing because breaking it breaks the release.",
  ["git", "process", "release"], { confidence: 0.7 });

add("note", 19, null, "Prefer boring technology, and spend the innovation budget deliberately",
  "Every novel component costs operational understanding that compounds. Choosing three exciting things means nobody understands the system at 3am. Pick the one place novelty actually buys the advantage.",
  ["architecture", "process", "simplicity"], { confidence: 0.9 });

add("research", 17, null, "SQLite is a genuinely good production database for single-node workloads",
  "WAL mode gives concurrent readers with one writer, and the absence of a network hop makes it faster than Postgres for many read-heavy embedded cases. The constraint is one writer and one machine, which is a far larger envelope than most people assume. Same argument as [[Prefer boring technology, and spend the innovation budget deliberately]].",
  ["sqlite", "architecture", "performance"], { confidence: 0.85 });

add("pattern", 14, null, "Test what a stranger receives, not what your working tree contains",
  "A repo's own test suite runs from source and cannot detect a broken published artifact — missing files, a native dependency that compiles on the user's machine, output on the wrong stream. Pack the real artifact, install it somewhere else, and drive that.",
  ["testing", "packaging", "release"], { confidence: 0.95 });

add("note", 12, null, "A green single-platform CI can be doing the wrong thing successfully",
  "A native dependency that compiles silently on a runner with a toolchain passes, while doing exactly what you were trying to prevent. Only a matrix makes it visible. Related: [[Test what a stranger receives, not what your working tree contains]].",
  ["ci", "testing", "packaging"], { confidence: 0.9 });

add("memo", 5, null, "Reread the retries note before the payments retry work next sprint",
  "Specifically the jitter part — the current client library backs off exponentially with no jitter and we have three services pointing at the same endpoint.",
  ["retries", "reliability"]);

add("memo", 2, null, "Two open questions have been sitting untouched for over two months",
  "The audit-log one and the read-replica one. Both are blocking capacity planning and neither needs more than an afternoon of measurement. Pick one this week.",
  ["process", "planning"]);

add("intention", 9, null, "Write up the incident review process before onboarding the two new engineers",
  "Half-drafted. The part that matters is the 'what made this hard to see' framing, which is currently only in my head and in one note.",
  ["process", "incident-response", "team"], { active: true });

/* --------------------------------------------------------------------------
 * Sessions — the Identity tab's history, and the boundary that decides
 * which memos count as unread.
 * ------------------------------------------------------------------------ */

const SESSIONS = [
  [147, "Billing job queue design", "Compared advisory locks against SKIP LOCKED for claiming billing jobs and settled on the table-based queue for auditability. Sketched the outbox pattern that later replaced the synchronous webhook call.", ["Prototype the outbox reader", "Measure claim throughput under load"]],
  [140, "Idempotency and the retry story", "Worked through why a uniqueness check alone is the wrong shape for idempotency keys, and specified the stored-response model with a 24h TTL.", ["Implement idempotency_records", "Add the Idempotent-Replay header"]],
  [131, "pgbouncer incident follow-up", "Traced intermittent prepared-statement errors to transaction pooling and decided to disable implicit prepared statements in the driver rather than move to session mode.", ["Ship the pgx exec-mode change", "Add a pooling section to the runbook"]],
  [126, "Frontend performance budget", "Set the product page JS budget at 180KB and wired size-limit into CI. Audited the Next.js 15 fetch cache changes across every call site.", ["Remove date-fns", "Re-measure INP after the budget lands"]],
  [119, "Warehouse incremental strategy", "Standardized dbt incremental models on insert_overwrite after backfills produced different numbers than original runs under merge.", ["Backfill Q2 to verify parity", "Document the partition contract"]],
  [113, "Kubernetes throttling investigation", "Reproduced CPU throttling at 40% utilisation and removed CPU limits across the platform namespace. p99 improved 22%.", ["Roll the change to the data namespace", "Add a throttling panel to the SLO dashboard"]],
  [95, "Alerting overhaul", "Replaced latency threshold pages with multi-window burn-rate alerts and made runbook links mandatory in the alert-rule CI check.", ["Migrate the remaining six rules", "Delete the unowned dashboards"]],
  [85, "Primary key migration decision", "Reviewed UUID v7 insert-locality benchmarks and superseded the standing v4 decision for new tables. Existing columns stay.", ["Update the schema conventions doc", "Benchmark the charges table after the change"]],
  [72, "Offline sync architecture", "Settled the mobile sync model on per-field last-write-wins with a local outbox, rejecting CRDTs as unjustified for single-surveyor sites.", ["Chunk the bulk SQLite inserts", "Design the tile pre-download prompt"]],
  [60, "Feature flag hygiene", "Introduced flag expiry dates enforced in CI and swept eleven stale flags.", ["Document the flag lifecycle", "Audit the remaining long-lived flags"]],
  [41, "Partitionwise join rollout", "Validated enable_partitionwise_join against a week of replayed production traffic and enabled it.", ["Watch planning time on the largest tables", "Revisit the archive job"]],
  [16, "Packaging and distribution review", "Worked through why a repo's own test suite cannot catch a broken published artifact, and what a cold-install check would have to assert.", ["Draft the pack-install check", "Widen CI to a real matrix"]],
  [8, "Quarterly planning prep", "Reviewed open questions and live intentions ahead of capacity planning. Two questions have gone stale and are blocking decisions.", ["Measure audit-log read volume", "Produce the read-replica load projection"]],
];

/* --------------------------------------------------------------------------
 * Seed
 * ------------------------------------------------------------------------ */

console.log(`\nseeding demo vault at ${HOME}`);
console.log(`  entries: ${E.length} · projects: ${PROJECTS.length} · sessions: ${SESSIONS.length}\n`);

const db = openDb();

for (const p of PROJECTS) upsertProject(db, p);
console.log(`  ok    ${PROJECTS.length} projects`);

upsertIdentity(db, {
  user_name: "Sam Whitfield",
  user_field: "Software Engineering",
  user_prefs: { language: "English", focus: "atlas-api", skills: ["go", "postgres", "typescript", "terraform"] },
  companion_name: "Atlas",
  companion_role: "Research librarian",
  companion_tone: "Concise, precise, cites its sources",
  // Gentler than DEFAULT_KIND_BOOST (memo 2.0), which on a corpus this size
  // pulls memos to the top of every query. Nudges do not consult boosts, so the
  // Steer tab still leads with memos regardless.
  companion_config: { stale_days: 21, conflict_threshold: 0.85, recall_boost: { memo: 1.2, question: 1.15, decision: 1.1 } },
});
console.log("  ok    identity");

process.stderr.write("  ..    warming the embedding model\n");
await warmup();

const idByTitle = new Map();
const setTime = db.prepare(`UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?`);

let n = 0;
for (const e of E) {
  const id = insertEntry(db, {
    kind: e.kind,
    title: e.title,
    body: e.body,
    confidence: e.confidence ?? null,
    tags: e.tags ?? [],
    project: e.project ?? null,
    status: e.status ?? "active",
    resolved: e.kind === "question" ? (e.resolved ?? false) : undefined,
    active: e.kind === "intention" ? (e.active ?? true) : undefined,
  }, await embed(`${e.title}\n${e.body}`));

  idByTitle.set(e.title, id);
  const at = stamp(e.daysAgo, 9 + (n % 9), (n * 7) % 60);
  setTime.run(at, at, id);

  for (const s of e.sources ?? []) insertSource(db, id, s);
  if (++n % 25 === 0) process.stderr.write(`  ..    ${n}/${E.length} entries embedded\n`);
}
console.log(`  ok    ${E.length} entries embedded and dated`);

// Resolve title references into ids now that every entry exists.
let linkCount = 0, supersedeCount = 0;
for (const e of E) {
  const id = idByTitle.get(e.title);
  const patch = {};
  if (e.links?.length) {
    const links = e.links
      .map(([title, rel]) => (idByTitle.has(title) ? { id: idByTitle.get(title), rel } : null))
      .filter(Boolean);
    if (links.length) { patch.links = links; linkCount += links.length; }
  }
  if (e.supersededBy && idByTitle.has(e.supersededBy)) {
    patch.superseded_by = idByTitle.get(e.supersededBy);
    supersedeCount++;
  }
  if (Object.keys(patch).length) {
    const at = stamp(e.daysAgo, 9, 0);
    updateEntry(db, id, patch);
    setTime.run(at, at, id); // updateEntry bumps updated_at; keep the timeline honest
  }
}
console.log(`  ok    ${linkCount} typed relations · ${supersedeCount} supersede pointers`);

const setSessionTime = db.prepare(`UPDATE sessions SET created_at = ? WHERE id = ?`);
for (const [daysAgo, title, summary, next] of SESSIONS) {
  const id = insertSession(db, title, summary, next);
  setSessionTime.run(stamp(daysAgo, 17, 30), id);
}
console.log(`  ok    ${SESSIONS.length} sessions`);

// The Steer tab's retrieval trace. Run a REAL recall rather than inventing an
// ordering — a hand-written trace drifts away from what the search would
// actually return, and the trace's whole purpose is to show what it returned.
const { hybridSearch } = await import("../dist/search/hybrid.js");
const traceQuery = "how do we keep alerts from paging people at 3am?";
const traceHits = hybridSearch(db, await embed(traceQuery), traceQuery, {
  limit: 4,
  boosts: { memo: 1.2, question: 1.15, decision: 1.1 },
});
writeLastFetch(HOME, {
  query: traceQuery,
  at: new Date(NOW.getTime() - 3 * 3600_000).toISOString(),
  results: traceHits.map((h) => ({
    id: h.entry.id,
    title: h.entry.title,
    kind: h.entry.kind,
    score: Number(h.score.toFixed(5)),
  })),
});
console.log(`  ok    retrieval trace (${traceHits.length} real hits)`);

const counts = db.prepare(`SELECT kind, status, COUNT(*) n FROM entries GROUP BY kind, status`).all();
const byKind = {};
for (const r of counts) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
const openQ = db.prepare(`SELECT COUNT(*) n FROM entries WHERE kind='question' AND resolved=0 AND status='active'`).get().n;
const liveI = db.prepare(`SELECT COUNT(*) n FROM entries WHERE kind='intention' AND active=1 AND status='active'`).get().n;
const lastSession = db.prepare(`SELECT MAX(created_at) c FROM sessions`).get().c;
const unread = db.prepare(`SELECT COUNT(*) n FROM entries WHERE kind='memo' AND status='active' AND created_at > ?`).get(lastSession).n;
const tags = db.prepare(`SELECT COUNT(DISTINCT value) n FROM entries, json_each(entries.tags)`).get().n;

console.log(`
  kinds        ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" · ")}
  statuses     ${db.prepare(`SELECT status, COUNT(*) n FROM entries GROUP BY status`).all().map((r) => `${r.status} ${r.n}`).join(" · ")}
  nudges       ${openQ} open questions · ${liveI} live intentions · ${unread} unread memos
  tags         ${tags} distinct
  sources      ${db.prepare(`SELECT COUNT(*) n FROM sources`).get().n}
  span         ${db.prepare(`SELECT MIN(created_at) a, MAX(created_at) b FROM entries`).get().a} -> ${db.prepare(`SELECT MAX(created_at) b FROM entries`).get().b}

demo vault ready. Browse it with:

  SARIPATI_HOME="${HOME}" npx saripati ui
`);

db.close();
