import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetEnvForTests, envFlag, getEnv, validateEnv } from '../env.js';
import { isForcedOffline, isOfflineMode } from '../providerAvailability.js';

/** Config is almost all optional by design: an empty .env must still boot. */
describe('validateEnv', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    __resetEnvForTests();
    for (const key of ['PORT', 'HOST', 'CORS_ORIGIN', 'DATABASE_PATH', 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_SEC', 'AI_MODEL_ROUTER_API_KEY']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = saved;
    __resetEnvForTests();
    vi.restoreAllMocks();
  });

  it('boots with nothing configured', () => {
    const env = validateEnv();

    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.CORS_ORIGIN).toBe('http://localhost:3001');
    expect(env.DATABASE_PATH).toBe('data/ai-model-router.db');
    expect(env.RATE_LIMIT_MAX).toBe(100);
    expect(env.AI_MODEL_ROUTER_API_KEY).toBeUndefined();
  });

  it('binds to localhost by default, since an unset key means an open API', () => {
    expect(validateEnv().HOST).toBe('127.0.0.1');
  });

  it('coerces numeric settings from strings', () => {
    process.env.PORT = '8080';
    process.env.RATE_LIMIT_MAX = '10';
    process.env.RATE_LIMIT_WINDOW_SEC = '30';

    const env = validateEnv();
    expect(env.PORT).toBe(8080);
    expect(env.RATE_LIMIT_MAX).toBe(10);
    expect(env.RATE_LIMIT_WINDOW_SEC).toBe(30);
  });

  it('memoises the parsed environment', () => {
    const first = validateEnv();
    process.env.PORT = '9999';
    expect(validateEnv()).toBe(first);
    expect(getEnv().PORT).toBe(first.PORT);
  });

  it('rejects an invalid NODE_ENV rather than starting in an unknown mode', () => {
    process.env.NODE_ENV = 'staging';
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exit).toHaveBeenCalledWith(1);
    process.env.NODE_ENV = 'test';
  });

  it('throws if getEnv is called before validation', () => {
    __resetEnvForTests();
    expect(() => getEnv()).toThrow(/not validated/i);
  });

  // Spelling the offline switch `true` used to be ignored in silence, which
  // meant live provider calls while the operator believed it was simulating.
  it.each([['1'], ['0'], [''], [' 1 ']])('accepts AI_MODEL_ROUTER_OFFLINE=%s', (value) => {
    process.env.AI_MODEL_ROUTER_OFFLINE = value;
    expect(() => validateEnv()).not.toThrow();
  });

  it.each([
    ['AI_MODEL_ROUTER_OFFLINE', 'true'],
    ['AI_MODEL_ROUTER_OFFLINE', 'yes'],
    ['AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH', 'true'],
  ])('refuses to start on an unreadable switch %s=%s', (name, value) => {
    process.env[name] = value;
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('invalid configuration'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnv()).toThrow('invalid configuration');
  });

  // The schema accepts a padded value, so every reader has to accept it too.
  // One reader trimming while another compared the raw string is how the same
  // switch came to mean two things at once.
  it('is read identically by everyone who reads it', () => {
    process.env.AI_MODEL_ROUTER_OFFLINE = ' 1 ';
    expect(() => validateEnv()).not.toThrow();
    expect(envFlag('AI_MODEL_ROUTER_OFFLINE')).toBe(true);
    expect(isOfflineMode()).toBe(true);
    expect(isForcedOffline()).toBe(true);

    process.env.AI_MODEL_ROUTER_OFFLINE = ' 0 ';
    expect(envFlag('AI_MODEL_ROUTER_OFFLINE')).toBe(false);
    expect(isOfflineMode()).toBe(false);
    expect(isForcedOffline()).toBe(false);
  });

  it('accepts RATE_LIMIT_MAX=0, which is how the shared budget is turned off', () => {
    // The limiter's own documentation offered this switch while the schema
    // refused it, so the server would not start for anyone who took it.
    process.env.RATE_LIMIT_MAX = '0';
    expect(validateEnv().RATE_LIMIT_MAX).toBe(0);
  });

  it.each([['PORT', 'NaN'], ['PORT', '65536'], ['RATE_LIMIT_MAX', '-1'], ['RATE_LIMIT_MAX', '1.5'], ['RATE_LIMIT_WINDOW_SEC', '0'], ['RATE_LIMIT_WINDOW_SEC', '-1']])('rejects invalid %s=%s', (name, value) => {
    process.env[name] = value;
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('invalid configuration'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => validateEnv()).toThrow('invalid configuration');
  });
});
