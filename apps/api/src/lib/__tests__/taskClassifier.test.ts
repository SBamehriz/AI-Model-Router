import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyTaskHeuristic,
  classifyTaskHeuristicWithConfidence,
  classifyWithLLM,
  classifyTaskAsync,
  type TaskType,
} from '../taskClassifier.js';

// Classifier HTTP stub
// The classifier calls the OpenAI chat endpoint with plain fetch. Tests queue
// completion payloads on `mockCreate`. A rejection simulates a transport error.
const mockCreate = vi.fn();

beforeEach(() => {
  vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '0');
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    const payload = await mockCreate(...args);
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('never calls the classifier in forced offline mode even with a configured key', async () => {
  vi.stubEnv('AI_MODEL_ROUTER_OFFLINE', '1');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  // No call was ever going to happen, so the keywords are the classification.
  expect((await classifyWithLLM(msgs('Hello there'))).method).toBe('heuristic');
  expect((await classifyTaskAsync(msgs('Hello there'))).method).toBe('heuristic');
  expect(fetchSpy).not.toHaveBeenCalled();
});

function msgs(content: string) {
  return [{ role: 'user', content }];
}

// Valid task types for runtime checks
const VALID_TYPES: TaskType[] = [
  'chat', 'coding', 'debugging', 'reasoning', 'math_reasoning',
  'writing', 'email', 'summarization', 'translation',
  'data_analysis', 'planning', 'customer_support',
  'image', 'agent_step',
];

// classifyTaskHeuristic
describe('classifyTaskHeuristic', () => {
  it('detects debugging tasks', () => {
    expect(classifyTaskHeuristic(msgs('Fix this bug in my code'))).toBe('debugging');
    expect(classifyTaskHeuristic(msgs('I have an error: TypeError cannot read property'))).toBe('debugging');
    expect(classifyTaskHeuristic(msgs('Debug this stack trace'))).toBe('debugging');
    expect(classifyTaskHeuristic(msgs('My app crashes with an exception'))).toBe('debugging');
  });

  it('detects coding tasks', () => {
    expect(classifyTaskHeuristic(msgs('Write a function to sort arrays'))).toBe('coding');
    expect(classifyTaskHeuristic(msgs('import React from react'))).toBe('coding');
    expect(classifyTaskHeuristic(msgs('const x = 5'))).toBe('coding');
    expect(classifyTaskHeuristic(msgs('Create a class for users'))).toBe('coding');
    expect(classifyTaskHeuristic(msgs('Use async await to fetch data'))).toBe('coding');
    expect(classifyTaskHeuristic(msgs('Implement a binary search algorithm'))).toBe('coding');
  });

  it('detects math_reasoning tasks', () => {
    expect(classifyTaskHeuristic(msgs('Solve this integral of x^2 dx'))).toBe('math_reasoning');
    expect(classifyTaskHeuristic(msgs('Prove this theorem using induction'))).toBe('math_reasoning');
    expect(classifyTaskHeuristic(msgs('Calculate the probability of drawing two aces'))).toBe('math_reasoning');
    expect(classifyTaskHeuristic(msgs('Find the derivative of f(x) = 3x^2'))).toBe('math_reasoning');
  });

  it('detects data_analysis tasks', () => {
    expect(classifyTaskHeuristic(msgs('Analyze this CSV dataset for trends'))).toBe('data_analysis');
    expect(classifyTaskHeuristic(msgs('Create a visualization of sales data'))).toBe('data_analysis');
    expect(classifyTaskHeuristic(msgs('Run a regression on this data'))).toBe('data_analysis');
    expect(classifyTaskHeuristic(msgs('Plot a histogram of the results'))).toBe('data_analysis');
  });

  it('detects planning tasks', () => {
    expect(classifyTaskHeuristic(msgs('Create a roadmap for our product launch'))).toBe('planning');
    expect(classifyTaskHeuristic(msgs('Help me plan my sprint backlog'))).toBe('planning');
    expect(classifyTaskHeuristic(msgs('Build a project timeline with milestones'))).toBe('planning');
  });

  it('detects email tasks', () => {
    expect(classifyTaskHeuristic(msgs('Write an email to my boss about vacation'))).toBe('email');
    expect(classifyTaskHeuristic(msgs('Draft a mail to the client with regards'))).toBe('email');
    expect(classifyTaskHeuristic(msgs('Compose an email with subject line: Meeting'))).toBe('email');
  });

  it('detects writing tasks', () => {
    expect(classifyTaskHeuristic(msgs('Write a blog post about AI trends'))).toBe('writing');
    expect(classifyTaskHeuristic(msgs('Help me draft an article on climate change'))).toBe('writing');
    expect(classifyTaskHeuristic(msgs('Write a short story about a robot'))).toBe('writing');
    expect(classifyTaskHeuristic(msgs('Rewrite this paragraph to be more professional'))).toBe('writing');
  });

  it('detects customer_support tasks', () => {
    expect(classifyTaskHeuristic(msgs('Help me respond to a customer complaint about a refund'))).toBe('customer_support');
    expect(classifyTaskHeuristic(msgs('Answer this FAQ about our return policy'))).toBe('customer_support');
  });

  it('detects reasoning tasks', () => {
    expect(classifyTaskHeuristic(msgs('Think through why this approach is better'))).toBe('reasoning');
    expect(classifyTaskHeuristic(msgs('Compare and evaluate these two options'))).toBe('reasoning');
  });

  it('detects summarization tasks', () => {
    expect(classifyTaskHeuristic(msgs('Summarize this article'))).toBe('summarization');
    expect(classifyTaskHeuristic(msgs('Give me a brief overview'))).toBe('summarization');
    expect(classifyTaskHeuristic(msgs('TL;DR of this document'))).toBe('summarization');
    expect(classifyTaskHeuristic(msgs('Create an outline of this text'))).toBe('summarization');
  });

  it('detects translation tasks', () => {
    expect(classifyTaskHeuristic(msgs('Translate this to French'))).toBe('translation');
  });

  it('detects image tasks', () => {
    expect(classifyTaskHeuristic(msgs('Generate an image of a cat'))).toBe('image');
    expect(classifyTaskHeuristic(msgs('Draw a picture of mountains'))).toBe('image');
  });

  it('defaults to chat for ambiguous input', () => {
    expect(classifyTaskHeuristic(msgs('Hello, how are you?'))).toBe('chat');
    expect(classifyTaskHeuristic(msgs('What is the capital of France?'))).toBe('chat');
    expect(classifyTaskHeuristic(msgs('Tell me a joke'))).toBe('chat');
  });

  it('handles empty messages', () => {
    expect(classifyTaskHeuristic([])).toBe('chat');
    expect(classifyTaskHeuristic([{ role: 'user', content: '' }])).toBe('chat');
  });

  it('handles multimodal content arrays', () => {
    const result = classifyTaskHeuristic([
      { role: 'user', content: [{ type: 'text', text: 'Write a function' }] as unknown },
    ]);
    expect(result).toBe('coding');
  });
});

// classifyWithLLM
describe('classifyWithLLM', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('returns LLM classification on success', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "coding", "confidence": 0.95, "reasoning": "User wants code"}',
          },
        },
      ],
    });

    const result = await classifyWithLLM(msgs('Build me an API'));
    expect(result.taskType).toBe('coding');
    expect(result.confidence).toBe(0.95);
    expect(result.method).toBe('llm');
    expect(result.reasoning).toBe('User wants code');
  });

  it('handles markdown-wrapped JSON response', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '```json\n{"taskType": "summarization", "confidence": 0.9, "reasoning": "Summarize request"}\n```',
          },
        },
      ],
    });

    const result = await classifyWithLLM(msgs('Summarize this'));
    expect(result.taskType).toBe('summarization');
    expect(result.method).toBe('llm');
  });

  it('falls back to heuristic on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));

    const mockLog = { warn: vi.fn() };
    const result = await classifyWithLLM(msgs('Hello there'), mockLog);
    expect(result.method).toBe('fallback');
    // The keyword confidence is reported, not a stand-in value.
    expect(result.confidence).toBe(classifyTaskHeuristicWithConfidence(msgs('Hello there')).confidence);
    expect(result.reasoning).toContain('API timeout');
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('falls back to heuristic when LLM returns invalid task type', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "unknown_type", "confidence": 0.9, "reasoning": "test"}',
          },
        },
      ],
    });

    const result = await classifyWithLLM(msgs('Hello'));
    expect(result.method).toBe('fallback');
    expect(VALID_TYPES).toContain(result.taskType);
  });

  it('falls back to heuristic when LLM returns invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'not json at all' } }],
    });

    const result = await classifyWithLLM(msgs('Hello'));
    expect(result.method).toBe('fallback');
    expect(result.reasoning).toContain('Failed to parse');
  });

  it('falls back when no API key is configured', async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await classifyWithLLM(msgs('Hello'));
    expect(result.method).toBe('heuristic');
    expect(result.reasoning).toContain('no OpenAI key is configured');
  });

  it('falls back when message is empty', async () => {
    const result = await classifyWithLLM([{ role: 'user', content: '' }]);
    expect(result.method).toBe('heuristic');
    expect(result.reasoning).toContain('no user text');
  });

  it('clamps confidence to 0-1 range', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "coding", "confidence": 5.0, "reasoning": "test"}',
          },
        },
      ],
    });

    const result = await classifyWithLLM(msgs('Write code'));
    expect(result.confidence).toBe(1.0);
  });

  it('defaults confidence to 0.7 when missing', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "coding", "reasoning": "test"}',
          },
        },
      ],
    });

    const result = await classifyWithLLM(msgs('Write code'));
    expect(result.confidence).toBe(0.7);
  });
});

