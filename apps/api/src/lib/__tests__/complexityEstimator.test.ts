import { describe, it, expect } from 'vitest';
import {
  estimateComplexity,
  estimateComplexityDetailed,
} from '../complexityEstimator.js';

// Helper to build a simple user message array
function msgs(content: string) {
  return [{ role: 'user', content }];
}

// Trivial tasks (complexity < 0.3)
describe('Trivial tasks (complexity < 0.3)', () => {
  it('returns low complexity for a simple greeting', () => {
    const c = estimateComplexity(msgs('Hi there!'), 'chat');
    expect(c).toBeLessThan(0.3);
  });

  it('returns low complexity for a short summarization request', () => {
    const c = estimateComplexity(msgs('Summarize this in one sentence.'), 'summarization');
    expect(c).toBeLessThan(0.35);
  });

  it('returns low complexity for a basic translation', () => {
    const c = estimateComplexity(msgs('Translate "hello" to French.'), 'translation');
    expect(c).toBeLessThan(0.35);
  });

  it('never goes below the task baseline for chat', () => {
    const c = estimateComplexity(msgs('ok'), 'chat');
    expect(c).toBeGreaterThanOrEqual(0.15);
  });
});

// Moderate tasks (complexity 0.3-0.7)
describe('Moderate tasks (complexity 0.3-0.7)', () => {
  it('returns moderate complexity for a coding task with some constraints', () => {
    const c = estimateComplexity(
      msgs('Write a function that sorts an array. It must handle edge cases and should be efficient.'),
      'coding'
    );
    expect(c).toBeGreaterThanOrEqual(0.3);
    expect(c).toBeLessThanOrEqual(0.75);
  });

  it('returns moderate complexity for a reasoning task', () => {
    const c = estimateComplexity(
      msgs('Explain why bubble sort is O(n^2) and prove the lower bound for comparison sorts.'),
      'reasoning'
    );
    expect(c).toBeGreaterThanOrEqual(0.4);
    expect(c).toBeLessThanOrEqual(0.8);
  });

  it('returns at least the coding baseline for simple code request', () => {
    const c = estimateComplexity(msgs('Write hello world in Python'), 'coding');
    expect(c).toBeGreaterThanOrEqual(0.45);
  });
});

// Complex tasks (complexity > 0.7)
describe('Complex tasks (complexity > 0.7)', () => {
  it('returns high complexity for a production architecture request', () => {
    const c = estimateComplexity(
      msgs(
        'Build a distributed consensus algorithm with formal proof of correctness. ' +
        'It must be scalable, production-ready, and support concurrent operations. ' +
        'Include comprehensive benchmarks and ensure the architecture handles edge cases. ' +
        'The algorithm should be optimized for performance and deploy easily with Docker and Kubernetes. ' +
        'You must not use any third-party consensus libraries. Do not skip error handling. ' +
        'Make sure the implementation supports at least 100 nodes. Ensure fault tolerance for up to 33% failures. ' +
        'The system must handle network partitions gracefully and include a formal proof of safety and liveness. ' +
        'Requirements: write unit tests, integration tests, and include deployment infrastructure. ' +
        'Constraints: must compile on Linux and macOS, should support ARM64, need to have CI/CD pipeline.'
      ),
      'coding'
    );
    expect(c).toBeGreaterThan(0.7);
  });

  it('returns high complexity for multi-constraint reasoning', () => {
    const c = estimateComplexity(
      msgs(
        'Prove that the halting problem is undecidable using a formal proof by contradiction. ' +
        'You must define the problem precisely, include all edge cases, and ensure logical rigor. ' +
        'Do not use informal arguments. Make sure every step is justified. ' +
        'Requirements: the proof must be self-contained and not rely on external references. ' +
        'You should include a discussion of Turing machines and the diagonal argument. ' +
        'Ensure the proof covers both the positive and negative cases. ' +
        'Do not skip the construction of the contradiction machine. ' +
        'Include at least three lemmas as prerequisites to the main theorem.'
      ),
      'reasoning'
    );
    expect(c).toBeGreaterThan(0.6);
  });
});

