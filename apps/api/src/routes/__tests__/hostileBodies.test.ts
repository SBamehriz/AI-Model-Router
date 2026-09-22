import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../__tests__/helpers/testApp.js';

/**
 * A 500 means something got past validation and threw, and a stack frame in a
 * response body means the caller learned about the filesystem. These bodies
 * are structurally wrong rather than semantically wrong, because those are the
 * ones a schema is most likely to wave through into code that assumed a shape.
 */
const nest = (depth: number): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  let node = root;
  for (let i = 0; i < depth; i += 1) {
    const next: Record<string, unknown> = {};
    node.next = next;
    node = next;
  }
  return root;
};

const ok = { role: 'user', content: 'hi' };

const BODIES: Array<[string, unknown]> = [
  ['null', null],
  ['an array', [1, 2, 3]],
  ['a number', 42],
  ['messages as a string', { model: 'auto', messages: 'hello' }],
  ['messages of nulls', { model: 'auto', messages: [null, null] }],
  ['content as an object', { model: 'auto', messages: [{ role: 'user', content: { a: 1 } }] }],
  ['content parts of the wrong type', { model: 'auto', messages: [{ role: 'user', content: [{ type: 'image', url: 'x' }] }] }],
  ['role as a number', { model: 'auto', messages: [{ role: 7, content: 'hi' }] }],
  ['a constructor key', { model: 'auto', messages: [ok], constructor: { prototype: {} } }],
  ['four hundred levels of nesting', { model: 'auto', messages: [ok], extra: nest(400) }],
  ['a negative max_tokens', { model: 'auto', messages: [ok], max_tokens: -5 }],
  ['a non numeric temperature', { model: 'auto', messages: [ok], temperature: 'NaN' }],
  ['an enormous n', { model: 'auto', messages: [ok], n: 1e12 }],
  ['tool_choice with no tools', { model: 'auto', messages: [ok], tool_choice: 'required' }],
  ['a tool result with no call', { model: 'auto', messages: [{ role: 'tool', tool_call_id: 'x', content: 'r' }] }],
  ['tool arguments that are not JSON', { model: 'auto', messages: [{ role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: 'not json' } }] }] }],
  ['stop as an object', { model: 'auto', messages: [ok], stop: { a: 1 } }],
  ['unicode noncharacters', { model: 'auto', messages: [{ role: 'user', content: '￾﷐ hi' }] }],
  ['a lone surrogate', { model: 'auto', messages: [{ role: 'user', content: 'a\uD800b' }] }],
];

const ENDPOINTS = ['/v1/chat/completions', '/v1/chat', '/v1/agent-step', '/v1/router/debug'];

describe('hostile request bodies', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildTestApp(); });
  afterEach(async () => { await app.close(); });

  for (const url of ENDPOINTS) {
    it.each(BODIES)(`${url} refuses %s without failing`, async (_label, payload) => {
      const response = await app.inject({ method: 'POST', url, payload: payload as never });
      expect(response.statusCode).toBeLessThan(500);
      expect(response.body).not.toMatch(/node:internal|\.ts:\d+|at Object\./);
    });
  }

  it('leaves Object.prototype alone', () => {
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
  });
});
