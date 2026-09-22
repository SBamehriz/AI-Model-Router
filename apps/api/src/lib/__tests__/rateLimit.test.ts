import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { __rateLimitWindowCountForTests, __resetRateLimitForTests, checkRateLimit } from '../rateLimit.js';

describe('checkRateLimit', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const call = (overrides: Partial<{ key: string; limit: number; windowSeconds: number }> = {}) =>
    checkRateLimit({ key: 'test', limit: 3, windowSeconds: 60, ...overrides });

  it('counts down the allowance within a window', async () => {
    expect(await call()).toMatchObject({ ok: true, remaining: 2 });
    expect(await call()).toMatchObject({ ok: true, remaining: 1 });
    expect(await call()).toMatchObject({ ok: true, remaining: 0 });
  });

  it('refuses once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i += 1) await call();
    const blocked = await call();

    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });

  it('tracks keys independently', async () => {
    await call({ key: 'a' });
    await call({ key: 'a' });
    expect(await call({ key: 'b' })).toMatchObject({ remaining: 2 });
  });

  it('is disabled when the limit or window is zero', async () => {
    expect(await call({ limit: 0 })).toEqual({ ok: true, remaining: null, resetSeconds: null });
    expect(await call({ windowSeconds: 0 })).toEqual({ ok: true, remaining: null, resetSeconds: null });
  });

  it('starts a fresh window once the old one expires', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) await call({ windowSeconds: 1 });
    expect(await call({ windowSeconds: 1 })).toMatchObject({ ok: false });

    vi.advanceTimersByTime(1500);

    expect(await call({ windowSeconds: 1 })).toMatchObject({ ok: true, remaining: 2 });
  });

  it('reports the seconds remaining until reset', async () => {
    vi.useFakeTimers();
    await call({ windowSeconds: 60 });
    vi.advanceTimersByTime(20_000);

    const result = await call({ windowSeconds: 60 });
    expect(result.resetSeconds).toBeLessThanOrEqual(40);
    expect(result.resetSeconds).toBeGreaterThan(35);
  });

  /**
   * Every distinct address a caller arrives from is its own window, and a
   * guesser can arrive from a great many. The sweep is the only thing that
   * gives those entries back, so it is the only thing standing between this
   * map and a caller choosing how much memory the process uses.
   */
  it('gives back the windows of keys that stopped being used', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 500; i += 1) await call({ key: `addr-${i}`, windowSeconds: 30 });
    expect(__rateLimitWindowCountForTests()).toBe(500);

    // Past every window, and past the interval that triggers a sweep.
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
    await call({ key: 'someone-still-here', windowSeconds: 30 });

    // Only the caller that is still arriving is still tracked.
    expect(__rateLimitWindowCountForTests()).toBe(1);
  });

  it('keeps a window that has not expired yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await call({ key: 'long-window', windowSeconds: 3600 });
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
    await call({ key: 'trigger-the-sweep', windowSeconds: 30 });
    expect(__rateLimitWindowCountForTests()).toBe(2);
  });
});
