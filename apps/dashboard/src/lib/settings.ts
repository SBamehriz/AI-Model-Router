const BASE_STORAGE_KEY = 'ai-model-router.api_base';
const KEY_STORAGE_KEY = 'ai-model-router.api_key';
export const SETTINGS_EVENT = 'ai-model-router:settings';
let memoryBase: string | undefined;
let memoryKey: string | undefined;

export function apiBaseUrl(): string {
  if (memoryBase !== undefined) return memoryBase;
  const fallback = defaultBaseUrl();
  try { return localStorage.getItem(BASE_STORAGE_KEY) ?? fallback; } catch { return fallback; }
}

/** Keys live in this tab's session, never in the built bundle. */
export function apiKey(): string {
  if (memoryKey !== undefined) return memoryKey;
  try { return sessionStorage.getItem(KEY_STORAGE_KEY) ?? ''; } catch { return ''; }
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an http:// or https:// URL without credentials, a query, or a fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function saveSettings(settings: { baseUrl?: string; key?: string }): void {
  if (settings.baseUrl !== undefined) memoryBase = normalizeBaseUrl(settings.baseUrl);
  if (settings.key !== undefined) memoryKey = settings.key.trim();
  try {
    if (memoryBase !== undefined) localStorage.setItem(BASE_STORAGE_KEY, memoryBase);
    if (memoryKey !== undefined) sessionStorage.setItem(KEY_STORAGE_KEY, memoryKey);
  } catch { /* In-memory settings still work when storage is unavailable. */ }
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

export function clearSettings(): void {
  memoryBase = defaultBaseUrl();
  memoryKey = '';
  try {
    localStorage.removeItem(BASE_STORAGE_KEY);
    sessionStorage.removeItem(KEY_STORAGE_KEY);
  } catch { /* Storage is optional. */ }
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

function defaultBaseUrl(): string {
  return (import.meta.env.VITE_API_URL as string) || (import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin);
}
