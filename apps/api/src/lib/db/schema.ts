/**
 * The schema, applied on first connection. Index N moves a database from
 * version N to N plus 1. Append, never edit.
 *
 * Timestamps are epoch milliseconds. Booleans are 0 or 1 with a check
 * constraint. List columns are JSON text validated with json_valid. Derived
 * values are generated columns, so they cannot drift from their inputs.
 */
export const MIGRATIONS: string[] = [
  // 0 -> 1: initial schema
  `
  CREATE TABLE models (
    id                 TEXT    PRIMARY KEY,
    provider           TEXT    NOT NULL,
    model_name         TEXT    NOT NULL,
    display_name       TEXT,
    cost_input         REAL    NOT NULL DEFAULT 0,   -- USD per 1K input tokens
    cost_output        REAL    NOT NULL DEFAULT 0,   -- USD per 1K output tokens
    avg_latency        INTEGER NOT NULL DEFAULT 0,   -- milliseconds
    strengths          TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(strengths)),
    quality_rating     REAL,                          -- 0-100, curated in config/models.yaml
    speed_index        REAL,                          -- 0-100
    price_index        REAL,                          -- 0-100
    supports_functions INTEGER NOT NULL DEFAULT 0 CHECK (supports_functions IN (0, 1)),
    supports_vision    INTEGER NOT NULL DEFAULT 0 CHECK (supports_vision IN (0, 1)),
    max_tokens         INTEGER,
    deprecated         INTEGER NOT NULL DEFAULT 0 CHECK (deprecated IN (0, 1)),
    data_source        TEXT    NOT NULL DEFAULT 'config',
    last_synced_at     INTEGER,
    UNIQUE (provider, model_name)
  );

  -- Routing only ever considers live models, so index just those rows.
  CREATE INDEX models_active_idx ON models (provider) WHERE deprecated = 0;
  -- Dropped again in migration 6 -> 7: nothing ever queried it.
  CREATE INDEX models_strength_count_idx ON models (json_array_length(strengths));

  CREATE TABLE requests (
    id                    TEXT    PRIMARY KEY,
    created_at            INTEGER NOT NULL,
    endpoint              TEXT    NOT NULL,
    task_type             TEXT    NOT NULL,
    complexity            REAL,
    priority              TEXT    NOT NULL DEFAULT 'balanced',
    provider              TEXT    NOT NULL,
    model_used            TEXT    NOT NULL,
    tokens_input          INTEGER NOT NULL DEFAULT 0,
    tokens_output         INTEGER NOT NULL DEFAULT 0,
    cost                  REAL    NOT NULL DEFAULT 0,
    premium_baseline_cost REAL    NOT NULL DEFAULT 0,
    latency_ms            INTEGER NOT NULL DEFAULT 0,
    success               INTEGER NOT NULL CHECK (success IN (0, 1)),
    fallback_level        TEXT,
    boost                 INTEGER NOT NULL DEFAULT 0 CHECK (boost IN (0, 1)),
    tokens_total          INTEGER GENERATED ALWAYS AS (tokens_input + tokens_output) VIRTUAL,
    savings               REAL    GENERATED ALWAYS AS (premium_baseline_cost - cost) VIRTUAL
  );

  CREATE INDEX requests_created_at_idx ON requests (created_at DESC);
  CREATE INDEX requests_provider_idx   ON requests (provider, created_at DESC);
  -- Expression index matching the GROUP BY used for the daily usage chart.
  CREATE INDEX requests_day_idx ON requests (date(created_at / 1000, 'unixepoch'));

  CREATE TABLE routing_decisions (
    request_id            TEXT    PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
    task_type             TEXT    NOT NULL,
    classification_method TEXT,
    confidence            REAL,
    complexity            REAL,
    weights               TEXT CHECK (weights IS NULL OR json_valid(weights)),
    constraints           TEXT CHECK (constraints IS NULL OR json_valid(constraints)),
    considered_models     TEXT CHECK (considered_models IS NULL OR json_valid(considered_models)),
    final_model           TEXT    NOT NULL,
    reason                TEXT
  );

  -- One row per provider call attempt, including attempts that failed and fell
  -- back. This is what provider-health scoring reads.
  CREATE TABLE provider_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    provider   TEXT    NOT NULL,
    model_name TEXT,
    success    INTEGER NOT NULL CHECK (success IN (0, 1)),
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX provider_attempts_window_idx ON provider_attempts (provider, created_at DESC);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 1 -> 2: persist provenance so simulated traffic cannot masquerade as live.
  `
  ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (source IN ('live', 'offline', 'demo', 'unknown'));
  UPDATE requests SET source = 'demo' WHERE id IN (
    SELECT request_id FROM routing_decisions WHERE reason = 'seeded demo history'
  );
  CREATE INDEX requests_source_idx ON requests (source, created_at DESC);
  `,
  // 2 -> 3: old attempt rows cannot reliably distinguish live calls from simulations.
  `
  ALTER TABLE provider_attempts ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (source IN ('live', 'offline', 'unknown'));
  CREATE INDEX provider_attempts_live_idx ON provider_attempts (provider, created_at DESC)
    WHERE source = 'live';
  `,
  // 3 -> 4: encrypted provider credentials and hashed integration keys.
  `
  CREATE TABLE provider_credentials (
    provider TEXT PRIMARY KEY,
    encrypted_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE integration_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 4 -> 5: reconcile the two branch-specific v4 schemas. Existing credentials,
  // request history and routing decisions survive upgrades from either branch.
  `
  CREATE TABLE IF NOT EXISTS provider_credentials (
    provider TEXT PRIMARY KEY,
    encrypted_value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS requests_nonnegative_insert BEFORE INSERT ON requests
  WHEN NEW.tokens_input < 0 OR NEW.tokens_output < 0 OR NEW.cost < 0
    OR NEW.premium_baseline_cost < 0 OR NEW.latency_ms < 0
  BEGIN
    SELECT RAISE(ABORT, 'requests: tokens, cost and latency must be non-negative');
  END;

  CREATE TRIGGER IF NOT EXISTS requests_nonnegative_update BEFORE UPDATE ON requests
  WHEN NEW.tokens_input < 0 OR NEW.tokens_output < 0 OR NEW.cost < 0
    OR NEW.premium_baseline_cost < 0 OR NEW.latency_ms < 0
  BEGIN
    SELECT RAISE(ABORT, 'requests: tokens, cost and latency must be non-negative');
  END;

  CREATE TRIGGER IF NOT EXISTS provider_attempts_nonnegative_insert BEFORE INSERT ON provider_attempts
  WHEN NEW.latency_ms < 0
  BEGIN
    SELECT RAISE(ABORT, 'provider_attempts: latency must be non-negative');
  END;
  `,
  // 5 -> 6: administrator-defined OpenAI-compatible endpoints.
  `CREATE TABLE custom_providers (
    provider TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL
  );`,
  // 6 -> 7: drop an index no query uses. It only cost write time on refresh.
  `DROP INDEX IF EXISTS models_strength_count_idx;`,
];
