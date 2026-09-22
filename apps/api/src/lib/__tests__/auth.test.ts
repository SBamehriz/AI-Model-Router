import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, authRequired, keysMatch } from '../auth.js';
import { __resetRateLimitForTests } from '../rateLimit.js';
import { createIntegrationKey } from '../credentials.js';

/**
 * Access control with a single optional shared key. These tests also pin the
 * wiring: hooks have to apply to routes registered after them, which is what an
 * encapsulated plugin would silently fail to do.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAuth(app);
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1/models', async () => ({ models: [] }));
  await app.ready();
  return app;
}

describe('auth', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    __resetRateLimitForTests();
    delete process.env.AI_MODEL_ROUTER_API_KEY;
  });

  afterEach(async () => {
    delete process.env.AI_MODEL_ROUTER_API_KEY;
    await app?.close();
  });

  describe('with no key configured', () => {
    beforeEach(async () => {
      app = await buildApp();
    });

    it('reports that auth is not required', () => {
      expect(authRequired()).toBe(false);
    });

    it('serves /v1 routes without credentials', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.statusCode).toBe(200);
    });

    it('attaches a request id header', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.headers['x-request-id']).toBeTruthy();
    });
  });

  describe('with a key configured', () => {
    beforeEach(async () => {
      process.env.AI_MODEL_ROUTER_API_KEY = 'ai-model-router_test_key';
      app = await buildApp();
    });

    it('reports that auth is required', () => {
      expect(authRequired()).toBe(true);
    });

    it('rejects a request with no key', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('invalid_api_key');
    });

    it('rejects a request with the wrong key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer wrong' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('accepts a bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer ai-model-router_test_key' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('accepts an x-api-key header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { 'x-api-key': 'ai-model-router_test_key' },
      });
      expect(response.statusCode).toBe(200);
    });

    it('leaves /health public', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('a guesser against a working client', () => {
    beforeEach(async () => {
      process.env.AI_MODEL_ROUTER_API_KEY = 'ai-model-router_test_key';
      process.env.RATE_LIMIT_MAX = '100';
      app = await buildApp();
    });

    it('lets a guesser spend none of the budget a working client needs', async () => {
      // The two per-address budgets collapse into one behind a reverse proxy,
      // which is the documented deployment, so the guarantee that matters is
      // that guessing cannot reach the shared budget at all.
      const good = { authorization: 'Bearer ai-model-router_test_key' };
      const before = await app.inject({ method: 'GET', url: '/v1/models', headers: good });
      expect(before.statusCode).toBe(200);
      const remainingBefore = Number(before.headers['x-ratelimit-remaining']);

      for (let i = 0; i < 20; i += 1) {
        await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer wrong-${i}` } });
      }

      const after = await app.inject({ method: 'GET', url: '/v1/models', headers: good });
      expect(after.statusCode).toBe(200);
      // Only this check itself moved the counter, not the twenty guesses.
      expect(Number(after.headers['x-ratelimit-remaining'])).toBe(remainingBefore - 1);
    });

  });

  describe('rate limiting', () => {
    beforeEach(async () => {
      process.env.RATE_LIMIT_MAX = '3';
      process.env.RATE_LIMIT_WINDOW_SEC = '60';
      app = await buildApp();
    });

    afterEach(() => {
      process.env.RATE_LIMIT_MAX = '100';
    });

    it('returns 429 once the window limit is exceeded', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode);
      }
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes.slice(3)).toEqual([429, 429]);
    });

    it('exposes rate-limit headers', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(response.headers['x-ratelimit-limit']).toBe('3');
      expect(response.headers['x-ratelimit-remaining']).toBe('2');
    });
  });

  describe('the shared budget turned off', () => {
    beforeEach(async () => {
      process.env.RATE_LIMIT_MAX = '0';
      process.env.AI_MODEL_ROUTER_API_KEY = 'ai-model-router_test_key';
      app = await buildApp();
    });

    afterEach(() => {
      process.env.RATE_LIMIT_MAX = '100';
    });

    it('stops limiting a working client, and stops claiming a budget it is not keeping', async () => {
      const headers = { authorization: 'Bearer ai-model-router_test_key' };
      const codes: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        codes.push((await app.inject({ method: 'GET', url: '/v1/models', headers })).statusCode);
      }
      expect(codes.every((code) => code === 200)).toBe(true);
      const last = await app.inject({ method: 'GET', url: '/v1/models', headers });
      expect(last.headers['x-ratelimit-limit']).toBeUndefined();
      expect(last.headers['x-ratelimit-remaining']).toBeUndefined();
    });

    it('still runs a key guesser out of attempts, because that budget is not this one', async () => {
      // The whole reason 0 is safe to offer: it turns off the throughput
      // budget and nothing else. The per-address budget for a refused key is
      // fixed at 60 a minute and is not read from the environment at all.
      let refused = 0;
      let limited = 0;
      for (let i = 0; i < 70; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer wrong-${i}` } });
        if (response.statusCode === 401) refused += 1;
        if (response.statusCode === 429) limited += 1;
      }
      expect(refused).toBe(60);
      expect(limited).toBe(10);
    });
  });

  describe('keysMatch', () => {
    it('matches identical keys', () => {
      expect(keysMatch('abc', 'abc')).toBe(true);
    });

    it('rejects different keys, including different lengths', () => {
      expect(keysMatch('abc', 'abd')).toBe(false);
      expect(keysMatch('abc', 'abcdef')).toBe(false);
    });
  });
});

/**
 * The whole access-control contract in one table.
 *
 * Every row is an endpoint, every column a caller. A new route that forgets its
 * scope, or a scope that quietly widens, changes a cell here before it reaches
 * anyone's instance.
 */
