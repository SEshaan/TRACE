/**
 * lib/normalize.js
 * ---------------------------------------------------------------------------
 * Defensive DTO normalization.
 *
 * Two rules:
 *   1. Preserve `raw` — the untouched server payload is always available.
 *   2. Never invent a field. If the backend did not send it, the DTO is null.
 *
 * camelCase is canonical; snake_case aliases are attached during the
 * transition so existing App.jsx bindings keep working.
 * ---------------------------------------------------------------------------
 */

export function normalizePreview(preview) {
  if (!preview) return null;
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  return {
    columns: Array.isArray(preview.columns) ? preview.columns : [],
    rows,
    rowCount: preview.row_count ?? rows.length,
    truncated: preview.truncated === true,
    executionTimeMs: preview.execution_time_ms ?? null,
    raw: preview,
  };
}

/**
 * The last action applied to a state, as { type, params, confidence }.
 * The backend serializes the concrete dataclass, so `action_type` and
 * `confidence` sit alongside the params.
 */
export function normalizeAction(action) {
  if (!action) return null;
  const { action_type: type, confidence, ...rest } = action;
  return {
    type: type ?? null,
    params: rest,
    confidence: typeof confidence === 'number' ? confidence : null,
    raw: action,
  };
}

export function normalizeFailure(failure) {
  if (!failure) return null;
  return {
    actionType: failure.action_type ?? null,
    code: failure.code ?? null,
    message: failure.message ?? 'Action failed.',
    stateId: failure.state_id ?? null,
    raw: failure,
  };
}

export function normalizeCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    id: checkpoint.id ?? null,
    stateId: checkpoint.state_id ?? null,
    label: checkpoint.label ?? null,
    raw: checkpoint,
  };
}

export function normalizeSession(session) {
  if (!session) return null;
  return {
    id: session.id ?? null,
    request: session.request ?? '',
    rootStateId: session.root_state_id ?? null,
    currentStateId: session.current_state_id ?? null,
    status: session.status ?? null,
    modelVersion: session.model_version ?? null,
    createdAt: session.created_at ?? null,
    updatedAt: session.updated_at ?? null,
    raw: session,
  };
}

export function normalizeState(state) {
  if (!state) return null;
  const preview = normalizePreview(state.preview);
  return {
    id: state.id ?? null,
    parentId: state.parent_id ?? null,
    status: state.status ?? null,
    actionCount: state.action_count ?? 0,
    sql: state.sql ?? null,
    displaySql: state.display_sql ?? null,
    action: normalizeAction(state.action),
    preview,
    /** Populated once the backend persists agent_decisions. Null until then. */
    decision: state.decision
      ? {
          probabilities: state.decision.probabilities ?? null,
          confidence: state.decision.confidence ?? null,
          latencyMs: state.decision.latency_ms ?? null,
          modelVersion: state.decision.model_version ?? null,
          raw: state.decision,
        }
      : null,
    failure: normalizeFailure(state.failure),
    /** Filled in by normalizeTrace from trace.checkpoints. */
    checkpoint: null,
    isCurrent: false,
    isTerminal: state.status === 'failed' || state.status === 'completed',

    // --- transition aliases (remove once App.jsx is fully rewired) ---
    parent_id: state.parent_id ?? null,
    action_count: state.action_count ?? 0,
    row_count: preview?.rowCount ?? null,
    execution_time_ms: preview?.executionTimeMs ?? null,

    raw: state,
  };
}

export function normalizeResult(result) {
  if (!result) return null;
  const rows = Array.isArray(result.rows) ? result.rows : [];
  return {
    state: normalizeState(result.state),
    sql: result.display_sql ?? result.sql ?? null,
    displaySql: result.display_sql ?? result.sql ?? null,
    executionSql: result.execution_sql ?? null,
    columns: Array.isArray(result.columns) ? result.columns : [],
    rows,
    rowCount: result.row_count ?? rows.length,
    executionTimeMs: result.execution_time_ms ?? null,
    totalActions: result.total_actions ?? null,
    modelVersion: result.model_version ?? null,
    raw: result,
  };
}

export function normalizeAgentStatus(status) {
  if (!status) return null;
  return {
    agent: status.active_agent ?? null,
    registered: Array.isArray(status.registered) ? status.registered : [],
    model: status.model_name ?? null,
    baseUrl: status.base_url ?? null,
    raw: status,
  };
}

export function normalizeSessionSummary(item) {
  if (!item) return null;
  return {
    id: item.id ?? null,
    request: item.request ?? '',
    status: item.status ?? null,
    modelVersion: item.model_version ?? null,
    createdAt: item.created_at ?? null,
    updatedAt: item.updated_at ?? null,
    stateCount: item.state_count ?? null,
    hasFailure: item.has_failure ?? null,
    raw: item,
  };
}

/**
 * Full trace envelope. Graph mapping lives in lib/traceGraph.js.
 */
export function normalizeTrace(trace) {
  if (!trace) return null;
  return {
    session: normalizeSession(trace.session),
    states: (Array.isArray(trace.states) ? trace.states : []).map(normalizeState),
    checkpoints: (Array.isArray(trace.checkpoints) ? trace.checkpoints : []).map(normalizeCheckpoint),
    failures: (Array.isArray(trace.failures) ? trace.failures : []).map(normalizeFailure),
    raw: trace,
  };
}
