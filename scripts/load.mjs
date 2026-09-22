/**
 * Load, memory and integrity harness.
 *
 * This is where the headline figures in docs/VERIFICATION.md come from: a
 * flat post-collection heap across tens of thousands of requests, every
 * request answered under a burst of simultaneous ones, and a request log whose
 * every row still recomputes to what it claims. A number nobody else can
 * reproduce is a number nobody else can check, and that document opens by
 * saying verification is reproducible from this repository.
 *
 * What it establishes, and what it does not. A run of this length rules out an
 * unbounded heap and a concurrency ceiling. It cannot characterise a week, and
 * the throughput it prints is a property of the machine it ran on, not of a
 * deployment.
 *
 * Providers are never called: the server runs in offline mode, which answers
 * from a local simulation after a deterministic 120 to 250 ms. That delay is
 * the point — it is what a provider costs, so the in-flight count means
 * something — and it is also the ceiling on throughput here.
 *
 * Usage: npm run build, then npm run test:load.
 *
 *   LOAD_TEST_REQUESTS      sustained requests          (default 5000)
 *   LOAD_TEST_CONCURRENCY   requests in flight          (default 50)
 *   LOAD_TEST_BURST         simultaneous requests       (default 500)
 *   LOAD_TEST_SAMPLE_EVERY  requests between heap reads (default 500)
 *   LOAD_TEST_SETTLE_MS     idle before the last read   (default 4000)
 *   LOAD_TEST_HEAP_BUDGET_MB  growth allowed end to end (default 16)
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// node:sqlite is still flagged experimental on Node 22 and warns as it loads.
// The server drops that one warning for the same reason; a script that prints
// it reads as a fault rather than a status. Everything else still reaches
// stderr, which is what the smoke check reads.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (type === 'ExperimentalWarning' && message.includes('SQLite')) return;
  emitWarning(warning, ...rest);
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const number = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number (got ${raw})`);
  return value;
};

const REQUESTS = number('LOAD_TEST_REQUESTS', 5000);
const CONCURRENCY = number('LOAD_TEST_CONCURRENCY', 50);
const BURST = number('LOAD_TEST_BURST', 500);
const SAMPLE_EVERY = number('LOAD_TEST_SAMPLE_EVERY', 500);
const SETTLE_MS = number('LOAD_TEST_SETTLE_MS', 4000);
const HEAP_BUDGET = number('LOAD_TEST_HEAP_BUDGET_MB', 16) * 1024 * 1024;
const WARMUP = Math.min(200, Math.max(1, Math.floor(REQUESTS / 10)));

const port = process.env.LOAD_TEST_PORT || '3014';
const base = `http://127.0.0.1:${port}`;
const key = 'local-load-test-key';

if (!existsSync('apps/api/dist/index.js')) {
  console.error('Build first: npm run build. This drives the built server, not the source.');
  process.exit(2);
}

/** Nothing this run wrote can be stamped before this. */
const startedAt = Date.now();

const scratch = mkdtempSync(join(tmpdir(), 'ai-model-router-load-'));
const database = join(scratch, 'router.db');

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const problems = [];
const fail = (line) => { problems.push(line); };