// classifyTaskAsync (hybrid)
describe('classifyTaskAsync', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('uses heuristic for coding (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Write a Python function'));
    expect(result.taskType).toBe('coding');
    expect(result.method).toBe('heuristic');
    // A clear coding prompt must clear the escalation threshold. The exact value
    // moves whenever patterns are added, so assert the property that matters.
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses heuristic for summarization (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Summarize this text'));
    expect(result.taskType).toBe('summarization');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses heuristic for translation (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Translate this to Spanish'));
    expect(result.taskType).toBe('translation');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses heuristic for image (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Generate an image of a sunset'));
    expect(result.taskType).toBe('image');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls LLM for chat (ambiguous type)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "chat", "confidence": 0.8, "reasoning": "General question"}',
          },
        },
      ],
    });

    const result = await classifyTaskAsync(msgs('What is the weather today?'));
    expect(result.method).toBe('llm');
    expect(mockCreate).toHaveBeenCalled();
  });

  it('calls LLM for reasoning (ambiguous type)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "reasoning", "confidence": 0.9, "reasoning": "Logic problem"}',
          },
        },
      ],
    });

    const result = await classifyTaskAsync(msgs('Explain why this happens'));
    expect(mockCreate).toHaveBeenCalled();
    expect(result.method).toBe('llm');
  });

  it('uses heuristic for strong writing match (poem)', async () => {
    const result = await classifyTaskAsync(msgs('Write a poem about the ocean'));
    expect(result.taskType).toBe('writing');
    expect(result.method).toBe('heuristic');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls LLM for low-confidence writing (ambiguous)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '{"taskType": "writing", "confidence": 0.85, "reasoning": "Creative writing request"}',
          },
        },
      ],
    });

    // A weak writing match, which is not confident enough on its own.
    const result = await classifyTaskAsync(msgs('draft something nice for me'));
    expect(mockCreate).toHaveBeenCalled();
    expect(result.method).toBe('llm');
  });

  it('uses heuristic for debugging (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Fix this bug: TypeError cannot read'));
    expect(result.taskType).toBe('debugging');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses heuristic for math_reasoning (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Calculate the integral of x^2'));
    expect(result.taskType).toBe('math_reasoning');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('uses heuristic for data_analysis (unambiguous)', async () => {
    const result = await classifyTaskAsync(msgs('Analyze this CSV dataset'));
    expect(result.taskType).toBe('data_analysis');
    expect(result.method).toBe('heuristic');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls back gracefully when LLM fails for ambiguous type', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Network error'));

    const result = await classifyTaskAsync(msgs('Hello there'));
    expect(result.method).toBe('fallback');
    expect(result.taskType).toBe('chat');
  });
});

