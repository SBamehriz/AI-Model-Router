import type { Usage } from './api';

export function rangeParams(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The query returns UTC buckets. Fill the gaps without shifting time zones. */
export function dailySeries(rows: Usage['by_day'], days: number): Usage['by_day'] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const start = new Date(rangeParams(days).from);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, requests: 0, cost: 0, savings: 0 };
  });
}

export const chartTooltipStyle = { background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: 'hsl(var(--popover-foreground))' };
