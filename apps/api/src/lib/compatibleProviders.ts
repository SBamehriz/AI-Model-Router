import { reportedTokens, requireCompletion, rejectProviderRefusal } from './providerResponse.js';
import { z } from 'zod';
import { customProvider } from './db/customProviders.js';
import { providerCredential } from './credentials.js';
import { callProviderWithRetry, ProviderError, isRetryableStatusCode, fetchProviderJson, PROVIDER_HTTP_DEADLINE_MS, PROVIDER_CALL_TIMEOUT_MS, PROVIDER_CALL_RETRIES } from './providerClient.js';
import { ToolCallSchema, type CompatibleRequest, type CompatibleResult } from './compatibleSchemas.js';
import { estimateTokensFromText } from './tokens.js';

const endpoints: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

const compatibleResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(ToolCallSchema).optional() }), finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable().optional() })).min(1),
  usage: z.object({ prompt_tokens: z.unknown(), completion_tokens: z.unknown() }).nullish(),
});
const anthropicResponse = z.object({
  content: z.array(z.union([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.unknown()) })])),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.unknown(), output_tokens: z.unknown() }).nullish(),
});
const geminiResponse = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }), finishReason: z.string().optional() })).min(1),
  usageMetadata: z.object({ promptTokenCount: z.unknown(), candidatesTokenCount: z.unknown() }).nullish(),
});

function anthropicBody(model: string, request: CompatibleRequest): Record<string, unknown> {
  const system = request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n');
  const messages: Array<{ role: 'assistant' | 'user'; content: Array<Record<string, unknown>> }> = [];
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Array<Record<string, unknown>> = [];
    if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content ?? '' });
    else {
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        // Arguments come from the client history, so malformed JSON has to
        // fail before the request is sent.
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
      }
    }
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  const choice = request.tool_choice;
  return {
    model, system, messages, max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 4096,
    ...(request.temperature !== undefined ? { temperature: Math.min(request.temperature, 1) } : {}),
    ...(request.top_p !== undefined && request.temperature === undefined ? { top_p: request.top_p } : {}),
    ...(request.stop ? { stop_sequences: Array.isArray(request.stop) ? request.stop : [request.stop] } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })),
      tool_choice: { ...(typeof choice === 'object' ? { type: 'tool', name: choice.function.name } : { type: choice === 'required' ? 'any' : choice ?? 'auto' }), ...(request.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}) },
    } : {}),
  };
}

/** Text and tool calls. The caller emits the answer as JSON or as SSE. */
export async function compatibleCompletion(provider: string, model: string, request: CompatibleRequest, signal?: AbortSignal): Promise<CompatibleResult> {
  if (provider === 'google') {
    // A tool conversation needs a provider whose call ids survive a round
    // trip. Gemini thought signatures are not portable between providers.
    const system = request.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n');
    return callProviderWithRetry(async (attemptSignal) => {
    signal?.throwIfAborted();
      const response = await fetchProviderJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': providerCredential('google') },

        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: request.messages.filter((m) => m.role !== 'system' && m.role !== 'developer').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content ?? '' }] })),
          generationConfig: { maxOutputTokens: request.max_completion_tokens ?? request.max_tokens ?? 4096, temperature: request.temperature, topP: request.top_p, ...(request.stop ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] } : {}) },
        }),
      }, PROVIDER_HTTP_DEADLINE_MS, AbortSignal.any([attemptSignal, ...(signal ? [signal] : [])]));
      if (!response.ok) { throw new ProviderError(`Provider returned HTTP ${response.status}`, provider, response.status, isRetryableStatusCode(response.status)); }
      rejectProviderRefusal(response.data, provider);
      const data = geminiResponse.parse(response.data);
      const content = data.candidates[0].content.parts.map((part) => part.text ?? '').join('');
      requireCompletion(content, provider);
      return { content, finish_reason: data.candidates[0].finishReason === 'MAX_TOKENS' ? 'length' : 'stop', inputTokens: reportedTokens(data.usageMetadata?.promptTokenCount) ?? estimateTokensFromText(JSON.stringify(request.messages)), outputTokens: reportedTokens(data.usageMetadata?.candidatesTokenCount) ?? estimateTokensFromText(content) };
    }, provider, { timeout: PROVIDER_CALL_TIMEOUT_MS, retries: PROVIDER_CALL_RETRIES, signal });
  }
  const custom = customProvider(provider);
  const endpoint = custom ? `${custom.base_url}/chat/completions` : endpoints[provider];
  const key = providerCredential(provider);
  if (!endpoint || !key) throw new Error('Provider is not configured');
  const { model: _alias, stream: _stream, stream_options: _streamOptions, ...options } = request;
  const payload = provider === 'anthropic' ? anthropicBody(model, request) : {
    ...options, model, stream: false,
    messages: request.messages.map((m) => ({ ...m, role: m.role === 'developer' ? 'system' : m.role })),
  };
  if (provider === 'openai' && /^o[134](?:-|$)/.test(model)) {
    // Reasoning models take max_completion_tokens and fixed sampling.
    const reasoningPayload = payload as Record<string, unknown>;
    reasoningPayload.max_completion_tokens = request.max_completion_tokens ?? request.max_tokens;
    delete reasoningPayload.max_tokens;
    delete reasoningPayload.temperature;
    delete reasoningPayload.top_p;
    delete reasoningPayload.stop;
  }
  return callProviderWithRetry(async (attemptSignal) => {
    signal?.throwIfAborted();
    const response = await fetchProviderJson(endpoint, {
      method: 'POST', redirect: 'error',

      headers: { 'Content-Type': 'application/json', ...(provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }) },
      body: JSON.stringify(payload),
    }, PROVIDER_HTTP_DEADLINE_MS, AbortSignal.any([attemptSignal, ...(signal ? [signal] : [])]));
    if (!response.ok) {
      throw new ProviderError(`Provider returned HTTP ${response.status}`, provider, response.status, isRetryableStatusCode(response.status));
    }
    const raw = response.data;
    rejectProviderRefusal(raw, provider);
    if (provider === 'anthropic') {
      const data = anthropicResponse.parse(raw);
      const calls = data.content.flatMap((block) => block.type === 'tool_use' ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) } }] : []);
      const content = data.content.map((block) => block.type === 'text' ? block.text : '').join('') || null;
      requireCompletion(content, provider, calls.length > 0);
      return { content, ...(calls.length ? { tool_calls: calls } : {}), finish_reason: calls.length ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : 'stop', inputTokens: reportedTokens(data.usage?.input_tokens) ?? estimateTokensFromText(JSON.stringify(request.messages)), outputTokens: reportedTokens(data.usage?.output_tokens) ?? estimateTokensFromText(JSON.stringify(data.content)) };
    }
    const data = compatibleResponse.parse(raw);
    const choice = data.choices[0];
    const calls = choice.message.tool_calls;
    requireCompletion(choice.message.content, provider, !!calls?.length);
    return {
      content: choice.message.content ?? null,
      ...(calls?.length ? { tool_calls: calls } : {}),
      finish_reason: calls?.length ? 'tool_calls' : choice.finish_reason ?? 'stop',
      inputTokens: reportedTokens(data.usage?.prompt_tokens) ?? estimateTokensFromText(JSON.stringify(request.messages)),
      outputTokens: reportedTokens(data.usage?.completion_tokens) ?? estimateTokensFromText(JSON.stringify(choice.message)),
    };
  }, provider, { timeout: PROVIDER_CALL_TIMEOUT_MS, retries: PROVIDER_CALL_RETRIES, signal });
}
