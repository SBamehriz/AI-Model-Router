import { getDb, withTransaction } from './index.js';

/** A routable model as stored in SQLite. Costs are USD per 1K tokens. */
export type ModelRecord = {
  id: string;
  provider: string;
  model_name: string;
  display_name: string | null;
  cost_input: number;
  cost_output: number;
  avg_latency: number;
  strengths: string[];
  quality_rating: number | null;
  speed_index: number | null;
  price_index: number | null;
  supports_functions: boolean;
  supports_vision: boolean;
  max_tokens: number | null;
  deprecated: boolean;
  data_source: string;
  last_synced_at: number | null;
};

export type ModelInput = Omit<ModelRecord, 'id' | 'strengths' | 'deprecated'> & {
  strengths: string[];
  deprecated?: boolean;
};

type ModelRow = Omit<ModelRecord, 'strengths' | 'supports_functions' | 'supports_vision' | 'deprecated'> & {
  strengths: string;
  supports_functions: number;
  supports_vision: number;
  deprecated: number;
};

const SELECT_MODEL = `
  SELECT id, provider, model_name, display_name, cost_input, cost_output, avg_latency,
         strengths, quality_rating, speed_index, price_index, supports_functions,
         supports_vision, max_tokens, deprecated, data_source, last_synced_at
  FROM models
`;

function hydrate(row: ModelRow): ModelRecord {
  return {
    ...row,
    strengths: JSON.parse(row.strengths) as string[],
    supports_functions: !!row.supports_functions,
    supports_vision: !!row.supports_vision,
    deprecated: !!row.deprecated,
  };
}

export function modelId(provider: string, modelName: string): string {
  return `${provider}/${modelName}`;
}

export function listModels(filter: { provider?: string; includeDeprecated?: boolean } = {}): ModelRecord[] {
  const where: string[] = [];
  const params: string[] = [];
  if (!filter.includeDeprecated) where.push('deprecated = 0');
  if (filter.provider) {
    where.push('provider = ?');
    params.push(filter.provider);
  }
  const sql = `${SELECT_MODEL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY provider, model_name`;
  return (getDb().prepare(sql).all(...params) as ModelRow[]).map(hydrate);
}

/** Insert or update by (provider, model_name). Returns the number of rows written. */
export function upsertModels(models: ModelInput[]): number {
  const statement = getDb().prepare(`
    INSERT INTO models (
      id, provider, model_name, display_name, cost_input, cost_output, avg_latency, strengths,
      quality_rating, speed_index, price_index, supports_functions, supports_vision, max_tokens,
      deprecated, data_source, last_synced_at
    ) VALUES (
      @id, @provider, @model_name, @display_name, @cost_input, @cost_output, @avg_latency, @strengths,
      @quality_rating, @speed_index, @price_index, @supports_functions, @supports_vision, @max_tokens,
      @deprecated, @data_source, @last_synced_at
    )
    ON CONFLICT (provider, model_name) DO UPDATE SET
      display_name       = excluded.display_name,
      cost_input         = excluded.cost_input,
      cost_output        = excluded.cost_output,
      avg_latency        = excluded.avg_latency,
      strengths          = excluded.strengths,
      quality_rating     = excluded.quality_rating,
      speed_index        = excluded.speed_index,
      price_index        = excluded.price_index,
      supports_functions = excluded.supports_functions,
      supports_vision    = excluded.supports_vision,
      max_tokens         = excluded.max_tokens,
      deprecated         = excluded.deprecated,
      data_source        = excluded.data_source,
      last_synced_at     = excluded.last_synced_at
  `);

  return withTransaction(() => {
    for (const m of models) {
      statement.run({
        id: modelId(m.provider, m.model_name),
        provider: m.provider,
        model_name: m.model_name,
        display_name: m.display_name ?? null,
        cost_input: m.cost_input,
        cost_output: m.cost_output,
        avg_latency: m.avg_latency,
        strengths: JSON.stringify(m.strengths ?? []),
        quality_rating: m.quality_rating ?? null,
        speed_index: m.speed_index ?? null,
        price_index: m.price_index ?? null,
        supports_functions: m.supports_functions ? 1 : 0,
        supports_vision: m.supports_vision ? 1 : 0,
        max_tokens: m.max_tokens ?? null,
        deprecated: m.deprecated ? 1 : 0,
        data_source: m.data_source,
        last_synced_at: m.last_synced_at ?? null,
      });
    }
    return models.length;
  });
}

/** Flag models that are no longer offered by any configured source. */
export function markDeprecatedExcept(liveIds: string[]): number {
  if (liveIds.length === 0) return 0;
  const placeholders = liveIds.map(() => '?').join(', ');
  const result = getDb()
    .prepare(`UPDATE models SET deprecated = 1 WHERE deprecated = 0 AND data_source != 'custom' AND id NOT IN (${placeholders})`)
    .run(...liveIds);
  // node:sqlite reports `changes` as number | bigint depending on magnitude.
  return Number(result.changes);
}

export function countModels(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM models WHERE deprecated = 0').get() as { n: number };
  return row.n;
}
