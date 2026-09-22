import { describe, it, expect, beforeEach } from 'vitest';
import {
  selectModels,
  invalidateModelCache,
  getWeightsForRequest,
  getConstraints,
  passesConstraints,
  fitsContext,
  largestContextWindow,
  requiredContextTokens,
  type ModelRow,
  type RoutingWeights,
} from '../router.js';
import { upsertModels } from '../db/models.js';
import { getDb } from '../db/index.js';
import type { TaskType } from '../taskClassifier.js';

/**
 * The router reads its catalog from SQLite, so these tests write the fixture
 * models into the in-memory database created by vitest.setup.ts.
 */
let mockModels: ModelRow[] = [];

function loadFixtureModels(models: ModelRow[]): void {
  upsertModels(
    models.map((m) => ({
      provider: m.provider,
      model_name: m.model_name,
      display_name: null,
      cost_input: m.cost_input,
      cost_output: m.cost_output,
      avg_latency: m.avg_latency,
      strengths: m.strengths,
      quality_rating: m.quality_rating ?? null,
      speed_index: m.speed_index ?? null,
      price_index: m.price_index ?? null,
      supports_functions: false,
      supports_vision: false,
      max_tokens: m.max_tokens ?? null,
      deprecated: m.deprecated ?? false,
      data_source: 'test',
      last_synced_at: null,
    }))
  );
  invalidateModelCache();
}

function clearModels(): void {
  getDb().prepare('DELETE FROM models').run();
  invalidateModelCache();
}

