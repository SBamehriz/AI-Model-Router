import { reportedTokens, requireCompletion, rejectProviderRefusal } from './providerResponse.js';
import type { ChatMessage } from './messages.js';
import type { ModelRow } from './router.js';
import { estimateTokensFromMessages, estimateTokensFromText } from './tokens.js';
import { isOfflineMode } from './providerAvailability.js';
import { completeOffline } from './offlineProvider.js';
import { customProvider } from './db/customProviders.js';
import { providerCredential, credentialForEnvironment } from './credentials.js';
import {
  callProviderWithRetry,
  ProviderError,
  isRetryableStatusCode,
  fetchProviderJson,
  PROVIDER_HTTP_DEADLINE_MS,
} from './providerClient.js';

/**
 * Credentials are read at call time, so a key added to the environment takes
 * effect without reloading the module.
 */
const providerKey = credentialForEnvironment;

/** OpenAI compatible chat endpoints, by provider. */
const OPENAI_COMPATIBLE_ENDPOINTS: Record<string, { url: string; envKey: string }> = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', envKey: 'OPENAI_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
};

export type CompletionResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};


/**
 * An error body can carry the prompt back, or an echoed key. It never reaches a
 * response or a log, so the only thing taken from it is whether there was
 * anything there at all.
 */
function providerErrorMessage(label: string, status: number, body: string): string {
  return body.trim() ? `${label}: ${status} (details redacted)` : `${label}: ${status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A 200 carrying nothing usable is a failed call, not an empty answer. It is
 * not retried, because a response shape that surprised us once will again, so
 * the chain moves on to another model.
 */
function malformedResponse(provider: string, detail: string): ProviderError {
  return new ProviderError(
    `Provider ${provider} returned a malformed completion: ${detail}`,
    provider,
    undefined,
    false
  );
}

type OpenAICompatResponse = {
  choices?: Array<{ message?: { content?: string; refusal?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Read an OpenAI shaped body, separating a refusal from a broken payload. */
function readOpenAICompatContent(data: unknown, provider: string): string {
  if (!isRecord(data)) throw malformedResponse(provider, 'response body was not an object');

  rejectProviderRefusal(data, provider);

  const choices = (data as OpenAICompatResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw malformedResponse(provider, 'no choices returned');
  }

  const choice = choices[0] ?? {};
  const content = choice.message?.content;
  if (typeof content !== 'string') {
    throw malformedResponse(provider, 'first choice carried no message content');
  }
  return content;
}

async function chatWithOpenAICompat(
  endpoint: string,
  apiKey: string,
  modelName: string,
  messages: ChatMessage[],
  providerName: string = 'openai-compatible'
): Promise<CompletionResult> {
  if (!apiKey) throw new Error('Missing API key');

  return callProviderWithRetry(
    async (signal) => {
      const response = await fetchProviderJson(
        endpoint,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: modelName, messages }),
        },
        PROVIDER_HTTP_DEADLINE_MS,
        signal
      );

      if (!response.ok) {
        throw new ProviderError(
          providerErrorMessage('Provider error', response.status, response.body),
          providerName,
          response.status,
          isRetryableStatusCode(response.status)
        );
      }

      const data = response.data as OpenAICompatResponse;
      const content = readOpenAICompatContent(data, providerName);
      requireCompletion(content, providerName);
      const fallbackTokens = estimateTokensFromMessages(messages);
      const inputTokens = reportedTokens(data.usage?.prompt_tokens) ?? fallbackTokens.inputTokens;
      const outputTokens = reportedTokens(data.usage?.completion_tokens) ?? estimateTokensFromText(content);
      return { content, inputTokens, outputTokens, model: modelName };
    },
    providerName
  );
}

/** Anthropic needs an explicit output limit. */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

function buildAnthropicPayload(modelName: string, messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
  const filtered = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : '',
  }));
  return {
    model: modelName,
    // The same default the compatibility endpoint sends, so one prompt is not
    // truncated on one route and complete on the other.
    max_tokens: DEFAULT_ANTHROPIC_MAX_TOKENS,
    system: system || undefined,
    messages: filtered,
  };
}

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function readAnthropicContent(data: unknown): string {
  if (!isRecord(data)) throw malformedResponse('anthropic', 'response body was not an object');

  rejectProviderRefusal(data, 'anthropic');

  const blocks = (data as AnthropicResponse).content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw malformedResponse('anthropic', 'no content blocks returned');
  }
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
}

async function chatWithAnthropic(
  modelName: string,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  if (!providerKey('ANTHROPIC_API_KEY')) throw new Error('Missing API key');

  return callProviderWithRetry(
    async (signal) => {
      const response = await fetchProviderJson(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'x-api-key': providerKey('ANTHROPIC_API_KEY'),
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildAnthropicPayload(modelName, messages)),
        },
        PROVIDER_HTTP_DEADLINE_MS,
        signal
      );

      if (!response.ok) {
        throw new ProviderError(
          providerErrorMessage('Anthropic error', response.status, response.body),
          'anthropic',
          response.status,
          isRetryableStatusCode(response.status)
        );
      }

      const data = response.data as AnthropicResponse;
      const content = readAnthropicContent(data);
      requireCompletion(content, 'anthropic');
      const fallbackTokens = estimateTokensFromMessages(messages);
      const inputTokens = reportedTokens(data.usage?.input_tokens) ?? fallbackTokens.inputTokens;
      const outputTokens = reportedTokens(data.usage?.output_tokens) ?? estimateTokensFromText(content);
      return { content, inputTokens, outputTokens, model: modelName };
    },
    'anthropic'
  );
}

type GeminiContentPart = { text?: string };
type GeminiContent = { role?: 'user' | 'model'; parts?: GeminiContentPart[] };
type GeminiGenerateContentResponse = {
  candidates?: Array<{ content?: { parts?: GeminiContentPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};


function readGeminiContent(data: unknown): string {
  if (!isRecord(data)) throw malformedResponse('google', 'response body was not an object');

  // One definition of what counts as a refusal, shared with the compatible
  // path. Two copies of a safety list is two chances for them to drift, and a
  // reason missing from one of them is a block quietly retried on the next
  // model, which is the one thing fallback must never do.
  rejectProviderRefusal(data, 'google');

  const body = data as GeminiGenerateContentResponse;
  const candidate = body.candidates?.[0];
  if (!candidate) throw malformedResponse('google', 'no candidates returned');

  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) throw malformedResponse('google', 'candidate carried no content parts');
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

function buildGeminiPayload(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n')
    .trim();

  const contents: GeminiContent[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    }));

  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
}

async function chatWithGemini(
  modelName: string,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  if (!providerKey('GOOGLE_API_KEY')) throw new Error('Missing API key');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent`;

  return callProviderWithRetry(
    async (signal) => {
      const response = await fetchProviderJson(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': providerKey('GOOGLE_API_KEY') },
          body: JSON.stringify(buildGeminiPayload(messages)),
        },
        PROVIDER_HTTP_DEADLINE_MS,
        signal
      );

      if (!response.ok) {
        throw new ProviderError(
          providerErrorMessage('Gemini error', response.status, response.body),
          'google',
          response.status,
          isRetryableStatusCode(response.status)
        );
      }

      const data = response.data as GeminiGenerateContentResponse;
      const content = readGeminiContent(data);
      requireCompletion(content, 'google');

      const fallbackTokens = estimateTokensFromMessages(messages);
      const inputTokens = reportedTokens(data.usageMetadata?.promptTokenCount) ?? fallbackTokens.inputTokens;
      const outputTokens =
        reportedTokens(data.usageMetadata?.candidatesTokenCount) ?? estimateTokensFromText(content);

      return { content, inputTokens, outputTokens, model: modelName };
    },
    'google'
  );
}

