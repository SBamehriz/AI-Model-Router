import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, authRequired } from '../../lib/auth.js';
import { settingsRoutes } from '../settings.js';
import { administratorKey, initializeCredentials, providerCredential, PROVIDER_ENV, createIntegrationKey } from '../../lib/credentials.js';
import { __resetRateLimitForTests } from '../../lib/rateLimit.js';
import { getDb } from '../../lib/db/index.js';
import { configuredProviders } from '../../lib/providerAvailability.js';

describe('secure provider and integration setup', () => {
  let app: FastifyInstance;
  let headers: { authorization: string };
  beforeEach(async () => {
    __resetRateLimitForTests();
    for (const name of Object.values(PROVIDER_ENV)) vi.stubEnv(name, '');
    initializeCredentials();
    headers = { authorization: `Bearer ${administratorKey()}` };
    app = Fastify();
    registerAuth(app);
    await app.register(settingsRoutes, { prefix: '/admin' });
    app.get('/v1/models', async () => ({ object: 'list' }));
    app.get('/v1/usage', async () => ({ private: true }));
    await app.ready();
  });
  afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

  it('requires the administrator even when the local demo API is open', async () => {
    expect(authRequired()).toBe(false);
    expect((await app.inject('/admin/settings')).statusCode).toBe(401);
    const result = await app.inject({ url: '/admin/settings', headers });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json().providers).toHaveLength(5);
  });

  it.each([['1', true], [' 1 ', true], ['0', false], ['', false]] as const)(
    'reports forced offline the same way the router applies it, for %s',
    async (value, expected) => {
      // Settings used to compare this value raw while the router trimmed it,
      // so a padded switch put the interface and the routing out of step.
      vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', value);
      const body = (await app.inject({ url: '/admin/settings', headers })).json();
      expect(body.forced_offline).toBe(expected);
      if (expected) expect(body.offline_mode).toBe(true);
    },
  );

  it('strips characters that would make a router key name read as something else', async () => {
    // A right-to-left override reverses what follows it wherever the name is
    // drawn, and the revoke list is where someone decides which key to kill.
    const RLO = String.fromCodePoint(0x202e);
    const C1 = String.fromCodePoint(0x85);
    const name = `billing${RLO}gnikcah${C1} key`;
    const created = await app.inject({ method: 'POST', url: '/admin/keys', headers, payload: { name } });
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe('billinggnikcah key');

    const listed = (await app.inject({ url: '/admin/settings', headers })).json();
    const stored = listed.keys.find((k: { id: string }) => k.id === created.json().id);
    expect(stored.name).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u0080-\u009F]/);
  });

  it('refuses a name that is nothing but formatting characters', async () => {
    const result = await app.inject({ method: 'POST', url: '/admin/keys', headers, payload: { name: String.fromCodePoint(0x202e, 0x2066) } });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe('validation_error');
  });

  it.each(['openai', 'anthropic', 'openrouter', 'google', 'groq'] as const)('encrypts, replaces, and removes %s without returning the key', async (provider) => {
    const secret = `sk-private-fixture-${provider}`;
    const result = await app.inject({ method: 'PUT', url: `/admin/providers/${provider}`, headers, payload: { key: secret } });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain(secret);
    expect(configuredProviders()).toContain(provider);
    expect(providerCredential(provider)).toBe(secret);
    const databaseDump = JSON.stringify(getDb().prepare('SELECT * FROM provider_credentials').all());
    expect(databaseDump).not.toContain(secret);
    expect(authRequired()).toBe(true);
    expect((await app.inject('/v1/models')).statusCode).toBe(401);
    expect((await app.inject({ url: '/admin/settings', headers })).body).not.toContain(secret);
    await app.inject({ method: 'PUT', url: `/admin/providers/${provider}`, headers, payload: { key: secret + '-new' } });
    expect(providerCredential(provider)).toBe(secret + '-new');
    expect((await app.inject({ method: 'DELETE', url: `/admin/providers/${provider}`, headers })).statusCode).toBe(200);
    expect(providerCredential(provider)).toBe('');
  });

  it('shows a router key once, restricts its access, and revokes it without reopening the API', async () => {
    const created = await app.inject({ method: 'POST', url: '/admin/keys', headers, payload: { name: 'OpenClaw laptop' } });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { key, id } = created.json();
    expect(key).toMatch(/^amr_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(getDb().prepare('SELECT * FROM integration_keys').all())).not.toContain(key);
    const appHeaders = { authorization: `Bearer ${key}` };
    expect((await app.inject({ url: '/v1/models', headers: appHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/usage', headers: appHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: '/admin/settings', headers: appHeaders })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/admin/providers/openai', headers: appHeaders, payload: { key: 'sk-attacker-value' } })).statusCode).toBe(401);
    const saved = await app.inject({ url: '/admin/settings', headers });
    expect(saved.json().keys[0].name).toBe('OpenClaw laptop');
    expect(saved.body).not.toContain(key);
    expect((await app.inject({ method: 'DELETE', url: `/admin/keys/${id}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/models', headers: appHeaders })).statusCode).toBe(401);
    expect((await app.inject('/v1/models')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/usage', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/admin/keys/${id}`, headers })).statusCode).toBe(404);
  });

  it('does not allow provider keys or the legacy instance key to administer credentials', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_API_KEY', 'legacy-application-key');
    for (const key of ['legacy-application-key', 'sk-provider-key']) {
      expect((await app.inject({ url: '/admin/settings', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(401);
    }
  });

  it('keeps environment-managed keys read-only and out of responses', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-managed-secret');
    const result = await app.inject({ method: 'PUT', url: '/admin/providers/openai', headers, payload: { key: 'sk-another-secret' } });
    expect(result.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/admin/providers/openai', headers })).statusCode).toBe(409);
    const settings = (await app.inject({ url: '/admin/settings', headers })).json();
    expect(settings.providers[0]).toMatchObject({ configured: true, source: 'environment' });
    expect(JSON.stringify(settings)).not.toContain('environment-managed-secret');
  });

  it.each([{ key: '' }, { key: 'short' }, { key: 'abc def ghi' }, { key: 'sk-valid-but-unknown-property', extra: true }])('rejects invalid provider input: %j', async (payload) => {
    expect((await app.inject({ method: 'PUT', url: '/admin/providers/openai', headers, payload })).statusCode).toBe(400);
  });

  it('rejects unknown providers, empty key names, and excess integration keys', async () => {
    expect((await app.inject({ method: 'PUT', url: '/admin/providers/untrusted', headers, payload: { key: 'sk-whatever' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/admin/providers/untrusted', headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/admin/keys', headers, payload: { name: ' ' } })).statusCode).toBe(400);
    for (let i = 0; i < 50; i++) createIntegrationKey(`app ${i}`);
    expect((await app.inject({ method: 'POST', url: '/admin/keys', headers, payload: { name: 'overflow' } })).statusCode).toBe(409);
  });

  it('rate limits repeated administrator guesses', async () => {
    for (let i = 0; i < 60; i++) await app.inject('/admin/settings');
    expect((await app.inject('/admin/settings')).statusCode).toBe(429);
  });
});
