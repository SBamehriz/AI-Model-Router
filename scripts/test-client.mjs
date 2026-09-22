import assert from 'node:assert/strict';

const base = (process.env.AI_MODEL_ROUTER_BASE_URL || 'http://localhost:3000/v1').replace(/\/+$/, '');
const key = process.env.AI_MODEL_ROUTER_KEY;
const allowOffline = process.argv.includes('--allow-offline');
const testTools = process.argv.includes('--tools');
const destination = new URL(base);
assert.ok(destination.protocol === 'https:' || (destination.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)), 'Use HTTPS for a remote router.');
assert.ok(!destination.username && !destination.password && !destination.search && !destination.hash, 'Use a base URL without credentials, query, or fragment.');
assert.ok(key, 'Set AI_MODEL_ROUTER_KEY to a generated router key.');

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(`HTTP ${response.status}: ${data.error?.message || 'Request failed'} (request ${data.request_id || response.headers.get('x-request-id') || 'unknown'})`);
  }
  return response;
}

try {
  const healthResponse = await fetch(`${base.replace(/\/v1$/, '')}/health`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.ok(healthResponse.ok, 'Cannot reach router health endpoint.');
  const health = await healthResponse.json();
  assert.equal(typeof health.offline_mode, 'boolean', 'Unexpected health response.');
  assert.ok(allowOffline || !health.offline_mode, 'Router is simulating replies. Add a provider and disable forced offline mode, or pass --allow-offline for a local protocol check.');
  console.log(health.offline_mode ? 'SIMULATION: checks protocol only; does not verify a provider.' : 'LIVE: this test makes billable provider requests.');
  const models = await (await request('/models')).json();
  assert.ok(models.data?.some((model) => model.id === 'auto'), 'Model discovery is missing auto.');
  console.log('PASS: router key accepted and auto model discovered.');
  const messages = [{ role: 'user', content: 'Reply with a short hello.' }];
  const completion = await (await request('/chat/completions', { model: 'auto', messages, max_tokens: 128 })).json();
  assert.equal(completion.object, 'chat.completion');
  assert.ok(completion.choices?.[0]?.message?.content?.trim(), 'No text answer returned.');
  console.log(`PASS: JSON completion via ${completion.model}; request ${completion.request_id}.`);
  const stream = await request('/chat/completions', { model: 'auto', messages, max_tokens: 128, stream: true, stream_options: { include_usage: true } });
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  const data = (await stream.text()).split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  assert.ok(data.includes('[DONE]'), 'Stream did not finish.');
  const chunks = data.filter((line) => line !== '[DONE]').map((line) => JSON.parse(line));
  assert.ok(!chunks.some((chunk) => chunk.error), 'Stream reported a provider error.');
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.delta?.content), 'Stream returned no content.');
  assert.ok(chunks.some((chunk) => chunk.usage?.total_tokens > 0), 'Stream returned no usage.');
  console.log('PASS: SSE content, usage, and end marker.');
  if (testTools) {
    assert.ok(!health.offline_mode, 'Tool verification requires a live tool-capable provider.');
    const tools = [{ type: 'function', function: { name: 'test_echo', description: 'Return a test string.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
    const toolMessages = [{ role: 'user', content: 'Call test_echo with text router-check. After the result, summarize it.' }];
    const first = await (await request('/chat/completions', { model: 'auto', messages: toolMessages, tools, tool_choice: { type: 'function', function: { name: 'test_echo' } }, max_tokens: 256 })).json();
    const assistant = first.choices?.[0]?.message;
    assert.ok(assistant?.tool_calls?.length, 'Provider did not return a function call.');
    const results = assistant.tool_calls.map((call) => {
      assert.equal(call.function.name, 'test_echo', 'Unexpected tool name.');
      const args = JSON.parse(call.function.arguments);
      assert.equal(typeof args.text, 'string');
      // No shell, file, or external action: this tool only echoes its argument.
      return { role: 'tool', tool_call_id: call.id, content: args.text };
    });
    const final = await (await request('/chat/completions', { model: 'auto', messages: [...toolMessages, assistant, ...results], tools, tool_choice: 'none', max_tokens: 256 })).json();
    assert.ok(final.choices?.[0]?.message?.content?.trim(), 'No answer after tool results.');
    console.log(`PASS: function call and result round trip; request ${final.request_id}.`);
  }
  console.log('Client checks passed. Inspect these request IDs in the dashboard, then send a message from your actual app.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Client check failed.');
  process.exitCode = 1;
}
