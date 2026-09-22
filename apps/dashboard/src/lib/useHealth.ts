import { useCallback } from 'react';
import { fetchHealth } from './api';
import { useResource } from './useResource';

export function useHealth() {
  const load = useCallback((signal: AbortSignal) => fetchHealth(signal), []);
  return useResource(load, { refreshInterval: 30_000 });
}
