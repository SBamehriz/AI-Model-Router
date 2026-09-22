import { describe, it, expect } from 'vitest';
import {
  ChatRequestSchema,
  describeValidationFailure,
  DebugRoutingRequestSchema,
  MessageSchema,
  ModelsQuerySchema,
  RecentRequestsQuerySchema,
  UsageQuerySchema,
} from '../schemas.js';

/**
 * The schemas are the API's outer boundary: anything they accept reaches the
 * router, and anything they reject becomes a 400. These pin both directions.
 */
describe('ChatRequestSchema', () => {
  const valid = { messages: [{ role: 'user', content: 'hello' }] };
  it('rejects a cost cap that boost orchestration cannot enforce', () => {
    expect(ChatRequestSchema.safeParse({ ...valid, boost: true, max_cost: 0.01 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...valid, boost: true }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ ...valid, max_cost: 0 }).success).toBe(true);
  });

  it('accepts a minimal request and applies defaults', () => {
    const parsed = ChatRequestSchema.parse(valid);
    expect(parsed.priority).toBe('balanced');
    expect(parsed.latency_pref).toBe('normal');
    expect(parsed.boost).toBe(false);
  });

  it('accepts every documented priority and latency preference', () => {
    for (const priority of ['cheap', 'balanced', 'best', 'quality']) {
      expect(ChatRequestSchema.safeParse({ ...valid, priority }).success).toBe(true);
    }
    for (const latency_pref of ['fast', 'normal']) {
      expect(ChatRequestSchema.safeParse({ ...valid, latency_pref }).success).toBe(true);
    }
  });

  it('rejects an empty conversation', () => {
    expect(ChatRequestSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('rejects an unknown role or non-string content', () => {
    expect(ChatRequestSchema.safeParse({ messages: [{ role: 'robot', content: 'hi' }] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 42 }] }).success).toBe(false);
  });

  it('rejects a negative max_cost but allows a zero-cost ceiling', () => {
    expect(ChatRequestSchema.safeParse({ ...valid, max_cost: -0.01 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...valid, max_cost: 0 }).success).toBe(true);
  });

  it('rejects an unreasonably long conversation', () => {
    const messages = Array.from({ length: 500 }, () => ({ role: 'user', content: 'hi' }));
    expect(ChatRequestSchema.safeParse({ messages }).success).toBe(false);
  });
});

describe('UsageQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(UsageQuerySchema.parse({})).toEqual({});
  });

  it('requires ISO timestamps', () => {
    expect(UsageQuerySchema.safeParse({ from: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
    expect(UsageQuerySchema.safeParse({ from: 'last tuesday' }).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ from: '2026-09-01' }).success).toBe(false);
  });

  it('rejects a range that runs backwards', () => {
    const result = UsageQuerySchema.safeParse({
      from: '2026-09-10T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('RecentRequestsQuerySchema', () => {
  it('defaults the limit', () => {
    expect(RecentRequestsQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces a query-string number', () => {
    expect(RecentRequestsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('bounds the limit so one request cannot pull the whole log', () => {
    expect(RecentRequestsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(RecentRequestsQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(RecentRequestsQuerySchema.safeParse({ limit: 200 }).success).toBe(true);
  });
});

describe('DebugRoutingRequestSchema', () => {
  it('accepts the same body as a chat request, so the two stay in step', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], priority: 'best' as const };
    expect(DebugRoutingRequestSchema.parse(body)).toEqual(ChatRequestSchema.parse(body));
  });
});

describe('MessageSchema', () => {
  it('accepts the three chat roles and rejects anything else', () => {
    for (const role of ['system', 'user', 'assistant']) {
      expect(MessageSchema.safeParse({ role, content: 'hi' }).success).toBe(true);
    }
    expect(MessageSchema.safeParse({ role: 'tool', content: 'hi' }).success).toBe(false);
  });

  it('rejects content that is only whitespace or control characters', () => {
    for (const content of [' ', '\t\n  ', '\u0000\u0007']) {
      expect(MessageSchema.safeParse({ role: 'user', content }).success).toBe(false);
    }
    expect(MessageSchema.safeParse({ role: 'user', content: '  hello  ' }).success).toBe(true);
  });

  it('caps message length, so a preview and a run reject the same bodies', () => {
    expect(MessageSchema.safeParse({ role: 'user', content: 'x'.repeat(100_000) }).success).toBe(true);
    expect(MessageSchema.safeParse({ role: 'user', content: 'x'.repeat(100_001) }).success).toBe(false);
  });
});

describe('ModelsQuerySchema', () => {
  it('accepts no filter and a single provider', () => {
    expect(ModelsQuerySchema.parse({})).toEqual({});
    expect(ModelsQuerySchema.parse({ provider: 'openai' }).provider).toBe('openai');
  });

  it('rejects a repeated provider key, which arrives as an array', () => {
    expect(ModelsQuerySchema.safeParse({ provider: ['openai', 'groq'] }).success).toBe(false);
  });

  it('rejects an empty or oversized provider', () => {
    expect(ModelsQuerySchema.safeParse({ provider: '   ' }).success).toBe(false);
    expect(ModelsQuerySchema.safeParse({ provider: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('describeValidationFailure', () => {
  it('names the field that failed and keeps every failure', () => {
    const described = describeValidationFailure([
      { path: ['messages'], message: 'Required' },
      { path: ['priority'], message: 'Invalid enum value' },
    ]);
    expect(described.message).toBe('messages: Required');
    expect(described.details).toHaveLength(2);
  });

  it('calls a whole-body failure request', () => {
    expect(describeValidationFailure([{ path: [], message: 'Expected object' }]).message)
      .toBe('request: Expected object');
  });

  /**
   * A strict schema rejecting unknown keys names them, and the caller chose
   * those names, so this is the one message here carrying caller text.
   */
  it('strips deceptive characters a caller put in a key name', () => {
    const override = String.fromCodePoint(0x202e);
    const c1 = String.fromCodePoint(0x85);
    const described = describeValidationFailure([
      { path: [], message: `Unrecognized key(s) in object: 'k${override}evil${c1}x'` },
    ]);
    expect(described.details[0].message).toBe("Unrecognized key(s) in object: 'kevilx'");
  });

  it('caps a message a caller can make arbitrarily long', () => {
    const described = describeValidationFailure([{ path: [], message: 'A'.repeat(4000) }]);
    expect(described.details[0].message).toHaveLength(200);
    expect(described.details[0].message.endsWith('…')).toBe(true);
  });
});
