// @vitest-environment happy-dom
/**
 * hooks/useSessionHistory.test.jsx — drives the real filtering logic via renderHook.
 *
 * Two things need shimming under happy-dom + this React build:
 *   1. The zustand store reads state through useSyncExternalStore, which happy-dom
 *      stubs as a non-function subscribe. We replace it with a working shim (all
 *      other react exports are preserved via importOriginal).
 *   2. The store itself calls the API client on mount; autoLoad:false skips that
 *      effect so we never touch the network, and we control state directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// A plain function (NOT inside a component) so babel-plugin-react-compiler does
// not try to treat its hook calls as component hooks and fail to parse.
export function makeUseSyncExternalStore(r) {
  return function subscribeToExternalStore(subscribe, getSnapshot, getServerSnapshot) {
    var st;
    try {
      st = getSnapshot();
    } catch (e) {
      if (getServerSnapshot) st = getServerSnapshot();
      else throw e;
    }
    var force;
    force = r.useState(0);
    r.useEffect(function subscribe() {
      var handle = subscribe(st);
      return typeof handle === 'function' ? handle : undefined;
    }, [st]);
    return st;
  };
}

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal();
  return { ...react, useSyncExternalStore: makeUseSyncExternalStore(react) };
});

const h = vi.hoisted(() => {
  // The real store's state is `{ sessions, capabilities, ... }` — the hook
  // destructures `{ sessions }`, so this mock must mirror that shape (not a flat
  // object) or `sessions` comes back undefined.
  let sessions = {
    items: [],
    filter: { status: null, q: '' },
    status: 'idle',
    unsupported: false,
    capabilities: {},
  };
  const state = { sessions, capabilities: {} };
  return {
    state,
    api: {
      loadSessions: vi.fn(() => Promise.resolve()),
      setSessionFilter: vi.fn((f) => {
        sessions.filter = f;
      }),
      openSession: vi.fn(),
    },
  };
});

vi.mock('../store/queryStore', () => ({
  useQueryStore: () => h.state, // stable reference → useMemo won't thrash
  loadSessions: () => h.api.loadSessions(),
  setSessionFilter: (f) => h.api.setSessionFilter(f),
  openSession: h.api.openSession,
}));

import { useSessionHistory } from './useSessionHistory';

const SEED = [
  { id: 's1', request: 'SELECT * FROM students WHERE gpa > 3.5', status: 'ready' },
  { id: 's2', request: 'JOIN courses ON id', status: 'error' },
  { id: 's3', request: 'SELECT * FROM students WHERE gpa > 4.0', status: 'ready' },
];

beforeEach(() => {
  // Reset the shared store back to a clean slate per test. NOTE: filter must be
  // reset too — an earlier test can drive it to `undefined` (e.g. via a status
  // toggle), and since h.state is a single stable object that leak would otherwise
  // poison every subsequent test in the file.
  h.state.sessions.items = SEED;
  h.state.sessions.filter = { status: null, q: '' };
  h.api.loadSessions.mockClear();
});

describe('useSessionHistory — filter logic (real logic under test)', () => {
  it('returns every session when no term or status is set', async () => {
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    console.log('TEST1 sessions=', JSON.stringify(result.current.sessions), 'filter=', JSON.stringify(result.current.sessions.filter));
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(result.current.all).toHaveLength(3); // all is the unfiltered set
  });

  it('case-insensitively substring-filters on request text', async () => {
    h.state.sessions.filter = { status: null, q: 'GPA' };
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3']); // both mention gpa
  });

  it('ignores surrounding whitespace in the search term', async () => {
    h.state.sessions.filter = { status: null, q: '   ' };
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.sessions).toHaveLength(3);
  });

  it('applies the status filter when one is active', async () => {
    h.state.sessions.filter = { status: 'ready', q: '' };
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3']); // drops the error session
  });

  it('combines term + status filters (AND semantics)', async () => {
    h.state.sessions.filter = { status: 'ready', q: 'gpa' };
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('recomputes the visible list when the store filter changes (immutable update)', async () => {
    const { result, rerender } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.sessions).toHaveLength(3);

    // Mimic the real store's immutable patch: a NEW sessions object identity so
    // useMemo([sessions]) recomputes on the next render.
    h.state.sessions = { ...h.state.sessions, filter: { status: null, q: 'courses' } };
    await rerender();
    expect(result.current.sessions.map((s) => s.id)).toEqual(['s2']);
  });

  it('surfaces store-level status/unsupported flags', async () => {
    h.state.sessions.status = 'loading';
    h.state.sessions.unsupported = true;
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.loading).toBe(true);
    expect(result.current.unsupported).toBe(true);
  });

  it('exposes the raw capabilities from the store', async () => {
    h.state.capabilities = { online: true };
    const { result } = renderHook(() => useSessionHistory({ autoLoad: false }));
    expect(result.current.capabilities.online).toBe(true);
  });

  it('reloads when the search term changes (effect dependency)', async () => {
    const spy = h.api.loadSessions;
    const { result, rerender } = renderHook(
      ({ q }) => useSessionHistory({ autoLoad: true, q }),
      { initialProps: { q: 'a' } },
    );
    expect(spy).toHaveBeenCalledTimes(1);

    await rerender({ q: 'b' });
    expect(spy).toHaveBeenCalledTimes(2); // dependency changed → effect re-ran
  });
});
