import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { classifyTaskAsync } from '../lib/taskClassifier.js';
import { estimateComplexityDetailed } from '../lib/complexityEstimator.js';
import { selectModels, getRoutingDecision, getWeightsForRequest, getConstraints } from '../lib/router.js';
import { explainNoCandidates, prepareChatRequest } from '../lib/chatRequest.js';
import { availableProviders, isOfflineMode } from '../lib/providerAvailability.js';

export const debugRoutes: FastifyPluginAsync = async (app) => {
  app.post('/debug', async (req: FastifyRequest, reply: FastifyReply) => {
    // Exactly what /v1/chat runs, minus the completion. A preview that
    // validated or priced a different request than the run would be worse than
    // no preview at all.
    const prepared = prepareChatRequest(req.body);
    if (!prepared.ok) {
      return reply.status(400).send({ error: prepared.error, request_id: req.request_id });
    }

    const { messages, priority, latency_pref, max_cost, boost, tokenEstimate } = prepared.value;

    const classification = await classifyTaskAsync(messages, req.log);
    const task_type = classification.taskType;

    const complexityResult = estimateComplexityDetailed(messages, task_type);
    const complexity = complexityResult.complexity;

    const weights = getWeightsForRequest(priority, complexity, latency_pref);

    const constraints = getConstraints(task_type, complexity, max_cost);

    const providers = availableProviders();

    const models = await selectModels(task_type, complexity, priority, latency_pref, {
      maxCost: max_cost,
      tokenEstimate,
      availableProviders: providers,
    });

    if (models.length === 0) {
      const failure = await explainNoCandidates(tokenEstimate, providers, max_cost);
      return reply.status(failure.status).send({
        error: { code: failure.code, message: failure.message },
        request_id: req.request_id,
      });
    }

    const decision = getRoutingDecision(models, task_type, priority, latency_pref);

    return reply.send({
      task_type,
      classification: {
        confidence: classification.confidence,
        method: classification.method,
        reasoning: classification.reasoning,
      },
      complexity: {
        score: complexity,
        factors: complexityResult.factors,
        reasoning: complexityResult.reasoning,
      },
      weights,
      constraints,
      considered_models: models.slice(0, 5).map((m) => ({
        provider: m.provider,
        model_name: m.model_name,
        score: m.score,
        quality_rating: m.quality_rating,
      })),
      selected_model: `${decision.provider}/${decision.model_name}`,
      reason: decision.reason,
      boost_eligible: complexity >= 0.5,
      boost_requested: boost,
      available_providers: providers,
      offline_mode: isOfflineMode(),
      request_id: req.request_id,
    });
  });
}
