import { describe, it, expect } from 'vitest';
import { ApiError, UNREACHABLE, describeError } from '../api';

/**
 * Every message a page shows for a failed request comes through describeError.
 * The settings page once showed "Failed to fetch", which is what Chrome calls a
 * router that is not answering, while the page beside it explained the same
 * failure in a sentence. These pin the translation each source gets.
 */
describe('describeError', () => {
  it('passes the API message through, because it was written for the reader', () => {
    expect(describeError(new ApiError('Administrator key required.', 401), 'fallback')).toBe('Administrator key required.');
  });

  it('replaces the browser network error, whatever its wording', () => {
    expect(describeError(new TypeError('Failed to fetch'), 'fallback')).toBe(UNREACHABLE);
    expect(describeError(new TypeError('Load failed'), 'fallback')).toBe(UNREACHABLE);
  });

  it('names the timeout as a timeout, not as a router that is down', () => {
    expect(describeError(new DOMException('signal timed out', 'TimeoutError'), 'fallback')).toMatch(/did not answer/);
  });

  it("keeps the client's own errors, which are not network errors", () => {
    expect(describeError(new Error('Use HTTPS for a remote router before sending credentials. HTTP is supported only on localhost.'), 'fallback')).toMatch(/^Use HTTPS/);
  });

  it('falls back when there is nothing to say', () => {
    expect(describeError('unknown', 'Could not save the key.')).toBe('Could not save the key.');
    expect(describeError(new Error(''), 'Could not save the key.')).toBe('Could not save the key.');
  });
});
