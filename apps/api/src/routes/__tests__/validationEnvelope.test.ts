import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { chatRoutes } from '../chat.js';
import { usageRoutes } from '../usage.js';
import { modelsRoutes } from '../models.js';
import { requestsRoutes } from '../requests.js';
import { debugRoutes } from '../debug.js';
import { completionsRoutes } from '../completions.js';
import { settingsRoutes } from '../settings.js';
import { healthRoutes } from '../health.js';
import { seedCatalogFromConfig } from '../../lib/modelCatalog.js';
import { registerErrors } from '../../lib/errors.js';
import { initializeCredentials } from '../../lib/credentials.js';

/**
 * The sibling guard reads the source and looks for the shape of a rejection.
 * That works only for spellings it knows, and it was proven blind to three:
 * a double-quoted code, a code held in a variable, and a route inventing a
 * code of its own. The last is the likely one, because somebody adding an
 * endpoint picks a code without reading what the others use.
 *
 * This asks the server instead. Each case sends a request with one field
 * deliberately wrong and requires the answer to say which field that was. No
 * way of writing the rejection gets around that, because it reads what the
 * caller receives rather than how the route was typed.
 */
const ADMIN = 'validation-envelope-administrator-key-0123456789';

type Case = {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  payload?: unknown;
  /** The field the request got wrong, which the answer has to name. */
  field: string;
};

const OK_MESSAGE = { role: 'user', content: 'hi' };

const CASES: Case[] = [
  { name: 'chat without messages', method: 'POST', url: '/v1/chat', payload: {}, field: 'messages' },
  { name: 'chat with an unknown priority', method: 'POST', url: '/v1/chat', payload: { messages: [OK_MESSAGE], priority: 'nope' }, field: 'priority' },
  { name: 'chat with a negative max_cost', method: 'POST', url: '/v1/chat', payload: { messages: [OK_MESSAGE], max_cost: -1 }, field: 'max_cost' },
  { name: 'agent step without messages', method: 'POST', url: '/v1/agent-step', payload: {}, field: 'messages' },
  { name: 'compatible completion without messages', method: 'POST', url: '/v1/chat/completions', payload: { model: 'auto' }, field: 'messages' },
  { name: 'compatible completion with an unknown alias', method: 'POST', url: '/v1/chat/completions', payload: { model: 'gpt-9', messages: [OK_MESSAGE] }, field: 'model' },
  { name: 'router debug without messages', method: 'POST', url: '/v1/router/debug', payload: {}, field: 'messages' },
  { name: 'models with a repeated provider', method: 'GET', url: '/v1/models?provider=a&provider=b', field: 'provider' },
  { name: 'usage with an unparseable from', method: 'GET', url: '/v1/usage?from=not-a-date', field: 'from' },
  { name: 'requests with a non numeric limit', method: 'GET', url: '/v1/requests?limit=abc', field: 'limit' },
  { name: 'a custom provider with no fields', method: 'PUT', url: '/admin/custom-providers', payload: {}, field: 'provider' },
  { name: 'a router key with no name', method: 'POST', url: '/admin/keys', payload: {}, field: 'name' },
  { name: 'a provider key with no key', method: 'PUT', url: '/admin/providers/google', payload: {}, field: 'key' },
  { name: 'removing a provider that does not exist', method: 'DELETE', url: '/admin/providers/nope', field: 'provider' },
];

/**
 * Routes that accept nothing from the caller to get wrong. Health and
 * readiness take no input; the provider and settings listings take none.
 * This is an explicit list because a route that is here is a decision, and
 * a new route that is not here and has no case above fails the coverage
 * check below until somebody makes that decision on purpose.
 */
const NO_CALLER_INPUT = new Set(['GET /health', 'GET /ready', 'GET /v1/providers', 'GET /admin/settings']);

/**
 * Routes whose only rejection is "that thing does not exist", which is a 404
 * naming the thing, not a 400 about the shape of what was sent.
 */
const ONLY_REJECTS_ABSENCE = new Set(['DELETE /admin/keys/:id', 'DELETE /admin/custom-providers/:provider']);

