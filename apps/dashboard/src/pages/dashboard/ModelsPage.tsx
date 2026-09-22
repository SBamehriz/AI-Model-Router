import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { fetchModels } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { errorHint } from '@/lib/apiHints';
import { NO_VALUE, humanize, ms, timeAgo } from '@/lib/format';
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
import { Skeleton } from '@/components/ui/skeleton';

/** Per million tokens, the unit most provider catalogs use. */
function price(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value * 1000);
}

/** The catalog source as a reader would say it, not as it is stored. */
function catalogSource(source: string | null): string {
  if (source === 'openrouter') return 'the OpenRouter catalog';
  if (source === 'config') return 'the bundled snapshot';
  return 'an unknown source';
}

/** Context windows as providers publish them, such as 128K or 1M. */
function contextWindow(tokens: number | null): string {
  if (!tokens) return NO_VALUE;
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export function ModelsPage() {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<string>('all');
  const [sort, setSort] = useState('name');

  const load = useCallback((signal: AbortSignal) => fetchModels(signal), []);
  const { data, error, loading, reload } = useResource(load);

  const providers = useMemo(
    () => (data ? ['all', ...new Set(data.models.map((m) => m.provider))] : ['all']),
    [data]
  );

  const models = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.models
      .filter((m) => (provider === 'all' ? true : m.provider === provider))
      .filter(
        (m) =>
          needle.length === 0 ||
          m.model_name.toLowerCase().includes(needle) ||
          m.display_name?.toLowerCase().includes(needle) ||
          m.provider.toLowerCase().includes(needle) ||
          m.strengths.some((s) => s.includes(needle))
      ).sort((a, b) => sort === 'price' ? a.cost_input - b.cost_input : sort === 'quality' ? (b.quality_rating ?? 0) - (a.quality_rating ?? 0) : a.model_name.localeCompare(b.model_name));
  }, [data, provider, query, sort]);

  const catalog = data?.catalog;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model catalog"
        description="Explore the models available to the router, with transparent pricing and capabilities."
        actions={
          <Button size="sm" variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {/* This line exists before the catalog answers, so the section under it
          does not move when the answer arrives. A failure is reported where the
          table would have been, in the space the skeleton already holds. */}
      {catalog ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{catalog.models} models</Badge>
          <span>
            pricing from <span className="text-foreground">{catalogSource(catalog.source)}</span>
          </span>
          {catalog.last_sync_at ? (
            <span>refreshed {timeAgo(new Date(catalog.last_sync_at).toISOString())}</span>
          ) : null}
          {data?.offline_mode ? (
            <Badge variant="outline" className="max-w-full whitespace-normal">Offline mode. Completions simulated.</Badge>
          ) : null}
          {catalog.stale && <Badge variant="outline" className="max-w-full whitespace-normal">Pricing snapshot is stale</Badge>}
        </div>
      ) : error ? (
        <p className="flex min-h-[1.375rem] items-center text-sm text-muted-foreground">The catalog could not be read.</p>
      ) : (
        <div className="flex min-h-[1.375rem] items-center" aria-busy="true"><Skeleton className="h-5 w-72" /></div>
      )}

      <SectionCard
        title={
          data && models.length !== data.models.length
            ? `${models.length} of ${data.models.length} models`
            : 'Routable models'
        }
        description="Quality is a maintainer estimate, not a benchmark. Observed latency is measured from this instance's own traffic."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="model-filter" className="text-xs text-muted-foreground">
                Filter
              </Label>
              <div className="relative"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden="true" /><Input
                id="model-filter"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or strength"
                className="w-full pl-9 sm:w-52"
              /></div>
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground" id="provider-filter-label">
                Provider
              </span>
              <select aria-labelledby="provider-filter-label" value={provider} onChange={(event) => setProvider(event.target.value)}>
                {providers.map((option) => (
                  <option key={option} value={option}>{option === 'all' ? 'All providers' : humanize(option)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1"><Label htmlFor="model-sort" className="text-xs text-muted-foreground">Sort by</Label><select id="model-sort" className="block" value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Name</option><option value="price">Input price</option><option value="quality">Quality estimate</option></select></div>
          </div>
        }
      >
        {loading ? <TableSkeleton rows={11} columns={5} /> : null}
        {error ? <ErrorPanel message={error} hint={errorHint(error)} onRetry={reload} /> : null}

        {data ? (
          models.length === 0 ? (
            <EmptyState
              title="No models match that filter"
              description="Clear the filter, or pick a different provider."
            >
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setQuery('');
                  setProvider('all');
                }}
              >
                Clear filters
              </Button>
            </EmptyState>
          ) : (
            <DataTable
              caption="Every routable model with its pricing, task tags, quality estimate and latency"
              minWidth="820px"
              head={
                <>
                  <Th>Model</Th>
                  <Th>Good at</Th>
                  <Th align="right">In / 1M</Th>
                  <Th align="right">Out / 1M</Th>
                  <Th align="right">Quality</Th>
                  <Th align="right">Latency</Th>
                  <Th align="right">Context</Th>
                </>
              }
            >
              {models.map((model) => (
                <tr key={model.id} className="align-top">
                  <th scope="row" className="text-left font-medium">
                    <span className="flex items-center gap-2">
                      <span className="break-all">{model.display_name ?? model.model_name}</span>
                      {!model.provider_configured ? (
                        <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
                          no key
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">{humanize(model.provider)}. {model.data_source === 'custom' ? 'Your pricing estimates' : model.data_source === 'openrouter' ? 'Synced pricing' : 'Snapshot pricing'}</span>
                  </th>
                  <td className="max-w-[260px]">
                    <ul className="flex flex-wrap gap-1">
                      {model.strengths.map((strength) => (
                        <li key={strength}>
                          <Badge variant="secondary" className="text-[11px] font-normal">
                            {humanize(strength)}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="text-right tabular-nums">{price(model.cost_input)}</td>
                  <td className="text-right tabular-nums">{price(model.cost_output)}</td>
                  <td className="text-right tabular-nums">{model.quality_rating ?? NO_VALUE}</td>
                  <td className="text-right tabular-nums">
                    {ms(model.avg_latency)}
                    {model.observed_latency_ms != null ? (
                      <span className="block text-xs text-muted-foreground">
                        {ms(model.observed_latency_ms)} observed
                      </span>
                    ) : null}
                  </td>
                  <td className="text-right tabular-nums">{contextWindow(model.max_tokens)}</td>
                </tr>
              ))}
            </DataTable>
          )
        ) : null}
      </SectionCard>
    </div>
  );
}
