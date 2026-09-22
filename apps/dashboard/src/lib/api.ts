/**
 * Typed client for the API. Every shape here mirrors a real response. A field
 * the API does not return does not belong in this file.
 */

import { apiBaseUrl, apiKey } from './settings';
export { apiBaseUrl, apiKey, saveSettings, clearSettings } from './settings';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = apiKey();
  const destination = new URL(apiBaseUrl());
  if ((key || path.startsWith('/admin/')) && destination.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname)) {
    throw new Error('Use HTTPS for a remote router before sending credentials. HTTP is supported only on localhost.');
  }
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)]),
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(body.error?.message ?? `Request failed (${response.status})`, response.status);
  }

  return (await response.json()) as T;
}

/**
 * What a failed request should say. The API writes its messages for the
 * reader, and so does the HTTPS rule above. The browser does not: a router
 * that is not answering surfaces as "Failed to fetch" in one browser and
 * "Load failed" in another, and a timeout as a DOMException, none of which
 * tells anyone what to do next. Every catch that shows a message goes
 * through here, so the wording is the same on every page.
 */
export const UNREACHABLE = 'Could not reach the API. Check the router address in Settings and confirm the server is running.';

export function describeError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && err.name === 'TimeoutError') return `The router at ${apiBaseUrl()} did not answer within two minutes.`;
  if (err instanceof TypeError) return UNREACHABLE;
  return err instanceof Error && err.message ? err.message : fallback;
}

// --- GET /health -----------------------------------------------------------

export type Health = {
  status: string;
  offline_mode: boolean;
  providers: string[];
  auth_required: boolean;
  catalog: { models: number; last_sync_at: number | null; source: string | null; stale: boolean };
};

export const fetchHealth = (signal?: AbortSignal) => request<Health>('/health', { signal });

// --- GET /v1/usage ---------------------------------------------------------

export type Usage = {
  by_source: Array<{ source: RequestSource; requests: number }>;
  total_requests: number;
  total_cost: number;
  total_savings: number;
  total_tokens: number;
  total_tokens_input: number;
  total_tokens_output: number;
  avg_latency_ms: number;
  success_rate: number;
  by_day: Array<{ date: string; requests: number; cost: number; savings: number }>;
  by_model: Array<{
    model: string;
    provider: string;
    requests: number;
    cost: number;
    savings: number;
    avg_latency_ms: number;
  }>;
  by_task: Array<{ task_type: string; requests: number; cost: number; avg_complexity: number | null }>;
};

export function fetchUsage(
  range: { from?: string; to?: string } = {},
  signal?: AbortSignal
): Promise<Usage> {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  const query = params.toString();
  return request<Usage>(`/v1/usage${query ? `?${query}` : ''}`, { signal });
}

// --- GET /v1/models --------------------------------------------------------

export type Model = {
  id: string;
  provider: string;
  model_name: string;
  display_name: string | null;
  cost_input: number;
  cost_output: number;
  avg_latency: number;
  strengths: string[];
  quality_rating: number | null;
  speed_index: number | null;
  price_index: number | null;
  supports_functions: boolean;
  supports_vision: boolean;
  max_tokens: number | null;
  deprecated: boolean;
  data_source: string;
  last_synced_at: string | null;
  observed_latency_ms: number | null;
  provider_configured: boolean;
};

export type ModelsResponse = {
  models: Model[];
  catalog: { models: number; last_sync_at: number | null; source: string | null; stale: boolean };
  offline_mode: boolean;
};

export const fetchModels = (signal?: AbortSignal) =>
  request<ModelsResponse>('/v1/models', { signal });

// --- GET /v1/requests ------------------------------------------------------

export type RoutingDetail = {
  considered_models: Array<{ provider: string; model_name: string; score?: number }>;
  final_model: string;
  reason: string | null;
  weights: Record<string, number> | null;
  constraints: Record<string, unknown> | null;
  classification_method: string | null;
  confidence: number | null;
};

export type RequestSource = 'live' | 'offline' | 'demo' | 'unknown';

export type RequestLogEntry = {
  source: RequestSource;
  id: string;
  created_at: string;
  endpoint: string;
  task_type: string;
  complexity: number | null;
  priority: string;
  provider: string;
  model_used: string;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  savings: number;
  latency_ms: number;
  success: boolean;
  fallback_level: string | null;
  boost: boolean;
  routing: RoutingDetail | null;
};