let server;
try {
  server = spawn(
    process.execPath,
    ['--expose-gc', '--import', pathToFileURL(resolve('scripts/heap-probe.mjs')).href, 'apps/api/dist/index.js'],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATABASE_PATH: database,
        AI_MODEL_ROUTER_OFFLINE: '1',
        AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH: '1',
        AI_MODEL_ROUTER_API_KEY: key,
        // The shared budget is a hundred a minute by design. Measuring the
        // router means measuring what it does with traffic it accepts, so the
        // limiter is off here and tested for on its own elsewhere.
        RATE_LIMIT_MAX: '0',
        OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '',
        LOG_LEVEL: 'silent',
      },
      // The fourth stream is the channel the heap probe answers on.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(server, 'exit');

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const body = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).json();
      if (body.status === 'ok' && body.offline_mode) { ready = true; break; }
    } catch { /* still binding */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error(`server did not become ready:\n${output}`);

  /** Ask the server's own process for a heap reading taken after a collection. */
  const sampleHeap = async () => {
    server.send('heap-sample');
    const [message] = await Promise.race([
      once(server, 'message'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the server did not answer a heap sample within 10s')), 10_000)),
    ]);
    if (message.error === 'gc-not-exposed') throw new Error('the server was started without --expose-gc, so a post-collection heap cannot be read');
    return message;
  };

  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const prompts = [
    'Write a Python function that reverses a linked list.',
    'Summarise the difference between a mutex and a semaphore.',
    'Translate "the router is ready" into French.',
    'What is the time complexity of a binary search?',
    'Draft a one sentence commit message for a dependency bump.',
  ];

  const ids = new Set();
  let completed = 0;
  // Kept per phase. Folding the burst's times into the sustained ones put the
  // 95th percentile at 1687 ms where the sustained figure is 262 ms, and
  // printed it under the line that says how many were in flight, which is a
  // figure describing one thing and labelled as another. Three thousand at
  // once queue behind each other on purpose; that is the burst's own number.
  const sustainedLatencies = [];
  const burstLatencies = [];

  /**
   * One completion. A non-200, a body without an id, or an id already seen is
   * recorded rather than thrown, so the run finishes and reports how many of
   * each rather than stopping on the first.
   */
  const one = async (n, into) => {
    const started = performance.now();
    let response;
    try {
      response = await fetch(`${base}/v1/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: `${prompts[n % prompts.length]} (#${n})` }] }),
      });
    } catch (err) {
      fail(`request ${n} never got an answer: ${err.message}`);
      return;
    }
    const elapsed = performance.now() - started;
    if (response.status !== 200) {
      const body = await response.text().catch(() => '');
      fail(`request ${n} answered ${response.status}: ${body.slice(0, 160)}`);
      return;
    }
    const body = await response.json();
    if (!body.request_id) { fail(`request ${n} answered 200 with no request id`); return; }
    if (ids.has(body.request_id)) { fail(`request id ${body.request_id} was given to two requests`); return; }
    ids.add(body.request_id);
    into?.push(elapsed);
    completed += 1;
  };

  /** Keep `width` requests in flight until `total` have been sent. */
  const pool = async (total, width, into, onProgress) => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const n = next;
        next += 1;
        if (n >= total) return;
        await one(n, into);
        if (onProgress) await onProgress(n + 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, total) }, worker));
  };

  // The warm-up's times are not kept: they are the first requests a cold
  // process sees, which is a measurement of starting up.
  console.log(`warm-up: ${WARMUP} requests`);
  await pool(WARMUP, CONCURRENCY, null);

  const samples = [];
  const take = async (label) => {
    const heap = await sampleHeap();
    let dbBytes = 0;
    try { dbBytes = statSync(database).size + (existsSync(`${database}-wal`) ? statSync(`${database}-wal`).size : 0); } catch { /* not yet written */ }
    samples.push({ label, ...heap, dbBytes });
    return samples[samples.length - 1];
  };

  const baseline = await take('after warm-up');
  console.log(`baseline post-collection heap: ${mb(baseline.heapUsed)}`);

  console.log(`sustained: ${REQUESTS} requests, ${CONCURRENCY} in flight, heap read every ${SAMPLE_EVERY}`);
  const sustainedStart = performance.now();
  const before = completed;
  await pool(REQUESTS, CONCURRENCY, sustainedLatencies, async (done) => {
    if (SAMPLE_EVERY && done % SAMPLE_EVERY === 0) await take(`at ${done}`);
  });
  const sustainedMs = performance.now() - sustainedStart;
  const answered = completed - before;

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const settled = await take(`after ${SETTLE_MS} ms idle`);

  console.log(`burst: ${BURST} simultaneous requests`);
  const burstStart = performance.now();
  const beforeBurst = completed;
  await Promise.all(Array.from({ length: BURST }, (_, i) => one(REQUESTS + i, burstLatencies)));
  const burstMs = performance.now() - burstStart;
  const burstAnswered = completed - beforeBurst;

  const totalSent = WARMUP + REQUESTS + BURST;

  // A harness that measured nothing is a failure of the harness, not a pass
  // for the server. Every number below is guarded by the count behind it.
  if (!samples.length) fail('no heap samples were taken, so retention measured nothing');
  if (!sustainedLatencies.length) fail('no request completed in the sustained phase, so nothing was measured');
  if (answered !== REQUESTS) fail(`the sustained phase answered ${answered} of ${REQUESTS}`);
  if (burstAnswered !== BURST) fail(`the burst answered ${burstAnswered} of ${BURST}`);
  // An id repeated between two answers is caught where it is seen, above.
  // Comparing the set's size to the count here would agree by construction,
  // which is a line that reads as a check and is not one. The count that can
  // disagree is the database's own, below.

  const heaps = samples.map((s) => s.heapUsed);
  const growth = settled.heapUsed - baseline.heapUsed;
  if (growth > HEAP_BUDGET) {
    fail(`post-collection heap grew ${mb(growth)} from ${mb(baseline.heapUsed)} to ${mb(settled.heapUsed)} over ${totalSent} requests, past the ${mb(HEAP_BUDGET)} allowed`);
  }

  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
  server = null;

  // The log the run wrote, checked against itself. A request that answered and
  // was not recorded, a row that cannot be recomputed from its own tokens, or
  // a routing decision with no request are each a defect the response body
  // cannot show.
  const db = new DatabaseSync(database, { readOnly: true });
  // id is the primary key, so counting distinct ids here could only ever
  // return the row count. The id a caller was handed twice is caught in
  // flight, above, and the row that then failed to insert is caught by this.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM requests').get();
  if (rows.n !== completed) fail(`${completed} requests were answered and ${rows.n} rows were written`);

  const undecided = db.prepare('SELECT COUNT(*) AS n FROM requests WHERE id NOT IN (SELECT request_id FROM routing_decisions)').get();
  if (undecided.n) fail(`${undecided.n} request(s) were stored with no routing decision`);

  const orphaned = db.prepare('SELECT COUNT(*) AS n FROM routing_decisions WHERE request_id NOT IN (SELECT id FROM requests)').get();
  if (orphaned.n) fail(`${orphaned.n} routing decision(s) point at no request`);

  // tokens_total and savings are generated columns: SQLite recomputes them
  // from their inputs and refuses a direct write, so comparing either to its
  // own definition cannot fail. Proven by moving premium_baseline_cost under
  // a row and watching savings follow it. What is left is what a row can
  // actually get wrong.
  const impossible = db.prepare(`
    SELECT COUNT(*) AS n FROM requests
    WHERE tokens_input <= 0 OR tokens_output <= 0 OR cost < 0 OR latency_ms <= 0
       OR created_at < @started OR created_at > @finished
  `).get({ started: Math.floor(startedAt), finished: Date.now() });
  if (impossible.n) fail(`${impossible.n} row(s) record tokens, latency or a time that could not have happened`);

  // Provenance. Every answer here came from the local simulation, and a row
  // that calls it live is the thing migration 1 -> 2 exists to prevent: a
  // dashboard total that reads as paid provider traffic and is not.
  const misattributed = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE source <> 'offline' OR endpoint <> '/v1/chat'").get();
  if (misattributed.n) fail(`${misattributed.n} row(s) record a source or endpoint this run never used`);

  // Recomputed from the tokens the row stores and the catalog rate for the
  // model it names, which is the arithmetic the dashboard's totals rest on.
  const mismatched = db.prepare(`
    SELECT COUNT(*) AS n FROM requests r JOIN models m
      ON m.provider = r.provider AND m.model_name = r.model_used
    WHERE ABS(r.cost - (r.tokens_input / 1000.0 * m.cost_input + r.tokens_output / 1000.0 * m.cost_output)) > 1e-9
  `).get();
  if (mismatched.n) fail(`${mismatched.n} row(s) record a cost that is not their tokens times their model's rate`);

  const priced = db.prepare(`
    SELECT COUNT(*) AS n FROM requests r JOIN models m
      ON m.provider = r.provider AND m.model_name = r.model_used
  `).get();
  if (priced.n !== rows.n) fail(`${rows.n - priced.n} row(s) name a model that is not in the catalog, so their cost could not be rechecked`);

  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity.integrity_check !== 'ok') fail(`integrity_check: ${integrity.integrity_check}`);
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) fail(`foreign_key_check reported ${foreignKeys.length} row(s)`);
  db.close();

  console.log(`\n${totalSent} requests, ${completed} answered with no id repeated, ${rows.n} rows written`);
  // A run where nothing answered has no median and no throughput, and the
  // first version of this went looking for them anyway: the whole diagnosis
  // was replaced by a TypeError on an empty array, on exactly the run that
  // most needed reading. The problems below are what that run has to say.
  const times = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return `median ${at(50).toFixed(0)} ms, 95th ${at(95).toFixed(0)} ms, slowest ${sorted[sorted.length - 1].toFixed(0)} ms`;
  };
  if (sustainedLatencies.length) {
    console.log(`sustained: ${(answered / (sustainedMs / 1000)).toFixed(0)} requests per second over ${(sustainedMs / 1000).toFixed(1)} s at ${CONCURRENCY} in flight, ${times(sustainedLatencies)}`);
  }
  if (burstLatencies.length) {
    console.log(`burst: ${burstAnswered} of ${BURST} at once in ${(burstMs / 1000).toFixed(1)} s, ${times(burstLatencies)}`);
  }
  if (samples.length) {
    console.log(
      `post-collection heap over ${samples.length} readings: ${mb(Math.min(...heaps))} to ${mb(Math.max(...heaps))}, ` +
        `${mb(baseline.heapUsed)} after warm-up and ${mb(settled.heapUsed)} after ${SETTLE_MS} ms idle ` +
        `(${growth >= 0 ? '+' : ''}${mb(growth)}, ${mb(HEAP_BUDGET)} allowed)`,
    );
    console.log(`heap total at the last reading: ${mb(settled.heapTotal)}, resident ${mb(settled.rss)}, database ${mb(settled.dbBytes)}`);
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const line of problems.slice(0, 20)) console.error(`  ${line}`);
    if (problems.length > 20) console.error(`  ... and ${problems.length - 20} more`);
    process.exitCode = 1;
  } else {
    console.log('\nLoad check passed: every request answered with its own id, every row recomputes, heap flat across the run.');
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill('SIGKILL');
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
