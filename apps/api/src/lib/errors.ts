import type { FastifyInstance } from 'fastify';
import { isDashboardPagePath } from './dashboard.js';

/** Keep parser errors as 4xx, while keeping server details out of responses. */
export function registerErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    const clientError = status >= 400 && status < 500;
    if (!clientError) req.log.error({ err: error, request_id: req.request_id }, 'unhandled error');
    // A rejection should say what was wrong. Fastify tells us which parser
    // step failed; the caller was getting "Invalid request" for all of them,
    // which is the one sentence every other rejection here was rewritten to
    // avoid. These are not schema failures, so there is no field to name, but
    // there is still a cause.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const message =
      status === 413 ? 'Request body is too large'
        : status === 415 ? 'Use Content-Type: application/json'
          : code === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 'Request body is not valid JSON'
            : code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'Request body is empty. Send a JSON object'
              : code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ? 'Request body did not match its Content-Length'
                : 'Invalid request';
    return reply.status(clientError ? status : 500).send({
      error: { code: clientError ? 'invalid_request' : 'internal_error', message: clientError ? message : 'Internal server error' },
      request_id: req.request_id ?? req.id,
    });
  });

  /**
   * An unmatched path is either a dashboard page or a miss. When the interface
   * is built into this server, page paths get the shell. API paths, assets and
   * dotfiles stay machine readable.
   */
  app.setNotFoundHandler((req, reply) => {
    const servesDashboard = typeof (reply as { sendFile?: unknown }).sendFile === 'function';
    if (req.method === 'GET' && servesDashboard && isDashboardPagePath(req.url.split('?')[0])) {
      return reply.header('Cache-Control', 'no-store').sendFile('index.html', { cacheControl: false });
    }
    return reply.status(404).send({
      error: { code: 'not_found', message: 'Endpoint not found' },
      request_id: req.request_id ?? req.id,
    });
  });
}
