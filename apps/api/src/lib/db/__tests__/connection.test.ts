import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTION_PRAGMAS, applyMigrations, closeDb, getDb, getMeta, openDatabase, setDb, setMeta, withTransaction } from '../index.js';
import { MIGRATIONS } from '../schema.js';
import { countModels, upsertModels } from '../models.js';
import { countRequests, insertRequest } from '../requests.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ai-model-router-db-'));
});

afterEach(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

const userVersion = (db = getDb()) =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

describe('migrations', () => {
  it('preserves legacy provider attempts without treating them as live traffic', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 2));
      db.prepare('INSERT INTO provider_attempts (provider, success, latency_ms, created_at) VALUES (?, ?, ?, ?)').run('openai', 1, 25, 100);
      applyMigrations(db);
      expect(db.prepare('SELECT provider, success, latency_ms, created_at, source FROM provider_attempts').get()).toEqual({ provider: 'openai', success: 1, latency_ms: 25, created_at: 100, source: 'unknown' });
      expect(userVersion(db)).toBe(MIGRATIONS.length);
    } finally {
      db.close();
    }
  });

  it.each(['credentials', 'qa-triggers'])('upgrades the %s branch v4 without losing data', (branch) => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrations(db, MIGRATIONS.slice(0, 3));
      const oldV4 = branch === 'credentials' ? MIGRATIONS[3] : MIGRATIONS[4].slice(MIGRATIONS[4].indexOf('CREATE TRIGGER'));
      applyMigrations(db, [...MIGRATIONS.slice(0, 3), oldV4]);
      db.exec("INSERT INTO requests (id, created_at, endpoint, task_type, provider, model_used, success) VALUES ('kept', 1, '/v1/chat', 'chat', 'openai', 'test', 1)");
      db.exec("INSERT INTO routing_decisions (request_id, task_type, final_model) VALUES ('kept', 'chat', 'openai/test')");
      if (branch === 'credentials') {
        db.exec("INSERT INTO provider_credentials VALUES ('openai', 'existing-ciphertext', 1)");
        db.exec("INSERT INTO integration_keys VALUES ('key-id', 'existing app', 'existing-hash', 'prefix', 1)");
      }
      expect(applyMigrations(db)).toBe(MIGRATIONS.length);
      expect(applyMigrations(db)).toBe(MIGRATIONS.length);
      expect(db.prepare('SELECT request_id FROM routing_decisions').get()).toEqual({ request_id: 'kept' });
      expect(db.prepare('SELECT id FROM requests').get()).toEqual({ id: 'kept' });
      expect(() => db.exec("UPDATE requests SET cost = -1 WHERE id = 'kept'")).toThrow(/non-negative/);
      if (branch === 'credentials') {
        expect(db.prepare('SELECT encrypted_value FROM provider_credentials').get()).toEqual({ encrypted_value: 'existing-ciphertext' });
        expect(db.prepare('SELECT key_hash FROM integration_keys').get()).toEqual({ key_hash: 'existing-hash' });
      } else {
        expect(db.prepare('SELECT * FROM provider_credentials').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM integration_keys').all()).toEqual([]);
      }
    } finally { db.close(); }
  });

  it('creates every table on an empty database', () => {
    const db = openDatabase(':memory:');
    setDb(db);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
      .filter((name) => !name.startsWith('sqlite_'));

    expect(tables.sort()).toEqual(['custom_providers', 'integration_keys', 'meta', 'models', 'provider_attempts', 'provider_credentials', 'requests', 'routing_decisions']);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
  });

  it('creates the indexes the queries rely on', () => {
    setDb(openDatabase(':memory:'));
    const indexes = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map((row) => row.name);

    expect(indexes).toEqual(
      expect.arrayContaining([
        'models_active_idx',
        'requests_created_at_idx',
        'requests_day_idx',
        'provider_attempts_window_idx',
      ])
    );
    // Migration 6 -> 7 dropped it, so an upgraded database must not keep it.
    expect(indexes).not.toContain('models_strength_count_idx');
  });

  it('is a no-op when reopening an up-to-date database, and keeps the data', () => {
    const file = join(workDir, 'ai-model-router.db');

    const first = openDatabase(file);
    setDb(first);
    insertRequest({
      endpoint: '/v1/chat', task_type: 'chat', complexity: 0.2, priority: 'balanced',
      provider: 'openai', model_used: 'gpt-4o-mini', tokens_input: 10, tokens_output: 20,
      cost: 0.001, premium_baseline_cost: 0.003, latency_ms: 100, success: true, fallback_level: 'primary',
    });
    expect(countRequests()).toBe(1);
    closeDb();

    const second = openDatabase(file);
    setDb(second);
    expect(userVersion(second)).toBe(MIGRATIONS.length);
    expect(countRequests()).toBe(1);
    closeDb();
  });

  it('applies only the migrations a database is missing', () => {
    const db = openDatabase(':memory:');
    setDb(db);
    // Start from a clean connection so the synthetic list is the whole history.
    const fresh = openDatabase(':memory:');
    fresh.exec('PRAGMA user_version = 0');
    fresh.exec('DROP TABLE IF EXISTS meta');
    fresh.exec('DROP TABLE IF EXISTS routing_decisions');
    fresh.exec('DROP TABLE IF EXISTS provider_attempts');
    fresh.exec('DROP TABLE IF EXISTS requests');
    fresh.exec('DROP TABLE IF EXISTS models');

    const migrations = [
      'CREATE TABLE step_one (id INTEGER PRIMARY KEY)',
      'CREATE TABLE step_two (id INTEGER PRIMARY KEY)',
    ];

    expect(applyMigrations(fresh, migrations.slice(0, 1))).toBe(1);
    expect(applyMigrations(fresh, migrations)).toBe(2);

    const tables = (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['step_one', 'step_two']));
    fresh.close();
  });

  it('does nothing when the database is already current', () => {
    const db = openDatabase(':memory:');
    setDb(db);
    const before = userVersion(db);
    expect(applyMigrations(db)).toBe(before);
    expect(applyMigrations(db)).toBe(before);
  });

  it('leaves the version untouched when a migration fails', () => {
    const db = openDatabase(':memory:');
    setDb(db);
    const before = userVersion(db);

    expect(() => applyMigrations(db, [...MIGRATIONS, 'THIS IS NOT SQL'])).toThrow();
    expect(userVersion(db)).toBe(before);
  });

  it('creates the parent directory for a nested database path', () => {
    const file = join(workDir, 'nested', 'deeper', 'ai-model-router.db');
    setDb(openDatabase(file));
    expect(existsSync(file)).toBe(true);
  });

  it('enables WAL and foreign keys on a file database', () => {
    setDb(openDatabase(join(workDir, 'wal.db')));
    const journal = getDb().prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = getDb().prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    expect(journal.journal_mode).toBe('wal');
    expect(fk.foreign_keys).toBe(1);
  });

  it('rejects a corrupt database and releases the file handle', () => {
    const file = join(workDir, 'corrupt.db');
    writeFileSync(file, 'this is not sqlite');
    expect(() => openDatabase(file)).toThrow();
    rmSync(file);
    expect(existsSync(file)).toBe(false);
  });
});

