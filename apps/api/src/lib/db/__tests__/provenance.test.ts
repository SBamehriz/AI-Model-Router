import { describe, expect, it } from 'vitest';
import { clearDemoRequests, countDemoRequests, insertRequest, insertRoutingDecision, listRecentRequests, observedLatencyByModel, usageSummary, type RequestInput } from '../requests.js';
import { getDb, getMeta, openDatabase, withTransaction } from '../index.js';
import { insertProviderAttempt, providerAttemptStats } from '../requests.js';

const request: RequestInput = { endpoint: '/v1/chat', task_type: 'chat', complexity: 0.2, priority: 'balanced', provider: 'openai', model_used: 'gpt-4o-mini', tokens_input: 10, tokens_output: 20, cost: 0.001, premium_baseline_cost: 0.002, latency_ms: 100, success: true, fallback_level: 'primary' };

describe('request provenance', () => {
  it('keeps offline and unknown attempts out of live provider health', () => {
    const attempt = { provider: 'openai', model_name: 'gpt-4o-mini', success: true, latency_ms: 125 };
    insertProviderAttempt({ ...attempt, source: 'offline', latency_ms: 1 });
    insertProviderAttempt({ ...attempt, source: 'unknown', success: false });
    expect(providerAttemptStats(0)).toEqual([]);
    insertProviderAttempt({ ...attempt, source: 'live' });
    expect(providerAttemptStats(0)).toEqual([{ provider: 'openai', attempts: 1, success_rate: 1, avg_latency_ms: 125, failures: 0, last_failure_at: null }]);
  });
  it('uses only live traffic for observed latency and reliability', () => {
    insertRequest({ ...request, source: 'demo', latency_ms: 9000, success: false });
    insertRequest({ ...request, source: 'offline', latency_ms: 500 });
    expect(observedLatencyByModel(0).size).toBe(0);
    insertRequest({ ...request, source: 'live', latency_ms: 125 });
    expect(observedLatencyByModel(0).get('openai/gpt-4o-mini')).toBe(125);
  });
  it('removes seeded history and its decisions while preserving operator traffic', () => {
    expect(countDemoRequests()).toBe(0);
    const demoId = insertRequest({ ...request, source: 'demo' });
    insertRoutingDecision({ request_id: demoId, task_type: 'chat', classification_method: 'seed', confidence: null, complexity: 0.2, weights: null, constraints: null, considered_models: [], final_model: 'openai/gpt-4o-mini', reason: 'seeded demo history' });
    const liveId = insertRequest(request);
    const offlineId = insertRequest({ ...request, source: 'offline' });
    expect(countDemoRequests()).toBe(1);
    expect(usageSummary().by_source).toEqual([{ source: 'demo', requests: 1 }, { source: 'live', requests: 1 }, { source: 'offline', requests: 1 }]);
    expect(clearDemoRequests()).toBe(1);
    expect(clearDemoRequests()).toBe(0);
    expect(listRecentRequests(10).map((r) => r.id).sort()).toEqual([liveId, offlineId].sort());
    expect(getDb().prepare('SELECT request_id FROM routing_decisions').all()).toEqual([]);
  });

  it('reports provenance only inside the requested time window', () => {
    insertRequest({ ...request, source: 'demo', created_at: 100 });
    insertRequest({ ...request, source: 'offline', created_at: 200 });
    expect(usageSummary({ from: 150, to: 250 }).by_source).toEqual([{ source: 'offline', requests: 1 }]);
  });

  it('keeps transactions on separate connections independent', () => {
    const second = openDatabase(':memory:');
    try {
      withTransaction(() => {
        expect(() => withTransaction(() => {
          second.prepare("INSERT INTO meta VALUES ('partial', 'no')").run();
          throw new Error('rollback second');
        }, second)).toThrow('rollback second');
        getDb().prepare("INSERT INTO meta VALUES ('outer', 'yes')").run();
      });
      expect(getMeta('outer')).toBe('yes');
      expect(second.prepare('SELECT * FROM meta').all()).toEqual([]);
    } finally { second.close(); }
  });
});
