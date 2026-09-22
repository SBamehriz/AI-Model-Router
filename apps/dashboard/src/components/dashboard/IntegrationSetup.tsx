import { openClawConfig } from '@/lib/integration';
import { useState } from 'react';
import { Check, KeyRound, Plug } from 'lucide-react';
import { apiBaseUrl, describeError, generateRouterKey, revokeRouterKey, type IntegrationKey } from '@/lib/api';
import { SectionCard } from '@/components/common/Panels';
import { CopyButton } from '@/components/common/CopyButton';
import { SecretInput } from '@/components/common/SecretInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function IntegrationSetup({ keys, onChange }: { keys: IntegrationKey[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [generated, setGenerated] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copiedKeyNotice, setCopiedKeyNotice] = useState(false);
  const base = `${apiBaseUrl()}/v1`;
  const config = openClawConfig(apiBaseUrl());

  async function generate() {
    setBusy(true); setError(''); setNotice(''); setCopiedKeyNotice(false);
    try { const result = await generateRouterKey(name.trim()); setGenerated(result.key); setName(''); onChange(); }
    catch (err) { setError(describeError(err, 'Could not create a key.')); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError('');
    try { await revokeRouterKey(id); setRevoking(null); setGenerated(''); setNotice('Router key revoked. Apps using it can no longer make new requests.'); onChange(); }
    catch (err) { setError(describeError(err, 'Could not revoke the key.')); }
    finally { setBusy(false); }
  }

  return <SectionCard title="2. Connect your apps" description="Create a router key for OpenClaw or your own system. Your provider keys stay here.">
    <div className="grid min-w-0 grid-cols-1 gap-6 [overflow-wrap:anywhere] lg:grid-cols-2"><div className="min-w-0 space-y-5">
      <div className="rounded-xl border bg-muted/30 p-4"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4 text-primary" aria-hidden="true" />OpenAI compatible connection</div><dl className="space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Base URL</dt><dd className="mt-1 flex items-center justify-between gap-2"><code className="min-w-0 break-all">{base}</code><CopyButton text={base} label="Copy base URL" /></dd></div><div className="flex flex-wrap items-center justify-between gap-3"><dt className="text-xs text-muted-foreground">Model</dt><dd className="flex flex-wrap items-center gap-2"><code>auto</code><CopyButton text="auto" label="Copy model" /></dd></div></dl><p className="mt-3 text-xs leading-relaxed text-muted-foreground">Choose <code>auto-cheap</code> for lower cost or <code>auto-best</code> for quality. Set the client API key to the router key you create below.</p></div>
      {!generated ? <form onSubmit={(event) => { event.preventDefault(); void generate(); }} className="space-y-3"><Label htmlFor="integration-name">Name this connection</Label><Input id="integration-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. OpenClaw on my laptop" maxLength={80} disabled={busy} /><Button type="submit" disabled={busy || !name.trim()}><KeyRound aria-hidden="true" />{busy ? 'Creating...' : 'Create router key'}</Button></form> : <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4"><p className="text-sm font-semibold">Your router key is ready</p><p className="text-xs leading-relaxed text-muted-foreground">Copy it now. This is the only time the full key is shown.</p><SecretInput aria-label="New router key" value={generated} readOnly /><div className="flex flex-wrap gap-2"><CopyButton text={generated} label="Copy router key" /><Button variant="ghost" size="sm" onClick={() => { setGenerated(''); setCopiedKeyNotice(true); }}>I have saved my key</Button></div></div>}
      {copiedKeyNotice && <p role="status" className="flex items-center gap-2 text-sm text-primary"><Check className="h-4 w-4" aria-hidden="true" />Key hidden. Revoke it below if you no longer need it.</p>}
      {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {keys.length > 0 && <ul className="divide-y border-t">{keys.map((key) => <li key={key.id} className="py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="break-words text-sm font-medium">{key.name}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{key.prefix}...</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRevoking(key.id)}>Revoke</Button></div>{revoking === key.id && <div className="mt-3 space-y-3 rounded-lg border border-destructive/30 p-3"><p className="text-xs">Apps using {key.name} will lose access immediately.</p><div className="flex gap-2"><Button variant="destructive" size="sm" disabled={busy} onClick={() => void revoke(key.id)}>Revoke key</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRevoking(null)}>Cancel</Button></div></div>}</li>)}</ul>}
    </div><div className="space-y-4"><div><h3 className="text-sm font-semibold">Use it with OpenClaw</h3><ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-relaxed text-muted-foreground"><li>Save your router key as <code>AI_MODEL_ROUTER_KEY</code> in OpenClaw environment.</li><li>Merge this configuration into <code>~/.openclaw/openclaw.json</code>.</li><li>Restart your OpenClaw gateway and send a message.</li></ol></div><details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">OpenClaw configuration</summary><div className="mt-3 flex justify-end"><CopyButton text={config} label="Copy OpenClaw config" /></div><pre className="code-surface mt-2 max-h-80 text-xs">{config}</pre></details><div className="rounded-xl border p-4"><h3 className="text-sm font-semibold">Where your app runs</h3><p className="mt-2 text-xs leading-6 text-muted-foreground">On this computer, use the base URL above. On another computer or a hosted OpenClaw gateway, use a reachable HTTPS address for this router, through your server or a private tunnel. A remote app localhost points to that remote machine, not yours. Keep the router running while your apps use it.</p></div><p className="text-xs leading-relaxed text-muted-foreground">Text and function tools are supported. Streaming clients receive SSE after the provider completes. Tool routing uses models marked as supporting function tools, including custom providers. Gemini supports text here.</p></div></div>
  </SectionCard>;
}
