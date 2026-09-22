/** Formatting shared by every page. */

/** Stands in for a value that was never recorded. */
export const NO_VALUE = '-';

export function usd(value: number, digits = 4): string {
  if (value === 0) return '$0';
  // Exponential notation reads badly for money, so an amount below the
  // display precision says which side of zero it falls on instead. Savings
  // go negative whenever a route costs more than the premium baseline.
  if (Math.abs(value) < 0.0001) return value < 0 ? '> -$0.0001' : '< $0.0001';
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(digits)}`;
}

/** Totals, with cents above a dollar. Small amounts still read as small. */
export function compactUsd(value: number): string {
  return usd(value, Math.abs(value) >= 1 ? 2 : 4);
}

export function ms(value: number | null): string {
  return value == null ? NO_VALUE : `${Math.round(value)} ms`;
}

export function percent(value: number | null, digits = 0): string {
  return value == null ? NO_VALUE : `${(value * 100).toFixed(digits)}%`;
}

export function count(value: number): string {
  return value.toLocaleString();
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Stored values as a reader would say them, such as "math reasoning". */
export function humanize(value: string): string {
  const names: Record<string, string> = { openai: 'OpenAI', openrouter: 'OpenRouter', groq: 'Groq', google: 'Google', anthropic: 'Anthropic' };
  if (names[value]) return names[value];
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
