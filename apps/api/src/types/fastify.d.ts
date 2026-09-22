import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation id attached to every request and echoed in responses. */
    request_id?: string;
  }
}
