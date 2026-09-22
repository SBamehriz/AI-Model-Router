import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateComplexityDetailed } from '../complexityEstimator.js';
import { classifyTaskHeuristicWithConfidence } from '../taskClassifier.js';
import { getWeightsForRequest } from '../router.js';
import { MAX_MODELS_ATTEMPTED } from '../fallback.js';
import { PROVIDER_HTTP_DEADLINE_MS, PROVIDER_CALL_TIMEOUT_MS } from '../providerClient.js';
import type { TaskType } from '../taskClassifier.js';

/**
 * The algorithm document states numbers, and twice now a stated number has
 * stopped being true without anything noticing: a worked example drifted until
 * it was wrong in both its score and the task it claimed to demonstrate, and a
 * contrast figure was quoted from a measurement nobody had repeated.
 *
 * Prose gets re-read by a person who has to remember to check. These read the
 * document and run its claims, so a number that stops being true fails here.
 * Everything below is parsed out of the file rather than restated, which is
 * the point: restating it would just be a second copy to drift.
 */
const DOC = readFileSync(
  join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), '..', '..', 'docs', 'algorithm.md'),
  'utf8',
);

/** The rows of the first markdown table whose header contains every column. */
const table = (...columns: string[]): string[][] => {
  const lines = DOC.split('\n');
  const header = lines.findIndex((line) => columns.every((c) => line.includes(c)) && line.startsWith('|'));
  if (header === -1) throw new Error(`no table with columns ${columns.join(', ')}`);
  const rows: string[][] = [];
  for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i += 1) {
    rows.push(lines[i].split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  if (!rows.length) throw new Error(`table ${columns.join(', ')} has no rows`);
  return rows;
};

const unquote = (cell: string) => cell.replace(/^"|"$/g, '').replace(/`/g, '').trim();

describe('the algorithm document against the code it describes', () => {
  it('finds the tables it is reading', () => {
    expect(table('Prompt', 'Task', 'Score').length).toBeGreaterThanOrEqual(3);
    expect(table('Priority', 'cost', 'latency').length).toBe(4);
  });

  /**
   * The worked examples, re-measured. This is the claim that was wrong: a
   * prompt documented at 0.91 scored 0.55, and classified as something other
   * than the task type the paragraph beneath it named.
   */
  it('scores every worked example exactly as written', () => {
    for (const [promptCell, taskCell, scoreCell] of table('Prompt', 'Task', 'Score')) {
      const prompt = unquote(promptCell);
      const messages = [{ role: 'user', content: prompt }];
      const classified = classifyTaskHeuristicWithConfidence(messages);
      const measured = estimateComplexityDetailed(messages, classified.taskType as TaskType);

      expect(classified.taskType, `"${prompt.slice(0, 48)}" is documented as ${taskCell}`).toBe(unquote(taskCell));
      expect(
        Number(measured.complexity.toFixed(2)),
        `"${prompt.slice(0, 48)}" is documented at ${scoreCell}`,
      ).toBe(Number(unquote(scoreCell)));
    }
  });

  /**
   * Between the two bending thresholds no multiplier applies, so the weights a
   * request gets are the documented row itself.
   */
  it('uses the documented weight for every priority', () => {
    for (const [priority, cost, latency, task, quality] of table('Priority', 'cost', 'latency')) {
      const actual = getWeightsForRequest(unquote(priority) as 'cheap', 0.5, 'normal');
      expect(actual.cost, `${priority} cost`).toBeCloseTo(Number(cost), 5);
      expect(actual.latency, `${priority} latency`).toBeCloseTo(Number(latency), 5);
      expect(actual.task, `${priority} task`).toBeCloseTo(Number(task), 5);
      expect(actual.quality, `${priority} quality`).toBeCloseTo(Number(quality), 5);
    }
  });

  /** The per-task floor, read back through the factors the estimator reports. */
  it('uses the documented baseline for every task', () => {
    for (const row of table('Task', 'Baseline')) {
      // The table is two pairs of columns per row to keep it short.
      for (const [tasks, baseline] of [row.slice(0, 2), row.slice(2, 4)]) {
        if (!tasks || !baseline) continue;
        for (const task of tasks.split(',').map(unquote)) {
          const measured = estimateComplexityDetailed([{ role: 'user', content: 'x' }], task as TaskType);
          expect(measured.factors.taskBaseline, `${task} baseline`).toBeCloseTo(Number(baseline), 5);
        }
      }
    }
  });

  it('states the attempt cap and both deadlines that the code uses', () => {
    expect(DOC).toMatch(new RegExp(`At most ${['zero', 'one', 'two', 'three', 'four', 'five'][MAX_MODELS_ATTEMPTED]} models are attempted`));
    expect(DOC).toContain(`${PROVIDER_HTTP_DEADLINE_MS / 1000} seconds for the`);
    expect(DOC).toContain(`${PROVIDER_CALL_TIMEOUT_MS / 1000} second wrapper`);
  });
});
