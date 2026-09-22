import { estimateTokensFromMessages } from '../tokens.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../messages.js';

import { chatWithProvider } from '../providers.js';
import { ProviderRefusalError } from '../providerClient.js';

// These tests drive the real provider adapters through a mocked fetch, so the
// offline stand-in must stay out of the way and every adapter needs a key.
process.env.AI_MODEL_ROUTER_OFFLINE = '0';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.GOOGLE_API_KEY = 'test-google-key';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.GROQ_API_KEY = 'test-groq-key';

/**
 * Provider Fallback Chain Tests
 *
 * Tests the retry logic and fallback behavior when provider APIs fail.
 *
 * Scenarios:
 * - The primary model succeeds, so it returns immediately.
 * - The primary fails, the backup is tried and it succeeds.
 * - The primary and the backup both fail, so the cheapest fallback is tried.
 * - Every model fails, so an error comes back.
 * - Retryable errors (408, 429, 5xx) are retried with backoff.
 * - Errors that are not retryable (400, 401, 404) fail immediately.
 */

describe('Provider Fallback Chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drive the real provider adapters, not the offline stand-in.
    process.env.AI_MODEL_ROUTER_OFFLINE = '0';
  });

  const mockMessages: ChatMessage[] = [
    { role: 'user', content: 'Hello' },
  ];

  describe('Successful Cases', () => {
    it('should return immediately when primary model succeeds', async () => {
      // Mock successful OpenAI call
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello!' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.content).toBe('Hello!');
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle multi-turn conversations', async () => {
      const multiTurnMessages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'I am fine, thank you!' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', multiTurnMessages);

      expect(result.content).toBe('I am fine, thank you!');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Retryable Error Handling', () => {
    const success = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Success after retry' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };

    it.each([
      ['429 rate limit', { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => '' }],
      ['500 server error', { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '' }],
      ['503 unavailable', { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => '' }],
    ])('retries a %s and returns the answer from the second attempt', async (_label, failure) => {
      const mockFetch = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success);
      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.content).toBe('Success after retry');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 15000);

    it('retries a transport failure the same way', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(success);
      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.content).toBe('Success after retry');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }, 15000);
  });

  describe('Non-Retryable Error Handling', () => {
    it.each([
      ['400 bad request', 400],
      ['401 unauthorized', 401],
      ['404 not found', 404],
    ])('fails a %s immediately, without a second attempt', async (_label, status) => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: 'Error',
        text: async () => JSON.stringify({ error: { message: 'Provider said no' } }),
      });
      global.fetch = mockFetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(
        new RegExp(`Provider error: ${status}`)
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps the provider body out of the error it raises', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'sk-secret-key-echoed-back by the provider',
      });

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(
        /Provider error: 400 \(details redacted\)/
      );
    });
  });

  describe('Provider-Specific Behavior', () => {
    it('should handle OpenAI response format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OpenAI response' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.content).toBe('OpenAI response');
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });

    it('should handle Anthropic response format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Anthropic response' }],
          usage: { input_tokens: 15, output_tokens: 8 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider(
        'anthropic',
        'claude-3-5-sonnet-20241022',
        mockMessages
      );

      expect(result.content).toBe('Anthropic response');
      expect(result.inputTokens).toBe(15);
      expect(result.outputTokens).toBe(8);
    });

    it('should handle Gemini response format', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { parts: [{ text: 'Gemini response' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 6,
          },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('google', 'gemini-1.5-flash', mockMessages);

      expect(result.content).toBe('Gemini response');
      expect(result.inputTokens).toBe(12);
      expect(result.outputTokens).toBe(6);
    });

    it('should handle OpenRouter response format (OpenAI-compatible)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OpenRouter response' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openrouter', 'any-model', mockMessages);

      expect(result.content).toBe('OpenRouter response');
      expect(result.inputTokens).toBe(11);
      expect(result.outputTokens).toBe(7);
    });

    it('should handle Groq response format (OpenAI-compatible)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Groq response' } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('groq', 'llama-3.1-8b-instant', mockMessages);

      expect(result.content).toBe('Groq response');
      expect(result.inputTokens).toBe(9);
      expect(result.outputTokens).toBe(4);
    });
  });

  describe('Token Estimation Fallback', () => {
    it('should estimate tokens when provider does not return usage', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Response without usage data' } }],
          // Missing usage field
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.content).toBe('Response without usage data');
      // Should have estimated token counts (not zero)
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    });

    it('should use rough estimation for missing token counts', async () => {
      // Input: "Hello" = ~1 token
      // Output: "Response without usage data" = ~4-5 tokens
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Short' } }],
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      // Rough estimate should be non-zero
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    });
  });

  describe('Error Message Extraction', () => {
    /** Minimal stand-in for a failed fetch Response. */
    const errorResponse = (status: number, body: string) => ({
      ok: false,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    });

    it('surfaces the status and redacts the provider body', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        errorResponse(400, JSON.stringify({ error: { message: 'sk-secret-key is invalid' } }))
      ) as unknown as typeof fetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(/400/);
      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.not.toThrow(
        /sk-secret-key/
      );
    });

    it('handles an error body that is not JSON', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        errorResponse(500, '<html>gateway error</html>')
      ) as unknown as typeof fetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(/500/);
    });

    it('propagates a transport failure', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('socket hang up')) as unknown as typeof fetch;

      await expect(chatWithProvider('groq', 'llama-3.3-70b-versatile', mockMessages)).rejects.toThrow(
        /socket hang up/
      );
    });
  });

  /**
   * A 200 is not the same as an answer. These pin the difference between a
   * provider that answered, one that declined, and one that returned something
   * the adapter cannot read, which used to be recorded, identically, as a
   * successful completion with empty output.
   */
  describe('Malformed Responses', () => {
    const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    const providers: Array<[string, string]> = [
      ['openai', 'gpt-4o-mini'],
      ['openrouter', 'any-model'],
      ['groq', 'llama-3.1-8b-instant'],
      ['anthropic', 'claude-3-5-sonnet-20241022'],
      ['google', 'gemini-1.5-flash'],
    ];

    it.each(providers)('rejects an empty body from %s rather than calling it an answer', async (provider, model) => {
      const mockFetch = vi.fn().mockResolvedValue(respond({}));
      global.fetch = mockFetch as unknown as typeof fetch;

      await expect(chatWithProvider(provider, model, mockMessages)).rejects.toThrow(
        /returned a malformed completion/
      );
      // Malformed is not transient: retrying the same broken shape only costs
      // another call, so the chain moves to a different model instead.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects an OpenAI-shaped body whose choice carries no content', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(respond({ choices: [{ message: {} }] })) as unknown as typeof fetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(
        /no message content/
      );
    });

    it('rejects a Gemini candidate with no parts', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(respond({ candidates: [{ content: {} }] })) as unknown as typeof fetch;

      await expect(chatWithProvider('google', 'gemini-1.5-flash', mockMessages)).rejects.toThrow(
        /no content parts/
      );
    });

    it('rejects an empty completion even in a well-formed envelope', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        respond({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 10, completion_tokens: 0 } })
      ) as unknown as typeof fetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(/empty completion/);
    });
  });

  describe('Refusals', () => {
    const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    const refusals: Array<[string, string, string, unknown]> = [
      ['openai', 'gpt-4o-mini', 'refusal', { choices: [{ message: { content: null, refusal: 'I cannot help with that' } }] }],
      ['openai', 'gpt-4o-mini', 'content_filter', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }],
      ['anthropic', 'claude-3-5-sonnet-20241022', 'refusal', { content: [{ type: 'text', text: '' }], stop_reason: 'refusal' }],
      ['google', 'gemini-1.5-flash', 'safety', { promptFeedback: { blockReason: 'SAFETY' } }],
      ['google', 'gemini-1.5-flash', 'safety', { candidates: [{ finishReason: 'SAFETY' }] }],
      // Captured from the live Gemini API in September 2026. A real block
      // carries `content: {}` with no parts array, so anything that reads the
      // content before checking the finish reason sees a malformed body and
      // retries a refusal on the next model.
      ['google', 'gemini-3.1-flash-lite', 'safety', {
        candidates: [{
          content: {},
          finishReason: 'SAFETY',
          index: 0,
          finishMessage: 'The model output could not be generated.',
          safetyRatings: [
            { category: 'HARM_CATEGORY_HARASSMENT', probability: 'MEDIUM' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'LOW' },
          ],
        }],
        usageMetadata: { promptTokenCount: 13, totalTokenCount: 13 },
        modelVersion: 'gemini-3.1-flash-lite',
      }],
    ];

    it.each(refusals)('reports a %s %s as a refusal, not a failure to retry', async (provider, model, reason, body) => {
      const mockFetch = vi.fn().mockResolvedValue(respond(body));
      global.fetch = mockFetch as unknown as typeof fetch;

      await expect(chatWithProvider(provider, model, mockMessages)).rejects.toBeInstanceOf(
        ProviderRefusalError
      );
      await expect(chatWithProvider(provider, model, mockMessages)).rejects.toMatchObject({ reason });
      // Two calls for the two assertions above, and no retry within either.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * Usage numbers become costs, savings and dashboard totals. A count that
   * cannot have happened must not survive the adapter boundary.
   */
  describe('Usage Validation', () => {
    const respond = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    it('ignores negative OpenAI usage and estimates instead', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        respond({
          choices: [{ message: { content: 'answer' } }],
          usage: { prompt_tokens: -100, completion_tokens: -20 },
        })
      ) as unknown as typeof fetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
    });

    it('ignores negative Anthropic and Gemini usage', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        respond({
          content: [{ type: 'text', text: 'answer' }],
          usage: { input_tokens: -5, output_tokens: -5 },
        })
      ) as unknown as typeof fetch;
      const anthropic = await chatWithProvider('anthropic', 'claude-3-5-sonnet-20241022', mockMessages);
      expect(anthropic.inputTokens).toBeGreaterThan(0);
      expect(anthropic.outputTokens).toBeGreaterThan(0);

      global.fetch = vi.fn().mockResolvedValue(
        respond({
          candidates: [{ content: { parts: [{ text: 'answer' }] } }],
          usageMetadata: { promptTokenCount: -1, candidatesTokenCount: -1 },
        })
      ) as unknown as typeof fetch;
      const gemini = await chatWithProvider('google', 'gemini-1.5-flash', mockMessages);
      expect(gemini.inputTokens).toBeGreaterThan(0);
      expect(gemini.outputTokens).toBeGreaterThan(0);
    });

    it('discards fractional and non-numeric usage in favor of estimates', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        respond({
          choices: [{ message: { content: 'answer' } }],
          usage: { prompt_tokens: 10.6, completion_tokens: 'twelve' },
        })
      ) as unknown as typeof fetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.inputTokens).toBe(estimateTokensFromMessages(mockMessages).inputTokens);
      expect(Number.isInteger(result.outputTokens)).toBe(true);
      expect(result.outputTokens).toBeGreaterThan(0);
    });

    it('keeps a zero the provider actually reported', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        respond({
          choices: [{ message: { content: 'Cached answer' } }],
          usage: { prompt_tokens: 7, completion_tokens: 0 },
        })
      ) as unknown as typeof fetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', mockMessages);

      expect(result.inputTokens).toBe(7);
      expect(result.outputTokens).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long messages', async () => {
      const longContent = 'A'.repeat(10000); // 10k chars
      const longMessages: ChatMessage[] = [
        { role: 'user', content: longContent },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Response' } }],
          usage: { prompt_tokens: 2500, completion_tokens: 10 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', longMessages);

      expect(result.inputTokens).toBeGreaterThan(1000);
    });

    it('should handle empty provider response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '' } }],
          usage: { prompt_tokens: 10, completion_tokens: 0 },
        }),
      });

      global.fetch = mockFetch;

      await expect(chatWithProvider('openai', 'gpt-4o-mini', mockMessages)).rejects.toThrow(/empty completion/);
    });

    it('should handle special characters in messages', async () => {
      const specialMessages: ChatMessage[] = [
        { role: 'user', content: 'Test with émojis 🚀 and symbols ™️ © ®' },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Handled ✓' } }],
          usage: { prompt_tokens: 15, completion_tokens: 5 },
        }),
      });

      global.fetch = mockFetch;

      const result = await chatWithProvider('openai', 'gpt-4o-mini', specialMessages);

      expect(result.content).toBe('Handled ✓');
    });
  });
});
