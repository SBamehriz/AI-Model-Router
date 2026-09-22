import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelRow } from '../router.js';
import {
  __resetProviderHealthForTests,
  adjustScoreForProviderHealth,
  getAllProviderHealth,
  getProviderHealth,
  recordProviderOutcome,
} from '../providerHealth.js';
import { insertProviderAttempt } from '../db/requests.js';

const model: ModelRow = {
  id: 'openai/gpt-4o-mini',
  provider: 'openai',
  model_name: 'gpt-4o-mini',
  cost_input: 0.00015,
  cost_output: 0.0006,
  avg_latency: 400,
  strengths: ['chat'],
};

/** Record `count` attempts at once, optionally back-dated. */
function record(provider: string, count: number, success: boolean, latency: number, ageMs = 0): void {
  for (let i = 0; i < count; i += 1) {
    insertProviderAttempt({
      provider,
      model_name: 'test-model',
      success,
      latency_ms: latency,
      created_at: Date.now() - ageMs,
    });
  }
}

describe('providerHealth', () => {
  beforeEach(() => {
    __resetProviderHealthForTests();
  });

  it('records outcomes and computes health metrics', async () => {
    await recordProviderOutcome('openai', true, 120);
    await recordProviderOutcome('openai', false, 300);
    await recordProviderOutcome('openai', true, 180);

    const health = await getProviderHealth('openai');

    expect(health.provider).toBe('openai');
    expect(health.attempts).toBe(3);
    expect(health.successRate).toBeCloseTo(2 / 3, 5);
    expect(health.avgLatency).toBe(200);
    expect(health.failureCount).toBe(1);
    expect(health.lastFailure).toBeInstanceOf(Date);
  });

  it('reports a healthy default for a provider with no traffic', async () => {
    const health = await getProviderHealth('groq');

    expect(health.attempts).toBe(0);
    expect(health.successRate).toBe(1);
    expect(health.failureCount).toBe(0);
  });

  it('ignores attempts older than the one-hour window', async () => {
    record('anthropic', 5, false, 900, 2 * 60 * 60 * 1000);
    __resetProviderHealthForTests();

    const health = await getProviderHealth('anthropic');
    expect(health.attempts).toBe(0);
  });

  it('summarises every provider seen in the window', async () => {
    record('openai', 4, true, 200);
    record('groq', 2, false, 700);
    __resetProviderHealthForTests();

    const all = await getAllProviderHealth();
    const providers = all.map((h) => h.provider).sort();

    expect(providers).toEqual(['groq', 'openai']);
    expect(all.find((h) => h.provider === 'groq')?.successRate).toBe(0);
  });

  it('penalises a provider with a poor success rate', async () => {
    record('openai', 3, true, 300);
    record('openai', 7, false, 300);
    __resetProviderHealthForTests();

    const adjusted = await adjustScoreForProviderHealth(model, 0.8);
    expect(adjusted).toBeLessThan(0.8);
  });

  it('penalises a provider much slower than the catalog baseline', async () => {
    record('openai', 10, true, model.avg_latency * 4);
    __resetProviderHealthForTests();

    const adjusted = await adjustScoreForProviderHealth(model, 0.8);
    expect(adjusted).toBeLessThan(0.8);
  });

  it('leaves scores untouched for a healthy provider', async () => {
    record('openai', 10, true, 300);
    __resetProviderHealthForTests();

    expect(await adjustScoreForProviderHealth(model, 0.8)).toBe(0.8);
  });

  it('does not penalise on a tiny sample', async () => {
    record('openai', 1, true, 5000);
    __resetProviderHealthForTests();

    expect(await adjustScoreForProviderHealth(model, 0.8)).toBe(0.8);
  });
});
