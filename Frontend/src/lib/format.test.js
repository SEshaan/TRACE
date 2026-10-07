/**
 * lib/format.test.js — presentation formatters must never invent a value.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY,
  cellValue,
  confidenceRatio,
  confidenceTone,
  formatActionLabel,
  formatConfidence,
  formatMs,
  formatNumber,
  formatParamName,
  formatParamValue,
  formatRows,
  formatSql,
  formatStatus,
  relativeTime,
  toCsv,
} from './format';

describe('formatConfidence / confidenceRatio / confidenceTone', () => {
  it('accepts both 0-1 and 0-100 scales', () => {
    expect(formatConfidence(0.94)).toBe('94%');
    expect(formatConfidence(94)).toBe('94%');
    expect(confidenceRatio(94)).toBe(0.94);
  });

  it('reads anything above 1 as a percentage and clamps', () => {
    expect(confidenceRatio(1.4)).toBe(0.014);
    expect(confidenceRatio(140)).toBe(1);
    expect(confidenceRatio(-2)).toBe(0);
  });

  it('reports nothing when the backend reported nothing', () => {
    expect(formatConfidence(null)).toBeNull();
    expect(formatConfidence(undefined)).toBeNull();
    expect(confidenceRatio('nope')).toBeNull();
    expect(confidenceTone(null)).toBe('neutral');
  });

  it('drives the colour ramp', () => {
    expect(confidenceTone(0.42)).toBe('danger');
    expect(confidenceTone(0.7)).toBe('warn');
    expect(confidenceTone(0.91)).toBe('good');
  });
});

describe('numbers, rows, latency', () => {
  it('groups thousands', () => {
    expect(formatNumber(12345)).toBe('12,345');
    expect(formatMs(1234.56)).toBe('1,234.56 ms');
  });

  it('pluralises rows', () => {
    expect(formatRows(1)).toBe('1 row');
    expect(formatRows(42)).toBe('42 rows');
  });

  it('returns null for missing numbers so the UI can show a dash', () => {
    expect(formatMs(null)).toBeNull();
    expect(formatRows(undefined)).toBeNull();
    expect(formatNumber('')).toBeNull();
  });
});

describe('parameter display', () => {
  it('humanises snake_case keys', () => {
    expect(formatParamName('left_on')).toBe('Left On');
    expect(formatParamName('join_type')).toBe('Join Type');
    expect(formatParamName('table')).toBe('Table');
  });

  it('keeps numbers bare and objects as JSON', () => {
    expect(formatParamValue(8.5)).toBe('8.5');
    expect(formatParamValue('gpa')).toBe('gpa');
    expect(formatParamValue([1, 2])).toBe('[1,2]');
    expect(formatParamValue(null)).toBe(EMPTY);
  });
});

describe('formatActionLabel', () => {
  it('drops the redundant SQL keyword', () => {
    expect(formatActionLabel('FILTER', { column: 'gpa', operator: '>', value: 8.5 })).toBe(
      'FILTER gpa > 8.5',
    );
    expect(formatActionLabel('SELECT_TABLE', { table: 'Student' })).toBe('SELECT_TABLE Student');
    expect(formatActionLabel('LIMIT', { limit: 5 })).toBe('LIMIT 5');
  });

  it('handles null params without throwing', () => {
    expect(formatActionLabel('FILTER')).toBe('FILTER');
    expect(formatActionLabel('FILTER', {})).toBe('FILTER ? ? ?');
    expect(formatActionLabel(null)).toBe(EMPTY);
  });
});

describe('cells, sql, status, time', () => {
  it('marks null cells visibly', () => {
    expect(cellValue(null)).toBe('∅');
    expect(cellValue(0)).toBe('0');
    expect(cellValue('Alice')).toBe('Alice');
  });

  it('never renders a bare null SQL block', () => {
    expect(formatSql(null)).toBe('No SQL compiled for this state.');
    expect(formatSql('  SELECT 1 ')).toBe('SELECT 1');
  });

  it('title-cases backend statuses', () => {
    expect(formatStatus('completed')).toBe('Completed');
    expect(formatStatus('in_progress')).toBe('In Progress');
  });

  it('renders relative time from an ISO stamp', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relativeTime('2026-01-01T11:58:00Z', now)).toBe('2m ago');
    expect(relativeTime('2026-01-01T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2025-12-30T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('not a date', now)).toBeNull();
    expect(relativeTime(null, now)).toBeNull();
  });
});

describe('toCsv', () => {
  it('quotes fields that would break the format', () => {
    const csv = toCsv(['name', 'note'], [{ name: 'Ann, "A"', note: null }, { name: 'Bo', note: 2 }]);
    expect(csv).toBe('name,note\r\n"Ann, ""A""",\r\nBo,2');
  });
});
