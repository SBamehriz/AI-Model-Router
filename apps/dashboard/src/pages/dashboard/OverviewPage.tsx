import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, ArrowRight, ArrowUpRight, Plus, RefreshCw, Coins, Timer, TrendingDown } from 'lucide-react';
import { fetchProviders, fetchUsage } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { errorHint } from '@/lib/apiHints';
import { NO_VALUE, compactUsd, count, humanize, ms, percent, shortDate, usd } from '@/lib/format';
import { DataTable, EmptyState, ErrorPanel, MeterRow, PageHeader, SectionCard, StatCard, TableSkeleton, Th } from '@/components/common/Panels';
import { DataProvenance, ReportingPeriod } from '@/components/common/Reporting';
import { chartTooltipStyle, dailySeries, rangeParams } from '@/lib/reporting';
import { CopyButton } from '@/components/common/CopyButton';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function OverviewPage() {
  const [days, setDays] = useState(30);
  const loadUsage = useCallback((signal: AbortSignal) => fetchUsage(rangeParams(days), signal), [days]);
  const loadProviders = useCallback((signal: AbortSignal) => fetchProviders(signal), []);
  const usage = useResource(loadUsage);
  const providers = useResource(loadProviders);
  const data = usage.data;
  const baseline = data ? data.total_cost + data.total_savings : 0;
  const empty = data?.total_requests === 0;
  const chart = data ? dailySeries(data.by_day, days).map((row) => ({ ...row, date: shortDate(row.date) })) : [];

  return <div className="space-y-6">
    <PageHeader title="Overview" description="Your routing activity, at a glance." actions={<Button asChild><Link to="/playground"><Plus aria-hidden="true" />Route a prompt</Link></Button>} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="status-dot" aria-hidden="true" />Request history, shown in UTC</div>
      <div className="flex items-center gap-2"><ReportingPeriod days={days} onChange={setDays} /><Button variant="ghost" size="icon" aria-label="Refresh overview" disabled={usage.loading} onClick={() => { usage.reload(); providers.reload(); }}><RefreshCw className={usage.loading ? 'animate-spin' : ''} aria-hidden="true" /></Button></div>
    </div>
    <DataProvenance sources={data?.by_source} loading={usage.loading} failed={!!usage.error} />
    {/* On a failure the error stands where the figures would have: four
        tiles reading a dash said nothing, and a panel added above them on
        top of that moved the whole page. */}
    {usage.error ? <ErrorPanel message={usage.error} hint={errorHint(usage.error)} onRetry={usage.reload} /> : <div className="metric-strip">
      <StatCard icon={<Activity className="h-3.5 w-3.5" />} label="Total requests" value={data ? count(data.total_requests) : NO_VALUE} loading={usage.loading} hint={`Across the last ${days} days`} />
      <StatCard icon={<Coins className="h-3.5 w-3.5" />} label="Routing cost" value={data ? compactUsd(data.total_cost) : NO_VALUE} loading={usage.loading} hint="Calculated from token usage" />
      <StatCard icon={<TrendingDown className="h-3.5 w-3.5" />} label="Saved vs. baseline" value={data ? compactUsd(data.total_savings) : NO_VALUE} loading={usage.loading} hint={baseline > 0 ? `${percent(data!.total_savings / baseline)} below premium-only routing` : 'Compared with premium-only routing'} />
      <StatCard icon={<Timer className="h-3.5 w-3.5" />} label="Average latency" value={data && !empty ? ms(data.avg_latency_ms) : NO_VALUE} loading={usage.loading} hint={data && !empty ? `${percent(data.success_rate, 1)} request success rate` : 'Measured after your first request'} />
    </div>}

    {/* When the report failed these cards would stand empty under the error,
        and their skeletons leaving would move whatever was drawn below. */}
    {!usage.error && <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <SectionCard title="Request volume" description="Daily requests across all models." actions={<span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="status-dot" aria-hidden="true" />Requests</span>}>
        {usage.loading && <Skeleton className="h-[260px] w-full" />}
        {empty && <EmptyState icon={Activity} title="Your first route starts here" description="Send a prompt to see which model the router selects. No provider key is needed to try it."><Button asChild><Link to="/playground">Try the playground<ArrowRight aria-hidden="true" /></Link></Button></EmptyState>}
        {data && !empty && <div role="img" aria-label={`${count(data.total_requests)} requests in the last ${days} days. Daily values available in Analytics.`}>
          <ResponsiveContainer width="100%" height={260}><AreaChart accessibilityLayer data={chart} margin={{ top: 10, right: 4, bottom: 0, left: -20 }}>
            <defs><linearGradient id="volume-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.16} /><stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" axisLine={false} tickLine={false} minTickGap={36} dy={8} />
            <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={chartTooltipStyle} formatter={(value: number) => [count(value), 'Requests']} />
            <Area type="monotone" dataKey="requests" stroke="hsl(var(--primary))" fill="url(#volume-fill)" strokeWidth={2} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer>
        </div>}
      </SectionCard>
      <SectionCard title="Task distribution" description="Detected by the classifier.">
        {usage.loading && <TableSkeleton rows={5} columns={1} />}
        {data && !empty && <div className="space-y-4">{data.by_task.slice(0, 6).map((task) => <MeterRow key={task.task_type} label={humanize(task.task_type)} value={task.requests / data.total_requests} caption={`${count(task.requests)} requests, ${percent(task.requests / data.total_requests)}`} />)}<Link to="/analytics" className="subtle-link">View analytics<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link></div>}
        {empty && <p className="py-8 text-sm leading-relaxed text-muted-foreground">Coding, reasoning, translation, and more. Your task mix appears after the first request.</p>}
      </SectionCard>
    </div>}

    {!usage.error && <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <SectionCard title="Models in use" description="The most frequently selected models." actions={<Link to="/models" className="subtle-link">Model catalog<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>}>
        {usage.loading && <TableSkeleton rows={5} columns={4} />}
        {empty && <p className="py-8 text-sm text-muted-foreground">No models used yet. Each completed route adds its usage here.</p>}
        {data && !empty && <DataTable caption="Requests, cost and latency per model" minWidth="520px" head={<><Th>Model</Th><Th align="right">Requests</Th><Th align="right">Cost</Th><Th align="right">Latency</Th></>}>
          {data.by_model.slice(0, 5).map((row) => <tr key={`${row.provider}/${row.model}`}><th scope="row" className="text-left font-medium"><span className="block max-w-[280px] truncate" title={row.model}>{row.model}</span><span className="text-xs font-normal text-muted-foreground">{humanize(row.provider)}</span></th><td className="text-right tabular-nums">{count(row.requests)}</td><td className="text-right tabular-nums">{usd(row.cost)}</td><td className="whitespace-nowrap text-right tabular-nums">{ms(row.avg_latency_ms)}</td></tr>)}
        </DataTable>}
      </SectionCard>
      <SectionCard title="Provider connections" description="Availability on this instance.">
        {providers.loading && <TableSkeleton rows={5} columns={2} />}
        {providers.error && <ErrorPanel message={providers.error} hint={errorHint(providers.error)} onRetry={providers.reload} />}
        {providers.data && <ul className="divide-y">{providers.data.providers.map((p) => <li key={p.provider} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div><p className="text-sm font-medium">{humanize(p.provider)}</p><p className="mt-1 text-xs text-muted-foreground">{p.attempts ? `${count(p.attempts)} calls, ${percent(p.success_rate)} success` : 'No calls in the last hour'}</p></div><span className={`shrink-0 rounded-md px-2 py-1 text-[11px] ${p.configured ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{p.configured ? 'Configured' : 'No key'}</span></li>)}</ul>}
        <Link to="/settings" className="subtle-link mt-3">Connection settings<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
      </SectionCard>
    </div>}
    {empty && <SectionCard title="Explore with sample history" description="Seed 30 days of clearly labeled synthetic requests, without calling a provider."><div className="flex flex-wrap items-center gap-4"><code className="code-surface flex-1">npm run demo:seed</code><CopyButton text="npm run demo:seed" label="Copy command" /></div><p className="mt-3 text-xs text-muted-foreground">Remove sample rows with <code>npm run demo:clear</code>. Your own requests are preserved.</p></SectionCard>}
    <p className="text-xs text-muted-foreground">All amounts in USD. Savings use a fixed premium-model baseline. They are not a billing reconciliation.</p>
  </div>;
}
