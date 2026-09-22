import { useCallback, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import { fetchUsage } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { compactUsd, count, humanize, ms, percent, shortDate, usd } from '@/lib/format';
import { DataTable, EmptyState, ErrorPanel, PageHeader, SectionCard, Th } from '@/components/common/Panels';
import { errorHint } from '@/lib/apiHints';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataProvenance, ReportingPeriod } from '@/components/common/Reporting';
import { dailySeries, rangeParams, chartTooltipStyle } from '@/lib/reporting';

/**
 * Chart colours in a fixed order, so a series keeps its colour across charts.
 * There are more colours than task types, so no two slices share one.
 */
const SERIES_COLORS = Array.from({ length: 8 }, (_, index) => `hsl(var(--chart-${index + 1}))`);

export function AnalyticsPage() {
  const [days, setDays] = useState<number>(30);
  const load = useCallback((signal: AbortSignal) => fetchUsage(rangeParams(days), signal), [days]);
  const { data, error, loading, reload } = useResource(load);

  const costTrend =
    data ? dailySeries(data.by_day, days).map((d) => ({ date: shortDate(d.date), cost: d.cost, savings: d.savings })) : [];
  const modelCost = data?.by_model.slice().sort((a, b) => b.cost - a.cost).slice(0, 8).map((m) => ({ ...m, label: m.model })) ?? [];
  const taskMix = data?.by_task ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Understand your spend and where each request goes."
        actions={
          <>
            <ReportingPeriod days={days} onChange={setDays} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh analytics"
              disabled={loading}
              onClick={reload}
            >
              <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            </Button>
          </>
        }
      />

      {error ? <ErrorPanel message={error} hint={errorHint(error)} onRetry={reload} /> : null}
      <DataProvenance sources={data?.by_source} loading={loading} failed={!!error} />
      {loading ? <Skeleton className="h-72 w-full" /> : null}

      {data && data.total_requests === 0 ? (
        <SectionCard title="No data in this period" description="Analytics are derived from the request log.">
          <EmptyState
            icon={BarChart3}
            title={`Nothing routed in the last ${days} days`}
            description="Send a request from the playground, or widen the period above."
          >
            <Button asChild size="sm">
              <Link to="/playground">Open the playground</Link>
            </Button>
          </EmptyState>
        </SectionCard>
      ) : null}

      {data && data.total_requests > 0 && (
        <>
          <SectionCard
            title="Cost and savings"
            description={`${compactUsd(data.total_cost)} spent, ${compactUsd(
              data.total_savings
            )} saved against a premium-only baseline.`}
          >
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={costTrend} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" minTickGap={36} />
                <YAxis tickFormatter={(value: number) => `$${value}`} tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={chartTooltipStyle} formatter={(value: number) => usd(value)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line isAnimationActive={false} type="monotone" name="Routing cost" dataKey="cost" stroke={SERIES_COLORS[0]} strokeWidth={2} dot={false} />
                <Line isAnimationActive={false} type="monotone" name="Saved vs. baseline" dataKey="savings" stroke={SERIES_COLORS[1]} strokeDasharray="5 4" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </SectionCard>

          <div className="grid gap-6 xl:grid-cols-2">
            <SectionCard title="Spend by model" description="Which models the router actually picked.">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={modelCost} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={150}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip contentStyle={chartTooltipStyle} formatter={(value: number) => usd(value)} />
                  <Bar isAnimationActive={false} dataKey="cost" fill={SERIES_COLORS[0]} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </SectionCard>

            <SectionCard title="Requests by task type" description="What the classifier detected.">
              <dl className="sr-only">{taskMix.map((entry) => <div key={entry.task_type}><dt>{humanize(entry.task_type)}</dt><dd>{count(entry.requests)} requests</dd></div>)}</dl>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  {/* The slices are one focus stop that announces nothing, and
                      the list above already carries the same numbers to a
                      screen reader. Keep the data, drop the silent stop. */}
                  <Pie
                    isAnimationActive={false}
                    rootTabIndex={-1}
                    data={taskMix}
                    dataKey="requests"
                    nameKey="task_type"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                  >
                    {taskMix.map((entry, index) => (
                      <Cell key={entry.task_type} fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    formatter={(value: number, name: string) => [count(value), humanize(String(name))]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    formatter={(value: string) => humanize(value)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </SectionCard>
          </div>

          <details className="section-panel p-5"><summary className="min-h-11 py-1.5 text-sm font-medium">View daily data (UTC)</summary><div className="mt-5"><DataTable caption="Daily request volume, routing cost and savings in UTC" minWidth="440px" head={<><Th>Date</Th><Th align="right">Requests</Th><Th align="right">Cost</Th><Th align="right">Saved</Th></>}>{dailySeries(data.by_day, days).map((row) => <tr key={row.date}><th scope="row" className="text-left font-normal">{row.date}</th><td className="text-right tabular-nums">{count(row.requests)}</td><td className="text-right tabular-nums">{usd(row.cost)}</td><td className="text-right tabular-nums">{usd(row.savings)}</td></tr>)}</DataTable></div></details>

          <SectionCard title="Per-model detail" description="Cost, savings and measured latency by model.">
            <DataTable
              caption="Requests, cost, savings and latency for every model used in this period"
              minWidth="640px"
              head={
                <>
                  <Th>Model</Th>
                  <Th align="right">Requests</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">Saved</Th>
                  <Th align="right">Avg latency</Th>
                  <Th align="right">Share</Th>
                </>
              }
            >
              {data.by_model.map((row) => (
                <tr key={`${row.provider}/${row.model}`}>
                  <th scope="row" className="text-left font-medium">
                    <span className="block max-w-[280px] truncate" title={row.model}>{row.model}</span>
                    <span className="text-xs font-normal text-muted-foreground">{humanize(row.provider)}</span>
                  </th>
                  <td className="text-right tabular-nums">{count(row.requests)}</td>
                  <td className="text-right tabular-nums">{usd(row.cost)}</td>
                  <td className="text-right tabular-nums">{usd(row.savings)}</td>
                  <td className="whitespace-nowrap text-right tabular-nums">{ms(row.avg_latency_ms)}</td>
                  <td className="text-right tabular-nums">{percent(row.requests / data.total_requests, 1)}</td>
                </tr>
              ))}
            </DataTable>
          </SectionCard>
        </>
      )}
    </div>
  );
}
