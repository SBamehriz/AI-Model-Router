import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfiguredApiKey } from '../auth.js';
import { classifyFailure } from '../chatExecution.js';
import { getRoutingDecision, type ModelRow } from '../router.js';
import { modelId } from '../db/models.js';
import { estimateTokensFromMessages, estimateTokensFromText } from '../tokens.js';
import { completeOffline, offlineLatencyMs } from '../offlineProvider.js';
import { ALL_PROVIDERS, availableProviders, configuredProviders, isOfflineMode } from '../providerAvailability.js';
import { ProviderError } from '../providerClient.js';

/**
 * Coverage for the small exported helpers that the larger suites only exercise
 * indirectly. Each of these has a behaviour something else depends on.
 */

describe('token estimation', () => {
  it('scales with message length and never returns zero input tokens', () => {
    const short = estimateTokensFromMessages([{ content: 'hi' }]);
    const long = estimateTokensFromMessages([{ content: 'x'.repeat(4000) }]);

    expect(short.inputTokens).toBeGreaterThan(0);
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens);
    expect(long.totalTokens).toBe(long.inputTokens + long.outputTokens);
  });

  it('keeps the output estimate inside its bounds', () => {
    expect(estimateTokensFromMessages([{ content: 'hi' }]).outputTokens).toBe(128);
    expect(estimateTokensFromMessages([{ content: 'x'.repeat(100_000) }]).outputTokens).toBe(512);
  });

  it('handles multi-part content and missing content', () => {
    const parts = estimateTokensFromMessages([
      { content: [{ text: 'hello ' }, { text: 'world' }] },
      { content: undefined },
      {},
    ]);
    expect(parts.inputTokens).toBe(Math.ceil('hello world'.length / 4));
  });

  it('estimates from raw text, treating empty as zero', () => {
    expect(estimateTokensFromText('')).toBe(0);
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('x'.repeat(400))).toBe(100);
  });
});

describe('classifyFailure', () => {
  it('recognises rate limiting however it is reported', () => {
    expect(classifyFailure(new Error('429 Too Many Requests'))).toBe('rate_limit');
    expect(classifyFailure(new Error('rate limit exceeded'))).toBe('rate_limit');
    expect(classifyFailure(new ProviderError('quota', 'openai', 429, true))).toBe('rate_limit');
  });

  it('recognises timeouts', () => {
    expect(classifyFailure(new Error('Provider openai timed out after 30000ms'))).toBe('timeout');
    expect(classifyFailure(new Error('Request timeout after 5000ms'))).toBe('timeout');
    expect(classifyFailure({ status: 408 })).toBe('timeout');
    expect(classifyFailure(new ProviderError('gateway', 'groq', 504, true))).toBe('timeout');
  });

  it('does not read a rate limit out of the word generate', () => {
    expect(classifyFailure(new Error('Could not generate a completion'))).toBe('error');
    expect(classifyFailure(new Error('generation failed'))).toBe('error');
  });

  it('falls back to a generic error for anything else', () => {
    expect(classifyFailure(new Error('invalid api key'))).toBe('error');
    expect(classifyFailure('a string')).toBe('error');
    expect(classifyFailure(undefined)).toBe('error');
    expect(classifyFailure(null)).toBe('error');
    expect(classifyFailure({ nothing: true })).toBe('error');
  });
});

describe('getRoutingDecision', () => {
  it('never invents a model when no candidate is available', () => {
    expect(() => getRoutingDecision([], 'chat')).toThrow(/without candidates/);
  });
  const model = (overrides: Partial<ModelRow> = {}): ModelRow => ({
    id: 'openai/gpt-4o-mini',
    provider: 'openai',
    model_name: 'gpt-4o-mini',
    cost_input: 0.00015,
    cost_output: 0.0006,
    avg_latency: 400,
    strengths: ['chat'],
    ...overrides,
  });

  it('describes the winning model and why it won', () => {
    const decision = getRoutingDecision([model(), model({ provider: 'groq', model_name: 'llama' })], 'chat', 'balanced', 'normal');

    expect(decision.provider).toBe('openai');
    expect(decision.model_name).toBe('gpt-4o-mini');
    expect(decision.reason.length).toBeGreaterThan(10);
    expect(decision.reason).toContain('chat');
  });

  it('mentions the priority mode that produced the choice', () => {
    const cheap = getRoutingDecision([model()], 'chat', 'cheap', 'normal');
    const quality = getRoutingDecision([model()], 'chat', 'quality', 'normal');

    expect(cheap.reason).not.toBe(quality.reason);
  });
});

