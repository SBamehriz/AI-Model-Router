import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { completionsRoutes } from '../completions.js';
import { modelsRoutes } from '../models.js';
import { registerAuth } from '../../lib/auth.js';
import { initializeCredentials, createIntegrationKey, storeProviderCredential, PROVIDER_ENV } from '../../lib/credentials.js';
import { seedCatalogFromConfig } from '../../lib/modelCatalog.js';
import { __resetRateLimitForTests } from '../../lib/rateLimit.js';
import { listRecentRequests, providerAttemptStats } from '../../lib/db/requests.js';
import { compatibleCompletion } from '../../lib/compatibleProviders.js';
import { CompatibleRequestSchema } from '../../lib/compatibleSchemas.js';

const call = { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } };
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const prompt = { model: 'auto', messages: [{ role: 'user', content: 'Read the README file.' }], tools };
const jsonResponse = (content = 'Done') => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 8 } }), { status: 200 });

describe('OpenClaw / OpenAI-compatible completions', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };
  beforeEach(async () => {
    __resetRateLimitForTests();
    for (const name of Object.values(PROVIDER_ENV)) vi.stubEnv(name, '');
    initializeCredentials(); seedCatalogFromConfig();
    headers = { authorization: `Bearer ${createIntegrationKey('OpenClaw test').key}` };
    app = Fastify(); registerAuth(app);
    await app.register(completionsRoutes, { prefix: '/v1' });
    await app.register(modelsRoutes, { prefix: '/v1' });
    await app.ready();
  });
  afterEach(async () => { await app.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const send = (payload: object) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload });

  it('discovers routing aliases with the standard model-list envelope', async () => {
    const result = await app.inject({ url: '/v1/models', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().object).toBe('list');
    expect(result.json().data.map((m: { id: string }) => m.id)).toEqual(['auto', 'auto-cheap', 'auto-best']);
  });

  it.each(['auto', 'auto-cheap', 'auto-best'])('returns a traced offline completion for %s', async (model) => {
    const result = await send({ model, messages: [{ role: 'user', content: 'Say hello.' }] });
    expect(result.statusCode).toBe(200);
    expect(result.json().object).toBe('chat.completion');
    expect(result.json().choices[0].message.content).toContain('offline mode');
    expect(result.json().usage.total_tokens).toBeGreaterThan(0);
    const [logged] = listRecentRequests(1);
    expect(logged.id).toBe(result.json().request_id);
    expect(logged.endpoint).toBe('/v1/chat/completions');
    expect(logged.source).toBe('offline');
    expect(logged.routing?.final_model).toBe(result.json().model);
    expect(providerAttemptStats(0)).toEqual([]);
  });

  it.each(['openai', 'openrouter', 'groq'] as const)('preserves a complete tool round trip through %s using the server key', async (provider) => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
    storeProviderCredential(provider, 'sk-private-upstream-key');
    const upstream = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 45, completion_tokens: 12 } }))).mockImplementationOnce(() => jsonResponse('The README describes a router.'));
    vi.stubGlobal('fetch', upstream);
    const first = await send({ ...prompt, temperature: 0.2, max_tokens: 4000, tool_choice: 'auto' });
    expect(first.statusCode).toBe(200);
    expect(first.json().choices[0].finish_reason).toBe('tool_calls');
    expect(first.json().choices[0].message.tool_calls).toEqual([call]);
    const firstRequest = JSON.parse(upstream.mock.calls[0][1].body);
    expect(firstRequest.tools).toEqual(tools);
    expect(firstRequest.temperature).toBe(0.2);
    expect(firstRequest.max_tokens).toBe(4000);
    expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-private-upstream-key');
    expect(upstream.mock.calls[0][1].headers.Authorization).not.toBe(headers.authorization);
    const second = await send({ ...prompt, messages: [...prompt.messages, first.json().choices[0].message, { role: 'tool', tool_call_id: 'call_read', content: 'AI Model Router documentation' }] });
    expect(second.statusCode).toBe(200);
    expect(second.json().choices[0].message.content).toBe('The README describes a router.');
    expect(JSON.parse(upstream.mock.calls[1][1].body).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_read' });
    expect(listRecentRequests(2)).toHaveLength(2);
    expect(providerAttemptStats(0)[0].attempts).toBe(2);
  });

  it('translates Anthropic tools, IDs, results, and usage in both directions', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
    storeProviderCredential('anthropic', 'sk-anthropic-fixture');
    const upstream = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', id: 'call_read', name: 'read_file', input: { path: 'README.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 30 } }))).mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'The file is a guide.' }], stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 12 } })));
    vi.stubGlobal('fetch', upstream);
    const first = await send({ ...prompt, messages: [{ role: 'developer', content: 'Act as a file assistant.' }, ...prompt.messages], tool_choice: { type: 'function', function: { name: 'read_file' } }, parallel_tool_calls: false, max_completion_tokens: 1000 });
    expect(first.statusCode).toBe(200);
    expect(first.json().choices[0].message.tool_calls).toEqual([call]);
    const sent = JSON.parse(upstream.mock.calls[0][1].body);
    expect(sent.system).toBe('Act as a file assistant.');
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'read_file', disable_parallel_tool_use: true });
    expect(sent.max_tokens).toBe(1000);
    expect(sent.tools[0].input_schema).toEqual(tools[0].function.parameters);
    const second = await send({ ...prompt, messages: [...prompt.messages, first.json().choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'The documentation' }] });
    expect(second.statusCode).toBe(200);
    expect(second.json().usage).toEqual({ prompt_tokens: 80, completion_tokens: 12, total_tokens: 92 });
    const history = JSON.parse(upstream.mock.calls[1][1].body).messages;
    expect(history[1].content[1]).toMatchObject({ type: 'tool_use', id: 'call_read' });
    expect(history[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_read', content: 'The documentation' });
  });

  it('emits standard SSE tool deltas, a finish reason, usage, and DONE', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('groq', 'gsk-fixture-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 6 } }))));
    const response = await send({ ...prompt, stream: true, stream_options: { include_usage: true } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['x-request-id']).toBeTruthy();
    const events = response.body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
    expect(events.at(-1)).toBe('[DONE]');
    expect(JSON.parse(events[0]).choices[0].delta.tool_calls[0]).toEqual({ index: 0, ...call });
    expect(JSON.parse(events[1]).choices[0].finish_reason).toBe('tool_calls');
    expect(JSON.parse(events[2]).usage.total_tokens).toBe(11);
  });

  it('falls back after an upstream failure without leaking provider error text', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('openai', 'sk-fixture-openai');
    const upstream = vi.fn().mockResolvedValueOnce(new Response('SECRET provider body', { status: 401 })).mockImplementation(() => jsonResponse('Fallback worked'));
    vi.stubGlobal('fetch', upstream);
    const response = await send({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('SECRET');
    expect(listRecentRequests(1)[0].fallback_level).toBe('backup');
    expect(providerAttemptStats(0)[0]).toMatchObject({ attempts: 2, failures: 1 });
  });

  it.each([false, true])('reports total failure and records it (stream=%s)', async (stream) => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('groq', 'gsk-fixture-key');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('SECRET upstream error', { status: 401 }))));
    const response = await send({ ...prompt, stream });
    expect(response.statusCode).toBe(stream ? 200 : 502);
    expect(response.body).toContain('provider_error');
    expect(response.body).not.toContain('SECRET');
    const [logged] = listRecentRequests(1);
    expect(logged.success).toBe(false);
    // The candidates and their scores are what you need when nothing worked,
    // so a failed request still gets its routing decision.
    expect(logged.routing).not.toBeNull();
    expect(logged.routing!.considered_models.length).toBeGreaterThan(0);
    expect(logged.routing!.reason).toContain('every candidate failed');
  });

  it('reports a provider rate limit as one, not as a broken provider', async () => {
    // A real burst against Gemini's free tier returns 429 from the provider.
    // Answering 502 "check the key, balance and model access" sends the caller
    // to look at three things that are all fine, when the fix is to wait.
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('groq', 'gsk-fixture-key');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('slow down', { status: 429 }))));
    const response = await send({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('provider_rate_limited');
    expect(response.json().error.message).toMatch(/rate limited/i);
  });

  it('says a conversation is too large rather than blaming capability', async () => {
    // The original path already reports context_length_exceeded here, and the
    // documented error table promises the specific reason on both paths.
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('groq', 'gsk-fixture-key');
    const huge = 'word '.repeat(60000); // 300k chars, ~75k tokens each
    const response = await send({ model: 'auto', messages: [{ role: 'user', content: huge }, { role: 'assistant', content: huge }] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('context_length_exceeded');
    expect(response.json().error.message).toMatch(/context window/);
  });

  it('returns an actionable error when only Gemini is configured for a tool conversation', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('google', 'gemini-fixture-key');
    const response = await send(prompt);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('tool conversation');
  });

  it('accepts text content arrays from OpenAI-compatible clients', async () => {
    const response = await send({ model: 'auto', messages: [{ role: 'developer', content: 'Answer briefly.' }, { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'there' }] }] });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toContain('offline mode');
  });

  it('supports a Gemini text completion from a key saved in Settings', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('google', 'google-fixture-key');
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } })));
    vi.stubGlobal('fetch', upstream);
    const response = await send({ model: 'auto', max_tokens: 150, temperature: 0.3, top_p: 0.8, stop: 'END', messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('Hello from Gemini');
    expect(response.json().usage.total_tokens).toBe(19);
    expect(response.json().choices[0].finish_reason).toBe('length');
    const [url, init] = upstream.mock.calls[0];
    expect(url).not.toContain('google-fixture-key');
    expect(init.headers['x-goog-api-key']).toBe('google-fixture-key');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toMatchObject({ systemInstruction: { parts: [{ text: 'Be helpful' }] }, generationConfig: { maxOutputTokens: 150, temperature: 0.3, topP: 0.8, stopSequences: ['END'] } });
  });

  it.each([
    ['openai', { choices: [{ message: { content: null, refusal: 'Declined' } }] }],
    ['groq', { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }],
    ['anthropic', { stop_reason: 'refusal' }],
    ['google', { promptFeedback: { blockReason: 'SAFETY' } }],
    ['google', { candidates: [{ finishReason: 'SAFETY' }] }],
  ] as const)('stops on a refusal from %s without trying another model', async (provider, body) => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
    storeProviderCredential(provider, 'fixture-provider-key');
    const upstream = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body))));
    vi.stubGlobal('fetch', upstream);
    const response = await send({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('provider_refused');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(listRecentRequests(1)[0].success).toBe(false);
  });

  it('closes a refused SSE response without falling back', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('groq', 'fixture-key');
    const upstream = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { refusal: 'No' } }] }))));
    vi.stubGlobal('fetch', upstream);
    const response = await send({ ...prompt, stream: true });
    expect(response.body).toContain('provider_refused');
    expect(response.body).toContain('data: [DONE]');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['openai', { choices: [{ message: { content: 'Answer' } }], usage: { prompt_tokens: -1, completion_tokens: 2.5 } }],
    ['anthropic', { content: [{ type: 'text', text: 'Answer' }], usage: { input_tokens: 'wrong', output_tokens: -1 } }],
    ['google', { candidates: [{ content: { parts: [{ text: 'Answer' }] } }], usageMetadata: { promptTokenCount: 2.5, candidatesTokenCount: -1 } }],
  ] as const)('estimates invalid usage from %s without discarding a valid answer', async (provider, body) => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential(provider, 'fixture-provider-key');
    const upstream = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body)))); vi.stubGlobal('fetch', upstream);
    const response = await send({ model: 'auto', messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('Answer');
    expect(upstream).toHaveBeenCalledTimes(1);
    const usage = response.json().usage;
    expect(Number.isSafeInteger(usage.prompt_tokens)).toBe(true);
    expect(Number.isSafeInteger(usage.completion_tokens)).toBe(true);
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
  });

  it('falls back from a whitespace-only answer and records only the real completion', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0'); storeProviderCredential('openai', 'fixture-key');
    const upstream = vi.fn().mockImplementationOnce(() => jsonResponse('   ')).mockImplementationOnce(() => jsonResponse('Answer'));
    vi.stubGlobal('fetch', upstream);
    const response = await send({ messages: [{ role: 'user', content: 'Hello' }] });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('Answer');
    expect(listRecentRequests(1)[0].fallback_level).toBe('backup');
  });

  it('preserves code whitespace and empty tool results while stripping forbidden controls', () => {
    const content = 'def f():\n    return "a  b"\u0000';
    const parsed = CompatibleRequestSchema.parse({ messages: [{ role: 'user', content }] });
    expect(parsed.messages[0].content).toBe('def f():\n    return "a  b"');
    expect(CompatibleRequestSchema.safeParse({ messages: [...prompt.messages, { role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '' }] }).success).toBe(true);
  });

  it.each(['', '   \t', '\u0000\u0007'])('rejects blank user text before calling a provider: %j', async (content) => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await send({ messages: [{ role: 'user', content }] })).statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('cancels a stalled response body on disconnect without retrying', async () => {
    storeProviderCredential('openai', 'fixture-key');
    const controller = new AbortController();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const upstream = vi.fn().mockImplementation(async (_url, init: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        started();
      }),
    }));
    vi.stubGlobal('fetch', upstream);
    const pending = compatibleCompletion('openai', 'test', CompatibleRequestSchema.parse({ messages: prompt.messages }), controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    await reading; controller.abort(); await assertion;
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('normalizes token and sampling parameters for OpenAI reasoning models', async () => {
    storeProviderCredential('openai', 'sk-fixture-openai');
    const upstream = vi.fn().mockImplementation(() => jsonResponse());
    vi.stubGlobal('fetch', upstream);
    await compatibleCompletion('openai', 'o3-mini', CompatibleRequestSchema.parse({ messages: [{ role: 'user', content: 'Reason carefully.' }], max_tokens: 2000, temperature: 0.2, top_p: 0.5, stop: 'END' }));
    const payload = JSON.parse(upstream.mock.calls[0][1].body);
    expect(payload.max_completion_tokens).toBe(2000);
    for (const property of ['max_tokens', 'temperature', 'top_p', 'stop']) expect(payload).not.toHaveProperty(property);
    expect(upstream.mock.calls[0][1].redirect).toBe('error');
  });

  it.each([
    { model: 'invented-model', messages: prompt.messages },
    { messages: [] },
    { messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'result' }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [call] }] },
    { ...prompt, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/pic.png' } }] }] },
    { ...prompt, tool_choice: { type: 'function', function: { name: 'missing_tool' } } },
    { ...prompt, n: 2 },
  ])('rejects unsupported or malformed input before contacting a provider: %j', async (payload) => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await send(payload)).statusCode).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
