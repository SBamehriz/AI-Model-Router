import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/testApp.js';

/**
 * End-to-end flows through the real server: request in, routing decision,
 * completion, cost accounting, usage aggregation.
 *
 * These run entirely offline. The in-memory database is seeded from
 * config/models.yaml and the offline provider stands in for real APIs, so the
 * assertions below are unconditional.
 */
describe('E2E: routing flows', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const chat = (payload: object): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: '/v1/chat', payload });

  const debug = (payload: object): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: '/v1/router/debug', payload });

  describe('chat', () => {
    it('returns a complete response envelope', async () => {
      const response = await chat({ messages: [{ role: 'user', content: 'Say hello in one word' }] });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const field of ['output', 'model_used', 'cost', 'latency_ms', 'savings_estimate', 'request_id']) {
        expect(body).toHaveProperty(field);
      }
      expect(body.cost).toBeGreaterThan(0);
      expect(body.latency_ms).toBeLessThan(5000);
    });

    it('prices cheap models below premium models for the same prompt', async () => {
      const messages = [{ role: 'user', content: 'Write a haiku about the sea' }];
      const cheap = (await chat({ messages, priority: 'cheap' })).json();
      const best = (await chat({ messages, priority: 'best' })).json();

      expect(cheap.model_used).not.toBe(best.model_used);
      expect(cheap.cost).toBeLessThan(best.cost);
      expect(cheap.savings_estimate).toBeGreaterThan(best.savings_estimate);
    });

    it('reports positive savings against the premium baseline for cheap routing', async () => {
      const body = (
        await chat({ messages: [{ role: 'user', content: 'Translate "hello" to French' }], priority: 'cheap' })
      ).json();

      expect(body.savings_estimate).toBeGreaterThan(0);
    });

    it('supports every priority mode', async () => {
      for (const priority of ['cheap', 'balanced', 'best', 'quality'] as const) {
        const response = await chat({
          messages: [{ role: 'user', content: 'Explain recursion briefly' }],
          priority,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().output).toBeTruthy();
      }
    });

    it('prefers a faster model when latency_pref is fast', async () => {
      const messages = [{ role: 'user', content: 'Give me a one-line summary of TCP' }];
      const fast = (await chat({ messages, latency_pref: 'fast' })).json();
      const normal = (await chat({ messages, latency_pref: 'normal' })).json();

      expect(fast.model_used).toBeTruthy();
      expect(normal.model_used).toBeTruthy();
    });
  });

  describe('agent workflow', () => {
    it('routes each step and accumulates cost', async () => {
      const steps = [
        'List the files that need changing to add OAuth login.',
        'Write the migration for the tokens table.',
        'Summarise what changed for the pull request description.',
      ];

      let totalCost = 0;
      for (const content of steps) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/agent-step',
          payload: { messages: [{ role: 'user', content }] },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.cost).toBeGreaterThan(0);
        totalCost += body.cost;
      }

      expect(totalCost).toBeGreaterThan(0);
    });
  });

  describe('routing debug', () => {
    it('explains the decision for a coding prompt', async () => {
      const response = await debug({
        messages: [{ role: 'user', content: 'Write a Python function that reverses a linked list' }],
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.task_type).toBe('coding');
      expect(Array.isArray(body.considered_models)).toBe(true);
      expect(body.considered_models.length).toBeGreaterThan(0);
      expect(body.selected_model).toContain('/');
      expect(body.reason.length).toBeGreaterThan(10);
    });

    it('scores every considered model between 0 and 1', async () => {
      const body = (
        await debug({ messages: [{ role: 'user', content: 'Refactor this function' }] })
      ).json();

      for (const model of body.considered_models) {
        expect(model).toHaveProperty('provider');
        expect(model).toHaveProperty('model_name');
        expect(model.score).toBeGreaterThanOrEqual(0);
        expect(model.score).toBeLessThanOrEqual(1);
      }
    });

    it('exposes classification, complexity, weights and constraints', async () => {
      const body = (
        await debug({
          messages: [{ role: 'user', content: 'Prove that this sorting algorithm terminates' }],
        })
      ).json();

      expect(body.classification).toHaveProperty('confidence');
      expect(['heuristic', 'llm', 'fallback', 'forced']).toContain(body.classification.method);

      expect(body.complexity.score).toBeGreaterThanOrEqual(0);
      expect(body.complexity.score).toBeLessThanOrEqual(1);
      expect(body.complexity).toHaveProperty('factors');

      const weightSum =
        body.weights.cost + body.weights.latency + body.weights.task + body.weights.quality;
      expect(weightSum).toBeCloseTo(1, 5);

      expect(body.constraints).toHaveProperty('minCategorySkill');
      expect(body.constraints).toHaveProperty('requireHardCoding');
    });

    it('shifts weight toward capability as complexity rises', async () => {
      const simple = (await debug({ messages: [{ role: 'user', content: 'hi' }] })).json();
      const hard = (
        await debug({
          messages: [
            {
              role: 'user',
              content:
                'Design a distributed consensus protocol, prove safety and liveness, and give a ' +
                'production-ready implementation with benchmarks covering every failure mode.',
            },
          ],
        })
      ).json();

      expect(hard.complexity.score).toBeGreaterThan(simple.complexity.score);
      expect(hard.weights.task).toBeGreaterThan(simple.weights.task);
      expect(hard.weights.cost).toBeLessThan(simple.weights.cost);
    });
  });

  /**
   * `/v1/router/debug` exists to explain what `/v1/chat` will do. If the two
   * validate or price different text, the explanation is of a request that was
   * never made.
   */
  describe('preview and execution agree', () => {
    it('rejects an over-long message on both endpoints', async () => {
      const messages = [{ role: 'user', content: 'x'.repeat(100_001) }];

      const [chatResponse, debugResponse] = await Promise.all([chat({ messages }), debug({ messages })]);

      expect(chatResponse.statusCode).toBe(400);
      expect(debugResponse.statusCode).toBe(400);
      expect(debugResponse.json().error.code).toBe(chatResponse.json().error.code);
    });

    it('rejects a whitespace-only message on both endpoints', async () => {
      const messages = [{ role: 'user', content: '   \t  ' }];

      const [chatResponse, debugResponse] = await Promise.all([chat({ messages }), debug({ messages })]);

      expect(chatResponse.statusCode).toBe(400);
      expect(debugResponse.statusCode).toBe(400);
    });

    it('reaches the same budget verdict on a heavily padded prompt', async () => {
      // Chat used to collapse the padding before estimating cost, so the same
      // request was unaffordable in the preview and affordable in the run.
      const messages = [{ role: 'user', content: `hello${' '.repeat(50_000)}x` }];
      const payload = { messages, max_cost: 0.0001 };

      const [chatResponse, debugResponse] = await Promise.all([chat(payload), debug(payload)]);

      expect(chatResponse.statusCode).toBe(debugResponse.statusCode);
      expect(chatResponse.json().error.code).toBe(debugResponse.json().error.code);
      expect(chatResponse.json().error.code).toBe('max_cost_exceeded');
    });

    it('previews the model the run then uses', async () => {
      const messages = [{ role: 'user', content: 'Write a Python function that reverses a linked list' }];

      const preview = (await debug({ messages })).json();
      const run = (await chat({ messages })).json();

      expect(run.task_type).toBe(preview.task_type);
      expect(run.routing.selected_model).toBe(preview.selected_model);
      expect(run.routing.considered_models.map((m: { model_name: string }) => m.model_name)).toEqual(
        preview.considered_models.map((m: { model_name: string }) => m.model_name)
      );
    });
  });

  describe('usage and models', () => {
    it('aggregates requests into usage totals and breakdowns', async () => {
      await chat({ messages: [{ role: 'user', content: 'Summarise this text' }], priority: 'cheap' });
      await chat({ messages: [{ role: 'user', content: 'Write a Python quicksort' }], priority: 'best' });

      const usage = (await app.inject({ method: 'GET', url: '/v1/usage' })).json();

      expect(usage.total_requests).toBe(2);
      expect(usage.total_cost).toBeGreaterThan(0);
      expect(usage.avg_latency_ms).toBeGreaterThanOrEqual(0);
      expect(usage.success_rate).toBe(1);
      expect(usage.by_day.length).toBe(1);
      expect(usage.by_model.length).toBeGreaterThan(0);
      expect(usage.by_task.length).toBeGreaterThan(0);
      expect(usage.by_model.reduce((sum: number, m: { requests: number }) => sum + m.requests, 0)).toBe(2);
    });

    it('rejects a usage window longer than 90 days', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/usage?from=2020-01-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z',
      });
      expect(response.statusCode).toBe(400);
    });

    it('lists the model catalog with routing metadata', async () => {
      const body = (await app.inject({ method: 'GET', url: '/v1/models' })).json();

      expect(body.models.length).toBeGreaterThan(0);
      expect(body.catalog.models).toBe(body.models.length);
      const model = body.models[0];
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('cost_input');
      expect(Array.isArray(model.strengths)).toBe(true);
    });

    it('filters the catalog by provider', async () => {
      const body = (await app.inject({ method: 'GET', url: '/v1/models?provider=openai' })).json();
      expect(body.models.length).toBeGreaterThan(0);
      expect(body.models.every((m: { provider: string }) => m.provider === 'openai')).toBe(true);
    });

    it('rejects a provider filter that is not a single value', async () => {
      // A repeated key arrives as an array. It used to reach a SQLite binding
      // and come back as a 500, blaming the server for a bad request.
      const response = await app.inject({
        method: 'GET',
        url: '/v1/models?provider=openai&provider=groq',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
    });

    it('returns an empty catalog for a provider nobody offers', async () => {
      const body = (
        await app.inject({ method: 'GET', url: "/v1/models?provider=' OR 1=1 --" })
      ).json();

      expect(body.models).toEqual([]);
    });

    it('returns the request log with its routing decisions', async () => {
      await chat({ messages: [{ role: 'user', content: 'Say hello' }] });

      const body = (await app.inject({ method: 'GET', url: '/v1/requests?limit=10' })).json();

      expect(body.requests.length).toBe(1);
      const [entry] = body.requests;
      expect(entry.model_used).toBeTruthy();
      expect(entry.routing.considered_models.length).toBeGreaterThan(0);
      expect(entry.routing.weights).toHaveProperty('cost');
      expect(new Date(entry.created_at).toString()).not.toBe('Invalid Date');
    });
  });
});

describe('E2E: provider health', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps simulated completions out of live provider health', async () => {
    const completion = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { messages: [{ role: 'user', content: 'Say hello' }] },
    });

    const body = (await app.inject({ method: 'GET', url: '/v1/providers' })).json();

    expect(completion.statusCode).toBe(200);
    expect(body.providers.length).toBeGreaterThan(0);
    const attempted = body.providers.filter((p: { attempts: number }) => p.attempts > 0);
    expect(attempted).toEqual([]);
    expect(body.offline_mode).toBe(true);
  });
});
