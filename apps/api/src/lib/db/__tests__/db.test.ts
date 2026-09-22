import { describe, it, expect } from 'vitest';
import { getDb } from '../index.js';
import { listModels, upsertModels, markDeprecatedExcept, countModels } from '../models.js';
import {
  insertProviderAttempt,
  insertRequest,
  insertRoutingDecision,
  listRecentRequests,
  observedLatencyByModel,
  providerAttemptStats,
  pruneProviderAttempts,
  usageSummary,
  countRequests,
} from '../requests.js';

const model = (overrides: Partial<Parameters<typeof upsertModels>[0][number]> = {}) => ({
  provider: 'openai',
  model_name: 'gpt-4o-mini',
  display_name: null,
  cost_input: 0.00015,
  cost_output: 0.0006,
  avg_latency: 400,
  strengths: ['chat', 'summarization'],
  quality_rating: 71,
  speed_index: 92,
  price_index: 18,
  supports_functions: true,
  supports_vision: true,
  max_tokens: 128000,
  data_source: 'test',
  last_synced_at: null,
  deprecated: false,
  ...overrides,
});

const request = (overrides: Partial<Parameters<typeof insertRequest>[0]> = {}) => ({
  endpoint: '/v1/chat',
  task_type: 'chat',
  complexity: 0.3,
  priority: 'balanced',
  provider: 'openai',
  model_used: 'gpt-4o-mini',
  tokens_input: 100,
  tokens_output: 200,
  cost: 0.001,
  premium_baseline_cost: 0.003,
  latency_ms: 400,
  success: true,
  fallback_level: 'primary',
  ...overrides,
});

