import type { FastifyPluginAsync } from 'fastify';
import { authRequired } from '../lib/auth.js';
import { countRequests } from '../lib/db/requests.js';
import { catalogStatus } from '../lib/modelCatalog.js';
import { configuredProviders, isOfflineMode } from '../lib/providerAvailability.js';

/**
 * GET /health and GET /ready. Both are public by path, so where they are
 * registered relative to the authentication hook does not change who can
 * reach them. They lived inline in the entry point, which kept them out of
 * the one test that walks every registered route and asks whether it has a
 * rejection case; a plugin is what every other handler is, and it is what
 * that test can see.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  /** Liveness, and how this instance is configured. */
  app.get('/health', async () => ({
    status: 'ok',
    offline_mode: isOfflineMode(),
    providers: configuredProviders(),
    auth_required: authRequired(),
    catalog: catalogStatus(),
  }));

  /** Readiness. The database has to answer. */
  app.get('/ready', async (_req, reply) => {
    try {
      countRequests();
      return reply.send({ status: 'ok' });
    } catch {
      return reply.status(503).send({ status: 'degraded', message: 'Database unavailable' });
    }
  });
};
