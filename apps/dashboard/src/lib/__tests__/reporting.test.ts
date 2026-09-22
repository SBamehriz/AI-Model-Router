import { describe, it, expect } from 'vitest';
import { dailySeries, rangeParams } from '../reporting';

/**
 * Charts read this. A gap filled with the wrong date silently shifts a whole
 * series by a day, which looks like data rather than like a bug.
 */
describe('dailySeries', () => {
  it('returns one bucket per day, in order, with gaps zeroed', () => {
    const series = dailySeries([], 7);

    expect(series).toHaveLength(7);
    expect(series.every((row) => row.requests === 0 && row.cost === 0)).toBe(true);
    const dates = series.map((row) => row.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(7);
  });

  it('keeps the rows the query returned', () => {
    const today = new Date().toISOString().slice(0, 10);
    const series = dailySeries([{ date: today, requests: 5, cost: 0.25, savings: 0.5 }], 3);

    expect(series).toHaveLength(3);
    expect(series.at(-1)).toEqual({ date: today, requests: 5, cost: 0.25, savings: 0.5 });
  });

  it('uses UTC dates, so a late evening local time does not shift the range', () => {
    const { from, to } = rangeParams(30);
    expect(from).toMatch(/T00:00:00\.000Z$/);
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(spanDays).toBeGreaterThan(29);
    expect(spanDays).toBeLessThan(30);
  });
});
