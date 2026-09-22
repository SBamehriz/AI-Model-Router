import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { listModels } from '../lib/db/models.js';
import { observedLatencyByModel } from '../lib/db/requests.js';
import { catalogStatus } from '../lib/modelCatalog.js';
import { configuredProviders, isOfflineMode } from '../lib/providerAvailability.js';
import { ROUTER_MODELS } from './completions.js';
import { ModelsQuerySchema } from '../lib/schemas.js';
import { describeValidationFailure } from '../lib/schemas.js';

const OBSERVED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /v1/models. The routable catalog, plus the latency this instance has
 * actually measured, so a baseline can be compared with reality.
 */
export const modelsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/models',
    async (req: FastifyRequest<{ Querystring: { provider?: string } }>, reply: FastifyReply) => {
      // A type annotation is not a runtime check. A repeated query key
      // arrives as an array, and an array reaching a SQLite binding would be a
      // 500 dressed up as a server fault.
      const query = ModelsQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.status(400).send({
          error: { code: 'validation_error', ...describeValidationFailure(query.error.issues) },
          request_id: req.request_id,
        });
      }

      try {
        const models = listModels(query.data.provider ? { provider: query.data.provider } : {});
        const observed = observedLatencyByModel(Date.now() - OBSERVED_WINDOW_MS);
        const available = new Set(configuredProviders());
        const offline = isOfflineMode();

        return reply.send({
          object: 'list',
          data: ROUTER_MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'ai-model-router' })),
          models: models.map((m) => ({
            ...m,
            last_synced_at: m.last_synced_at ? new Date(m.last_synced_at).toISOString() : null,
            observed_latency_ms: observed.get(m.id) ?? null,
            /** Whether this instance holds a key for the model's provider. */
            provider_configured: offline ? false : available.has(m.provider),
          })),
          catalog: catalogStatus(),
          offline_mode: offline,
          request_id: req.request_id,
        });
      } catch (err) {
        req.log?.warn({ err }, 'Models query failed');
        return reply.status(500).send({
          error: { code: 'internal_error', message: 'Failed to fetch models' },
          request_id: req.request_id,
        });
      }
    }
  );
}
