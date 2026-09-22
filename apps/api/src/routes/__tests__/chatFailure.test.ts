import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

const tryChatWithFallback = vi.fn();
const runBoostPipeline = vi.fn();

vi.mock('../../lib/chatExecution.js', () => ({
  tryChatWithFallback: (...args: unknown[]) => tryChatWithFallback(...args),
}));
vi.mock('../../lib/boostPipeline.js', () => ({
  runBoostPipeline: (...args: unknown[]) => runBoostPipeline(...args),
}));

const { ProviderRefusalError } = await import('../../lib/providerClient.js');
const { chatRoutes } = await import('../chat.js');
const { seedCatalogFromConfig } = await import('../../lib/modelCatalog.js');
const { countRequests, listRecentRequests } = await import('../../lib/db/requests.js');

/**
 * The paths a live provider cannot be relied on to produce: every model
 * failing, and the boost pipeline. Both are scripted here so the route's own
 * behaviour, the status, the envelope and what reaches the request log, is
 * asserted rather than inferred.
 */
describe('chat route failure and boost paths', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    tryChatWithFallback.mockReset();
    runBoostPipeline.mockReset();
    seedCatalogFromConfig();

    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      req.request_id = randomUUID();
    });
    await app.register(chatRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const chat = (payload: object) => app.inject({ method: 'POST', url: '/v1/chat', payload });

  it('answers 502 when every model in the chain fails', async () => {
    tryChatWithFallback.mockResolvedValue(null);

    const response = await chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('provider_error');
    expect(response.json().request_id).toBeTruthy();
  });

  it('reports a refusal as a refusal, not as every provider failing', async () => {
    tryChatWithFallback.mockRejectedValue(
      new ProviderRefusalError('declined', 'openai', 'content_filter')
    );

    const response = await chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('provider_refused');
    expect(response.json().error.reason).toBe('content_filter');
  });

  it('logs a refusal without inventing tokens or cost for it', async () => {
    tryChatWithFallback.mockRejectedValue(new ProviderRefusalError('declined', 'openai', 'refusal'));

    await chat({ messages: [{ role: 'user', content: 'hello' }] });

    const [logged] = listRecentRequests(1);
    expect(logged.success).toBe(false);
    expect(logged.cost).toBe(0);
    expect(logged.tokens_total).toBe(0);
  });

  it('records the failed attempt, with its routing decision, in the log', async () => {
    tryChatWithFallback.mockResolvedValue(null);

    await chat({ messages: [{ role: 'user', content: 'Write a Python quicksort' }] });

    expect(countRequests()).toBe(1);
    const [logged] = listRecentRequests(1);
    expect(logged.success).toBe(false);
    expect(logged.cost).toBe(0);
    expect(logged.task_type).toBe('coding');
    expect(logged.routing?.considered_models.length).toBeGreaterThan(0);
  });

  it('reports the fallback level that answered', async () => {
    tryChatWithFallback.mockResolvedValue({
      content: 'answer',
      inputTokens: 10,
      outputTokens: 20,
      model: 'gpt-4o-mini',
      provider: 'openai',
      modelRow: { id: 'openai/gpt-4o-mini', provider: 'openai', model_name: 'gpt-4o-mini', cost_input: 0.00015, cost_output: 0.0006, avg_latency: 400, strengths: ['chat'] },
      fallbackLevel: 'backup',
    });

    const response = await chat({ messages: [{ role: 'user', content: 'hello' }] });

    expect(response.json().fallback_level).toBe('backup');
    expect(listRecentRequests(1)[0].fallback_level).toBe('backup');
  });

  it('runs the boost pipeline for a complex request and returns its details', async () => {
    runBoostPipeline.mockResolvedValue({
      output: 'synthesised answer',
      total_cost: 0.004,
      inputTokens: 1000,
      outputTokens: 500,
      boost_details: { total_tasks: 3, manager_model: 'anthropic/claude-3-5-sonnet-20241022' },
    });

    const response = await chat({
      messages: [
        {
          role: 'user',
          content:
            'Design a distributed rate limiter, prove it correct under clock skew, and provide ' +
            'production-ready Go with benchmarks, tests and an architecture overview covering ' +
            'every failure mode including partitions and node restarts.',
        },
      ],
      boost: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().model_used).toBe('ai-model-router-ai');
    expect(response.json().boost_details.total_tasks).toBe(3);
    expect(tryChatWithFallback).not.toHaveBeenCalled();

    const [logged] = listRecentRequests(1);
    expect(logged.boost).toBe(true);
    expect(logged.model_used).toBe('ai-model-router-ai');
    expect(logged.tokens_input).toBe(1000);
    expect(logged.tokens_output).toBe(500);
    expect(logged.cost).toBe(0.004);
    expect(logged.savings).toBeGreaterThan(0);
    expect(response.json().savings_estimate).toBeCloseTo(logged.savings, 6);
  });

  it('falls back to normal routing when the boost pipeline throws', async () => {
    runBoostPipeline.mockRejectedValue(new Error('manager unavailable'));
    tryChatWithFallback.mockResolvedValue({
      content: 'plain answer',
      inputTokens: 5,
      outputTokens: 5,
      model: 'gpt-4o-mini',
      provider: 'openai',
      modelRow: { id: 'openai/gpt-4o-mini', provider: 'openai', model_name: 'gpt-4o-mini', cost_input: 0.00015, cost_output: 0.0006, avg_latency: 400, strengths: ['chat'] },
      fallbackLevel: 'primary',
    });

    const response = await chat({
      messages: [
        {
          role: 'user',
          content:
            'Design a distributed consensus protocol with formal proofs, production Go code, ' +
            'benchmarks and a full analysis of every partition and restart failure mode.',
        },
      ],
      boost: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().output).toBe('plain answer');
    expect(response.json().boost_details).toBeUndefined();
  });

  it('skips boost for a request that is not complex enough', async () => {
    tryChatWithFallback.mockResolvedValue({
      content: 'hi',
      inputTokens: 1,
      outputTokens: 1,
      model: 'gpt-4o-mini',
      provider: 'openai',
      modelRow: { id: 'openai/gpt-4o-mini', provider: 'openai', model_name: 'gpt-4o-mini', cost_input: 0.00015, cost_output: 0.0006, avg_latency: 400, strengths: ['chat'] },
      fallbackLevel: 'primary',
    });

    await chat({ messages: [{ role: 'user', content: 'hi' }], boost: true });

    expect(runBoostPipeline).not.toHaveBeenCalled();
    expect(tryChatWithFallback).toHaveBeenCalled();
  });
});
