import { getDb, setMeta, withTransaction } from './index.js';

export type StoredCredential = { provider: string; encrypted_value: string; updated_at: number };
export type IntegrationKey = { id: string; name: string; prefix: string; created_at: number };

export function storedCredential(provider: string): StoredCredential | undefined {
  return getDb().prepare('SELECT * FROM provider_credentials WHERE provider = ?').get(provider) as StoredCredential | undefined;
}

export function saveCredential(provider: string, encrypted: string): void {
  getDb().prepare('INSERT INTO provider_credentials (provider, encrypted_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at').run(provider, encrypted, Date.now());
}

export function deleteCredential(provider: string): void {
  getDb().prepare('DELETE FROM provider_credentials WHERE provider = ?').run(provider);
}

export function credentialCount(): number {
  return Number(getDb().prepare('SELECT COUNT(*) AS n FROM provider_credentials').get()!.n);
}

export function listIntegrationKeys(): IntegrationKey[] {
  return getDb().prepare('SELECT id, name, prefix, created_at FROM integration_keys ORDER BY created_at DESC').all() as IntegrationKey[];
}

export function saveIntegrationKey(key: IntegrationKey, hash: string): void {
  withTransaction(() => {
    getDb().prepare('INSERT INTO integration_keys (id, name, prefix, created_at, key_hash) VALUES (?, ?, ?, ?, ?)').run(key.id, key.name, key.prefix, key.created_at, hash);
    // Revoking the last key must never reopen the API.
    setMeta('integration_auth_enabled', '1');
  });
}

export function acceptsIntegrationKey(hash: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM integration_keys WHERE key_hash = ?').get(hash);
}

export function revokeIntegrationKey(id: string): boolean {
  return getDb().prepare('DELETE FROM integration_keys WHERE id = ?').run(id).changes > 0;
}
