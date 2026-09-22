import type { TaskType } from './taskClassifier.js';
import { textFromContent } from './messages.js';

// --- Types ---

export interface ComplexityFactors {
  lengthScore: number;      // 0-1 based on word count
  constraintScore: number;  // 0-1 based on requirements count
  hardnessScore: number;    // 0-1 based on technical keywords
  taskBaseline: number;     // Minimum complexity for task type
}

export interface ComplexityResult {
  complexity: number;       // Final 0-1 complexity score
  factors: ComplexityFactors;
  reasoning: string;        // Human-readable explanation
}

// --- Constants ---

/** The floor for each task type. Some work is never trivial. */
const TASK_BASELINES: Record<TaskType, number> = {
  coding: 0.45,
  debugging: 0.45,
  math_reasoning: 0.50,
  reasoning: 0.40,
  data_analysis: 0.40,
  planning: 0.35,
  agent_step: 0.35,
  writing: 0.30,
  image: 0.30,
  translation: 0.25,
  email: 0.20,
  summarization: 0.20,
  customer_support: 0.15,
  chat: 0.15,
};

/** Markers that the request is imposing requirements. */
const CONSTRAINT_PATTERNS: RegExp[] = [
  /\bmust\b/gi,
  /\bshould\b/gi,
  /\bneed to\b/gi,
  /\brequirements?\b/gi,
  /\bconstraints?\b/gi,
  /\bdon['']t\b/gi,
  /\bdo not\b/gi,
  /\binclude\b/gi,
  /\bexclude\b/gi,
  /\bedge cases?\b/gi,
  /\bmake sure\b/gi,
  /\bensure\b/gi,
  /\bat least\b/gi,
  /\bat most\b/gi,
  /\bno more than\b/gi,
];

/** Words that signal technically demanding work. */
const HARD_KEYWORDS: string[] = [
  'optimize', 'prove', 'formal', 'production', 'scalable',
  'secure', 'architecture', 'distributed', 'benchmark',
  'algorithm', 'performance', 'concurrent', 'async',
  'multi-threaded', 'consensus', 'cryptograph', 'compiler',
  'database', 'infrastructure', 'microservice', 'deploy',
  'kubernetes', 'docker', 'ci/cd', 'pipeline',
  'machine learning', 'neural', 'deep learning',
  'type system', 'generic', 'polymorphi', 'recursion',
];

// --- Helpers ---

/** All message text as one string. */
function extractText(messages: Array<{ role?: string; content?: unknown }>): string {
  return messages.map((m) => textFromContent(m.content)).join(' ');
}

/**
 * Length on an exponential curve. Around 150 words scores about 0.63, and
 * around 350 words about 0.90.
 */
function scoreLengthComponent(text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return 1.0 - Math.exp(-wordCount / 150);
}

/**
 * Saturates at five. Once a request has stated five requirements, more of them
 * say little extra about how hard it is.
 */
function scoreConstraintComponent(text: string): number {
  let count = 0;
  for (const pattern of CONSTRAINT_PATTERNS) {
    // Reset regex state (global flag)
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }
  return Math.min(count / 5, 1.0);
}

/**
 * Saturates at three markers. Distributed, concurrent and production together
 * already describe a hard problem.
 */
function scoreHardnessComponent(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const keyword of HARD_KEYWORDS) {
    if (lower.includes(keyword)) count++;
  }
  return Math.min(count / 3, 1.0);
}

// --- Public API ---

/** Difficulty on a 0 to 1 scale. */
export function estimateComplexity(
  messages: Array<{ role?: string; content?: unknown }>,
  taskType: TaskType
): number {
  return estimateComplexityDetailed(messages, taskType).complexity;
}

/** The same score with the factors behind it, for the routing explanation. */
export function estimateComplexityDetailed(
  messages: Array<{ role?: string; content?: unknown }>,
  taskType: TaskType
): ComplexityResult {
  const text = extractText(messages);

  const lengthScore = scoreLengthComponent(text);
  const constraintScore = scoreConstraintComponent(text);
  const hardnessScore = scoreHardnessComponent(text);
  const taskBaseline = TASK_BASELINES[taskType] ?? 0.35;

  // Two readings of the same evidence, and the score is the stronger one.
  // `combined` rewards a request that is long, demanding and technical at once.
  // `intrinsic` ignores length, because length says how much someone wrote, not
  // how hard the work is. A terse but demanding request would otherwise sit at
  // its task baseline while a rambling trivial one scored higher.
  const combined = 0.3 * lengthScore + 0.35 * constraintScore + 0.35 * hardnessScore;
  const intrinsic = 0.55 * hardnessScore + 0.45 * constraintScore;

  // The task baseline is a floor: some kinds of work are never trivial.
  const strongest = Math.max(taskBaseline, combined, intrinsic);
  const complexity = Math.min(1, Math.max(0, strongest));

  // Build a human-readable reasoning string
  const parts: string[] = [];
  parts.push(`task=${taskType} (baseline ${taskBaseline.toFixed(2)})`);
  parts.push(`length=${lengthScore.toFixed(2)}`);
  parts.push(`constraints=${constraintScore.toFixed(2)}`);
  parts.push(`hardness=${hardnessScore.toFixed(2)}`);
  // Name which reading won, so the debug endpoint explains the number.
  const source =
    strongest === taskBaseline
      ? 'baseline'
      : intrinsic >= combined
        ? 'difficulty markers'
        : 'length and requirements';
  parts.push(`decided by ${source}: ${complexity.toFixed(2)}`);

  return {
    complexity,
    factors: {
      lengthScore,
      constraintScore,
      hardnessScore,
      taskBaseline,
    },
    reasoning: parts.join(', '),
  };
}