// Multi-turn conversations
describe('Multi-turn conversations', () => {
  it('classifies based on last message', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'Write a function to sort an array' },
    ];
    expect(classifyTaskHeuristic(messages)).toBe('coding');
  });

  it('ignores earlier messages for classification', () => {
    const messages = [
      { role: 'user', content: 'Write code for me' },
      { role: 'assistant', content: 'Sure, here is code...' },
      { role: 'user', content: 'Translate that to French' },
    ];
    expect(classifyTaskHeuristic(messages)).toBe('translation');
  });

  it('uses the latest user message even when assistant speaks last', () => {
    const messages = [
      { role: 'user', content: 'Write code for me' },
      { role: 'assistant', content: 'Sure, here is code...' },
      { role: 'user', content: 'Translate that to French' },
      { role: 'assistant', content: 'Sure, here is the translation...' },
    ];
    expect(classifyTaskHeuristic(messages)).toBe('translation');
  });
});

// classifyTaskHeuristicWithConfidence
describe('classifyTaskHeuristicWithConfidence', () => {
  it('returns high confidence for strong pattern matches', () => {
    const result = classifyTaskHeuristicWithConfidence(msgs('Write a function to sort arrays'));
    expect(result.taskType).toBe('coding');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('returns lower confidence for weak-only matches', () => {
    const result = classifyTaskHeuristicWithConfidence(msgs('tell me about this code'));
    expect(result.taskType).toBe('coding');
    expect(result.confidence).toBeLessThan(0.85);
  });

  it('returns low confidence for no matches (chat fallback)', () => {
    const result = classifyTaskHeuristicWithConfidence(msgs('Hello'));
    expect(result.taskType).toBe('chat');
    expect(result.confidence).toBe(0.3);
  });

  it('boosts confidence with multiple pattern matches', () => {
    const single = classifyTaskHeuristicWithConfidence(msgs('Fix this bug'));
    const multiple = classifyTaskHeuristicWithConfidence(msgs('Fix this bug, I see a TypeError stack trace and exception'));
    expect(multiple.confidence).toBeGreaterThan(single.confidence);
  });

  it('returns same taskType as classifyTaskHeuristic', () => {
    const inputs = [
      'Write code', 'Fix this bug', 'Summarize this', 'Hello there',
      'Translate to French', 'Create a roadmap', 'Analyze this CSV',
    ];
    for (const input of inputs) {
      const withConf = classifyTaskHeuristicWithConfidence(msgs(input));
      const plain = classifyTaskHeuristic(msgs(input));
      expect(withConf.taskType).toBe(plain);
    }
  });
});

// classifyTaskAsync threshold behavior
describe('classifyTaskAsync threshold behavior', () => {
  const originalEnv = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('skips LLM when heuristic confidence >= 0.7', async () => {
    // "Fix this bug" is a strong debugging match, so confidence is high.
    const result = await classifyTaskAsync(msgs('Fix this bug in my code'));
    expect(result.method).toBe('heuristic');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls LLM when heuristic confidence < 0.7', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"taskType": "chat", "confidence": 0.8, "reasoning": "test"}' } }],
    });

    // "Hello" matches no pattern, so confidence stays at 0.3.
    const result = await classifyTaskAsync(msgs('Hello there friend'));
    expect(mockCreate).toHaveBeenCalled();
    expect(result).toMatchObject({ taskType: 'chat', method: 'llm' });
  });

  it('includes confidence in heuristic reasoning', async () => {
    const result = await classifyTaskAsync(msgs('Summarize this article'));
    expect(result.method).toBe('heuristic');
    expect(result.reasoning).toContain('confidence');
  });
});

