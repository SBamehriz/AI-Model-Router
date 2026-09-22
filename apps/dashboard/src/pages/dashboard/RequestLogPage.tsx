import { Fragment, useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Download, RefreshCw, ScrollText } from 'lucide-react';
import { fetchRequests, type RequestLogEntry } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { errorHint } from '@/lib/apiHints';
import { NO_VALUE, count, humanize, ms, timeAgo, usd } from '@/lib/format';
import {
  DataTable,
  EmptyState,
  ErrorPanel,
  PageHeader,
  SectionCard,
  TableSkeleton,
  Th,
} from '@/components/common/Panels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyButton } from '@/components/common/CopyButton';

function RoutingDetail({ entry }: { entry: RequestLogEntry }) {
  if (!entry.routing) {
    return (
      <p className="text-sm text-muted-foreground">
        No routing decision was recorded for this request.
      </p>
    );
  }

  const { routing } = entry;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decision</h4>
        <p className="mt-1 text-sm">{routing.reason ?? 'Not recorded'}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Classified by {routing.classification_method ?? 'unknown'}
          {routing.confidence != null ? ` (${Math.round(routing.confidence * 100)}% confidence)` : ''}
          {entry.complexity != null ? `, complexity ${entry.complexity.toFixed(2)}` : ''}
        </p>
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Weights</h4>
        <dl className="mt-1 space-y-0.5 text-sm">
          {routing.weights ? (
            Object.entries(routing.weights).map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{humanize(key)}</dt>
                <dd className="tabular-nums">{value.toFixed(2)}</dd>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">Not recorded</div>
          )}
        </dl>
      </div>

      <div>
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Candidates</h4>
        <dl className="mt-1 space-y-0.5 text-sm">
          {routing.considered_models.map((model) => (
            <div key={`${model.provider}/${model.model_name}`} className="flex justify-between gap-4">
              <dt className="truncate">{model.model_name}</dt>
              <dd className="tabular-nums text-muted-foreground">
                {model.score != null ? model.score.toFixed(3) : NO_VALUE}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function RequestLogPage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const filter = params.get('q') ?? '';
  const setFilter = (value: string) => setParams(value ? { q: value } : {}, { replace: true });
  const [status, setStatus] = useState('all');

  const load = useCallback((signal: AbortSignal) => fetchRequests(200, signal), []);
  const { data, error, loading, reload } = useResource(load);

  const entries = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    return data.requests.filter(
      (entry) =>
        (status === 'all' || (status === 'success' ? entry.success : !entry.success)) && (
        entry.id.includes(needle) ||
        entry.source.includes(needle) ||
        entry.model_used.toLowerCase().includes(needle) ||
        entry.task_type.includes(needle) ||
        entry.provider.includes(needle))
    );
  }, [data, filter, status]);

  function exportEntries() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'ai-model-router-requests.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Request log"
        description="Trace each request from model selection to outcome."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="log-filter" className="text-xs text-muted-foreground">
                Filter
              </Label>
              <Input
                id="log-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Model, task, source or request ID"
                className="w-full sm:w-64"
              />
            </div>
            <div className="space-y-1"><Label htmlFor="request-status" className="text-xs text-muted-foreground">Outcome</Label><select id="request-status" className="block" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All outcomes</option><option value="success">Succeeded</option><option value="failed">Failed</option></select></div>
            <Button size="sm" variant="outline" onClick={exportEntries} disabled={!entries.length}><Download aria-hidden="true" />Export JSON</Button>
            <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        }
      />

      {error ? <ErrorPanel message={error} hint={errorHint(error)} onRetry={reload} /> : null}
      {loading ? (
        <SectionCard title="Requests" description="Loading the most recent requests.">
          <TableSkeleton rows={6} columns={6} />
        </SectionCard>
      ) : null}

      {data && data.requests.length === 0 ? (
        <SectionCard title="Requests" description="Newest first.">
          <EmptyState
            icon={ScrollText}
            title="No requests recorded yet"
            description="Every routed request lands here with the scores behind the decision, including the ones that failed over to another model."
          >
            <Button asChild size="sm">
              <Link to="/playground">Route a prompt</Link>
            </Button>
          </EmptyState>
        </SectionCard>
      ) : null}

      {data && data.requests.length > 0 ? (
        <SectionCard
          title={`${entries.length} ${entries.length === 1 ? 'request' : 'requests'}`}
          description="Latest 200 requests, newest first. Expand a row for its decision and request ID."
        >
          {entries.length === 0 ? (
            <EmptyState title="Nothing matches that filter" description="Try a different model, provider or task.">
              <Button size="sm" variant="outline" onClick={() => { setFilter(''); setStatus('all'); }}>
                Clear filter
              </Button>
            </EmptyState>
          ) : (
            <DataTable
              caption="Recent requests with model, cost, latency and outcome"
              minWidth="760px"
              head={
                <>
                  <Th className="w-8">
                    <span className="sr-only">Expand</span>
                  </Th>
                  <Th>When</Th>
                  <Th>Task</Th>
                  <Th>Source</Th>
                  <Th>Model</Th>
                  <Th align="right">Tokens</Th>
                  <Th align="right">Cost</Th>
                  <Th align="right">Latency</Th>
                  <Th align="right">Status</Th>
                </>
              }
            >
              {entries.map((entry) => {
                const open = expanded === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr>
                      <td className="pl-1">
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : entry.id)}
                          aria-expanded={open}
                          aria-controls={`routing-${entry.id}`}
                          className="flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {open ? (
                            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          <span className="sr-only">
                            {open ? 'Hide' : 'Show'} routing decision for {entry.model_used}
                          </span>
                        </button>
                      </td>
                      <td className="text-muted-foreground">
                        <time dateTime={entry.created_at} title={new Date(entry.created_at).toLocaleString()}>{timeAgo(entry.created_at)}</time>
                      </td>
                      <td>
                        <Badge variant="secondary" className="text-[10px] font-normal">
                          {humanize(entry.task_type)}
                        </Badge>
                      </td>
                      <td><span className="text-xs text-muted-foreground">{entry.source === 'demo' ? 'Seeded' : entry.source === 'offline' ? 'Simulated' : humanize(entry.source)}</span></td>
                      <th scope="row" className="text-left font-medium">
                        {entry.model_used}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">{humanize(entry.provider)}</span>
                        {entry.fallback_level && entry.fallback_level !== 'primary' ? (
                          <Badge variant="outline" className="ml-2 text-[10px] font-normal">
                            {humanize(entry.fallback_level)}
                          </Badge>
                        ) : null}
                      </th>
                      <td className="text-right tabular-nums">
                        {count(entry.tokens_input + entry.tokens_output)}
                      </td>
                      <td className="text-right tabular-nums">{usd(entry.cost)}</td>
                      <td className="whitespace-nowrap text-right tabular-nums">{ms(entry.latency_ms)}</td>
                      <td className="text-right">
                        <Badge
                          variant={entry.success ? 'secondary' : 'destructive'}
                          className="text-[10px] font-normal"
                        >
                          {entry.success ? 'Success' : 'Failed'}
                        </Badge>
                      </td>
                    </tr>
                    {open ? (
                      <tr id={`routing-${entry.id}`} className="bg-muted/30">
                        <td colSpan={9} className="p-4">
                          <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><code className="text-xs text-muted-foreground">{entry.id}</code><CopyButton text={entry.id} label="Copy ID" /></div>
                          <RoutingDetail entry={entry} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </DataTable>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