describe('withTransaction', () => {
  beforeEach(() => {
    setDb(openDatabase(':memory:'));
  });

  it('commits the work when it returns', () => {
    const written = withTransaction(() =>
      upsertModels([
        {
          provider: 'openai', model_name: 'gpt-4o-mini', display_name: null,
          cost_input: 0.0001, cost_output: 0.0002, avg_latency: 300, strengths: ['chat'],
          quality_rating: 70, speed_index: 90, price_index: 10,
          supports_functions: false, supports_vision: false, max_tokens: null,
          data_source: 'test', last_synced_at: null,
        },
      ])
    );

    expect(written).toBe(1);
    expect(countModels()).toBe(1);
  });

  it('rolls back every write when the work throws', () => {
    expect(() =>
      withTransaction(() => {
        getDb().prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
        getDb().prepare("INSERT INTO meta (key, value) VALUES ('b', '2')").run();
        throw new Error('halfway failure');
      })
    ).toThrow('halfway failure');

    expect(getMeta('a')).toBeNull();
    expect(getMeta('b')).toBeNull();
  });

  it('nests without starting a second transaction', () => {
    withTransaction(() => {
      setMeta('outer', '1');
      withTransaction(() => setMeta('inner', '2'));
    });

    expect(getMeta('outer')).toBe('1');
    expect(getMeta('inner')).toBe('2');
  });

  it('rolls the outer transaction back when a nested block throws', () => {
    expect(() =>
      withTransaction(() => {
        setMeta('outer', '1');
        withTransaction(() => {
          throw new Error('inner failure');
        });
      })
    ).toThrow('inner failure');

    expect(getMeta('outer')).toBeNull();
  });

  it('recovers for the next transaction after a rollback', () => {
    expect(() => withTransaction(() => { throw new Error('fail'); })).toThrow();
    withTransaction(() => setMeta('after', 'ok'));
    expect(getMeta('after')).toBe('ok');
  });
});