// ClassificationResult structure
describe('ClassificationResult structure', () => {
  it('has all required fields from heuristic path', async () => {
    const result = await classifyTaskAsync(msgs('Write code'));
    expect(result).toHaveProperty('taskType');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('reasoning');
    expect(result).toHaveProperty('method');
    expect(typeof result.taskType).toBe('string');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.reasoning).toBe('string');
    expect(['heuristic', 'llm', 'fallback', 'cache']).toContain(result.method);
  });
});

describe('classifier regressions', () => {
  const ask = (content: string) => classifyTaskHeuristic([{ role: 'user', content }]);

  it('treats an authoring verb next to a code noun as coding, not writing', () => {
    expect(ask('Write a Python quicksort')).toBe('coding');
    expect(ask('Write a function that debounces callbacks')).toBe('coding');
    expect(ask('Create a CLI that renames files')).toBe('coding');
    expect(ask('Build a regex for email addresses')).toBe('coding');
  });

  it('recognises a language named after "in"/"using"/"with"', () => {
    expect(ask('Sort a list in Python')).toBe('coding');
    expect(ask('Do this using TypeScript')).toBe('coding');
  });

  it('still classifies prose requests as writing', () => {
    expect(ask('Write a blog post about remote work')).toBe('writing');
    expect(ask('Draft a short story about a lighthouse')).toBe('writing');
  });

  it('accepts British spellings', () => {
    expect(ask('Summarise this article in two sentences')).toBe('summarization');
    expect(ask('Summarize this article in two sentences')).toBe('summarization');
  });
});
