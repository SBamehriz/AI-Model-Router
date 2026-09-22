import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { listRecentRequests } from '../lib/db/requests.js';
import { RecentRequestsQuerySchema } from '../lib/schemas.js';
import { describeValidationFailure } from '../lib/schemas.js';

/**
 * GET /v1/requests. The request log, each row joined to the decision that
 * produced it: candidates, weights, constraints and reason.
 */
export const requestsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/requests', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = RecentRequestsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'validation_error', ...describeValidationFailure(parsed.error.issues) },
        request_id: req.request_id,
      });
    }

    try {
      const rows = listRecentRequests(parsed.data.limit);
      return reply.send({
        requests: rows.map((r) => ({
          id: r.id,
          source: r.source,
          created_at: new Date(r.created_at).toISOString(),
          endpoint: r.endpoint,
          task_type: r.task_type,
          complexity: r.complexity,
          priority: r.priority,
          provider: r.provider,
          model_used: r.model_used,
          tokens_input: r.tokens_input,
          tokens_output: r.tokens_output,
          cost: r.cost,
          savings: r.savings,
          latency_ms: r.latency_ms,
          success: r.success,
          fallback_level: r.fallback_level,
          boost: r.boost,
          routing: r.routing,
        })),
        request_id: req.request_id,
      });
    } catch (err) {
      req.log?.warn({ err }, 'Recent requests query failed');
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'Failed to fetch requests' },
        request_id: req.request_id,
      });
    }
  });
}
