import { listModels } from './db/models.js';
import type { ModelRecord } from './db/models.js';
import type { TaskType } from './taskClassifier.js';
import type { TokenEstimate } from './tokens.js';
import { adjustScoreForProviderHealth } from './providerHealth.js';

export type ModelRow = {
  id: string;
  provider: string;
  model_name: string;
  cost_input: number;
  cost_output: number;
  avg_latency: number;
  strengths: string[];
  /** Context window in tokens, from the catalog. Null when the source does not publish one. */
  max_tokens?: number | null;
  /** 0-100 maintainer estimate from config/models.yaml, not a benchmark result. */
  quality_rating?: number;
  /** 0-100 positions within the catalog, derived at each catalog refresh. */
  speed_index?: number;
  price_index?: number;
  deprecated?: boolean;
  // Computed fields (populated during routing)
  score?: number;
  qualityNorm?: number;
  costNorm?: number;
  latencyNorm?: number;
};

// In-memory cache for model registry
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let modelCache: { data: ModelRow[]; timestamp: number } | null = null;

/** The catalog, cached for five minutes to keep routing off a database read. */
async function getModelsFromRegistry(): Promise<ModelRow[]> {
  if (modelCache && Date.now() - modelCache.timestamp < CACHE_TTL_MS) {
    return modelCache.data;
  }

  let rows: ModelRecord[] = [];
  try {
    rows = listModels();
  } catch {
    rows = [];
  }

  if (!rows.length) {
    // A read that returns nothing keeps the last good catalog rather than
    // leaving the router with no candidates at all.
    if (modelCache) {
      return modelCache.data;
    }
    return [];
  }

  const models: ModelRow[] = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    model_name: r.model_name,
    cost_input: Number(r.cost_input),
    cost_output: Number(r.cost_output),
    avg_latency: r.avg_latency ?? 0,
    strengths: r.strengths ?? [],
    max_tokens: r.max_tokens != null ? Number(r.max_tokens) : null,
    quality_rating: r.quality_rating != null ? Number(r.quality_rating) : undefined,
    speed_index: r.speed_index != null ? Number(r.speed_index) : undefined,
    price_index: r.price_index != null ? Number(r.price_index) : undefined,
    deprecated: r.deprecated ?? false,
  }));

  modelCache = { data: models, timestamp: Date.now() };
  return models;
}

/** Called after any change to the catalog. */
export function invalidateModelCache(): void {
  modelCache = null;
}

export type RoutingDecision = {
  provider: string;
  model_name: string;
  reason: string;
};

export type RoutingPriority = 'cheap' | 'balanced' | 'best' | 'quality';
export type RoutingLatencyPreference = 'fast' | 'normal';

export interface RoutingWeights {
  cost: number;      // 0-1, higher = prioritize low cost
  latency: number;   // 0-1, higher = prioritize low latency
  task: number;      // 0-1, higher = prioritize task match
  quality: number;   // 0-1, higher = prioritize quality rating
}

// Base weights by priority mode
const BASE_WEIGHTS: Record<string, RoutingWeights> = {
  cheap:    { cost: 0.7,  latency: 0.2,  task: 0.1, quality: 0 },
  balanced: { cost: 0.4,  latency: 0.3,  task: 0.3, quality: 0 },
  best:     { cost: 0.1,  latency: 0.2,  task: 0.4, quality: 0.3 },
  quality:  { cost: 0.05, latency: 0.15, task: 0.3, quality: 0.5 },
};

/**
 * Weights for one request. A hard task shifts weight toward capability, an easy
 * one toward cost and speed. The result always sums to 1.
 */
