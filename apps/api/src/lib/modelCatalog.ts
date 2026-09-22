import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { getMeta, setMeta } from './db/index.js';
import { countModels, markDeprecatedExcept, modelId, upsertModels, type ModelInput } from './db/models.js';
import { invalidateModelCache } from './router.js';
import { providerCredential } from './credentials.js';
import { envFlag } from './env.js';

/**
 * Keeping the catalog current without anyone running a script.
 *
 * Task tags and quality estimates are curated in config/models.yaml. Prices and
 * context limits are refreshed from the public OpenRouter catalog on a timer
 * and mirrored into SQLite, so a long running instance does not drift and an
 * offline clone still routes from the snapshot in the config file.
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** config/models.yaml, resolved the same way from source and from dist. */
const CONFIG_PATH = resolve(MODULE_DIR, '../../config/models.yaml');

const LAST_SYNC_META_KEY = 'model_catalog.last_sync_at';
const LAST_SOURCE_META_KEY = 'model_catalog.last_source';
const FETCH_TIMEOUT_MS = 10_000;

export type CatalogEntry = {
  provider: string;
  model: string;
  openrouter_id?: string;
  strengths: string[];
  quality: number;
  latency_ms: number;
  context?: number;
  vision?: boolean;
  functions?: boolean;
  price: { input: number; output: number };
};

export type CatalogConfig = {
  settings: { refresh_hours: number; catalog_url: string };
  models: CatalogEntry[];
};

export type SyncResult = {
  source: 'openrouter' | 'config';
  models: number;
  pricesUpdated: number;
  deprecated: number;
  error?: string;
};

let cachedConfig: CatalogConfig | null = null;

export function loadCatalogConfig(path: string = CONFIG_PATH): CatalogConfig {
  if (cachedConfig && path === CONFIG_PATH) return cachedConfig;
  const parsed = parseYaml(readFileSync(path, 'utf8')) as CatalogConfig;
  const config: CatalogConfig = {
    settings: {
      refresh_hours: parsed.settings?.refresh_hours ?? 6,
      catalog_url: parsed.settings?.catalog_url ?? 'https://openrouter.ai/api/v1/models',
    },
    models: parsed.models ?? [],
  };
  if (path === CONFIG_PATH) cachedConfig = config;
  return config;
}

type OpenRouterModel = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
};

/** OpenRouter quotes USD per token. The router works in USD per 1K tokens. */
function perThousand(price: string | undefined): number | null {
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) return null;
  return value * 1000;
}

export async function fetchOpenRouterCatalog(url: string): Promise<Map<string, OpenRouterModel>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json' };
  // Optional. It only raises the rate limit, the endpoint itself is public.
  const key = providerCredential('openrouter');
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`catalog request failed: ${response.status}`);
    const body = (await response.json()) as { data?: OpenRouterModel[] };
    return new Map((body.data ?? []).map((m) => [m.id, m]));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Whether an OpenRouter listing describes the same product this entry calls.
 *
 * It does when OpenRouter serves the call, or when the listing is the
 * provider's own model under its own namespace. It does not when a provider
 * hosts open weights itself: the same model id on OpenRouter is then a
 * different host, which sets its own price, its own context window and its own
 * tool support. None of those numbers transfer, so the curated entry stands.
 */
function describesSameProduct(entry: CatalogEntry): boolean {
  if (entry.provider === 'openrouter') return true;
  return entry.openrouter_id?.split('/')[0] === entry.provider;
}

/** Percentile rank on a 0 to 100 scale. The lowest value scores 0. */
function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  const index = sorted.findIndex((v) => v >= value);
  return Math.round((Math.max(index, 0) / (sorted.length - 1)) * 100);
}

function toModelInputs(config: CatalogConfig, live: Map<string, OpenRouterModel>): {
  rows: ModelInput[];
  pricesUpdated: number;
} {
  const now = Date.now();
  let pricesUpdated = 0;

  const enriched = config.models.map((entry) => {
    const listing = entry.openrouter_id ? live.get(entry.openrouter_id) : undefined;
    // A listing for a different host supplies nothing, not just no price.
    const remote = describesSameProduct(entry) ? listing : undefined;
    const remoteIn = perThousand(remote?.pricing?.prompt);
    const remoteOut = perThousand(remote?.pricing?.completion);
    const hasLivePricing = remoteIn !== null && remoteOut !== null && remoteIn + remoteOut > 0;
    if (hasLivePricing) pricesUpdated += 1;

    return {
      entry,
      remote,
      cost_input: hasLivePricing ? remoteIn : entry.price.input,
      cost_output: hasLivePricing ? remoteOut : entry.price.output,
      live: hasLivePricing,
    };
  });

  // These two are positions within the catalog, so they are recomputed on
  // every refresh rather than maintained by hand.
  const latencies = enriched.map((e) => e.entry.latency_ms);
  const blended = enriched.map((e) => e.cost_input * 0.75 + e.cost_output * 0.25);

  const rows: ModelInput[] = enriched.map((e, i) => ({
    provider: e.entry.provider,
    model_name: e.entry.model,
    display_name: e.remote?.name ?? null,
    cost_input: e.cost_input,
    cost_output: e.cost_output,
    avg_latency: e.entry.latency_ms,
    strengths: e.entry.strengths ?? [],
    quality_rating: e.entry.quality,
    speed_index: 100 - percentileRank(latencies, e.entry.latency_ms),
    price_index: percentileRank(blended, blended[i]),
    supports_functions: e.remote?.supported_parameters?.includes('tools') ?? e.entry.functions ?? false,
    supports_vision:
      e.remote?.architecture?.input_modalities?.includes('image') ?? e.entry.vision ?? false,
    max_tokens: e.remote?.context_length ?? e.entry.context ?? null,
    data_source: e.live ? 'openrouter' : 'config',
    last_synced_at: e.live ? now : null,
    deprecated: false,
  }));

  return { rows, pricesUpdated };
}

