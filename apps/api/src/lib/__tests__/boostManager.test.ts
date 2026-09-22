import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildSubTaskMessages,
  conversationContext,
  decomposeRequest,
  resolveManagerModel,
  synthesizeOutputs,
} from '../boostManager.js';
import { seedCatalogFromConfig } from '../modelCatalog.js';
import { listModels } from '../db/models.js';
import { getDb } from '../db/index.js';

vi.mock('../providers.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providers.js')>(),
  chatWithProvider: vi.fn(),
}));

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const messages = [{ role: 'user' as const, content: 'Build a REST API with documentation and React frontend' }];

describe('decomposeRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The manager model is resolved from the live catalog.
    seedCatalogFromConfig();
  });

  it('parses a valid JSON decompose response into tasks', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: JSON.stringify({
        tasks: [
          { id: 'task_1', description: 'Build the React frontend', task_type: 'coding', instructions: 'Create React components' },
          { id: 'task_2', description: 'Build the REST API', task_type: 'coding', instructions: 'Create Express routes' },
          { id: 'task_3', description: 'Write API documentation', task_type: 'writing', instructions: 'Document all endpoints' },
        ],
        reasoning: 'Split into frontend, backend, and docs',
      }),
      inputTokens: 200,
      outputTokens: 150,
      model: 'claude-sonnet-4-6',
    });

    const result = await decomposeRequest(messages, 'coding', 0.75, 'ai-model-router-ai', mockLog);

    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0].id).toBe('task_1');
    expect(result.tasks[0].task_type).toBe('coding');
    expect(result.reasoning).toBe('Split into frontend, backend, and docs');
    expect(result.cost).toBeGreaterThan(0);
    const selected = listModels().find((model) => model.provider === resolveManagerModel('ai-model-router-ai').provider && model.model_name === resolveManagerModel('ai-model-router-ai').modelName)!;
    expect(result.cost).toBeCloseTo((200 * selected.cost_input + 150 * selected.cost_output) / 1000, 8);
  });

  it.each([
    { tasks: [] },
    { tasks: [{ id: 'one', description: 'Task', task_type: 'unrecognized', instructions: 'Do it' }] },
    { tasks: [{ id: 'one', description: 'Task', task_type: 'coding' }] },
    { tasks: [{ id: 'one', description: 'Task', task_type: 'coding', instructions: 'Do it' }, { id: 'one', description: 'Duplicate', task_type: 'coding', instructions: 'Do it' }] },
  ])('rejects malformed manager plans before workers are scheduled: %j', async (plan) => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({ content: JSON.stringify(plan), inputTokens: 1, outputTokens: 1, model: 'test' });
    await expect(decomposeRequest(messages, 'coding', 0.8, 'ai-model-router-ai', mockLog)).rejects.toThrow('invalid task plan');
  });

  it('accepts a fenced JSON plan without logging model output', async () => {
    const { chatWithProvider } = await import('../providers.js');
    const plan = { tasks: [{ id: 'one', description: 'Task', task_type: 'coding', instructions: 'Do it' }] };
    vi.mocked(chatWithProvider).mockResolvedValueOnce({ content: '```json\n' + JSON.stringify(plan) + '\n```', inputTokens: 1, outputTokens: 1, model: 'test' });
    expect((await decomposeRequest(messages, 'coding', 0.8, 'ai-model-router-ai', mockLog)).tasks).toEqual(plan.tasks);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('caps tasks at 5 even if LLM returns more', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: JSON.stringify({
        tasks: [
          { id: 'task_1', description: 'A', task_type: 'coding', instructions: 'Do A' },
          { id: 'task_2', description: 'B', task_type: 'writing', instructions: 'Do B' },
          { id: 'task_3', description: 'C', task_type: 'coding', instructions: 'Do C' },
          { id: 'task_4', description: 'D', task_type: 'reasoning', instructions: 'Do D' },
          { id: 'task_5', description: 'E', task_type: 'planning', instructions: 'Do E' },
          { id: 'task_6', description: 'F', task_type: 'chat', instructions: 'Do F' },
        ],
        reasoning: 'Six tasks',
      }),
      inputTokens: 100,
      outputTokens: 100,
      model: 'claude-sonnet-4-6',
    });

    const result = await decomposeRequest(messages, 'coding', 0.8, 'ai-model-router-ai', mockLog);
    expect(result.tasks).toHaveLength(5);
  });

  it('throws when provider returns invalid JSON', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: 'Sorry, I cannot decompose this request.',
      inputTokens: 50,
      outputTokens: 20,
      model: 'claude-sonnet-4-6',
    });

    await expect(
      decomposeRequest(messages, 'coding', 0.75, 'ai-model-router-ai', mockLog)
    ).rejects.toThrow('Manager decompose response was not valid JSON');
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('calls chatWithProvider with the model resolved for ai-model-router-ai', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: JSON.stringify({
        tasks: [{ id: 'task_1', description: 'Do it', task_type: 'coding', instructions: 'Go' }],
        reasoning: 'Simple',
      }),
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4-6',
    });

    await decomposeRequest(messages, 'coding', 0.75, 'ai-model-router-ai', mockLog);

    const manager = resolveManagerModel('ai-model-router-ai');
    expect(chatWithProvider).toHaveBeenCalledWith(
      manager.provider,
      manager.modelName,
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ])
    );
  });
});

