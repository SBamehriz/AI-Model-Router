import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Braces, Check, Code2, GitBranch, Languages, Loader2, Play, Search, Square, Text } from 'lucide-react';
import { describeError, explainRouting, sendChat, type ChatResponse, type LatencyPref, type Priority, type RoutingExplanation } from '@/lib/api';
import { useHealth } from '@/lib/useHealth';
import { humanize, ms, usd } from '@/lib/format';
import { EmptyState, ErrorPanel, MeterRow, PageHeader, SectionCard } from '@/components/common/Panels';
import { CopyButton } from '@/components/common/CopyButton';
import { errorHint } from '@/lib/apiHints';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

const EXAMPLES = [
  { label: 'Code', icon: Code2, prompt: 'Write a Python function that merges two sorted linked lists.' },
  { label: 'Reason', icon: GitBranch, prompt: 'Design a distributed rate limiter, prove it is correct under clock skew, and give production ready Go with benchmarks.' },
  { label: 'Summarize', icon: Text, prompt: 'Summarize this release note in one sentence. Version 2 adds automatic retries, improves request tracing, and fixes a timeout when the database is busy.' },
  { label: 'Translate', icon: Languages, prompt: 'Translate the sentence Where is the station into Japanese.' },
];
const PRIORITIES: Array<{ value: Priority; label: string }> = [{ value: 'cheap', label: 'Lowest cost' }, { value: 'balanced', label: 'Balanced' }, { value: 'best', label: 'Best fit' }, { value: 'quality', label: 'Quality first' }];