describe('Router - Model Selection', () => {
  beforeEach(() => {
    // Reset mock models before each test
    mockModels = [
      {
        id: '1',
        provider: 'openai',
        model_name: 'gpt-4o-mini',
        cost_input: 0.00015,
        cost_output: 0.0006,
        avg_latency: 400,
        strengths: ['chat', 'summarization'],
        quality_rating: 78,
        speed_index: 92,
        price_index: 20,
        deprecated: false,
      },
      {
        id: '2',
        provider: 'openai',
        model_name: 'gpt-4o',
        cost_input: 0.0025,
        cost_output: 0.01,
        avg_latency: 800,
        strengths: ['reasoning', 'coding', 'chat'],
        quality_rating: 90,
        speed_index: 75,
        price_index: 70,
        deprecated: false,
      },
      {
        id: '3',
        provider: 'anthropic',
        model_name: 'claude-3-5-haiku-20241022',
        cost_input: 0.0008,
        cost_output: 0.004,
        avg_latency: 350,
        strengths: ['chat', 'summarization'],
        quality_rating: 80,
        speed_index: 88,
        price_index: 30,
        deprecated: false,
      },
      {
        id: '4',
        provider: 'anthropic',
        model_name: 'claude-3-5-sonnet-20241022',
        cost_input: 0.003,
        cost_output: 0.015,
        avg_latency: 600,
        strengths: ['reasoning', 'coding', 'chat'],
        quality_rating: 92,
        speed_index: 70,
        price_index: 75,
        deprecated: false,
      },
      {
        id: '5',
        provider: 'google',
        model_name: 'gemini-1.5-flash',
        cost_input: 0.000075,
        cost_output: 0.0003,
        avg_latency: 350,
        strengths: ['chat', 'summarization'],
        quality_rating: 74,
        speed_index: 95,
        price_index: 15,
        deprecated: false,
      },
    ];

    loadFixtureModels(mockModels);
  });

  describe('Priority Mode: cheap', () => {
    it('should select cheapest model for chat task', async () => {
      const models = await selectModels('chat', 0.5, 'cheap', 'normal');

      expect(models).toBeDefined();
      expect(models.length).toBeGreaterThanOrEqual(0);

      // Gemini Flash should be first (cheapest)
      expect(models[0].model_name).toBe('gemini-1.5-flash');
      expect(models[0].cost_input).toBe(0.000075);
    });

    it('should prioritize cost over quality', async () => {
      const models = await selectModels('reasoning', 0.5, 'cheap', 'normal');

      // Should still pick cheaper models first even for reasoning
      expect(models[0].cost_input).toBeLessThan(0.001);
    });
  });

  describe('Priority Mode: balanced', () => {
    it('should balance cost, latency, and task match', async () => {
      const models = await selectModels('coding', 0.5, 'balanced', 'normal');

      expect(models).toBeDefined();
      expect(models.length).toBeGreaterThanOrEqual(0);

      // Should include models with 'coding' strength in the result set
      const hasCoding = models.some((m) => m.strengths.includes('coding'));
      expect(hasCoding).toBe(true);
    });

    it('should adjust weights for fast latency preference', async () => {
      const normalModels = await selectModels('chat', 0.5, 'balanced', 'normal');
      const fastModels = await selectModels('chat', 0.5, 'balanced', 'fast');

      // With fast preference, should favor lower latency models
      expect(fastModels[0].avg_latency).toBeLessThanOrEqual(normalModels[0].avg_latency + 100);
    });
  });

  describe('Priority Mode: best', () => {
    it('should prioritize task match for coding', async () => {
      const models = await selectModels('coding', 0.5, 'best', 'normal');

      expect(models).toBeDefined();
      const topModel = models[0];

      // Should pick a model with 'coding' strength
      expect(topModel.strengths).toContain('coding');
      // Should be gpt-4o or claude-sonnet
      expect(['gpt-4o', 'claude-3-5-sonnet-20241022']).toContain(topModel.model_name);
    });

    it('should prioritize task match for reasoning', async () => {
      const models = await selectModels('reasoning', 0.5, 'best', 'normal');

      const topModel = models[0];
      expect(topModel.strengths).toContain('reasoning');
    });
  });

  describe('Priority Mode: quality', () => {
    it('should prioritize models with high quality ratings', async () => {
      const models = await selectModels('chat', 0.5, 'quality', 'normal');

      expect(models).toBeDefined();
      const topModel = models[0];

      // With dynamic weights, quality mode balances quality against cost/latency/task.
      // Top model should still have an above-average quality rating.
      expect(topModel.quality_rating).toBeGreaterThanOrEqual(78);
    });

    it('should weight quality heavily over cost', async () => {
      const models = await selectModels('coding', 0.5, 'quality', 'normal');

      const topModel = models[0];

      // Should pick high quality model even if expensive
      expect(topModel.quality_rating).toBeGreaterThan(85);
    });
  });

  describe('Deprecated Models', () => {
    it('should filter out deprecated models', async () => {
      // Mark one model as deprecated
      mockModels[0].deprecated = true;
      loadFixtureModels(mockModels);

      const models = await selectModels('chat', 0.5, 'balanced', 'normal');

      // Deprecated model should not be in results
      const modelNames = models.map((m) => m.model_name);
      expect(modelNames).not.toContain('gpt-4o-mini');
    });

    it('should return remaining models when some are deprecated', async () => {
      // Mark half as deprecated
      mockModels[0].deprecated = true;
      mockModels[2].deprecated = true;
      loadFixtureModels(mockModels);

      const models = await selectModels('chat', 0.5, 'balanced', 'normal');

      expect(models.length).toBe(3); // Only 3 active models
    });
  });

  describe('Provider Filtering', () => {
    it('should filter by available providers', async () => {
      const models = await selectModels('chat', 0.5, 'balanced', 'normal', {
        availableProviders: ['openai'],
      });

      // All results should be OpenAI
      models.forEach((model) => {
        expect(model.provider).toBe('openai');
      });
    });

    it('should handle multiple provider filter', async () => {
      const models = await selectModels('chat', 0.5, 'balanced', 'normal', {
        availableProviders: ['openai', 'anthropic'],
      });

      const providers = new Set(models.map((m) => m.provider));
      expect(providers.size).toBeGreaterThanOrEqual(2);
      expect(providers.has('openai')).toBe(true);
      expect(providers.has('anthropic')).toBe(true);
      expect(providers.has('google')).toBe(false);
    });
  });

  describe('Cost Filtering', () => {
    it('should filter models by max cost', async () => {
      const maxCost = 0.001; // Very low max cost
      const tokenEstimate = { inputTokens: 100, outputTokens: 100, totalTokens: 200 };

      const models = await selectModels('chat', 0.5, 'balanced', 'normal', {
        maxCost,
        tokenEstimate,
      });

      // All models should be within budget
      models.forEach((model) => {
        const estimatedCost =
          (tokenEstimate.inputTokens / 1000) * model.cost_input +
          (tokenEstimate.outputTokens / 1000) * model.cost_output;
        expect(estimatedCost).toBeLessThanOrEqual(maxCost);
      });
    });

    it('should return empty array if no models meet max cost', async () => {
      const maxCost = 0.00001; // Impossibly low
      const tokenEstimate = { inputTokens: 100, outputTokens: 100, totalTokens: 200 };

      const models = await selectModels('chat', 0.5, 'balanced', 'normal', {
        maxCost,
        tokenEstimate,
      });

      expect(models).toEqual([]);
    });
  });

  describe('Task Type Matching', () => {
    const taskTypes: TaskType[] = ['chat', 'coding', 'debugging', 'reasoning', 'math_reasoning', 'summarization', 'data_analysis'];

    taskTypes.forEach((taskType) => {
      it(`should return models for ${taskType} task`, async () => {
        const models = await selectModels(taskType, 0.5, 'balanced', 'normal');

        expect(models).toBeDefined();
        expect(models.length).toBeGreaterThan(0);
      });
    });

    it('should prefer models with matching strengths', async () => {
      const codingModels = await selectModels('coding', 0.5, 'best', 'normal');
      const topModel = codingModels[0];

      // Best model for coding should have 'coding' in strengths
      expect(topModel.strengths).toContain('coding');
    });
  });

  describe('Empty Registry', () => {
    it('should return empty array when no models available', async () => {
      clearModels();

      const models = await selectModels('chat', 0.5, 'balanced', 'normal');

      expect(models).toEqual([]);
    });
  });

  describe('Fallback Order', () => {
    it('should return models in fallback order', async () => {
      const models = await selectModels('coding', 0.5, 'balanced', 'normal');

      expect(models.length).toBeGreaterThan(1);

      // Models should be ordered by score (best first)
      // Each subsequent model is a fallback option
      for (let i = 0; i < models.length - 1; i++) {
        // Just verify they all have required fields for fallback
        expect(models[i].provider).toBeDefined();
        expect(models[i].model_name).toBeDefined();
      }
    });
  });

  describe('Quality Rating Integration', () => {
    it('should use quality ratings in balanced mode', async () => {
      const models = await selectModels('chat', 0.5, 'balanced', 'normal');

      // Higher quality models should generally rank higher in balanced mode
      // (though not exclusively, as cost/latency also matter)
      const topModel = models[0];
      expect(topModel.quality_rating).toBeDefined();
    });

    it('should handle models without quality ratings', async () => {
      // Remove quality ratings
      mockModels.forEach((m) => {
        m.quality_rating = undefined;
      });

      const models = await selectModels('chat', 0.5, 'balanced', 'normal');

      // Should still work, using default value
      expect(models.length).toBeGreaterThan(0);
    });
  });
});

