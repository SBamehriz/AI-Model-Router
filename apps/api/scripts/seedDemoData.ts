#!/usr/bin/env tsx
/**
 * Fill the local database with synthetic request history so the dashboard's
 * charts have something to show before you have generated real traffic.
 *
 *   npm run seed:demo --workspace=apps/api
 *
 * The rows are clearly synthetic. They are written through the same code path
 * as real requests, priced from the catalog, and removed again by
 * npm run demo:clear. Nothing here is presented as production data.
 */
import 'dotenv/config';
import { closeDb, getDb, withTransaction } from '../src/lib/db/index.js';
import { listModels } from '../src/lib/db/models.js';
import { countDemoRequests, insertRequest, insertRoutingDecision } from '../src/lib/db/requests.js';
import { seedCatalogFromConfig } from '../src/lib/modelCatalog.js';
import { premiumEstimate } from '../src/lib/providers.js';

const DAYS = 30;
const REQUESTS_PER_DAY = 12;

const TASK_MIX: Array<{ task: string; complexity: [number, number]; strengths: string }> = [
  { task: 'chat', complexity: [0.1, 0.35], strengths: 'chat' },
  { task: 'summarization', complexity: [0.15, 0.4], strengths: 'summarization' },
  { task: 'coding', complexity: [0.45, 0.9], strengths: 'coding' },
  { task: 'debugging', complexity: [0.5, 0.85], strengths: 'debugging' },
  { task: 'reasoning', complexity: [0.4, 0.85], strengths: 'reasoning' },
  { task: 'translation', complexity: [0.1, 0.3], strengths: 'translation' },
  { task: 'data_analysis', complexity: [0.4, 0.8], strengths: 'data_analysis' },
  { task: 'agent_step', complexity: [0.2, 0.6], strengths: 'agent_step' },
];

/** Deterministic PRNG so repeated seeding produces the same history. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

async function main(): Promise<void> {
  getDb();
  if (countDemoRequests() > 0) {
    console.log('Demo history already exists. Run npm run demo:clear before reseeding.');
    closeDb();
    return;
  }
  if (listModels().length === 0) seedCatalogFromConfig();

  const models = listModels();
  if (models.length === 0) {
    console.error('No models in the catalog. Start the API once so it can populate.');
    process.exit(1);
  }

  const random = makeRandom(20240917);
  const now = Date.now();
  let written = 0;

  withTransaction(() => {
  for (let day = DAYS - 1; day >= 0; day -= 1) {
    const count = Math.max(3, Math.round(REQUESTS_PER_DAY * (0.6 + random())));

    for (let i = 0; i < count; i += 1) {
      const mix = TASK_MIX[Math.floor(random() * TASK_MIX.length)];
      const complexity = mix.complexity[0] + random() * (mix.complexity[1] - mix.complexity[0]);

      // Harder tasks pick stronger models and simple ones pick cheap models,
      // which is the bias the router itself applies.
      const candidates = models.filter((m) => m.strengths.includes(mix.strengths));
      const pool = (candidates.length ? candidates : models).slice().sort((a, b) =>
        complexity > 0.55
          ? (b.quality_rating ?? 0) - (a.quality_rating ?? 0)
          : a.cost_input + a.cost_output - (b.cost_input + b.cost_output)
      );
      const model = pool[Math.floor(random() * Math.min(3, pool.length))];

      const tokensIn = Math.round(180 + random() * 1400 * (0.4 + complexity));
      const tokensOut = Math.round(120 + random() * 900 * (0.4 + complexity));
      const cost = (tokensIn / 1000) * model.cost_input + (tokensOut / 1000) * model.cost_output;
      const success = random() > 0.02;
      const latency = Math.round(model.avg_latency * (0.75 + random() * 0.7));
      const createdAt =
        now - day * 24 * 60 * 60 * 1000 - Math.floor(random() * 20 * 60 * 60 * 1000);

      const id = insertRequest({
        source: 'demo',
        endpoint: mix.task === 'agent_step' ? '/v1/agent-step' : '/v1/chat',
        task_type: mix.task,
        complexity: Math.round(complexity * 100) / 100,
        priority: complexity > 0.6 ? 'best' : 'balanced',
        provider: model.provider,
        model_used: model.model_name,
        tokens_input: tokensIn,
        tokens_output: tokensOut,
        cost,
        premium_baseline_cost: premiumEstimate(tokensIn, tokensOut),
        latency_ms: latency,
        success,
        fallback_level: random() > 0.95 ? 'backup' : 'primary',
        created_at: createdAt,
      });

      insertRoutingDecision({
        request_id: id,
        task_type: mix.task,
        classification_method: 'heuristic',
        confidence: 0.85,
        complexity: Math.round(complexity * 100) / 100,
        weights: null,
        constraints: null,
        considered_models: pool.slice(0, 3).map((m) => ({
          provider: m.provider,
          model_name: m.model_name,
        })),
        final_model: `${model.provider}/${model.model_name}`,
        reason: 'seeded demo history',
      });

      written += 1;
    }
  }

  });
  console.log(`Seeded ${written} synthetic requests across ${DAYS} days.`);
  console.log('Run npm run demo:clear to remove only these rows.');
  closeDb();
}

void main();
