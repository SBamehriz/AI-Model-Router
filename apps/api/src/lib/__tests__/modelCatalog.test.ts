import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadCatalogConfig,
  seedCatalogFromConfig,
  syncCatalog,
  catalogStatus,
  ensureCatalog,
  fetchOpenRouterCatalog,
  lastSyncedAt,
  startCatalogRefresh,
  type CatalogConfig,
} from '../modelCatalog.js';
import { listModels } from '../db/models.js';
import { setMeta } from '../db/index.js';

/**
 * The catalog mirrors OpenRouter's public price list into SQLite on a TTL.
 * These tests stub the HTTP call, so they cover the mapping and the offline
 * fallback without depending on the network.
 */

const config: CatalogConfig = {
  settings: { refresh_hours: 6, catalog_url: 'https://openrouter.test/models' },
  models: [
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      openrouter_id: 'openai/gpt-4o-mini',
      strengths: ['chat'],
      quality: 71,
      latency_ms: 400,
      context: 128000,
      vision: true,
      functions: true,
      price: { input: 0.00015, output: 0.0006 },
    },
    {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      openrouter_id: 'anthropic/claude-sonnet-4.6',
      strengths: ['coding', 'reasoning'],
      quality: 89,
      latency_ms: 640,
      context: 200000,
      vision: true,
      functions: true,
      price: { input: 0.003, output: 0.015 },
    },
  ],
};

function mockCatalogResponse(models: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: models }), { status: 200 }))
  );
}

describe('model catalog', () => {
  beforeEach(() => {
    delete process.env.AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH = '1';
  });

  describe('config file', () => {
    it('parses the checked-in catalog', () => {
      const parsed = loadCatalogConfig();
      expect(parsed.models.length).toBeGreaterThan(0);
      expect(parsed.settings.refresh_hours).toBeGreaterThan(0);
      for (const entry of parsed.models) {
        expect(entry.strengths.length).toBeGreaterThan(0);
        expect(entry.quality).toBeGreaterThan(0);
        expect(entry.price.input).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('seeding from config', () => {
    it('writes every configured model with snapshot pricing', () => {
      const result = seedCatalogFromConfig(config);

      expect(result.source).toBe('config');
      expect(result.models).toBe(2);
      const rows = listModels();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.model_name === 'gpt-4o-mini')?.cost_input).toBe(0.00015);
    });

    it('derives speed and price indexes from latency and cost', () => {
      seedCatalogFromConfig(config);
      const rows = listModels();
      const fast = rows.find((r) => r.model_name === 'gpt-4o-mini');
      const slow = rows.find((r) => r.model_name === 'claude-sonnet-4-6');

      expect(fast!.speed_index).toBeGreaterThan(slow!.speed_index!);
      expect(fast!.price_index).toBeLessThan(slow!.price_index!);
    });
  });

  describe('refresh from OpenRouter', () => {
    it('converts per-token prices to per-1K and records the source', async () => {
      mockCatalogResponse([
        {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-4o mini',
          context_length: 128000,
          pricing: { prompt: '0.00000015', completion: '0.0000006' },
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['tools'],
        },
        {
          id: 'anthropic/claude-sonnet-4.6',
          pricing: { prompt: '0.000004', completion: '0.00002' },
        },
      ]);

      const result = await syncCatalog();
      expect(result.source).toBe('openrouter');
      expect(result.pricesUpdated).toBe(2);

      const rows = listModels();
      const sonnet = rows.find((r) => r.model_name === 'claude-sonnet-4-6');
      expect(sonnet?.cost_input).toBeCloseTo(0.004, 8);
      expect(sonnet?.cost_output).toBeCloseTo(0.02, 8);
      expect(sonnet?.data_source).toBe('openrouter');
      expect(lastSyncedAt()).toBeGreaterThan(0);
    });

    it('keeps the config snapshot when a model is missing upstream', async () => {
      mockCatalogResponse([
        { id: 'openai/gpt-4o-mini', pricing: { prompt: '0.0000002', completion: '0.0000008' } },
      ]);

      await syncCatalog();
      const rows = listModels();

      expect(rows.find((r) => r.model_name === 'gpt-4o-mini')?.data_source).toBe('openrouter');
      const fallback = rows.find((r) => r.model_name === 'claude-sonnet-4-6');
      expect(fallback?.data_source).toBe('config');
      expect(fallback?.cost_input).toBe(0.003);
    });

    it('adopts a live price only from the host that bills it', async () => {
      // Runs against the checked-in catalog. Groq serves Llama weights itself,
      // so the OpenRouter listing of the same id is another host at another
      // rate: adopting it would under-report what Groq bills. An openrouter
      // entry is billed by OpenRouter, so there the live price does apply.
      const real = loadCatalogConfig();
      const selfHosted = real.models.find((m) => m.provider === 'groq')!;
      const billed = real.models.find((m) => m.provider === 'openrouter')!;
      mockCatalogResponse([
        // Deliberately unlike the curated entry on every field a different
        // host could set for itself.
        { id: selfHosted.openrouter_id, pricing: { prompt: '0.0000001', completion: '0.00000032' }, context_length: 8192, supported_parameters: [] },
        { id: billed.openrouter_id, pricing: { prompt: '0.000001', completion: '0.000002' } },
      ]);

      await syncCatalog();
      const rows = listModels();

      const groq = rows.find((r) => r.model_name === selfHosted.model);
      expect(groq?.cost_input).toBe(selfHosted.price.input);
      expect(groq?.cost_output).toBe(selfHosted.price.output);
      expect(groq?.data_source).toBe('config');
      // Price is not the only thing that belongs to the host. A context window
      // and tool support are set per host as well.
      expect(groq?.max_tokens).toBe(selfHosted.context);
      expect(groq?.supports_functions).toBe(selfHosted.functions);

      const openrouter = rows.find((r) => r.model_name === billed.model);
      expect(openrouter?.cost_input).toBeCloseTo(0.001, 8);
      expect(openrouter?.data_source).toBe('openrouter');
    });

    it('falls back to the config snapshot when the catalog is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

      const result = await syncCatalog();

      expect(result.source).toBe('config');
      expect(result.error).toContain('network down');
      expect(listModels().length).toBeGreaterThan(0);
    });

    it('skips the network entirely when fetching is disabled', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      process.env.AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH = '1';

      const result = await syncCatalog();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.source).toBe('config');
    });
  });

  describe('status', () => {
    it('reports the catalog as fresh right after a sync', () => {
      seedCatalogFromConfig(config);
      const status = catalogStatus();

      expect(status.models).toBe(2);
      expect(status.stale).toBe(false);
      expect(status.source).toBe('config');
    });

    it('reports an empty catalog as stale', () => {
      expect(catalogStatus().stale).toBe(true);
    });
  });
});

