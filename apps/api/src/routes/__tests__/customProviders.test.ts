import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { settingsRoutes } from '../settings.js';
import { completionsRoutes } from '../completions.js';
import { providersRoutes } from '../providers.js';
import { registerAuth } from '../../lib/auth.js';
import { administratorKey, createIntegrationKey, initializeCredentials, PROVIDER_ENV, providerCredential } from '../../lib/credentials.js';
import { configuredProviders } from '../../lib/providerAvailability.js';
import { seedCatalogFromConfig } from '../../lib/modelCatalog.js';
import { listModels } from '../../lib/db/models.js';
import { listRecentRequests } from '../../lib/db/requests.js';
import { customProvider } from '../../lib/db/customProviders.js';
import { chatWithProvider } from '../../lib/providers.js';
import { __resetRateLimitForTests } from '../../lib/rateLimit.js';

const setup = {
  provider: 'custom-example', name: 'Example', base_url: 'https://provider.example/v1/', key: 'custom-fixture-secret',
  model: { model_name: 'example-chat', cost_input: 0.001, cost_output: 0.002, max_tokens: 32000, supports_functions: true, quality_rating: 85, avg_latency: 1000, strengths: ['chat', 'coding', 'agent_step'] },
};
const answer = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello from custom' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));

describe('custom provider setup and routing', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };
  beforeEach(async () => {
    __resetRateLimitForTests();
    for (const name of Object.values(PROVIDER_ENV)) vi.stubEnv(name, '');
    initializeCredentials(); seedCatalogFromConfig();
    headers = { authorization: `Bearer ${administratorKey()}` };
    app = Fastify(); registerAuth(app);
    await app.register(settingsRoutes, { prefix: '/admin' });
    await app.register(completionsRoutes, { prefix: '/v1' });
    await app.register(providersRoutes, { prefix: '/v1' });
    await app.ready();
  });
  afterEach(async () => { await app.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const save = (payload: object = setup) => app.inject({ method: 'PUT', url: '/admin/custom-providers', headers, payload });

  it('requires administrator access, encrypts keys, keeps custom models after refresh, and removes only that provider', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/custom-providers', payload: setup })).statusCode).toBe(401);
    expect((await save()).statusCode).toBe(200);
    expect(providerCredential(setup.provider)).toBe(setup.key);
    expect(configuredProviders()).toEqual([setup.provider]);
    const settings = await app.inject({ url: '/admin/settings', headers });
    expect(settings.body).not.toContain(setup.key);
    expect(settings.json().custom_providers[0]).toMatchObject({ name: 'Example', base_url: 'https://provider.example/v1', models: [{ model_name: 'example-chat', data_source: 'custom' }] });
    const health = await app.inject({ url: '/v1/providers', headers });
    expect(health.json().providers).toContainEqual(expect.objectContaining({ provider: setup.provider, configured: true }));
    seedCatalogFromConfig();
    expect(listModels({ provider: setup.provider })).toHaveLength(1);
    expect((await save({ ...setup, key: undefined, model: { ...setup.model, model_name: 'another-model' } })).statusCode).toBe(200);
    expect(listModels({ provider: setup.provider })).toHaveLength(2);
    expect((await save({ ...setup, key: 'replacement-fixture-key' })).statusCode).toBe(200);
    expect(providerCredential(setup.provider)).toBe('replacement-fixture-key');
    expect((await app.inject({ method: 'DELETE', url: `/admin/custom-providers/${setup.provider}`, headers })).statusCode).toBe(200);
    expect(customProvider(setup.provider)).toBeUndefined();
    expect(providerCredential(setup.provider)).toBe('');
    expect(listModels({ provider: setup.provider })).toEqual([]);
    expect(listModels({ provider: 'openai' }).length).toBeGreaterThan(0);
    expect((await app.inject({ method: 'DELETE', url: `/admin/custom-providers/${setup.provider}`, headers })).statusCode).toBe(404);
  });

  it.each(['not a URL', 'https://', '', 'http://remote.example/v1', 'https://user:pass@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#fragment', 'https://provider.example/v1/chat/completions', 'file:///tmp/socket'])('rejects invalid endpoint %s', async (base_url) => {
    expect((await save({ ...setup, base_url })).statusCode).toBe(400);
    expect(configuredProviders()).toEqual([]);
  });

  it('requires keys for new endpoints, protects built-ins, validates model data, and accepts explicit localhost', async () => {
    expect((await save({ ...setup, key: undefined })).statusCode).toBe(400);
    expect((await save({ ...setup, provider: 'openai' })).statusCode).toBe(400);
    expect((await save({ ...setup, model: { ...setup.model, cost_input: -1 } })).statusCode).toBe(400);
    expect((await save({ ...setup, base_url: 'http://127.0.0.1:8080/v1' })).statusCode).toBe(200);
    expect((await save({ ...setup, key: undefined })).statusCode).toBe(400);
    expect((await save()).statusCode).toBe(200);
    expect(customProvider(setup.provider)?.base_url).toBe('https://provider.example/v1');
  });

  it('uses the custom endpoint and provider key for Playground completions', async () => {
    await save(); vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
    const upstream = vi.fn().mockImplementation(answer); vi.stubGlobal('fetch', upstream);
    const result = await chatWithProvider(setup.provider, setup.model.model_name, [{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Hello from custom');
    expect(upstream.mock.calls[0][0]).toBe('https://provider.example/v1/chat/completions');
    expect(upstream.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${setup.key}` } });
    expect(JSON.parse(upstream.mock.calls[0][1].body).model).toBe('example-chat');
  });

  it('routes a client key through a custom tool round trip and SSE, preserving tool history', async () => {
    await save(); vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
    const clientHeaders = { authorization: `Bearer ${createIntegrationKey('test client').key}` };
    const call = { id: 'call_test', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } };
    const upstream = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] }))).mockImplementation(answer);
    vi.stubGlobal('fetch', upstream);
    const tools = [{ type: 'function', function: { name: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }];
    const messages = [{ role: 'user', content: 'Say hi using echo.' }];
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: clientHeaders, payload: { model: 'auto', messages, tools } });
    expect(first.statusCode).toBe(200);
    expect(first.json().model).toBe('custom-example/example-chat');
    expect(first.json().choices[0].message.tool_calls).toEqual([call]);
    const second = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: clientHeaders, payload: { model: 'auto', messages: [...messages, first.json().choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'hi' }], tools, stream: true } });
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('Hello from custom');
    expect(second.body).toContain('data: [DONE]');
    expect(JSON.parse(upstream.mock.calls[1][1].body).messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: call.id });
    expect(upstream.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${setup.key}`);
    expect(listRecentRequests(2).every((r) => r.source === 'live' && r.provider === setup.provider)).toBe(true);
    await save({ ...setup, model: { ...setup.model, supports_functions: false } });
    const unsupported = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: clientHeaders, payload: { model: 'auto', messages, tools } });
    expect(unsupported.statusCode).toBe(422);
  });
});
