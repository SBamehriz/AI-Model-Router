import { describe, it, expect, beforeEach } from 'vitest';
import { explainNoCandidates, prepareChatRequest } from '../chatRequest.js';
import { seedCatalogFromConfig } from '../modelCatalog.js';
import { invalidateModelCache } from '../router.js';
import { getDb } from '../db/index.js';

/**
 * The single front door for /v1/chat, /v1/agent-step and /v1/router/debug.
 * Everything below is a property the three endpoints must share, because a
 * preview that validated or priced a different request than the run is worse
 * than no preview at all.
 */
describe('prepareChatRequest', () => {
  it('returns the message text exactly as it was sent', () => {
    const content = 'def example():\n    if True:\n        return "a  b"';
    const result = prepareChatRequest({ messages: [{ role: 'user', content }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages[0].content).toBe(content);
  });

  it('estimates tokens from the text that will actually be sent', () => {
    const padded = `hello${' '.repeat(4000)}x`;
    const result = prepareChatRequest({ messages: [{ role: 'user', content: padded }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tokenEstimate.inputTokens).toBe(Math.ceil(padded.length / 4));
  });

  it('applies the documented defaults', () => {
    const result = prepareChatRequest({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.priority).toBe('balanced');
    expect(result.value.latency_pref).toBe('normal');
    expect(result.value.boost).toBe(false);
    expect(result.value.manager_model).toBe('ai-model-router-ai');
  });

  it('reports which field failed validation', () => {
    const result = prepareChatRequest({ messages: [{ role: 'user', content: '  ' }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('validation_error');
    expect(result.error.details?.[0].path).toBe('messages.0.content');
    // The message alone has to be enough. A caller that shows only that should
    // not be left guessing which field it was.
    expect(result.error.message).toContain('messages.0.content');
    expect(result.error.message).not.toBe('Invalid request body');
  });

  it('rejects a body that is not a chat request at all', () => {
    expect(prepareChatRequest(undefined).ok).toBe(false);
    expect(prepareChatRequest({ messages: [] }).ok).toBe(false);
    expect(prepareChatRequest({ messages: [{ role: 'tool', content: 'hi' }] }).ok).toBe(false);
  });
});

describe('explainNoCandidates', () => {
  const tokens = { inputTokens: 1000, outputTokens: 128, totalTokens: 1128 };

  beforeEach(() => {
    seedCatalogFromConfig();
    invalidateModelCache();
  });

  it('names the context window when the conversation fits nowhere', async () => {
    getDb().prepare('UPDATE models SET max_tokens = 8').run();
    invalidateModelCache();

    const failure = await explainNoCandidates(tokens, ['openai'], 0.5);

    // Reported ahead of the cost cap: this request was never a budget question.
    expect(failure).toMatchObject({ status: 422, code: 'context_length_exceeded' });
    expect(failure.message).toContain('1128');
  });

  it('reports the cost cap when one was set and the conversation fits', async () => {
    const failure = await explainNoCandidates(tokens, ['openai'], 0.5);

    expect(failure).toMatchObject({ status: 400, code: 'max_cost_exceeded' });
  });

  it('falls back to the capability explanation when no cap was set', async () => {
    const failure = await explainNoCandidates(tokens, ['openai']);

    expect(failure).toMatchObject({ status: 422, code: 'no_capable_model' });
  });
});
