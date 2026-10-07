/**
 * lib/actions.js
 * ---------------------------------------------------------------------------
 * Payload builders and pre-flight checks for typed query actions.
 *
 * Responsibilities:
 *   1. Accept loose action input from anywhere in the app and normalize it.
 *   2. Reject anything the backend cannot possibly accept, BEFORE the network.
 *   3. Guarantee `parameters` is always a plain object (the backend schema is
 *      `dict[str, Any]`; a string here produces an HTTP 422).
 *   4. Drop fields the backend does not know about.
 *
 * Validation here is advisory. The backend stays authoritative.
 * ---------------------------------------------------------------------------
 */

import {
  ACTION_SPECS,
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  ACTIONS_REQUIRING_BASE_TABLE,
  JOIN_TYPES,
  OPERATORS,
  ORDER_DIRECTIONS,
} from '../constants/backend';
import { ApiError, API_ERROR } from '../api/errors';
import { activeTables, hasColumn, hasSchema, hasTable } from './schema';

/**
 * Accept any of the shapes the app currently produces and return one shape.
 *   { action_type, parameters }
 *   { action, params }
 *   { type, parameters }
 *   "FILTER"                        (with a second positional argument)
 */
export function normalizeActionInput(input, maybeParameters) {
  if (typeof input === 'string') {
    return { action_type: input, parameters: toPlainParameters(maybeParameters) };
  }
  if (!input || typeof input !== 'object') {
    throw new ApiError('An action must be an object or an action type string.', {
      code: API_ERROR.INVALID_ACTION,
    });
  }

  const actionType = input.action_type ?? input.action ?? input.type;
  const parameters = input.parameters ?? input.params ?? {};

  return {
    action_type: typeof actionType === 'string' ? actionType.trim().toUpperCase() : actionType,
    parameters: toPlainParameters(parameters),
  };
}

/**
 * The backend schema is `dict[str, Any]`. A string here produces an HTTP 422,
 * so anything that is not a plain object becomes an empty object and the
 * required-parameter check fires locally instead of on the server.
 */
function toPlainParameters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * Build the exact body the backend expects: { action_type, parameters }.
 *
 * Throws ApiError(INVALID_ACTION) for unknown action types and
 * ApiError(PREFLIGHT) for missing required parameters.
 *
 * @returns {{ action_type: string, parameters: object }}
 */
export function buildActionPayload(actionTypeOrInput, maybeParameters) {
  const { action_type, parameters } = normalizeActionInput(actionTypeOrInput, maybeParameters);

  if (typeof action_type !== 'string' || !ACTION_TYPE_LIST.includes(action_type)) {
    throw new ApiError(
      `Unsupported action_type: ${String(action_type)}. Allowed: ${ACTION_TYPE_LIST.join(', ')}`,
      { code: API_ERROR.INVALID_ACTION },
    );
  }

  const spec = ACTION_SPECS[action_type] ?? {};
  const out = {};

  for (const [name, rule] of Object.entries(spec)) {
    // `IS NULL` / `IS NOT NULL` take no value: skip it entirely.
    if (rule.noValueOps?.includes(out.operator)) continue;

    const raw = parameters[name];
    const value = coerce(raw, rule, name, action_type);

    if (value === undefined) {
      if (rule.default !== undefined) {
        out[name] = rule.default;
        continue;
      }
      if (rule.required) {
        throw new ApiError(`${action_type} requires '${name}'.`, {
          code: API_ERROR.PREFLIGHT,
          fields: [name],
        });
      }
      continue;
    }

    out[name] = value;
  }

  return { action_type, parameters: out };
}

function coerce(raw, rule, name, actionType) {
  if (raw === undefined || raw === null || raw === '') return undefined;

  switch (rule.kind) {
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) {
        throw new ApiError(`${actionType}.${name} must be a number.`, {
          code: API_ERROR.PREFLIGHT,
          fields: [name],
        });
      }
      if (rule.min !== undefined && num < rule.min) {
        throw new ApiError(`${actionType}.${name} must be >= ${rule.min}.`, {
          code: API_ERROR.PREFLIGHT,
          fields: [name],
        });
      }
      return Math.trunc(num);
    }

    case 'operator': {
      const op = String(raw).trim().toUpperCase();
      if (!OPERATORS.includes(op)) {
        throw new ApiError(
          `${actionType}.${name} must be one of: ${OPERATORS.join(', ')}. Got '${raw}'.`,
          { code: API_ERROR.PREFLIGHT, fields: [name] },
        );
      }
      return op;
    }

    case 'direction': {
      const dir = String(raw).trim().toUpperCase();
      if (!ORDER_DIRECTIONS.includes(dir)) {
        throw new ApiError(
          `${actionType}.${name} must be ASC or DESC. Got '${raw}'.`,
          { code: API_ERROR.PREFLIGHT, fields: [name] },
        );
      }
      return dir;
    }

    case 'joinType': {
      const jt = String(raw).trim().toUpperCase();
      if (!JOIN_TYPES.includes(jt)) {
        throw new ApiError(
          `${actionType}.${name} must be one of: ${JOIN_TYPES.join(', ')}. Got '${raw}'.`,
          { code: API_ERROR.PREFLIGHT, fields: [name] },
        );
      }
      return jt;
    }

    case 'json':
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed === '' ? undefined : trimmed;
      }
      return raw;

    case 'table':
    case 'column':
    case 'string':
    default: {
      const str = String(raw).trim();
      return str === '' ? undefined : str;
    }
  }
}

