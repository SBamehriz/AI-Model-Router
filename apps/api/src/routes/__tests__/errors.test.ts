import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../../__tests__/helpers/testApp.js';
import { getDb } from '../../lib/db/index.js';

/**
 * Degraded paths: bad input and a database that has gone away. Every endpoint
 * must answer with the documented error envelope rather than a stack trace.
 */
describe('error handling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (url: string): Promise<LightMyRequestResponse> => app.inject({ method: 'GET', url });

  describe('query validation', () => {
    it('rejects a malformed usage window', async () => {
      const response = await get('/v1/usage?from=yesterday');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
      expect(response.json().error.details[0].path).toBe('from');
    });

    it('rejects a reversed usage window', async () => {
      const response = await get(
        '/v1/usage?from=2026-09-10T00:00:00.000Z&to=2026-09-01T00:00:00.000Z'
      );
      expect(response.statusCode).toBe(400);
    });

    it('rejects an out-of-range request-log limit', async () => {
      expect((await get('/v1/requests?limit=0')).statusCode).toBe(400);
      expect((await get('/v1/requests?limit=9999')).statusCode).toBe(400);
      expect((await get('/v1/requests?limit=abc')).statusCode).toBe(400);
    });

    it('rejects a debug request with no messages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/router/debug',
        payload: { messages: [] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
    });

    it('reports max_cost_exceeded when nothing fits the budget', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/router/debug',
        payload: { messages: [{ role: 'user', content: 'hi' }], max_cost: 1e-12 },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('max_cost_exceeded');
    });
  });

  describe('when the database is broken', () => {
    beforeEach(() => {
      // A database that is present but unusable, which is the closest
      // reproducible stand-in for a corrupted or externally-modified file.
      getDb().exec('DROP TABLE requests');
      getDb().exec('DROP TABLE models');
      getDb().exec('DROP TABLE provider_attempts');
    });

    it('returns a 500 envelope from /v1/usage without leaking internals', async () => {
      const response = await get('/v1/usage');
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('internal_error');
      expect(response.json().error.message).toBe('Failed to fetch usage');
      expect(JSON.stringify(response.json())).not.toMatch(/sqlite|SQL|table/i);
    });

    it('returns a 500 envelope from /v1/models', async () => {
      const response = await get('/v1/models');
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('internal_error');
    });

    it('returns a 500 envelope from /v1/requests', async () => {
      const response = await get('/v1/requests');
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('internal_error');
    });

    it('still answers /v1/providers, reporting health as unknown', async () => {
      const response = await get('/v1/providers');
      expect(response.statusCode).toBe(200);
      expect(response.json().providers.every((p: { attempts: number }) => p.attempts === 0)).toBe(true);
    });
  });

  describe('validation messages', () => {
    // Two routes were taught to name the failing field while three query
    // routes went on answering "Invalid query parameters". They share one
    // definition now, so the next route cannot drift back on its own.
    it.each([
      ['/v1/usage?from=nope', 'from'],
      ['/v1/requests?limit=0', 'limit'],
      ['/v1/models?provider=', 'provider'],
    ])('names the failing field for %s', async (url, field) => {
      const response = await get(url);
      expect(response.statusCode).toBe(400);
      const error = response.json().error;
      expect(error.code).toBe('validation_error');
      expect(error.message).toContain(field);
      expect(error.message).not.toBe('Invalid query parameters');
      expect(error.details?.[0].path).toBe(field);
    });
  });

  describe('request identifiers', () => {
    it('echoes a request_id on both success and failure', async () => {
      expect((await get('/v1/usage')).json().request_id).toBeTruthy();
      expect((await get('/v1/usage?from=nope')).json().request_id).toBeTruthy();
    });
  });
});
