#!/usr/bin/env tsx
/**
 * Print a random API key for AI_MODEL_ROUTER_API_KEY.
 *
 * Only needed if you expose the API beyond localhost: with AI_MODEL_ROUTER_API_KEY unset
 * the server accepts local requests without a key.
 *
 *   npm run generate-key --workspace=apps/api
 */
import { randomBytes } from 'node:crypto';

const key = `ai-model-router_${randomBytes(24).toString('base64url')}`;

console.log('Add this to apps/api/.env:\n');
console.log(`AI_MODEL_ROUTER_API_KEY=${key}\n`);
console.log('Then send it as "Authorization: Bearer <key>" (or X-API-Key) on /v1 requests.');
