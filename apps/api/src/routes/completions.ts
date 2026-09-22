import { ProviderRefusalError } from '../lib/providerClient.js';
import type { FastifyPluginAsync } from 'fastify';
import { CompatibleRequestSchema, type CompatibleResult } from '../lib/compatibleSchemas.js';
import { compatibleCompletion } from '../lib/compatibleProviders.js';
import { classifyTaskHeuristicWithConfidence } from '../lib/taskClassifier.js';
import { estimateComplexityDetailed } from '../lib/complexityEstimator.js';
import { selectModels, getWeightsForRequest, getConstraints } from '../lib/router.js';
import { explainNoCandidates } from '../lib/chatRequest.js';
import { describeValidationFailure } from '../lib/schemas.js';
import { MAX_MODELS_ATTEMPTED, type FailureReason } from '../lib/fallback.js';
import { classifyFailure } from '../lib/chatExecution.js';
import { listModels } from '../lib/db/models.js';
import { insertRequest, insertRoutingDecision, insertProviderAttempt } from '../lib/db/requests.js';
import { withTransaction } from '../lib/db/index.js';
import { availableProviders, isOfflineMode } from '../lib/providerAvailability.js';
import { costForModel, premiumEstimate } from '../lib/providers.js';
import { estimateTokensFromText } from '../lib/tokens.js';
import { completeOffline } from '../lib/offlineProvider.js';

export const ROUTER_MODELS = ['auto', 'auto-cheap', 'auto-best'] as const;