describe('ensureCatalog', () => {
  beforeEach(() => {
    process.env.AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH = '1';
  });

  it('populates an empty catalog before the server serves traffic', async () => {
    expect(listModels()).toHaveLength(0);
    await ensureCatalog();
    expect(listModels().length).toBeGreaterThan(0);
  });

  it('leaves a fresh catalog alone', async () => {
    seedCatalogFromConfig(config);
    const before = lastSyncedAt();
    await new Promise((r) => setTimeout(r, 2));
    await ensureCatalog();
    expect(lastSyncedAt()).toBe(before);
  });

  it('refreshes a stale catalog in the background without blocking', async () => {
    seedCatalogFromConfig(config);
    // Backdate the sync so the TTL has expired.
    setMeta('model_catalog.last_sync_at', String(Date.now() - 48 * 60 * 60 * 1000));

    const logs: object[] = [];
    await ensureCatalog({ info: (o) => logs.push(o), warn: () => {} });
    await new Promise((r) => setTimeout(r, 20));

    expect(catalogStatus().stale).toBe(false);
  });
});

describe('fetchOpenRouterCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('indexes the response by model id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-sonnet-4.6' }],
    }), { status: 200 })));

    const catalog = await fetchOpenRouterCatalog('https://openrouter.test/models');
    expect([...catalog.keys()].sort()).toEqual(['anthropic/claude-sonnet-4.6', 'openai/gpt-4o']);
  });

  it('sends the OpenRouter key only when one is configured', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const headersOf = (call: number) =>
      (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;

    await fetchOpenRouterCatalog('https://openrouter.test/models');
    expect(headersOf(0)).not.toHaveProperty('Authorization');

    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    try {
      await fetchOpenRouterCatalog('https://openrouter.test/models');
      expect(headersOf(1)).toHaveProperty('Authorization');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('throws on a non-200 response so the caller can fall back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(fetchOpenRouterCatalog('https://openrouter.test/models')).rejects.toThrow(/503/);
  });

  it('tolerates a response with no data array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(fetchOpenRouterCatalog('https://openrouter.test/models')).resolves.toEqual(new Map());
  });
});

describe('startCatalogRefresh', () => {
  it('returns a stopper and does not hold the process open', () => {
    const stop = startCatalogRefresh();
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('deprecation', () => {
  it('marks a model that disappears from the config as deprecated', () => {
    seedCatalogFromConfig(config);
    expect(listModels()).toHaveLength(2);

    const shrunk = { ...config, models: config.models.slice(0, 1) };
    const result = seedCatalogFromConfig(shrunk);

    expect(result.deprecated).toBe(1);
    expect(listModels()).toHaveLength(1);
    expect(listModels({ includeDeprecated: true })).toHaveLength(2);
  });
});
