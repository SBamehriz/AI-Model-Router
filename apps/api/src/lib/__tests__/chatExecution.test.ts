import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChatMessage } from '../messages.js';
import type { ModelRow } from '../router.js';
import { ProviderError } from '../providerClient.js';
import { MAX_MODELS_ATTEMPTED } from '../fallback.js';

const chatWithProvider = vi.fn();
vi.mock('../providers.js', () => ({
  chatWithProvider: (...args: unknown[]) => chatWithProvider(...args),
  premiumEstimate: () => 0.003,
}));

const { tryChatWithFallback } = await import('../chatExecution.js');
const { providerAttemptStats } = await import('../db/requests.js');

/**
 * The fallback chain is the reliability story: these drive it end to end with a
 * scripted provider, asserting which model answered, at which level, and that
 * every attempt is recorded for provider health, including the failures.
 */
const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function model(id: string, overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id,
    provider: id.split('/')[0],
    model_name: id.split('/')[1],
    cost_input: 0.001,
    cost_output: 0.002,
    avg_latency: 500,
    strengths: ['chat', 'coding'],
    quality_rating: 80,
    ...overrides,
  };
}

const completion = (model: string) => ({
  content: `answer from ${model}`,
  inputTokens: 10,
  outputTokens: 20,
  model,
});

const candidates = [
  model('openai/gpt-4o', { quality_rating: 90, avg_latency: 800 }),
  model('anthropic/claude-3-5-sonnet', { quality_rating: 88, avg_latency: 600 }),
  model('groq/llama-3.3-70b', { quality_rating: 76, avg_latency: 180, cost_input: 0.0001, cost_output: 0.0002 }),
];

describe('tryChatWithFallback', () => {
  beforeEach(() => {
    chatWithProvider.mockReset();
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does not treat an offline completion as a live provider observation', async () => {
    vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '1');
    chatWithProvider.mockResolvedValueOnce(completion('gpt-4o'));
    expect((await tryChatWithFallback(candidates, messages, 'chat'))?.fallbackLevel).toBe('primary');
    expect(providerAttemptStats(0)).toEqual([]);
  });

  it('returns null when there is nothing to try', async () => {
    expect(await tryChatWithFallback([], messages, 'chat')).toBeNull();
    expect(chatWithProvider).not.toHaveBeenCalled();
  });

  it('stops after a bounded number of models rather than the whole catalog', async () => {
    // Selection returns every eligible model, so without a cap the worst case
    // grows with the catalog: 23 candidates is about 50 minutes of deadlines.
    const many = Array.from({ length: 15 }, (_, i) =>
      model(`p${i}/model-${i}`, { quality_rating: 90 - i, avg_latency: 200 + i * 10 }));
    chatWithProvider.mockRejectedValue(new ProviderError('503', 'openai', 503, true));

    const result = await tryChatWithFallback(many, messages, 'chat');

    expect(result).toBeNull();
    expect(chatWithProvider.mock.calls.length).toBeLessThanOrEqual(MAX_MODELS_ATTEMPTED);
  });

  it('buys nothing once the caller has already gone', async () => {
    expect(await tryChatWithFallback(candidates, messages, 'chat', undefined, AbortSignal.abort())).toBeNull();
    expect(chatWithProvider).not.toHaveBeenCalled();
  });

  it('stops walking the candidates when the caller goes mid request', async () => {
    const controller = new AbortController();
    // The primary fails, and the connection drops while that call is in flight.
    chatWithProvider.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new ProviderError('503', 'openai', 503, true));
    });

    const result = await tryChatWithFallback(candidates, messages, 'chat', undefined, controller.signal);

    expect(result).toBeNull();
    // The primary was paid for. The backup and emergency were not.
    expect(chatWithProvider).toHaveBeenCalledTimes(1);
  });

  it('uses the primary model when it succeeds', async () => {
    chatWithProvider.mockResolvedValueOnce(completion('gpt-4o'));

    const result = await tryChatWithFallback(candidates, messages, 'chat');

    expect(result?.fallbackLevel).toBe('primary');
    expect(result?.provider).toBe('openai');
    expect(chatWithProvider).toHaveBeenCalledTimes(1);
  });

  it('falls back to the backup when the primary fails', async () => {
    chatWithProvider
      .mockRejectedValueOnce(new ProviderError('503', 'openai', 503, true))
      .mockResolvedValueOnce(completion('claude-3-5-sonnet'));

    const result = await tryChatWithFallback(candidates, messages, 'chat');

    expect(result?.fallbackLevel).toBe('backup');
    expect(result?.content).toContain('claude-3-5-sonnet');
  });

  it('moves to a different provider when the primary is rate limited', async () => {
    chatWithProvider
      .mockRejectedValueOnce(new ProviderError('429 rate limited', 'openai', 429, true))
      .mockResolvedValueOnce(completion('backup'));

    const result = await tryChatWithFallback(candidates, messages, 'chat');

    expect(result?.provider).not.toBe('openai');
  });

  it('reaches the emergency model when primary and backup both fail', async () => {
    chatWithProvider
      .mockRejectedValueOnce(new Error('primary down'))
      .mockRejectedValueOnce(new Error('backup down'))
      .mockResolvedValueOnce(completion('emergency'));

    const result = await tryChatWithFallback(candidates, messages, 'chat');

    expect(result?.fallbackLevel).toBe('emergency');
    expect(chatWithProvider).toHaveBeenCalledTimes(3);
  });

  it('returns null once every candidate has failed', async () => {
    chatWithProvider.mockRejectedValue(new Error('everything is down'));

    expect(await tryChatWithFallback(candidates, messages, 'chat')).toBeNull();
    expect(chatWithProvider.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('records every attempt, successes and failures alike, for provider health', async () => {
    chatWithProvider
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(completion('backup'));

    await tryChatWithFallback(candidates, messages, 'chat');
    await new Promise((resolve) => setTimeout(resolve, 10)); // health writes are fire-and-forget

    const stats = providerAttemptStats(0);
    const failed = stats.find((s) => s.provider === 'openai');
    expect(failed?.failures).toBe(1);
    expect(stats.some((s) => s.success_rate === 1)).toBe(true);
  });

  it('logs the failure reason it inferred', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    chatWithProvider
      .mockRejectedValueOnce(new ProviderError('429', 'openai', 429, true))
      .mockResolvedValueOnce(completion('backup'));

    await tryChatWithFallback(candidates, messages, 'chat', log);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'rate_limit' }),
      expect.stringContaining('Primary model failed')
    );
  });

  it('tries a single-candidate list exactly once', async () => {
    chatWithProvider.mockRejectedValue(new Error('down'));

    expect(await tryChatWithFallback([candidates[0]], messages, 'chat')).toBeNull();
    expect(chatWithProvider).toHaveBeenCalledTimes(1);
  });
});