export const completionsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat/completions', { config: { compress: false } }, async (req, reply) => {
    const parsed = CompatibleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request_error', type: 'invalid_request_error', ...describeValidationFailure(parsed.error.issues) },
        request_id: req.request_id,
      });
    }
    const body = parsed.data;
    const start = Date.now();
    const messages = body.messages.filter((m) => m.role !== 'tool').map((m) => ({ role: m.role === 'developer' ? 'system' as const : m.role as 'user' | 'system' | 'assistant', content: m.content ?? '' }));
    const classification = classifyTaskHeuristicWithConfidence(messages);
    const taskType = classification.taskType;
    const complexity = estimateComplexityDetailed(messages, taskType).complexity;
    const priority = body.model === 'auto-cheap' ? 'cheap' : body.model === 'auto-best' ? 'best' : 'balanced';
    const inputEstimate = estimateTokensFromText(JSON.stringify(body.messages) + JSON.stringify(body.tools ?? []));
    const outputEstimate = body.max_completion_tokens ?? body.max_tokens ?? 4096;
    const usesTools = !!body.tools?.length || body.messages.some((m) => m.role === 'tool' || m.tool_calls?.length);
    const catalog = new Map(listModels().map((m) => [m.id, m]));
    const candidates = (await selectModels(taskType, complexity, priority, 'normal', { availableProviders: availableProviders(), tokenEstimate: { inputTokens: inputEstimate, outputTokens: outputEstimate, totalTokens: inputEstimate + outputEstimate } }))
      .filter((m) => {
        const metadata = catalog.get(m.id);
        return (!usesTools || (metadata?.supports_functions && m.provider !== 'google')) && (!metadata?.max_tokens || inputEstimate + outputEstimate <= metadata.max_tokens);
      });
    if (!candidates.length) {
      // Say which filter emptied the list, the way the original path does. A
      // conversation larger than every window is not a capability problem, and
      // the documented error table promises the specific code either way.
      const explained = await explainNoCandidates(
        { inputTokens: inputEstimate, outputTokens: outputEstimate, totalTokens: inputEstimate + outputEstimate },
        availableProviders(),
      );
      const toolsAreTheLikelyCause = usesTools && explained.code === 'no_capable_model';
      const error = toolsAreTheLikelyCause
        ? { code: 'no_capable_model', message: 'No configured model can handle this tool conversation and context size. Add a provider with a tool-capable model in Settings.' }
        : { code: explained.code, message: explained.message };
      return reply.code(explained.status).send({ error, request_id: req.request_id });
    }

    // Selection returns every eligible model. Trying all of them makes the
    // worst case grow with the catalog, so only the top few are attempted.
    const attempts = candidates.slice(0, MAX_MODELS_ATTEMPTED);

    // Over a provider's rate limit is a wait, not a broken key. The answer
    // has to say which, because a client acts on them differently.
    const failureReasons: FailureReason[] = [];

    // Every outcome records a decision, not just the successful one. The
    // candidate list and its scores are most useful when nothing worked.
    const recordDecision = (model: { provider: string; model_name: string }, outcome: string) => insertRoutingDecision({
      request_id: req.request_id!, task_type: taskType, classification_method: 'heuristic', confidence: classification.confidence, complexity,
      weights: getWeightsForRequest(priority, complexity, 'normal'), constraints: getConstraints(taskType, complexity),
      considered_models: candidates.slice(0, 5).map((m) => ({ provider: m.provider, model_name: m.model_name, score: m.score })),
      final_model: `${model.provider}/${model.model_name}`,
      reason: `OpenAI-compatible ${body.model}; ${outcome}${usesTools ? '; tool-capable models only' : ''}`,
    });

    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.on('close', disconnect);
    const offline = isOfflineMode();
    // A client may ask for SSE even though the adapter returns JSON. Hold the
    // connection open, then emit standard chunks once the answer arrives.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const event = (value: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(value)}\n\n`); };
    if (body.stream) {
      reply.header('Content-Type', 'text/event-stream; charset=utf-8').header('Cache-Control', 'no-cache, no-transform').header('X-Accel-Buffering', 'no');
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200);
      reply.raw.write(': connected\n\n');
      heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': waiting\n\n'); }, 10000);
    }
    try {
      for (const [index, model] of attempts.entries()) {
        if (controller.signal.aborted) return;
        const attemptStart = Date.now();
        let result: CompatibleResult;
        try {
          if (offline) {
            const simulated = await completeOffline(model.provider, model.model_name, messages);
            result = { content: simulated.content, inputTokens: simulated.inputTokens, outputTokens: simulated.outputTokens, finish_reason: 'stop' };
          } else result = await compatibleCompletion(model.provider, model.model_name, body, controller.signal);
          insertProviderAttempt({ provider: model.provider, model_name: model.model_name, success: true, latency_ms: Date.now() - attemptStart, source: offline ? 'offline' : 'live' });
        } catch (failure) {
          if (controller.signal.aborted) return;
          insertProviderAttempt({ provider: model.provider, model_name: model.model_name, success: false, latency_ms: Date.now() - attemptStart, source: offline ? 'offline' : 'live' });
          if (failure instanceof ProviderRefusalError) {
            withTransaction(() => {
              insertRequest({ id: req.request_id, endpoint: '/v1/chat/completions', task_type: taskType, complexity, priority, provider: model.provider, model_used: model.model_name, tokens_input: 0, tokens_output: 0, cost: 0, premium_baseline_cost: 0, latency_ms: Date.now() - start, success: false, fallback_level: null, source: offline ? 'offline' : 'live' });
              recordDecision(model, 'the provider declined the request');
            });
            // The stated reason travels with the refusal here too, so a
            // compatible client can tell a safety block from a plain decline.
            const error = { error: { code: 'provider_refused', message: 'The provider declined this request.', reason: failure.reason }, request_id: req.request_id };
            if (body.stream) { event(error); reply.raw.end('data: [DONE]\n\n'); return; }
            return reply.code(422).send(error);
          }
          failureReasons.push(classifyFailure(failure));
          req.log.warn({ provider: model.provider, model: model.model_name, request_id: req.request_id }, 'Compatible completion failed; trying the next ranked model');
          continue;
        }
        const cost = costForModel(model, result.inputTokens, result.outputTokens);
        const fallback = index === 0 ? 'primary' : index === 1 ? 'backup' : 'emergency';
        withTransaction(() => {
          insertRequest({ id: req.request_id, endpoint: '/v1/chat/completions', task_type: taskType, complexity, priority, provider: model.provider, model_used: model.model_name, tokens_input: result.inputTokens, tokens_output: result.outputTokens, cost, premium_baseline_cost: premiumEstimate(result.inputTokens, result.outputTokens), latency_ms: Date.now() - start, success: true, fallback_level: fallback, source: offline ? 'offline' : 'live' });
          recordDecision(model, `${fallback} completion`);
        });
        const common = { id: `chatcmpl-${req.request_id}`, created: Math.floor(Date.now() / 1000), model: `${model.provider}/${model.model_name}` };
        const usage = { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.inputTokens + result.outputTokens };
        if (!body.stream) return reply.send({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: result.content, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) }, finish_reason: result.finish_reason }], usage, request_id: req.request_id });
        const chunk = { ...common, object: 'chat.completion.chunk' };
        event({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: result.content ?? '', ...(result.tool_calls ? { tool_calls: result.tool_calls.map((call, toolIndex) => ({ index: toolIndex, ...call })) } : {}) }, finish_reason: null }] });
        event({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: result.finish_reason }] });
        if (body.stream_options?.include_usage) event({ ...chunk, choices: [], usage });
        reply.raw.end('data: [DONE]\n\n');
        return;
      }
      withTransaction(() => {
        insertRequest({ id: req.request_id, endpoint: '/v1/chat/completions', task_type: taskType, complexity, priority, provider: candidates[0].provider, model_used: candidates[0].model_name, tokens_input: 0, tokens_output: 0, cost: 0, premium_baseline_cost: 0, latency_ms: Date.now() - start, success: false, fallback_level: null, source: offline ? 'offline' : 'live' });
        recordDecision(candidates[0], `every candidate failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`);
      });
      const rateLimited = failureReasons.length > 0 && failureReasons.every((reason) => reason === 'rate_limit');
      const error = rateLimited
        ? { error: { code: 'provider_rate_limited', type: 'rate_limit_error', message: 'Every model this request could use is rate limited by its provider right now. Wait and retry, or add another provider in Settings.' }, request_id: req.request_id }
        : { error: { code: 'provider_error', type: 'server_error', message: 'All selected providers failed. Check the provider key, balance, and model access in Settings.' }, request_id: req.request_id };
      if (body.stream) { event(error); reply.raw.end('data: [DONE]\n\n'); return; }
      return reply.code(rateLimited ? 429 : 502).send(error);
    } catch {
      req.log.error({ request_id: req.request_id }, 'Compatible completion processing failed');
      const error = { error: { code: 'internal_error', type: 'server_error', message: 'The router could not complete the request.' }, request_id: req.request_id };
      if (body.stream) { event(error); reply.raw.end('data: [DONE]\n\n'); return; }
      return reply.code(500).send(error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      reply.raw.removeListener('close', disconnect);
    }
  });
};
