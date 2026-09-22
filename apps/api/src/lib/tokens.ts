export type TokenEstimate = { inputTokens: number; outputTokens: number; totalTokens: number };

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const text = (part as { text?: string }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

export function estimateTokensFromMessages(messages: Array<{ content?: unknown }>): TokenEstimate {
  const totalChars = messages.reduce((sum, m) => sum + normalizeContent(m?.content).length, 0);
  const inputTokens = Math.max(1, Math.ceil(totalChars / 4));
  const outputTokens = Math.min(512, Math.max(128, Math.round(inputTokens * 0.5)));
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
