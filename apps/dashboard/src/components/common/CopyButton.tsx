import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function CopyButton({ text, label = 'Copy', description }: { text: string; label?: string; description?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus('copied'); } catch { setStatus('error'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus('idle'), 2500);
  }
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal py-2" aria-label={status === 'copied' ? 'Copied' : description} onClick={copy}>{status === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{status === 'copied' ? 'Copied' : label}</Button><span role="status" className={status === 'error' ? 'text-xs text-destructive' : 'sr-only'}>{status === 'error' ? 'Copy unavailable. Select and copy the text manually.' : status === 'copied' ? 'Copied to clipboard' : ''}</span></div>;
}
