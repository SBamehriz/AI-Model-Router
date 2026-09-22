import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../../__tests__/helpers/testApp.js';
import { countRequests, listRecentRequests } from '../../lib/db/requests.js';
import { getDb } from '../../lib/db/index.js';
import { invalidateModelCache } from '../../lib/router.js';

/**
 * Integration tests for the chat endpoints: validation, the full routing
 * pipeline, and the request log written as a side effect. Nothing reaches the network: with no
 * provider keys configured the offline provider answers.
 */
describe('POST /v1/chat', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (payload: object, url = '/v1/chat'): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url, payload });

  describe('validation', () => {
    it('rejects a non-array messages field', async () => {
      const response = await post({ messages: 'invalid' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
    });

    it('rejects an empty messages array', async () => {
      const response = await post({ messages: [] });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
    });

    it('rejects an unknown priority', async () => {
      const response = await post({
        messages: [{ role: 'user', content: 'Hello' }],
        priority: 'super-fast',
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown message role', async () => {
      const response = await post({ messages: [{ role: 'invalid', content: 'Hello' }] });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a negative max_cost', async () => {
      const response = await post({
        messages: [{ role: 'user', content: 'Hello' }],
        max_cost: -1,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a message with nothing in it but whitespace', async () => {
      // This used to be answered: the prompt reached the provider empty and the
      // simulated completion reported `Prompt received: ""` as a success.
      for (const content of [' \t\n ', '\u0000\u0007']) {
        const response = await post({ messages: [{ role: 'user', content }] });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('validation_error');
      }
      expect(countRequests()).toBe(0);
    });

    it('rejects a whitespace-only message on /v1/agent-step too', async () => {
      const response = await post({ messages: [{ role: 'user', content: '   ' }] }, '/v1/agent-step');

      expect(response.statusCode).toBe(400);
      expect(countRequests()).toBe(0);
    });

    it('rejects a message past the length cap', async () => {
      const response = await post({ messages: [{ role: 'user', content: 'x'.repeat(100_001) }] });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('validation_error');
    });
  });

  describe('context capacity', () => {
    it('says so when the conversation is larger than every available window', async () => {
      // Shrink the catalog rather than sending megabytes: the routing decision
      // is the same one a genuinely long conversation would provoke.
      getDb().prepare('UPDATE models SET max_tokens = 8').run();
      invalidateModelCache();

      const response = await post({
        messages: [{ role: 'user', content: 'Summarise this. '.repeat(500) }],
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('context_length_exceeded');
      expect(response.json().error.message).toMatch(/context window of 8 tokens/);
      invalidateModelCache();
    });
  });

  describe('routing', () => {
    it('answers with a routed completion and cost accounting', async () => {
      const response = await post({ messages: [{ role: 'user', content: 'Say hello' }] });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.output).toBe('string');
      expect(body.output.length).toBeGreaterThan(0);
      expect(typeof body.model_used).toBe('string');
      expect(body.cost).toBeGreaterThan(0);
      expect(typeof body.savings_estimate).toBe('number');
      expect(body.latency_ms).toBeGreaterThanOrEqual(0);
      expect(body.request_id).toBeTruthy();
      expect(body.task_type).toBeTruthy();
    });

    it('honours all optional fields', async () => {
      const response = await post({
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' },
        ],
        priority: 'balanced',
        latency_pref: 'fast',
        max_cost: 0.5,
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns max_cost_exceeded when no model fits the budget', async () => {
      const response = await post({
        messages: [{ role: 'user', content: 'Hello' }],
        max_cost: 0.0000000001,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('max_cost_exceeded');
    });

    it('routes a cheap-priority request to an inexpensive model', async () => {
      const response = await post({
        messages: [{ role: 'user', content: 'Say hi' }],
        priority: 'cheap',
      });

      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(['gemini-1.5-flash', 'meta-llama/llama-3.1-8b-instruct', 'gpt-4o-mini']).toContain(
        body.model_used
      );
    });

    it('routes a hard coding request to a high-quality model', async () => {
      const response = await post({
        messages: [
          {
            role: 'user',
            content:
              'Implement a distributed rate limiter in Go with a formal proof of correctness. ' +
              'It must be concurrent, production ready, and handle every edge case: clock skew, ' +
              'partitions and node restarts. Include benchmarks and an architecture overview.',
          },
        ],
        priority: 'best',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Weak models are excluded by the hard constraints for complex coding.
      expect(['gpt-4o-mini', 'gemini-1.5-flash', 'meta-llama/llama-3.1-8b-instruct']).not.toContain(
        body.model_used
      );
    });
  });

  describe('request logging', () => {
    it('records the request and its routing decision', async () => {
      expect(countRequests()).toBe(0);

      const response = await post({ messages: [{ role: 'user', content: 'Summarise this paragraph.' }] });

      expect(countRequests()).toBe(1);
      const [logged] = listRecentRequests(1);
      expect(logged.endpoint).toBe('/v1/chat');
      expect(logged.id).toBe(response.json().request_id);
      expect(logged.source).toBe('offline');
      expect(response.json().routing.request_id).toBe(logged.id);
      expect(response.json().routing.selected_model).toBe(logged.routing?.final_model);
      expect(response.json().routing.considered_models).toEqual(logged.routing?.considered_models);
      expect(logged.success).toBe(true);
      expect(logged.tokens_total).toBeGreaterThan(0);
      expect(logged.routing?.considered_models.length).toBeGreaterThan(0);
      expect(logged.routing?.final_model).toContain('/');
    });

    it('does not log requests rejected by validation', async () => {
      await post({ messages: [] });
      expect(countRequests()).toBe(0);
    });

    it('prices the prompt the caller actually sent, indentation included', async () => {
      // Collapsing runs of spaces made the router estimate, price and send a
      // different prompt than the one it was given.
      const padded = `def example():\n${' '.repeat(2000)}return 1`;

      const response = await post({ messages: [{ role: 'user', content: padded }] });

      expect(response.statusCode).toBe(200);
      const [logged] = listRecentRequests(1);
      expect(logged.tokens_input).toBeGreaterThanOrEqual(Math.floor(padded.length / 4));
    });
  });
});

describe('POST /v1/agent-step', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('validates its body like /v1/chat', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent-step',
      payload: { messages: 'nope' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('classifies the step as agent_step and logs the endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent-step',
      payload: { messages: [{ role: 'user', content: 'Fetch the user record for id 42.' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task_type).toBe('agent_step');

    const [logged] = listRecentRequests(1);
    expect(logged.endpoint).toBe('/v1/agent-step');
    expect(logged.task_type).toBe('agent_step');
  });
});