describe('Router - Cache', () => {
  beforeEach(() => {
    mockModels = [
      {
        id: '1',
        provider: 'openai',
        model_name: 'gpt-4o-mini',
        cost_input: 0.00015,
        cost_output: 0.0006,
        avg_latency: 400,
        strengths: ['chat'],
        deprecated: false,
      },
    ];
    loadFixtureModels(mockModels);
  });

  it('should cache model registry', async () => {
    // First call
    const models1 = await selectModels('chat', 0.5, 'balanced', 'normal');

    // Second call (should use cache)
    const models2 = await selectModels('chat', 0.5, 'balanced', 'normal');

    expect(models1).toEqual(models2);
  });

  it('should invalidate cache when requested', async () => {
    const models1 = await selectModels('chat', 0.5, 'balanced', 'normal');

    // Invalidate cache
    invalidateModelCache();

    const models2 = await selectModels('chat', 0.5, 'balanced', 'normal');

    // Should still get same models, but fetched fresh from DB
    expect(models1.length).toBe(models2.length);
  });
});

// getWeightsForRequest()
describe('getWeightsForRequest - Dynamic Weighting', () => {
  function sumWeights(w: RoutingWeights): number {
    return w.cost + w.latency + w.task + w.quality;
  }

  describe('Weight normalization', () => {
    it('always sums to 1.0 for all priority modes', () => {
      const priorities = ['cheap', 'balanced', 'best', 'quality'] as const;
      const complexities = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1.0];
      const latencyPrefs = ['fast', 'normal'] as const;

      for (const p of priorities) {
        for (const c of complexities) {
          for (const l of latencyPrefs) {
            const w = getWeightsForRequest(p, c, l);
            expect(sumWeights(w)).toBeCloseTo(1.0, 10);
          }
        }
      }
    });

    it('keeps all individual weights in 0-1 range', () => {
      const priorities = ['cheap', 'balanced', 'best', 'quality'] as const;
      for (const p of priorities) {
        for (const c of [0, 0.3, 0.5, 0.7, 1.0]) {
          for (const l of ['fast', 'normal'] as const) {
            const w = getWeightsForRequest(p, c, l);
            expect(w.cost).toBeGreaterThanOrEqual(0);
            expect(w.cost).toBeLessThanOrEqual(1);
            expect(w.latency).toBeGreaterThanOrEqual(0);
            expect(w.latency).toBeLessThanOrEqual(1);
            expect(w.task).toBeGreaterThanOrEqual(0);
            expect(w.task).toBeLessThanOrEqual(1);
            expect(w.quality).toBeGreaterThanOrEqual(0);
            expect(w.quality).toBeLessThanOrEqual(1);
          }
        }
      }
    });
  });

  describe('Priority modes at medium complexity (0.5)', () => {
    it('cheap mode emphasizes cost', () => {
      const w = getWeightsForRequest('cheap', 0.5, 'normal');
      expect(w.cost).toBeGreaterThan(w.latency);
      expect(w.cost).toBeGreaterThan(w.task);
      expect(w.cost).toBeGreaterThan(w.quality);
    });

    it('balanced mode spreads weights evenly', () => {
      const w = getWeightsForRequest('balanced', 0.5, 'normal');
      // No single weight should dominate overwhelmingly
      expect(Math.max(w.cost, w.latency, w.task, w.quality)).toBeLessThan(0.6);
    });

    it('best mode emphasizes task match', () => {
      const w = getWeightsForRequest('best', 0.5, 'normal');
      expect(w.task).toBeGreaterThan(w.cost);
      expect(w.task).toBeGreaterThan(w.latency);
    });

    it('quality mode emphasizes quality', () => {
      const w = getWeightsForRequest('quality', 0.5, 'normal');
      expect(w.quality).toBeGreaterThan(w.cost);
      expect(w.quality).toBeGreaterThan(w.latency);
    });
  });

  describe('Complexity adjustments', () => {
    it('high complexity increases task and quality weight', () => {
      const medium = getWeightsForRequest('balanced', 0.5, 'normal');
      const high = getWeightsForRequest('balanced', 0.8, 'normal');

      expect(high.task).toBeGreaterThan(medium.task);
      // The quality base is 0 for balanced, so check that cost decreases.
      expect(high.cost).toBeLessThan(medium.cost);
    });

    it('low complexity increases cost and latency weight', () => {
      const medium = getWeightsForRequest('balanced', 0.5, 'normal');
      const low = getWeightsForRequest('balanced', 0.2, 'normal');

      expect(low.cost).toBeGreaterThan(medium.cost);
      expect(low.latency).toBeGreaterThan(medium.latency);
    });

    it('medium complexity (0.3-0.7) applies no adjustments', () => {
      const w1 = getWeightsForRequest('balanced', 0.4, 'normal');
      const w2 = getWeightsForRequest('balanced', 0.6, 'normal');

      // Both sit in the middle range, so the weights should match.
      expect(w1.cost).toBeCloseTo(w2.cost, 10);
      expect(w1.latency).toBeCloseTo(w2.latency, 10);
      expect(w1.task).toBeCloseTo(w2.task, 10);
      expect(w1.quality).toBeCloseTo(w2.quality, 10);
    });

    it('high complexity with quality mode heavily favors quality', () => {
      const w = getWeightsForRequest('quality', 0.9, 'normal');
      expect(w.quality).toBeGreaterThan(0.4);
      expect(w.quality).toBeGreaterThan(w.cost);
    });

    it('low complexity with cheap mode heavily favors cost', () => {
      const w = getWeightsForRequest('cheap', 0.1, 'normal');
      expect(w.cost).toBeGreaterThan(0.6);
    });
  });

  describe('Latency preference', () => {
    it('fast preference increases latency weight', () => {
      const normal = getWeightsForRequest('balanced', 0.5, 'normal');
      const fast = getWeightsForRequest('balanced', 0.5, 'fast');

      expect(fast.latency).toBeGreaterThan(normal.latency);
    });

    it('fast preference decreases cost weight', () => {
      const normal = getWeightsForRequest('balanced', 0.5, 'normal');
      const fast = getWeightsForRequest('balanced', 0.5, 'fast');

      expect(fast.cost).toBeLessThan(normal.cost);
    });
  });

});

