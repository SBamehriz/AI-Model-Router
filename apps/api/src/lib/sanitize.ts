/**
 * Message content, after the schema has checked the shape.
 *
 * This strips control characters that could corrupt a log or a provider
 * payload, and caps how much text one request carries. It never rewrites the
 * prompt: indentation, tabs and runs of spaces are content, and collapsing them
 * would change the code and the strings a caller sent. A character is either
 * forbidden and removed, or kept exactly as written.
 */

/**
 * Control characters, except the newlines and tabs chat text legitimately
 * uses. The C1 range is included: nothing a caller means to send lives there,
 * and it is as capable of corrupting a log line as the C0 range is.
 */
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Bidirectional overrides and isolates, which reorder the characters after
 * them when the text is drawn. Removed from labels only. Prose can need them,
 * but a name is one short line somebody reads to decide which key to revoke
 * or which provider to remove, and it has to read as what it is.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** Caps shared by the schemas and this module, so both boundaries agree. */
export const MAX_MESSAGE_LENGTH = 100_000;
export const MAX_MESSAGES = 100;

export function sanitizeText(text: string): string {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_CHARACTERS, '');
}

/**
 * A short name the interface renders and a person acts on: a router key in
 * the revoke list, a custom provider in the remove list. Message content is
 * sanitised already; these were the fields the same rule had not reached.
 */
export function sanitizeLabel(text: string): string {
  return sanitizeText(text).replace(BIDI_CONTROLS, '').trim();
}

/**
 * Whether a message would carry nothing a model could act on once the
 * forbidden characters are gone. Whitespace on its own is not a prompt.
 */
export function isBlankAfterSanitize(text: string): boolean {
  return sanitizeText(text).trim().length === 0;
}

/** One message body, rejecting anything over the length cap. */
export function sanitizeMessageContent(content: string, maxLength = MAX_MESSAGE_LENGTH): string {
  if (typeof content !== 'string') {
    throw new Error('Message content must be a string');
  }
  if (content.length > maxLength) {
    throw new Error(`Message content exceeds maximum length of ${maxLength} characters`);
  }
  const sanitized = sanitizeText(content);
  if (sanitized.trim().length === 0) {
    throw new Error('Message content is empty after removing control characters');
  }
  return sanitized;
}

/**
 * A whole conversation. Throws with the offending index rather than silently
 * dropping a message, so the caller can say what was wrong.
 */
export function sanitizeMessages(
  messages: Array<{ role: string; content: string }>,
  maxMessagesCount = MAX_MESSAGES,
  maxMessageLength = MAX_MESSAGE_LENGTH
): Array<{ role: string; content: string }> {
  if (!Array.isArray(messages)) {
    throw new Error('Messages must be an array');
  }
  if (messages.length > maxMessagesCount) {
    throw new Error(`Messages array exceeds maximum count of ${maxMessagesCount}`);
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== 'object') {
      throw new Error(`Message at index ${index} is not an object`);
    }
    if (!message.role || typeof message.role !== 'string') {
      throw new Error(`Message at index ${index} has invalid role`);
    }
    if (!message.content || typeof message.content !== 'string') {
      throw new Error(`Message at index ${index} has invalid content`);
    }

    try {
      return {
        role: message.role,
        content: sanitizeMessageContent(message.content, maxMessageLength),
      };
    } catch (error) {
      throw new Error(
        `Message at index ${index}: ${error instanceof Error ? error.message : 'Invalid content'}`
      );
    }
  });
}