describe('modelId', () => {
  it('joins provider and model into the catalog primary key', () => {
    expect(modelId('openai', 'gpt-4o')).toBe('openai/gpt-4o');
    expect(modelId('openrouter', 'deepseek/deepseek-chat')).toBe('openrouter/deepseek/deepseek-chat');
  });
});

describe('provider availability', () => {
  const providerKeys = ALL_PROVIDERS.map((p) => `${p.toUpperCase()}_API_KEY`);
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(providerKeys.map((k) => [k, process.env[k]]));
    for (const key of providerKeys) delete process.env[key];
    delete process.env.AI_MODEL_ROUTER_OFFLINE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.AI_MODEL_ROUTER_OFFLINE = '1';
  });

  it('reports offline mode when no key is configured', () => {
    expect(configuredProviders()).toEqual([]);
    expect(isOfflineMode()).toBe(true);
    // Offline still routes across the whole catalog, so routing stays exercisable.
    expect(availableProviders()).toEqual([...ALL_PROVIDERS]);
  });

  it('restricts routing to providers that have a key', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.GROQ_API_KEY = 'gsk-test';

    expect(configuredProviders().sort()).toEqual(['groq', 'openai']);
    expect(availableProviders().sort()).toEqual(['groq', 'openai']);
    expect(isOfflineMode()).toBe(false);
  });

  it('ignores an empty or whitespace-only key', () => {
    process.env.OPENAI_API_KEY = '   ';
    expect(configuredProviders()).toEqual([]);
  });

  it('lets AI_MODEL_ROUTER_OFFLINE force the mode either way', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.AI_MODEL_ROUTER_OFFLINE = '1';
    expect(isOfflineMode()).toBe(true);

    delete process.env.OPENAI_API_KEY;
    process.env.AI_MODEL_ROUTER_OFFLINE = '0';
    expect(isOfflineMode()).toBe(false);
  });
});

describe('offline provider', () => {
  const messages = [{ role: 'user' as const, content: 'Write a quicksort' }];

  it('labels its output as simulated and names the model it stands in for', async () => {
    const result = await completeOffline('groq', 'llama-3.3-70b-versatile', messages);

    expect(result.content).toContain('[offline mode]');
    expect(result.content).toContain('groq/llama-3.3-70b-versatile');
    expect(result.content).toContain('Write a quicksort');
    expect(result.model).toBe('llama-3.3-70b-versatile');
  });

  it('reports token counts so cost accounting stays meaningful', async () => {
    const result = await completeOffline('openai', 'gpt-4o-mini', messages);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it('is deterministic for the same prompt and model', async () => {
    const [a, b] = await Promise.all([
      completeOffline('openai', 'gpt-4o-mini', messages),
      completeOffline('openai', 'gpt-4o-mini', messages),
    ]);
    expect(a.content).toBe(b.content);
  });

  it('varies with the prompt', async () => {
    const other = await completeOffline('openai', 'gpt-4o-mini', [{ role: 'user', content: 'Translate hello' }]);
    const first = await completeOffline('openai', 'gpt-4o-mini', messages);
    expect(other.content).not.toBe(first.content);
  });

  it('produces a plausible, deterministic latency', () => {
    const latency = offlineLatencyMs('openai', 'gpt-4o-mini', 'hello');
    expect(latency).toBe(offlineLatencyMs('openai', 'gpt-4o-mini', 'hello'));
    expect(latency).toBeGreaterThanOrEqual(120);
    expect(latency).toBeLessThan(500);
  });

  it('handles a conversation with no user message', async () => {
    const result = await completeOffline('openai', 'gpt-4o-mini', [
      { role: 'assistant', content: 'previous answer' },
    ]);
    expect(result.content).toContain('[offline mode]');
  });
});

describe('getConfiguredApiKey', () => {
  afterEach(() => {
    delete process.env.AI_MODEL_ROUTER_API_KEY;
  });

  it('returns null when unset or blank, so local use needs no key', () => {
    delete process.env.AI_MODEL_ROUTER_API_KEY;
    expect(getConfiguredApiKey()).toBeNull();

    process.env.AI_MODEL_ROUTER_API_KEY = '   ';
    expect(getConfiguredApiKey()).toBeNull();
  });

  it('trims the configured key', () => {
    process.env.AI_MODEL_ROUTER_API_KEY = '  ai-model-router_key  ';
    expect(getConfiguredApiKey()).toBe('ai-model-router_key');
  });
});