describe('models table', () => {
  it('round-trips a model, decoding JSON and boolean columns', () => {
    upsertModels([model()]);
    const [row] = listModels();

    expect(row.id).toBe('openai/gpt-4o-mini');
    expect(row.strengths).toEqual(['chat', 'summarization']);
    expect(row.supports_vision).toBe(true);
    expect(row.deprecated).toBe(false);
  });

  it('updates in place on conflict rather than duplicating', () => {
    upsertModels([model()]);
    upsertModels([model({ cost_input: 0.0002 })]);

    const rows = listModels();
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_input).toBe(0.0002);
  });

  it('filters by provider and hides deprecated models by default', () => {
    upsertModels([model(), model({ provider: 'groq', model_name: 'llama-3.3-70b-versatile' })]);
    markDeprecatedExcept(['groq/llama-3.3-70b-versatile']);

    expect(countModels()).toBe(1);
    expect(listModels()).toHaveLength(1);
    expect(listModels({ includeDeprecated: true })).toHaveLength(2);
    expect(listModels({ provider: 'groq' })).toHaveLength(1);
  });

  it('rejects invalid JSON in the strengths column', () => {
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO models (id, provider, model_name, strengths, success)
           VALUES ('x/y', 'x', 'y', 'not json', 1)`
        )
        .run()
    ).toThrow();
  });
});

describe('requests table', () => {
  it('computes generated columns for tokens and savings', () => {
    insertRequest(request());
    const [row] = listRecentRequests(1);

    expect(row.tokens_total).toBe(300);
    expect(row.savings).toBeCloseTo(0.002, 8);
    expect(countRequests()).toBe(1);
  });

  it('joins the routing decision onto the request', () => {
    const id = insertRequest(request());
    insertRoutingDecision({
      request_id: id,
      task_type: 'chat',
      classification_method: 'heuristic',
      confidence: 0.85,
      complexity: 0.3,
      weights: { cost: 0.5, latency: 0.2, task: 0.3, quality: 0 },
      constraints: { minCategorySkill: 0 },
      considered_models: [{ provider: 'openai', model_name: 'gpt-4o-mini' }],
      final_model: 'openai/gpt-4o-mini',
      reason: 'cheapest capable model',
    });

    const [row] = listRecentRequests(1);
    expect(row.routing?.reason).toBe('cheapest capable model');
    expect(row.routing?.weights?.cost).toBe(0.5);
    expect(row.routing?.considered_models).toHaveLength(1);
  });

  it('returns requests newest first, respecting the limit', () => {
    const now = Date.now();
    insertRequest(request({ model_used: 'old', created_at: now - 10_000 }));
    insertRequest(request({ model_used: 'new', created_at: now }));

    expect(listRecentRequests(1).map((r) => r.model_used)).toEqual(['new']);
    expect(listRecentRequests(10)).toHaveLength(2);
  });

  it('refuses a measurement that cannot have happened', () => {
    // A provider reporting negative usage turned into a negative cost, a
    // negative token total, and inflated savings in every dashboard figure.
    expect(() => insertRequest(request({ tokens_input: -100 }))).toThrow(
      /tokens_input must be a finite non-negative number/
    );
    expect(() => insertRequest(request({ tokens_output: -20 }))).toThrow(/tokens_output/);
    expect(() => insertRequest(request({ cost: -0.5 }))).toThrow(/cost/);
    expect(() => insertRequest(request({ premium_baseline_cost: Number.NaN }))).toThrow(
      /premium_baseline_cost/
    );
    expect(() => insertRequest(request({ latency_ms: -1 }))).toThrow(/latency_ms/);
    expect(countRequests()).toBe(0);
  });

  it('keeps negative savings, which are a real routing outcome', () => {
    insertRequest(request({ cost: 0.01, premium_baseline_cost: 0.002 }));

    expect(listRecentRequests(1)[0].savings).toBeCloseTo(-0.008, 8);
  });

  it('rounds fractional token and latency counts to whole units', () => {
    insertRequest(request({ tokens_input: 10.6, tokens_output: 4.4, latency_ms: 12.5 }));
    const [row] = listRecentRequests(1);

    expect(row.tokens_input).toBe(11);
    expect(row.tokens_output).toBe(4);
    expect(row.latency_ms).toBe(13);
  });

  it('refuses a negative measurement at the database, not only in TypeScript', () => {
    // The typed helper is one boundary. The schema is the one that holds for
    // anything else writing to this file.
    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO requests (
             id, created_at, endpoint, task_type, complexity, priority, provider, model_used,
             tokens_input, tokens_output, cost, premium_baseline_cost, latency_ms, success,
             fallback_level, boost, source
           ) VALUES ('raw', 1, '/v1/chat', 'chat', 0.3, 'balanced', 'openai', 'gpt-4o-mini',
             -100, -20, -0.000027, 0, 10, 1, NULL, 0, 'live')`
        )
        .run()
    ).toThrow(/non-negative/);
  });

  it('cascades the routing decision when a request is deleted', () => {
    const id = insertRequest(request());
    insertRoutingDecision({
      request_id: id,
      task_type: 'chat',
      classification_method: null,
      confidence: null,
      complexity: null,
      weights: null,
      constraints: null,
      considered_models: null,
      final_model: 'openai/gpt-4o-mini',
      reason: null,
    });

    getDb().prepare('DELETE FROM requests WHERE id = ?').run(id);
    const remaining = getDb().prepare('SELECT COUNT(*) AS n FROM routing_decisions').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe('usageSummary', () => {
  it('reports zeroes for an empty database', () => {
    const usage = usageSummary();
    expect(usage.total_requests).toBe(0);
    expect(usage.total_cost).toBe(0);
    expect(usage.success_rate).toBe(1);
    expect(usage.by_day).toEqual([]);
  });

  it('aggregates totals, success rate and average latency', () => {
    insertRequest(request({ cost: 0.001, latency_ms: 200 }));
    insertRequest(request({ cost: 0.003, latency_ms: 600, success: false }));

    const usage = usageSummary();
    expect(usage.total_requests).toBe(2);
    expect(usage.total_cost).toBeCloseTo(0.004, 8);
    expect(usage.avg_latency_ms).toBe(400);
    expect(usage.success_rate).toBe(0.5);
    expect(usage.total_tokens).toBe(600);
  });

  it('breaks usage down by model, task and day', () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    insertRequest(request({ created_at: now }));
    insertRequest(request({ created_at: now, task_type: 'coding', model_used: 'gpt-4o', cost: 0.02 }));
    insertRequest(request({ created_at: now - day }));

    const usage = usageSummary();
    expect(usage.by_day).toHaveLength(2);
    expect(usage.by_model.map((m) => m.model).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(usage.by_model.find((m) => m.model === 'gpt-4o-mini')?.requests).toBe(2);
    expect(usage.by_task.find((t) => t.task_type === 'coding')?.requests).toBe(1);
    expect(usage.by_task.find((t) => t.task_type === 'chat')?.avg_complexity).toBe(0.3);
  });

  it('honours the from/to window', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    insertRequest(request({ created_at: now - 5 * day }));
    insertRequest(request({ created_at: now }));

    expect(usageSummary({ from: now - day }).total_requests).toBe(1);
    expect(usageSummary({ to: now - day }).total_requests).toBe(1);
    expect(usageSummary({ from: now - 10 * day, to: now + 1000 }).total_requests).toBe(2);
  });
});

describe('provider attempt statistics', () => {
  const attempt = (overrides: Partial<Parameters<typeof insertProviderAttempt>[0]> = {}) => ({
    provider: 'openai',
    model_name: 'gpt-4o-mini',
    success: true,
    latency_ms: 200,
    ...overrides,
  });

  it('aggregates attempts per provider inside the window', () => {
    insertProviderAttempt(attempt());
    insertProviderAttempt(attempt({ success: false, latency_ms: 600 }));
    insertProviderAttempt(attempt({ provider: 'groq', latency_ms: 100 }));

    const stats = providerAttemptStats(Date.now() - 60_000);
    const openai = stats.find((s) => s.provider === 'openai');

    expect(openai).toMatchObject({ attempts: 2, failures: 1 });
    expect(openai?.success_rate).toBe(0.5);
    expect(openai?.avg_latency_ms).toBe(400);
    expect(openai?.last_failure_at).toBeGreaterThan(0);
    expect(stats.find((s) => s.provider === 'groq')?.attempts).toBe(1);
  });

  it('can be narrowed to a single provider', () => {
    insertProviderAttempt(attempt());
    insertProviderAttempt(attempt({ provider: 'groq' }));

    expect(providerAttemptStats(Date.now() - 60_000, 'groq')).toHaveLength(1);
  });

  it('excludes attempts older than the window', () => {
    insertProviderAttempt(attempt({ created_at: Date.now() - 2 * 60 * 60 * 1000 }));
    expect(providerAttemptStats(Date.now() - 60 * 60 * 1000)).toEqual([]);
  });

  it('prunes old attempts and reports how many it removed', () => {
    insertProviderAttempt(attempt({ created_at: Date.now() - 5 * 86_400_000 }));
    insertProviderAttempt(attempt());

    expect(pruneProviderAttempts(Date.now() - 86_400_000)).toBe(1);
    expect(providerAttemptStats(0)).toHaveLength(1);
  });

  it('reports no last_failure_at for a provider with a clean record', () => {
    insertProviderAttempt(attempt());
    expect(providerAttemptStats(0)[0].last_failure_at).toBeNull();
  });
});

describe('observed latency', () => {
  it('averages successful requests per model, keyed by provider/model', () => {
    insertRequest(request({ latency_ms: 200 }));
    insertRequest(request({ latency_ms: 400 }));
    insertRequest(request({ latency_ms: 9999, success: false }));

    const observed = observedLatencyByModel(Date.now() - 60_000);
    expect(observed.get('openai/gpt-4o-mini')).toBe(300);
  });

  it('ignores requests outside the window', () => {
    insertRequest(request({ created_at: Date.now() - 30 * 86_400_000 }));
    expect(observedLatencyByModel(Date.now() - 86_400_000).size).toBe(0);
  });
});
