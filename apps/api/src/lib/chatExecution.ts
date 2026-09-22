import type { ChatMessage } from './messages.js';
import type { TaskType } from './taskClassifier.js';
import { chatWithProvider } from './providers.js';
import { ProviderRefusalError } from './providerClient.js';
import { MAX_MODELS_ATTEMPTED, selectFallbackChain, type FailureReason } from './fallback.js';
import { recordProviderOutcome } from './providerHealth.js';
import type { ModelRow } from './router.js';
import { isOfflineMode } from './providerAvailability.js';

export type ChatResult = {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  modelRow: ModelRow;
  fallbackLevel: 'primary' | 'backup' | 'emergency';
};

/**
 * Why a call failed, which decides what the fallback chain does next. The HTTP
 * status is checked before the message text, because a status is unambiguous.
 * Both status fields are read, since different errors carry different ones.
 */
export function classifyFailure(err: unknown): FailureReason {
  const status =
    typeof err === 'object' && err !== null
      ? (err as { status?: number; statusCode?: number }).status ??
        (err as { statusCode?: number }).statusCode
      : undefined;

  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';

  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    // Matching on the whole phrase, because a bare "rate" also appears inside
    // "generate", and a misread reason sends fallback down the wrong chain.
    if (/\b429\b|rate[\s_-]?limit|too many/.test(message)) {
      return 'rate_limit';
    }
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('aborted')
    ) {
      return 'timeout';
    }
  }

  return 'error';
}

export function queueProviderOutcome(
  provider: string,
  success: boolean,
  latency: number,
  modelName?: string,
  log?: { warn: (o: object, s: string) => void }
): void {
  void recordProviderOutcome(provider, success, latency, modelName, isOfflineMode() ? 'offline' : 'live').catch((err) => {
    log?.warn({ err, provider }, 'provider health logging failed');
  });
}

/**
 * One attempt against one model, recorded either way. Provider health is scored
 * from attempts, so an attempt that is not recorded never happened.
 */
async function attemptModel(
  model: ModelRow,
  messages: ChatMessage[],
  fallbackLevel: ChatResult['fallbackLevel'],
  log?: { info: (o: object, s: string) => void; warn: (o: object, s: string) => void },
  onFailure?: (reason: FailureReason) => void
): Promise<ChatResult> {
  const start = Date.now();
  try {
    const result = await chatWithProvider(model.provider, model.model_name, messages);
    queueProviderOutcome(model.provider, true, Date.now() - start, model.model_name, log);
    return { ...result, provider: model.provider, modelRow: model, fallbackLevel };
  } catch (err) {
    queueProviderOutcome(model.provider, false, Date.now() - start, model.model_name, log);
    if (!(err instanceof ProviderRefusalError)) onFailure?.(classifyFailure(err));
    throw err;
  }
}

/**
 * A refusal ends the chain. Fallback exists to survive providers that are down,
 * rate limited or slow, not to keep asking until a model agrees.
 */
function rethrowRefusal(err: unknown): void {
  if (err instanceof ProviderRefusalError) throw err;
}

/**
 * `signal` is the caller still being there. Every candidate costs a real
 * provider call, so once the connection is gone the walk stops rather than
 * working through the rest of the catalog for an answer nobody will read.
 */
export async function tryChatWithFallback(
  models: ModelRow[],
  messages: ChatMessage[],
  taskType: TaskType,
  log?: { info: (o: object, s: string) => void; warn: (o: object, s: string) => void },
  signal?: AbortSignal,
  onFailure?: (reason: FailureReason) => void
): Promise<ChatResult | null> {
  if (!models.length || signal?.aborted) return null;

  const primary = models[0];

  try {
    return await attemptModel(primary, messages, 'primary', log, onFailure);
  } catch (err) {
    rethrowRefusal(err);
    const failureReason = classifyFailure(err);
    log?.warn(
      { model: `${primary.provider}/${primary.model_name}`, failureReason },
      'Primary model failed, building fallback chain'
    );

    const chain = selectFallbackChain(primary, models, taskType, failureReason);

    if (signal?.aborted) return null;
    if (chain.backup.id !== primary.id) {
      try {
        const result = await attemptModel(chain.backup, messages, 'backup', log, onFailure);
        log?.info(
          { model: `${chain.backup.provider}/${chain.backup.model_name}`, reasoning: chain.reasoning },
          'Backup model succeeded'
        );
        return result;
      } catch (backupErr) {
        rethrowRefusal(backupErr);
        log?.warn(
          { model: `${chain.backup.provider}/${chain.backup.model_name}` },
          'Backup model also failed'
        );
      }
    }

    if (signal?.aborted) return null;
    if (chain.emergency.id !== primary.id && chain.emergency.id !== chain.backup.id) {
      try {
        const result = await attemptModel(chain.emergency, messages, 'emergency', log, onFailure);
        log?.info(
          { model: `${chain.emergency.provider}/${chain.emergency.model_name}`, reasoning: chain.reasoning },
          'Emergency model succeeded'
        );
        return result;
      } catch (emergencyErr) {
        rethrowRefusal(emergencyErr);
        log?.warn(
          { model: `${chain.emergency.provider}/${chain.emergency.model_name}` },
          'Emergency model also failed'
        );
      }
    }

    const tried = new Set([primary.id, chain.backup.id, chain.emergency.id]);
    for (const m of models) {
      if (signal?.aborted) return null;
      if (tried.size >= MAX_MODELS_ATTEMPTED) break;
      if (tried.has(m.id)) continue;
      tried.add(m.id);
      try {
        const result = await attemptModel(m, messages, 'emergency', log, onFailure);
        log?.info({ model: `${m.provider}/${m.model_name}` }, 'Fallback to remaining model succeeded');
        return result;
      } catch (remainingErr) {
        rethrowRefusal(remainingErr);
        continue;
      }
    }
  }

  return null;
}
