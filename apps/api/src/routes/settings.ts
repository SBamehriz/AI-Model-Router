import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createIntegrationKey, PROVIDER_ENV, providerCredentialStatus, removeProviderCredential, storeProviderCredential, type ProviderId } from '../lib/credentials.js';
import { listIntegrationKeys, revokeIntegrationKey } from '../lib/db/credentials.js';
import { isForcedOffline, isOfflineMode } from '../lib/providerAvailability.js';
import { customProvider, listCustomProviders, saveCustomProvider, deleteCustomProvider } from '../lib/db/customProviders.js';
import { CustomProviderSchema } from '../lib/customProviders.js';
import { describeValidationFailure } from '../lib/schemas.js';
import { sanitizeLabel } from '../lib/sanitize.js';
import { listModels, upsertModels } from '../lib/db/models.js';
import { withTransaction } from '../lib/db/index.js';
import { invalidateModelCache } from '../lib/router.js';

const providerSchema = z.enum(['openai', 'anthropic', 'google', 'openrouter', 'groq']);
const keySchema = z.object({ key: z.string().trim().min(8).max(4096).regex(/^[\x21-\x7e]+$/) }).strict();
const nameSchema = z.object({ name: z.string().trim().min(1).max(80).transform(sanitizeLabel).refine((value) => value.length > 0, 'Name cannot be only formatting characters') }).strict();

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (_req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  app.get('/settings', async () => ({ providers: providerCredentialStatus(), custom_providers: listCustomProviders().map((p) => ({ ...p, models: listModels({ provider: p.provider }) })), keys: listIntegrationKeys(), offline_mode: isOfflineMode(), forced_offline: isForcedOffline() }));
  app.put('/custom-providers', async (req, reply) => {
    const parsed = CustomProviderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation_error', ...describeValidationFailure(parsed.error.issues) }, request_id: req.request_id });
    const value = parsed.data;
    const existing = customProvider(value.provider);
    if (!existing && !value.key) return reply.code(400).send({ error: { code: 'validation_error', message: 'Enter an API key for this new provider.' }, request_id: req.request_id });
    if (existing && existing.base_url !== value.base_url && !value.key) return reply.code(400).send({ error: { code: 'validation_error', message: 'Enter the key again when changing the API base URL.' }, request_id: req.request_id });
    withTransaction(() => {
      saveCustomProvider(value);
      if (value.key) storeProviderCredential(value.provider, value.key);
      upsertModels([{ ...value.model, provider: value.provider, display_name: value.model.model_name, supports_vision: false, speed_index: null, price_index: null, data_source: 'custom', last_synced_at: Date.now() }]);
    });
    invalidateModelCache();
    return { saved: true };
  });
  app.delete<{ Params: { provider: string } }>('/custom-providers/:provider', async (req, reply) => {
    if (!customProvider(req.params.provider)) return reply.code(404).send({ error: { code: 'not_found', message: 'Custom provider not found.' }, request_id: req.request_id });
    withTransaction(() => { removeProviderCredential(req.params.provider); deleteCustomProvider(req.params.provider); });
    invalidateModelCache();
    return { removed: true };
  });
  app.put<{ Params: { provider: string } }>('/providers/:provider', async (req, reply) => {
    const provider = providerSchema.safeParse(req.params.provider);
    const body = keySchema.safeParse(req.body);
    // Two schemas behind one answer used to mean the caller could not tell a
    // bad provider name from a bad key. Report whichever actually failed.
    if (!provider.success || !body.success) {
      const issues = [
        ...(provider.success ? [] : provider.error.issues.map((issue) => ({ ...issue, path: ['provider'] }))),
        ...(body.success ? [] : body.error.issues),
      ];
      return reply.code(400).send({ error: { code: 'validation_error', ...describeValidationFailure(issues) }, request_id: req.request_id });
    }
    if (process.env[PROVIDER_ENV[provider.data]]?.trim()) return reply.code(409).send({ error: { code: 'environment_managed', message: 'This key is managed by the server environment. Remove that environment value before editing it here.' }, request_id: req.request_id });
    storeProviderCredential(provider.data, body.data.key);
    return { saved: true, providers: providerCredentialStatus() };
  });
  app.delete<{ Params: { provider: string } }>('/providers/:provider', async (req, reply) => {
    if (!providerSchema.safeParse(req.params.provider).success) return reply.code(400).send({ error: { code: 'validation_error', message: 'Unknown provider.' }, request_id: req.request_id });
    if (process.env[PROVIDER_ENV[req.params.provider as ProviderId]]?.trim()) return reply.code(409).send({ error: { code: 'environment_managed', message: 'This key is managed by the server environment. Remove that environment value and restart the server.' }, request_id: req.request_id });
    removeProviderCredential(req.params.provider as ProviderId);
    return { removed: true, providers: providerCredentialStatus() };
  });
  app.post('/keys', async (req, reply) => {
    const body = nameSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: 'validation_error', message: 'Name this key using 1 to 80 characters.' }, request_id: req.request_id });
    if (listIntegrationKeys().length >= 50) return reply.code(409).send({ error: { code: 'key_limit', message: 'Revoke an unused key before creating another (maximum 50).' }, request_id: req.request_id });
    return reply.code(201).send(createIntegrationKey(body.data.name));
  });
  app.delete<{ Params: { id: string } }>('/keys/:id', async (req, reply) => {
    if (!revokeIntegrationKey(req.params.id)) return reply.code(404).send({ error: { code: 'not_found', message: 'Key not found.' }, request_id: req.request_id });
    return { revoked: true };
  });
};