describe('meta store', () => {
  beforeEach(() => {
    setDb(openDatabase(':memory:'));
  });

  it('returns null for an unknown key', () => {
    expect(getMeta('missing')).toBeNull();
  });

  it('overwrites an existing key rather than duplicating it', () => {
    setMeta('k', 'one');
    setMeta('k', 'two');
    expect(getMeta('k')).toBe('two');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('concurrent writers', () => {
  /**
   * Within one process, node:sqlite is synchronous, so requests cannot
   * interleave. The real risk is a second process, the demo seeder or a
   * stray server, writing the same file, which is what WAL and the busy timeout are
   * configured for. This spawns real processes to prove it.
   */
  it('loses no writes when several processes write the same database', () => {
    const file = join(workDir, 'concurrent.db');
    setDb(openDatabase(file));
    closeDb();

    // The writers are configured from the same list the application uses, not
    // from a second copy of it. The copy that used to be here set the journal
    // mode and nothing else, so each writer ran at SQLite's default
    // `synchronous = FULL` and fsynced on all two hundred of its commits:
    // three times the wall clock of the configuration actually shipped, and
    // three times as long for the writer waiting on the lock. On a loaded
    // Windows runner that is what pushed one past the five second timeout and
    // failed this with "database is locked". It also passed the busy timeout
    // as the constructor option the application avoids, which does not exist
    // on the oldest Node this supports, where it would mean no timeout at all.
    const script = join(workDir, 'writer.mjs');
    writeFileSync(
      script,
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[2]);
       ${CONNECTION_PRAGMAS.map((pragma) => `db.exec('PRAGMA ${pragma}');`).join('\n       ')}
       const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
       for (let i = 0; i < 200; i++) insert.run(process.argv[3] + ':' + i, 'x');
       db.close();`
    );

    const writers = ['a', 'b', 'c'].map((tag) =>
      new Promise<string | null>((resolve) => {
        execFile(process.execPath, [script, file, tag], (error) => resolve(error ? `${tag}: ${error.message}` : null));
      })
    );

    // Every writer is waited for, even once one has failed. Rejecting on the
    // first left the other two running into the teardown, which then could not
    // remove a directory Windows still had open, so one failure was reported
    // as two and the real one was the second line.
    return Promise.all(writers).then((results) => {
      expect(results.filter(Boolean)).toEqual([]);
      setDb(openDatabase(file));
      const total = getDb().prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number };
      expect(total.n).toBe(600);
    });
  }, 30_000);
});
