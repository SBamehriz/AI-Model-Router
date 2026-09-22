/**
 * The browser gate. Starts the built server on a throwaway database with
 * sample history, drives Chromium over every page and state in both themes,
 * and fails on any text, focus indicator or hover state under its floor.
 *
 * This is the check that caught the two regressions the unit tests could not
 * see: gradient text at 2:1, and a half-opacity focus ring at 2.2:1. Both
 * reached the interface, because the check was run by hand and only when
 * someone thought to. It runs beside test:smoke and test:simulation now.
 *
 * It stays out of `npm run check` on purpose. That command is what a person
 * runs between edits, and it should not need a browser. This needs one, so it
 * is its own command, and CI runs it.
 *
 * Usage: npm run test:browser        (after npm run build)
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = process.env.BROWSER_TEST_PORT || '3013';
const base = `http://127.0.0.1:${port}`;
const adminKey = 'amr_admin_isolated_browser_verification_key_0123';

if (!existsSync('apps/api/dist/index.js') || !existsSync('apps/dashboard/dist/index.html')) {
  console.error('Build first: npm run build. The browser gate drives the built server, not the source.');
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'ai-model-router-browser-'));
const database = join(scratch, 'router.db');
const env = {
  ...process.env,
  PORT: port,
  HOST: '127.0.0.1',
  DATABASE_PATH: database,
  AI_MODEL_ROUTER_OFFLINE: '1',
  AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH: '1',
  AI_MODEL_ROUTER_ADMIN_KEY: adminKey,
  AI_MODEL_ROUTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '',
  LOG_LEVEL: 'silent',
};

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.on('exit', (code) => resolve(code ?? 1));
  });

// npm sets this to its own entry point when it runs a script. Going through
// it with node, rather than through a shell, works the same on every platform
// and avoids the shell entirely.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Run this as npm run test:browser; it uses npm to seed the sample history.');
  process.exit(2);
}

let server;
let code = 1;
try {
  // Charts and tables with nothing in them are a state the audit drives on
  // purpose; the default render should have something to measure.
  const seeded = await run(process.execPath, [npmCli, 'run', 'seed:demo', '--workspace=apps/api'], { env, stdio: 'ignore' });
  if (seeded !== 0) throw new Error(`seeding sample history failed (${seeded})`);

  server = spawn(process.execPath, ['apps/api/dist/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  server.stdout.on('data', (c) => { output += c; });
  server.stderr.on('data', (c) => { output += c; });
  const exited = once(server, 'exit');

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const body = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).json();
      if (body.status === 'ok' && body.offline_mode) { ready = true; break; }
    } catch { /* still binding */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error(`server did not become ready:\n${output}`);

  code = await run(process.execPath, ['scripts/contrast-audit.mjs', base, adminKey]);

  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  if (server && server.exitCode === null) server.kill('SIGKILL');
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.exit(code);
