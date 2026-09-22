import { z } from 'zod';
import { MAX_MESSAGE_LENGTH, MAX_MESSAGES, isBlankAfterSanitize, sanitizeLabel } from './sanitize.js';

/** One message of a conversation. */
export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system'], {
    errorMap: () => ({ message: 'Role must be one of: user, assistant, system' }),
  }),
  /**
   * Capped here as well as in the sanitiser, so a preview and a run reject the
   * same bodies. Whitespace alone is not a prompt, and would reach a provider
   * as an empty message.
   */
  content: z
    .string()
    .min(1, 'Message content cannot be empty')
    .max(MAX_MESSAGE_LENGTH, `Message content exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters`)
    .refine((content) => !isBlankAfterSanitize(content), {
      message: 'Message content cannot be only whitespace or control characters',
    }),
});

/** Manager output is untrusted input until it has been validated. */
export const BoostPlanSchema = z.object({
  tasks: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(10000),
    task_type: z.enum(['chat', 'coding', 'debugging', 'reasoning', 'math_reasoning', 'writing', 'email', 'summarization', 'translation', 'data_analysis', 'planning', 'customer_support', 'image', 'agent_step']),
    instructions: z.string().trim().min(1).max(50000),
  })).min(1).transform((tasks) => tasks.slice(0, 5))
    .refine((tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length, 'Task IDs must be unique'),
  reasoning: z.string().max(10000).default(''),
});

/** Body of POST /v1/chat and POST /v1/agent-step. */
export const ChatRequestSchema = z.object({
  messages: z
    .array(MessageSchema)
    .min(1, 'At least one message is required')
    .max(MAX_MESSAGES, `Maximum ${MAX_MESSAGES} messages allowed`),
  priority: z
    .enum(['cheap', 'balanced', 'best', 'quality'], {
      errorMap: () => ({
        message: 'Priority must be one of: cheap, balanced, best, quality',
      }),
    })
    .optional()
    .default('balanced'),
  latency_pref: z
    .enum(['fast', 'normal'], {
      errorMap: () => ({ message: 'Latency preference must be: fast or normal' }),
    })
    .optional()
    .default('normal'),
  max_cost: z
    .number()
    .nonnegative('Max cost must be a non-negative number')
    .optional(),
  boost: z.boolean().optional().default(false),
  manager_model: z.string().min(1).optional().default('ai-model-router-ai'),
}).refine((body) => !body.boost || body.max_cost === undefined, {
  message: 'max_cost is not supported with boost; disable boost to apply a cost filter',
  path: ['max_cost'],
});

/**
 * Query for GET /v1/models. A repeated key arrives as an array, which would
 * otherwise reach a SQLite binding expecting a string.
 */
export const ModelsQuerySchema = z.object({
  provider: z
    .string({ invalid_type_error: 'provider must be a single string value' })
    .trim()
    .min(1, 'provider cannot be empty')
    .max(64, 'provider is too long')
    .optional(),
});

/** Query for GET /v1/usage. */
export const UsageQuerySchema = z
  .object({
    from: z
      .string()
      .datetime({ message: 'Invalid datetime format for "from"' })
      .optional(),
    to: z
      .string()
      .datetime({ message: 'Invalid datetime format for "to"' })
      .optional(),
  })
  .refine(
    (data) => {
      if (data.from && data.to) {
        return new Date(data.from) <= new Date(data.to);
      }
      return true;
    },
    {
      message: '"from" date must be before or equal to "to" date',
      path: ['from'],
    }
  );

/** POST /v1/router/debug takes the same body as a completion. */
export const DebugRoutingRequestSchema = ChatRequestSchema;

/** Query params for GET /v1/requests */
export const RecentRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type Message = z.infer<typeof MessageSchema>;

/**
 * One shape for every rejected request, so the message names the field that
 * failed rather than saying only that something did. Clients commonly surface
 * the message alone and never open details, and a fixed sentence sends the
 * reader to the wrong setting. Every route builds its envelope from here so
 * the next one cannot quietly go back to a generic line.
 */
export function describeValidationFailure(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): {
  message: string;
  details: Array<{ path: string; message: string }>;
} {
  const details = issues.map((issue) => ({ path: issue.path.join('.'), message: describeIssue(issue.message) }));
  const first = details[0];
  return {
    message: first ? `${first.path || 'request'}: ${first.message}` : 'Invalid request',
    details,
  };
}

/** The longest an explanation of one bad field needs to be. */
const MAX_ISSUE_MESSAGE = 200;

/**
 * A validation message is mostly fixed text, but not entirely: a strict schema
 * rejecting unknown keys names them, and the caller chose those names. That
 * text is the one attacker-controlled string this API still puts in a
 * response, so it gets the treatment every other rendered label got.
 *
 * It is contained today. Only an administrator key reaches the strict schemas,
 * nothing logs these messages, and the dashboard neither reads `details` nor
 * renders any HTML it is given. None of that is a property of this function,
 * which is the reason to bound it here rather than rely on all three holding.
 */
function describeIssue(message: string): string {
  const clean = sanitizeLabel(message);
  return clean.length > MAX_ISSUE_MESSAGE ? `${clean.slice(0, MAX_ISSUE_MESSAGE - 1)}…` : clean;
}
