/**
 * Task classification: keyword patterns first, a cheap model only for the
 * prompts they cannot settle. Escalating every request would add a charge to
 * prompts the keywords already answer, so confidence decides.
 */
import crypto from 'node:crypto';
import { credentialForEnvironment } from './credentials.js';
import { isOfflineMode } from './providerAvailability.js';
import { textFromContent } from './messages.js';

export type TaskType =
  | 'chat'
  | 'coding'
  | 'debugging'
  | 'reasoning'
  | 'math_reasoning'
  | 'writing'
  | 'email'
  | 'summarization'
  | 'translation'
  | 'data_analysis'
  | 'planning'
  | 'customer_support'
  | 'image'
  | 'agent_step';

export interface ClassificationResult {
  taskType: TaskType;
  confidence: number;      // 0-1 confidence score
  reasoning: string;       // Why this classification
  method: 'heuristic' | 'llm' | 'fallback' | 'cache';
}

// --- Internals ---

/** Valid task types for runtime validation of LLM output. */
const VALID_TASK_TYPES: Set<string> = new Set<string>([
  'chat', 'coding', 'debugging', 'reasoning', 'math_reasoning',
  'writing', 'email', 'summarization', 'translation',
  'data_analysis', 'planning', 'customer_support',
  'image', 'agent_step',
]);

/** Confidence threshold below which the LLM is called for a second opinion. */
const LLM_CONFIDENCE_THRESHOLD = 0.7;

/** LLM classification timeout in milliseconds. */
const LLM_TIMEOUT_MS = 5_000;

/** Cheap, fast model used only to break ties the heuristic cannot. */
const CLASSIFIER_MODEL = 'gpt-4o-mini';

/** Cache TTL for LLM classification results (1 hour). */
const CLASSIFICATION_CACHE_TTL_SEC = 3600;

const CLASSIFICATION_SYSTEM_PROMPT = `You are a task classifier. Classify the user's request into ONE of these categories:

- coding: Writing, modifying, or generating code
- debugging: Fixing errors, troubleshooting code issues
- math_reasoning: Mathematical proofs, equations, calculations
- reasoning: Logical analysis, problem-solving
- writing: Creative or professional writing
- email: Email composition
- summarization: Summarizing documents or text
- translation: Language translation
- data_analysis: Analyzing data, creating visualizations
- planning: Project planning, roadmaps, strategies
- customer_support: Answering customer questions
- image: Image generation or manipulation
- chat: General conversation
- agent_step: Multi-step AI agent workflow

Respond ONLY with valid JSON: {"taskType": "...", "confidence": 0.0-1.0, "reasoning": "short explanation"}`;

/** The latest user message, lowercased. Falls back to the final message. */
function getLastUserText(messages: Array<{ role?: string; content?: unknown }>): string {
  if (!messages?.length) return '';

  // Prefer the latest user-authored message to avoid classifying assistant echoes.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user' && msg.content !== undefined) {
      return textFromContent(msg.content).toLowerCase();
    }
  }

  const lastMessage = messages[messages.length - 1];
  return lastMessage?.content ? textFromContent(lastMessage.content).toLowerCase() : '';
}

// --- Public API ---

/** Strong patterns are high signal on their own. Weak ones need company. */
interface PatternGroup {
  strong: RegExp[];
  weak: RegExp[];
}

