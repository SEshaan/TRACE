/**
 * lib/schema.js
 * ---------------------------------------------------------------------------
 * A tiny, advisory schema cache.
 *
 * The backend is authoritative. This module exists only so payload builders
 * can warn early ("column 'CGPA' is not in table 'students'") instead of
 * round-tripping. When the schema is unknown, every check degrades to
 * "unverified" and never blocks a request.
 * ---------------------------------------------------------------------------
 */

/** @type {{ tables: Array<{ name: string, columns: string[] }> } | null} */
let cachedSchema = null;

/**
 * Install a schema (from GET /queries/{id}/schema once it exists,
 * or from a fixture during offline development).
 */
export function setSchema(schema) {
  cachedSchema = schema ? normalizeSchema(schema) : null;
  return cachedSchema;
}

export function clearSchema() {
  cachedSchema = null;
}

export function getSchema() {
  return cachedSchema;
}

export function hasSchema() {
  return cachedSchema !== null && cachedSchema.tables.length > 0;
}

function normalizeSchema(schema) {
  if (Array.isArray(schema)) {
    return { tables: schema.map((t) => ({ name: t.name, columns: t.columns ?? [] })) };
  }
  const tables = Array.isArray(schema.tables) ? schema.tables : [];
  return {
    tables: tables.map((t) => ({
      name: t.name,
      columns: Array.isArray(t.columns) ? t.columns.map((c) => (typeof c === 'string' ? c : c.name)) : [],
    })),
  };
}

/**
 * Derive a partial schema from a trace: every action mentions tables and
 * columns, and every preview mentions the resulting column names.
 * Good enough for advisory validation, never authoritative.
 */
export function schemaFromTrace(trace) {
  const tables = new Map();

  const ensure = (name) => {
    if (!name) return null;
    if (!tables.has(name)) tables.set(name, new Set());
    return tables.get(name);
  };

  for (const state of trace?.states ?? []) {
    const action = state?.action;
    const params = action?.parameters ?? {};
    const type = action?.action_type;

    if (type === 'SELECT_TABLE' || type === 'JOIN') {
      ensure(params.table);
    }
    if (type === 'SELECT_COLUMN' || type === 'FILTER' || type === 'GROUP_BY' || type === 'ORDER_BY') {
      if (params.table) ensure(params.table)?.add(params.column);
    }

    for (const col of state?.preview?.columns ?? []) {
      // Preview columns are unqualified; attach them to every active table.
      for (const [, cols] of tables) cols.add(col);
    }
  }

  const normalized = {
    tables: [...tables.entries()].map(([name, cols]) => ({ name, columns: [...cols] })),
  };

  if (normalized.tables.length > 0) {
    cachedSchema = normalized;
  }

  return normalized;
}

/**
 * Tables in scope for a state: the base table plus every joined table.
 * Mirrors DeterministicValidator._get_active_tables().
 */
export function activeTables(actions = []) {
  const out = [];
  for (const action of actions) {
    const type = action?.action_type ?? action?.type;
    const table = action?.table ?? action?.parameters?.table;
    if ((type === 'SELECT_TABLE' || type === 'JOIN') && table && !out.includes(table)) {
      out.push(table);
    }
  }
  return out;
}

export function hasTable(name) {
  if (!hasSchema()) return null; // unknown
  return cachedSchema.tables.some((t) => t.name === name);
}

/**
 * Resolve a column against a set of tables.
 * Returns true | false | null (null = schema unknown, cannot verify).
 */
export function hasColumn(column, tables = []) {
  if (!column || column === '*') return true;
  if (!hasSchema()) return null;

  for (const tableName of tables) {
    const table = cachedSchema.tables.find((t) => t.name === tableName);
    if (table && table.columns.includes(column)) return true;
  }
  return false;
}

/** All columns known for the given tables. Empty when schema is unknown. */
export function columnsFor(tables = []) {
  if (!hasSchema()) return [];
  const out = new Set();
  for (const tableName of tables) {
    const table = cachedSchema.tables.find((t) => t.name === tableName);
    if (table) for (const col of table.columns) out.add(col);
  }
  return [...out];
}

export function tableNames() {
  return hasSchema() ? cachedSchema.tables.map((t) => t.name) : [];
}
