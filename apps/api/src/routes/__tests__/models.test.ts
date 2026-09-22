import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../__tests__/helpers/testApp.js';
import { getDb } from '../../lib/db/index.js';

/**
 * The model list is what a client reads before it sends anything, so the
 * fields it uses to decide have to mean what they say.
 */
describe('model discovery', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const list = async (url = '/v1/models') => (await app.inject({ method: 'GET', url })).json();

  it('offers the router aliases alongside the catalog', async () => {
    const body = await list();

    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id)).toContain('auto');
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.request_id).toBeTruthy();
  });

  it('reports no configured provider while completions are simulated', async () => {
    const body = await list();

    expect(body.offline_mode).toBe(true);
    expect(body.models.every((m: { provider_configured: boolean }) => m.provider_configured === false)).toBe(true);
  });

  it('reports a configured provider once a key is present and simulation is off', async () => {
    process.env.AI_MODEL_ROUTER_OFFLINE = '0';
    process.env.OPENAI_API_KEY = 'sk-test-models-route';
    try {
      const body = await list();

      expect(body.offline_mode).toBe(false);
      const openai = body.models.filter((m: { provider: string }) => m.provider === 'openai');
      expect(openai.length).toBeGreaterThan(0);
      expect(openai.every((m: { provider_configured: boolean }) => m.provider_configured)).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
      process.env.AI_MODEL_ROUTER_OFFLINE = '1';
    }
  });

  it('leaves the sync time null until the catalog has been refreshed', async () => {
    const body = await list();

    expect(body.models.every((m: { last_synced_at: string | null }) => m.last_synced_at === null)).toBe(true);
  });

  it('returns the sync time as an ISO string once one is recorded', async () => {
    const at = Date.UTC(2026, 8, 18, 12, 0, 0);
    getDb().prepare('UPDATE models SET last_synced_at = ?').run(at);

    const body = await list();

    expect(body.models[0].last_synced_at).toBe(new Date(at).toISOString());
  });

  it('filters to one provider, and rejects a repeated filter', async () => {
    const filtered = await list('/v1/models?provider=openai');
    expect(filtered.models.every((m: { provider: string }) => m.provider === 'openai')).toBe(true);
    expect(filtered.models.length).toBeGreaterThan(0);

    const repeated = await app.inject({ method: 'GET', url: '/v1/models?provider=openai&provider=groq' });
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json().error.code).toBe('validation_error');
  });
});
