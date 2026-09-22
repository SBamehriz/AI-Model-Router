import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrors } from '../errors.js';

describe('HTTP error envelopes', () => {
  it('preserves parser status codes and gives each response a request ID', async () => {
    const app = Fastify({ logger: false, bodyLimit: 64 });
    registerErrors(app);
    app.post('/body', async (req) => req.body);
    try {
      for (const [body, contentType, status] of [['{', 'application/json', 400], ['x'.repeat(100), 'application/json', 413], ['hello', 'application/xml', 415]] as const) {
        const result = await app.inject({ method: 'POST', url: '/body', headers: { 'content-type': contentType }, payload: body });
        expect(result.statusCode).toBe(status);
        expect(result.json().error.code).toBe('invalid_request');
        expect(result.json().request_id).toBeTruthy();
      }
      const missing = await app.inject('/missing');
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('not_found');
    } finally { await app.close(); }
  });

  /**
   * A parser failure has no field to name, but it has a cause, and "Invalid
   * request" is the one sentence every other rejection here was rewritten to
   * stop saying.
   */
  it('says which parser step failed rather than only that one did', async () => {
    const app = Fastify({ logger: false, bodyLimit: 64 });
    registerErrors(app);
    app.post('/body', async (req) => req.body);
    try {
      const cases: Array<[string, string, string]> = [
        ['{', 'application/json', 'not valid JSON'],
        ['', 'application/json', 'is empty'],
        ['x'.repeat(100), 'application/json', 'too large'],
        ['hello', 'application/xml', 'Content-Type: application/json'],
      ];
      for (const [body, contentType, names] of cases) {
        const result = await app.inject({ method: 'POST', url: '/body', headers: { 'content-type': contentType }, payload: body });
        expect(result.json().error.message, `${JSON.stringify(body.slice(0, 8))} as ${contentType}`).toContain(names);
        expect(result.json().error.message).not.toBe('Invalid request');
      }
    } finally { await app.close(); }
  });

  it('does not leak internal exceptions', async () => {
    const app = Fastify({ logger: false });
    registerErrors(app);
    app.get('/broken', async () => { throw new Error('private_database_path'); });
    try {
      const response = await app.inject('/broken');
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toEqual({ code: 'internal_error', message: 'Internal server error' });
      expect(response.body).not.toContain('private_database_path');
    } finally { await app.close(); }
  });
});
