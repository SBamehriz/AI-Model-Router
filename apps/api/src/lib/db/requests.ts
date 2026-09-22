import { randomUUID } from 'node:crypto';
import { getDb } from './index.js';

export type RequestSource = 'live' | 'offline' | 'demo' | 'unknown';

export type RequestInput = {
  id?: string;
  source?: RequestSource;
  endpoint: string;
  task_type: string;
  complexity: number | null;
  priority: string;
  provider: string;
  model_used: string;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  premium_baseline_cost: number;
  latency_ms: number;
  success: boolean;
  fallback_level: string | null;
  boost?: boolean;
  created_at?: number;
};

export type RoutingDecisionInput = {
  request_id: string;
  task_type: string;
  classification_method: string | null;
  confidence: number | null;
  complexity: number | null;
  weights: unknown;
  constraints: unknown;
  considered_models: unknown;
  final_model: string;
  reason: string | null;
};

export type RequestRecord = {
  source: RequestSource;
  id: string;
  created_at: number;
  endpoint: string;
  task_type: string;
  complexity: number | null;
  priority: string;
  provider: string;
  model_used: string;
  tokens_input: number;
  tokens_output: number;
  tokens_total: number;
  cost: number;
  savings: number;
  latency_ms: number;
  success: boolean;
  fallback_level: string | null;
  boost: boolean;
};

export type RequestWithRouting = RequestRecord & {
  routing: {
    considered_models: Array<{ provider: string; model_name: string; score?: number }>;
    final_model: string;
    reason: string | null;
    weights: Record<string, number> | null;
    constraints: Record<string, unknown> | null;
    classification_method: string | null;
    confidence: number | null;
  } | null;
};

export type UsageSummary = {
  by_source: Array<{ source: RequestSource; requests: number }>;
  total_requests: number;
  total_cost: number;
  total_savings: number;
  total_tokens: number;
  total_tokens_input: number;
  total_tokens_output: number;
  avg_latency_ms: number;
  success_rate: number;
  by_day: Array<{ date: string; requests: number; cost: number; savings: number }>;
  by_model: Array<{ model: string; provider: string; requests: number; cost: number; savings: number; avg_latency_ms: number }>;
  by_task: Array<{ task_type: string; requests: number; cost: number; avg_complexity: number | null }>;
};

const round = (n: number): number => Math.round(n * 1e8) / 1e8;

/**
 * Reject a measurement that cannot have happened. The database refuses these
 * too, but failing here names the field and the value. Tokens and latency are
 * whole units, so a provider reporting 10.5 tokens is rounded.
 */
function measurement(field: string, value: number, integer = false): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`insertRequest: ${field} must be a finite non-negative number (got ${value})`);
  }
  return integer ? Math.round(value) : value;
}

export function insertRequest(input: RequestInput): string {
  const id = input.id ?? randomUUID();
  getDb()
    .prepare(`
      INSERT INTO requests (
        id, created_at, endpoint, task_type, complexity, priority, provider, model_used,
        tokens_input, tokens_output, cost, premium_baseline_cost, latency_ms, success,
        fallback_level, boost, source
      ) VALUES (
        @id, @created_at, @endpoint, @task_type, @complexity, @priority, @provider, @model_used,
        @tokens_input, @tokens_output, @cost, @premium_baseline_cost, @latency_ms, @success,
        @fallback_level, @boost, @source
      )
    `)
    .run({
      id,
      source: input.source ?? 'live',
      created_at: input.created_at ?? Date.now(),
      endpoint: input.endpoint,
      task_type: input.task_type,
      complexity: input.complexity,
      priority: input.priority,
      provider: input.provider,
      model_used: input.model_used,
      tokens_input: measurement('tokens_input', input.tokens_input, true),
      tokens_output: measurement('tokens_output', input.tokens_output, true),
      cost: measurement('cost', input.cost),
      premium_baseline_cost: measurement('premium_baseline_cost', input.premium_baseline_cost),
      latency_ms: measurement('latency_ms', input.latency_ms, true),
      success: input.success ? 1 : 0,
      fallback_level: input.fallback_level,
      boost: input.boost ? 1 : 0,
    });
  return id;
}

export function insertRoutingDecision(input: RoutingDecisionInput): void {
  getDb()
    .prepare(`
      INSERT INTO routing_decisions (
        request_id, task_type, classification_method, confidence, complexity,
        weights, constraints, considered_models, final_model, reason
      ) VALUES (
        @request_id, @task_type, @classification_method, @confidence, @complexity,
        @weights, @constraints, @considered_models, @final_model, @reason
      )
      ON CONFLICT (request_id) DO NOTHING
    `)
    .run({
      request_id: input.request_id,
      task_type: input.task_type,
      classification_method: input.classification_method,
      confidence: input.confidence,
      complexity: input.complexity,
      weights: input.weights ? JSON.stringify(input.weights) : null,
      constraints: input.constraints ? JSON.stringify(input.constraints) : null,
      considered_models: input.considered_models ? JSON.stringify(input.considered_models) : null,
      final_model: input.final_model,
      reason: input.reason,
    });
}

