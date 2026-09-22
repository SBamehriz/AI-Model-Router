import { useState } from 'react';
import { Check, KeyRound, X } from 'lucide-react';
import { describeError, saveProviderKey, removeProviderKey, type SavedProvider } from '@/lib/api';
import { SectionCard } from '@/components/common/Panels';
import { SecretInput } from '@/components/common/SecretInput';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const PROVIDER_NAMES: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', openrouter: 'OpenRouter', groq: 'Groq' };

export function ProviderSetup({ providers, forcedOffline, onChange }: { providers: SavedProvider[]; forcedOffline: boolean; onChange: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  async function save(provider: string) {
    setError(''); setMessage('');
    if (!/^[\x21-\x7e]{8,4096}$/.test(key.trim())) { setError('Paste the full provider key without spaces.'); return; }
    setBusy(true);
    try { await saveProviderKey(provider, key); setKey(''); setEditing(null); setMessage('Key saved securely. Run a prompt in Playground to check your account and model access.'); onChange(); }
    catch (err) { setError(describeError(err, 'Could not save the key.')); }
    finally { setBusy(false); }
  }
  async function remove(provider: string) {
    setBusy(true); setError(''); setMessage('');
    try { await removeProviderKey(provider); setRemoving(null); setMessage('Provider key removed.'); onChange(); }
    catch (err) { setError(describeError(err, 'Could not remove the key.')); }
    finally { setBusy(false); }
  }

  return <SectionCard title="1. Connect your providers" description="Add one or more keys. OpenRouter gives you access to several model families with one key.">
    <ul className="divide-y">{providers.map((provider) => <li key={provider.provider} className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className={`grid h-9 w-9 place-items-center rounded-lg ${provider.configured ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{provider.configured ? <Check className="h-4 w-4" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}</span><div><p className="text-sm font-semibold">{PROVIDER_NAMES[provider.provider]}</p><p className="mt-0.5 text-xs text-muted-foreground">{provider.source === 'environment' ? 'Managed by server environment' : provider.configured ? 'Key saved, ready to try' : 'No key added'}</p></div></div><div className="flex gap-1">{provider.source !== 'environment' && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(provider.provider); setRemoving(null); setKey(''); setError(''); setMessage(''); }}>{provider.configured ? 'Replace key' : 'Add key'}</Button>}{provider.source === 'settings' && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRemoving(provider.provider); setEditing(null); setKey(''); }}>Remove</Button>}</div></div>
      {editing === provider.provider && <form className="mt-4 space-y-3 rounded-lg border bg-muted/30 p-4" onSubmit={(event) => { event.preventDefault(); void save(provider.provider); }}><Label htmlFor={`provider-${provider.provider}`}>{PROVIDER_NAMES[provider.provider]} API key</Label><SecretInput id={`provider-${provider.provider}`} value={key} autoFocus onChange={(event) => { setKey(event.target.value); setError(''); }} placeholder="Paste your provider key" disabled={busy} aria-invalid={!!error} aria-describedby="provider-key-help" /><p id="provider-key-help" className="text-xs leading-relaxed text-muted-foreground">Encrypted on this server. The key is never returned to the browser or included in exports. Saving does not make a paid API call.</p><div className="flex gap-2"><Button type="submit" disabled={busy || !key.trim()}>{busy ? 'Saving...' : 'Save key'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setKey(''); setError(''); }}><X aria-hidden="true" />Cancel</Button></div></form>}
      {removing === provider.provider && <div className="mt-3 rounded-lg border border-destructive/30 p-4"><p className="text-sm">Removing this key makes new requests use your other configured providers.</p><div className="mt-3 flex gap-2"><Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove(provider.provider)}>Remove key</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button></div></div>}
    </li>)}</ul>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="mt-4 text-sm leading-relaxed text-primary">{message}</p>}
    {forcedOffline && <p className="mt-4 rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">This server has offline mode forced on. Set AI_MODEL_ROUTER_OFFLINE=0 or remove that override and restart to use saved keys.</p>}
  </SectionCard>;
}