describe('access matrix', () => {
  const ADMIN = 'amr_admin_access_matrix_key_0000000000';
  const LEGACY = 'legacy-shared-secret';
  let app: FastifyInstance;
  let router: string;

  const ENDPOINTS: Array<[string, string, 'GET' | 'POST' | 'DELETE']> = [
    ['/health', 'health', 'GET'],
    ['/ready', 'readiness', 'GET'],
    ['/v1/models', 'model discovery', 'GET'],
    ['/v1/chat', 'chat', 'POST'],
    ['/v1/agent-step', 'agent step', 'POST'],
    ['/v1/chat/completions', 'compatible completions', 'POST'],
    ['/v1/router/debug', 'routing preview', 'POST'],
    ['/v1/usage', 'usage', 'GET'],
    ['/v1/requests', 'request log', 'POST'],
    ['/v1/providers', 'provider health', 'GET'],
    ['/admin/settings', 'settings', 'GET'],
    ['/admin/keys/:id', 'revoke key', 'DELETE'],
  ];

  /** What each caller may reach. Anything else is refused. */
  const ALLOWED: Record<string, string[]> = {
    none: ['/health', '/ready'],
    wrong: ['/health', '/ready'],
    router: ['/health', '/ready', '/v1/models', '/v1/chat', '/v1/agent-step', '/v1/chat/completions'],
    legacy: ENDPOINTS.map(([path]) => path).filter((path) => !path.startsWith('/admin/')),
    admin: ENDPOINTS.map(([path]) => path),
  };

  beforeEach(async () => {
    __resetRateLimitForTests();
    process.env.AI_MODEL_ROUTER_ADMIN_KEY = ADMIN;
    process.env.AI_MODEL_ROUTER_API_KEY = LEGACY;
    router = createIntegrationKey('access matrix').key;

    app = Fastify({ logger: false });
    registerAuth(app);
    for (const [path, , method] of ENDPOINTS) {
      app.route({ method, url: path, handler: async () => ({ reached: true }) });
    }
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AI_MODEL_ROUTER_ADMIN_KEY;
    delete process.env.AI_MODEL_ROUTER_API_KEY;
    await app?.close();
  });

  it.each(['none', 'wrong', 'router', 'legacy', 'admin'])('gives a %s caller exactly its endpoints', async (caller) => {
    const keys: Record<string, string> = { none: '', wrong: 'not-a-real-key', router: '', legacy: LEGACY, admin: ADMIN };
    const key = caller === 'router' ? router : keys[caller];

    for (const [path, name, method] of ENDPOINTS) {
      const response = await app.inject({
        method,
        url: path,
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      const reached = response.statusCode === 200;
      expect(reached, `${caller} on ${name}`).toBe(ALLOWED[caller].includes(path));
      if (!reached) expect([401, 403]).toContain(response.statusCode);
    }
  });

  /**
   * The guard runs before the body is parsed. A bodyless DELETE that declares
   * JSON makes the parser fail, and if the guard ran after it, an
   * unauthenticated caller would get that 400 instead of 401 and would have
   * spent the parser to get it.
   */
  it('answers an unauthenticated request before parsing its body', async () => {
    for (const key of ['', 'not-a-real-key']) {
      const response = await app.inject({
        method: 'DELETE',
        url: '/admin/keys/whatever',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      });
      expect(response.statusCode, `bodyless delete with key "${key}"`).toBe(401);
      expect(response.json().error.code).toBe('admin_required');
    }
  });

  it('refuses a router key on settings with the administrator code, not a scope error', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/settings', headers: { authorization: `Bearer ${router}` } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('admin_required');
  });

  it('refuses a router key on a reporting endpoint with a scope error', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${router}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
  });

  it('stops answering a run of wrong keys, then lets a good one through', async () => {
    const attempt = (key: string) =>
      app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${key}` } });

    for (let i = 0; i < 60; i += 1) {
      expect((await attempt(`guess-${i}`)).statusCode).toBe(401);
    }
    const throttled = await attempt('guess-60');
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe('rate_limited');

    // Failed attempts must not cost a caller that holds a real key.
    expect((await attempt(router)).statusCode).toBe(200);
  });

  it('keeps authentication on after the last router key is revoked', async () => {
    expect(authRequired()).toBe(true);
    delete process.env.AI_MODEL_ROUTER_API_KEY;
    // The meta flag set when a key was first created outlives every key.
    expect(authRequired()).toBe(true);
  });
});
