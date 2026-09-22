import { useId, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The page title. Every page renders exactly one, as its h1. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * One headline figure, as a description list, so a screen reader reads the
 * label with its value rather than two loose spans.
 */
export function StatCard({
  label,
  value,
  hint,
  loading,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="metric">
        <dl aria-busy={loading || undefined}>
          <dt className="flex min-h-7 items-center justify-between gap-2 text-sm font-medium text-muted-foreground">{label}{icon && <span className="metric-icon" aria-hidden="true">{icon}</span>}</dt>
          <dd className="metric-figure mt-3 text-3xl font-semibold tracking-tight tabular-nums">
            {loading ? <Skeleton className="h-9 w-24" /> : value}
          </dd>
          {hint ? <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">{hint}</dd> : null}
        </dl>
    </div>
  );
}

/**
 * Something went wrong and the reader can act on it. Announced immediately,
 * because it replaces content they were waiting for.
 */
export function ErrorPanel({
  message,
  onRetry,
  hint,
}: {
  message: string;
  onRetry?: () => void;
  hint?: string;
}) {
  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardContent className="flex flex-wrap items-start gap-3 p-5" role="alert">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-medium">{message}</p>
          {hint ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
        </div>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Nothing to show yet, which is expected on a fresh install, so it reads as a
 * starting point rather than a failure.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-4 px-4 py-12 text-center">
      {Icon ? (
        <span className="empty-state-mark" aria-hidden="true">
          <Icon className="h-5 w-5" />
        </span>
      ) : null}
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <div className="mx-auto max-w-md text-sm text-muted-foreground">{description}</div>
      </div>
      {children ? <div className="flex flex-wrap justify-center gap-2 pt-1">{children}</div> : null}
    </div>
  );
}

/** A titled region, labelled so it appears in the landmark list. */
export function SectionCard({
  title,
  description,
  children,
  className,
  actions,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={cn('section-panel', className)}
    >
      <div className="section-heading">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold leading-none tracking-tight">
            {title}
          </h2>
          {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

/** A proportion bar, exposed as a meter so its value is announced. */
export function MeterRow({
  label,
  value,
  caption,
  className,
  tone = 'primary',
}: {
  label: string;
  value: number;
  caption?: string;
  className?: string;
  tone?: 'primary' | 'muted';
}) {
  const clamped = Math.min(Math.max(value, 0), 1);
  const percent = Math.round(clamped * 100);

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate">{label}</span>
        <span className="tabular-nums text-muted-foreground">{caption ?? `${percent}%`}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={caption ?? `${percent}%`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full', tone === 'primary' ? 'bg-primary' : 'bg-muted-foreground/40')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Table scaffolding. It scrolls sideways on a small screen, and has a caption. */
export function DataTable({
  caption,
  head,
  children,
  minWidth = '640px',
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
      <table className="data-table" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A header cell. Alignment is a prop, so every table stays consistent. */
export function Th({
  children,
  align = 'left',
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn('py-2 font-medium', align === 'right' ? 'text-right' : 'text-left', className)}
    >
      {children}
    </th>
  );
}

/** Placeholder rows while a table loads, so the layout holds still. */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-3">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className={cn('h-8 flex-1', column === 0 && 'flex-[2]')} />
          ))}
        </div>
      ))}
    </div>
  );
}
