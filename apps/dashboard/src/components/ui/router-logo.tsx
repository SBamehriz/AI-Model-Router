import { useId } from 'react';

/** A branch and the path taken. Decorative, beside the wordmark. */
export function RouterLogo({ className }: { className?: string }) {
  const gradientId = useId();
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22C55E" />
          <stop offset=".5" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      <path d="M9 9v8a6 6 0 0 0 6 6h8M9 17l8-8h6m-3-3 3 3-3 3" stroke="#0B1018" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23" cy="23" r="2" fill="#0B1018" />
    </svg>
  );
}
