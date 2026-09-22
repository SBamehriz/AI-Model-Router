import { apiBaseUrl } from './api';

/**
 * Turn a failed request into something the reader can act on. A page that only
 * says it failed leaves them guessing whether the server is down, the address
 * is wrong, or a key is missing.
 */
export function errorHint(message: string): string | undefined {
  if (/could not reach/i.test(message)) {
    return `Nothing is answering at ${apiBaseUrl()}. Start it with "npm run dev" from the repository root, or change the address in Settings.`;
  }
  if (/401|403|api key|administrator key/i.test(message)) {
    return 'Open Settings and unlock with the administrator key from "npm run admin:key" or your hosting secrets. Use a router key only in your apps.';
  }
  if (/429|rate limit/i.test(message)) {
    return 'The instance is rate limiting. Retry in a moment, or raise RATE_LIMIT_MAX.';
  }
  return undefined;
}