/** Write a set of catalog rows into SQLite and record what they came from. */
function applyCatalog(config: CatalogConfig, live: Map<string, OpenRouterModel>): SyncResult {
  const { rows, pricesUpdated } = toModelInputs(config, live);
  upsertModels(rows);
  const deprecated = markDeprecatedExcept(rows.map((r) => modelId(r.provider, r.model_name)));

  const source: SyncResult['source'] = pricesUpdated > 0 ? 'openrouter' : 'config';
  setMeta(LAST_SYNC_META_KEY, String(Date.now()));
  setMeta(LAST_SOURCE_META_KEY, source);
  invalidateModelCache();

  return { source, models: rows.length, pricesUpdated, deprecated };
}

/** Load the catalog from config alone, without touching the network. */
export function seedCatalogFromConfig(config: CatalogConfig = loadCatalogConfig()): SyncResult {
  return applyCatalog(config, new Map());
}

/**
 * Refresh into SQLite, falling back to the config snapshot when the catalog is
 * unreachable, so the table is never left empty.
 */
export async function syncCatalog(): Promise<SyncResult> {
  const config = loadCatalogConfig();

  // Tests and disconnected runs skip the network entirely.
  if (envFlag('AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH') === true) {
    return seedCatalogFromConfig(config);
  }

  let live = new Map<string, OpenRouterModel>();
  let error: string | undefined;

  try {
    live = await fetchOpenRouterCatalog(config.settings.catalog_url);
  } catch (err) {
    error = err instanceof Error ? err.message : 'unknown error';
  }

  const result = applyCatalog(config, live);
  return { ...result, ...(error ? { error } : {}) };
}

export function lastSyncedAt(): number | null {
  const value = getMeta(LAST_SYNC_META_KEY);
  return value ? Number(value) : null;
}

export function catalogStatus(): {
  models: number;
  last_sync_at: number | null;
  source: string | null;
  stale: boolean;
} {
  const last = lastSyncedAt();
  const ttlMs = loadCatalogConfig().settings.refresh_hours * 60 * 60 * 1000;
  return {
    models: countModels(),
    last_sync_at: last,
    source: getMeta(LAST_SOURCE_META_KEY),
    stale: last === null || Date.now() - last > ttlMs,
  };
}

type CatalogLog = { info: (o: object, s: string) => void; warn: (o: object, s: string) => void };

/**
 * A refresh that fell back to the snapshot still produced a usable catalog, but
 * it is a warning, not routine news: prices may be out of date until the next
 * attempt succeeds.
 */
function report(result: SyncResult, log: CatalogLog | undefined, message: string): void {
  if (result.error) log?.warn({ ...result }, `${message} from the bundled snapshot`);
  else log?.info({ ...result }, message);
}

/**
 * Make sure the catalog is usable. This blocks only when there is nothing to
 * route with. A stale catalog is refreshed in the background.
 */
export async function ensureCatalog(log?: {
  info: (o: object, s: string) => void;
  warn: (o: object, s: string) => void;
}): Promise<void> {
  const status = catalogStatus();

  if (status.models === 0) {
    report(await syncCatalog(), log, 'model catalog initialised');
    return;
  }

  if (status.stale) {
    void syncCatalog()
      .then((result) => report(result, log, 'model catalog refreshed'))
      .catch((err) => log?.warn({ err }, 'model catalog refresh failed'));
  }
}

/** Periodic refresh for long-running instances. Returns a stop function. */
export function startCatalogRefresh(log?: {
  info: (o: object, s: string) => void;
  warn: (o: object, s: string) => void;
}): () => void {
  const intervalMs = loadCatalogConfig().settings.refresh_hours * 60 * 60 * 1000;
  const timer = setInterval(() => {
    void syncCatalog()
      .then((result) => report(result, log, 'model catalog refreshed'))
      .catch((err) => log?.warn({ err }, 'model catalog refresh failed'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
