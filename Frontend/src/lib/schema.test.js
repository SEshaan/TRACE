/**
 * lib/schema.test.js — the advisory schema cache accepts both wire shapes,
 * normalizes columns to strings, and degrades gracefully when unknown. Only
 * loadSchema() touches the network; everything else here is pure + stateful.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setSchema,
  clearSchema,
  getSchema,
  hasSchema,
  loadSchema,
  schemaFromTrace,
  activeTables,
  hasTable,
  hasColumn,
  columnsFor,
  tableNames,
} from './schema';

beforeEach(() => {
  clearSchema();
});

describe('setSchema / getSchema / hasSchema lifecycle', () => {
  it('installs and reports a populated schema', () => {
    setSchema({ tables: [{ name: 'students', columns: ['id', 'gpa'] }] });
    expect(hasSchema()).toBe(true);
    expect(getSchema().tables).toHaveLength(1);
    expect(tableNames()).toEqual(['students']);
  });

  it('clears everything and reports no schema afterwards', () => {
    setSchema({ tables: [{ name: 't', columns: ['c'] }] });
    clearSchema();
    expect(hasSchema()).toBe(false);
    expect(getSchema()).toBeNull();
    // With no schema, checks degrade to "unknown" rather than throwing.
    expect(hasTable('students')).toBeNull();
    expect(hasColumn('gpa', ['students'])).toBeNull();
    expect(columnsFor(['students'])).toEqual([]);
  });

  it('setSchema returns the normalized cache (idempotent install)', () => {
    const a = setSchema({ tables: [{ name: 't', columns: ['c'] }] });
    const b = setSchema(a); // feeding normalized output back in is safe
    expect(b).toEqual(a);
  });

  it('loadSchema swallows network failures and leaves the cache untouched', async () => {
    global.fetch = async () => {
      throw new Error('offline');
    };
    const result = await loadSchema();
    expect(result).toBeNull();
    expect(hasSchema()).toBe(false);
  });

  it('loadSchema caches whatever the API returns', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ tables: [{ name: 't', columns: ['c'] }] }),
      text: async () => JSON.stringify({ tables: [{ name: 't', columns: ['c'] }] }),
    });
    const result = await loadSchema();
    expect(result).not.toBeNull();
    expect(hasSchema()).toBe(true);
  });
});

describe('normalizeSchema — accepts both wire shapes', () => {
  it('normalizes an array of tables into the {tables} object shape', () => {
    setSchema([
      { name: 'students', columns: ['id', 'gpa'] },
      { name: 'courses', columns: [] }, // missing columns → empty, not crash
    ]);
    const schema = getSchema();
    expect(schema.tables).toHaveLength(2);
    expect(schema.tables[0]).toEqual({ name: 'students', columns: ['id', 'gpa'] });
    expect(schema.tables[1].columns).toEqual([]);
  });

  it('extracts column names from either bare strings or {name} objects', () => {
    setSchema({
      tables: [
        { name: 'students', columns: ['id', { name: 'gpa' }, { name: 'name' }] },
      ],
    });
    expect(getSchema().tables[0].columns).toEqual(['id', 'gpa', 'name']);
  });

  it('treats a non-array, column-less payload as an empty schema', () => {
    setSchema({}); // no tables key at all
    expect(hasSchema()).toBe(false); // tables.length === 0 → not "has schema"
  });
});

describe('schemaFromTrace — derives a partial schema from actions + previews', () => {
  it('collects tables from SELECT_TABLE/JOIN and columns from subsequent ops', () => {
    const trace = {
      states: [
        { action: { action_type: 'SELECT_TABLE', parameters: { table: 'students' } }, preview: { columns: ['id'] } },
        { action: { action_type: 'SELECT_COLUMN', parameters: { table: 'students', column: 'gpa' } }, preview: {} },
        { action: { action_type: 'JOIN', parameters: { table: 'courses' } }, preview: { columns: ['id'] } },
      ],
    };

    const schema = schemaFromTrace(trace);
    expect(schema.tables).toHaveLength(2);
    // Preview columns are unqualified and attached to every active table.
    expect(schema.tables.find((t) => t.name === 'students').columns).toContain('id');
    expect(schema.tables.find((t) => t.name === 'courses').columns).toContain('id');
  });

  it('mutates the module cache as a side effect', () => {
    schemaFromTrace({ states: [{ action: { action_type: 'SELECT_TABLE', parameters: { table: 'x' } }, preview: {} }] });
    expect(hasSchema()).toBe(true);
    expect(tableNames()).toEqual(['x']);
  });

  it('returns an empty (non-cached) schema for a trace with no actions', () => {
    const schema = schemaFromTrace({ states: [] });
    expect(schema.tables).toEqual([]);
    expect(hasSchema()).toBe(false); // nothing was cached
  });
});

describe('activeTables — tables in scope for a state', () => {
  it('collects base + joined tables and de-duplicates', () => {
    const actions = [
      { action_type: 'SELECT_TABLE', table: 'students' },
      { action_type: 'JOIN', table: 'courses' },
      { action_type: 'FILTER', table: 'students', column: 'gpa' }, // not a table-op, ignored
    ];
    expect(activeTables(actions)).toEqual(['students', 'courses']);
  });

  it('reads `table` from either the top-level or parameters shape', () => {
    const actions = [{ action_type: 'SELECT_TABLE', parameters: { table: 'grades' } }];
    expect(activeTables(actions)).toEqual(['grades']);
  });
});

describe('hasColumn / hasTable — verification against a known schema', () => {
  it('verifies a column exists in one of the given tables', () => {
    setSchema({ tables: [{ name: 'students', columns: ['id', 'gpa'] }] });
    expect(hasColumn('gpa', ['students'])).toBe(true);
    expect(hasColumn('name', ['students'])).toBe(false);
  });

  it('returns true for "*" or a missing column (cannot be false without schema)', () => {
    setSchema({ tables: [{ name: 'students', columns: ['id'] }] });
    expect(hasColumn('*', ['students'])).toBe(true);
    expect(hasColumn(null, ['students'])).toBe(true);
  });

  it('columnsFor returns the union of all known columns for the tables', () => {
    setSchema({
      tables: [
        { name: 'a', columns: ['x', 'y'] },
        { name: 'b', columns: ['y', 'z'] },
      ],
    });
    expect(columnsFor(['a', 'b']).sort()).toEqual(['x', 'y', 'z']);
  });
});