export function getWeightsForRequest(
  priority: RoutingPriority,
  complexity: number,
  latencyPref: RoutingLatencyPreference
): RoutingWeights {
  const base = BASE_WEIGHTS[priority] ?? BASE_WEIGHTS.balanced;
  const weights = { ...base };

  if (complexity >= 0.7) {
    // Hard tasks: capability matters more than price and speed.
    weights.task *= 1.4;
    weights.quality *= 1.3;
    weights.cost *= 0.6;
    weights.latency *= 0.7;
  } else if (complexity <= 0.3) {
    // Easy tasks: save money and time.
    weights.cost *= 1.3;
    weights.latency *= 1.2;
    weights.task *= 0.8;
    weights.quality *= 0.7;
  }

  if (latencyPref === 'fast') {
    weights.latency *= 1.5;
    weights.cost *= 0.8;
  }

  const sum = weights.cost + weights.latency + weights.task + weights.quality;
  return {
    cost: weights.cost / sum,
    latency: weights.latency / sum,
    task: weights.task / sum,
    quality: weights.quality / sum,
  };
}

// --- Hard Constraints ---

export interface Constraints {
  minCategorySkill: number;   // 0-100 minimum skill for task type
  minReasoning: number;       // 0-100 minimum reasoning ability
  requireHardCoding: boolean; // Must support complex coding
  /** Reported with the decision. Enforced in selectModels, where token estimates exist. */
  maxCost?: number;
}

export interface ConstraintCheck {
  passes: boolean;
  reasons: string[];  // Why model was disqualified
}

export interface SelectModelsOptions {
  /** Estimated ceiling in USD for this request. Filtering needs a token estimate. */
  maxCost?: number;
  tokenEstimate?: TokenEstimate;
  /** Providers this instance holds credentials for. Undefined means no filter. */
  availableProviders?: string[];
}

/** The capability floor this task and difficulty demand. */
export function getConstraints(
  taskType: TaskType,
  complexity: number,
  maxCost?: number
): Constraints {
  const constraints: Constraints = {
    minCategorySkill: 0,
    minReasoning: 0,
    requireHardCoding: false,
    maxCost,
  };

  if (taskType === 'coding' || taskType === 'debugging') {
    if (complexity >= 0.7) {
      constraints.minCategorySkill = 70;
      constraints.minReasoning = 72;
      constraints.requireHardCoding = true;
    } else if (complexity >= 0.5) {
      constraints.minCategorySkill = 55;
      constraints.minReasoning = 60;
    }
  }

  if (taskType === 'reasoning' || taskType === 'math_reasoning') {
    if (complexity >= 0.65) {
      constraints.minCategorySkill = 70;
      constraints.minReasoning = 75;
    } else if (complexity >= 0.4) {
      constraints.minCategorySkill = 55;
      constraints.minReasoning = 65;
    }
  }

  if (taskType === 'data_analysis' && complexity >= 0.6) {
    constraints.minCategorySkill = 65;
    constraints.minReasoning = 70;
  }

  return constraints;
}

/** Skill for one task: the full quality rating, or 70 percent of it. */
function estimateCategorySkill(model: ModelRow, taskType: TaskType): number {
  const baseSkill = model.quality_rating ?? 50;
  const hasStrength = (model.strengths ?? []).includes(taskType);
  return hasStrength ? baseSkill : baseSkill * 0.7;
}

/** Whether a model clears the constraints, and why it does not. */
export function passesConstraints(
  model: ModelRow,
  constraints: Constraints,
  taskType: TaskType
): ConstraintCheck {
  const reasons: string[] = [];

  if (constraints.minCategorySkill > 0) {
    const skill = estimateCategorySkill(model, taskType);
    if (skill < constraints.minCategorySkill) {
      reasons.push(
        `category skill ${skill.toFixed(0)} < required ${constraints.minCategorySkill}`
      );
    }
  }

  if (constraints.minReasoning > 0) {
    const reasoning = model.quality_rating ?? 50;
    if (reasoning < constraints.minReasoning) {
      reasons.push(
        `reasoning ${reasoning} < required ${constraints.minReasoning}`
      );
    }
  }

  if (constraints.requireHardCoding) {
    const hasCoding = (model.strengths ?? []).includes('coding');
    const highQuality = (model.quality_rating ?? 0) >= 80;
    if (!hasCoding || !highQuality) {
      reasons.push('does not meet hard coding requirement (needs coding strength + quality >= 80)');
    }
  }

  return { passes: reasons.length === 0, reasons };
}

