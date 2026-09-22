import { useState } from 'react';
import { Plus } from 'lucide-react';
import { describeError, saveCustomProvider, removeCustomProvider, type CustomProvider, type CustomModel } from '@/lib/api';
import { SectionCard } from '@/components/common/Panels';
import { SecretInput } from '@/components/common/SecretInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const tasks = ['chat', 'coding', 'debugging', 'reasoning', 'math_reasoning', 'writing', 'email', 'summarization', 'translation', 'data_analysis', 'planning', 'customer_support', 'agent_step'];
const initial = { provider: '', name: '', base_url: '', model_name: '', cost_input: '', cost_output: '', max_tokens: '', supports_functions: false, quality_rating: '70', avg_latency: '2000', strengths: ['chat'] };

export function CustomProviderSetup({ providers, onChange }: { providers: CustomProvider[]; onChange: () => void }) {
  const [form, setForm] = useState(initial);
  const [open, setOpen] = useState(false);
  const [editingModel, setEditingModel] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  function edit(provider?: CustomProvider, model?: CustomModel) {
    setEditingModel(!!model);
    setForm(provider ? { ...initial, ...provider, model_name: model?.model_name ?? '', cost_input: model ? String(model.cost_input * 1000) : '', cost_output: model ? String(model.cost_output * 1000) : '', max_tokens: model?.max_tokens ? String(model.max_tokens) : '', supports_functions: model?.supports_functions ?? false, quality_rating: String(model?.quality_rating ?? 70), avg_latency: String(model?.avg_latency ?? 2000), strengths: model?.strengths ?? ['chat'] } : initial);
    setKey(''); setError(''); setMessage(''); setOpen(true); setRemoving(null);
  }
  async function save() {
    const providerId = form.provider || `custom-${form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'provider'}`;
    if (!form.provider && providers.some((provider) => provider.provider === providerId)) { setError("This provider already exists. Use Add model or Edit model and key below its name."); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      await saveCustomProvider({ provider: providerId, name: form.name, base_url: form.base_url, ...(key.trim() ? { key: key.trim() } : {}), model: { model_name: form.model_name, cost_input: Number(form.cost_input) / 1000, cost_output: Number(form.cost_output) / 1000, max_tokens: Number(form.max_tokens), supports_functions: form.supports_functions, quality_rating: Number(form.quality_rating), avg_latency: Number(form.avg_latency), strengths: form.strengths } });
      setKey(''); setOpen(false); setMessage('Provider and model saved. Try a prompt in Playground to verify access.'); onChange();
    } catch (err) { setError(describeError(err, 'Could not save provider.')); }
    finally { setBusy(false); }
  }
  async function remove(provider: string) {
    setBusy(true); setError(''); setMessage('');
    try { await removeCustomProvider(provider); setRemoving(null); setMessage('Custom provider, its saved key, and its models removed.'); onChange(); }
    catch (err) { setError(describeError(err, 'Could not remove provider.')); }
    finally { setBusy(false); }
  }
  return <SectionCard title="Use another provider" description="DeepSeek, Moonshot, a local server, or another OpenAI compatible Chat Completions API.">
    <div className="space-y-5">
      {providers.map((provider) => <div key={provider.provider} className="space-y-3 border-b pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold">{provider.name}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{provider.base_url}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => edit(provider)}>Add model</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRemoving(provider.provider); setOpen(false); setKey(''); }}>Remove</Button></div></div>
        <ul className="space-y-1">{provider.models.map((model) => <li key={model.id} className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 break-all font-mono text-xs">{model.model_name}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => edit(provider, model)}>Edit model and key</Button></li>)}</ul>
        {removing === provider.provider && <div className="rounded-lg border border-destructive/30 p-3"><p className="text-sm">Removing {provider.name} also removes its key and models. Request history stays available.</p><div className="mt-3 flex gap-2"><Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove(provider.provider)}>Remove provider</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button></div></div>}
      </div>)}
      {!open ? <Button variant="outline" onClick={() => edit()} disabled={busy}><Plus aria-hidden="true" />Add custom provider</Button> : <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-5 rounded-xl border bg-muted/20 p-4 sm:p-5">
        <p className="text-sm font-semibold">{form.provider ? 'Update provider or add a model' : 'Connect an OpenAI compatible provider'}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="custom-name">Provider name</Label><Input id="custom-name" required maxLength={80} value={form.name} disabled={busy} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. DeepSeek or Moonshot" /></div>
          <div className="space-y-2"><Label htmlFor="custom-url">API base URL</Label><Input id="custom-url" type="url" required value={form.base_url} disabled={busy} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.example.com/v1" /></div>
          <div className="space-y-2"><Label htmlFor="custom-key">API key{form.provider && ", leave blank to keep"}</Label><SecretInput id="custom-key" required={!form.provider} value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="custom-model">Model ID</Label><Input id="custom-model" readOnly={editingModel} required maxLength={200} value={form.model_name} disabled={busy} onChange={(e) => setForm({ ...form, model_name: e.target.value })} placeholder="Exact model ID from your provider" /></div>
          {([['cost_input', "Input USD per million tokens", '0.001', '0', '1000000'], ['cost_output', "Output USD per million tokens", '0.001', '0', '1000000'], ['max_tokens', "Context window in tokens", '1', '1024', '10000000']] as const).map(([field, label, step, min, max]) => <div key={field} className="space-y-2"><Label htmlFor={`custom-${field}`}>{label}</Label><Input id={`custom-${field}`} type="number" required min={min} max={max} step={step} value={form[field]} disabled={busy} onChange={(e) => setForm({ ...form, [field]: e.target.value })} /></div>)}
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={form.supports_functions} disabled={busy} onChange={(e) => setForm({ ...form, supports_functions: e.target.checked })} />This model supports function tools for agent apps</label>
        <p className="text-xs leading-relaxed text-muted-foreground">Use the base URL, model ID, context window, and prices published by the provider. The router appends /chat/completions. Keys are encrypted. Saving makes no provider call.</p>
        <details className="rounded-lg border p-4"><summary className="text-sm font-medium">Routing estimates and task strengths</summary><p className="mt-3 text-xs leading-relaxed text-muted-foreground">These starting estimates affect model selection. Adjust them to match your own evaluation. They are not measured benchmarks.</p><div className="mt-4 grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="custom-quality">Quality estimate from 0 to 100</Label><Input id="custom-quality" type="number" min="0" max="100" required value={form.quality_rating} onChange={(e) => setForm({ ...form, quality_rating: e.target.value })} /></div><div className="space-y-2"><Label htmlFor="custom-latency">Latency estimate in milliseconds</Label><Input id="custom-latency" type="number" min="1" max="600000" required value={form.avg_latency} onChange={(e) => setForm({ ...form, avg_latency: e.target.value })} /></div></div><fieldset className="mt-4"><legend className="text-sm font-medium">Task strengths, choose at least one</legend><div className="mt-2 grid grid-cols-2 gap-x-4 sm:grid-cols-3">{tasks.map((task) => <label key={task} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={form.strengths.includes(task)} onChange={(e) => setForm({ ...form, strengths: e.target.checked ? [...form.strengths, task] : form.strengths.filter((t) => t !== task) })} />{task.replaceAll('_', ' ')}</label>)}</div></fieldset></details>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !form.strengths.length}>{busy ? 'Saving...' : 'Save provider and model'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setOpen(false); setKey(''); setError(''); }}>Cancel</Button></div>
      </form>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {message && <p role="status" className="text-sm text-primary">{message}</p>}
    </div>
  </SectionCard>;
}