export async function chatWithProvider(
  provider: string,
  modelName: string,
  messages: ChatMessage[]
): Promise<CompletionResult> {
  // No credentials anywhere, so the completion is simulated locally and the
  // rest of the pipeline still runs. The text says so.
  if (isOfflineMode()) {
    return completeOffline(provider, modelName, messages);
  }

  const custom = customProvider(provider);
  if (custom) return chatWithOpenAICompat(`${custom.base_url}/chat/completions`, providerCredential(provider), modelName, messages, provider);
  const compatible = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  if (compatible) {
    return chatWithOpenAICompat(
      compatible.url,
      providerKey(compatible.envKey),
      modelName,
      messages,
      provider
    );
  }
  if (provider === 'anthropic') {
    return chatWithAnthropic(modelName, messages);
  }
  if (provider === 'google') {
    return chatWithGemini(modelName, messages);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

export function costForModel(model: Pick<ModelRow, 'cost_input' | 'cost_output'>, inputTokens: number, outputTokens: number): number {
  const inCost = Number(model.cost_input);
  const outCost = Number(model.cost_output);
  return (inputTokens / 1000) * inCost + (outputTokens / 1000) * outCost;
}

export const PREMIUM_ESTIMATE_PER_1K_IN = 0.0025;
export const PREMIUM_ESTIMATE_PER_1K_OUT = 0.01;

export function premiumEstimate(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1000) * PREMIUM_ESTIMATE_PER_1K_IN + (outputTokens / 1000) * PREMIUM_ESTIMATE_PER_1K_OUT
  );
}

export function savingsEstimate(actualCost: number, premiumCost: number): number {
  return premiumCost - actualCost; // negative = more expensive than premium
}
