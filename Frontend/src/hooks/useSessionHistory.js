/**
 * hooks/useSessionHistory.js
 * ---------------------------------------------------------------------------
 * Past sessions from the backend trace store.
 *
 * Degrades: when GET /queries is not implemented in this backend build the
 * hook reports `unsupported: true` instead of throwing, so the sidebar can
 * render "history unavailable".
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo } from 'react';
import { useQueryStore, loadSessions, setSessionFilter, openSession } from '../store/queryStore';

export function useSessionHistory({ autoLoad = true, status = null, q = '' } = {}) {
  const { sessions, capabilities } = useQueryStore();

  useEffect(() => {
    if (autoLoad) loadSessions();
  }, [autoLoad]);

  const visible = useMemo(() => {
    const term = (sessions.filter.q ?? '').trim().toLowerCase();
    return sessions.items.filter((item) => {
      if (sessions.filter.status && item.status !== sessions.filter.status) return false;
      if (term && !String(item.request ?? '').toLowerCase().includes(term)) return false;
      return true;
    });
  }, [sessions]);

  return {
    sessions: visible,
    all: sessions.items,
    status: sessions.status, // idle | loading | ready | error
    loading: sessions.status === 'loading',
    unsupported: sessions.unsupported,
    filter: sessions.filter,
    refresh: loadSessions,
    setFilter: (next = {}) => {
      setSessionFilter(next);
      return loadSessions(next);
    },
    openSession,
    capabilities,
  };
}