// Task baseline enforcement
describe('Task baseline enforcement', () => {
  const shortMsg = msgs('do it');

  it('enforces math_reasoning baseline (0.50)', () => {
    const c = estimateComplexity(shortMsg, 'math_reasoning');
    expect(c).toBeGreaterThanOrEqual(0.50);
  });

  it('enforces coding baseline (0.45)', () => {
    const c = estimateComplexity(shortMsg, 'coding');
    expect(c).toBeGreaterThanOrEqual(0.45);
  });

  it('enforces debugging baseline (0.45)', () => {
    const c = estimateComplexity(shortMsg, 'debugging');
    expect(c).toBeGreaterThanOrEqual(0.45);
  });

  it('enforces reasoning baseline (0.40)', () => {
    const c = estimateComplexity(shortMsg, 'reasoning');
    expect(c).toBeGreaterThanOrEqual(0.40);
  });

  it('enforces data_analysis baseline (0.40)', () => {
    const c = estimateComplexity(shortMsg, 'data_analysis');
    expect(c).toBeGreaterThanOrEqual(0.40);
  });

  it('enforces planning baseline (0.35)', () => {
    const c = estimateComplexity(shortMsg, 'planning');
    expect(c).toBeGreaterThanOrEqual(0.35);
  });

  it('enforces agent_step baseline (0.35)', () => {
    const c = estimateComplexity(shortMsg, 'agent_step');
    expect(c).toBeGreaterThanOrEqual(0.35);
  });

  it('enforces writing baseline (0.30)', () => {
    const c = estimateComplexity(shortMsg, 'writing');
    expect(c).toBeGreaterThanOrEqual(0.30);
  });

  it('enforces image baseline (0.30)', () => {
    const c = estimateComplexity(shortMsg, 'image');
    expect(c).toBeGreaterThanOrEqual(0.30);
  });

  it('enforces translation baseline (0.25)', () => {
    const c = estimateComplexity(shortMsg, 'translation');
    expect(c).toBeGreaterThanOrEqual(0.25);
  });

  it('enforces email baseline (0.20)', () => {
    const c = estimateComplexity(shortMsg, 'email');
    expect(c).toBeGreaterThanOrEqual(0.20);
  });

  it('enforces summarization baseline (0.20)', () => {
    const c = estimateComplexity(shortMsg, 'summarization');
    expect(c).toBeGreaterThanOrEqual(0.20);
  });

  it('enforces customer_support baseline (0.15)', () => {
    const c = estimateComplexity(shortMsg, 'customer_support');
    expect(c).toBeGreaterThanOrEqual(0.15);
  });

  it('enforces chat baseline (0.15)', () => {
    const c = estimateComplexity(shortMsg, 'chat');
    expect(c).toBeGreaterThanOrEqual(0.15);
  });
});

// Detailed output
describe('estimateComplexityDetailed()', () => {
  it('returns all factor fields', () => {
    const result = estimateComplexityDetailed(
      msgs('Write a secure production API with Docker deployment'),
      'coding'
    );

    expect(result).toHaveProperty('complexity');
    expect(result).toHaveProperty('factors');
    expect(result).toHaveProperty('reasoning');

    expect(result.factors).toHaveProperty('lengthScore');
    expect(result.factors).toHaveProperty('constraintScore');
    expect(result.factors).toHaveProperty('hardnessScore');
    expect(result.factors).toHaveProperty('taskBaseline');
  });

  it('has all factors in 0-1 range', () => {
    const result = estimateComplexityDetailed(
      msgs('Optimize a distributed concurrent algorithm with formal proof and benchmarks'),
      'coding'
    );

    expect(result.factors.lengthScore).toBeGreaterThanOrEqual(0);
    expect(result.factors.lengthScore).toBeLessThanOrEqual(1);
    expect(result.factors.constraintScore).toBeGreaterThanOrEqual(0);
    expect(result.factors.constraintScore).toBeLessThanOrEqual(1);
    expect(result.factors.hardnessScore).toBeGreaterThanOrEqual(0);
    expect(result.factors.hardnessScore).toBeLessThanOrEqual(1);
    expect(result.factors.taskBaseline).toBeGreaterThanOrEqual(0);
    expect(result.factors.taskBaseline).toBeLessThanOrEqual(1);
    expect(result.complexity).toBeGreaterThanOrEqual(0);
    expect(result.complexity).toBeLessThanOrEqual(1);
  });

  it('produces a human-readable reasoning string', () => {
    const result = estimateComplexityDetailed(msgs('Hello'), 'chat');
    expect(result.reasoning).toContain('task=chat');
    expect(result.reasoning).toContain('baseline');
    expect(result.reasoning).toContain('length=');
    expect(result.reasoning).toContain('constraints=');
    expect(result.reasoning).toContain('hardness=');
  });

  it('names the reading that produced the score', () => {
    expect(estimateComplexityDetailed(msgs('Hello'), 'chat').reasoning).toContain('baseline');
    expect(
      estimateComplexityDetailed(msgs('Make it distributed, concurrent and production ready'), 'chat').reasoning
    ).toContain('difficulty markers');
  });
});