const TASK_PATTERNS: Record<Exclude<TaskType, 'chat' | 'agent_step'>, PatternGroup> = {
  debugging: {
    strong: [
      /\b(bug|debug|stack ?trace|exception|crash|traceback|segfault)\b/i,
      /\b(undefined is not|cannot read|typeerror|syntaxerror|referenceerror|runtime ?error)\b/i,
      /\b(fix.*(error|issue|problem)|error.*fix)\b/i,
    ],
    weak: [
      /\b(broken|failing|not working|unexpected|wrong output)\b/i,
      /\b(log|stderr|stdout|exit code|panic)\b/i,
    ],
  },
  coding: {
    strong: [
      /\b(function|def |class |import |const |let |var |async |await )\b/i,
      /\.(py|ts|js|jsx|tsx|go|rs|java|cpp|c|rb|php|swift|kt)\b/i,
      /\b(implement|refactor|snippet|codebase|source code|pull request|merge)\b/i,
      /\b(api|endpoint|route|middleware|controller|service|repository)\b/i,
      // An authoring verb next to a code noun, such as "write a Python
      // function", which otherwise reads as generic writing.
      /\b(write|create|generate|build|code|add)\b[^.!?]{0,40}\b(function|method|class|script|program|algorithm|regex|query|component|module|endpoint|api|cli|parser|test|unit test)\b/i,
      /\b(in|using|with)\s+(python|javascript|typescript|java|golang|rust|ruby|php|swift|kotlin|scala|sql|bash|shell|c\+\+|c#)\b/i,
    ],
    weak: [
      /\b(code|program|script|module|package|library|framework|sdk)\b/i,
      /\b(compile|deploy|lint|format)\b/i,
      /\b(git|docker|kubernetes|ci\s*\/?\s*cd)\b/i,
      /\b(python|javascript|typescript|golang|rust|kotlin|swift|node\.?js|react|django|flask)\b/i,
      /\b(algorithm|quick ?sort|merge ?sort|binary search|linked list|hash ?map|hash ?table|recursion|data structure|big-?o)\b/i,
    ],
  },
  math_reasoning: {
    strong: [
      /\b(equation|calculus|integral|derivative|matrix|linear algebra)\b/i,
      /\b(probability|theorem|prove|proof|formula|lemma|corollary)\b/i,
    ],
    weak: [
      /\b(math|statistics|calculate|compute|solve.*equation)\b/i,
      /\b(geometric|algebraic|trigonometric|logarithm|exponential)\b/i,
    ],
  },
  data_analysis: {
    strong: [
      /\b(data ?set|csv|analytics|visuali[sz]ation|dataframe|pandas)\b/i,
      /\b(regression|correlation|histogram|scatter ?plot|pivot ?table)\b/i,
      /\b(sql query|etl|data ?pipeline|data ?warehouse|tableau|power ?bi)\b/i,
    ],
    weak: [
      /\b(chart|graph|plot|metric|kpi|dashboard|trend|insight)\b/i,
      /\b(aggregate|group by|filter|sort|join|query)\b/i,
      /\b(excel|spreadsheet|report|forecast)\b/i,
    ],
  },
  planning: {
    strong: [
      /\b(roadmap|project plan|gantt|sprint plan)\b/i,
      /\b(strategy|strategic plan|action items|deliverables)\b/i,
      /\b(backlog|user stor(y|ies)|acceptance criteria|requirements)\b/i,
      /\b(milestone|timeline)\b/i,
    ],
    weak: [
      /\b(plan|schedule|prioritize|scope|deadline)\b/i,
      /\b(phase|quarter|okr|goal|objective|initiative)\b/i,
      /\b(budget|resource|allocat|estimate|proposal)\b/i,
    ],
  },
  email: {
    strong: [
      /\b(write.*email|draft.*email|compose.*email|email.*draft)\b/i,
      /\b(subject line|dear |regards|sincerely|best regards)\b/i,
      /\b(compose.*mail|draft.*mail|reply.*email|forward.*email)\b/i,
    ],
    weak: [
      /\b(email|inbox|newsletter|mailing list|outreach)\b/i,
    ],
  },
  customer_support: {
    strong: [
      /\b(support ticket|help desk|customer complaint|service request)\b/i,
      /\b(refund|return policy|warranty|dispute|escalat)\b/i,
      /\b(customer service|client issue|user complaint|account issue)\b/i,
    ],
    weak: [
      /\b(customer|faq|troubleshoot|satisfaction|churn|onboard)\b/i,
      /\b(response template|canned response|sla|nps|csat)\b/i,
    ],
  },
  writing: {
    strong: [
      /\b(essay|blog ?post|story|poem|novel|copywriting)\b/i,
      /\b(creative writing|short story|screenplay|lyrics)\b/i,
    ],
    weak: [
      /\b(write|draft|rewrite|paraphrase|rephrase|proofread|edit)\b/i,
      /\b(tone|voice|style|narrative|prose|article)\b/i,
    ],
  },
  reasoning: {
    strong: [
      /\b(think through|reason about|logical.*analysis|critical.*thinking)\b/i,
      /\b(pros and cons|trade-?offs|weigh.*options|decision.*matrix)\b/i,
    ],
    weak: [
      /\b(why|explain|analy[sz]e|evaluate|compare|assess|consider)\b/i,
      /\b(logic|argument|hypothesis|assumption|implication)\b/i,
    ],
  },
  summarization: {
    strong: [
      /\b(summari[sz]e|summary|tl;dr|condense|recap|abstract)\b/i,
    ],
    weak: [
      /\b(brief|outline|overview|key ?points|highlights|gist)\b/i,
    ],
  },
  translation: {
    strong: [
      /\b(translate|translation|traduction|übersetzen|翻译|traducir|tradurre)\b/i,
      /\b(translate.*to|into.*(french|spanish|german|chinese|japanese|korean|arabic|portuguese|italian|russian|hindi))\b/i,
    ],
    weak: [
      /\b(locali[sz]e|locali[sz]ation|i18n|multilingual)\b/i,
    ],
  },
  image: {
    strong: [
      /\b(generate.*image|create.*image|draw.*picture|dall-?e|stable ?diffusion|midjourney)\b/i,
      /\b(illustration|artwork|graphic|visual|render.*scene)\b/i,
    ],
    weak: [
      /\b(image|picture|photo|icon|logo|banner)\b/i,
    ],
  },
};

/** More specific types are checked first, to avoid a false positive. */
const EVAL_ORDER: Array<Exclude<TaskType, 'chat' | 'agent_step'>> = [
  'debugging', 'coding', 'math_reasoning', 'data_analysis',
  'planning', 'email', 'customer_support', 'summarization',
  'translation', 'image', 'writing', 'reasoning',
];

interface HeuristicScore {
  taskType: TaskType;
  confidence: number;
}

/** Best matching task type for this text, with a confidence. */
function scoreHeuristic(text: string): HeuristicScore {
  let bestType: TaskType = 'chat';
  let bestScore = 0;

  for (const taskType of EVAL_ORDER) {
    const group = TASK_PATTERNS[taskType];
    const strongHits = group.strong.filter(p => p.test(text)).length;
    const weakHits = group.weak.filter(p => p.test(text)).length;

    if (strongHits === 0 && weakHits === 0) continue;

    // A strong hit alone starts at 0.85, each further strong hit adds 0.05.
    // Weak hits alone start at 0.55, each further weak hit adds 0.08.
    // A mix of both takes the strong base and adds the weak bonus.
    let score: number;
    if (strongHits > 0) {
      score = 0.85 + (strongHits - 1) * 0.05 + weakHits * 0.04;
    } else {
      score = 0.55 + (weakHits - 1) * 0.08;
    }

    score = Math.min(0.98, score);

    if (score > bestScore) {
      bestScore = score;
      bestType = taskType;
    }
  }

  return {
    taskType: bestType,
    confidence: bestScore > 0 ? bestScore : 0.3, // 0.3 = "no patterns matched, guessing chat"
  };
}

/** Keyword-scored task type, with the confidence discarded. */
export function classifyTaskHeuristic(
  messages: Array<{ role?: string; content?: unknown }>
): TaskType {
  const last = getLastUserText(messages);
  return scoreHeuristic(last).taskType;
}

/**
 * Keyword-scored task type with its confidence, which is what decides whether
 * the request is worth a classifier call.
 */
export function classifyTaskHeuristicWithConfidence(
  messages: Array<{ role?: string; content?: unknown }>
): HeuristicScore {
  const last = getLastUserText(messages);
  return scoreHeuristic(last);
}

/** Any failure, missing key or unparseable answer returns the keyword result. */
export async function classifyWithLLM(
  messages: Array<{ role?: string; content?: unknown }>,
  log?: { warn: (o: object, s: string) => void }
): Promise<ClassificationResult> {
  const apiKey = credentialForEnvironment('OPENAI_API_KEY');
  if (!apiKey) {
    return heuristicResult(messages, 'no OpenAI key is configured', 'heuristic');
  }
  if (isOfflineMode()) {
    return heuristicResult(messages, 'offline mode is enabled', 'heuristic');
  }

  const lastText = getLastUserText(messages);
  if (!lastText) {
    return heuristicResult(messages, 'the request carries no user text', 'heuristic');
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      // A redirect would carry the key to whatever host answered it.
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [
          { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
          { role: 'user', content: lastText.slice(0, 2000) }, // Cap input to save tokens
        ],
        temperature: 0,
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`classifier request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    return parseLLMClassification(raw, messages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown LLM error';
    log?.warn({ err }, `LLM classification failed: ${msg}`);
    return heuristicResult(messages, msg, 'fallback');
  }
}

/** The entry point. Escalates only when the keywords are unsure. */
export async function classifyTaskAsync(
  messages: Array<{ role?: string; content?: unknown }>,
  log?: { warn: (o: object, s: string) => void }
): Promise<ClassificationResult> {
  const { taskType, confidence } = classifyTaskHeuristicWithConfidence(messages);

  // Confident enough on keywords alone.
  if (confidence >= LLM_CONFIDENCE_THRESHOLD) {
    return {
      taskType,
      confidence,
      reasoning: `Heuristic classification (confidence ${confidence.toFixed(2)})`,
      method: 'heuristic',
    };
  }

  // Ambiguous: reuse a recent answer for the same prompt, else ask the LLM.
  if (isOfflineMode()) {
    return heuristicResult(messages, 'offline mode is enabled', 'heuristic');
  }
  const cacheKey = classificationCacheKey(getLastUserText(messages));

  const cached = getCachedClassification(cacheKey);
  if (cached) return cached;

  const llmResult = await classifyWithLLM(messages, log);
  if (llmResult.method === 'llm') {
    cacheClassification(cacheKey, llmResult);
  }

  return llmResult;
}

// --- Cache helpers ---

/**
 * Only prompts that reached the classifier are cached, for one hour, so a
 * repeated prompt does not pay twice. A restart clears it, which costs at most
 * one cheap call.
 */
const CLASSIFICATION_CACHE_MAX_ENTRIES = 500;

const classificationCache = new Map<string, { result: ClassificationResult; expiresAt: number }>();

/** Deterministic key from the message text. */
function classificationCacheKey(text: string): string {
  const hash = crypto.createHash('sha256').update(text.slice(0, 2000)).digest('hex');
  return `cls:${hash}`;
}

function getCachedClassification(key: string): ClassificationResult | null {
  const entry = classificationCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    classificationCache.delete(key);
    return null;
  }
  return { ...entry.result, method: 'cache' };
}

function cacheClassification(key: string, result: ClassificationResult): void {
  // Simple bound: drop the oldest entry once the cache is full.
  if (classificationCache.size >= CLASSIFICATION_CACHE_MAX_ENTRIES) {
    const oldest = classificationCache.keys().next().value;
    if (oldest) classificationCache.delete(oldest);
  }
  classificationCache.set(key, {
    result,
    expiresAt: Date.now() + CLASSIFICATION_CACHE_TTL_SEC * 1000,
  });
}

// --- Helpers ---

/** Parse the classifier reply, falling back to keywords if it is unusable. */
function parseLLMClassification(
  raw: string,
  messages: Array<{ role?: string; content?: unknown }>
): ClassificationResult {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    const taskType = String(parsed.taskType ?? '').toLowerCase();
    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.7;
    const reasoning = String(parsed.reasoning ?? 'LLM classification');

    if (!VALID_TASK_TYPES.has(taskType)) {
      return heuristicResult(messages, `the classifier returned an unknown type: ${taskType}`, 'fallback');
    }

    return {
      taskType: taskType as TaskType,
      confidence,
      reasoning,
      method: 'llm',
    };
  } catch {
    return heuristicResult(messages, 'Failed to parse the classifier response', 'fallback');
  }
}

/**
 * The keyword answer. `method` is `heuristic` when no classifier call was
 * possible, and `fallback` when a call was made and did not answer. The
 * confidence reported is the one the keywords produced.
 */
function heuristicResult(
  messages: Array<{ role?: string; content?: unknown }>,
  reason: string,
  method: 'heuristic' | 'fallback'
): ClassificationResult {
  const { taskType, confidence } = classifyTaskHeuristicWithConfidence(messages);
  return {
    taskType,
    confidence,
    reasoning:
      method === 'heuristic'
        ? `Heuristic classification (confidence ${confidence.toFixed(2)}). No classifier call: ${reason}`
        : `Fallback to heuristic (confidence ${confidence.toFixed(2)}): ${reason}`,
    method,
  };
}