/**
 * What the request needs a model to hold: the prompt plus the expected reply.
 * A smaller window cannot serve the request at all, so this filters rather
 * than scores.
 */
export function requiredContextTokens(tokens: TokenEstimate): number {
  return tokens.inputTokens + tokens.outputTokens;
}

/**
 * A model with no published window is not excluded. An unknown limit is not
 * evidence of a small one, and the provider will say so if it is too small.
 */
export function fitsContext(model: Pick<ModelRow, 'max_tokens'>, tokens?: TokenEstimate): boolean {
  if (!tokens) return true;
  const capacity = model.max_tokens;
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) return true;
  return capacity >= requiredContextTokens(tokens);
}

/**
 * The largest window this instance can route to, which is what tells a
 * conversation that is too large apart from one that no model is capable of.
 */
export async function largestContextWindow(availableProviders?: string[]): Promise<number | null> {
  const rows = await getModelsFromRegistry();
  const candidates = rows.filter(
    (r) => !r.deprecated && (availableProviders === undefined || availableProviders.includes(r.provider))
  );

  let largest: number | null = null;
  for (const model of candidates) {
    const capacity = model.max_tokens;
    if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) continue;
    if (largest === null || capacity > largest) largest = capacity;
  }
  return largest;
}

function estimateCostForModel(model: ModelRow, tokens: TokenEstimate): number {
  const inCost = Number(model.cost_input);
  const outCost = Number(model.cost_output);
  return (tokens.inputTokens / 1000) * inCost + (tokens.outputTokens / 1000) * outCost;
}

function estimateCostForSort(model: ModelRow, tokens?: TokenEstimate): number {
  if (tokens) return estimateCostForModel(model, tokens);
  return Number(model.cost_input) + Number(model.cost_output);
}

function taskMatchScore(strengths: string[], taskType: TaskType): number {
  if (strengths.includes(taskType)) return 1;
  if (strengths.includes('chat')) return 0.5;
  return 0;
}

function normalizeInverse(value: number, min: number, max: number): number {
  if (max <= min) return 1;
  const ratio = (value - min) / (max - min);
  return 1 - Math.min(Math.max(ratio, 0), 1);
}

/**
 * Rank the models this request could use, best first.
 *
 * The list is ordered rather than reduced to one choice, because the execution
 * path walks it when a provider fails. An empty list means no model satisfied
 * the hard filters, which the caller reports rather than papering over.
 */
