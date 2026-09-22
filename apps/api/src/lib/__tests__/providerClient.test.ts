import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderError,
  ProviderRefusalError,
  callProviderWithRetry,
  fetchProviderJson,
  isRetryableStatusCode,
  isTransientError,
  setRetryLogger,
} from '../providerClient.js';

/** Retry delays do not affect the logic, so keep them near zero and tests stay fast. */
const fast = { retries: 2, minRetryDelay: 1, maxRetryDelay: 2 };

describe('isRetryableStatusCode', () => {
  it('retries transient statuses', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatusCode(status)).toBe(true);
    }
  });

  it('does not retry client errors or "not implemented"', () => {
    for (const status of [200, 400, 401, 403, 404, 422, 501]) {
      expect(isRetryableStatusCode(status)).toBe(false);
    }
  });
});

describe('callProviderWithRetry', () => {
  beforeEach(() => {
    setRetryLogger(() => {});
  });

  it('returns the result when the call succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(callProviderWithRetry(fn, 'openai', fast)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable provider error and returns the eventual success', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('429 rate limited', 'openai', 429, true))
      .mockResolvedValue('recovered');

    await expect(callProviderWithRetry(fn, 'openai', fast)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of retries', async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError('503', 'groq', 503, true));

    await expect(callProviderWithRetry(fn, 'groq', { ...fast, retries: 2 })).rejects.toThrow(/503/);
    expect(fn).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it('does not retry a non-retryable provider error', async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError('401 unauthorized', 'openai', 401, false));

    await expect(callProviderWithRetry(fn, 'openai', fast)).rejects.toThrow(/401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats connection failures as retryable', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'))
      .mockResolvedValue('recovered');

    await expect(callProviderWithRetry(fn, 'anthropic', fast)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unknown error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('something structural'));

    await expect(callProviderWithRetry(fn, 'google', fast)).rejects.toThrow(/something structural/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('times out a call that never settles, and retries it', async () => {
    const fn = vi.fn().mockImplementation(() => new Promise(() => {}));

    await expect(
      callProviderWithRetry(fn, 'openai', { ...fast, retries: 1, timeout: 20 })
    ).rejects.toThrow(/timed out after 20ms/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('hands each attempt a signal and aborts it when the attempt times out', async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(() => {});
    });

    await expect(
      callProviderWithRetry(fn, 'openai', { ...fast, retries: 1, timeout: 20 })
    ).rejects.toThrow(/timed out after 20ms/);

    // A timeout that only stops waiting leaves the request running: two
    // overlapping attempts, both still holding a socket and a generation.
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('aborts the attempt signal when the call fails outright', async () => {
    let captured: AbortSignal | undefined;
    const fn = vi.fn(async (signal: AbortSignal) => {
      captured = signal;
      throw new ProviderError('401 unauthorized', 'openai', 401, false);
    });

    await expect(callProviderWithRetry(fn, 'openai', fast)).rejects.toThrow(/401/);
    expect(captured?.aborted).toBe(true);
  });

  it('keeps the provider error type, so a status is not re-read from message text', async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError('service gone', 'openai', 404, false));

    await expect(callProviderWithRetry(fn, 'openai', fast)).rejects.toMatchObject({
      name: 'ProviderError',
      statusCode: 404,
    });
  });

  it('never retries a refusal, and surfaces it unchanged', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new ProviderRefusalError('declined', 'openai', 'content_filter'));

    await expect(callProviderWithRetry(fn, 'openai', fast)).rejects.toMatchObject({
      name: 'ProviderRefusalError',
      reason: 'content_filter',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each failed attempt to the retry logger', async () => {
    const entries: Array<{ provider: string; attempt: number }> = [];
    setRetryLogger((info) => entries.push(info));

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('429', 'groq', 429, true))
      .mockResolvedValue('ok');

    await callProviderWithRetry(fn, 'groq', fast);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ provider: 'groq', attempt: 1 });
  });
});

describe('fetchProviderJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed body of a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":1}', { status: 200 })));

    const result = await fetchProviderJson('https://example.test', {}, 1000);

    expect(result).toEqual({ ok: true, status: 200, data: { ok: 1 } });
  });

  it('returns the status and raw body of a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 503 })));

    const result = await fetchProviderJson('https://example.test', {}, 1000);

    expect(result).toEqual({ ok: false, status: 503, body: 'upstream exploded' });
  });

  it('forwards method and headers, and attaches an abort signal', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchProviderJson('https://example.test', { method: 'POST', headers: { a: 'b' } }, 1000);

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ a: 'b' });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('converts an abort into a timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
      )
    );

    await expect(fetchProviderJson('https://example.test', {}, 10)).rejects.toThrow(
      /Request timeout after 10ms/
    );
  });

  it('holds the deadline open until the body is read, not just the headers', async () => {
    // The defect: the abort timer was cleared as soon as fetch resolved, which
    // is when the *headers* arrive. A body that never finished streaming then
    // hung forever with nothing left to cancel it.
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          // A body that starts and never finishes.
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('body aborted')));
            }),
        } as unknown as Response;
      })
    );

    await expect(fetchProviderJson('https://example.test', {}, 20)).rejects.toThrow(
      /Request timeout after 20ms/
    );
    expect(requestSignal?.aborted).toBe(true);
  });

  it('cancels an outer deadline through to the request', async () => {
    const outer = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      })
    );

    const pending = fetchProviderJson('https://example.test', {}, 60_000, outer.signal);
    outer.abort(new Error('attempt is over'));

    await expect(pending).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('releases the body of a response it cannot use', async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: { cancel },
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }) as unknown as Response)
    );

    await expect(fetchProviderJson('https://example.test', {}, 1000)).rejects.toThrow(/JSON/);
    expect(cancel).toHaveBeenCalled();
  });

  it('propagates a non-abort network error unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dns failure'); }));
    await expect(fetchProviderJson('https://example.test', {}, 1000)).rejects.toThrow(/dns failure/);
  });
});

describe('isTransientError', () => {
  const named = (name: string, message = 'boom') => Object.assign(new Error(message), { name });

  it('recognises timeouts by error name, whatever the wording', () => {
    expect(isTransientError(named('TimeoutError', 'Provider openai timed out after 30000ms'))).toBe(true);
    expect(isTransientError(named('AbortError'))).toBe(true);
    expect(isTransientError(named('FetchError'))).toBe(true);
  });

  it('recognises connection failures by message', () => {
    for (const message of [
      'connect ECONNREFUSED 127.0.0.1:443',
      'read ECONNRESET',
      'connect ETIMEDOUT',
      'getaddrinfo EAI_AGAIN api.openai.com',
      'socket hang up',
      'Request timeout after 5000ms',
    ]) {
      expect(isTransientError(new Error(message))).toBe(true);
    }
  });

  it('does not treat application errors as transient', () => {
    expect(isTransientError(new Error('invalid api key'))).toBe(false);
    expect(isTransientError(new Error('model not found'))).toBe(false);
    expect(isTransientError('a string')).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});