describe('what a rejected request is told', () => {
  let app: FastifyInstance;
  const registered: string[] = [];

  beforeEach(async () => {
    process.env.AI_MODEL_ROUTER_OFFLINE = '1';
    process.env.AI_MODEL_ROUTER_ADMIN_KEY = ADMIN;
    seedCatalogFromConfig();
    initializeCredentials();

    app = Fastify({ logger: false, genReqId: () => randomUUID() });
    registered.length = 0;
    app.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== 'HEAD' && method !== 'OPTIONS') registered.push(`${method} ${route.url}`);
      }
    });
    registerErrors(app);
    app.addHook('onRequest', async (req) => { req.request_id = randomUUID(); });
    await app.register(chatRoutes, { prefix: '/v1' });
    await app.register(usageRoutes, { prefix: '/v1' });
    await app.register(modelsRoutes, { prefix: '/v1' });
    await app.register(requestsRoutes, { prefix: '/v1' });
    await app.register(debugRoutes, { prefix: '/v1/router' });
    await app.register(completionsRoutes, { prefix: '/v1' });
    await app.register(settingsRoutes, { prefix: '/admin' });
    await app.register(healthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AI_MODEL_ROUTER_ADMIN_KEY;
    await app?.close();
  });

  it.each(CASES)('$name is told which field was wrong', async ({ method, url, payload, field }) => {
    const response = await app.inject({ method, url, payload: payload as never });
    expect(response.statusCode, `${url} should refuse this`).toBe(400);

    const body = response.json();
    const envelope = body.error ?? {};
    const detailPaths: string[] = (envelope.details ?? []).map((d: { path: string }) => d.path);
    const named = String(envelope.message ?? '').toLowerCase().includes(field.toLowerCase()) || detailPaths.some((p) => p.includes(field));

    expect(
      named,
      `answering ${url} did not name "${field}".\n` +
        `message: ${JSON.stringify(envelope.message)}\n` +
        `details: ${JSON.stringify(envelope.details)}\n` +
        'A rejection has to say which field was wrong, however the route spells it.',
    ).toBe(true);
  });

  /**
   * Naming the first bad field is not enough when several are wrong: a caller
   * fixing them one at a time pays a round trip for each.
   */
  it('lists every bad field at once, not just the first', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { messages: [OK_MESSAGE], priority: 'nope', latency_pref: 'sideways' } as never,
    });
    expect(response.statusCode).toBe(400);
    const paths: string[] = (response.json().error.details ?? []).map((d: { path: string }) => d.path);
    expect(paths).toContain('priority');
    expect(paths).toContain('latency_pref');
  });

  /**
   * The cases above were a list somebody wrote, and a list somebody wrote is
   * a list somebody forgot to extend: three routes had no case when this
   * check was added. The routes come from the app now, so an endpoint added
   * tomorrow fails here until it has a case, or is put on one of the two lists
   * above, both of which are decisions rather than defaults.
   */
  it('has a case for every registered route that takes caller input', () => {
    expect(registered.length, 'no routes were collected').toBeGreaterThan(10);
    const covered = new Set(CASES.map((c) => `${c.method} ${c.url.split('?')[0]}`));
    const matchesCase = (route: string) => {
      const [method, pattern] = route.split(' ');
      const re = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
      return [...covered].some((c) => c.startsWith(`${method} `) && re.test(c.slice(method.length + 1)));
    };
    const uncovered = [...new Set(registered)].filter(
      (route) => !NO_CALLER_INPUT.has(route) && !ONLY_REJECTS_ABSENCE.has(route) && !matchesCase(route),
    );
    expect(
      uncovered,
      `these routes take caller input and have no case proving a rejection names the field:\n  ${uncovered.join('\n  ')}\n` +
        'Add a case to CASES, or add the route to NO_CALLER_INPUT or ONLY_REJECTS_ABSENCE if that is really true of it.',
    ).toEqual([]);
  });

  it('never answers a rejected request with an empty or generic message', async () => {
    for (const { method, url, payload } of CASES) {
      const body = (await app.inject({ method, url, payload: payload as never })).json();
      const message = String(body.error?.message ?? '');
      expect(message.length, `${url} answered with nothing`).toBeGreaterThan(0);
      expect(
        /^(invalid request|bad request|validation failed|invalid request body)\.?$/i.test(message.trim()),
        `${url} answered "${message}", which says only that something was wrong`,
      ).toBe(false);
    }
  });
});
