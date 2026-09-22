import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBoostPipeline } from '../boostPipeline.js';

// The manager's two model calls are scripted. Its context helpers are pure and
// are exercised as they really are, since what the workers see depends on them.
vi.mock('../boostManager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../boostManager.js')>(),
  decomposeRequest: vi.fn(),
  synthesizeOutputs: vi.fn(),
}));

vi.mock('../chatExecution.js', () => ({
  tryChatWithFallback: vi.fn(),
  queueProviderOutcome: vi.fn(),
}));

vi.mock('../router.js', () => ({
  selectModels: vi.fn(),
  getWeightsForRequest: vi.fn().mockReturnValue({ cost: 0.4, latency: 0.3, task: 0.3, quality: 0 }),
  getConstraints: vi.fn().mockReturnValue({ minCategorySkill: 0, minReasoning: 0, requireHardCoding: false }),
}));

vi.mock('../complexityEstimator.js', () => ({
  estimateComplexityDetailed: vi.fn().mockReturnValue({ complexity: 0.6, factors: {}, reasoning: 'moderate' }),
}));

vi.mock('../tokens.js', () => ({
  estimateTokensFromMessages: vi.fn().mockReturnValue({ inputTokens: 100, outputTokens: 0 }),
}));

vi.mock('../providers.js', () => ({
  costForModel: vi.fn().mockReturnValue(0.005),
  premiumEstimate: vi.fn().mockReturnValue(0.01),
  savingsEstimate: vi.fn().mockReturnValue(0.005),
}));

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

const messages = [{ role: 'user' as const, content: 'Build a full-stack app with React and Express' }];

const mockModel = {
  id: 'model-1',
  provider: 'openai',
  model_name: 'gpt-4o',
  cost_input: 0.005,
  cost_output: 0.015,
  avg_latency: 1000,
  strengths: ['coding'],
};

describe('runBoostPipeline, happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns BoostResult with boost_details when all sub-tasks succeed', async () => {
    const { decomposeRequest, synthesizeOutputs } = await import('../boostManager.js');
    const { tryChatWithFallback } = await import('../chatExecution.js');
    const { selectModels } = await import('../router.js');

    vi.mocked(decomposeRequest).mockResolvedValue({
      tasks: [
        { id: 'task_1', description: 'Build React frontend', task_type: 'coding', instructions: 'Create components' },
        { id: 'task_2', description: 'Build Express API', task_type: 'coding', instructions: 'Create routes' },
      ],
      reasoning: 'Split into frontend and backend',
      manager: 'openai/gpt-4o',
      cost: 0.003,
      inputTokens: 40,
      outputTokens: 30,
    });

    vi.mocked(selectModels).mockResolvedValue([mockModel as any]);
    vi.mocked(tryChatWithFallback)
      .mockResolvedValueOnce({
        content: 'React component code',
        inputTokens: 200,
        outputTokens: 300,
        model: 'gpt-4o',
        provider: 'openai',
        modelRow: mockModel as any,
        fallbackLevel: 'primary' as const,
      })
      .mockResolvedValueOnce({
        content: 'Express API code',
        inputTokens: 150,
        outputTokens: 250,
        model: 'gpt-4o',
        provider: 'openai',
        modelRow: mockModel as any,
        fallbackLevel: 'primary' as const,
      });

    vi.mocked(synthesizeOutputs).mockResolvedValue({
      output: 'Combined frontend and backend solution',
      latency_ms: 1500,
      cost: 0.008,
      inputTokens: 80,
      outputTokens: 60,
    });

    const result = await runBoostPipeline(
      messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog
    );

    expect(result.output).toBe('Combined frontend and backend solution');
    expect(result.model_used).toBe('ai-model-router-ai');
    expect(result.boost_details.total_tasks).toBe(2);
    expect(result.boost_details.tasks).toHaveLength(2);
    expect(result.boost_details.tasks[0].status).toBe('completed');
    expect(result.boost_details.tasks[1].status).toBe('completed');
    expect(result.boost_details.synthesis_failed).toBeUndefined();
    expect(result.total_cost).toBeCloseTo(0.003 + 0.005 + 0.005 + 0.008, 5);
    expect(result.inputTokens).toBe(470);
    expect(result.outputTokens).toBe(640);
  });

  it('runs sub-tasks in parallel via Promise.all', async () => {
    const { decomposeRequest, synthesizeOutputs } = await import('../boostManager.js');
    const { tryChatWithFallback } = await import('../chatExecution.js');
    const { selectModels } = await import('../router.js');

    let task1Resolved = false;

    vi.mocked(decomposeRequest).mockResolvedValue({
      tasks: [
        { id: 'task_1', description: 'Task 1', task_type: 'coding', instructions: 'Do task 1' },
        { id: 'task_2', description: 'Task 2', task_type: 'writing', instructions: 'Do task 2' },
      ],
      reasoning: 'Two independent tasks',
      manager: 'openai/gpt-4o',
      cost: 0.002,
      inputTokens: 40,
      outputTokens: 30,
    });
    vi.mocked(selectModels).mockResolvedValue([mockModel as any]);
    vi.mocked(tryChatWithFallback)
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 10));
        task1Resolved = true;
        return { content: 'T1', inputTokens: 100, outputTokens: 100, model: 'gpt-4o', provider: 'openai', modelRow: mockModel as any, fallbackLevel: 'primary' as const };
      })
      .mockImplementationOnce(async () => {
        expect(task1Resolved).toBe(false);
        await new Promise((r) => setTimeout(r, 5));
        return { content: 'T2', inputTokens: 100, outputTokens: 100, model: 'gpt-4o', provider: 'openai', modelRow: mockModel as any, fallbackLevel: 'primary' as const };
      });
    vi.mocked(synthesizeOutputs).mockResolvedValue({ output: 'Combined', latency_ms: 500, cost: 0.004, inputTokens: 80, outputTokens: 60 });

    await runBoostPipeline(messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog);

    expect(tryChatWithFallback).toHaveBeenCalledTimes(2);
  });
});

