import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A fix for "say which field failed" kept landing on some of the places that
 * needed it and not the others, because each route had its own copy of the
 * envelope. The copies are gone; this keeps them gone.
 *
 * A route that rejects a parse either builds its answer from the shared
 * describer, or its schema has exactly one field and the fixed sentence names
 * that field on its own. The second case is an explicit list, so adding to it
 * is a decision somebody makes on purpose rather than a default.
 */
const SRC = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Routes are not the only place an envelope gets built. prepareChatRequest is
 * the shared front door for three endpoints and lives in lib, so a guard that
 * read only the routes directory could not see the one file three endpoints
 * agree through. Both directories, so moving a handler does not move it out of
 * view.
 */
const SCANNED = [join(SRC, 'routes'), join(SRC, 'lib')];

/**
 * Rejections whose own sentence already names the thing that failed: schemas
 * with a single field, and rules that are not schema checks at all.
 */
const ALREADY_NAMES_THE_PROBLEM = [
  'Unknown provider.',
  'Name this key using 1 to 80 characters.',
  'Enter an API key for this new provider.',
  'Enter the key again when changing the API base URL.',
  'Usage date window must be between',
  // Not a parse rejection: the sanitiser throws, and every message it throws
  // already names the message index or the cap that was passed.
  'Invalid message content',
];

/**
 * Recursive, because `lib/db` and anything added beside it are as able to
 * build an envelope as `lib` itself, and a directory that is out of scope is
 * a place the rule quietly stops applying. Tests are skipped: they assert on
 * envelopes rather than producing them.
 */
const walk = (dir: string, prefix: string): Array<readonly [string, string]> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : walk(join(dir, entry.name), `${prefix}/${entry.name}`);
    }
    return entry.name.endsWith('.ts')
      ? [[`${prefix}/${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')] as const]
      : [];
  });

const sources = SCANNED.flatMap((dir) => walk(dir, dir.endsWith('lib') ? 'lib' : 'routes'));

describe('validation envelopes', () => {
  it('finds the route files it is meant to police', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
    expect(sources.some(([, body]) => body.includes('safeParse'))).toBe(true);
  });

  /**
   * The one error object a marker sits inside, found by matching braces rather
   * than by counting lines. A line window reaches into the next block and
   * finds a sentence that belongs to a different check, which is how the first
   * version of this guard passed a rejection it should have caught.
   */
  const envelopeAround = (body: string, markerIndex: number): string => {
    let open = body.lastIndexOf('{', markerIndex);
    // Walk out to the object that actually opens this error, not the inner one.
    while (open > 0 && !/error:\s*$|\(\s*$|send\($/.test(body.slice(Math.max(0, open - 12), open))) {
      const next = body.lastIndexOf('{', open - 1);
      if (next === -1) break;
      open = next;
    }
    let depth = 0;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') {
        depth -= 1;
        if (depth === 0) return body.slice(open, i + 1);
      }
    }
    return body.slice(open, markerIndex + 200);
  };

  /**
   * A rejection is written one of two ways here, and a guard that knows only
   * the first is a guard with a hole exactly the shape of the second. The
   * object literal is the common form; errorReply is the helper the auth code
   * uses, and nothing stops a route reaching for it with a validation code.
   */
  const MARKERS = [
    /code:\s*'(validation_error|invalid_request_error)'(.)/g,
    /errorReply\(\s*\w+\s*,\s*'(validation_error|invalid_request_error)'/g,
  ];

  it.each(sources)('%s builds every parse rejection from the shared describer', (_file, body) => {
    const found: Array<{ index: number; declaration: boolean }> = [];
    for (const pattern of MARKERS) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
        // `code: 'validation_error';` declares the shape of a rejection. Only
        // a property in an object literal builds one, and those carry on with
        // a comma or close the object.
        found.push({ index: m.index, declaration: m[2] === ';' });
      }
    }
    for (const { index, declaration } of found) {
      if (declaration) continue;
      // An errorReply call has no braces of its own, so read the statement.
      const envelope = body.startsWith('errorReply', index)
        ? body.slice(index, body.indexOf('\n', index) === -1 ? undefined : body.indexOf('\n', index))
        : envelopeAround(body, index);
      const m = { index };
      const shared = envelope.includes('describeValidationFailure');
      const approved = ALREADY_NAMES_THE_PROBLEM.some((sentence) => envelope.includes(sentence));
      const line = body.slice(0, m.index).split('\n').length;
      expect(
        shared || approved,
        `line ${line} answers with its own message: ${envelope.slice(0, 160)}\n` +
          'Use describeValidationFailure, or add the sentence to ALREADY_NAMES_THE_PROBLEM ' +
          'if the schema really has one field.',
      ).toBe(true);
    }
  });

  it('no route reads an offline switch without the shared flag reader', () => {
    for (const [file, body] of sources) {
      expect(body, `${file} compares an environment switch directly`).not.toMatch(
        /process\.env\.AI_MODEL_ROUTER_(OFFLINE|DISABLE_CATALOG_FETCH)/,
      );
    }
  });
});