// Edge cases
describe('Edge cases', () => {
  it('handles empty messages array', () => {
    const c = estimateComplexity([], 'chat');
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('handles messages with empty content', () => {
    const c = estimateComplexity([{ role: 'user', content: '' }], 'chat');
    expect(c).toBeGreaterThanOrEqual(0.15); // At least baseline
  });

  it('handles messages with array content (multimodal)', () => {
    const c = estimateComplexity(
      [{ role: 'user', content: [{ type: 'text', text: 'Write production code' }] as unknown }],
      'coding'
    );
    expect(c).toBeGreaterThanOrEqual(0.45);
  });

  it('handles multi-turn conversations', () => {
    const singleTurn = estimateComplexity(msgs('Write a sort function'), 'coding');
    const multiTurn = estimateComplexity(
      [
        { role: 'user', content: 'Write a sort function that must handle large datasets efficiently' },
        { role: 'assistant', content: 'Here is a bubble sort implementation...' },
        { role: 'user', content: 'Now optimize it for performance and make sure it handles edge cases with concurrent access. You should use a production-grade algorithm. Do not use bubble sort.' },
      ],
      'coding'
    );
    expect(multiTurn).toBeGreaterThan(singleTurn);
  });

  it('consistency: same input always produces same output', () => {
    const a = estimateComplexity(msgs('Build a REST API'), 'coding');
    const b = estimateComplexity(msgs('Build a REST API'), 'coding');
    expect(a).toBe(b);
  });
});

// Constraint detection
describe('Constraint detection', () => {
  it('detects "must" and "should" constraints', () => {
    const without = estimateComplexityDetailed(msgs('Write a function'), 'coding');
    const with_ = estimateComplexityDetailed(
      msgs('Write a function. It must be fast. It should handle nulls. You must not use loops.'),
      'coding'
    );
    expect(with_.factors.constraintScore).toBeGreaterThan(without.factors.constraintScore);
  });

  it('detects "edge cases" and "requirements"', () => {
    const result = estimateComplexityDetailed(
      msgs('Handle all edge cases and meet the requirements'),
      'coding'
    );
    expect(result.factors.constraintScore).toBeGreaterThan(0);
  });
});

// Hardness detection
describe('Hardness detection', () => {
  it('detects technical keywords like optimize, distributed, algorithm', () => {
    const simple = estimateComplexityDetailed(msgs('Write hello world'), 'coding');
    const hard = estimateComplexityDetailed(
      msgs('Optimize a distributed algorithm for concurrent performance'),
      'coding'
    );
    expect(hard.factors.hardnessScore).toBeGreaterThan(simple.factors.hardnessScore);
  });

  it('caps hardness at 1.0 even with many keywords', () => {
    const result = estimateComplexityDetailed(
      msgs(
        'optimize distributed algorithm concurrent performance scalable ' +
        'production secure benchmark architecture compiler'
      ),
      'coding'
    );
    expect(result.factors.hardnessScore).toBeLessThanOrEqual(1.0);
  });
});

describe('difficulty vs. verbosity', () => {
  const ask = (content: string) => estimateComplexityDetailed([{ role: 'user', content }], 'coding');

  /**
   * The point of these: length measures how much someone wrote, not how hard
   * the work is. A terse but genuinely hard request has to outscore a long,
   * easy one, or the constraint tiers that protect hard tasks never engage.
   */
  it('rates a short but technically hard request above its task baseline', () => {
    const hard = ask(
      'Refactor this module for concurrent access: production ready, distributed, with benchmarks.'
    );

    expect(hard.complexity).toBeGreaterThan(0.5);
    expect(hard.factors.hardnessScore).toBeGreaterThan(0.5);
  });

  it('rates a long but undemanding request no higher than a short hard one', () => {
    const rambling = ask(
      'So I was thinking about this thing we discussed the other day, and I wondered whether ' +
        'you could take a look at it when you have a moment, because it has been on my mind ' +
        'for a while now and I keep going back and forth about the best way to approach it, ' +
        'and honestly I would value a second opinion on the whole thing before I commit to ' +
        'anything, since it is the kind of decision that is annoying to unwind afterwards.'
    );
    const terse = ask('Make this scalable, secure and production ready under concurrent load.');

    expect(terse.complexity).toBeGreaterThan(rambling.complexity);
  });

  it('reaches the hard-coding tier for a request that is both long and hard', () => {
    const hard = ask(
      'Design a distributed consensus protocol. It must prove safety and liveness formally, ' +
        'handle network partitions, clock skew and node restarts, include a production-ready ' +
        'implementation with benchmarks, and cover every edge case in the test suite. Do not ' +
        'assume a synchronous network. The architecture should be scalable and secure, and the ' +
        'implementation must be concurrent and performant under load.'
    );

    expect(hard.complexity).toBeGreaterThanOrEqual(0.7);
  });

  it('leaves a plainly simple request at its baseline', () => {
    expect(ask('Write a Python quicksort').complexity).toBeCloseTo(0.45, 2);
  });
});
