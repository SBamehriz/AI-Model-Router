// Must come first: installs the filter for the warning node:sqlite emits.
import './quietSqliteWarning.js';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { MIGRATIONS } from './schema.js';

// A static import of a builtin is resolved while the module graph is linked,
// before any module body has run, including the filter above. A lazy require
// defers it to this point, so the load time warning is caught. The import type
// above keeps full typing with no runtime import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * One SQLite file, created on first run. No server, no migrations to run by
 * hand and no native module to compile, because node:sqlite ships with Node.
 *
 * Every call here is synchronous. Node runs them on one thread, so statements
 * from concurrent requests cannot interleave inside a transaction. WAL and a
 * busy timeout cover the remaining case, another process touching the same
 * file. Set DATABASE_PATH to move it, or to :memory: for tests.
 */
export const DEFAULT_DATABASE_PATH = 'data/ai-model-router.db';

/** How long a statement waits for another writer before giving up. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * What every connection to a file database is configured with, in this order.
 * Exported because a test that spawns a second writer has to configure it the
 * same way or it is not testing this: a writer left at SQLite's default
 * `synchronous = FULL` fsyncs on every commit and takes three times as long,
 * which is three times as long for another writer to wait out.
 *
 * `busy_timeout` is set with a statement rather than the constructor option of
 * the same name, which arrived after Node 22.13, the oldest release this
 * supports. An ignored option is no timeout at all.
 */
export const CONNECTION_PRAGMAS = [
  `busy_timeout = ${BUSY_TIMEOUT_MS}`,
  'journal_mode = WAL',
  'synchronous = NORMAL',
] as const;

export type Db = SqliteDatabase;

let db: Db | null = null;

/** Read a single value pragma, such as user_version. */
function readPragma(connection: Db, name: string): number {
  const row = connection.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
  return Number(row?.[name] ?? 0);
}

/**
 * Run work inside a transaction, rolling back if it throws. node:sqlite has no
 * transaction helper and nesting BEGIN would fail, so the depth counter lets
 * callers compose without knowing whether they are already inside one.
 */
const transactionDepth = new WeakMap<Db, number>();

export function withTransaction<T>(work: () => T, connection: Db = getDb()): T {
  if ((transactionDepth.get(connection) ?? 0) > 0) return work();

  connection.exec('BEGIN');
  transactionDepth.set(connection, 1);
  try {
    const result = work();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      connection.exec('ROLLBACK');
    } catch {
      // SQLite rolled it back already. Keep the original error.
    }
    throw error;
  } finally {
    transactionDepth.delete(connection);
  }
}

/**
 * Apply the migrations this database has not seen yet. user_version records how
 * far it has got: entry N moves the database from version N to N plus 1. Each
 * step is its own transaction, so a failing migration leaves the version where
 * it was rather than half applied.
 */
export function applyMigrations(connection: Db, migrations: readonly string[] = MIGRATIONS): number {
  const current = readPragma(connection, 'user_version');

  for (let version = current; version < migrations.length; version += 1) {
    withTransaction(() => {
      connection.exec(migrations[version]);
      connection.exec(`PRAGMA user_version = ${version + 1}`);
    }, connection);
  }

  return readPragma(connection, 'user_version');
}

export function openDatabase(path: string): Db {
  const location = path === ':memory:' ? path : resolve(process.cwd(), path);
  if (path !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true });
  }

  const connection = new DatabaseSync(location, {
    enableForeignKeyConstraints: true,
  });
  // WAL lets a reader run while a writer holds the file. It is a no-op for
  // :memory:, which SQLite keeps in journal mode.
  try {
    for (const pragma of CONNECTION_PRAGMAS) connection.exec(`PRAGMA ${pragma}`);
    applyMigrations(connection);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Process-wide connection, opened lazily on first use. */
export function getDb(): Db {
  if (!db) db = openDatabase(process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH);
  return db;
}

/** Point the process at a different database (tests use ':memory:'). */
export function setDb(connection: Db | null): void {
  db = connection;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
