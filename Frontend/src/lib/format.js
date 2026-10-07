/**
 * lib/format.js
 * ---------------------------------------------------------------------------
 * Presentation formatters. Pure, no React, no network.
 *
 * The rule that matters: **a value the backend never reported renders as '—',
 * never as a guess.** Every formatter here returns null / EMPTY for missing
 * input so components can show "not reported" instead of a fake number.
 * ---------------------------------------------------------------------------
 */

import { describeAction } from './actions';

/** The "we don't know" glyph. One place, so the UI is consistent. */
export const EMPTY = '—';

/** Null-ish check shared by every formatter below. */
function missing(value) {
  return value === null || value === undefined || value === '';
}

/**
 * 0.94 -> '94%', 94 -> '94%', null -> null (UI shows "not reported").
 */
export function formatConfidence(value) {
  const ratio = confidenceRatio(value);
  return ratio === null ? null : `${Math.round(ratio * 100)}%`;
}

/**
 * 0.94 -> 0.94, 94 -> 0.94 — the 0..1 ratio a meter bar needs.
 *
 * Ambiguity rule: the backend reports 0-1, so anything above 1 is read as a
 * percentage (1.4 -> 1.4%). Clamped to [0, 1].
 */
export function confidenceRatio(value) {
  if (missing(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ratio = n <= 1 ? n : n / 100;
  return Math.min(1, Math.max(0, ratio));
}

/** Colour ramp for the confidence meter. */
export function confidenceTone(value) {
  const ratio = confidenceRatio(value);
  if (ratio === null) return 'neutral';
  if (ratio < 0.6) return 'danger';
  if (ratio < 0.8) return 'warn';
  return 'good';
}

/** 1234.56 -> '1,235 ms' */
export function formatMs(ms) {
  if (missing(ms)) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return `${formatNumber(n)} ms`;
}

/** 3 -> '3 rows', 1 -> '1 row' */
export function formatRows(count) {
  if (missing(count)) return null;
  const n = Number(count);
  if (!Number.isFinite(n)) return null;
  return `${formatNumber(n)} ${n === 1 ? 'row' : 'rows'}`;
}

/** 12345 -> '12,345' (integers only; floats keep up to 2 decimals). */
export function formatNumber(value) {
  if (missing(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Human label for a parameter key: `left_on` -> 'Left on'. */
export function formatParamName(name) {
  return String(name ?? '')
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * A parameter value as one display line. Numbers stay bare, strings keep
 * their quotes, objects/arrays become compact JSON.
 */
export function formatParamValue(value) {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const SQL_PREFIX = /^(FROM|SELECT|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\s+/;

/**
 * 'FILTER {column:'gpa',operator:'>',value:8.5}' -> 'FILTER gpa > 8.5'
 *
 * describeAction() emits the SQL fragment ('WHERE gpa > 8.5'); the leading
 * keyword is redundant next to the action name, so it is stripped.
 */
export function formatActionLabel(actionType, parameters) {
  if (missing(actionType)) return EMPTY;
  const type = String(actionType);
  if (parameters === null || parameters === undefined) return type;
  const described = describeAction(type, parameters ?? {});
  if (!described) return type;
  const body = described.replace(SQL_PREFIX, '').replace(/\bundefined\b/g, '?');
  return body && body !== described ? `${type} ${body}` : `${type} · ${described}`;
}

/** SQL for the viewer; never null so <pre> never renders 'null'. */
export function formatSql(sql) {
  const text = String(sql ?? '').trim();
  return text || 'No SQL compiled for this state.';
}

/** Table cell: null -> '∅' so an empty cell is visibly empty. */
export function cellValue(value) {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** '2m ago' | '3h ago' | 'just now' — 'invalid' for unparseable input. */
export function relativeTime(iso, now = Date.now()) {
  if (missing(iso)) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** 'completed' -> 'Completed' (backend vocabulary -> UI copy). */
export function formatStatus(status) {
  if (missing(status)) return EMPTY;
  return String(status)
    .toLowerCase()
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * CSV export for the results table. Quotes fields containing , " or newline
 * and doubles inner quotes — enough for Excel/Sheets.
 */
export function toCsv(columns = [], rows = []) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(escape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(row?.[c])).join(','));
  return lines.join('\r\n');
}
