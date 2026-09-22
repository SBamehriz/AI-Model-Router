import type { ModelRow } from './router.js';
import type { TaskType } from './taskClassifier.js';

// --- Types ---

export type FailureReason = 'rate_limit' | 'timeout' | 'error' | 'unknown';

/**
 * How many models one request may try before giving up.
 *
 * Selection returns every eligible model, which is the whole catalog for an
 * easy prompt. Trying all of them meant worst case latency grew with the
 * catalog: eleven curated models take about 24 minutes to fail one by one at
 * the provider deadline, and adding a dozen custom models takes it past 49.
 * No caller waits that long, so the tail was work nobody would ever read.
 *
 * Four covers the documented chain, primary then backup then emergency, with
 * one spare. Past that the evidence says the problem is the account or the
 * network rather than the model, and another candidate will not fix it.
 */
export const MAX_MODELS_ATTEMPTED = 4;

export interface FallbackChain {
  primary: ModelRow;
  backup: ModelRow;
  emergency: ModelRow;
  reasoning: string;
}

// --- Helpers ---

/**
 * The cheapest model that still rates 60 or better, or the cheapest of all when
 * none of them do.
 */
export function findCheapestReliable(models: ModelRow[]): ModelRow {
  if (!models.length) throw new Error('Cannot select a fallback from an empty model list');
  const reliable = models.filter((m) => (m.quality_rating ?? 50) >= 60);
  const pool = reliable.length > 0 ? reliable : models;
  return [...pool].sort(
    (a, b) => (a.cost_input + a.cost_output) - (b.cost_input + b.cost_output)
  )[0];
}

// --- Main ---

/**
 * The chain to try after a failure, chosen by what went wrong. A rate limit
 * moves to another provider, a timeout moves to the fastest models, and
 * anything else falls back on quality. With one model available, the chain
 * reuses it.
 */
export function selectFallbackChain(
  primaryModel: ModelRow,
  allModels: ModelRow[],
  taskType: TaskType,
  failureReason?: FailureReason
): FallbackChain {
  const otherModels = allModels.filter((m) => m.id !== primaryModel.id);

  // Nothing else to try.
  if (otherModels.length === 0) {
    return {
      primary: primaryModel,
      backup: primaryModel,
      emergency: primaryModel,
      reasoning: 'Only one model available, so there is no alternative',
    };
  }

  // A different provider, to leave the bucket that just refused.
  if (failureReason === 'rate_limit') {
    const differentProvider = otherModels.find(
      (m) => m.provider !== primaryModel.provider
    );
    const cheapest = findCheapestReliable(otherModels);

    return {
      primary: primaryModel,
      backup: differentProvider ?? otherModels[0],
      emergency: cheapest,
      reasoning: 'Rate limit fallback, trying a different provider',
    };
  }

  // Speed first.
  if (failureReason === 'timeout') {
    const bySpeed = [...otherModels].sort(
      (a, b) => a.avg_latency - b.avg_latency
    );

    return {
      primary: primaryModel,
      backup: bySpeed[0],
      emergency: bySpeed[1] ?? bySpeed[0],
      reasoning: 'Timeout fallback, prioritising speed',
    };
  }

  // Quality first, with a lift for a model that lists this task.
  const byQuality = [...otherModels].sort((a, b) => {
    const aBoost = (a.strengths ?? []).includes(taskType) ? 1.2 : 1.0;
    const bBoost = (b.strengths ?? []).includes(taskType) ? 1.2 : 1.0;
    const scoreA = (a.quality_rating ?? 50) * aBoost;
    const scoreB = (b.quality_rating ?? 50) * bBoost;
    return scoreB - scoreA;
  });

  return {
    primary: primaryModel,
    backup: byQuality[0],
    emergency: findCheapestReliable(otherModels),
    reasoning: 'Quality based fallback chain',
  };
}
