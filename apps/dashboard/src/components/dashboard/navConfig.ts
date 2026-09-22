import type { LucideIcon } from 'lucide-react';
import { BookOpen, BarChart3, Cpu, LayoutDashboard, ScrollText, Settings, TerminalSquare } from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Introduction', path: '/', icon: BookOpen, description: 'How requests move through the router' },
  {
    label: 'Overview',
    path: '/overview',
    icon: LayoutDashboard,
    description: 'Usage, spend and provider health',
  },
  {
    label: 'Playground',
    path: '/playground',
    icon: TerminalSquare,
    description: 'Route a prompt and inspect the decision',
  },
  {
    label: 'Analytics',
    path: '/analytics',
    icon: BarChart3,
    description: 'Cost and routing distribution',
  },
  {
    label: 'Models',
    path: '/models',
    icon: Cpu,
    description: 'The catalog the router selects from',
  },
  {
    label: 'Requests',
    path: '/requests',
    icon: ScrollText,
    description: 'Request log with routing decisions',
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: Settings,
    description: 'API connection',
  },
];
