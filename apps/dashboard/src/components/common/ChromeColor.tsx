import { useEffect } from 'react';
import { useTheme } from 'next-themes';

/** The two page backgrounds, which is what a phone's browser chrome should match. */
const CHROME = { dark: '#0E1015', light: '#F6F7F9' } as const;

/**
 * The pre-paint script in index.html sets the browser chrome colour for the
 * first frame. This keeps it matched when the theme changes afterwards, from
 * the toggle or from the system, since the provider only manages the class.
 */
export function ChromeColor() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme !== 'dark' && resolvedTheme !== 'light') return;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[resolvedTheme]);
  }, [resolvedTheme]);
  return null;
}