/**
 * Advisory, schema-aware validation. Mirrors DeterministicValidator rules so
 * forms can show inline errors. Never blocks a request the backend would accept:
 * when the schema is unknown the result is `{ ok: true, unverified: true }`.
 *
 * @param {string} actionType
 * @param {object} parameters
 * @param {{ actions?: object[], schemaKnown?: boolean }} context
 * @returns {{ ok: boolean, unverified?: boolean, errors: Array<{field?: string, message: string}> }}
 */
export function preflightValidate(actionType, parameters = {}, context = {}) {
  const errors = [];

  if (!ACTION_TYPE_LIST.includes(actionType)) {
    return {
      ok: false,
      errors: [{ message: `Unsupported action_type: ${actionType}` }],
    };
  }

  const schemaKnown = context.schemaKnown ?? hasSchema();
  const tables = context.activeTables ?? activeTables(context.actions ?? []);

  if (ACTIONS_REQUIRING_BASE_TABLE.includes(actionType) && tables.length === 0) {
    errors.push({ message: 'A base table must be selected before this action.' });
  }

  if (actionType === ACTION_TYPES.SELECT_TABLE && tables.length > 0) {
    errors.push({ message: `Base table already selected: ${tables[0]}. Use JOIN to add tables.` });
  }

  if (schemaKnown) {
    for (const key of ['table']) {
      if (parameters[key] && hasTable(parameters[key]) === false) {
        errors.push({ field: key, message: `Table '${parameters[key]}' does not exist in schema.` });
      }
    }

    const scope = actionType === ACTION_TYPES.JOIN ? [parameters.table] : tables;
    for (const key of ['column', 'left_on']) {
      if (parameters[key] && hasColumn(parameters[key], scope) === false) {
        errors.push({
          field: key,
          message: `Column '${parameters[key]}' not found in active tables: ${scope.join(', ')}.`,
        });
      }
    }

    if (actionType === ACTION_TYPES.JOIN && parameters.right_on) {
      if (hasColumn(parameters.right_on, [parameters.table]) === false) {
        errors.push({
          field: 'right_on',
          message: `Right join key '${parameters.right_on}' not found in table '${parameters.table}'.`,
        });
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, unverified: !schemaKnown, errors: [] };
}

/**
 * Human label for an action: "FILTER gpa > 8.5", "JOIN courses", "LIMIT 10".
 */
export function describeAction(actionType, parameters = {}) {
  const p = parameters ?? {};
  switch (actionType) {
    case ACTION_TYPES.SELECT_TABLE:
      return `FROM ${p.table ?? '?'}`;
    case ACTION_TYPES.SELECT_COLUMN:
      return `SELECT ${p.alias ?? p.column ?? '*'}`;
    case ACTION_TYPES.FILTER:
      return p.operator === 'IS NULL' || p.operator === 'IS NOT NULL'
        ? `WHERE ${p.column} ${p.operator}`
        : `WHERE ${p.column} ${p.operator ?? '?'} ${formatValue(p.value)}`;
    case ACTION_TYPES.JOIN:
      return `JOIN ${p.table ?? '?'} ON ${p.left_on ?? '?'} = ${p.right_on ?? '?'}`;
    case ACTION_TYPES.GROUP_BY:
      return `GROUP BY ${p.column ?? '?'}`;
    case ACTION_TYPES.ORDER_BY:
      return `ORDER BY ${p.column ?? '?'} ${p.direction ?? 'ASC'}`;
    case ACTION_TYPES.LIMIT:
      return `LIMIT ${p.limit ?? '?'}`;
    case ACTION_TYPES.FINISH:
      return 'Execute final SQL';
    default:
      return String(actionType ?? '');
  }
}

function formatValue(value) {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `(${value.join(', ')})`;
  return String(value);
}

/**
 * Field descriptors for a form: [{ name, kind, required, default, options }].
 */
export function actionSignature(actionType) {
  const spec = ACTION_SPECS[actionType] ?? {};
  return Object.entries(spec).map(([name, rule]) => ({
    name,
    kind: rule.kind,
    required: rule.required === true,
    default: rule.default,
    options:
      rule.kind === 'operator'
        ? OPERATORS
        : rule.kind === 'direction'
          ? ORDER_DIRECTIONS
          : rule.kind === 'joinType'
            ? JOIN_TYPES
            : undefined,
  }));
}
