import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { usageSummary } from '../lib/db/requests.js';
import { UsageQuerySchema } from '../lib/schemas.js';
import { describeValidationFailure } from '../lib/schemas.js';

const MAX_USAGE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** GET /v1/usage. Cost, savings, latency and model mix, aggregated in SQL. */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/usage', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = UsageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'validation_error', ...describeValidationFailure(parsed.error.issues) },
        request_id: req.request_id,
      });
    }

    const from = parsed.data.from ? Date.parse(parsed.data.from) : undefined;
    const to = parsed.data.to ? Date.parse(parsed.data.to) : undefined;

    if (from !== undefined && to !== undefined) {
      const rangeDays = (to - from) / DAY_MS;
      if (rangeDays < 0 || rangeDays > MAX_USAGE_WINDOW_DAYS) {
        return reply.status(400).send({
          error: {
            code: 'validation_error',
            message: `Usage date window must be between 0 and ${MAX_USAGE_WINDOW_DAYS} days`,
          },
          request_id: req.request_id,
        });
      }
    }

    try {
      return reply.send({ ...usageSummary({ from, to }), request_id: req.request_id });
    } catch (err) {
      req.log?.warn({ err }, 'Usage query failed');
      return reply.status(500).send({
        error: { code: 'internal_error', message: 'Failed to fetch usage' },
        request_id: req.request_id,
      });
    }
  });
}
