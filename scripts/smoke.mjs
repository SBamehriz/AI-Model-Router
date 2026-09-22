import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const port = process.env.SMOKE_TEST_PORT || '3012';
const base = `http://127.0.0.1:${port}`;
const key = 'local-smoke-test-key';
const adminKey = 'amr_admin_isolated_smoke_verification_key';
const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  env: { ...process.env, PORT: port, HOST: '127.0.0.1', DATABASE_PATH: ':memory:', AI_MODEL_ROUTER_OFFLINE: '1', AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH: '1', AI_MODEL_ROUTER_API_KEY: key, AI_MODEL_ROUTER_ADMIN_KEY: adminKey, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '', LOG_LEVEL: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOutput = '';
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });
const exited = once(child, 'exit');
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${serverOutput}`);
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      const body = await health.json();
      if (body.status === 'ok' && body.offline_mode && body.auth_required) { ready = true; break; }
    } catch { /* Wait for the built process to bind its port. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Server did not become ready: ${serverOutput}`);
  assert.equal((await fetch(`${base}/ready`)).status, 200);
  assert.equal((await fetch(`${base}/v1/usage`)).status, 401);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const invalid = await fetch(`${base}/v1/chat`, { method: 'POST', headers, body: '{' });
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).request_id);
  const response = await fetch(`${base}/v1/chat`, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Write a Python quicksort' }] }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.output, /offline mode/);
  assert.equal(result.routing.selected_model, `${result.provider}/${result.model_used}`);
  // The header, the body and the stored row must all name the same request, or
  // a report from a user cannot be followed up.
  assert.equal(response.headers.get('x-request-id'), result.request_id);
  const log = await (await fetch(`${base}/v1/requests`, { headers })).json();
  assert.equal(log.requests[0].id, result.request_id);
  assert.equal(log.requests[0].source, 'offline');
  for (const route of ['/', '/overview', '/playground', '/analytics', '/models', '/requests', '/settings', '/guide', '/about']) {
    const html = await fetch(`${base}${route}`);
    assert.equal(html.status, 200, `Dashboard route ${route}`);
    assert.match(await html.text(), /router-mark\.svg/);
  }
  assert.equal((await fetch(`${base}/router-mark.svg`)).status, 200);
  assert.equal((await fetch(`${base}/admin/settings`, { headers })).status, 401);
  const adminHeaders = { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' };
  // A separate dashboard origin must be allowed to save and revoke credentials.
  for (const method of ['PUT', 'DELETE']) {
    const preflight = await fetch(`${base}/admin/keys/example`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    assert.ok(preflight.headers.get('access-control-allow-methods')?.split(/,\s*/).includes(method), `${method} must pass browser preflight`);
  }
  const saved = await fetch(`${base}/admin/providers/openrouter`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ key: 'smoke-placeholder-provider-key' }) });
  assert.equal(saved.status, 200);
  const created = await fetch(`${base}/admin/keys`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'Smoke test client' }) });
  assert.equal(created.status, 201);
  const appKey = await created.json();
  const clientHeaders = { Authorization: `Bearer ${appKey.key}`, 'Content-Type': 'application/json' };
  const settingsText = await (await fetch(`${base}/admin/settings`, { headers: adminHeaders })).text();
  assert.ok(!settingsText.includes(appKey.key) && !settingsText.includes('smoke-placeholder-provider-key'));
  assert.equal((await fetch(`${base}/v1/requests`, { headers: clientHeaders })).status, 403);
  assert.equal((await fetch(`${base}/admin/settings`, { headers: clientHeaders })).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: clientHeaders })).status, 200);
  const chat = { model: 'auto', messages: [{ role: 'user', content: 'Say hello.' }] };
  const completion = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: clientHeaders, body: JSON.stringify(chat) });
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).object, 'chat.completion');
  const stream = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: clientHeaders, body: JSON.stringify({ ...chat, stream: true, stream_options: { include_usage: true } }) });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const events = await stream.text();
  assert.match(events, /chat\.completion\.chunk/);
  assert.match(events, /total_tokens/);
  assert.match(events, /data: \[DONE\]/);
  assert.equal((await fetch(`${base}/admin/keys/${appKey.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminKey}` } })).status, 200);
  assert.equal((await fetch(`${base}/v1/models`, { headers: clientHeaders })).status, 401);

  // A deprecation notice on the production start is a thing the operator is
  // asked to read and cannot act on. It also names a removal, so ignoring one
  // is how the next major version becomes a surprise. The whole run's output
  // is here, so this covers anything a request path emits as well as startup.
  const deprecations = serverOutput
    .split('\n')
    .filter((line) => /DeprecationWarning|FSTDEP\d+|\bis deprecated\b/.test(line));
  assert.equal(
    deprecations.length,
    0,
    `The built server emitted ${deprecations.length} deprecation warning(s):\n${deprecations.join('\n')}`,
  );

  console.log('Built-server smoke check passed: dashboard, credential setup, router key scopes and revocation, JSON/SSE completions, readiness, validation, tracing, and a start with no deprecation warnings.');
} finally {
  child.kill('SIGTERM');
  await exited;
}
