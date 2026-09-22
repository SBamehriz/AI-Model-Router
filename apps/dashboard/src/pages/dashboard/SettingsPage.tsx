import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Laptop, LockKeyhole, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { apiBaseUrl, apiKey, describeError, fetchRouterSettings, saveSettings, type RouterSettings } from '@/lib/api';
import { normalizeBaseUrl } from '@/lib/settings';
import { useHealth } from '@/lib/useHealth';
import { PageHeader, SectionCard } from '@/components/common/Panels';
import { SecretInput } from '@/components/common/SecretInput';
import { CopyButton } from '@/components/common/CopyButton';
import { CustomProviderSetup } from '@/components/dashboard/CustomProviderSetup';
import { ProviderSetup } from '@/components/dashboard/ProviderSetup';
import { IntegrationSetup } from '@/components/dashboard/IntegrationSetup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

export function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState(apiBaseUrl());
  const [key, setKey] = useState(apiKey());
  const [settings, setSettings] = useState<RouterSettings | null>(null);
  // A stored key is known before the first paint; whether it still works is
  // not. Rendering the unlock form for that gap told a returning administrator
  // they were locked out for as long as the round trip took, then swapped in a
  // banner a fraction of the height and moved everything on the page.
  const [checking, setChecking] = useState(() => Boolean(apiKey()));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const health = useHealth();
  const { theme, setTheme } = useTheme();

  const refreshSettings = useCallback(async (): Promise<boolean> => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    try {
      const result = await fetchRouterSettings(next.signal);
      if (!next.signal.aborted) { setSettings(result); setError(''); }
      return true;
    } catch (err) {
      if (!next.signal.aborted) { setSettings(null); setError(describeError(err, 'Could not load Settings.')); }
      return false;
    }
  }, []);

  useEffect(() => {
    const initial = new AbortController();
    controller.current = initial;
    if (apiKey()) fetchRouterSettings(initial.signal).then((result) => {
      if (!initial.signal.aborted) { setSettings(result); setChecking(false); }
    }).catch((err: unknown) => {
      if (!initial.signal.aborted) { setError(describeError(err, 'Could not load Settings.')); setChecking(false); }
    });
    return () => controller.current?.abort();
  }, []);

  async function unlock() {
    setError('');
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!key.trim()) { setError('Paste the administrator key from npm run admin:key.'); return; }
      saveSettings({ baseUrl: normalized, key }); setBaseUrl(normalized);
      setBusy(true);
      // A key that was just refused should not stay in this tab's session.
      if (!(await refreshSettings())) saveSettings({ key: '' });
    } catch (err) { setError(err instanceof Error ? err.message : 'Enter a valid API address.'); }
    finally { setBusy(false); }
  }

  function lock() {
    controller.current?.abort();
    saveSettings({ key: '' }); setKey(''); setSettings(null); setError('');
  }

  function changed() { void refreshSettings(); health.reload(); }

  return <div className="space-y-6">
    <PageHeader title="Settings" description="Your providers. A router key for each app." actions={<Button asChild variant="outline"><Link to="/guide">How to use<ArrowRight aria-hidden="true" /></Link></Button>} />
    {checking && !settings ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4" aria-busy="true"><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-primary/50" aria-hidden="true" /><div><p className="text-sm font-medium">Checking the stored administrator key</p><p className="mt-1 text-xs text-muted-foreground">{baseUrl}</p></div></div><Skeleton className="h-9 w-32" /></div>
    : settings ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-5 py-4"><div className="flex items-center gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" /><div><p className="text-sm font-medium">Settings unlocked</p><p className="mt-1 break-all text-xs text-muted-foreground">{baseUrl}. Administrator key kept for this tab session.</p></div></div><Button variant="ghost" size="sm" onClick={lock}><LockKeyhole aria-hidden="true" />Lock Settings</Button></div> : <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,1fr)]"><SectionCard title="Unlock Settings" description="Only the person running this router can change providers and create router keys."><form onSubmit={(event) => { event.preventDefault(); void unlock(); }} className="space-y-5"><div className="space-y-2"><Label htmlFor="admin-key">Administrator key</Label><SecretInput id="admin-key" value={key} onChange={(event) => { setKey(event.target.value); setError(''); }} placeholder="Paste the administrator key" disabled={busy} aria-describedby="admin-key-help" /><p id="admin-key-help" className="text-xs leading-relaxed text-muted-foreground">In another terminal, from this project folder, run the command below and paste its key here.</p><div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2"><code className="text-sm">npm run admin:key</code><CopyButton text="npm run admin:key" label="Copy command" /></div></div><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">Router address <span className="ml-1 break-all text-xs text-muted-foreground">{baseUrl}</span></summary><div className="mt-4 space-y-2"><Label htmlFor="base-url">API base URL</Label><Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} inputMode="url" className="font-mono text-sm" /><p className="text-xs leading-relaxed text-muted-foreground">Use this instance origin, without /v1. A remote router requires HTTPS. On a hosted server, use the AI_MODEL_ROUTER_ADMIN_KEY secret configured by its owner.</p></div></details>{error && <p role="alert" className="text-sm leading-relaxed text-destructive">{error}</p>}<Button type="submit" disabled={busy || !key.trim()}><LockKeyhole aria-hidden="true" />{busy ? 'Unlocking...' : 'Unlock Settings'}</Button></form></SectionCard><SectionCard title="From provider to app" description="Set up once. Keep your integrations simple."><ol className="space-y-6">{[['01', 'Add a provider key', "Use a built in provider or add an OpenAI compatible API. Keys are encrypted on the server."], ['02', 'Create a router key', 'Give each app its own key. Revoke one connection without changing your provider keys.'], ['03', 'Connect and try it', 'Copy the base URL and model name into OpenClaw or another compatible client.']].map(([number, title, text]) => <li key={number} className="flex gap-4"><span className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-primary">{number}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p></div></li>)}</ol></SectionCard></div>}
    {checking && !settings && <>
      {/* The three sections below take about twelve hundred pixels once the
          server answers. Rendering nothing until then moved everything after
          them by that much on every load, a layout shift of 0.23 where 0.1 is
          already poor. These hold the same frames at the same heights, so
          the page arrives in place and only the insides change. */}
      <SectionCard title="1. Connect your providers" description="Add one or more keys. OpenRouter gives you access to several model families with one key."><div aria-busy="true" className="space-y-4"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-2/3" /></div></SectionCard>
      <SectionCard title="Use another provider" description="DeepSeek, Moonshot, a local server, or another OpenAI compatible Chat Completions API."><Skeleton aria-busy="true" className="h-11 w-48" /></SectionCard>
      <SectionCard title="2. Connect your apps" description="Create a router key for OpenClaw or your own system. Your provider keys stay here."><div aria-busy="true" className="space-y-4"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-1/2" /></div></SectionCard>
    </>}
    {settings && <><ProviderSetup providers={settings.providers.filter((p) => !p.provider.startsWith('custom-'))} forcedOffline={settings.forced_offline} onChange={changed} /><CustomProviderSetup providers={settings.custom_providers} onChange={changed} /><IntegrationSetup keys={settings.keys} onChange={changed} /><div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5"><div><p className="text-sm font-semibold">3. Try a request</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Run a prompt to check provider access, then inspect the saved route in Requests. Live calls use your provider balance.</p></div><Button asChild><Link to="/playground">Open Playground<ArrowRight aria-hidden="true" /></Link></Button></div></>}
    {/* Rendered once the key check settles. A refused key swaps the held frames
        above for the unlock form, which is shorter, and this grid would be
        pulled up into view with them; arriving with the answer instead, it is
        an insertion below what the reader is looking at, not a move. */}
    {!checking && <div className="grid items-start gap-6 lg:grid-cols-2"><SectionCard title="Instance status" description="Read from the connected API.">{health.loading && <Skeleton className="h-20" />}{health.error && <p className="text-sm text-destructive" role="alert">Could not reach {apiBaseUrl()}. Start the server with npm run dev, or check the router address above.</p>}{health.data && <dl className="space-y-3 text-sm">{[['Connection', 'Connected'], ['Completions', health.data.offline_mode ? 'Simulated locally' : 'Live providers'], ['API access', health.data.auth_required ? 'Key required' : 'Open local demo']].map(([label, value]) => <div key={label} className="flex flex-wrap items-center justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="flex items-center gap-2 font-medium">{label === 'Connection' && <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}{value}</dd></div>)}</dl>}</SectionCard><SectionCard title="Appearance" description="Choose a theme for this browser."><div className="segmented" role="group" aria-label="Color theme">{[{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Laptop }].map((item) => <Button size="sm" key={item.value} variant="ghost" aria-pressed={theme === item.value} onClick={() => setTheme(item.value)}><item.icon aria-hidden="true" />{item.label}</Button>)}</div></SectionCard></div>}
  </div>;
}
