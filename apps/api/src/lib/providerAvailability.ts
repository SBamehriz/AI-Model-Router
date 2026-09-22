/**
 * Which providers the router may consider: every one with a key configured.
 * With no key at all the server runs offline, where all providers stay
 * selectable and completions are simulated, so routing can be exercised before
 * any credentials exist.
 */

import { providerCredentialStatus } from './credentials.js';
import { envFlag } from './env.js';

export const ALL_PROVIDERS = ['openai', 'anthropic', 'google', 'openrouter', 'groq'] as const;

/** Providers with a configured API key. */
export function configuredProviders(): string[] {
  return providerCredentialStatus().filter((p) => p.configured).map((p) => p.provider);
}

/** True when AI_MODEL_ROUTER_OFFLINE itself forced simulation, whatever is configured. */
export function isForcedOffline(): boolean {
  return envFlag('AI_MODEL_ROUTER_OFFLINE') === true;
}

/**
 * True when completions are simulated rather than sent. Automatic when no key
 * is configured, and forced either way by AI_MODEL_ROUTER_OFFLINE.
 */
export function isOfflineMode(): boolean {
  return envFlag('AI_MODEL_ROUTER_OFFLINE') ?? configuredProviders().length === 0;
}

/** Providers the router may route to right now. */
export function availableProviders(): string[] {
  const configured = configuredProviders();
  return configured.length > 0 ? configured : [...ALL_PROVIDERS];
}
