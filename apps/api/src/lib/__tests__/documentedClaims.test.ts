import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __resetEnvForTests, validateEnv } from '../env.js';
import { MAX_MESSAGES, MAX_MESSAGE_LENGTH } from '../sanitize.js';
import { RecentRequestsQuerySchema } from '../schemas.js';
import { CompatibleRequestSchema } from '../compatibleSchemas.js';

/**
 * The algorithm document checks its own numbers. These are the numbers in
 * every other file: the README's environment table and caps, and the API
 * reference's limits. Checking those by hand works exactly once and starts
 * going stale again the moment anything moves.
 *
 * Each claim is parsed out of the document and compared against the thing
 * that decides it, reading a schema's own behaviour at its boundary rather
 * than a constant copied next to it.
 */
const ROOT = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..', '..');
/** Prose wraps, so a sentence is matched with its line breaks flattened. */
const flat = (text: string) => text.replace(/\s+/g, ' ');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const API = flat(readFileSync(join(ROOT, 'docs', 'API.md'), 'utf8'));
const SECURITY = flat(readFileSync(join(ROOT, 'SECURITY.md'), 'utf8'));

/** The defaults the schema applies when nothing is set. */
const defaults = (): Record<string, unknown> => {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(AI_MODEL_ROUTER_|DATABASE_PATH|CORS_ORIGIN|RATE_LIMIT_|PORT$|HOST$)/.test(key)) delete process.env[key];
  }
  __resetEnvForTests();
  try {
    return validateEnv() as unknown as Record<string, unknown>;
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    __resetEnvForTests();
  }
};

/** The cell of the README environment table for one variable. */
const envRow = (variable: string): string => {
  const row = README.split('\n').find((line) => line.startsWith('|') && line.includes(`\`${variable}\``));
  if (!row) throw new Error(`no README row for ${variable}`);
  return row;
};

describe('the README against the environment it documents', () => {
  const applied = defaults();

  it.each([
    ['DATABASE_PATH', 'DATABASE_PATH'],
    ['PORT', 'HOST` and `PORT'],
    ['HOST', 'HOST` and `PORT'],
    ['CORS_ORIGIN', 'CORS_ORIGIN'],
    ['RATE_LIMIT_MAX', 'RATE_LIMIT_MAX'],
    ['RATE_LIMIT_WINDOW_SEC', 'RATE_LIMIT_MAX'],
  ])('documents the real default for %s', (key, rowKey) => {
    const row = envRow(rowKey);
    expect(row, `${key} default ${String(applied[key])} is not in its README row`).toContain(`\`${String(applied[key])}\``);
  });

  it('documents the administrator key length the schema enforces', () => {
    // 31 is refused and 32 accepted, so "at least 32 characters" is the rule.
    const saved = process.env.AI_MODEL_ROUTER_ADMIN_KEY;
    const withKey = (value: string) => {
      process.env.AI_MODEL_ROUTER_ADMIN_KEY = value;
      __resetEnvForTests();
      try { validateEnv(); return true; } catch { return false; }
    };
    expect(envRow('AI_MODEL_ROUTER_ADMIN_KEY')).toContain('at least 32 characters');
    expect(withKey('x'.repeat(32))).toBe(true);
    process.env.AI_MODEL_ROUTER_ADMIN_KEY = saved;
    __resetEnvForTests();
  });

  it('documents the coverage thresholds the gate actually enforces', () => {
    const config = readFileSync(join(ROOT, 'apps', 'api', 'vitest.config.ts'), 'utf8');
    const threshold = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(config)?.[1]);
    const sentence = /Coverage gates require ([^.]+)\./.exec(flat(README))?.[1] ?? '';
    expect(sentence).toContain(`${threshold('lines')} percent lines`);
    expect(sentence).toContain(`${threshold('functions')} percent functions`);
    expect(sentence).toContain(`${threshold('branches')} percent branches`);
  });

  it('documents the Node version the package requires', () => {
    const engines = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node as string;
    const version = engines.replace(/[^\d.]/g, '').replace(/\.0$/, '');
    expect(flat(README)).toContain(`Node.js ${version} or newer`);
  });
});

