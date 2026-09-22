import { ProviderError, ProviderRefusalError } from './providerClient.js';

/** Only a whole, representable count can become recorded usage and cost. */
export function reportedTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function requireCompletion(content: string | null | undefined, provider: string, hasTools = false): void {
  if (!content?.trim() && !hasTools) {
    throw new ProviderError('Provider returned an empty completion', provider);
  }
}

/** Check refusal metadata before content, since a blocked reply often has none. */
export function rejectProviderRefusal(data: unknown, provider: string): void {
  if (!data || typeof data !== 'object') return;
  const body = data as {
    choices?: Array<{ message?: { refusal?: unknown }; finish_reason?: string }>;
    stop_reason?: string;
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string }>;
  };
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const candidate = Array.isArray(body.candidates) ? body.candidates[0] : undefined;
  const blocked = ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'RECITATION', 'SPII'];
  const reason = typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim()
    ? 'refusal'
    : choice?.finish_reason === 'content_filter' ? 'content_filter'
    : body.stop_reason === 'refusal' ? 'refusal'
    : body.promptFeedback?.blockReason
    || (candidate?.finishReason && blocked.includes(candidate.finishReason) ? candidate.finishReason : undefined);
  if (reason) throw new ProviderRefusalError('Provider declined the request', provider, reason.toLowerCase());
}
