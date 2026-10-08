/**
 * constants/backend.js
 * ---------------------------------------------------------------------------
 * The canonical backend vocabulary. Single source of truth for every action
 * type, operator, and enum the FastAPI service accepts.
 *
 * Nothing in the frontend may hardcode an action name outside this file.
 * ---------------------------------------------------------------------------
 */

export const ACTION_TYPES = {
  SELECT_TABLE: 'SELECT_TABLE',
  SELECT_COLUMN: 'SELECT_COLUMN',
  FILTER: 'FILTER',
  JOIN: 'JOIN',
  GROUP_BY: 'GROUP_BY',
  AGGREGATE: 'AGGREGATE',
  ORDER_BY: 'ORDER_BY',
  LIMIT: 'LIMIT',
  FINISH: 'FINISH',
  // Graceful-fail actions: the agent declines to proceed instead of guessing.
  INSUFFICIENT_INFO: 'INSUFFICIENT_INFO',
  SCHEMA_MISSING: 'SCHEMA_MISSING',
  ABORT_QUERY: 'ABORT_QUERY',
};

export const ACTION_TYPE_LIST = Object.freeze(Object.values(ACTION_TYPES));

/**
 * Agent actions that mean "I cannot build this query" rather than a step in
 * building it. Rendered as amber dashed decline nodes, never as red failures.
 */
export const FAIL_STATE_ACTION_TYPES = Object.freeze([
  ACTION_TYPES.INSUFFICIENT_INFO,
  ACTION_TYPES.SCHEMA_MISSING,
  ACTION_TYPES.ABORT_QUERY,
]);

export const OPERATORS = Object.freeze([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'IN',
  'IS NULL',
  'IS NOT NULL',
]);

export const JOIN_TYPES = Object.freeze(['INNER', 'LEFT', 'RIGHT']);

export const ORDER_DIRECTIONS = Object.freeze(['ASC', 'DESC']);
export const AGGREGATE_FUNCTIONS = Object.freeze(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

export const QUERY_STATUS = {
  NEW: 'new',
  ACTIVE: 'active',
  FAILED: 'failed',
  COMPLETED: 'completed',
};

/** Backend ActionFailure.code values. */
export const FAILURE_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  STATE_TRANSITION_FAILED: 'STATE_TRANSITION_FAILED',
  SQL_COMPILATION_FAILED: 'SQL_COMPILATION_FAILED',
  DATABASE_EXECUTION_FAILED: 'DATABASE_EXECUTION_FAILED',
};

/**
 * Actions the backend will accept as a recovery correction.
 * SELECT_TABLE is excluded: the base table is already fixed by the checkpoint state.
 * FINISH is excluded: finishing is done by POST /finish, not by recovery.
 */
export const CORRECTABLE_ACTION_TYPES = Object.freeze([
  ACTION_TYPES.SELECT_COLUMN,
  ACTION_TYPES.FILTER,
  ACTION_TYPES.JOIN,
  ACTION_TYPES.GROUP_BY,
  ACTION_TYPES.ORDER_BY,
  ACTION_TYPES.LIMIT,
]);

/**
 * Param spec per action.
 *
 * kind      : 'table' | 'column' | 'operator' | 'direction' | 'joinType'
 *             | 'string' | 'number' | 'json'
 * required  : param must be present and non-empty
 * default   : applied when the param is absent
 * min/max   : numeric bounds
 * noValueOp : operators for which `value` must be omitted
 */
export const ACTION_SPECS = Object.freeze({
  SELECT_TABLE: {
    table: { kind: 'table', required: true },
  },
  SELECT_COLUMN: {
    column: { kind: 'column', required: true },
    table: { kind: 'table' },
    alias: { kind: 'string' },
  },
  FILTER: {
    column: { kind: 'column', required: true },
    operator: { kind: 'operator', required: true },
    // kind 'json' on purpose: the backend compares this value in SQL, so a
    // number must stay a number and an IN list must stay a list.
    value: { kind: 'json', required: true, noValueOps: ['IS NULL', 'IS NOT NULL'] },
    table: { kind: 'table' },
  },
  JOIN: {
    table: { kind: 'table', required: true },
    left_on: { kind: 'column', required: true },
    right_on: { kind: 'column', required: true },
    join_type: { kind: 'joinType', default: 'INNER' },
  },
  GROUP_BY: {
    column: { kind: 'column', required: true },
    table: { kind: 'table' },
  },
  AGGREGATE: {
    function: { kind: 'aggregate', required: true },
    column: { kind: 'column', required: true },
    table: { kind: 'table' },
    alias: { kind: 'string' },
  },
  ORDER_BY: {
    column: { kind: 'column', required: true },
    direction: { kind: 'direction', default: 'ASC' },
    table: { kind: 'table' },
  },
  LIMIT: {
    limit: { kind: 'number', required: true, min: 1 },
  },
  FINISH: {},
  // Graceful-fail actions. `reason` is required so the decline always carries a
  // human-readable why; the optional fields explain what we need / what's absent.
  INSUFFICIENT_INFO: {
    reason: { kind: 'string', required: true },
    clarification: { kind: 'string' },
    missing_fields: { kind: 'json' },
  },
  SCHEMA_MISSING: {
    reason: { kind: 'string', required: true },
    table: { kind: 'table' },
    column: { kind: 'column' },
    expected_relationship: { kind: 'string' },
  },
  ABORT_QUERY: {
    reason: { kind: 'string' },
  },
});

/** Actions that require a base table to already exist in the state. */
export const ACTIONS_REQUIRING_BASE_TABLE = Object.freeze(
  ACTION_TYPE_LIST.filter((t) => t !== ACTION_TYPES.SELECT_TABLE),
);

/** Safety guard for the auto execution loop. */
export const MAX_RUN_STEPS = 25;

/** Animation pacing for the live demo loop. */
export const STEP_DELAY_MS = 380;
