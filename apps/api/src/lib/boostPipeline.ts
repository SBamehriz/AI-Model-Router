import type { ChatMessage } from './messages.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TaskType } from './taskClassifier.js';
import { estimateComplexityDetailed } from './complexityEstimator.js';
import { selectModels, type RoutingPriority, type RoutingLatencyPreference } from './router.js';
import { estimateTokensFromMessages } from './tokens.js';
import { costForModel } from './providers.js';
import { tryChatWithFallback } from './chatExecution.js';
import {
  buildSubTaskMessages,
  conversationContext,
  decomposeRequest,
  synthesizeOutputs,
  type BoostTask,
  type ConversationContext,
  type SubTaskResult,
} from './boostManager.js';

export interface BoostDetails {
  complexity_score: number;
  /** The model that decomposed and synthesized, as `provider/model`. */
  manager_model: string;
  decompose_reasoning: string;
  total_tasks: number;
  parallel_latency_ms: number;
  synthesis_latency_ms: number;
  synthesis_failed?: boolean;
  tasks: Array<{
    id: string;
    description: string;
    task_type: TaskType;
    model_used: string;
    cost: number;
    latency_ms: number;
    status: 'completed' | 'failed';
  }>;
}

export interface BoostResult {
  inputTokens: number;
  outputTokens: number;
  output: string;
  model_used: 'ai-model-router-ai';
  total_cost: number;
  total_latency_ms: number;
  boost_details: BoostDetails;
}

async function executeSubTask(
  task: BoostTask,
  context: ConversationContext,
  priority: RoutingPriority,
  latencyPref: RoutingLatencyPreference,
  availableProviders: string[],
  log: FastifyBaseLogger,
  signal?: AbortSignal
): Promise<SubTaskResult> {
  // The worker sees the same system instructions and conversation the
  // single-model path would have seen, not just the slice the manager wrote.
  const taskMessage = buildSubTaskMessages(task, context);

  // Difficulty is a property of the sub-task, not of how much conversation it
  // is carrying, so it is estimated from the task alone. Cost and context
  // filtering use the whole payload, which is what actually gets sent.
  const taskOnly: ChatMessage[] = [
    { role: 'user', content: `${task.description}\n\n${task.instructions}` },
  ];
  const complexityResult = estimateComplexityDetailed(taskOnly, task.task_type);
  const tokenEstimate = estimateTokensFromMessages(taskMessage);

  const models = await selectModels(task.task_type, complexityResult.complexity, priority, latencyPref, {
    tokenEstimate,
    availableProviders,
  });

  if (!models.length) {
    return {
      task,
      inputTokens: 0,
      outputTokens: 0,
      output: '',
      model_used: 'none',
      cost: 0,
      latency_ms: 0,
      status: 'failed',
      error: 'No models available for this sub-task',
    };
  }

  const start = Date.now();
  const result = await tryChatWithFallback(models, taskMessage, task.task_type, log, signal);
  const latency_ms = Date.now() - start;

  if (!result) {
    return { task, inputTokens: 0, outputTokens: 0, output: '', model_used: 'none', cost: 0, latency_ms, status: 'failed', error: 'All providers failed' };
  }

  const cost = costForModel(result.modelRow, result.inputTokens, result.outputTokens);
  return {
    task,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    output: result.content,
    model_used: `${result.provider}/${result.model}`,
    cost,
    latency_ms,
    status: 'completed',
  };
}

export async function runBoostPipeline(
  messages: ChatMessage[],
  taskType: TaskType,
  complexityScore: number,
  priority: RoutingPriority,
  latencyPref: RoutingLatencyPreference,
  managerModel: string,
  availableProviders: string[],
  log: FastifyBaseLogger,
  signal?: AbortSignal
): Promise<BoostResult> {
  const pipelineStart = Date.now();
  const context = conversationContext(messages);
  const decomposeResult = await decomposeRequest(messages, taskType, complexityScore, managerModel, log);

  const parallelStart = Date.now();
  const subTaskResults = await Promise.all(
    decomposeResult.tasks.map((task) =>
      executeSubTask(task, context, priority, latencyPref, availableProviders, log, signal)
    )
  );
  const parallel_latency_ms = Date.now() - parallelStart;

  let output: string;
  let synthesisLatencyMs = 0;
  let synthesisCost = 0;
  let synthesisInputTokens = 0;
  let synthesisOutputTokens = 0;
  let synthesisFailed: true | undefined;

  try {
    if (signal?.aborted) throw new Error('client disconnected before synthesis');
    const synthesisResult = await synthesizeOutputs(messages, subTaskResults, managerModel);
    output = synthesisResult.output;
    synthesisLatencyMs = synthesisResult.latency_ms;
    synthesisCost = synthesisResult.cost;
    synthesisInputTokens = synthesisResult.inputTokens;
    synthesisOutputTokens = synthesisResult.outputTokens;
  } catch (err) {
    log.warn({ err }, 'Synthesis failed, using best sub-task output as fallback');
    synthesisFailed = true;
    const completed = subTaskResults.filter((r) => r.status === 'completed');
    if (!completed.length) {
      throw new Error('All sub-tasks and synthesis failed');
    }
    output = completed.map((r) => r.output).join('\n\n');
  }

  const workerCost = subTaskResults.reduce((sum, r) => sum + r.cost, 0);
  const total_cost = decomposeResult.cost + workerCost + synthesisCost;
  const total_latency_ms = Date.now() - pipelineStart;
  const inputTokens = decomposeResult.inputTokens + synthesisInputTokens + subTaskResults.reduce((sum, result) => sum + result.inputTokens, 0);
  const outputTokens = decomposeResult.outputTokens + synthesisOutputTokens + subTaskResults.reduce((sum, result) => sum + result.outputTokens, 0);

  const boost_details: BoostDetails = {
    complexity_score: complexityScore,
    manager_model: decomposeResult.manager,
    decompose_reasoning: decomposeResult.reasoning,
    total_tasks: decomposeResult.tasks.length,
    parallel_latency_ms,
    synthesis_latency_ms: synthesisLatencyMs,
    ...(synthesisFailed ? { synthesis_failed: true } : {}),
    tasks: subTaskResults.map((r) => ({
      id: r.task.id,
      description: r.task.description,
      task_type: r.task.task_type,
      model_used: r.model_used,
      cost: Math.round(r.cost * 1e8) / 1e8,
      latency_ms: r.latency_ms,
      status: r.status,
    })),
  };

  return {
    output,
    inputTokens,
    outputTokens,
    model_used: 'ai-model-router-ai',
    total_cost,
    total_latency_ms,
    boost_details,
  };
}