export const fetchRequests = (limit = 50, signal?: AbortSignal) =>
  request<{ requests: RequestLogEntry[] }>(`/v1/requests?limit=${limit}`, { signal });

// --- POST /v1/router/debug -------------------------------------------------

export type Priority = 'cheap' | 'balanced' | 'best' | 'quality';
export type LatencyPref = 'fast' | 'normal';

export type RoutingExplanation = {
  task_type: string;
  classification: { confidence: number; method: string; reasoning: string };
  complexity: {
    score: number;
    factors: Record<string, number>;
    reasoning: string;
  };
  weights: { cost: number; latency: number; task: number; quality: number };
  constraints: {
    minCategorySkill: number;
    minReasoning: number;
    requireHardCoding: boolean;
    maxCost?: number;
  };
  considered_models: Array<{
    provider: string;
    model_name: string;
    score: number;
    quality_rating?: number;
  }>;
  selected_model: string;
  reason: string;
  boost_eligible: boolean;
  available_providers: string[];
  offline_mode: boolean;
  request_id: string;
};

export type RouteRequest = {
  prompt: string;
  priority: Priority;
  latency_pref: LatencyPref;
  max_cost?: number;
};

export function explainRouting(input: RouteRequest, signal?: AbortSignal): Promise<RoutingExplanation> {
  return request<RoutingExplanation>('/v1/router/debug', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      messages: [{ role: 'user', content: input.prompt }],
      priority: input.priority,
      latency_pref: input.latency_pref,
      ...(input.max_cost !== undefined ? { max_cost: input.max_cost } : {}),
    }),
  });
}

// --- POST /v1/chat ---------------------------------------------------------

export type ChatResponse = {
  routing: RoutingExplanation;
  output: string;
  model_used: string;
  provider: string;
  task_type: string;
  complexity: number;
  cost: number;
  latency_ms: number;
  savings_estimate: number;
  fallback_level: string;
  request_id: string;
};

export function sendChat(input: RouteRequest, signal?: AbortSignal): Promise<ChatResponse> {
  return request<ChatResponse>('/v1/chat', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      messages: [{ role: 'user', content: input.prompt }],
      priority: input.priority,
      latency_pref: input.latency_pref,
      ...(input.max_cost !== undefined ? { max_cost: input.max_cost } : {}),
    }),
  });
}

// --- GET /v1/providers -----------------------------------------------------

export type ProviderStatus = {
  provider: string;
  configured: boolean;
  attempts: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  failures: number;
  last_failure_at: string | null;
};

export const fetchProviders = (signal?: AbortSignal) =>
  request<{ offline_mode: boolean; providers: ProviderStatus[] }>('/v1/providers', { signal });

export type SavedProvider = { provider: string; configured: boolean; source: 'environment' | 'settings' | null; updated_at: number | null };
export type IntegrationKey = { id: string; name: string; prefix: string; created_at: number };
export type RouterSettings = { providers: SavedProvider[]; custom_providers: CustomProvider[]; keys: IntegrationKey[]; offline_mode: boolean; forced_offline: boolean };
export const fetchRouterSettings = (signal?: AbortSignal) => request<RouterSettings>('/admin/settings', { signal });
export const saveProviderKey = (provider: string, key: string) => request(`/admin/providers/${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify({ key }) });
export const removeProviderKey = (provider: string) => request(`/admin/providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
export const generateRouterKey = (name: string) => request<IntegrationKey & { key: string }>('/admin/keys', { method: 'POST', body: JSON.stringify({ name }) });
export const revokeRouterKey = (id: string) => request(`/admin/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

export type CustomModel = Omit<Model, 'last_synced_at' | 'observed_latency_ms' | 'provider_configured'> & { last_synced_at: number | null };
export type CustomProvider = { provider: string; name: string; base_url: string; models: CustomModel[] };
export type CustomProviderInput = Omit<CustomProvider, 'models'> & { key?: string; model: Pick<Model, 'model_name' | 'cost_input' | 'cost_output' | 'max_tokens' | 'supports_functions' | 'quality_rating' | 'avg_latency' | 'strengths'> };
export const saveCustomProvider = (value: CustomProviderInput) => request('/admin/custom-providers', { method: 'PUT', body: JSON.stringify(value) });
export const removeCustomProvider = (provider: string) => request(`/admin/custom-providers/${encodeURIComponent(provider)}`, { method: 'DELETE' });