describe('runBoostPipeline, failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks a sub-task as failed when tryChatWithFallback returns null', async () => {
    const { decomposeRequest, synthesizeOutputs } = await import('../boostManager.js');
    const { tryChatWithFallback } = await import('../chatExecution.js');
    const { selectModels } = await import('../router.js');

    vi.mocked(decomposeRequest).mockResolvedValue({
      tasks: [
        { id: 'task_1', description: 'Task A', task_type: 'coding', instructions: 'Do A' },
        { id: 'task_2', description: 'Task B', task_type: 'writing', instructions: 'Do B' },
      ],
      reasoning: 'Two tasks',
      manager: 'openai/gpt-4o',
      cost: 0.002,
      inputTokens: 40,
      outputTokens: 30,
    });
    vi.mocked(selectModels).mockResolvedValue([mockModel as any]);
    vi.mocked(tryChatWithFallback)
      .mockResolvedValueOnce({
        content: 'Task A output', inputTokens: 100, outputTokens: 100,
        model: 'gpt-4o', provider: 'openai', modelRow: mockModel as any, fallbackLevel: 'primary' as const,
      })
      .mockResolvedValueOnce(null);

    vi.mocked(synthesizeOutputs).mockResolvedValue({ output: 'Partial result', latency_ms: 500, cost: 0.004, inputTokens: 80, outputTokens: 60 });

    const result = await runBoostPipeline(
      messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog
    );

    expect(result.boost_details.tasks[0].status).toBe('completed');
    expect(result.boost_details.tasks[1].status).toBe('failed');
    expect(synthesizeOutputs).toHaveBeenCalled();
  });

  it('uses concatenated sub-task outputs when synthesis throws', async () => {
    const { decomposeRequest, synthesizeOutputs } = await import('../boostManager.js');
    const { tryChatWithFallback } = await import('../chatExecution.js');
    const { selectModels } = await import('../router.js');

    vi.mocked(decomposeRequest).mockResolvedValue({
      tasks: [{ id: 'task_1', description: 'Task A', task_type: 'coding', instructions: 'Do A' }],
      reasoning: 'One task',
      manager: 'openai/gpt-4o',
      cost: 0.001,
      inputTokens: 40,
      outputTokens: 30,
    });
    vi.mocked(selectModels).mockResolvedValue([mockModel as any]);
    vi.mocked(tryChatWithFallback).mockResolvedValueOnce({
      content: 'Task A output', inputTokens: 100, outputTokens: 100,
      model: 'gpt-4o', provider: 'openai', modelRow: mockModel as any, fallbackLevel: 'primary' as const,
    });
    vi.mocked(synthesizeOutputs).mockRejectedValueOnce(new Error('Synthesis timed out'));

    const result = await runBoostPipeline(
      messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog
    );

    expect(result.output).toBe('Task A output');
    expect(result.boost_details.synthesis_failed).toBe(true);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('throws when all sub-tasks fail AND synthesis fails', async () => {
    const { decomposeRequest, synthesizeOutputs } = await import('../boostManager.js');
    const { tryChatWithFallback } = await import('../chatExecution.js');
    const { selectModels } = await import('../router.js');

    vi.mocked(decomposeRequest).mockResolvedValue({
      tasks: [{ id: 'task_1', description: 'Task A', task_type: 'coding', instructions: 'Do A' }],
      reasoning: 'One task',
      manager: 'openai/gpt-4o',
      cost: 0.001,
      inputTokens: 40,
      outputTokens: 30,
    });
    vi.mocked(selectModels).mockResolvedValue([mockModel as any]);
    vi.mocked(tryChatWithFallback).mockResolvedValueOnce(null);
    vi.mocked(synthesizeOutputs).mockRejectedValueOnce(new Error('No outputs'));

    await expect(
      runBoostPipeline(messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog)
    ).rejects.toThrow('All sub-tasks and synthesis failed');
  });

  it('propagates decomposeRequest failure (caller handles fallback)', async () => {
    const { decomposeRequest } = await import('../boostManager.js');

    vi.mocked(decomposeRequest).mockRejectedValueOnce(
      new Error('Manager decompose response was not valid JSON')
    );

    await expect(
      runBoostPipeline(messages, 'coding', 0.75, 'balanced', 'normal', 'ai-model-router-ai', ['openai'], mockLog)
    ).rejects.toThrow('Manager decompose response was not valid JSON');
  });
});
