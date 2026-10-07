import { describe, it, expect, afterEach } from 'vitest';
import {
  buildActionPayload,
  describeAction,
  normalizeActionInput,
  parseFilterText,
  preflightValidate,
  actionSignature,
} from './actions';
import { API_ERROR } from '../api/errors';
import { setSchema, clearSchema } from './schema';

// The schema cache is module-level state; keep tests isolated.
afterEach(() => clearSchema());

describe('normalizeActionInput', () => {
  it('accepts the loose shapes the app produces', () => {
    expect(normalizeActionInput('FILTER', { column: 'gpa' })).toEqual({
      action_type: 'FILTER',
      parameters: { column: 'gpa' },
    });
    expect(normalizeActionInput({ action: 'filter', params: { column: 'gpa' } }).action_type).toBe('FILTER');
    expect(normalizeActionInput({ type: 'LIMIT', parameters: { limit: 5 } })).toEqual({
      action_type: 'LIMIT',
      parameters: { limit: 5 },
    });
  });

  it('never returns a non-object parameters', () => {
    expect(normalizeActionInput('FILTER', 'GPA > 8.5').parameters).toEqual({});
    expect(normalizeActionInput({ action_type: 'FILTER', parameters: 'GPA > 8.5' }).parameters).toEqual({});
  });
});