const mockSubTaskResults: import('../boostManager.js').SubTaskResult[] = [
  {
    task: { id: 'task_1', description: 'Build React frontend', task_type: 'coding', instructions: 'Create components' },
    output: '```tsx\nconst App = () => <div>Hello</div>\n```',
    model_used: 'openai/gpt-4o',
    cost: 0.006,
    inputTokens: 200,
    outputTokens: 300,
    latency_ms: 2100,
    status: 'completed',
  },
  {
    task: { id: 'task_2', description: 'Write REST API', task_type: 'coding', instructions: 'Create routes' },
    output: '```ts\napp.get("/api", (req, res) => res.json({ ok: true }))\n```',
    model_used: 'anthropic/claude-sonnet-4-6',
    cost: 0.008,
    inputTokens: 150,
    outputTokens: 250,
    latency_ms: 1900,
    status: 'completed',
  },
];

describe('synthesizeOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The manager model is resolved from the live catalog.
    seedCatalogFromConfig();
  });

  it('returns merged output from LLM synthesis call', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: 'Here is the complete solution combining frontend and API...',
      inputTokens: 500,
      outputTokens: 300,
      model: 'claude-sonnet-4-6',
    });

    const result = await synthesizeOutputs(messages, mockSubTaskResults, 'ai-model-router-ai');

    expect(result.output).toBe('Here is the complete solution combining frontend and API...');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.cost).toBeGreaterThan(0);
  });

  it('includes all sub-task outputs and original request in the synthesis call', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: 'Synthesized output',
      inputTokens: 400,
      outputTokens: 200,
      model: 'claude-sonnet-4-6',
    });

    await synthesizeOutputs(messages, mockSubTaskResults, 'ai-model-router-ai');

    const callArgs = vi.mocked(chatWithProvider).mock.calls[0];
    const userMessage = callArgs[2].find((m) => m.role === 'user');
    const content = typeof userMessage!.content === 'string' ? userMessage!.content : '';
    expect(content).toContain('Build a REST API');
    expect(content).toContain('task_1');
    expect(content).toContain('Build React frontend');
  });

  it('handles a failed sub-task in synthesis input without throwing', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: 'Partial output noting task_2 failed',
      inputTokens: 300,
      outputTokens: 100,
      model: 'claude-sonnet-4-6',
    });

    const resultsWithFailure: import('../boostManager.js').SubTaskResult[] = [
      { ...mockSubTaskResults[0] },
      { ...mockSubTaskResults[1], status: 'failed', output: '', error: 'Provider error' },
    ];

    const result = await synthesizeOutputs(messages, resultsWithFailure, 'ai-model-router-ai');
    expect(result.output).toBe('Partial output noting task_2 failed');
  });
});

describe('resolveManagerModel', () => {
  beforeEach(() => {
    seedCatalogFromConfig();
  });

  it('picks the highest-quality routable model for ai-model-router-ai', () => {
    const manager = resolveManagerModel('ai-model-router-ai');
    const best = listModels().sort((a, b) => (b.quality_rating ?? 0) - (a.quality_rating ?? 0))[0];

    expect(manager.provider).toBe(best.provider);
    expect(manager.modelName).toBe(best.model_name);
  });

  it('only considers providers this instance has a key for', () => {
    process.env.AI_MODEL_ROUTER_OFFLINE = '0';
    process.env.GROQ_API_KEY = 'test-groq-key';

    try {
      expect(resolveManagerModel('ai-model-router-ai').provider).toBe('groq');
    } finally {
      delete process.env.GROQ_API_KEY;
      process.env.AI_MODEL_ROUTER_OFFLINE = '1';
    }
  });

  it('accepts an explicit provider/model override', () => {
    expect(resolveManagerModel('openai/gpt-4o')).toEqual({
      provider: 'openai',
      modelName: 'gpt-4o',
    });
  });

  it('rejects overrides that are outside the available catalog', () => {
    expect(() => resolveManagerModel('openai/nonexistent-model')).toThrow('not in the available model catalog');
    expect(() => resolveManagerModel('invalid-override')).toThrow('not in the available model catalog');
  });

  it('throws when the catalog has nothing routable', () => {
    getDb().prepare('DELETE FROM models').run();
    expect(() => resolveManagerModel('ai-model-router-ai')).toThrow(/no model available/i);
  });
});

