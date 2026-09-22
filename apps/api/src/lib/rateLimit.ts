/**
 * Fixed window rate limiter, in process. One instance means no shared counter
 * to coordinate and no external cache to run.
 *
 * RATE_LIMIT_MAX=0 turns off the shared budget this limiter holds for /v1. The
 * per-address budgets that stop a key being guessed, and the one on Settings,
 * pass their own fixed limits and are unaffected.
 */

export type RateLimitResult = {
  ok: boolean;
  remaining: number | null;
  resetSeconds: number | null;
};

type Window = { count: number; windowEndMs: number };

const windows = new Map<string, Window>();

/** Drop expired windows, so the map cannot grow without bound. */
function sweep(now: number): void {
  for (const [key, window] of windows) {
    if (now >= window.windowEndMs) windows.delete(key);
  }
}

let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60_000;

export async function checkRateLimit(opts: {
  key: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const limit = Number(opts.limit || 0);
  const windowSeconds = Number(opts.windowSeconds || 0);
  if (!limit || !windowSeconds) return { ok: true, remaining: null, resetSeconds: null };

  const now = Date.now();
  if (now - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = now;
    sweep(now);
  }

  const key = `ratelimit:${opts.key}`;
  const existing = windows.get(key);

  if (!existing || now >= existing.windowEndMs) {
    windows.set(key, { count: 1, windowEndMs: now + windowSeconds * 1000 });
    return { ok: true, remaining: Math.max(0, limit - 1), resetSeconds: windowSeconds };
  }

  existing.count += 1;
  return {
    ok: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetSeconds: Math.ceil((existing.windowEndMs - now) / 1000),
  };
}

/**
 * How many windows are being tracked. The sweep is the only thing keeping this
 * from growing with every distinct address a caller can come from, so it needs
 * to be observable to be testable.
 */
export function __rateLimitWindowCountForTests(): number {
  return windows.size;
}

/** Test helper. */
export function __resetRateLimitForTests(): void {
  windows.clear();
  lastSweepAt = 0;
}
