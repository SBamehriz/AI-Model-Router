import { describe, it, expect } from 'vitest';
import {
  isBlankAfterSanitize,
  sanitizeLabel,
  sanitizeMessageContent,
  sanitizeMessages,
  sanitizeText,
} from '../sanitize.js';

describe('sanitizeText', () => {
  it('keeps ordinary text intact', () => {
    expect(sanitizeText('Write a quicksort in Python')).toBe('Write a quicksort in Python');
  });

  it('strips control characters that could corrupt logs or payloads', () => {
    expect(sanitizeText('safe\x00\x07\x1Btext')).toBe('safetext');
    expect(sanitizeText('bell\x07')).toBe('bell');
  });

  it('keeps newlines and tabs, which chat text uses legitimately', () => {
    expect(sanitizeText('line one\nline two')).toBe('line one\nline two');
    expect(sanitizeText('a\tb')).toBe('a\tb');
  });

  it('leaves runs of spaces and surrounding whitespace exactly as written', () => {
    expect(sanitizeText('  too    many   spaces  ')).toBe('  too    many   spaces  ');
  });

  it('preserves indentation, so code survives the prompt boundary', () => {
    const python = 'def example():\n    if True:\n        return "a  b"\n';
    expect(sanitizeText(python)).toBe(python);

    // The failure this pins: collapsing runs of spaces flattened the nesting
    // and rewrote the string literal, and what reached the model was not valid
    // Python and not what the caller sent.
    const tsv = 'name\tvalue\nalpha\t1';
    expect(sanitizeText(tsv)).toBe(tsv);
  });

  it('returns an empty string for a non-string input', () => {
    expect(sanitizeText(undefined as unknown as string)).toBe('');
    expect(sanitizeText(42 as unknown as string)).toBe('');
  });
});

describe('sanitizeMessageContent', () => {
  it('sanitises within the limit', () => {
    expect(sanitizeMessageContent('hello\x00 world')).toBe('hello world');
  });

  it('rejects content over the limit', () => {
    expect(() => sanitizeMessageContent('x'.repeat(11), 10)).toThrow(/maximum length of 10/);
  });

  it('accepts content exactly at the limit', () => {
    expect(sanitizeMessageContent('x'.repeat(10), 10)).toHaveLength(10);
  });

  it('rejects a non-string body', () => {
    expect(() => sanitizeMessageContent(null as unknown as string)).toThrow(/must be a string/);
  });

  it('rejects a body with nothing left once control characters are gone', () => {
    expect(() => sanitizeMessageContent('   \t\n  ')).toThrow(/empty after removing control characters/);
    expect(() => sanitizeMessageContent('\x00\x07\x1B')).toThrow(/empty after removing control characters/);
  });
});

describe('isBlankAfterSanitize', () => {
  it('treats whitespace and control characters as no prompt at all', () => {
    expect(isBlankAfterSanitize(' \t\n ')).toBe(true);
    expect(isBlankAfterSanitize('\x00\x1F')).toBe(true);
    expect(isBlankAfterSanitize(' \t hello \n')).toBe(false);
    expect(isBlankAfterSanitize('0')).toBe(false);
  });
});

describe('sanitizeMessages', () => {
  const message = (content: string) => ({ role: 'user', content });

  it('sanitises every message and preserves roles', () => {
    const result = sanitizeMessages([
      { role: 'system', content: 'You are\x00 helpful' },
      message('Hi   there'),
    ]);

    expect(result).toEqual([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hi   there' },
    ]);
  });

  it('rejects a message that is only whitespace', () => {
    expect(() => sanitizeMessages([{ role: 'user', content: ' \t\n ' }])).toThrow(
      /Message at index 0: .*empty after removing control characters/
    );
  });

  it('rejects a non-array input', () => {
    expect(() => sanitizeMessages('nope' as unknown as [])).toThrow(/must be an array/);
  });

  it('rejects a conversation longer than the cap', () => {
    const many = Array.from({ length: 4 }, () => message('hi'));
    expect(() => sanitizeMessages(many, 3)).toThrow(/maximum count of 3/);
  });

  it('names the offending index for a malformed message', () => {
    expect(() => sanitizeMessages([message('ok'), null as unknown as { role: string; content: string }]))
      .toThrow(/index 1 is not an object/);
    expect(() => sanitizeMessages([{ role: '', content: 'hi' }])).toThrow(/index 0 has invalid role/);
    expect(() => sanitizeMessages([{ role: 'user', content: '' }])).toThrow(/index 0 has invalid content/);
  });

  it('reports which message was too long', () => {
    expect(() => sanitizeMessages([message('ok'), message('x'.repeat(50))], 10, 20))
      .toThrow(/Message at index 1: .*maximum length of 20/);
  });

  it('accepts an empty conversation (Zod rejects it earlier)', () => {
    expect(sanitizeMessages([])).toEqual([]);
  });
});

/**
 * A label is rendered in the interface and acted on: which key to revoke,
 * which provider to remove. It has to read as what it is.
 */
describe('sanitizeLabel', () => {
  const RLO = '‮';
  const LRI = '⁦';
  const C1 = '';

  it('removes a bidirectional override that would reverse what follows it', () => {
    expect(sanitizeLabel(`billing${RLO}gnikcah key`)).toBe('billinggnikcah key');
    expect(sanitizeLabel(`a${LRI}b`)).toBe('ab');
  });

  it('removes C1 controls, which message content now drops as well', () => {
    expect(sanitizeLabel(`laptop${C1} key`)).toBe('laptop key');
    expect(sanitizeMessageContent(`hello${C1}world`)).toBe('helloworld');
  });

  it('leaves an ordinary name exactly as written', () => {
    for (const name of ['OpenClaw laptop', 'DeepSeek (work)', 'clé de routeur', '路由器密钥']) {
      expect(sanitizeLabel(name)).toBe(name);
    }
  });

  it('keeps bidirectional marks in prose, which only labels strip', () => {
    // Message content may legitimately need them to lay out mixed direction text.
    expect(sanitizeMessageContent(`شكرا${RLO} thanks`)).toContain(RLO);
  });
});
