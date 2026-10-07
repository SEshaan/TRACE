/**
 * api/client.js
 * ---------------------------------------------------------------------------
 * One boring function per backend operation.
 *
 * Every method follows the same shape:
 *     arguments -> build payload -> request() -> normalize -> DTO
 *
 * No React, no state, no retries beyond transport's GET retry, no business
 * logic. If a rule feels like business logic it belongs in a hook.
 * ---------------------------------------------------------------------------
 */

import { EP } from './endpoints';
import { request } from './transport';
import { API_ERROR, ApiError } from './errors';
import { buildActionPayload, normalizeActionInput } from '../lib/actions';
import {
  normalizeAgentStatus,
  normalizeCheckpoint,
  normalizeFailure,
  normalizeResult,
  normalizeSession,
  normalizeSessionSummary,
  normalizeState,
  normalizeTrace,
} from '../lib/normalize';

/* ------------------------------------------------------------------ health */

export async function health(options = {}) {
  const { health: ep } = EP;
  try {
    const data = await request(ep.path, { method: ep.method, timeout: 3000, retries: 0, ...options });
    return { ok: data?.status === 'ok', raw: data };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/* --------------------------------------------------------------- sessions */

export async function createSession(naturalLanguageRequest, options = {}) {
  const request_text = String(naturalLanguageRequest ?? '').trim();
  if (!request_text) {
    throw new ApiError('A query request must be a non-empty string.', {
      code: API_ERROR.PREFLIGHT,
      fields: ['request'],
    });
  }

  const ep = EP.createSession;
  const data = await request(ep.path, { method: ep.method, body: { request: request_text }, ...options });
  return normalizeSession(data);
}

export async function getSession(sessionId, options = {}) {
  const ep = EP.getSession(requireId(sessionId, 'sessionId'));
  const data = await request(ep.path, { method: ep.method, ...options });
  return normalizeState(data);
}

/* ---------------------------------------------------------------- actions */

/**
 * Ask the decision model what it would do next. Decides only: nothing is
 * validated, applied, or persisted.
 */
export async function getNextAction(sessionId, options = {}) {
  const ep = EP.nextAction(requireId(sessionId, 'sessionId'));
  const data = await request(ep.path, { method: ep.method, ...options });
  return {
    action_type: data?.action_type ?? null,
    parameters: data?.parameters && typeof data.parameters === 'object' ? data.parameters : {},
    raw: data,
  };
}

/**
 * Validate + apply one typed action. Produces an intermediate preview.
 *
 * Accepts (sessionId, {action_type, parameters}) or the legacy
 * (sessionId, 'FILTER', { column, operator, value }).
 */
export async function applyAction(sessionId, actionInput, maybeParameters, options = {}) {
  const { action_type, parameters } = buildActionPayload(actionInput, maybeParameters);
  const ep = EP.applyAction(requireId(sessionId, 'sessionId'));

  const data = await request(ep.path, { method: ep.method, body: { action_type, parameters }, ...options });
  return normalizeActionResponse(data);
}

/**
 * Decide + apply in one round trip. Falls back to nextAction + applyAction
 * when the backend has no /step route.
 */
export async function step(sessionId, options = {}) {
  const id = requireId(sessionId, 'sessionId');
  const ep = EP.step(id);
  try {
    const data = await request(ep.path, { method: ep.method, ...options });
    return {
      decision: data?.decision
        ? { action_type: data.decision.action_type ?? null, parameters: data.decision.parameters ?? {} }
        : null,
      ...normalizeActionResponse(data),
      via: 'step',
    };
  } catch (err) {
    if (err instanceof ApiError && (err.code === API_ERROR.NOT_FOUND || err.code === API_ERROR.UNSUPPORTED)) {
      const decision = await getNextAction(id, options);
      const applied = await applyAction(id, decision, undefined, options);
      return { decision, ...applied, via: 'fallback' };
    }
    throw err;
  }
}

/* ------------------------------------------------------------ checkpoints */

/**
 * Pin a checkpoint.
 *
 * `stateId` is sent when supplied (backend Phase 0.2). If the backend build
 * rejects the unknown field, retry without it and report the downgrade so the
 * UI can say "pinned to the current state" instead of lying.
 *
 * @returns {Promise<{ id, stateId, label, pinnedToCurrentState: boolean, raw }>}
 */
export async function createCheckpoint(sessionId, options = {}) {
  const id = requireId(sessionId, 'sessionId');
  // Legacy call style: createCheckpoint(sessionId, 'my-label')
  const opts = typeof options === 'string' ? { label: options } : options ?? {};
  const ep = EP.checkpoint(id);

  const body = { label: opts.label ?? null };
  if (opts.stateId) body.state_id = opts.stateId;

  try {
    const data = await request(ep.path, { method: ep.method, body, ...opts });
    return { ...normalizeCheckpoint(data), pinnedToCurrentState: false };
  } catch (err) {
    if (opts.stateId && err instanceof ApiError && err.code === API_ERROR.UNPROCESSABLE) {
      const data = await request(ep.path, {
        method: ep.method,
        body: { label: opts.label ?? null },
        ...opts,
      });
      return { ...normalizeCheckpoint(data), pinnedToCurrentState: true };
    }
    throw err;
  }
}

/* --------------------------------------------------------------- recovery */

/**
 * Branch from a checkpoint with a structured correction.
 *
 * The checkpoint id must be a real checkpoint id — the backend 404s on a
 * state id, and the old code passed fabricated strings. Callers resolve that
 * in useSession; here we refuse anything that looks local.
 */
export async function recover(sessionId, { checkpointId, action } = {}, options = {}) {
  const id = requireId(sessionId, 'sessionId');

  if (!checkpointId || typeof checkpointId !== 'string') {
    throw new ApiError('Recovery requires a real checkpoint id.', {
      code: API_ERROR.NO_CHECKPOINT,
      fields: ['checkpoint_id'],
    });
  }

  // The previous UI invented ids like `cp-389b65` / `rec_1715...` and sent them
  // here, which the backend answers with a 404. Those shapes are only ever
  // produced by the frontend, so refuse them locally with an actionable error.
  if (looksLikeLocalId(checkpointId)) {
    throw new ApiError(
      `'${checkpointId}' is a locally generated id, not a checkpoint id. Pick a checkpoint from the trace.`,
      { code: API_ERROR.NO_CHECKPOINT, fields: ['checkpoint_id'], detail: { checkpointId } },
    );
  }

  const correction = buildActionPayload(action);
  const ep = EP.recover(id);

  const data = await request(ep.path, {
    method: ep.method,
    body: { checkpoint_id: checkpointId, correction },
    ...options,
  });

  return normalizeActionResponse(data);
}

/* ----------------------------------------------------------------- finish */

export async function finish(sessionId, options = {}) {
  const ep = EP.finish(requireId(sessionId, 'sessionId'));
  const data = await request(ep.path, { method: ep.method, ...options });
  return normalizeResult(data);
}

/* ------------------------------------------------------------------ trace */

export async function getTrace(sessionId, options = {}) {
  const ep = EP.trace(requireId(sessionId, 'sessionId'));
  const data = await request(ep.path, { method: ep.method, ...options });
  return normalizeTrace(data);
}

/* --------------------------------------------------------- session history */

/**
 * Session history. Degrades instead of throwing when the backend has no
 * list route, so the sidebar can render "history unavailable".
 */
export async function listSessions({ status, q, limit } = {}, options = {}) {
  const ep = EP.listSessions;
  try {
    const data = await request(ep.path, {
      method: ep.method,
      query: { status, q, limit },
      ...options,
    });
    const items = (Array.isArray(data) ? data : data?.items ?? []).map(normalizeSessionSummary);
    return { items, unsupported: false };
  } catch (err) {
    if (err instanceof ApiError && (err.code === API_ERROR.UNSUPPORTED || err.code === API_ERROR.NOT_FOUND)) {
      return { items: [], unsupported: true };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ agent */

export async function getAgentStatus(options = {}) {
  const ep = EP.agentStatus;
  const data = await request(ep.path, { method: ep.method, timeout: 5000, retries: 0, ...options });
  return normalizeAgentStatus(data);
}

export async function selectAgent(agentType, options = {}) {
  const ep = EP.agentSelect;
  const data = await request(ep.path, {
    method: ep.method,
    body: { agent_type: String(agentType) },
    ...options,
  });
  return { agent: data?.active_agent ?? null, raw: data };
}

/* ------------------------------------------------------------------ schema */

export async function getSchema(options = {}) {
  const ep = EP.schema;
  const data = await request(ep.path, { method: ep.method, ...options });
  return data;
}

/* ------------------------------------------------------------- capability */

/**
 * Cheap probe of the endpoints this backend build actually serves.
 * Cached for the session; call refreshCapabilities() to re-probe.
 */
let capabilities = null;

export async function probeCapabilities(options = {}) {
  const [agent, sessions, schemaAvailable] = await Promise.all([
    getAgentStatus(options).then(() => true).catch(() => false),
    listSessions({ limit: 1 }, options).then((r) => !r.unsupported).catch(() => false),
    getSchema(options).then(() => true).catch(() => false),
  ]);

  capabilities = {
    online: agent,
    listSessions: sessions,
    schema: schemaAvailable,
    step: capabilities?.step ?? true,
    checkpointStateId: capabilities?.checkpointStateId ?? true,
  };
  return capabilities;
}

export function getCapabilities() {
  return capabilities;
}

export function markCapability(name, value) {
  capabilities = { ...(capabilities ?? {}), [name]: value };
  return capabilities;
}

/* ----------------------------------------------------------------- shared */

function requireId(value, name) {
  if (!value || typeof value !== 'string') {
    throw new ApiError(`${name} is required.`, { code: API_ERROR.PREFLIGHT, fields: [name] });
  }
  return value;
}

/**
 * Ids the frontend used to fabricate: `cp-389b65`, `rec_1715...`,
 * `finish_1715...`, `node_...`, `state-1`. Backend ids are UUIDs.
 */
function looksLikeLocalId(id) {
  return /^(cp|rec|finish|node|state)[-_]/i.test(id) || id.length < 8;
}

function normalizeActionResponse(data) {
  return {
    success: data?.success === true,
    state: normalizeState(data?.state),
    failure: normalizeFailure(data?.failure),
    raw: data,
  };
}

/* --------------------------------------------- deprecated call signatures */

/** @deprecated use finish(sessionId) */
export const finishQuery = finish;

/** @deprecated use getSession(sessionId) */
export const getQueryState = getSession;

/** @deprecated use recover(sessionId, { checkpointId, action }) */
export function recoverFromCheckpoint(sessionId, checkpointId, correction) {
  const { action_type, parameters } = normalizeActionInput(correction);
  return recover(sessionId, { checkpointId, action: { action_type, parameters } });
}
