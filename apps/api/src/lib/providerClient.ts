import pTimeout from 'p-timeout';
import pRetry, { AbortError } from 'p-retry';

export interface ProviderCallOptions {
  signal?: AbortSignal;
  timeout?: number;
  retries?: number;
  minRetryDelay?: number;
  maxRetryDelay?: number;
}

/**
 * One deadline for every completion, on both the original and the compatible
 * path. A hard reasoning prompt is exactly what the router sends to its best
 * models, and those answers do not arrive in thirty seconds. The two paths
 * drifted apart once already, which made the same prompt succeed through
 * /v1/chat/completions and fail through /v1/chat.
 *
 * The outer deadline sits above the HTTP one so the request that produced the
 * timeout is the one reported. A slow model answers slowly on the retry too,
 * so one retry is the useful number: it covers a dropped connection without
 * paying the full deadline three times over.
 */
export const PROVIDER_HTTP_DEADLINE_MS = 60_000;
export const PROVIDER_CALL_TIMEOUT_MS = 65_000;
export const PROVIDER_CALL_RETRIES = 1;

const DEFAULT_TIMEOUT = PROVIDER_CALL_TIMEOUT_MS;
const DEFAULT_RETRIES = PROVIDER_CALL_RETRIES;
const DEFAULT_MIN_RETRY_DELAY = 1000; // 1 second
const DEFAULT_MAX_RETRY_DELAY = 3000; // 3 seconds

type RetryLogger = (info: { provider: string; attempt: number; retriesLeft: number; error: string }) => void;

/** Silent by default. The server points this at its logger on start-up. */
let retryLogger: RetryLogger = () => {};

export function setRetryLogger(logger: RetryLogger): void {
  retryLogger = logger;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public statusCode?: number,
    public isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * The provider answered, and the answer was no: a content filter, a safety
 * block or an explicit refusal. That is a result, not a transport failure, so
 * it is never retried and never falls back to another model.
 */
export class ProviderRefusalError extends Error {
  constructor(
    message: string,
    public provider: string,
    public reason: string
  ) {
    super(message);
    this.name = 'ProviderRefusalError';
  }
}

/**
 * Transport failures worth retrying: the request never produced an answer.
 * Matching is on the error name first, because message text differs between
 * runtimes and libraries.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (['TimeoutError', 'AbortError', 'FetchError'].includes(error.name)) return true;
  return /timed out|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network error/i.test(
    error.message
  );
}

/**
 * Run a provider call under a deadline, retrying what is worth retrying.
 *
 * `fn` receives the attempt's AbortSignal and must pass it to whatever it
 * starts. A timeout that only stops waiting is not a timeout: the request would
 * keep a socket and a provider side generation alive, and overlap the retry
 * meant to replace it. Each attempt is aborted before the next one begins.
 */
export async function callProviderWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  provider: string,
  options: ProviderCallOptions = {}
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const minRetryDelay = options.minRetryDelay ?? DEFAULT_MIN_RETRY_DELAY;
  const maxRetryDelay = options.maxRetryDelay ?? DEFAULT_MAX_RETRY_DELAY;

  return pRetry(
    async () => {
      const controller = new AbortController();
      try {
        // Wrap in timeout
        return await pTimeout(fn(controller.signal), {
          milliseconds: timeout,
          signal: options.signal,
          message: `Provider ${provider} timed out after ${timeout}ms`,
        });
      } catch (error) {
        // Whatever this attempt still has in flight is now unwanted work.
        controller.abort(error instanceof Error ? error : new Error(String(error)));

        // An explicit refusal is the provider's answer. Retrying it would ask
        // the same question twice. Falling back would ask a different model.
        if (error instanceof ProviderRefusalError) {
          throw new AbortError(error);
        }

        // Determine if error is retryable
        if (error instanceof ProviderError) {
          if (!error.isRetryable) {
            // Non-retryable error - abort immediately, keeping the status code
            throw new AbortError(error);
          }
          throw error; // Retryable - let pRetry handle it
        }

        // Transport-level failures are worth another attempt.
        if (isTransientError(error)) {
          throw new ProviderError(error instanceof Error ? error.message : String(error), provider, undefined, true);
        }

        // Unknown errors - don't retry to avoid wasting time
        throw new AbortError(error instanceof Error ? error : new Error('Unknown error'));
      }
    },
    {
      retries,
      signal: options.signal,
      minTimeout: minRetryDelay,
      maxTimeout: maxRetryDelay,
      onFailedAttempt: (context) => {
        retryLogger({
          provider,
          attempt: context.attemptNumber,
          retriesLeft: context.retriesLeft,
          error: context.error instanceof Error ? context.error.message : String(context.error),
        });
      },
    }
  );
}

/** 408, 429 and server errors are worth another attempt. 501 is not. */
export function isRetryableStatusCode(status: number): boolean {
  // 408 Request Timeout
  // 429 Too Many Requests
  // 500-599 Server Errors (except 501 Not Implemented)
  return (
    status === 408 ||
    status === 429 ||
    (status >= 500 && status < 600 && status !== 501)
  );
}

/** What a provider call got back: parsed JSON, or the status and raw body of a failure. */
export type ProviderHttpResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; body: string };

/** Read an error body without letting a second failure mask the first. */
async function readBodyText(response: Response): Promise<string> {
  if (typeof response.text !== 'function') return '';
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Release a body nobody is going to read, so the socket is not held open. */
async function discardBody(response: Response | undefined): Promise<void> {
  const body = (response as { body?: { cancel?: () => Promise<unknown> } } | undefined)?.body;
  if (!body || typeof body.cancel !== 'function') return;
  try {
    await body.cancel();
  } catch {
    // Already cancelled or never streamed, so there is nothing to release.
  }
}

/**
 * Fetch JSON under a single deadline covering headers and body.
 *
 * A timer armed only around `fetch` is not a deadline: fetch resolves when the
 * headers arrive, so a body that never finishes would hang with the timer
 * already cleared. A body nobody will read is released before the error
 * propagates.
 */
export async function fetchProviderJson(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = PROVIDER_HTTP_DEADLINE_MS,
  signal?: AbortSignal
): Promise<ProviderHttpResult> {
  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onOuterAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) onOuterAbort();
  else signal?.addEventListener('abort', onOuterAbort, { once: true });

  let response: Response | undefined;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });

    if (!response.ok) {
      return { ok: false, status: response.status, body: await readBodyText(response) };
    }

    return { ok: true, status: response.status, data: await response.json() };
  } catch (error) {
    await discardBody(response);
    if (timedOut) throw new Error(`Request timeout after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
