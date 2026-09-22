import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_DATABASE_PATH } from './db/index.js';
import { listCustomProviders } from './db/customProviders.js';
import { credentialCount, deleteCredential, saveCredential, saveIntegrationKey, storedCredential, type IntegrationKey } from './db/credentials.js';

export const PROVIDER_ENV = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY' } as const;
export type ProviderId = keyof typeof PROVIDER_ENV;
let masterKey: Buffer | undefined;

/** The encryption key lives outside SQLite, or in the host secret store. */
export function initializeCredentials(): void {
  if (masterKey) return;
  const configured = process.env.AI_MODEL_ROUTER_ENCRYPTION_KEY;
  if (configured) {
    const decoded = Buffer.from(configured, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== configured) throw new Error('AI_MODEL_ROUTER_ENCRYPTION_KEY must be 32 random bytes in base64');
    masterKey = decoded;
    return;
  }
  const database = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
  if (database === ':memory:') { masterKey = randomBytes(32); return; }
  const file = resolve(dirname(database), 'credentials.key');
  if (!existsSync(file)) {
    if (credentialCount() > 0) throw new Error('The encryption key is missing. Restore credentials.key or AI_MODEL_ROUTER_ENCRYPTION_KEY from your backup.');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (err) { if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err; }
  }
  const decoded = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (decoded.length !== 32) throw new Error('Invalid credentials.key file');
  masterKey = decoded;
}

function encryptionKey(): Buffer {
  initializeCredentials();
  return masterKey!;
}

/** Used by the local command only. Never returned over HTTP. */
export function administratorKey(): string {
  return process.env.AI_MODEL_ROUTER_ADMIN_KEY?.trim() || `amr_admin_${createHmac('sha256', encryptionKey()).update('ai-model-router:administrator:v1').digest('base64url')}`;
}

export function isAdministratorKey(key: string): boolean {
  // An arbitrary bearer token must not cause a key file to be written.
  if (!masterKey && !process.env.AI_MODEL_ROUTER_ADMIN_KEY) return false;
  return timingSafeEqual(createHash('sha256').update(key).digest(), createHash('sha256').update(administratorKey()).digest());
}

export function providerCredential(provider: string): string {
  const name = PROVIDER_ENV[provider as ProviderId];
  const environment = name ? process.env[name]?.trim() : undefined;
  if (environment) return environment;
  const row = storedCredential(provider);
  if (!row) return '';
  const [iv, tag, ciphertext] = row.encrypted_value.split('.').map((part) => Buffer.from(part, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAAD(Buffer.from(provider));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Error('Unable to decrypt provider credentials. Check the encryption key.'); }
}

export function credentialForEnvironment(name: string): string {
  const provider = (Object.keys(PROVIDER_ENV) as ProviderId[]).find((p) => PROVIDER_ENV[p] === name);
  return provider ? providerCredential(provider) : '';
}

export function storeProviderCredential(provider: string, value: string): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(provider));
  const encrypted = Buffer.concat([cipher.update(value.trim(), 'utf8'), cipher.final()]);
  saveCredential(provider, [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.'));
}

export function removeProviderCredential(provider: string): void { deleteCredential(provider); }

export function providerCredentialStatus(): Array<{ provider: string; configured: boolean; source: 'environment' | 'settings' | null; updated_at: number | null }> {
  return [...Object.keys(PROVIDER_ENV), ...listCustomProviders().map((p) => p.provider)].map((provider) => {
    const name = PROVIDER_ENV[provider as ProviderId];
    const env = name ? !!process.env[name]?.trim() : false;
    const saved = storedCredential(provider);
    return { provider, configured: env || !!saved, source: env ? 'environment' : saved ? 'settings' : null, updated_at: saved?.updated_at ?? null };
  });
}

export function hashIntegrationKey(key: string): string { return createHash('sha256').update(key).digest('hex'); }

export function createIntegrationKey(name: string): IntegrationKey & { key: string } {
  const key = `amr_${randomBytes(32).toString('base64url')}`;
  const record = { id: randomUUID(), name, prefix: key.slice(0, 12), created_at: Date.now() };
  saveIntegrationKey(record, hashIntegrationKey(key));
  return { ...record, key };
}

export function resetCredentialsForTests(): void { masterKey = undefined; }