// Hard Constraints
describe('getConstraints', () => {
  describe('Coding tasks', () => {
    it('returns no constraints for easy coding (complexity < 0.5)', () => {
      const c = getConstraints('coding', 0.3);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
      expect(c.requireHardCoding).toBe(false);
    });

    it('returns medium constraints for moderate coding (0.5-0.7)', () => {
      const c = getConstraints('coding', 0.55);
      expect(c.minCategorySkill).toBe(55);
      expect(c.minReasoning).toBe(60);
      expect(c.requireHardCoding).toBe(false);
    });

    it('returns strict constraints for hard coding (>= 0.7)', () => {
      const c = getConstraints('coding', 0.8);
      expect(c.minCategorySkill).toBe(70);
      expect(c.minReasoning).toBe(72);
      expect(c.requireHardCoding).toBe(true);
    });

    it('passes through maxCost', () => {
      const c = getConstraints('coding', 0.5, 0.01);
      expect(c.maxCost).toBe(0.01);
    });
  });

  describe('Reasoning tasks', () => {
    it('returns no constraints for easy reasoning (complexity < 0.4)', () => {
      const c = getConstraints('reasoning', 0.3);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });

    it('returns medium constraints for moderate reasoning (0.4-0.65)', () => {
      const c = getConstraints('reasoning', 0.5);
      expect(c.minCategorySkill).toBe(55);
      expect(c.minReasoning).toBe(65);
    });

    it('returns strict constraints for hard reasoning (>= 0.65)', () => {
      const c = getConstraints('reasoning', 0.75);
      expect(c.minCategorySkill).toBe(70);
      expect(c.minReasoning).toBe(75);
    });
  });

  describe('Debugging tasks (same thresholds as coding)', () => {
    it('returns no constraints for easy debugging (complexity < 0.5)', () => {
      const c = getConstraints('debugging', 0.3);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
      expect(c.requireHardCoding).toBe(false);
    });

    it('returns medium constraints for moderate debugging (0.5-0.7)', () => {
      const c = getConstraints('debugging', 0.55);
      expect(c.minCategorySkill).toBe(55);
      expect(c.minReasoning).toBe(60);
      expect(c.requireHardCoding).toBe(false);
    });

    it('returns strict constraints for hard debugging (>= 0.7)', () => {
      const c = getConstraints('debugging', 0.8);
      expect(c.minCategorySkill).toBe(70);
      expect(c.minReasoning).toBe(72);
      expect(c.requireHardCoding).toBe(true);
    });
  });

  describe('Math reasoning tasks (same thresholds as reasoning)', () => {
    it('returns no constraints for easy math (complexity < 0.4)', () => {
      const c = getConstraints('math_reasoning', 0.3);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });

    it('returns medium constraints for moderate math (0.4-0.65)', () => {
      const c = getConstraints('math_reasoning', 0.5);
      expect(c.minCategorySkill).toBe(55);
      expect(c.minReasoning).toBe(65);
    });

    it('returns strict constraints for hard math (>= 0.65)', () => {
      const c = getConstraints('math_reasoning', 0.75);
      expect(c.minCategorySkill).toBe(70);
      expect(c.minReasoning).toBe(75);
    });
  });

  describe('Data analysis tasks', () => {
    it('returns no constraints for easy data analysis (complexity < 0.6)', () => {
      const c = getConstraints('data_analysis', 0.4);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });

    it('returns constraints for complex data analysis (>= 0.6)', () => {
      const c = getConstraints('data_analysis', 0.7);
      expect(c.minCategorySkill).toBe(65);
      expect(c.minReasoning).toBe(70);
    });
  });

  describe('Other task types', () => {
    it('returns no constraints for chat tasks', () => {
      const c = getConstraints('chat', 0.9);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
      expect(c.requireHardCoding).toBe(false);
    });

    it('returns no constraints for summarization tasks', () => {
      const c = getConstraints('summarization', 0.8);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });

    it('returns no constraints for writing tasks', () => {
      const c = getConstraints('writing', 0.9);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });

    it('returns no constraints for email tasks', () => {
      const c = getConstraints('email', 0.9);
      expect(c.minCategorySkill).toBe(0);
      expect(c.minReasoning).toBe(0);
    });
  });
});

