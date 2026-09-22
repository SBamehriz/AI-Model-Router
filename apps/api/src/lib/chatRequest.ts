import type { ChatMessage } from './messages.js';
import type { RoutingLatencyPreference, RoutingPriority } from './router.js';
import type { TokenEstimate } from './tokens.js';
import { ChatRequestSchema, describeValidationFailure } from './schemas.js';
import { MAX_MESSAGES, MAX_MESSAGE_LENGTH, sanitizeMessages } from './sanitize.js';
import { estimateTokensFromMessages } from './tokens.js';
import { largestContextWindow, requiredContextTokens } from './router.js';

/**
 * One front door for /v1/chat, /v1/agent-step and /v1/router/debug. The three
 * have to agree on what a request is, or a preview could price one thing and
 * the run execute another. Validation, message content and the token estimate
 * are computed here once, and every route reads the same result.
 */

export type PreparedChatRequest = {
  messages: ChatMessage[];
  priority: RoutingPriority;
  latency_pref: RoutingLatencyPreference;
  max_cost?: number;
  boost: boolean;
  manager_model: string;
  /** Estimated tokens for the sanitised conversation, as routing sees it. */
  tokenEstimate: TokenEstimate;
};

export type ChatRequestRejection = {
  code: 'validation_error';
  message: string;
  details?: Array<{ path: string; message: string }>;
};

export type PrepareResult =
  | { ok: true; value: PreparedChatRequest }
  | { ok: false; error: ChatRequestRejection };

export function prepareChatRequest(body: unknown): PrepareResult {
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation_error', ...describeValidationFailure(parsed.error.issues) } };
  }

  let messages: ChatMessage[];
  try {
    messages = sanitizeMessages(parsed.data.messages, MAX_MESSAGES, MAX_MESSAGE_LENGTH) as ChatMessage[];
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'validation_error',
        message: error instanceof Error ? error.message : 'Invalid message content',
      },
    };
  }

  return {
    ok: true,
    value: {
      messages,
      priority: parsed.data.priority,
      latency_pref: parsed.data.latency_pref,
      max_cost: parsed.data.max_cost,
      boost: parsed.data.boost,
      manager_model: parsed.data.manager_model,
      tokenEstimate: estimateTokensFromMessages(messages),
    },
  };
}

export type NoCandidateError = { status: number; code: string; message: string };

/**
 * Say why routing produced no candidate, rather than reporting whichever filter
 * was checked first. A conversation larger than every context window is not a
 * budget problem and not a capability problem.
 */
export async function explainNoCandidates(
  tokenEstimate: TokenEstimate,
  availableProviders: string[],
  maxCost?: number
): Promise<NoCandidateError> {
  const required = requiredContextTokens(tokenEstimate);
  const capacity = await largestContextWindow(availableProviders);

  if (capacity !== null && required > capacity) {
    return {
      status: 422,
      code: 'context_length_exceeded',
      message: `Request needs about ${required} tokens (prompt plus reply), more than the largest available context window of ${capacity} tokens`,
    };
  }

  if (maxCost !== undefined) {
    return {
      status: 400,
      code: 'max_cost_exceeded',
      message: 'No available models satisfy max_cost',
    };
  }

  return {
    status: 422,
    code: 'no_capable_model',
    message: 'No models satisfy routing constraints for this request',
  };
}
