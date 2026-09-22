import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { IntroductionPage } from './pages/IntroductionPage';
import { DashboardShell } from './components/dashboard/DashboardShell';
import { TableSkeleton } from './components/common/Panels';

const GuidePage = lazy(() => import('./pages/GuidePage').then((m) => ({ default: m.GuidePage })));
const OverviewPage = lazy(() =>
  import('./pages/dashboard/OverviewPage').then((m) => ({ default: m.OverviewPage }))
);
const PlaygroundPage = lazy(() =>
  import('./pages/dashboard/PlaygroundPage').then((m) => ({ default: m.PlaygroundPage }))
);
const AnalyticsPage = lazy(() =>
  import('./pages/dashboard/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage }))
);
const ModelsPage = lazy(() =>
  import('./pages/dashboard/ModelsPage').then((m) => ({ default: m.ModelsPage }))
);
const RequestLogPage = lazy(() =>
  import('./pages/dashboard/RequestLogPage').then((m) => ({ default: m.RequestLogPage }))
);
const SettingsPage = lazy(() =>
  import('./pages/dashboard/SettingsPage').then((m) => ({ default: m.SettingsPage }))
);

/** Each page is a separate bundle, so each one has its own fallback. */
const fallback = <div className="space-y-6"><div className="h-10 w-48 animate-pulse rounded bg-muted" /><TableSkeleton rows={6} columns={3} /></div>;

export const router = createBrowserRouter([
  {
    element: <DashboardShell />,
    children: [
      { path: '/', element: <IntroductionPage /> },
      { path: '/about', element: <Navigate to="/guide" replace /> },
      { path: '/guide', element: <Suspense fallback={fallback}><GuidePage /></Suspense> },
      { path: '/overview', element: <Suspense fallback={fallback}><OverviewPage /></Suspense> },
      { path: '/playground', element: <Suspense fallback={fallback}><PlaygroundPage /></Suspense> },
      { path: '/analytics', element: <Suspense fallback={fallback}><AnalyticsPage /></Suspense> },
      { path: '/models', element: <Suspense fallback={fallback}><ModelsPage /></Suspense> },
      { path: '/requests', element: <Suspense fallback={fallback}><RequestLogPage /></Suspense> },
      { path: '/settings', element: <Suspense fallback={fallback}><SettingsPage /></Suspense> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
