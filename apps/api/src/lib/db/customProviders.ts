import { getDb } from './index.js';

export type CustomProvider = { provider: string; name: string; base_url: string };

export function listCustomProviders(): CustomProvider[] {
  return getDb().prepare('SELECT provider, name, base_url FROM custom_providers ORDER BY name').all() as CustomProvider[];
}

export function customProvider(provider: string): CustomProvider | undefined {
  return getDb().prepare('SELECT provider, name, base_url FROM custom_providers WHERE provider = ?').get(provider) as CustomProvider | undefined;
}

export function saveCustomProvider(value: CustomProvider): void {
  getDb().prepare('INSERT INTO custom_providers (provider, name, base_url) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET name = excluded.name, base_url = excluded.base_url').run(value.provider, value.name, value.base_url);
}

export function deleteCustomProvider(provider: string): void {
  getDb().prepare('DELETE FROM models WHERE provider = ? AND data_source = ?').run(provider, 'custom');
  getDb().prepare('DELETE FROM custom_providers WHERE provider = ?').run(provider);
}
