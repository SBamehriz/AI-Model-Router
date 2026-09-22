import { FlaskConical } from 'lucide-react';
import type { Usage } from '@/lib/api';
import { count } from '@/lib/format';
import { Button } from '@/components/ui/button';

export function ReportingPeriod({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return <div className="segmented" role="group" aria-label="Reporting period">
    {[7, 30, 90].map((value) => <Button key={value} size="sm" variant="ghost" aria-pressed={days === value} onClick={() => onChange(value)}>{value} days</Button>)}
  </div>;
}

/**
 * Where the numbers on the page came from. This line renders for every
 * period that has requests, live traffic included, and holds its frame while
 * the report is still loading. It used to appear only when there was sample
 * data to label, which meant the whole page below it dropped by its height
 * on every load of an instance with sample data, a layout shift that measured
 * 0.058 against a 0.025 bar. A constant slot is the only way to be still in
 * every case, and telling someone their figures are real traffic is worth a
 * line anyway.
 */
export function DataProvenance({ sources, loading = false, failed = false }: { sources?: Usage['by_source']; loading?: boolean; failed?: boolean }) {
  if (loading) {
    return <div className="notice" aria-busy="true"><FlaskConical className="h-4 w-4 shrink-0 text-primary/40" aria-hidden="true" /><span>Reading the request history to say where these figures come from.</span></div>;
  }
  if (failed) {
    return <div className="notice"><FlaskConical className="h-4 w-4 shrink-0 text-primary/40" aria-hidden="true" /><span>The request history could not be read, so there is nothing to say about where figures come from.</span></div>;
  }
  if (!sources) return null;
  const counted = sources.filter((s) => s.requests > 0);
  // A period with nothing in it still gets the line, because a placeholder
  // that then vanished would move the page on exactly the load a new user
  // sees first.
  if (!counted.length) {
    return <div className="notice"><FlaskConical className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><strong className="font-medium text-foreground">No requests in this period</strong><span>Figures appear here once something has been routed.</span></div>;
  }
  const synthetic = counted.filter((s) => s.source !== 'live');
  if (!synthetic.length) {
    const total = counted.reduce((n, s) => n + s.requests, 0);
    return <div className="notice"><FlaskConical className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><strong className="font-medium text-foreground">Live traffic only</strong><span>{count(total)} {total === 1 ? 'request' : 'requests'} in this period, all sent to a provider. Costs are calculated from the token counts each one reported.</span></div>;
  }
  const labels = { demo: 'seeded', offline: 'simulated', unknown: 'legacy (source unknown)', live: 'live' };
  return <div className="notice"><FlaskConical className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><strong className="font-medium text-foreground">Sample data included</strong><span>{synthetic.map((s) => `${count(s.requests)} ${labels[s.source]} ${s.requests === 1 ? 'request' : 'requests'}`).join(', ')}. Costs and savings for these rows are estimates, not provider charges.</span></div>;
}