describe('buildActionPayload', () => {
  it('produces the exact body the backend expects', () => {
    expect(buildActionPayload('FILTER', { column: 'gpa', operator: '>', value: 8.5 })).toEqual({
      action_type: 'FILTER',
      parameters: { column: 'gpa', operator: '>', value: 8.5 },
    });
  });

  it('keeps numeric values numeric (SQL compares them)', () => {
    const { parameters } = buildActionPayload('FILTER', { column: 'gpa', operator: '>', value: 8.5 });
    expect(typeof parameters.value).toBe('number');
  });

  it('keeps IN lists as lists', () => {
    const { parameters } = buildActionPayload('FILTER', { column: 'name', operator: 'IN', value: ['Alice', 'Bob'] });
    expect(parameters.value).toEqual(['Alice', 'Bob']);
  });

  it('drops the value for IS NULL operators', () => {
    const payload = buildActionPayload('FILTER', { column: 'gpa', operator: 'IS NULL', value: 'ignored' });
    expect(payload.parameters).toEqual({ column: 'gpa', operator: 'IS NULL' });
  });

  it('rejects an action type the backend does not know, before the network', () => {
    let error = null;
    try {
      buildActionPayload('ADD_FILTER', { column: 'gpa' });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect(error.code).toBe(API_ERROR.INVALID_ACTION);
    expect(error.message).toContain('ADD_FILTER');
  });

  it('rejects a string parameters object (the 422 producer)', () => {
    let error = null;
    try {
      buildActionPayload({ action_type: 'FILTER', parameters: 'GPA > 8.5' });
    } catch (err) {
      error = err;
    }
    expect(error.code).toBe(API_ERROR.PREFLIGHT);
    expect(error.fields).toContain('column');
  });

  it('drops fields the backend does not accept', () => {
    const payload = buildActionPayload('SELECT_TABLE', { table: 'students', confidence: 0.9, nonsense: true });
    expect(payload.parameters).toEqual({ table: 'students' });
  });

  it('applies documented defaults', () => {
    expect(buildActionPayload('ORDER_BY', { column: 'gpa' }).parameters.direction).toBe('ASC');
    expect(buildActionPayload('JOIN', { table: 'courses', left_on: 'department_id', right_on: 'department_id' }).parameters.join_type).toBe(
      'INNER',
    );
  });

  it('normalizes operator casing and validates the enum', () => {
    expect(buildActionPayload('FILTER', { column: 'gpa', operator: '>', value: 1 }).parameters.operator).toBe('>');
    expect(() => buildActionPayload('FILTER', { column: 'gpa', operator: '>>', value: 1 })).toThrowError();
  });

  it('requires a positive integer limit', () => {
    expect(buildActionPayload('LIMIT', { limit: '10' }).parameters.limit).toBe(10);
    expect(() => buildActionPayload('LIMIT', { limit: 0 })).toThrowError();
    expect(() => buildActionPayload('LIMIT', {})).toThrowError();
  });

  it('always returns parameters as a plain object', () => {
    for (const [type, params] of [
      ['SELECT_TABLE', { table: 'students' }],
      ['FINISH', {}],
    ]) {
      const payload = buildActionPayload(type, params);
      expect(typeof payload.parameters).toBe('object');
      expect(Array.isArray(payload.parameters)).toBe(false);
    }
  });
});

describe('preflightValidate', () => {
  it('is advisory when the schema is unknown', () => {
    clearSchema();
    const result = preflightValidate('FILTER', { column: 'does_not_matter', operator: '>', value: 1 }, {
      actions: [{ action_type: 'SELECT_TABLE', table: 'students' }],
    });
    expect(result.ok).toBe(true);
    expect(result.unverified).toBe(true);
  });

  it('catches a column that is not in the active tables', () => {
    setSchema({ tables: [{ name: 'students', columns: ['id', 'name', 'gpa'] }] });
    const result = preflightValidate('FILTER', { column: 'CGPA', operator: '>', value: 8 }, {
      schemaKnown: true,
      activeTables: ['students'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'column')).toBe(true);
    clearSchema();
  });

  it('catches a second base table selection', () => {
    const result = preflightValidate('SELECT_TABLE', { table: 'courses' }, {
      schemaKnown: false,
      activeTables: ['students'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('Use JOIN');
  });

  it('catches an action with no base table', () => {
    const result = preflightValidate('FILTER', { column: 'gpa', operator: '>', value: 1 }, {
      schemaKnown: false,
      activeTables: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe('describeAction / actionSignature', () => {
  it('renders a compact human label', () => {
    expect(describeAction('FILTER', { column: 'gpa', operator: '>', value: 8.5 })).toBe('WHERE gpa > 8.5');
    expect(describeAction('SELECT_TABLE', { table: 'students' })).toBe('FROM students');
    expect(describeAction('LIMIT', { limit: 10 })).toBe('LIMIT 10');
  });

  it('exposes field descriptors for forms', () => {
    const fields = actionSignature('FILTER');
    expect(fields.map((f) => f.name)).toEqual(['column', 'operator', 'value', 'table']);
    expect(fields.find((f) => f.name === 'operator').options.length).toBeGreaterThan(5);
  });
});

describe('parseFilterText — free text to a structured FILTER', () => {
  it('parses the recovery shorthand the UI collects', () => {
    expect(parseFilterText('gpa > 8.5')).toEqual({
      action_type: 'FILTER',
      parameters: { column: 'gpa', operator: '>', value: 8.5 },
    });
  });

  it('keeps integers as numbers, not strings', () => {
    expect(parseFilterText('credits >= 4').parameters.value).toBe(4);
    expect(typeof parseFilterText('credits >= 4').parameters.value).toBe('number');
  });

  it('keeps text values as strings', () => {
    expect(parseFilterText("name = 'Alice'").parameters.value).toBe("'Alice'");
  });

  it('supports multi-word values (IN lists)', () => {
    expect(parseFilterText('department_id IN 1 2 3').parameters.value).toBe('1 2 3');
  });

  it('omits the value for IS NULL / IS NOT NULL', () => {
    expect(parseFilterText('gpa IS NULL')).toEqual({
      action_type: 'FILTER',
      parameters: { column: 'gpa', operator: 'IS NULL' },
    });
    expect(parseFilterText('gpa IS NOT NULL')).toEqual({
      action_type: 'FILTER',
      parameters: { column: 'gpa', operator: 'IS NOT NULL' },
    });
  });

  it('defaults the operator to > when only a column and value are given', () => {
    expect(parseFilterText('gpa 8.5').parameters.operator).toBe('>');
  });

  it('produces a payload the backend accepts', () => {
    const payload = parseFilterText('gpa > 8.5');
    expect(typeof payload.parameters).toBe('object');
    expect(Array.isArray(payload.parameters)).toBe(false);
  });

  it('rejects an empty line with a fixable error', () => {
    expect(() => parseFilterText('')).toThrow();
    try {
      parseFilterText('');
    } catch (err) {
      expect(err.code).toBe(API_ERROR.PREFLIGHT);
      expect(err.fields).toEqual(['column']);
    }
  });

  it('rejects a column with no value', () => {
    try {
      parseFilterText('gpa >');
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe(API_ERROR.PREFLIGHT);
      expect(err.fields).toEqual(['value']);
    }
  });
});
