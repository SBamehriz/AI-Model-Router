import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { NAV_ITEMS } from './navConfig';

export function DashboardShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const close = useCallback(() => setSidebarOpen(false), []);
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const label = NAV_ITEMS.find((item) => item.path === pathname)?.label ?? 'User guide';
    document.title = `${label}: AI Model Router`;
    mainRef.current?.scrollTo(0, 0);
  }, [pathname]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const resize = () => { if (media.matches) close(); };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [close]);
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a href="#main-content" className="sr-only z-[60] focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-sm focus:text-primary-foreground">Skip to content</a>
      <Sidebar open={sidebarOpen} onClose={close} />
      <div className="flex min-w-0 flex-1 flex-col" inert={sidebarOpen || undefined}>
        <TopBar onMenuClick={() => setSidebarOpen(true)} menuOpen={sidebarOpen} />
        {/* Positioned, so offscreen captions and status text scroll with the page instead of extending the document. */}
        <main ref={mainRef} id="main-content" tabIndex={-1} className="relative flex-1 overflow-y-auto focus:outline-none">
          <div key={pathname} className="workspace-page mx-auto max-w-[1440px] p-4 pb-10 sm:p-8 lg:px-10 lg:py-9"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