export async function selectModels(
  taskType: TaskType,
  rawComplexity: number,
  priority: RoutingPriority,
  latencyPref: RoutingLatencyPreference,
  options?: SelectModelsOptions
): Promise<ModelRow[]> {
  // An estimate arriving from outside this module is clamped, not trusted.
  const complexity = Math.min(1, Math.max(0, rawComplexity));

  const rows = await getModelsFromRegistry();

  if (!rows.length) return [];

  const activeModels = rows.filter((r) => !r.deprecated);

  const providerFiltered = options?.availableProviders !== undefined
    ? activeModels.filter((r) => options.availableProviders?.includes(r.provider))
    : activeModels;

  if (!providerFiltered.length) return [];

  // A model that cannot hold this conversation is not a candidate, however
  // well it scores. Routing to it would burn a fallback attempt on a certain
  // rejection.
  const tokenEstimate = options?.tokenEstimate;
  const contextFiltered = providerFiltered.filter((m) => fitsContext(m, tokenEstimate));

  if (!contextFiltered.length) return [];

  const constraints = getConstraints(taskType, complexity, options?.maxCost);
  const constraintFiltered = contextFiltered.filter(
    (m) => passesConstraints(m, constraints, taskType).passes
  );

  let scored = constraintFiltered.map((r) => {
    const strengths = (r.strengths as string[]) ?? [];
    const match = taskMatchScore(strengths, taskType);
    const estimatedCost = estimateCostForSort(r as ModelRow, tokenEstimate);
    return {
      ...r,
      strengths,
      match,
      estimatedCost,
      avg_latency: r.avg_latency ?? 0,
    };
  });

  const maxCost = options?.maxCost;
  if (maxCost !== undefined && tokenEstimate) {
    scored = scored.filter((r) => estimateCostForModel(r as ModelRow, tokenEstimate) <= maxCost);
  }
  if (!scored.length) return [];

  const costValues = scored.map((r) => r.estimatedCost);
  const latencyValues = scored.map((r) => r.avg_latency ?? 0);
  const costMin = Math.min(...costValues);
  const costMax = Math.max(...costValues);
  const latMin = Math.min(...latencyValues);
  const latMax = Math.max(...latencyValues);

  const weights = getWeightsForRequest(priority, complexity, latencyPref);

  scored = await Promise.all(
    scored.map(async (r) => {
      const costNorm = normalizeInverse(r.estimatedCost, costMin, costMax);
      const latencyNorm = normalizeInverse(r.avg_latency ?? 0, latMin, latMax);
      const qualityRating = Math.min(Math.max((r as { quality_rating?: number }).quality_rating ?? 50, 0), 100);
      const qualityNorm = qualityRating / 100; // 0-1 scale

      const rawScore =
        weights.cost * costNorm +
        weights.latency * latencyNorm +
        weights.task * r.match +
        weights.quality * qualityNorm;

      const score = await adjustScoreForProviderHealth(r as ModelRow, rawScore);
      return { ...r, costNorm, latencyNorm, qualityNorm, score };
    })
  );

  let ordered: typeof scored = [];
  if (priority === 'cheap') {
    ordered = [...scored].sort((a, b) => {
      if (a.estimatedCost !== b.estimatedCost) return a.estimatedCost - b.estimatedCost;
      if (latencyPref === 'fast' && a.avg_latency !== b.avg_latency) return a.avg_latency - b.avg_latency;
      if (a.match !== b.match) return b.match - a.match;
      return a.avg_latency - b.avg_latency;
    });
  } else if (priority === 'best') {
    ordered = [...scored].sort((a, b) => {
      if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
      if ((b.quality_rating ?? 0) !== (a.quality_rating ?? 0)) return (b.quality_rating ?? 0) - (a.quality_rating ?? 0);
      if (latencyPref === 'fast' && a.avg_latency !== b.avg_latency) return a.avg_latency - b.avg_latency;
      if (a.estimatedCost !== b.estimatedCost) return a.estimatedCost - b.estimatedCost;
      return b.match - a.match;
    });
  } else {
    ordered = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  return ordered.map((r) => ({
    id: r.id,
    provider: r.provider,
    model_name: r.model_name,
    cost_input: Number(r.cost_input),
    cost_output: Number(r.cost_output),
    avg_latency: r.avg_latency ?? 0,
    strengths: (r.strengths as string[]) ?? [],
    max_tokens: r.max_tokens ?? null,
    quality_rating: r.quality_rating,
    // Reported with the decision, so a ranking can be read back.
    score: r.score,
    qualityNorm: r.qualityNorm,
    costNorm: r.costNorm,
    latencyNorm: r.latencyNorm,
  }));
}

export function getRoutingDecision(
  models: ModelRow[],
  taskType: TaskType,
  priority: RoutingPriority = 'balanced',
  latencyPref: RoutingLatencyPreference = 'normal'
): RoutingDecision {
  const primary = models[0];
  if (!primary) throw new Error('Cannot make a routing decision without candidates');
  return {
    provider: primary.provider,
    model_name: primary.model_name,
    reason: `task=${taskType}, priority=${priority}, latency=${latencyPref}, primary=${primary.provider}/${primary.model_name}`,
  };
}
