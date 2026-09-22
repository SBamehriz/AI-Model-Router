import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { chatRoutes } from '../../routes/chat.js';
import { usageRoutes } from '../../routes/usage.js';
import { modelsRoutes } from '../../routes/models.js';
import { requestsRoutes } from '../../routes/requests.js';
import { providersRoutes } from '../../routes/providers.js';
import { debugRoutes } from '../../routes/debug.js';
import { completionsRoutes } from '../../routes/completions.js';
import { seedCatalogFromConfig } from '../../lib/modelCatalog.js';
import { registerErrors } from '../../lib/errors.js';

/**
 * A server wired exactly like production, on the in-memory database created by
 * vitest.setup.ts. With no provider keys set the offline provider answers, so
 * these tests exercise the whole pipeline deterministically and offline.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  process.env.AI_MODEL_ROUTER_OFFLINE = '1';
  seedCatalogFromConfig();

  const app = Fastify({ logger: false, genReqId: () => randomUUID() });
  registerErrors(app);

  app.addHook('onRequest', async (req) => {
    req.request_id = randomUUID();
  });

  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(usageRoutes, { prefix: '/v1' });
  await app.register(modelsRoutes, { prefix: '/v1' });
  await app.register(requestsRoutes, { prefix: '/v1' });
  await app.register(providersRoutes, { prefix: '/v1' });
  await app.register(debugRoutes, { prefix: '/v1/router' });
  // The compatible endpoint is the one most callers use, so a helper that
  // claims production wiring has to include it.
  await app.register(completionsRoutes, { prefix: '/v1' });

  await app.ready();
  return app;
}