function hydrateRequest(row: Record<string, unknown>): RequestRecord {
  return {
    source: row.source as RequestSource,
    id: String(row.id),
    created_at: Number(row.created_at),
    endpoint: String(row.endpoint),
    task_type: String(row.task_type),
    complexity: row.complexity != null ? Number(row.complexity) : null,
    priority: String(row.priority),
    provider: String(row.provider),
    model_used: String(row.model_used),
    tokens_input: Number(row.tokens_input),
    tokens_output: Number(row.tokens_output),
    tokens_total: Number(row.tokens_total),
    cost: Number(row.cost),
    savings: Number(row.savings),
    latency_ms: Number(row.latency_ms),
    success: !!row.success,
    fallback_level: (row.fallback_level as string | null) ?? null,
    boost: !!row.boost,
  };
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Most recent requests with the routing decision that produced them. */
export function listRecentRequests(limit: number): RequestWithRouting[] {
  const rows = getDb()
    .prepare(`
      SELECT r.*, d.considered_models, d.final_model, d.reason, d.weights, d.constraints,
             d.classification_method, d.confidence
      FROM requests r
      LEFT JOIN routing_decisions d ON d.request_id = r.id
      ORDER BY r.created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...hydrateRequest(row),
    routing: row.final_model
      ? {
          considered_models: parseJson<Array<{ provider: string; model_name: string; score?: number }>>(row.considered_models) ?? [],
          final_model: String(row.final_model),
          reason: (row.reason as string | null) ?? null,
          weights: parseJson<Record<string, number>>(row.weights),
          constraints: parseJson<Record<string, unknown>>(row.constraints),
          classification_method: (row.classification_method as string | null) ?? null,
          confidence: row.confidence != null ? Number(row.confidence) : null,
        }
      : null,
  }));
}

/**
 * Usage aggregation. Totals, the daily series and the per model and per task
 * breakdowns are all computed in SQL.
 */
export function usageSummary(range: { from?: number; to?: number } = {}): UsageSummary {
  const where: string[] = [];
  const params: Record<string, number> = {};
  if (range.from != null) {
    where.push('created_at >= @from');
    params.from = range.from;
  }
  if (range.to != null) {
    where.push('created_at <= @to');
    params.to = range.to;
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();

  const totals = db
    .prepare(`
      SELECT COUNT(*)                          AS total_requests,
             COALESCE(SUM(cost), 0)            AS total_cost,
             COALESCE(SUM(savings), 0)         AS total_savings,
             COALESCE(SUM(tokens_total), 0)    AS total_tokens,
             COALESCE(SUM(tokens_input), 0)    AS total_tokens_input,
             COALESCE(SUM(tokens_output), 0)   AS total_tokens_output,
             COALESCE(AVG(latency_ms), 0)      AS avg_latency_ms,
             COALESCE(AVG(success), 1)         AS success_rate
      FROM requests ${filter}
    `)
    .get(params) as Record<string, number>;

  const byDay = db
    .prepare(`
      SELECT date(created_at / 1000, 'unixepoch') AS date,
             COUNT(*)                  AS requests,
             COALESCE(SUM(cost), 0)    AS cost,
             COALESCE(SUM(savings), 0) AS savings
      FROM requests ${filter}
      GROUP BY date(created_at / 1000, 'unixepoch')
      ORDER BY date
    `)
    .all(params) as Array<{ date: string; requests: number; cost: number; savings: number }>;

  const byModel = db
    .prepare(`
      SELECT model_used                    AS model,
             provider,
             COUNT(*)                      AS requests,
             COALESCE(SUM(cost), 0)        AS cost,
             COALESCE(SUM(savings), 0)     AS savings,
             COALESCE(AVG(latency_ms), 0)  AS avg_latency_ms
      FROM requests ${filter}
      GROUP BY model_used, provider
      ORDER BY requests DESC, model ASC
    `)
    .all(params) as Array<{ model: string; provider: string; requests: number; cost: number; savings: number; avg_latency_ms: number }>;

  const byTask = db
    .prepare(`
      SELECT task_type,
             COUNT(*)               AS requests,
             COALESCE(SUM(cost), 0) AS cost,
             AVG(complexity)        AS avg_complexity
      FROM requests ${filter}
      GROUP BY task_type
      ORDER BY requests DESC, task_type ASC
    `)
    .all(params) as Array<{ task_type: string; requests: number; cost: number; avg_complexity: number | null }>;

  return {
    by_source: db.prepare(`SELECT source, COUNT(*) AS requests FROM requests ${filter} GROUP BY source ORDER BY source`).all(params) as UsageSummary['by_source'],
    total_requests: totals.total_requests,
    total_cost: round(totals.total_cost),
    total_savings: round(totals.total_savings),
    total_tokens: totals.total_tokens,
    total_tokens_input: totals.total_tokens_input,
    total_tokens_output: totals.total_tokens_output,
    avg_latency_ms: Math.round(totals.avg_latency_ms),
    success_rate: round(totals.success_rate),
    by_day: byDay.map((d) => ({ ...d, cost: round(d.cost), savings: round(d.savings) })),
    by_model: byModel.map((m) => ({
      ...m,
      cost: round(m.cost),
      savings: round(m.savings),
      avg_latency_ms: Math.round(m.avg_latency_ms),
    })),
    by_task: byTask.map((t) => ({
      ...t,
      cost: round(t.cost),
      avg_complexity: t.avg_complexity != null ? Math.round(t.avg_complexity * 100) / 100 : null,
    })),
  };
}

/** Observed average latency per model, used to show measured vs. catalog latency. */
export function observedLatencyByModel(sinceMs: number): Map<string, number> {
  const rows = getDb()
    .prepare(`
      SELECT provider || '/' || model_used AS model_key, AVG(latency_ms) AS avg_latency_ms
      FROM requests
      WHERE created_at >= ? AND success = 1 AND source = 'live'
      -- Group by the expression rather than the alias. An alias that collides
      -- with a real column silently groups by that column instead.
      GROUP BY provider || '/' || model_used
    `)
    .all(sinceMs) as Array<{ model_key: string; avg_latency_ms: number }>;
  return new Map(rows.map((r) => [r.model_key, Math.round(r.avg_latency_ms)]));
}

export function countRequests(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number };
  return row.n;
}

/** Remove only the rows that were seeded. Decisions cascade with their requests. */
export function clearDemoRequests(): number {
  return Number(getDb().prepare("DELETE FROM requests WHERE source = 'demo'").run().changes);
}

export function countDemoRequests(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE source = 'demo'").get() as { n: number }).n;
}

// --- Provider attempts (provider-health signal) ---

export type ProviderAttemptInput = {
  source?: 'live' | 'offline' | 'unknown';
  provider: string;
  model_name: string | null;
  success: boolean;
  latency_ms: number;
  created_at?: number;
};

export function insertProviderAttempt(input: ProviderAttemptInput): void {
  getDb()
    .prepare(`
      INSERT INTO provider_attempts (provider, model_name, success, latency_ms, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.provider,
      input.model_name,
      input.success ? 1 : 0,
      Math.max(0, Math.round(input.latency_ms)),
      input.created_at ?? Date.now(),
      input.source ?? 'live'
    );
}

export type ProviderAttemptStats = {
  provider: string;
  attempts: number;
  success_rate: number;
  avg_latency_ms: number;
  failures: number;
  last_failure_at: number | null;
};

/** Aggregate only live provider attempts inside a trailing window. */
export function providerAttemptStats(sinceMs: number, provider?: string): ProviderAttemptStats[] {
  const rows = getDb()
    .prepare(`
      SELECT provider,
             COUNT(*)                                      AS attempts,
             AVG(success)                                  AS success_rate,
             AVG(latency_ms)                               AS avg_latency_ms,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END)  AS failures,
             MAX(CASE WHEN success = 0 THEN created_at END) AS last_failure_at
      FROM provider_attempts
      WHERE source = 'live' AND created_at >= @since ${provider ? 'AND provider = @provider' : ''}
      GROUP BY provider
    `)
    .all(provider ? { since: sinceMs, provider } : { since: sinceMs }) as Array<Record<string, number | null>>;

  return rows.map((r) => ({
    provider: String(r.provider),
    attempts: Number(r.attempts),
    success_rate: Number(r.success_rate ?? 1),
    avg_latency_ms: Math.round(Number(r.avg_latency_ms ?? 0)),
    failures: Number(r.failures ?? 0),
    last_failure_at: r.last_failure_at != null ? Number(r.last_failure_at) : null,
  }));
}

/** Drop attempt rows older than the retention window. */
export function pruneProviderAttempts(olderThanMs: number): number {
  const result = getDb().prepare('DELETE FROM provider_attempts WHERE created_at < ?').run(olderThanMs);
  return Number(result.changes);
}
