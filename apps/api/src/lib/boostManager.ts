import type { ChatMessage } from './messages.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TaskType } from './taskClassifier.js';
import { chatWithProvider, costForModel } from './providers.js';
import { listModels } from './db/models.js';
import { availableProviders } from './providerAvailability.js';
import { BoostPlanSchema } from './schemas.js';

/**
 * How much earlier conversation each call carries. Enough for the requirements
 * a follow up refers to, bounded so a long thread cannot multiply the cost of
 * every sub task.
 */
const CONTEXT_CHAR_BUDGET = 4000;

/**
 * What every stage of the pipeline has to see. A request that is split into
 * parts still has to be answered under the constraints it was made under, so a
 * follow up such as "now implement it" keeps the requirement it refers to.
 */
export interface ConversationContext {
  /** System instructions exactly as the caller wrote them. */
  systemInstructions: string;
  /** Earlier turns, most recent first, within the budget. */
  transcript: string;
  /** The turn being answered. */
  latestRequest: string;
}

const messageText = (message: ChatMessage): string =>
  typeof message.content === 'string' ? message.content : '';

export function conversationContext(messages: ChatMessage[]): ConversationContext {
  const systemInstructions = messages
    .filter((m) => m.role === 'system')
    .map(messageText)
    .join('\n\n')
    .trim();

  let latestUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      latestUserIndex = i;
      break;
    }
  }

  const priorTurns = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role !== 'system' && index !== latestUserIndex)
    .map(({ message }) => `${message.role}: ${messageText(message)}`);

  // A constraint set three turns ago matters more than the greeting that
  // opened the thread.
  const kept: string[] = [];
  let budget = CONTEXT_CHAR_BUDGET;
  let dropped = false;
  for (let i = priorTurns.length - 1; i >= 0; i -= 1) {
    const turn = priorTurns[i];
    if (turn.length > budget) {
      dropped = true;
      break;
    }
    kept.unshift(turn);
    budget -= turn.length;
  }
  if (dropped) kept.unshift('[earlier turns omitted]');

  return {
    systemInstructions,
    transcript: kept.join('\n'),
    latestRequest: latestUserIndex >= 0 ? messageText(messages[latestUserIndex]) : '',
  };
}

/** The preamble every call shares: what to respect, and what came before. */
function renderContext(
  context: ConversationContext,
  options: { includeSystem?: boolean } = {}
): string {
  const includeSystem = options.includeSystem ?? true;
  const sections: string[] = [];
  if (includeSystem && context.systemInstructions) {
    sections.push(
      `System instructions that apply to this request. Follow them exactly:\n${context.systemInstructions}`
    );
  }
  if (context.transcript) {
    sections.push(`Conversation so far:\n${context.transcript}`);
  }
  return sections.join('\n\n');
}

export interface BoostTask {
  id: string;
  description: string;
  task_type: TaskType;
  instructions: string;
}

export interface DecomposeResult {
  inputTokens: number;
  outputTokens: number;
  tasks: BoostTask[];
  reasoning: string;
  cost: number;
  /** The model that actually ran, as `provider/model`, not the requested alias. */
  manager: string;
}

export interface SubTaskResult {
  inputTokens: number;
  outputTokens: number;
  task: BoostTask;
  output: string;
  model_used: string;
  cost: number;
  latency_ms: number;
  status: 'completed' | 'failed';
  error?: string;
}

export interface SynthesisResult {
  inputTokens: number;
  outputTokens: number;
  output: string;
  latency_ms: number;
  cost: number;
}

/**
 * The model that decomposes and synthesizes. The default resolves to the
 * strongest model this instance can actually reach, so the manager can never
 * point at something unroutable. Anything else is an explicit provider and
 * model override.
 */
export function resolveManagerModel(managerModel: string): { provider: string; modelName: string } {
  const providers = new Set(availableProviders());
  const candidates = listModels().filter((m) => providers.has(m.provider));
  if (managerModel && managerModel !== 'ai-model-router-ai') {
    const requested = candidates.find((model) => `${model.provider}/${model.model_name}` === managerModel);
    if (!requested) throw new Error('Requested boost manager is not in the available model catalog');
    return { provider: requested.provider, modelName: requested.model_name };
  }

  candidates.sort((a, b) => (b.quality_rating ?? 0) - (a.quality_rating ?? 0));

  const best = candidates[0];
  if (!best) {
    throw new Error('No model available to act as the boost manager');
  }
  return { provider: best.provider, modelName: best.model_name };
}

function managerCost(provider: string, modelName: string, inputTokens: number, outputTokens: number): number {
  const model = listModels().find((row) => row.provider === provider && row.model_name === modelName);
  if (!model) throw new Error('Boost manager pricing is unavailable');
  return costForModel(model, inputTokens, outputTokens);
}

