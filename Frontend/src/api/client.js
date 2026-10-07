const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000';

/**
 * Creates a new query session with natural language prompt.
 */
export async function createSession(request) {
  const res = await fetch(`${API_BASE}/queries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to create query session');
  }
  return res.json();
}

/**
 * Gets the current state of a query session.
 */
export async function getQueryState(sessionId) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}`);
  if (!res.ok) throw new Error('Failed to fetch query state');
  return res.json();
}

/**
 * Asks the decision agent (Ornith / Laya / Rule) for the next typed action.
 */
export async function getNextAction(sessionId) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}/next-action`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to get next action');
  }
  return res.json();
}

/**
 * Applies and validates a typed action (producing an intermediate preview).
 * Accepts either (sessionId, actionType, parameters) or (sessionId, actionObject).
 */
export async function applyAction(sessionId, actionOrType, maybeParameters = {}) {
  let actionType = actionOrType;
  let parameters = maybeParameters;

  if (typeof actionOrType === 'object' && actionOrType !== null) {
    actionType = actionOrType.action_type || actionOrType.action;
    parameters = actionOrType.parameters || actionOrType.params || {};
  }

  const res = await fetch(`${API_BASE}/queries/${sessionId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action_type: actionType,
      parameters,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to apply action');
  }
  return res.json();
}

/**
 * Creates a checkpoint on the current state.
 */
export async function createCheckpoint(sessionId, label = null) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}/checkpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error('Failed to create checkpoint');
  return res.json();
}

/**
 * Recomputes and creates a new branch from a checkpoint with a correction action.
 */
export async function recoverFromCheckpoint(sessionId, checkpointId, correction) {
  let actionType = correction;
  let parameters = {};
  if (typeof correction === 'object' && correction !== null) {
    actionType = correction.action_type || correction.action;
    parameters = correction.parameters || correction.params || {};
  }
  return recoverQuery(sessionId, checkpointId, actionType, parameters);
}

export async function recoverQuery(sessionId, checkpointId, correctionActionType, correctionParameters) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkpoint_id: checkpointId,
      correction: {
        action_type: correctionActionType,
        parameters: correctionParameters,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to recover from checkpoint');
  }
  return res.json();
}

/**
 * Finishes query construction and executes final SQL.
 */
export async function finishQuery(sessionId) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}/finish`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to finish query');
  }
  return res.json();
}

/**
 * Fetches the complete execution trace graph (states, checkpoints, failures).
 */
export async function getTrace(sessionId) {
  const res = await fetch(`${API_BASE}/queries/${sessionId}/trace`);
  if (!res.ok) throw new Error('Failed to fetch trace graph');
  return res.json();
}

/**
 * Decision agent status and model swapping.
 */
export async function getAgentStatus() {
  const res = await fetch(`${API_BASE}/queries/agent/status`);
  if (!res.ok) throw new Error('Failed to get agent status');
  return res.json();
}

export async function selectAgent(agentType) {
  const res = await fetch(`${API_BASE}/queries/agent/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_type: agentType }),
  });
  if (!res.ok) throw new Error('Failed to switch agent');
  return res.json();
}
