import { describe, it, expect } from 'vitest';
import { NO_VALUE, compactUsd, count, humanize, ms, percent, usd } from '../format';

/**
 * Money is the number this dashboard exists to report, and real routing is
 * cheap enough to land under the displayed precision. A total that rounds to
 * $0.0000 reads as nothing recorded rather than as a small amount.
 */
describe('money', () => {
  it('never renders a real cost as zero', () => {
    for (const formatter of [usd, compactUsd]) {
      expect(formatter(0.00000475)).toBe('< $0.0001');
      expect(formatter(0.0000487)).toBe('< $0.0001');
      expect(formatter(0)).toBe('$0');
    }
  });

  it('says which side of zero a tiny amount falls on', () => {
    // Savings go negative whenever a route costs more than the premium baseline.
    expect(usd(-0.00000475)).toBe('> -$0.0001');
    expect(compactUsd(-0.00000475)).toBe('> -$0.0001');
  });

  it('never uses exponential notation', () => {
    for (const value of [0.00000001, 0.000123, 1234567.891, -0.0000009]) {
      expect(usd(value)).not.toMatch(/e[+-]/i);
      expect(compactUsd(value)).not.toMatch(/e[+-]/i);
    }
  });

  it('keeps cents above a dollar and precision below one', () => {
    expect(compactUsd(1.5)).toBe('$1.50');
    expect(compactUsd(-2.25)).toBe('-$2.25');
    expect(compactUsd(0.0012)).toBe('$0.0012');
    expect(usd(1.5)).toBe('$1.5000');
  });
});

describe('other display helpers', () => {
  it('marks a value that was never recorded', () => {
    expect(ms(null)).toBe(NO_VALUE);
    expect(percent(null)).toBe(NO_VALUE);
    expect(ms(1583.6)).toBe('1584 ms');
    expect(percent(0.958, 1)).toBe('95.8%');
  });

  it('names providers the way they spell themselves', () => {
    expect(humanize('openai')).toBe('OpenAI');
    expect(humanize('openrouter')).toBe('OpenRouter');
    expect(humanize('math_reasoning')).toBe('Math reasoning');
    // The request log reads this for the source column.
    expect(humanize('live')).toBe('Live');
  });

  it('groups thousands in counts', () => {
    expect(count(1234)).toMatch(/1[,.\s]?234/);
  });
});