describe('the API reference against the limits it documents', () => {
  /** The largest value a schema still accepts, found at its boundary. */
  const accepts = (parse: (n: number) => boolean, at: number) => parse(at) && !parse(at + 1);

  it('documents the request history ceiling both files claim', () => {
    const limit = (n: number) => RecentRequestsQuerySchema.safeParse({ limit: String(n) }).success;
    expect(accepts(limit, 200), 'the ceiling is not 200').toBe(true);
    expect(RecentRequestsQuerySchema.parse({}).limit, 'the default is not 50').toBe(50);
    expect(flat(README)).toContain('latest 200 records');
    expect(API).toContain('defaults to 50, maximum 200');
  });

  it('documents the largest output token request the schema accepts', () => {
    const tokens = (n: number) =>
      CompatibleRequestSchema.safeParse({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: n }).success;
    expect(accepts(tokens, 32768)).toBe(true);
    expect(API).toContain('largest output token request accepted is 32768');
  });

  it('documents the message count and length caps the sanitiser enforces', () => {
    expect(API).toContain(`at most ${MAX_MESSAGES}`);
    expect(API).toContain(`capped at ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters`);
  });

  it('documents the guessing budget the auth guard applies', () => {
    const auth = readFileSync(join(ROOT, 'apps', 'api', 'src', 'lib', 'auth.ts'), 'utf8');
    const limits = [...auth.matchAll(/limit:\s*(\d+),\s*windowSeconds:\s*(\d+)/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(new Set(limits).size, 'the two budgets no longer agree').toBe(1);
    const [perWindow, seconds] = limits[0].split('/');
    expect(seconds, 'the window is not a minute').toBe('60');
    expect(API).toContain(`limited to ${perWindow} per minute`);
    expect(SECURITY).toContain(`limited to ${perWindow} per minute`);
  });
});

describe('the verification document against the suite it describes', () => {
  /** Every *.test.ts under a workspace, however deeply nested. */
  const countTests = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => {
      if (entry.isDirectory()) return n + countTests(join(dir, entry.name));
      return n + (/\.test\.tsx?$/.test(entry.name) ? 1 : 0);
    }, 0);

  it('counts the test files it claims to have run', () => {
    const doc = flat(readFileSync(join(ROOT, 'docs', 'VERIFICATION.md'), 'utf8'));
    const api = countTests(join(ROOT, 'apps', 'api', 'src'));
    const dashboard = countTests(join(ROOT, 'apps', 'dashboard', 'src'));
    expect(doc, `there are ${api} API test files`).toContain(`${api} API test files`);
    expect(doc, `there are ${dashboard} dashboard test files`).toContain(`${dashboard} dashboard test files`);
  });

  /** Root package scripts, which is where every documented command resolves. */
  const packaged = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const scripts = Object.keys(packaged);
  /** What `npm run check` runs for you, and so need not be named separately. */
  const insideCheck = new Set([...packaged.check.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));

  it.each([
    ['docs/VERIFICATION.md', join('docs', 'VERIFICATION.md')],
    ['CONTRIBUTING.md', 'CONTRIBUTING.md'],
    ['docs/TESTING-CLIENTS.md', join('docs', 'TESTING-CLIENTS.md')],
  ])('only tells a reader to run commands that exist, in %s', (_name, file) => {
    const named = [...readFileSync(join(ROOT, file), 'utf8').matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const command of new Set(named)) {
      expect(scripts, `npm run ${command} is documented and does not exist`).toContain(command);
    }
  });

  it('names every check the repository can run', () => {
    // The failure this guards against is the one that made the load harness
    // necessary: a verification mechanism that exists and that the document
    // describing verification says nothing about, so nobody runs it.
    const described = readFileSync(join(ROOT, 'docs', 'VERIFICATION.md'), 'utf8')
      + readFileSync(join(ROOT, 'docs', 'TESTING-CLIENTS.md'), 'utf8');
    for (const command of scripts.filter((name) => name.startsWith('test:') && !insideCheck.has(name))) {
      expect(described, `npm run ${command} exists and no document tells anyone to run it`).toContain(`npm run ${command}`);
    }
  });
});
