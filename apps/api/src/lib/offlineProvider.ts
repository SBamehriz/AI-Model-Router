import type { ChatMessage } from './messages.js';
import { createHash } from 'node:crypto';
import { estimateTokensFromMessages, estimateTokensFromText } from './tokens.js';

/**
 * The stand in for a provider call when no key is configured, or when offline
 * mode is forced. It lets routing, fallback, cost accounting, logging and the
 * dashboard be exercised with no credentials at all. The text always says it is
 * simulated, and is never presented as model output.
 *
 * The answer is deterministic for a given prompt and model, and its length
 * tracks the prompt, so token and cost figures stay meaningful.
 */

export type OfflineCompletion = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

function seedFrom(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0);
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user' && typeof message.content === 'string') return message.content;
  }
  const first = messages[0]?.content;
  return typeof first === 'string' ? first : '';
}

function truncate(text: string, max = 160): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}...`;
}

/** Deterministic latency, in the range real providers occupy. */
export function offlineLatencyMs(provider: string, modelName: string, prompt: string): number {
  return 120 + (seedFrom(`${provider}/${modelName}:${prompt}`) % 380);
}

export async function completeOffline(
  provider: string,
  modelName: string,
  messages: ChatMessage[]
): Promise<OfflineCompletion> {
  const prompt = lastUserMessage(messages);
  const latency = offlineLatencyMs(provider, modelName, prompt);
  await new Promise((resolve) => setTimeout(resolve, Math.min(latency, 250)));

  const content = [
    `[offline mode] Simulated completion from ${provider}/${modelName}.`,
    '',
    'Offline mode is enabled. This response was generated locally; no provider was called.',
    `Prompt received: "${truncate(prompt)}"`,
    '',
    'The router classified your task, scored the eligible models, and selected this route. Inspect the decision to see its reasoning and candidate scores.',
    '',
    'For real completions, add a provider key in Settings. If AI_MODEL_ROUTER_OFFLINE=1 is set, remove that override and restart the API.',
  ].join('\n');

  return {
    content,
    inputTokens: estimateTokensFromMessages(messages).inputTokens,
    outputTokens: estimateTokensFromText(content),
    model: modelName,
  };
}
