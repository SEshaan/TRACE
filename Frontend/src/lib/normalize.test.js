/**
 * lib/normalize.test.js — DTO→UI contract must never invent a field.
 *
 * Every normalizer is defensive: null in, null (or a safe default) out, and
 * the untouched `raw` payload is always preserved for debugging. These tests
 * lock that contract down so a backend schema change can't silently corrupt
 * what App.jsx renders.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePreview,
  normalizeAction,
  normalizeFailure,
  normalizeCheckpoint,
  normalizeSession,
  normalizeState,
  normalizeResult,
  normalizeAgentStatus,
  normalizeSessionSummary,
} from './normalize';

describe('normalizePreview', () => {
  it('falls back to rows.length when row_count is absent', () => {
    const preview = normalizePreview({ rows: [{ a: 1 }, { a: 2 }] });
    expect(preview.rowCount).toBe(2);
  });

  it('keeps an explicit zero instead of falling back (nullish coalescing)', () => {
    const preview = normalizePreview({ row_count: 0, rows: [] });
    expect(preview.rowCount).toBe(0);
  });

  it('coerces a truthy string to a boolean and drops everything else', () => {
    expect(normalizePreview({ truncated: 'yes' }).truncated).toBe(false);
    expect(normalizePreview({ truncated: true }).truncated).toBe(true);
    expect(normalizePreview({}).truncated).toBe(false);
  });

  it('defaults execution_time_ms to null when the backend omits it', () => {
    expect(normalizePreview({ rows: [] }).executionTimeMs).toBeNull();
    expect(normalizePreview({ execution_time_ms: 12 }).executionTimeMs).toBe(12);
  });

  it('never mutates the incoming payload', () => {
    const raw = { rows: [{ a: 1 }], row_count: 5 };
    normalizePreview(raw);
    expect(raw.rowCount).toBeUndefined(); // no camelCase alias leaked back in
  });

  it('returns null for missing/empty input and preserves the sentinel', () => {
    expect(normalizePreview(null)).toBeNull();
    expect(normalizePreview(undefined)).toBeNull();
    expect(normalizePreview({})).not.toBeNull(); // empty object is still "present"
  });
});

describe('normalizeAction', () => {
  it('coerces confidence to a number and null otherwise', () => {
    const action = normalizeAction({ action_type: 'FILTER', column: 'gpa', confidence: 0.9 });
    expect(action.type).toBe('FILTER');
    expect(action.confidence).toBe(0.9);
    expect(action.params.column).toBe('gpa');

    const badConf = normalizeAction({ action_type: 'LIMIT', limit: 5, confidence: 'high' });
    expect(badConf.confidence).toBeNull();
  });

  it('defaults a missing type to null and keeps the raw payload', () => {
    const action = normalizeAction({ column: 'gpa' });
    expect(action.type).toBeNull();
    expect(action.params.column).toBe('gpa');
    expect(action.raw.action_type).toBeUndefined();
  });

  it('returns null for falsy input', () => {
    expect(normalizeAction(null)).toBeNull();
    expect(normalizeAction(undefined)).toBeNull();
  });
});

describe('normalizeFailure / normalizeCheckpoint / normalizeSession', () => {
  it('fills sensible defaults and preserves raw on failure', () => {
    const failure = normalizeFailure({ action_type: 'FILTER', code: 'PREFLIGHT', message: 'bad column' });
    expect(failure.actionType).toBe('FILTER');
    expect(failure.code).toBe('PREFLIGHT');
    expect(failure.message).toBe('bad column');
    expect(failure.stateId).toBeNull(); // state_id omitted → null, not ''
  });

  it('defaults checkpoint label and id to null', () => {
    const cp = normalizeCheckpoint({});
    expect(cp.id).toBeNull();
    expect(cp.label).toBeNull();
    expect(cp.raw).toEqual({});
  });

  it('pulls every documented session field with snake_case fallbacks', () => {
    const session = normalizeSession({ id: 's1', status: 'completed' });
    expect(session.id).toBe('s1');
    expect(session.status).toBe('completed');
    expect(session.rootStateId).toBeNull();
    expect(session.modelVersion).toBeNull();
  });

  it('returns null for falsy input across the board', () => {
    expect(normalizeFailure(null)).toBeNull();
    expect(normalizeCheckpoint(undefined)).toBeNull();
    expect(normalizeSession({})).not.toBeNull(); // present but empty → still an object
  });
});

describe('normalizeState — terminal status & transition aliases', () => {
  const state = {
    id: 'st-1',
    parent_id: 'st-0',
    status: 'completed',
    action_count: 3,
    sql: 'SELECT * FROM students',
    preview: { rows: [{ a: 1 }], row_count: 7 },
  };

  it('flags terminal states (failed | completed) and rejects in_progress', () => {
    expect(normalizeState(state).isTerminal).toBe(true);
    expect(normalizeState({ ...state, status: 'in_progress' }).isTerminal).toBe(false);
    expect(normalizeState({ ...state, status: 'started' }).isTerminal).toBe(false);
  });

  it('exposes snake_case aliases App.jsx still binds to', () => {
    const normalized = normalizeState(state);
    expect(normalized.parent_id).toBe('st-0');
    expect(normalized.action_count).toBe(3);
    // row_count is derived from the preview's rowCount, not the raw payload
    expect(normalized.row_count).toBe(7);
    expect(normalized.execution_time_ms).toBeNull();
  });

  it('normalizes a nested action and preview independently', () => {
    const normalized = normalizeState({ ...state, action: { action_type: 'LIMIT', limit: 10 } });
    expect(normalized.action.type).toBe('LIMIT');
    expect(normalized.preview.rowCount).toBe(7);
  });

  it('keeps the decision block only when a decision is present', () => {
    const withDecision = normalizeState({ ...state, decision: { confidence: 0.8 } });
    expect(withDecision.decision.confidence).toBe(0.8);

    const withoutDecision = normalizeState(state);
    expect(withoutDecision.decision).toBeNull();
  });

  it('returns null for falsy input', () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState(undefined)).toBeNull();
  });
});

describe('normalizeResult — rowCount & sql fallbacks', () => {
  it('falls back to rows.length when row_count is missing', () => {
    const result = normalizeResult({ rows: [{ a: 1 }, { a: 2 }] });
    expect(result.rowCount).toBe(2);
  });

  it('prefers display_sql, then sql, for the displayed statement', () => {
    expect(normalizeResult({ display_sql: 'SELECT 1' }).sql).toBe('SELECT 1');
    expect(normalizeResult({ sql: 'SELECT 2' }).sql).toBe('SELECT 2');
    expect(normalizeResult({}).sql).toBeNull();
  });

  it('preserves total_actions and model_version when present', () => {
    const result = normalizeResult({ rows: [], total_actions: 4, model_version: 'ornith-1.5' });
    expect(result.totalActions).toBe(4);
    expect(result.modelVersion).toBe('ornith-1.5');
  });

  it('returns null for falsy input', () => {
    expect(normalizeResult(null)).toBeNull();
    expect(normalizeResult(undefined)).toBeNull();
  });
});

describe('normalizeAgentStatus / normalizeSessionSummary', () => {
  it('lists registered agents as an array and defaults to empty', () => {
    const status = normalizeAgentStatus({ active_agent: 'ornith', model_name: 'm' });
    expect(status.agent).toBe('ornith');
    expect(status.registered).toEqual([]);
  });

  it('counts states and flags failures in the summary', () => {
    const summary = normalizeSessionSummary({ id: 's1', state_count: 3, has_failure: true });
    expect(summary.stateCount).toBe(3);
    expect(summary.hasFailure).toBe(true);
    // request defaults to an empty string, not null
    expect(summary.request).toBe('');
  });
});