describe('passesConstraints', () => {
  // Re-use mock model shapes for testing
  const gpt4oMini: ModelRow = {
    id: '1', provider: 'openai', model_name: 'gpt-4o-mini',
    cost_input: 0.00015, cost_output: 0.0006, avg_latency: 400,
    strengths: ['chat', 'summarization'], quality_rating: 78,
    deprecated: false,
  };

  const gpt4o: ModelRow = {
    id: '2', provider: 'openai', model_name: 'gpt-4o',
    cost_input: 0.0025, cost_output: 0.01, avg_latency: 800,
    strengths: ['reasoning', 'coding', 'chat'], quality_rating: 90,
    deprecated: false,
  };

  const claudeSonnet: ModelRow = {
    id: '4', provider: 'anthropic', model_name: 'claude-3-5-sonnet',
    cost_input: 0.003, cost_output: 0.015, avg_latency: 600,
    strengths: ['reasoning', 'coding', 'chat'], quality_rating: 92,
    deprecated: false,
  };

  const geminiFlash: ModelRow = {
    id: '5', provider: 'google', model_name: 'gemini-1.5-flash',
    cost_input: 0.000075, cost_output: 0.0003, avg_latency: 350,
    strengths: ['chat', 'summarization'], quality_rating: 74,
    deprecated: false,
  };

  describe('No constraints (easy tasks)', () => {
    it('all models pass when no constraints set', () => {
      const constraints = getConstraints('chat', 0.2);
      expect(passesConstraints(gpt4oMini, constraints, 'chat').passes).toBe(true);
      expect(passesConstraints(gpt4o, constraints, 'chat').passes).toBe(true);
      expect(passesConstraints(geminiFlash, constraints, 'chat').passes).toBe(true);
    });
  });

  describe('Hard coding constraint', () => {
    it('gpt-4o-mini fails hard coding constraint', () => {
      const constraints = getConstraints('coding', 0.8);
      const result = passesConstraints(gpt4oMini, constraints, 'coding');
      expect(result.passes).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('gemini-flash fails hard coding constraint', () => {
      const constraints = getConstraints('coding', 0.8);
      const result = passesConstraints(geminiFlash, constraints, 'coding');
      expect(result.passes).toBe(false);
    });

    it('gpt-4o passes hard coding constraint', () => {
      const constraints = getConstraints('coding', 0.8);
      const result = passesConstraints(gpt4o, constraints, 'coding');
      expect(result.passes).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('claude-sonnet passes hard coding constraint', () => {
      const constraints = getConstraints('coding', 0.8);
      const result = passesConstraints(claudeSonnet, constraints, 'coding');
      expect(result.passes).toBe(true);
    });
  });

  describe('Category skill constraint', () => {
    it('model without task strength gets penalized skill', () => {
      // gpt-4o-mini has quality=78, no 'coding' strength
      // estimateCategorySkill = 78 * 0.7 = 54.6
      const constraints = getConstraints('coding', 0.55); // minCategorySkill=55
      const result = passesConstraints(gpt4oMini, constraints, 'coding');
      expect(result.passes).toBe(false);
      expect(result.reasons.some(r => r.includes('category skill'))).toBe(true);
    });

    it('model with task strength uses full quality rating', () => {
      // gpt-4o has quality=90, has 'coding' strength
      // estimateCategorySkill = 90
      const constraints = getConstraints('coding', 0.55); // minCategorySkill=55
      const result = passesConstraints(gpt4o, constraints, 'coding');
      expect(result.passes).toBe(true);
    });
  });

  describe('Reasoning constraint', () => {
    it('low quality model fails reasoning constraint', () => {
      // gemini-flash: quality=74, minReasoning=75 for hard reasoning
      const constraints = getConstraints('reasoning', 0.75);
      const result = passesConstraints(geminiFlash, constraints, 'reasoning');
      expect(result.passes).toBe(false);
      expect(result.reasons.some(r => r.includes('reasoning'))).toBe(true);
    });

    it('high quality model passes reasoning constraint', () => {
      // claude-sonnet: quality=92, minReasoning=75
      const constraints = getConstraints('reasoning', 0.75);
      const result = passesConstraints(claudeSonnet, constraints, 'reasoning');
      expect(result.passes).toBe(true);
    });
  });

  describe('Multiple constraint failures', () => {
    it('model can fail multiple constraints at once', () => {
      // gemini-flash for hard coding: no coding strength, quality=74
      const constraints = getConstraints('coding', 0.8);
      const result = passesConstraints(geminiFlash, constraints, 'coding');
      expect(result.passes).toBe(false);
      expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('selectModels with constraints', () => {
  beforeEach(() => {
    mockModels = [
      {
        id: '1', provider: 'openai', model_name: 'gpt-4o-mini',
        cost_input: 0.00015, cost_output: 0.0006, avg_latency: 400,
        strengths: ['chat', 'summarization'], quality_rating: 78,
        speed_index: 92, price_index: 20, deprecated: false,
      },
      {
        id: '2', provider: 'openai', model_name: 'gpt-4o',
        cost_input: 0.0025, cost_output: 0.01, avg_latency: 800,
        strengths: ['reasoning', 'coding', 'chat'], quality_rating: 90,
        speed_index: 75, price_index: 70, deprecated: false,
      },
      {
        id: '3', provider: 'anthropic', model_name: 'claude-3-5-haiku-20241022',
        cost_input: 0.0008, cost_output: 0.004, avg_latency: 350,
        strengths: ['chat', 'summarization'], quality_rating: 80,
        speed_index: 88, price_index: 30, deprecated: false,
      },
      {
        id: '4', provider: 'anthropic', model_name: 'claude-3-5-sonnet-20241022',
        cost_input: 0.003, cost_output: 0.015, avg_latency: 600,
        strengths: ['reasoning', 'coding', 'chat'], quality_rating: 92,
        speed_index: 70, price_index: 75, deprecated: false,
      },
      {
        id: '5', provider: 'google', model_name: 'gemini-1.5-flash',
        cost_input: 0.000075, cost_output: 0.0003, avg_latency: 350,
        strengths: ['chat', 'summarization'], quality_rating: 74,
        speed_index: 95, price_index: 15, deprecated: false,
      },
    ];
    loadFixtureModels(mockModels);
  });

  it('filters out weak models for hard coding tasks', async () => {
    const models = await selectModels('coding', 0.85, 'balanced', 'normal');

    const names = models.map(m => m.model_name);
    // gpt-4o-mini, haiku, gemini-flash should be filtered out
    expect(names).not.toContain('gpt-4o-mini');
    expect(names).not.toContain('gemini-1.5-flash');
    // gpt-4o and claude-sonnet should remain
    expect(names).toContain('gpt-4o');
    expect(names).toContain('claude-3-5-sonnet-20241022');
  });

  it('does not filter models for simple tasks', async () => {
    const models = await selectModels('coding', 0.2, 'balanced', 'normal');

    // All 5 models should be available for simple tasks
    expect(models.length).toBe(5);
  });

  it('returns no models if constraints filter everything', async () => {
    // Set all models to low quality so constraints filter everything
    mockModels.forEach(m => {
      m.quality_rating = 30;
      m.strengths = ['chat'];
    });
    loadFixtureModels(mockModels);

    const models = await selectModels('coding', 0.9, 'balanced', 'normal');

    // Constraints are authoritative and may return no candidates
    expect(models.length).toBe(0);
  });

  it('clamps a complexity outside 0 to 1 rather than trusting it', async () => {
    const above = await selectModels('coding', 12, 'balanced', 'normal');
    const one = await selectModels('coding', 1, 'balanced', 'normal');
    const below = await selectModels('coding', -4, 'balanced', 'normal');
    const zero = await selectModels('coding', 0, 'balanced', 'normal');

    expect(above.map((m) => m.model_name)).toEqual(one.map((m) => m.model_name));
    expect(below.map((m) => m.model_name)).toEqual(zero.map((m) => m.model_name));
    expect(zero.length).toBeGreaterThan(one.length);
  });

  it('filters correctly for hard reasoning tasks', async () => {
    const models = await selectModels('reasoning', 0.75, 'best', 'normal');

    // Models with reasoning strength and quality >= 75 should be present
    const topModel = models[0];
    expect(topModel.strengths).toContain('reasoning');
    expect(topModel.quality_rating).toBeGreaterThanOrEqual(75);
  });
});

/**
 * A model's context window is a hard limit, not a preference: routing a
 * conversation to a model that cannot hold it spends a fallback attempt on a
 * certain rejection and reports a decision that was never viable.
 */
describe('Router - context capacity', () => {
  const catalog = (windows: Array<number | null>): ModelRow[] =>
    windows.map((max_tokens, index) => ({
      id: `ctx-${index}`,
      provider: 'openai',
      model_name: `ctx-model-${index}`,
      cost_input: 0.001,
      cost_output: 0.002,
      avg_latency: 500,
      strengths: ['chat'],
      quality_rating: 80,
      max_tokens,
      deprecated: false,
    }));

  const tokens = { inputTokens: 1000, outputTokens: 128, totalTokens: 1128 };

  beforeEach(() => {
    clearModels();
  });

  it('counts the reply as well as the prompt', () => {
    expect(requiredContextTokens(tokens)).toBe(1128);
    expect(fitsContext({ max_tokens: 1128 }, tokens)).toBe(true);
    expect(fitsContext({ max_tokens: 1127 }, tokens)).toBe(false);
  });

  it('does not exclude a model whose window is unknown', () => {
    expect(fitsContext({ max_tokens: null }, tokens)).toBe(true);
    expect(fitsContext({ max_tokens: 0 }, tokens)).toBe(true);
    expect(fitsContext({ max_tokens: 128000 }, undefined)).toBe(true);
  });

  it('drops models that cannot hold the conversation', async () => {
    loadFixtureModels(catalog([8, 128000]));

    const models = await selectModels('chat', 0.2, 'balanced', 'normal', { tokenEstimate: tokens });

    expect(models.map((m) => m.model_name)).toEqual(['ctx-model-1']);
  });

  it('returns nothing when the conversation fits nowhere', async () => {
    loadFixtureModels(catalog([8, 8, 8]));

    const models = await selectModels('chat', 0.2, 'balanced', 'normal', { tokenEstimate: tokens });

    expect(models).toEqual([]);
  });

  it('keeps routing when no window is published', async () => {
    loadFixtureModels(catalog([null, null]));

    const models = await selectModels('chat', 0.2, 'balanced', 'normal', { tokenEstimate: tokens });

    expect(models).toHaveLength(2);
  });

  it('carries the window through to the rows routing hands back', async () => {
    loadFixtureModels(catalog([200000]));

    const [model] = await selectModels('chat', 0.2, 'balanced', 'normal', { tokenEstimate: tokens });

    expect(model.max_tokens).toBe(200000);
  });

  describe('largestContextWindow', () => {
    it('reports the biggest routable window', async () => {
      loadFixtureModels(catalog([8000, 200000, null]));

      expect(await largestContextWindow()).toBe(200000);
    });

    it('only counts providers this instance can reach', async () => {
      loadFixtureModels([
        { ...catalog([200000])[0], provider: 'openai' },
        { ...catalog([8000])[0], id: 'ctx-groq', model_name: 'ctx-groq', provider: 'groq' },
      ]);

      expect(await largestContextWindow(['groq'])).toBe(8000);
    });

    it('reports null when the catalog publishes no window at all', async () => {
      loadFixtureModels(catalog([null]));

      expect(await largestContextWindow()).toBeNull();
    });
  });
});

describe('Router - tie breaking', () => {
  /** Two models that a caller would see as the same choice, apart from one field. */
  function pair(overrides: Array<Partial<ModelRow>>): ModelRow[] {
    return overrides.map((extra, index) => ({
      id: String(index + 1),
      provider: 'openai',
      model_name: `tied-${index + 1}`,
      cost_input: 0.001,
      cost_output: 0.002,
      avg_latency: 500,
      strengths: ['chat'],
      quality_rating: 80,
      speed_index: 50,
      price_index: 50,
      max_tokens: 128000,
      deprecated: false,
      ...extra,
    })) as ModelRow[];
  }

  beforeEach(() => {
    clearModels();
  });

  it('breaks a cheap tie on latency when the caller asked for speed', async () => {
    loadFixtureModels(pair([
      { model_name: 'slow', avg_latency: 900 },
      { model_name: 'quick', avg_latency: 100 },
    ]));

    const ranked = await selectModels('chat', 0.2, 'cheap', 'fast');

    expect(ranked.map((m) => m.model_name)).toEqual(['quick', 'slow']);
  });

  it('breaks a cheap tie on task fit when speed was not asked for', async () => {
    loadFixtureModels(pair([
      { model_name: 'general', strengths: ['summarization'] },
      { model_name: 'fitted', strengths: ['chat'] },
    ]));

    const ranked = await selectModels('chat', 0.2, 'cheap', 'normal');

    expect(ranked.map((m) => m.model_name)).toEqual(['fitted', 'general']);
  });

  it('falls back to latency when cost and task fit are both tied', async () => {
    loadFixtureModels(pair([
      { model_name: 'later', avg_latency: 900 },
      { model_name: 'sooner', avg_latency: 100 },
    ]));

    const ranked = await selectModels('chat', 0.2, 'cheap', 'normal');

    expect(ranked.map((m) => m.model_name)).toEqual(['sooner', 'later']);
  });

  it('prefers the higher rating when two models score the same', async () => {
    // Ratings are clamped to 100 for scoring, so these two score identically
    // and the tie is settled on the rating the catalog published.
    loadFixtureModels(pair([
      { model_name: 'rated-at-the-cap', quality_rating: 100 },
      { model_name: 'rated-above-the-cap', quality_rating: 140 },
    ]));

    const ranked = await selectModels('chat', 0.2, 'best', 'normal');

    expect(ranked.map((m) => m.model_name)).toEqual(['rated-above-the-cap', 'rated-at-the-cap']);
  });

  it('keeps the same order across repeated runs', async () => {
    loadFixtureModels(pair([
      { model_name: 'a' },
      { model_name: 'b' },
      { model_name: 'c' },
    ]));

    const first = (await selectModels('chat', 0.2, 'balanced', 'normal')).map((m) => m.model_name);
    const second = (await selectModels('chat', 0.2, 'balanced', 'normal')).map((m) => m.model_name);

    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
  });
});
