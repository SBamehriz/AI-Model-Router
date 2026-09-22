import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { classifyTaskAsync } from '../lib/taskClassifier.js';
import type { TaskType } from '../lib/taskClassifier.js';
import { estimateComplexityDetailed } from '../lib/complexityEstimator.js';
import { selectModels, getRoutingDecision, getWeightsForRequest, getConstraints } from '../lib/router.js';
import { costForModel, premiumEstimate, savingsEstimate } from '../lib/providers.js';
import { insertRequest, insertRoutingDecision } from '../lib/db/requests.js';
import { explainNoCandidates, prepareChatRequest } from '../lib/chatRequest.js';
import { ProviderRefusalError } from '../lib/providerClient.js';
import type { FailureReason } from '../lib/fallback.js';
import { tryChatWithFallback } from '../lib/chatExecution.js';
import { runBoostPipeline } from '../lib/boostPipeline.js';
import { availableProviders, isOfflineMode } from '../lib/providerAvailability.js';
import { withTransaction } from '../lib/db/index.js';

type Logger = { info: (o: object, s: string) => void; warn: (o: object, s: string) => void; error: (o: object, s: string) => void };

type RequestLogInput = Parameters<typeof insertRequest>[0] & {
  routing?: Omit<Parameters<typeof insertRoutingDecision>[0], 'request_id'>;
};

const round = (n: number): number => Math.round(n * 1e8) / 1e8;

/**
 * Persist the request and its decision. Logging must never fail a response, so
 * an error here is recorded and dropped.
 */
function logRequest(input: RequestLogInput, log?: Logger): void {
  try {
    withTransaction(() => {
      const id = insertRequest({ ...input, source: isOfflineMode() ? 'offline' : 'live' });
      if (input.routing) insertRoutingDecision({ ...input.routing, request_id: id });
    });
  } catch (err) {
    log?.error({ err }, 'request logging failed');
  }
}

/**
 * The pipeline behind POST /v1/chat and POST /v1/agent-step. Classify, estimate
 * difficulty, weight, constrain, select, execute with fallback, price and log.
 * A forced task type is the only difference between the two routes.
 */