const DECOMPOSE_SYSTEM_PROMPT = `You are AI Model Router AI, an intelligent orchestration system that coordinates specialized AI models to solve complex problems together.

Your job in this step is to analyze the user's request and break it into clear, independent sub-tasks that different specialized models can work on in parallel.

Rules:
- Create between 2 and 5 sub-tasks. Never more than 5.
- Each sub-task must be independent. It should not need the output of another sub-task to complete.
- Each sub-task must have a clear, self-contained description with enough context to complete it without knowing about the other tasks.
- Any system instruction, earlier requirement or constraint from the conversation that applies to a sub-task must be restated in that sub-task's instructions. A worker sees the conversation context, but the instructions are what it is held to.
- Assign the correct task_type from: coding, debugging, writing, reasoning, math_reasoning, summarization, data_analysis, planning, translation, email, customer_support, image, chat.
- If the request cannot meaningfully be split into independent tasks, return a single task.

Respond with ONLY valid JSON in this format:
{
  "tasks": [
    {
      "id": "task_1",
      "description": "...",
      "task_type": "coding",
      "instructions": "Specific instructions for this model. Include all context it needs."
    }
  ],
  "reasoning": "Brief explanation of why you split it this way."
}`;

export async function decomposeRequest(
  messages: ChatMessage[],
  taskType: TaskType,
  complexityScore: number,
  managerModel: string,
  log: FastifyBaseLogger
): Promise<DecomposeResult> {
  const { provider, modelName } = resolveManagerModel(managerModel);

  const context = conversationContext(messages);
  const preamble = renderContext(context);

  const callMessages: ChatMessage[] = [
    { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Task type: ${taskType}`,
        `Complexity score: ${complexityScore.toFixed(2)}`,
        ...(preamble ? ['', preamble] : []),
        '',
        `Latest user request:\n${context.latestRequest}`,
      ].join('\n'),
    },
  ];

  const result = await chatWithProvider(provider, modelName, callMessages);
  const cost = managerCost(provider, modelName, result.inputTokens, result.outputTokens);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    log.warn(
      { managerModel },
      'Failed to parse decompose response as JSON'
    );
    throw new Error('Manager decompose response was not valid JSON');
  }

  const plan = BoostPlanSchema.safeParse(parsed);
  if (!plan.success) throw new Error('Manager decompose response contained an invalid task plan');
  return {
    ...plan.data,
    cost,
    manager: `${provider}/${modelName}`,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

const SYNTHESIZE_SYSTEM_PROMPT = `You are AI Model Router AI, an intelligent orchestration system that coordinates specialized AI models to solve complex problems together.

Your job in this step is to synthesize the outputs from multiple specialized models into one unified, coherent response. The user asked you one question. You coordinated multiple models to answer it together, and now you are presenting the final result.

Rules:
- Merge all outputs seamlessly. The final response should read as one coherent piece, not a collection of parts.
- Ensure all parts work together correctly (e.g., API routes match what the frontend calls, variable names are consistent).
- Resolve any conflicts or inconsistencies between model outputs.
- Present the result naturally. At the end, include a brief "## How This Was Built" section listing what each model contributed.
- If a sub-task failed, acknowledge the gap and work around it.
- The final response must obey the system instructions and the constraints stated earlier in the conversation, even where a sub-task output did not.

You are part of AI Model Router, a self-hosted routing and orchestration tool. If asked about your identity, explain that your response is synthesized from model outputs. Do not claim to be a proprietary foundation model.`;

/**
 * What one worker sees. System instructions stay system instructions rather
 * than being flattened into prose, so a worker is bound by them the same way
 * the single model path would be.
 */
export function buildSubTaskMessages(task: BoostTask, context: ConversationContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (context.systemInstructions) {
    messages.push({ role: 'system', content: context.systemInstructions });
  }

  const history = renderContext(context, { includeSystem: false });
  const sections = [
    ...(history ? [history, ''] : []),
    ...(context.latestRequest
      ? [`The full request this sub-task is part of:\n${context.latestRequest}`, '', '---', '']
      : []),
    `Your sub-task: ${task.description}`,
    '',
    task.instructions,
  ];

  messages.push({ role: 'user', content: sections.join('\n') });
  return messages;
}

export async function synthesizeOutputs(
  originalMessages: ChatMessage[],
  subTaskResults: SubTaskResult[],
  managerModel: string
): Promise<SynthesisResult> {
  const { provider, modelName } = resolveManagerModel(managerModel);

  const context = conversationContext(originalMessages);
  const preamble = renderContext(context);

  const taskSummaries = subTaskResults
    .map((r) => {
      const body =
        r.status === 'completed'
          ? r.output
          : `Error: ${r.error ?? 'unknown failure'}`;
      return `## ${r.task.id}: ${r.task.description}\nStatus: ${r.status}\n\n${body}`;
    })
    .join('\n\n---\n\n');

  const callMessages: ChatMessage[] = [
    { role: 'system', content: SYNTHESIZE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        ...(preamble ? [preamble, ''] : []),
        `Original request:\n${context.latestRequest}`,
        '',
        '---',
        '',
        `Specialist model outputs:\n\n${taskSummaries}`,
      ].join('\n'),
    },
  ];

  const start = Date.now();
  const result = await chatWithProvider(provider, modelName, callMessages);
  const latency_ms = Date.now() - start;
  const cost = managerCost(provider, modelName, result.inputTokens, result.outputTokens);

  return { output: result.content, latency_ms, cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}
