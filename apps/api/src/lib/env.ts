import { z } from 'zod';

/**
 * Environment validation. The database is a local file and there are no
 * accounts, so almost everything here is optional. With an empty .env the
 * server still starts, in offline mode, with simulated completions.
 */
/**
 * A switch that is read as exactly "1" or exactly "0". Spelling it `true` used
 * to be ignored in silence, which on the offline switch meant the router went
 * on spending real provider credit while the operator believed it was
 * simulating. A value it cannot act on stops the server instead.
 */
const flag = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.enum(['', '0', '1'], { errorMap: () => ({ message: 'must be 1 or 0, or left unset' }) }).optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** Comma separated origins allowed to call the API from a browser. */
  CORS_ORIGIN: z.string().default('http://localhost:3001'),

  /** SQLite file. Created on first run. */
  DATABASE_PATH: z.string().default('data/ai-model-router.db'),

  /** Optional shared secret. When set, every /v1 request must present it. */
  AI_MODEL_ROUTER_API_KEY: z.string().optional(),
  AI_MODEL_ROUTER_ADMIN_KEY: z.string().min(32).optional(),
  AI_MODEL_ROUTER_ENCRYPTION_KEY: z.string().optional(),

  // Provider credentials, any subset. With none set, the server runs offline.
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  AI_MODEL_ROUTER_OFFLINE: flag,
  AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH: flag,

  /**
   * 0 turns the shared budget off, for an instance behind something that
   * already limits, or for a load measurement. It does not turn off the two
   * per-address budgets in auth.ts, which are what stops a key being guessed
   * and are fixed at 60 a minute.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(100),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Read a switch exactly the way the schema above validates it, trimming
 * included. Every reader has to agree: a value the schema accepts and one
 * reader honours, while another compares it raw and misses, is the same
 * silent divergence in a smaller place.
 */
export function envFlag(name: 'AI_MODEL_ROUTER_OFFLINE' | 'AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH'): boolean | null {
  const value = process.env[name]?.trim();
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

let validatedEnv: Env | null = null;

export function validateEnv(): Env {
  if (validatedEnv) return validatedEnv;

  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Environment validation failed:');
    for (const err of result.error.issues) {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    }
    process.exit(1);
  }

  validatedEnv = result.data;
  return validatedEnv;
}

export function getEnv(): Env {
  if (!validatedEnv) throw new Error('Environment not validated. Call validateEnv() first.');
  return validatedEnv;
}

/** Test helper. */
export function __resetEnvForTests(): void {
  validatedEnv = null;
}
