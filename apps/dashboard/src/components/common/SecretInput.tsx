import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function SecretInput(props: Omit<ComponentProps<typeof Input>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return <div className="relative"><Input {...props} type={visible ? 'text' : 'password'} autoComplete="off" autoCapitalize="none" spellCheck={false} className={`pr-12 font-mono text-sm ${props.className ?? ''}`} /><Button type="button" size="icon" variant="ghost" className="absolute right-0 top-0 h-11 w-11" aria-label={visible ? 'Hide key' : 'Show key'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>;
}
