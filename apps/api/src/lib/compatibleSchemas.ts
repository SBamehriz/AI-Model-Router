import { isBlankAfterSanitize, sanitizeText } from './sanitize.js';
import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().min(1).max(200), type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(128), arguments: z.string().max(200000) }),
});

const contentSchema = z.union([z.string().max(500000), z.array(z.object({ type: z.literal('text'), text: z.string().max(500000) })).max(100).transform((parts) => parts.map((p) => p.text).join('\n')), z.null()]);
export const CompatibleMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: contentSchema.optional().default(null).transform((content) => content === null ? null : sanitizeText(content)),
  tool_calls: z.array(ToolCallSchema).max(100).optional(),
  tool_call_id: z.string().min(1).max(200).optional(),
  name: z.string().max(128).optional(),
}).superRefine((message, ctx) => {
  if (['user', 'system', 'developer'].includes(message.role) && (message.content === null || isBlankAfterSanitize(message.content))) ctx.addIssue({ code: 'custom', message: 'Message text cannot be blank' });
  if (message.role === 'tool' && !message.tool_call_id) ctx.addIssue({ code: 'custom', message: 'Tool results require tool_call_id' });
  if (message.tool_calls && message.role !== 'assistant') ctx.addIssue({ code: 'custom', message: 'Only assistant messages may contain tool_calls' });
  if (message.content === null && !(message.role === 'assistant' && message.tool_calls?.length)) ctx.addIssue({ code: 'custom', message: 'A message needs text or assistant tool calls' });
});

export const CompatibleRequestSchema = z.object({
  model: z.enum(['auto', 'auto-cheap', 'auto-best']).default('auto'),
  messages: z.array(CompatibleMessageSchema).min(1).max(1000),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().max(20000).optional(), parameters: z.record(z.unknown()), strict: z.boolean().optional() }) })).max(128).optional(),
  tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) })]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().min(1).max(32768).optional(),
  max_completion_tokens: z.number().int().min(1).max(32768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  n: z.literal(1).optional(),
}).superRefine((body, ctx) => {
  if (body.tool_choice && body.tool_choice !== 'none' && !body.tools?.length) ctx.addIssue({ code: 'custom', path: ['tools'], message: 'tool_choice requires tools' });
  if (typeof body.tool_choice === 'object' && !body.tools?.some((tool) => tool.function.name === (body.tool_choice as { function: { name: string } }).function.name)) ctx.addIssue({ code: 'custom', path: ['tool_choice'], message: 'The selected function must be defined in tools' });
  const pending = new Set<string>();
  for (const message of body.messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id!)) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Tool results must match a preceding assistant tool call' });
    } else {
      if (pending.size) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Every tool call needs a result before the next message' });
      for (const call of message.tool_calls ?? []) {
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
        } catch { ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Tool arguments must be a JSON object' }); }
        if (pending.has(call.id)) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Tool call IDs must be unique within a turn' });
        pending.add(call.id);
      }
    }
  }
  if (pending.size) ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Provide results for pending tool calls before continuing' });
});

export type CompatibleRequest = z.infer<typeof CompatibleRequestSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type CompatibleResult = { content: string | null; tool_calls?: ToolCall[]; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'; inputTokens: number; outputTokens: number };
