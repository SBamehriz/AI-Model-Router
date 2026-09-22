import { Link, useLocation } from 'react-router-dom';
import { CircleHelp, Menu, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useHealth } from '@/lib/useHealth';
import { NAV_ITEMS } from './navConfig';
import { Button } from '@/components/ui/button';

/** The guide topic that answers questions about each page. */
const HELP_TOPIC: Record<string, string> = {
  '/settings': 'providers',
  '/models': 'providers',
  '/overview': 'dashboard',
  '/playground': 'dashboard',
  '/analytics': 'dashboard',
  '/requests': 'dashboard',
};

export function TopBar({ onMenuClick, menuOpen }: { onMenuClick: () => void; menuOpen: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const { pathname } = useLocation();
  const health = useHealth();
  const label = NAV_ITEMS.find((item) => item.path === pathname)?.label ?? (pathname === '/' ? 'Introduction' : 'User guide');
  const status = health.data ? (health.data.offline_mode ? 'Offline mode' : 'API connected') : health.error ? 'API unreachable' : 'Connecting...';
  return (
    <header className="workspace-topbar flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-card/80 px-4 backdrop-blur-xl sm:px-8">
      <div className="flex min-w-0 items-center gap-3 text-sm">
        <Button id="navigation-toggle" variant="ghost" size="icon" className="lg:hidden" onClick={onMenuClick} aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="workspace-navigation"><Menu aria-hidden="true" /></Button>
        <span className="truncate font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-2 sm:gap-5">
        <Button asChild variant="ghost" size="icon" className="hidden sm:inline-flex"><Link to={`/guide?topic=${HELP_TOPIC[pathname] ?? 'start'}`} aria-label="Help for this page"><CircleHelp aria-hidden="true" /></Link></Button>
        <Link to="/settings" className="connection-pill flex min-h-9 items-center gap-2 text-xs text-muted-foreground" aria-label={`Connection settings: ${status}`}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${health.error ? 'bg-destructive' : health.data && !health.data.offline_mode ? 'bg-primary' : 'bg-muted-foreground'}`} aria-hidden="true" />{status}
        </Link>
        <span className="h-5 border-l" aria-hidden="true" />
        <Button variant="ghost" size="icon" aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
          {resolvedTheme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
        </Button>
      </div>
    </header>
  );
}
