import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { initializeCredentials, administratorKey, isAdministratorKey, providerCredential, credentialForEnvironment, storeProviderCredential, resetCredentialsForTests } from '../credentials.js';
import { saveCredential, storedCredential } from '../db/credentials.js';

describe('credential vault', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ai-model-router-vault-')); });
  afterEach(() => { vi.unstubAllEnvs(); resetCredentialsForTests(); rmSync(directory, { recursive: true, force: true }); });

  it('creates a persistent key beside SQLite and decrypts credentials after a restart', () => {
    vi.stubEnv('DATABASE_PATH', join(directory, 'router.db'));
    initializeCredentials();
    const admin = administratorKey();
    expect(isAdministratorKey(admin)).toBe(true);
    expect(isAdministratorKey('wrong')).toBe(false);
    storeProviderCredential('openai', 'sk-persistent-provider');
    const encrypted = storedCredential('openai')!.encrypted_value;
    resetCredentialsForTests();
    initializeCredentials();
    expect(administratorKey()).toBe(admin);
    expect(providerCredential('openai')).toBe('sk-persistent-provider');
    expect(credentialForEnvironment('OPENAI_API_KEY')).toBe('sk-persistent-provider');
    expect(credentialForEnvironment('UNKNOWN_API_KEY')).toBe('');
    expect(Buffer.from(readFileSync(join(directory, 'credentials.key'), 'utf8'), 'base64')).toHaveLength(32);
    expect(encrypted).not.toContain('sk-persistent-provider');
  });

  it('authenticates ciphertext and binds it to its provider', () => {
    storeProviderCredential('openai', 'sk-authenticated-secret');
    saveCredential('anthropic', storedCredential('openai')!.encrypted_value);
    expect(() => providerCredential('anthropic')).toThrow('Unable to decrypt');
  });

  it('supports host-managed encryption and administrator secrets', () => {
    vi.stubEnv('AI_MODEL_ROUTER_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('AI_MODEL_ROUTER_ADMIN_KEY', 'host-admin-key-at-least-32-characters');
    initializeCredentials();
    expect(administratorKey()).toBe('host-admin-key-at-least-32-characters');
    storeProviderCredential('groq', 'gsk-fixture-secret');
    resetCredentialsForTests(); initializeCredentials();
    expect(providerCredential('groq')).toBe('gsk-fixture-secret');
  });

  it('refuses to replace a lost key when encrypted data already exists', () => {
    storeProviderCredential('openai', 'sk-important-data');
    resetCredentialsForTests();
    vi.stubEnv('DATABASE_PATH', join(directory, 'router.db'));
    expect(() => initializeCredentials()).toThrow('encryption key is missing');
  });

  it('rejects invalid encryption keys and corrupted key files', () => {
    vi.stubEnv('AI_MODEL_ROUTER_ENCRYPTION_KEY', 'invalid');
    expect(() => initializeCredentials()).toThrow('32 random bytes');
    vi.stubEnv('AI_MODEL_ROUTER_ENCRYPTION_KEY', '');
    vi.stubEnv('DATABASE_PATH', join(directory, 'router.db'));
    writeFileSync(join(directory, 'credentials.key'), 'invalid');
    expect(() => initializeCredentials()).toThrow('Invalid credentials.key');
  });
});
