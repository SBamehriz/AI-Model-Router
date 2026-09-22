import type { ModelRow } from './router.js';
import { insertProviderAttempt, providerAttemptStats, pruneProviderAttempts } from './db/requests.js';

/**
 * Provider reliability, measured from this instance's own traffic. Every
 * attempt is written to SQLite, including the ones that failed and fell back,
 * and health is an aggregate over a trailing window. It survives restarts and
 * needs no external service.
 */

export interface ProviderHealth {
  provider: string;
  attempts: number; // calls observed within the window
  successRate: number; // 0-1
  avgLatency: number; // milliseconds
  failureCount: number; // within the window
  lastFailure?: Date;
}

const HEALTH_WINDOW_MS = 60 * 60 * 1000;
/** Attempts are kept for a day, which is well past the scoring window. */
const RETENTION_MS = 24 * 60 * 60 * 1000;
const HEALTH_CACHE_TTL_MS = 30 * 1000;
/** Below this many attempts the sample is too small to penalize a provider. */
const MIN_ATTEMPTS_FOR_SCORING = 5;

const healthCache = new Map<string, { value: ProviderHealth; timestamp: number }>();
let lastPruneAt = 0;

function neutralHealth(provider: string): ProviderHealth {
  return { provider, attempts: 0, successRate: 1, avgLatency: 0, failureCount: 0 };
}

/** Record the outcome of one provider call. Never throws. */
export async function recordProviderOutcome(
  provider: string,
  success: boolean,
  latency: number,
  modelName?: string,
  source: 'live' | 'offline' = 'live'
): Promise<void> {
  healthCache.delete(provider);
  try {
    insertProviderAttempt({
      source,
      provider,
      model_name: modelName ?? null,
      success,
      latency_ms: Number.isFinite(latency) ? Math.max(0, latency) : 0,
    });

    const now = Date.now();
    if (now - lastPruneAt > HEALTH_WINDOW_MS) {
      lastPruneAt = now;
      pruneProviderAttempts(now - RETENTION_MS);
    }
  } catch {
    // Health tracking is best effort. Never fail a request over it.
  }
}

/** Success rate and latency for one provider, over the trailing window. */
export async function getProviderHealth(provider: string): Promise<ProviderHealth> {
  const cached = healthCache.get(provider);
  if (cached && Date.now() - cached.timestamp < HEALTH_CACHE_TTL_MS) return cached.value;

  let health = neutralHealth(provider);
  try {
    const [stats] = providerAttemptStats(Date.now() - HEALTH_WINDOW_MS, provider);
    if (stats) {
      health = {
        provider,
        attempts: stats.attempts,
        successRate: stats.success_rate,
        avgLatency: stats.avg_latency_ms,
        failureCount: stats.failures,
        ...(stats.last_failure_at ? { lastFailure: new Date(stats.last_failure_at) } : {}),
      };
    }
  } catch {
    // No database yet (or a read error): treat the provider as healthy.
  }

  healthCache.set(provider, { value: health, timestamp: Date.now() });
  return health;
}

/** Health for every provider seen in the window, as the dashboard shows it. */
export async function getAllProviderHealth(): Promise<ProviderHealth[]> {
  try {
    return providerAttemptStats(Date.now() - HEALTH_WINDOW_MS).map((s) => ({
      provider: s.provider,
      attempts: s.attempts,
      successRate: s.success_rate,
      avgLatency: s.avg_latency_ms,
      failureCount: s.failures,
      ...(s.last_failure_at ? { lastFailure: new Date(s.last_failure_at) } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * Lower a model's score when its provider has been unreliable or slow. A small
 * sample with no failures is left alone, so a quiet provider is not penalised
 * for lack of evidence.
 */
export async function adjustScoreForProviderHealth(model: ModelRow, score: number): Promise<number> {
  if (!Number.isFinite(score)) return score;

  try {
    const health = await getProviderHealth(model.provider);
    // Too few observations and a clean record, so there is nothing to say.
    if (health.attempts < MIN_ATTEMPTS_FOR_SCORING && health.failureCount === 0) return score;

    let adjusted = score;

    if (health.successRate < 0.9) {
      adjusted *= Math.max(0.5, health.successRate / 0.9);
    }

    const baselineLatency = Number(model.avg_latency ?? 0);
    if (baselineLatency > 0 && health.avgLatency > baselineLatency * 1.5) {
      adjusted *= Math.max(0.7, (baselineLatency * 1.5) / health.avgLatency);
    }

    return Math.max(0, Math.min(1, adjusted));
  } catch {
    return score;
  }
}

/** Test helper. */
export function __resetProviderHealthForTests(): void {
  healthCache.clear();
  lastPruneAt = 0;
}
