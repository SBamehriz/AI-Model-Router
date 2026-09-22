import { providerCredentialStatus } from '../lib/credentials.js';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getAllProviderHealth } from '../lib/providerHealth.js';
import { configuredProviders, isOfflineMode } from '../lib/providerAvailability.js';

/**
 * GET /v1/providers. Which providers this instance can reach, and how they have
 * behaved over the last hour, counting the attempts that failed and fell back.
 */
export const providersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/providers', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const health = await getAllProviderHealth();
      const configured = new Set(configuredProviders());
      const byProvider = new Map(health.map((h) => [h.provider, h]));

      return reply.send({
        offline_mode: isOfflineMode(),
        providers: providerCredentialStatus().map(({ provider }) => {
          const stats = byProvider.get(provider);
          return {
            provider,
            configured: configured.has(provider),
            attempts: stats?.attempts ?? 0,
            success_rate: stats?.successRate ?? null,
            avg_latency_ms: stats?.avgLatency ?? null,
            failures: stats?.failureCount ?? 0,
            last_failure_at: stats?.lastFailure?.toISOString() ?? null,
          };
        }),
        request_id: req.request_id,
      });
    } catch (err) {
      req.log?.warn({ err }, 'Provider health query failed');
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'Failed to fetch provider health' },
        request_id: req.request_id,
      });
    }
  });
}
