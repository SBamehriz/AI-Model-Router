import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from './rateLimit.js';
import { hashIntegrationKey, isAdministratorKey, providerCredentialStatus } from './credentials.js';
import { acceptsIntegrationKey } from './db/credentials.js';
import { getMeta } from './db/index.js';

/**
 * Access control for a single operator.
 *
 * Settings always require the administrator key. Once a provider or router key
 * exists, /v1 requires an administrator, router or legacy shared key. Only an
 * unconfigured local demo is open, and the default bind address is loopback.
 */

const PUBLIC_PATHS = new Set(['/health', '/ready']);

export function getConfiguredApiKey(): string | null {
  const key = process.env.AI_MODEL_ROUTER_API_KEY?.trim();
  return key ? key : null;
}

export function authRequired(): boolean {
  return getConfiguredApiKey() !== null || getMeta('integration_auth_enabled') === '1' || providerCredentialStatus().some((p) => p.configured);
}

/** Constant time comparison over fixed length digests. */
export function keysMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  if (typeof header === 'string') return header.trim();
  return null;
}

function errorReply(
  reply: FastifyReply,
  code: string,
  message: string,
  statusCode: number,
  request_id?: string
) {
  return reply.status(statusCode).send({ error: { code, message }, request_id });
}

/**
 * Attach the request id, authentication and rate limit hooks.
 *
 * These go on the instance directly rather than through a plugin. A registered
 * plugin gets its own scope, so its hooks would not apply to routes registered
 * beside it, which would silently disable authentication. Call this before
 * registering routes.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorateRequest('request_id', undefined);

  // The id a caller is given, the id in the log and the id on the stored
  // routing decision are the same id. Two of them would make a report
  // impossible to follow up.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.request_id) req.request_id = String(req.id);
    reply.header('x-request-id', req.request_id);
  });

  /**
   * onRequest, not preHandler: the body is parsed between the two, so a
   * preHandler guard lets an unauthenticated caller spend the server's JSON
   * parser first and answers a bodyless DELETE with the parser's 400 instead
   * of the 401 the reference documents. Nothing below reads the body, so
   * there is nothing to wait for.
   */
  app.addHook('onRequest', async (req, reply) => {
    if (!req.request_id) req.request_id = String(req.id);

    const path = req.routeOptions.url ?? req.url.split('?')[0];
    if (PUBLIC_PATHS.has(path) || (!path.startsWith('/v1/') && !path.startsWith('/admin/'))) return;

    const provided = presentedKey(req);
    const administrator = !!provided && isAdministratorKey(provided);
    if (path.startsWith('/admin/')) {
      const rate = await checkRateLimit({ key: `admin:${req.ip}`, limit: 60, windowSeconds: 60 });
      if (!rate.ok) return errorReply(reply, 'rate_limited', 'Too many settings requests. Try again in a minute.', 429, req.request_id);
      if (!administrator) return errorReply(reply, 'admin_required', 'Unlock Settings with the administrator key from npm run admin:key.', 401, req.request_id);
      return;
    }

    const expected = getConfiguredApiKey();
    if (authRequired()) {
      const legacy = !!provided && !!expected && keysMatch(provided, expected);
      const integration = !!provided && acceptsIntegrationKey(hashIntegrationKey(provided));
      if (!administrator && !legacy && !integration) {
        // Guessing a key should run out of attempts, and it must not be able to
        // spend the shared budget that a working client needs.
        const strikes = await checkRateLimit({ key: `auth-fail:${req.ip}`, limit: 60, windowSeconds: 60 });
        if (!strikes.ok) return errorReply(reply, 'rate_limited', 'Too many failed key attempts. Try again in a minute.', 429, req.request_id);
        return errorReply(reply, 'invalid_api_key', 'Missing or invalid API key', 401, req.request_id);
      }
      const integrationPaths = new Set(['/v1/chat/completions', '/v1/chat', '/v1/agent-step', '/v1/models']);
      if (integration && !administrator && !legacy && !integrationPaths.has(path)) return errorReply(reply, 'forbidden', 'Router keys can run completions and list models. Use the administrator key for the dashboard.', 403, req.request_id);
    }

    // One process, one counter. There is nothing to coordinate across
    // instances, so the limit lives in memory.
    const limit = Number(process.env.RATE_LIMIT_MAX ?? '100');
    const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SEC ?? '60');
    const rate = await checkRateLimit({ key: 'local', limit, windowSeconds });

    if (rate.remaining !== null) {
      reply.header('x-ratelimit-limit', limit);
      reply.header('x-ratelimit-remaining', rate.remaining);
      reply.header('x-ratelimit-reset', rate.resetSeconds ?? windowSeconds);
    }
    if (!rate.ok) {
      return errorReply(reply, 'rate_limited', 'Rate limit exceeded', 429, req.request_id);
    }
  });
}