function chatHandler(endpoint: '/v1/chat' | '/v1/agent-step', forcedTaskType?: TaskType) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Shared with /v1/router/debug, so a preview and a run see the same
    // request, with the same validation and the same token estimate.
    const prepared = prepareChatRequest(req.body);
    if (!prepared.ok) {
      return reply.status(400).send({ error: prepared.error, request_id: req.request_id });
    }

    const { messages, priority, latency_pref, max_cost, boost, manager_model, tokenEstimate } = prepared.value;

    const start = Date.now();

    // A caller that hangs up should not keep buying completions it will never
    // read. Boost fans out the most calls, so it watches the same signal as
    // the single-model walk.
    const controller = new AbortController();
    const disconnect = (): void => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', disconnect);

    // An agent step is known to be one. Everything else is classified from
    // keywords, and only an ambiguous prompt reaches the classifier model.
    const classification = forcedTaskType
      ? { taskType: forcedTaskType, confidence: 1, method: 'forced' as const, reasoning: 'agent-step endpoint' }
      : await classifyTaskAsync(messages, req.log);
    const taskType = classification.taskType;

    const complexityResult = estimateComplexityDetailed(messages, taskType);
    const complexity = complexityResult.complexity;
    const weights = getWeightsForRequest(priority, complexity, latency_pref);
    const constraints = getConstraints(taskType, complexity, max_cost);

    req.log.info(
      {
        request_id: req.request_id,
        endpoint,
        taskType,
        complexity,
        factors: complexityResult.factors,
        complexity_reasoning: complexityResult.reasoning,
        confidence: classification.confidence,
        method: classification.method,
        weights,
        constraints,
      },
      'Task classified and complexity estimated'
    );

    const providers = availableProviders();

    // Decompose into sub tasks, route each one, then synthesize.
    if (boost && complexity >= 0.5) {
      try {
        const boostResult = await runBoostPipeline(
          messages,
          taskType,
          complexity,
          priority,
          latency_pref,
          manager_model,
          providers,
          req.log,
          controller.signal
        );

        const latency_ms = Date.now() - start;
        logRequest(
          {
            id: req.request_id,
            endpoint,
            task_type: taskType,
            complexity,
            priority,
            provider: 'ai-model-router',
            model_used: 'ai-model-router-ai',
            tokens_input: boostResult.inputTokens,
            tokens_output: boostResult.outputTokens,
            cost: boostResult.total_cost,
            premium_baseline_cost: premiumEstimate(boostResult.inputTokens, boostResult.outputTokens),
            latency_ms,
            success: true,
            fallback_level: null,
            boost: true,
          },
          req.log
        );

        return reply.send({
          output: boostResult.output,
          model_used: 'ai-model-router-ai',
          cost: round(boostResult.total_cost),
          latency_ms,
          savings_estimate: round(savingsEstimate(boostResult.total_cost, premiumEstimate(boostResult.inputTokens, boostResult.outputTokens))),
          request_id: req.request_id,
          boost_details: boostResult.boost_details,
        });
      } catch (err) {
        // Falling back would start the whole walk again. With the caller gone
        // that is a second round of calls for an answer with nowhere to go.
        if (controller.signal.aborted) {
          req.log.info({ request_id: req.request_id, endpoint }, 'client disconnected during boost');
          reply.hijack();
          return;
        }
        req.log.warn(
          { err, request_id: req.request_id },
          'Boost pipeline failed, falling back to normal routing'
        );
      }
    }

    const models = await selectModels(taskType, complexity, priority, latency_pref, {
      maxCost: max_cost,
      tokenEstimate,
      availableProviders: providers,
    });

    if (!models.length) {
      const failure = await explainNoCandidates(tokenEstimate, providers, max_cost);
      return reply.status(failure.status).send({
        error: { code: failure.code, message: failure.message },
        request_id: req.request_id,
      });
    }

    const decision = getRoutingDecision(models, taskType, priority, latency_pref);
    const considered = models.slice(0, 5).map((m) => ({
      provider: m.provider,
      model_name: m.model_name,
      score: m.score,
    }));

    req.log.info(
      {
        request_id: req.request_id,
        taskType,
        complexity,
        weights,
        constraints,
        selected_model: `${decision.provider}/${decision.model_name}`,
      },
      'Routing decision computed'
    );

    const routing = {
      task_type: taskType,
      classification_method: classification.method,
      confidence: classification.confidence,
      complexity,
      weights,
      constraints,
      considered_models: considered,
      final_model: `${decision.provider}/${decision.model_name}`,
      reason: decision.reason,
    };

    // Being over a provider's rate limit is not the same as the provider being
    // broken, and a caller acts on it differently: wait, rather than go and
    // check the key. Collected so the answer can say which happened.
    const failureReasons: FailureReason[] = [];
    let result: Awaited<ReturnType<typeof tryChatWithFallback>>;
    try {
      result = await tryChatWithFallback(models, messages, taskType, req.log, controller.signal, (reason) => failureReasons.push(reason));
    } catch (err) {
      // A model that declined has answered. Routing to another model for a
      // different verdict would be shopping for a yes, so the refusal is the
      // outcome of the request.
      if (!(err instanceof ProviderRefusalError)) throw err;
      const latency_ms = Date.now() - start;
      req.log.info(
        { request_id: req.request_id, provider: err.provider, reason: err.reason },
        'Provider refused the request'
      );
      logRequest(
        {
          id: req.request_id,
          endpoint,
          task_type: taskType,
          complexity,
          priority,
          provider: err.provider,
          model_used: models[0]?.model_name ?? 'unknown',
          tokens_input: 0,
          tokens_output: 0,
          cost: 0,
          premium_baseline_cost: 0,
          latency_ms,
          success: false,
          fallback_level: null,
          routing,
        },
        req.log
      );
      return reply.status(422).send({
        error: {
          code: 'provider_refused',
          message: 'The selected model declined to answer this request',
          reason: err.reason,
        },
        request_id: req.request_id,
      });
    }
    const latency_ms = Date.now() - start;
    reply.raw.removeListener('close', disconnect);

    // The caller hung up. No model refused and none failed, so this is not
    // recorded as a failed request, and there is no socket left to answer on.
    if (controller.signal.aborted) {
      req.log.info({ request_id: req.request_id, endpoint, latency_ms }, 'client disconnected before the answer was ready');
      reply.hijack();
      return;
    }

    if (!result) {
      logRequest(
        {
          id: req.request_id,
          endpoint,
          task_type: taskType,
          complexity,
          priority,
          provider: models[0]?.provider ?? 'unknown',
          model_used: models[0]?.model_name ?? 'unknown',
          tokens_input: 0,
          tokens_output: 0,
          cost: 0,
          premium_baseline_cost: 0,
          latency_ms,
          success: false,
          fallback_level: null,
          routing,
        },
        req.log
      );
      const rateLimited = failureReasons.length > 0 && failureReasons.every((reason) => reason === 'rate_limit');
      return reply.status(rateLimited ? 429 : 502).send({
        error: rateLimited
          ? {
              code: 'provider_rate_limited',
              message: 'Every model this request could use is rate limited by its provider right now. Wait and retry, or add another provider in Settings.',
            }
          : {
              code: 'provider_error',
              message: 'All selected providers failed. Check the provider key, balance, and model access in Settings.',
            },
        request_id: req.request_id,
      });
    }

    if (result.fallbackLevel !== 'primary') {
      req.log.info(
        {
          request_id: req.request_id,
          fallbackLevel: result.fallbackLevel,
          model: `${result.provider}/${result.model}`,
        },
        `Used ${result.fallbackLevel} fallback model`
      );
    }

    const cost = costForModel(result.modelRow, result.inputTokens, result.outputTokens);
    const premiumCost = premiumEstimate(result.inputTokens, result.outputTokens);

    logRequest(
      {
        id: req.request_id,
        endpoint,
        task_type: taskType,
        complexity,
        priority,
        provider: result.provider,
        model_used: result.model,
        tokens_input: result.inputTokens,
        tokens_output: result.outputTokens,
        cost,
        premium_baseline_cost: premiumCost,
        latency_ms,
        success: true,
        fallback_level: result.fallbackLevel,
        routing: { ...routing, final_model: `${result.provider}/${result.model}` },
      },
      req.log
    );

    return reply.send({
      output: result.content,
      model_used: result.model,
      provider: result.provider,
      task_type: taskType,
      complexity: Math.round(complexity * 100) / 100,
      cost: round(cost),
      latency_ms,
      savings_estimate: round(savingsEstimate(cost, premiumCost)),
      fallback_level: result.fallbackLevel,
      request_id: req.request_id,
      routing: {
        task_type: taskType,
        classification: { confidence: classification.confidence, method: classification.method, reasoning: classification.reasoning },
        complexity: { score: complexity, factors: complexityResult.factors, reasoning: complexityResult.reasoning },
        weights,
        constraints,
        considered_models: considered,
        selected_model: `${result.provider}/${result.model}`,
        reason: decision.reason,
        boost_eligible: complexity >= 0.5,
        available_providers: providers,
        offline_mode: isOfflineMode(),
        request_id: req.request_id,
      },
    });
  };
}

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', chatHandler('/v1/chat'));
  app.post('/agent-step', chatHandler('/v1/agent-step', 'agent_step'));
}
