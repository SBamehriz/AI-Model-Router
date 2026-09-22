import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Exercise actual sockets and the built application, without provider accounts.
const scratch = await mkdtemp(join(tmpdir(), 'ai-model-router-simulation-'));
const secret = randomBytes(32).toString('hex');
const admin = randomBytes(32).toString('hex');
const encryption = randomBytes(32).toString('base64');
let fault = '';
let primaryCalls = 0;
let child;
let exited;
let output = '';
let base;
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401).end(JSON.stringify({ error: { message: 'Wrong provider key' } })); return; }
  const primary = req.url.startsWith('/primary/');
  if (primary) primaryCalls++;
  if (fault === 'all' || (primary && fault === 'primary')) { res.writeHead(401).end(JSON.stringify({ error: { message: 'Fixture rejected the account' } })); return; }
  if (primary && fault === 'retry' && primaryCalls === 1) { res.writeHead(429).end(JSON.stringify({ error: { message: 'Retry this fixture' } })); return; }
  if (primary && fault === 'malformed') { res.end('{invalid json'); return; }
  if (payload.tools?.length && payload.tool_choice !== 'none' && payload.messages.at(-1).role !== 'tool') {
    const name = typeof payload.tool_choice === 'object' ? payload.tool_choice.function.name : payload.tools[0].function.name;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name, arguments: '{"text":"router-check"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  } else {
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Local provider fixture response.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  }
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