export function PlaygroundPage() {
  const [prompt, setPrompt] = useState(EXAMPLES[0].prompt);
  const [priority, setPriority] = useState<Priority>('balanced');
  const [latency, setLatency] = useState<LatencyPref>('normal');
  const [explanation, setExplanation] = useState<RoutingExplanation | null>(null);
  const [completion, setCompletion] = useState<ChatResponse | null>(null);
  const [busy, setBusy] = useState<'explain' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'decision' | 'response' | 'json'>('decision');
  const controller = useRef<AbortController | null>(null);
  const health = useHealth();
  useEffect(() => () => controller.current?.abort(), []);

  function invalidate() { setExplanation(null); setCompletion(null); setError(null); setTab('decision'); }
  async function run(mode: 'explain' | 'run') {
    if (!prompt.trim() || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    invalidate(); setBusy(mode);
    try {
      const input = { prompt, priority, latency_pref: latency };
      if (mode === 'explain') setExplanation(await explainRouting(input, request.signal));
      else {
        const result = await sendChat(input, request.signal);
        setCompletion(result); setExplanation(result.routing); setTab('response');
      }
    } catch (err) {
      if (!request.signal.aborted) setError(describeError(err, 'Request failed.'));
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(null); }
    }
  }
  function cancel() { controller.current?.abort(); controller.current = null; setBusy(null); }

  return <div className="space-y-6">
    <PageHeader title="Routing playground" description="Try a prompt. Inspect the choice. Follow every tradeoff." />
    {/* This line says whether a run here will be simulated or billed, which
        is worth saying either way, and saying it either way is what keeps
        the page still: appearing only for offline mode inserted a banner
        above the editor whenever /health answered after the first paint. */}
    {health.loading ? <div className="notice" aria-busy="true"><span className="status-dot opacity-40" aria-hidden="true" /><span>Checking whether completions here are live or simulated.</span></div>
      : health.data?.offline_mode ? <div className="notice"><span className="status-dot" aria-hidden="true" /><strong className="font-medium text-foreground">Offline mode</strong><span>Routing runs locally. Completions and costs are simulated. No provider is called.</span></div>
        : health.data ? <div className="notice"><span className="status-dot" aria-hidden="true" /><strong className="font-medium text-foreground">Live mode</strong><span>A run here is sent to one of your providers and billed by it.</span></div>
          : <div className="notice"><span className="status-dot" aria-hidden="true" /><strong className="font-medium text-foreground">Router not reached</strong><span>A run cannot be sent until the API answers. Check the address in Settings.</span></div>}
    {error && <ErrorPanel message={error} hint={errorHint(error)} />}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,.9fr)_minmax(0,1.1fr)]">
      <SectionCard title="Your prompt" description="Describe what the model should do." actions={<span className="font-mono text-xs text-muted-foreground">POST /v1/chat</span>}>
        <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void run('run'); }}>
          <fieldset disabled={busy !== null} className="min-w-0 space-y-5">
            <div className="space-y-2"><Label htmlFor="prompt" className="sr-only">Prompt</Label><Textarea id="prompt" value={prompt} onChange={(event) => { setPrompt(event.target.value); invalidate(); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void run('run'); } }} rows={9} maxLength={100000} placeholder="Ask for something" className="min-h-[220px] resize-y border-border bg-background/50 text-sm leading-7" /><div className="flex justify-between text-xs text-muted-foreground"><span>Plain text. Up to 100,000 characters</span><span className="tabular-nums">{prompt.length.toLocaleString()}</span></div></div>
            <div><p className="mb-2 text-xs text-muted-foreground">Start with an example</p><div className="flex flex-wrap gap-2">{EXAMPLES.map((example) => <Button type="button" key={example.label} size="sm" variant="outline" aria-pressed={prompt === example.prompt} onClick={() => { setPrompt(example.prompt); invalidate(); }}><example.icon className="h-3.5 w-3.5" aria-hidden="true" />{example.label}</Button>)}</div></div>
            <div className="grid gap-4 border-t pt-5 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="priority">Routing priority</Label><select id="priority" className="w-full" value={priority} onChange={(event) => { setPriority(event.target.value as Priority); invalidate(); }}>{PRIORITIES.map((p) => <option value={p.value} key={p.value}>{p.label}</option>)}</select></div><div className="space-y-2"><Label htmlFor="latency">Response speed</Label><select id="latency" className="w-full" value={latency} onChange={(event) => { setLatency(event.target.value as LatencyPref); invalidate(); }}><option value="normal">Standard</option><option value="fast">Prefer faster models</option></select></div></div>
          </fieldset>
          <div className="flex flex-wrap gap-2 border-t pt-5"><Button type="submit" disabled={busy !== null || !prompt.trim()}>{busy === 'run' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}{busy === 'run' ? 'Routing...' : 'Run prompt'}</Button><Button type="button" variant="outline" onClick={() => void run('explain')} disabled={busy !== null || !prompt.trim()}>{busy === 'explain' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Search aria-hidden="true" />}Explain routing</Button>{busy && <Button type="button" variant="ghost" onClick={cancel}><Square aria-hidden="true" />Stop waiting</Button>}</div>
          <p className="text-xs leading-relaxed text-muted-foreground">Explain skips the completion. With a live OpenAI key, ambiguous prompts may use a classifier call. Run records a request. <span className="hidden sm:inline">Press Ctrl or Cmd with Enter to run.</span></p>
          {busy && <p role="status" className="text-xs text-muted-foreground">{busy === 'run' ? 'Waiting for the routed response. Stopping here does not cancel a provider call already in progress.' : 'Classifying your prompt and scoring available models.'}</p>}
        </form>
      </SectionCard>

      <SectionCard title="Routing inspector" description={completion ? 'The decision from this execution.' : 'Classification, scores, and model selection.'} actions={explanation && <Badge variant="outline">{completion ? 'Executed' : 'Preview'}</Badge>}>
        <div className="mb-6 flex flex-wrap border-b" role="group" aria-label="Inspector view">{(['decision', 'response', 'json'] as const).map((value) => <button key={value} type="button" onClick={() => setTab(value)} aria-pressed={tab === value} className={`min-h-11 border-b-2 px-4 text-sm transition-colors ${tab === value ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{value === 'json' ? 'JSON' : humanize(value)}</button>)}</div>
        {busy ? <div className="space-y-5" aria-busy="true"><Skeleton className="h-24" /><Skeleton className="h-12" /><Skeleton className="h-44" /></div> : !explanation ? <EmptyState icon={GitBranch} title="A decision you can inspect" description="Run or explain a prompt to see the selected model, its alternatives, and the weights behind the choice." /> : tab === 'decision' ? <div className="space-y-6">
          <div className="rounded-lg border border-primary/25 bg-primary/5 p-4"><p className="mb-2 flex items-center gap-2 text-xs font-medium text-primary"><Check className="h-3.5 w-3.5" aria-hidden="true" />{completion ? 'Model used' : 'Selected model'}</p><p className="break-all font-mono text-sm font-medium">{explanation.selected_model}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{explanation.reason}</p></div>
          <dl className="grid grid-cols-3 gap-3 border-b pb-5"><div><dt className="text-xs text-muted-foreground">Task</dt><dd className="mt-2 text-sm font-semibold">{humanize(explanation.task_type)}</dd></div><div><dt className="text-xs text-muted-foreground">Complexity</dt><dd className="mt-2 font-mono text-sm">{explanation.complexity.score.toFixed(2)}<span className="text-muted-foreground"> / 1</span></dd></div><div><dt className="text-xs text-muted-foreground">Confidence</dt><dd className="mt-2 font-mono text-sm">{Math.round(explanation.classification.confidence * 100)}%</dd></div></dl>
          <div><h3 className="mb-4 text-sm font-semibold">Candidate ranking</h3><div className="space-y-4">{explanation.considered_models.map((model, index) => <div key={`${model.provider}/${model.model_name}`} className="flex items-start gap-3"><span className="pt-0.5 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><MeterRow label={model.model_name} value={model.score} caption={model.score.toFixed(3)} tone={`${model.provider}/${model.model_name}` === explanation.selected_model ? 'primary' : 'muted'} /><p className="mt-1 text-[11px] text-muted-foreground">{humanize(model.provider)}</p></div></div>)}</div></div>
          <div className="border-t pt-5"><h3 className="mb-4 text-sm font-semibold">Scoring weights</h3><div className="grid grid-cols-2 gap-x-6 gap-y-4">{Object.entries(explanation.weights).map(([name, value]) => <MeterRow key={name} label={humanize(name)} value={value} />)}</div></div>
          <details className="border-t pt-4"><summary className="py-1 text-sm font-medium">Classification & constraints</summary><div className="space-y-3 pt-4 text-xs leading-relaxed text-muted-foreground"><p>{explanation.classification.method}: {explanation.classification.reasoning}</p><p>{explanation.complexity.reasoning}</p><p>Minimum task skill: {explanation.constraints.minCategorySkill}. Reasoning: {explanation.constraints.minReasoning}. Hard coding required: {explanation.constraints.requireHardCoding ? 'yes' : 'no'}</p></div></details>
        </div> : tab === 'response' ? completion ? <div className="space-y-5"><div className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{ms(completion.latency_ms)}</span><span>{usd(completion.cost)}</span><span>{humanize(completion.fallback_level)} route</span></div><pre className="max-h-[500px] overflow-auto whitespace-pre-wrap break-words text-sm leading-7">{completion.output}</pre><div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4"><CopyButton text={completion.output} label="Copy response" /><Link to={`/requests?q=${completion.request_id}`} className="subtle-link">View request<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Link></div></div> : <EmptyState icon={Play} title="Ready when you are" description="This is a routing preview. Choose Run prompt to get a completion from the selected model." /> : <div className="space-y-4"><CopyButton text={JSON.stringify(completion ?? explanation, null, 2)} label="Copy JSON" /><pre className="code-surface max-h-[600px]">{JSON.stringify(completion ?? explanation, null, 2)}</pre><p className="flex items-center gap-2 text-xs text-muted-foreground"><Braces className="h-3.5 w-3.5" aria-hidden="true" />Unmodified API response</p></div>}
      </SectionCard>
    </div>
  </div>;
}
