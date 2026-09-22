/**
 * Tests run against a throwaway in-memory SQLite database, with completions
 * simulated locally, so nothing touches the network or real data. Suites that
 * exercise the provider adapters set AI_MODEL_ROUTER_OFFLINE=0 themselves.
 */
import { afterEach, beforeEach } from 'vitest';
import { openDatabase, setDb, closeDb } from './src/lib/db/index.js';
import { resetCredentialsForTests } from './src/lib/credentials.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.AI_MODEL_ROUTER_DISABLE_CATALOG_FETCH = '1';
delete process.env.AI_MODEL_ROUTER_API_KEY;

beforeEach(() => {
  resetCredentialsForTests();
  process.env.AI_MODEL_ROUTER_OFFLINE = '1';
  setDb(openDatabase(':memory:'));
});

afterEach(() => {
  closeDb();
});
