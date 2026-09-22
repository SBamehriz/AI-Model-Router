import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { ArrowUpRight, BookOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './navConfig';
import { RouterLogo } from '@/components/ui/router-logo';
import { Button } from '@/components/ui/button';

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Making the page inert can blur the opener before this effect runs.
    const previous = document.getElementById('navigation-toggle');
    const focusFrame = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(navRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!navRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
      requestAnimationFrame(() => previous?.focus());
    };
  }, [open, onClose]);

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={onClose} aria-hidden="true" />}
      <aside ref={navRef} id="workspace-navigation" aria-label="Router navigation" role={open ? 'dialog' : undefined} aria-modal={open || undefined}
        onTransitionEnd={(event) => {
          if (open && event.target === navRef.current && !navRef.current.contains(document.activeElement)) closeRef.current?.focus({ preventScroll: true });
        }}
        className={cn('workspace-sidebar fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r bg-sidebar transition-transform duration-200 lg:static lg:z-auto lg:w-[232px]', open ? 'visible translate-x-0' : 'invisible -translate-x-full lg:visible lg:translate-x-0')}>
        <div className="flex h-20 shrink-0 items-center justify-between px-6">
          <NavLink to="/" onClick={onClose} aria-label="AI Model Router home" className="brand-home flex items-center gap-2.5 rounded-md">
            <RouterLogo className="brand-mark h-9 w-9 shrink-0" />
            <span className="brand-wordmark text-[15px] font-semibold leading-tight tracking-tight">AI Model<br />Router</span>
          </NavLink>
          <Button ref={closeRef} variant="ghost" size="icon" className="lg:hidden" onClick={onClose} aria-label="Close navigation"><X aria-hidden="true" /></Button>
        </div>
        <nav aria-label="Main navigation" className="flex-1 px-3 pt-6">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => <li key={item.path}>
              <NavLink end to={item.path} onClick={onClose} title={item.description}
                className={({ isActive }) => cn('workspace-nav-link group flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors', isActive ? 'font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                {({ isActive }) => <><item.icon className="h-[18px] w-[18px]" strokeWidth={1.7} aria-hidden="true" /><span>{item.label}</span>{isActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}</>}
              </NavLink>
            </li>)}
          </ul>
        </nav>
        <div className="space-y-4 p-5">
          <NavLink to="/guide" onClick={onClose} className="flex min-h-11 items-center gap-3 rounded-md text-sm text-muted-foreground hover:text-foreground"><BookOpen className="h-4 w-4" aria-hidden="true" />User guide<ArrowUpRight className="ml-auto h-3.5 w-3.5" aria-hidden="true" /></NavLink>
          <div className="border-t pt-4 text-xs leading-relaxed text-muted-foreground"><p className="font-medium text-foreground">Your models. Your control.</p><p className="mt-1">Built by Salim Ba Mehriz</p></div>
        </div>
      </aside>
    </>
  );
}
