import { useCallback, useEffect, useMemo, useState } from 'react';
import { UNREACHABLE, describeError } from './api';
import { SETTINGS_EVENT } from './settings';

type State<T> = { token: object | null; data?: T; error?: string };

export type Resource<T> = {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
};

/**
 * Load data from the API, aborting on unmount, with a manual reload.
 *
 * The loader must be stable, wrapped in useCallback, because its identity is
 * what triggers a refetch. Loading is derived by comparing the request token
 * with the one stored beside the result, which keeps setState out of the effect
 * body.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, options: { refreshInterval?: number } = {}): Resource<T> {
  const [state, setState] = useState<State<T>>({ token: null });
  const [nonce, setNonce] = useState(0);

  const token = useMemo(() => ({ load, nonce }), [load, nonce]);

  useEffect(() => {
    const controller = new AbortController();

    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ token, data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ token, error: describeError(err, UNREACHABLE) });
      });

    return () => controller.abort();
  }, [token, load]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const refresh = () => { if (!document.hidden) reload(); };
    window.addEventListener(SETTINGS_EVENT, reload);
    window.addEventListener('online', refresh);
    const interval = options.refreshInterval ? window.setInterval(refresh, options.refreshInterval) : undefined;
    return () => {
      window.removeEventListener(SETTINGS_EVENT, reload);
      window.removeEventListener('online', refresh);
      window.clearInterval(interval);
    };
  }, [reload, options.refreshInterval]);

  return {
    data: state.token === token ? state.data : undefined,
    error: state.token === token ? state.error : undefined,
    loading: state.token !== token,
    reload,
  };
}
