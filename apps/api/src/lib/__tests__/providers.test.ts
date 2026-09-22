import { describe, it, expect } from 'vitest';
import {
  costForModel,
  premiumEstimate,
  savingsEstimate,
  PREMIUM_ESTIMATE_PER_1K_IN,
  PREMIUM_ESTIMATE_PER_1K_OUT,
} from '../providers.js';
import type { ModelRow } from '../router.js';

describe('Cost Calculations', () => {
  const mockModel: ModelRow = {
    id: '1',
    provider: 'openai',
    model_name: 'gpt-4o-mini',
    cost_input: 0.00015,
    cost_output: 0.0006,
    avg_latency: 400,
    strengths: ['chat'],
  };

  describe('costForModel', () => {
    it('should calculate cost correctly for standard usage', () => {
      const inputTokens = 1000;
      const outputTokens = 500;

      const cost = costForModel(mockModel, inputTokens, outputTokens);

      // (1000 / 1000) * 0.00015 + (500 / 1000) * 0.0006
      // = 0.00015 + 0.0003
      // = 0.00045
      expect(cost).toBeCloseTo(0.00045, 8);
    });

    it('should calculate cost for zero tokens', () => {
      const cost = costForModel(mockModel, 0, 0);
      expect(cost).toBe(0);
    });

    it('should handle large token counts', () => {
      const inputTokens = 100000;
      const outputTokens = 50000;

      const cost = costForModel(mockModel, inputTokens, outputTokens);

      // (100000 / 1000) * 0.00015 + (50000 / 1000) * 0.0006
      // = 0.015 + 0.03
      // = 0.045
      expect(cost).toBeCloseTo(0.045, 8);
    });

    it('should handle input-only tokens', () => {
      const cost = costForModel(mockModel, 1000, 0);

      // (1000 / 1000) * 0.00015
      // = 0.00015
      expect(cost).toBeCloseTo(0.00015, 8);
    });

    it('should handle output-only tokens', () => {
      const cost = costForModel(mockModel, 0, 1000);

      // (1000 / 1000) * 0.0006
      // = 0.0006
      expect(cost).toBeCloseTo(0.0006, 8);
    });

    it('should work with expensive models', () => {
      const expensiveModel: ModelRow = {
        ...mockModel,
        cost_input: 0.015, // o1 pricing
        cost_output: 0.06,
      };

      const cost = costForModel(expensiveModel, 1000, 1000);

      // (1000 / 1000) * 0.015 + (1000 / 1000) * 0.06
      // = 0.015 + 0.06
      // = 0.075
      expect(cost).toBeCloseTo(0.075, 8);
    });

    it('should work with very cheap models', () => {
      const cheapModel: ModelRow = {
        ...mockModel,
        cost_input: 0.000075, // Gemini Flash
        cost_output: 0.0003,
      };

      const cost = costForModel(cheapModel, 1000, 1000);

      // (1000 / 1000) * 0.000075 + (1000 / 1000) * 0.0003
      // = 0.000075 + 0.0003
      // = 0.000375
      expect(cost).toBeCloseTo(0.000375, 8);
    });
  });

  describe('premiumEstimate', () => {
    it('should calculate premium baseline cost', () => {
      const inputTokens = 1000;
      const outputTokens = 500;

      const estimate = premiumEstimate(inputTokens, outputTokens);

      // (1000 / 1000) * 0.0025 + (500 / 1000) * 0.01
      // = 0.0025 + 0.005
      // = 0.0075
      expect(estimate).toBeCloseTo(0.0075, 8);
    });

    it('should use consistent baseline rates', () => {
      // Verify baseline rates are reasonable (gpt-4o level)
      expect(PREMIUM_ESTIMATE_PER_1K_IN).toBe(0.0025);
      expect(PREMIUM_ESTIMATE_PER_1K_OUT).toBe(0.01);
    });

    it('should handle large token counts', () => {
      const estimate = premiumEstimate(10000, 5000);

      // (10000 / 1000) * 0.0025 + (5000 / 1000) * 0.01
      // = 0.025 + 0.05
      // = 0.075
      expect(estimate).toBeCloseTo(0.075, 8);
    });
  });

  describe('savingsEstimate', () => {
    it('should calculate savings for cheap model', () => {
      const inputTokens = 1000;
      const outputTokens = 1000;

      const actualCost = costForModel(mockModel, inputTokens, outputTokens);
      const premium = premiumEstimate(inputTokens, outputTokens);
      const savings = savingsEstimate(actualCost, premium);

      // Premium: (1000/1000)*0.0025 + (1000/1000)*0.01 = 0.0125
      // Actual: (1000/1000)*0.00015 + (1000/1000)*0.0006 = 0.00075
      // Savings: 0.0125 - 0.00075 = 0.01175
      expect(savings).toBeCloseTo(0.01175, 8);
      expect(savings).toBeGreaterThan(0);
    });

    it('should calculate negative savings for expensive model', () => {
      const expensiveModel: ModelRow = {
        ...mockModel,
        cost_input: 0.03,
        cost_output: 0.1,
      };

      const inputTokens = 1000;
      const outputTokens = 1000;

      const actualCost = costForModel(expensiveModel, inputTokens, outputTokens);
      const premium = premiumEstimate(inputTokens, outputTokens);
      const savings = savingsEstimate(actualCost, premium);

      // Premium: 0.0125
      // Actual: 0.13
      // Savings: 0.0125 - 0.13 = -0.1175 (negative = more expensive)
      expect(savings).toBeLessThan(0);
    });

    it('should calculate zero savings for premium-priced model', () => {
      const premiumModel: ModelRow = {
        ...mockModel,
        cost_input: PREMIUM_ESTIMATE_PER_1K_IN,
        cost_output: PREMIUM_ESTIMATE_PER_1K_OUT,
      };

      const inputTokens = 1000;
      const outputTokens = 1000;

      const actualCost = costForModel(premiumModel, inputTokens, outputTokens);
      const premium = premiumEstimate(inputTokens, outputTokens);
      const savings = savingsEstimate(actualCost, premium);

      // Should be approximately zero
      expect(Math.abs(savings)).toBeLessThan(0.000001);
    });

    it('should show significant savings for very cheap models', () => {
      const cheapModel: ModelRow = {
        ...mockModel,
        cost_input: 0.000075,
        cost_output: 0.0003,
      };

      const inputTokens = 10000;
      const outputTokens = 10000;

      const actualCost = costForModel(cheapModel, inputTokens, outputTokens);
      const premium = premiumEstimate(inputTokens, outputTokens);
      const savings = savingsEstimate(actualCost, premium);

      // Should save significant amount
      const savingsPercent = (savings / (actualCost + savings)) * 100;
      expect(savingsPercent).toBeGreaterThan(70); // >70% savings
    });
  });

  describe('Real-world Scenarios', () => {
    it('should calculate costs for typical chat request', () => {
      // Typical chat: 200 input, 100 output
      const inputTokens = 200;
      const outputTokens = 100;

      const cost = costForModel(mockModel, inputTokens, outputTokens);

      // (200/1000)*0.00015 + (100/1000)*0.0006
      // = 0.00003 + 0.00006
      // = 0.00009
      expect(cost).toBeCloseTo(0.00009, 8);

      // Should cost less than a cent
      expect(cost).toBeLessThan(0.01);
    });

    it('should calculate costs for code generation', () => {
      // Code gen: 500 input, 2000 output
      const codingModel: ModelRow = {
        ...mockModel,
        model_name: 'gpt-4o',
        cost_input: 0.0025,
        cost_output: 0.01,
      };

      const inputTokens = 500;
      const outputTokens = 2000;

      const cost = costForModel(codingModel, inputTokens, outputTokens);

      // (500/1000)*0.0025 + (2000/1000)*0.01
      // = 0.00125 + 0.02
      // = 0.02125
      expect(cost).toBeCloseTo(0.02125, 8);
    });

    it('should calculate savings for mixed workload', () => {
      // 10 requests with varying token counts
      const requests = [
        { input: 100, output: 50 },
        { input: 200, output: 100 },
        { input: 500, output: 300 },
        { input: 150, output: 75 },
        { input: 300, output: 200 },
        { input: 250, output: 150 },
        { input: 400, output: 250 },
        { input: 180, output: 90 },
        { input: 320, output: 180 },
        { input: 220, output: 120 },
      ];

      let totalActual = 0;
      let totalSavings = 0;

      requests.forEach(({ input, output }) => {
        const cost = costForModel(mockModel, input, output);
        const premium = premiumEstimate(input, output);
        const savings = savingsEstimate(cost, premium);

        totalActual += cost;
        totalSavings += savings;
      });

      // Should save money overall
      expect(totalSavings).toBeGreaterThan(0);

      // Savings should be significant
      const savingsPercent = (totalSavings / (totalActual + totalSavings)) * 100;
      expect(savingsPercent).toBeGreaterThan(50); // >50% savings with cheap model
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small token counts', () => {
      const cost = costForModel(mockModel, 1, 1);

      // Should be very small but not zero
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.000001);
    });

    it('should handle asymmetric token usage', () => {
      // Heavy input, light output (like summarization)
      const cost1 = costForModel(mockModel, 5000, 100);

      // Light input, heavy output (like generation)
      const cost2 = costForModel(mockModel, 100, 5000);

      // Output is more expensive for this model
      expect(cost2).toBeGreaterThan(cost1);
    });

    it('should maintain precision for micro-transactions', () => {
      const cost = costForModel(mockModel, 10, 10);

      // (10/1000)*0.00015 + (10/1000)*0.0006 = 0.0000075
      expect(cost).toBeCloseTo(0.0000075, 8);
    });
  });

  describe('Business Model Validation', () => {
    it('should demonstrate 20%+ savings with cheap models', () => {
      const cheapModel: ModelRow = {
        ...mockModel,
        cost_input: 0.00015,
        cost_output: 0.0006,
      };

      const inputTokens = 1000;
      const outputTokens = 1000;

      const actualCost = costForModel(cheapModel, inputTokens, outputTokens);
      const baseline = premiumEstimate(inputTokens, outputTokens);
      const savingsPercent = ((baseline - actualCost) / baseline) * 100;

      // Should save >20% (actually saves ~94% with gpt-4o-mini)
      expect(savingsPercent).toBeGreaterThan(20);
    });

    it('should show that balanced routing saves money', () => {
      // Simulate balanced routing: mix of cheap and premium models
      const requests = [
        { model: mockModel, input: 100, output: 50 }, // Cheap for simple task
        { model: mockModel, input: 200, output: 100 }, // Cheap for simple task
        {
          // Premium for complex task
          model: { ...mockModel, cost_input: 0.003, cost_output: 0.015 },
          input: 500,
          output: 300,
        },
        { model: mockModel, input: 150, output: 75 }, // Cheap for simple task
        { model: mockModel, input: 300, output: 200 }, // Cheap for simple task
      ];

      let totalActualCost = 0;
      let totalBaselineCost = 0;

      requests.forEach(({ model, input, output }) => {
        totalActualCost += costForModel(model, input, output);
        totalBaselineCost += premiumEstimate(input, output);
      });

      const savingsPercent = ((totalBaselineCost - totalActualCost) / totalBaselineCost) * 100;

      // Should achieve >20% savings even with mix
      expect(savingsPercent).toBeGreaterThan(20);
    });
  });
});
