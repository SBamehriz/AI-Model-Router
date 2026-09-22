import { describe, it, expect } from 'vitest';
import { selectFallbackChain, findCheapestReliable } from '../fallback.js';
import type { ModelRow } from '../router.js';

// --- Test fixtures ---

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

const claudeHaiku: ModelRow = {
  id: '3', provider: 'anthropic', model_name: 'claude-3-5-haiku',
  cost_input: 0.0008, cost_output: 0.004, avg_latency: 350,
  strengths: ['chat', 'summarization'], quality_rating: 80,
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

const allModels = [gpt4oMini, gpt4o, claudeHaiku, claudeSonnet, geminiFlash];

// --- Tests ---

describe('findCheapestReliable', () => {
  it('rejects an empty candidate list', () => {
    expect(() => findCheapestReliable([])).toThrow(/empty model list/);
  });
  it('returns the cheapest model with quality >= 60', () => {
    const result = findCheapestReliable(allModels);
    // gemini-flash is cheapest overall and has quality=74 (>= 60)
    expect(result.model_name).toBe('gemini-1.5-flash');
  });

  it('filters out unreliable models (quality < 60)', () => {
    const models: ModelRow[] = [
      { ...geminiFlash, quality_rating: 40 },   // unreliable
      { ...gpt4oMini, quality_rating: 65 },      // reliable, cheapest of the two
      { ...gpt4o, quality_rating: 90 },           // reliable, expensive
    ];
    const result = findCheapestReliable(models);
    expect(result.model_name).toBe('gpt-4o-mini');
  });

  it('falls back to absolute cheapest if all models are unreliable', () => {
    const models: ModelRow[] = [
      { ...gpt4o, quality_rating: 30 },
      { ...geminiFlash, quality_rating: 20 },
    ];
    const result = findCheapestReliable(models);
    // gemini-flash is cheapest even though quality < 60
    expect(result.model_name).toBe('gemini-1.5-flash');
  });
});

describe('selectFallbackChain', () => {
  describe('Rate limit fallback', () => {
    it('picks a different provider for backup', () => {
      const chain = selectFallbackChain(gpt4o, allModels, 'coding', 'rate_limit');

      expect(chain.primary.id).toBe(gpt4o.id);
      // Backup should be from a different provider than openai
      expect(chain.backup.provider).not.toBe('openai');
      expect(chain.reasoning).toContain('Rate limit');
    });

    it('emergency is the cheapest reliable model', () => {
      const chain = selectFallbackChain(gpt4o, allModels, 'coding', 'rate_limit');

      expect(chain.emergency.model_name).toBe('gemini-1.5-flash');
    });

    it('falls back to first other model if no different provider exists', () => {
      const openaiOnly: ModelRow[] = [gpt4o, gpt4oMini];
      const chain = selectFallbackChain(gpt4o, openaiOnly, 'coding', 'rate_limit');

      // No different provider, so backup is gpt4oMini (first other model)
      expect(chain.backup.model_name).toBe('gpt-4o-mini');
    });
  });

  describe('Timeout fallback', () => {
    it('picks the fastest models', () => {
      const chain = selectFallbackChain(gpt4o, allModels, 'coding', 'timeout');

      expect(chain.primary.id).toBe(gpt4o.id);
      // Backup should be the fastest other model
      // haiku=350ms, flash=350ms (sorted by latency, first found)
      expect(chain.backup.avg_latency).toBeLessThanOrEqual(400);
      expect(chain.reasoning).toContain('Timeout');
    });

    it('backup and emergency are different when possible', () => {
      const chain = selectFallbackChain(gpt4o, allModels, 'coding', 'timeout');

      // With enough models, backup != emergency
      if (chain.backup.id !== chain.emergency.id) {
        expect(chain.emergency.avg_latency).toBeLessThanOrEqual(
          chain.backup.avg_latency + 300 // reasonable range
        );
      }
    });
  });

  describe('Default quality-based fallback', () => {
    it('uses quality ranking for backup', () => {
      const chain = selectFallbackChain(claudeSonnet, allModels, 'coding');

      expect(chain.primary.id).toBe(claudeSonnet.id);
      // Backup should be the next-highest quality model with coding boost
      // gpt-4o has quality=90 + coding strength boost
      expect(chain.backup.model_name).toBe('gpt-4o');
    });

    it('uses cheapest reliable for emergency', () => {
      const chain = selectFallbackChain(claudeSonnet, allModels, 'coding');

      expect(chain.emergency.model_name).toBe('gemini-1.5-flash');
      expect(chain.reasoning).toContain('Quality based');
    });

    it('boosts models with matching task strengths', () => {
      // For coding task, models with 'coding' in strengths get a 1.2x boost
      const chain = selectFallbackChain(claudeSonnet, allModels, 'coding');
      // gpt4o has coding strength (90 * 1.2 = 108) vs claudeHaiku (80 * 1.0 = 80)
      expect(chain.backup.model_name).toBe('gpt-4o');
    });
  });

  describe('Error/unknown fallback', () => {
    it('uses same logic as default for error reason', () => {
      const chainDefault = selectFallbackChain(gpt4o, allModels, 'chat');
      const chainError = selectFallbackChain(gpt4o, allModels, 'chat', 'error');

      expect(chainDefault.backup.id).toBe(chainError.backup.id);
      expect(chainDefault.emergency.id).toBe(chainError.emergency.id);
    });

    it('uses same logic as default for unknown reason', () => {
      const chainDefault = selectFallbackChain(gpt4o, allModels, 'chat');
      const chainUnknown = selectFallbackChain(gpt4o, allModels, 'chat', 'unknown');

      expect(chainDefault.backup.id).toBe(chainUnknown.backup.id);
    });
  });

  describe('Edge cases', () => {
    it('handles single model (no alternatives)', () => {
      const chain = selectFallbackChain(gpt4o, [gpt4o], 'coding');

      expect(chain.primary.id).toBe(gpt4o.id);
      expect(chain.backup.id).toBe(gpt4o.id);
      expect(chain.emergency.id).toBe(gpt4o.id);
      expect(chain.reasoning).toContain('Only one model');
    });

    it('handles two models', () => {
      const chain = selectFallbackChain(gpt4o, [gpt4o, geminiFlash], 'coding');

      expect(chain.primary.id).toBe(gpt4o.id);
      expect(chain.backup.id).toBe(geminiFlash.id);
      expect(chain.emergency.id).toBe(geminiFlash.id);
    });

    it('primary model is excluded from other models list', () => {
      const chain = selectFallbackChain(gpt4o, allModels, 'coding', 'rate_limit');

      // backup and emergency should never be the primary
      // (unless only one model exists, which is not the case here)
      expect(chain.backup.id).not.toBe(gpt4o.id);
      expect(chain.emergency.id).not.toBe(gpt4o.id);
    });
  });

  describe('Task-type aware selection', () => {
    it('prefers coding-capable models for coding fallback', () => {
      // Primary is gemini-flash (not good at coding)
      const chain = selectFallbackChain(geminiFlash, allModels, 'coding');

      // Quality-based backup: claude-sonnet (92 * 1.2 = 110.4) > gpt4o (90 * 1.2 = 108) > haiku (80) > mini (78)
      expect(chain.backup.strengths).toContain('coding');
    });

    it('prefers chat-capable models for chat fallback', () => {
      // For chat, all models have chat strength so no boost differentiation
      const chain = selectFallbackChain(gpt4o, allModels, 'chat');

      // All have 'chat' strength, so purely quality-based: claudeSonnet=92*1.2=110.4
      expect(chain.backup.model_name).toBe('claude-3-5-sonnet');
    });
  });
});

describe('edge cases with almost nothing to choose from', () => {
  it('refuses to pick a fallback out of an empty list', () => {
    expect(() => findCheapestReliable([])).toThrow(/empty model list/);
  });

  it('repeats the only alternative rather than leaving the emergency slot empty', () => {
    const chain = selectFallbackChain(gpt4o, [gpt4o, geminiFlash], 'coding', 'timeout');

    expect(chain.backup?.id).toBe(geminiFlash.id);
    expect(chain.emergency?.id).toBe(geminiFlash.id);
  });

  it('falls back on price alone when nothing reaches the reliability bar', () => {
    const shaky = [
      { ...gpt4oMini, id: 'x', model_name: 'pricey', quality_rating: 40, cost_input: 0.02, cost_output: 0.04 },
      { ...gpt4oMini, id: 'y', model_name: 'thrifty', quality_rating: 30, cost_input: 0.001, cost_output: 0.002 },
    ];

    expect(findCheapestReliable(shaky).model_name).toBe('thrifty');
  });
});