/**
 * Splitting a request into parts does not release it from the constraints it
 * was made under. Decomposition once saw only the final user message, so a
 * system instruction and an earlier requirement were dropped before any worker
 * was scheduled, and every worker inherited the gap.
 */
describe('conversation context through boost', () => {
  const conversation = [
    { role: 'system' as const, content: 'Always answer in Arabic.' },
    { role: 'user' as const, content: 'Build a task queue. It must use SQLite for storage.' },
    { role: 'assistant' as const, content: 'Here is a design sketch.' },
    { role: 'user' as const, content: 'Now implement it with concurrency and prove correctness.' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    seedCatalogFromConfig();
  });

  /** The user-role prompt actually sent to the manager on its first call. */
  const managerPrompt = (calls: unknown[]): string => {
    const [, , sent] = calls[0] as [string, string, Array<{ role: string; content: unknown }>];
    const userMessage = sent.find((message) => message.role === 'user');
    return typeof userMessage?.content === 'string' ? userMessage.content : '';
  };

  it('reads the system instructions, the earlier turns and the latest request', () => {
    const context = conversationContext(conversation);

    expect(context.systemInstructions).toBe('Always answer in Arabic.');
    expect(context.transcript).toContain('user: Build a task queue. It must use SQLite for storage.');
    expect(context.transcript).toContain('assistant: Here is a design sketch.');
    expect(context.latestRequest).toBe('Now implement it with concurrency and prove correctness.');
  });

  it('keeps the most recent turns when the conversation outgrows the budget', () => {
    const long = [
      { role: 'user' as const, content: `ancient: ${'a'.repeat(5000)}` },
      { role: 'assistant' as const, content: 'recent answer' },
      { role: 'user' as const, content: 'what now?' },
    ];

    const context = conversationContext(long);

    expect(context.transcript).toContain('assistant: recent answer');
    expect(context.transcript).toContain('[earlier turns omitted]');
    expect(context.transcript).not.toContain('ancient');
  });

  it('sends the constraints to the manager when decomposing', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: JSON.stringify({
        tasks: [{ id: 'task_1', description: 'Implement', task_type: 'coding', instructions: 'Go' }],
        reasoning: 'single task',
      }),
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4-6',
    });

    await decomposeRequest(conversation, 'coding', 0.8, 'ai-model-router-ai', mockLog);

    const prompt = managerPrompt(vi.mocked(chatWithProvider).mock.calls);
    expect(prompt).toContain('Always answer in Arabic.');
    expect(prompt).toContain('It must use SQLite for storage.');
    expect(prompt).toContain('Now implement it with concurrency and prove correctness.');
  });

  it('sends the constraints to the manager when synthesizing', async () => {
    const { chatWithProvider } = await import('../providers.js');
    vi.mocked(chatWithProvider).mockResolvedValueOnce({
      content: 'merged',
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet-4-6',
    });

    await synthesizeOutputs(conversation, mockSubTaskResults, 'ai-model-router-ai');

    const prompt = managerPrompt(vi.mocked(chatWithProvider).mock.calls);
    expect(prompt).toContain('Always answer in Arabic.');
    expect(prompt).toContain('It must use SQLite for storage.');
    expect(prompt).toContain('Now implement it with concurrency and prove correctness.');
  });

  it('gives a worker the system instructions as system instructions', () => {
    const task = {
      id: 'task_1',
      description: 'Implement the queue',
      task_type: 'coding' as const,
      instructions: 'Write the code',
    };

    const messages = buildSubTaskMessages(task, conversationContext(conversation));

    expect(messages[0]).toEqual({ role: 'system', content: 'Always answer in Arabic.' });
    const worker = messages[1].content as string;
    expect(worker).toContain('It must use SQLite for storage.');
    expect(worker).toContain('Now implement it with concurrency and prove correctness.');
    expect(worker).toContain('Implement the queue');
    expect(worker).toContain('Write the code');
  });

  it('sends only the task when there is no context to carry', () => {
    const task = {
      id: 'task_1',
      description: 'Summarise this',
      task_type: 'summarization' as const,
      instructions: 'Keep it short',
    };

    const messages = buildSubTaskMessages(task, conversationContext([]));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Your sub-task: Summarise this\n\nKeep it short');
  });
});
