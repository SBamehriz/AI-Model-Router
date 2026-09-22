/**
 * The message shape every adapter speaks. Providers are reached over plain HTTP
 * with the OpenAI chat schema as the common format, which the Anthropic and
 * Gemini adapters translate, so no vendor SDK or vendor type reaches the rest
 * of the code.
 */
export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * One message's content as plain text. A caller may send a string or the
 * OpenAI array of typed parts, and everything that reads a prompt rather than
 * forwarding it, the classifier and the complexity estimator, needs the same
 * answer from both spellings. Non-text parts are dropped: this is for reading
 * what was asked, not for reproducing the message.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown): part is { type: 'text'; text: string } =>
        typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}