async function start() {
  // Ask the OS for an unused port, then release it for the child process.
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  base = `http://127.0.0.1:${port}`;
  output = '';
  child = spawn(process.execPath, ['apps/api/dist/index.js'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: join(scratch, 'router.db'),
    AI_MODEL_ROUTER_OFFLINE: '0', AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH: '1', AI_MODEL_ROUTER_API_KEY: '',
    AI_MODEL_ROUTER_ADMIN_KEY: admin, AI_MODEL_ROUTER_ENCRYPTION_KEY: encryption,
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '', GROQ_API_KEY: '',
    RATE_LIMIT_MAX: '10000', LOG_LEVEL: 'silent', CORS_ORIGIN: 'http://localhost:3001',
  } });
  exited = once(child, 'exit');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Isolated router failed to start.');
    try { if ((await fetch(`${base}/ready`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { /* startup */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Isolated router did not become ready.');
}
async function stop() { if (child && child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
async function request(path, { key = admin, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
async function runClient(key, args = []) {
  const runner = spawn(process.execPath, ['scripts/test-client.mjs', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AI_MODEL_ROUTER_BASE_URL: `${base}/v1`, AI_MODEL_ROUTER_KEY: key } });
  let text = '';
  runner.stdout.on('data', (chunk) => { text += chunk; });
  runner.stderr.on('data', (chunk) => { text += chunk; });
  const [code] = await once(runner, 'exit');
  assert.ok(!text.includes(secret) && !text.includes(key) && !text.includes(admin), 'Client printed a secret');
  return { code, text };
}

try {
  await start();
  for (const name of ['primary', 'backup']) {
    const result = await request('/admin/custom-providers', { method: 'PUT', body: {
      provider: `custom-${name}`, name: `Local ${name} fixture`, base_url: `${providerBase}/${name}/v1`, key: secret,
      model: { model_name: `${name}-model`, cost_input: name === 'primary' ? 0.0001 : 0.01, cost_output: name === 'primary' ? 0.0002 : 0.02, max_tokens: 128000, supports_functions: true, quality_rating: 90, avg_latency: 1000, strengths: ['chat', 'coding', 'reasoning', 'agent_step'] },
    } });
    assert.equal(result.status, 200);
  }
  const created = await request('/admin/keys', { method: 'POST', body: { name: 'Simulated OpenClaw client' } });
  assert.equal(created.status, 201);
  const appKey = await created.json();
  assert.equal((await request('/admin/settings', { key: appKey.key })).status, 401);
  assert.equal((await request('/v1/usage', { key: appKey.key })).status, 403);
  assert.equal((await request('/v1/models', { key: '' })).status, 401);
  assert.equal((await request('/v1/models', { key: secret })).status, 401);
  const basic = await runClient(appKey.key, ['--tools']);
  assert.equal(basic.code, 0, basic.text);
  assert.match(basic.text, /function call and result round trip/);
  console.log('PASS. Real HTTP model discovery, JSON, SSE, and tool round trip with local fixtures.');

  for (const endpoint of ['/v1/chat', '/v1/agent-step']) {
    const response = await request(endpoint, { key: appKey.key, method: 'POST', body: { messages: [{ role: 'user', content: 'Say hello.' }], priority: 'cheap' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output, 'Local provider fixture response.');
  }
  const prompt = { model: 'auto-cheap', messages: [{ role: 'developer', content: 'Be concise.' }, { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }], max_tokens: 128 };
  for (const failure of ['primary', 'malformed', 'retry']) {
    fault = failure; primaryCalls = 0;
    const response = await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body: prompt });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.model, failure === 'retry' ? 'custom-primary/primary-model' : 'custom-backup/backup-model');
    if (failure === 'retry') assert.equal(primaryCalls, 2);
    const history = await (await request('/v1/requests?limit=1')).json();
    assert.equal(history.requests[0].id, data.request_id);
    assert.equal(history.requests[0].success, true);
    assert.equal(history.requests[0].fallback_level, failure === 'retry' ? 'primary' : 'backup');
  }
  // The native endpoint has its own fallback walk, so it is checked separately.
  fault = 'primary';
  const nativeFallback = await request('/v1/chat', { key: appKey.key, method: 'POST', body: { messages: [{ role: 'user', content: 'Say hello.' }], priority: 'cheap' } });
  assert.equal(nativeFallback.status, 200);
  const native = await nativeFallback.json();
  assert.equal(native.provider, 'custom-backup');
  assert.equal(native.fallback_level, 'backup');
  assert.ok(native.cost > 0, 'Fallback answer was priced at zero');
  const nativeRow = (await (await request('/v1/requests?limit=1')).json()).requests[0];
  assert.equal(nativeRow.id, native.request_id);
  assert.equal(nativeRow.fallback_level, 'backup');
  assert.equal(nativeRow.provider, 'custom-backup');

  fault = 'all';
  assert.equal((await request('/v1/chat', { key: appKey.key, method: 'POST', body: { messages: [{ role: 'user', content: 'Say hello.' }] } })).status, 502);
  assert.equal((await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body: prompt })).status, 502);
  const failedStream = await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body: { ...prompt, stream: true } });
  assert.equal(failedStream.status, 200);
  const events = await failedStream.text();
  assert.match(events, /provider_error/); assert.match(events, /data: \[DONE\]/);
  fault = '';
  for (const body of ['{', { model: 'unknown', messages: [] }, { ...prompt, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] }] }, { ...prompt, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'result' }] }]) {
    assert.equal((await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body: { ...prompt, messages: [{ role: 'user', content: 'x'.repeat(2100000) }] } })).status, 413);
  assert.equal((await request('/v1/responses', { key: appKey.key, method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/v1/responses', { method: 'POST', body: {} })).status, 404);
  console.log('PASS. Fallback on both completion paths, retries, malformed upstream replies, error streams, input validation, body limit, and endpoint boundaries.');

  const settings = await (await request('/admin/settings')).text();
  assert.ok(!settings.includes(secret) && !settings.includes(appKey.key) && !settings.includes(admin));
  await stop();
  const database = await readFile(join(scratch, 'router.db'));
  assert.ok(!database.includes(Buffer.from(secret)) && !database.includes(Buffer.from(appKey.key)), 'Plaintext key stored in SQLite');
  assert.ok(!output.includes(secret) && !output.includes(appKey.key), 'Secret in server logs');
  await start();
  assert.equal((await request('/v1/models', { key: appKey.key })).status, 200);
  assert.equal((await request('/v1/chat/completions', { key: appKey.key, method: 'POST', body: prompt })).status, 200);
  assert.equal((await request(`/admin/keys/${appKey.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request('/v1/models', { key: appKey.key })).status, 401);
  for (const name of ['primary', 'backup']) assert.equal((await request(`/admin/custom-providers/custom-${name}`, { method: 'DELETE' })).status, 200);
  await stop(); await start();
  assert.equal((await request('/v1/models', { key: appKey.key })).status, 401);
  assert.equal((await request('/v1/models', { key: '' })).status, 401);
  console.log('PASS. Encrypted persistence, restart recovery, deletion, and revocation that survives restart.');
  console.log('Simulation passed. No external provider or installed OpenClaw was called.');
} finally {
  await stop();
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  // Only the unique temporary directory created by this process may be removed.
  const target = resolve(scratch);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('ai-model-router-simulation-'));
  await rm(target, { recursive: true, force: true });
}
