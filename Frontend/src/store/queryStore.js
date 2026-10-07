/**
 * store/queryStore.js
 * ---------------------------------------------------------------------------
 * The single source of truth for query state.
 *
 *   UI -> hooks -> this store -> api/client -> api/transport
 *
 * Owns: capabilities, agent, session list, current session, trace + derived
 * graph, run state, selection, final result, errors.
 *
 * Rules:
 *   - It calls the API client. It never calls fetch.
 *   - State is replaced, never mutated (React Compiler + useSyncExternalStore).
 *   - Every mutation is followed by a trace refresh, so the UI reads the
 *     trace and never a locally assembled node list.
 * ---------------------------------------------------------------------------
 */

import { useSyncExternalStore } from 'react';
import * as api from '../api/client';
import { API_ERROR, ApiError } from '../api/errors';
import { buildGraph } from '../lib/traceGraph';
import { schemaFromTrace, setSchema, loadSchema } from '../lib/schema';
import { DEMO_FAILURE_ACTION, MAX_RUN_STEPS, STEP_DELAY_MS } from '../constants/backend';

/* -------------------------------------------------------------- state ---- */

const EMPTY_GRAPH = buildGraph(null);

function initialState() {
  return {
    capabilities: { online: null, listSessions: null, step: null, checkpointStateId: null },
    agent: { agent: null, model: null, baseUrl: null, registered: [], loading: false },
    sessions: { items: [], status: 'idle', unsupported: false, filter: { status: null, q: '' } },
    session: { id: null, request: null, status: null, current: null, loading: false },
    trace: { data: null, graph: EMPTY_GRAPH, status: 'idle', fetchedAt: null },
    run: {
      phase: 'idle', // idle | running | paused | finished | failed | aborted
      mode: 'auto',
      stepIndex: 0,
      lastAction: null,
      nextAction: null,
      startedAt: null,
      controller: null,
    },
    selection: { id: null },
    result: null,
    error: null,
    busy: {},
  };
}

let state = initialState();
const listeners = new Set();

export function getState() {
  return state;
}

function set(patch) {
  state = typeof patch === 'function' ? { ...state, ...patch(state) } : { ...state, ...patch };
  for (const listener of listeners) listener();
}

function patch(key, value) {
  set((prev) => ({ [key]: typeof value === 'function' ? value(prev[key]) : value }));
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Subscribe to the store.
 *
 * `selector` must return a stable reference (a primitive, or an object that
 * already lives in the state tree). Returning a freshly built object on every
 * call makes useSyncExternalStore re-render forever.
 */
export function useQueryStore(selector = (s) => s) {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/* --------------------------------------------------------------- utils ---- */

function busy(key, on) {
  patch('busy', (prev) => ({ ...prev, [key]: on }));
}

function setError(err, extra = {}) {
  if (!err) {
    patch('error', null);
    return;
  }
  if (err instanceof ApiError && err.isAborted) return; // cancellation is not an error
  patch('error', {
    code: err.code ?? API_ERROR.NETWORK,
    message: err.message ?? 'Unexpected error.',
    detail: err.detail ?? null,
    fields: err.fields ?? [],
    endpoint: err.endpoint ?? null,
    status: err.status ?? 0,
    ...extra,
  });
}

function isOffline(err) {
  return err instanceof ApiError && err.isOffline;
}

function delay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* ------------------------------------------------------- capabilities ----- */

export async function probe() {
  busy('probe', true);
  try {
    const capabilities = await api.probeCapabilities();
    patch('capabilities', (prev) => ({ ...prev, ...capabilities }));
    if (capabilities.schema) {
      await loadSchema().catch(() => {});
    }
    if (capabilities.online) clearError();
    return capabilities;
  } finally {
    busy('probe', false);
  }
}

/* ------------------------------------------------------------ agent ------ */

export async function refreshAgent() {
  patch('agent', (prev) => ({ ...prev, loading: true }));
  try {
    const status = await api.getAgentStatus();
    patch('agent', {
      agent: status.agent,
      model: status.model,
      baseUrl: status.baseUrl,
      registered: status.registered,
      loading: false,
    });
    patch('capabilities', (prev) => ({ ...prev, online: true }));
    clearError();
    return status;
  } catch (err) {
    patch('agent', (prev) => ({ ...prev, loading: false }));
    if (isOffline(err)) patch('capabilities', (prev) => ({ ...prev, online: false }));
    setError(err);
    return null;
  }
}

export async function switchAgent(agentType) {
  busy('agent', true);
  try {
    const result = await api.selectAgent(agentType);
    patch('agent', (prev) => ({ ...prev, agent: result.agent }));
    await refreshAgent();
    return result;
  } catch (err) {
    setError(err);
    return null;
  } finally {
    busy('agent', false);
  }
}

/* ------------------------------------------------------ session history --- */

export function setSessionFilter({ status, q } = {}) {
  patch('sessions', (prev) => ({
    ...prev,
    filter: { status: status === undefined ? prev.filter.status : status, q: q === undefined ? prev.filter.q : q },
  }));
}

export async function loadSessions(params = {}) {
  const filter = { ...state.sessions.filter, ...params };
  patch('sessions', (prev) => ({ ...prev, status: 'loading', filter }));
  try {
    const { items, unsupported } = await api.listSessions(filter);
    patch('sessions', (prev) => ({ ...prev, items, status: 'ready', unsupported }));
    patch('capabilities', (prev) => ({ ...prev, listSessions: !unsupported }));
    return items;
  } catch (err) {
    patch('sessions', (prev) => ({ ...prev, status: 'error' }));
    if (!isOffline(err)) setError(err);
    return [];
  }
}

/* ------------------------------------------------------- current session -- */

export function resetSession() {
  abortRun();
  set({
    session: initialState().session,
    trace: { ...initialState().trace },
    result: null,
    selection: { id: null },
    error: null,
  });
}

/**
 * Load a past session: session + full trace. Read-only until the user runs a
 * new query.
 */
export async function openSession(sessionId) {
  if (!sessionId) return null;
  busy('openSession', true);
  abortRun();
  patch('run', initialState().run);
  patch('result', null);
  clearError();
  try {
    const trace = await api.getTrace(sessionId);
    applyTrace(trace);
    patch('session', {
      id: trace.session?.id ?? sessionId,
      request: trace.session?.request ?? null,
      status: trace.session?.status ?? null,
      current: trace.session?.currentStateId ?? null,
      loading: false,
    });
    const sessionStatus = trace.session?.status;
    patch('run', {
      ...initialState().run,
      phase: sessionStatus === 'completed' ? 'finished' : sessionStatus === 'failed' ? 'failed' : 'idle',
    });
    const currentId = trace.session?.currentStateId ?? trace.states[trace.states.length - 1]?.id;
    patch('selection', { id: currentId ?? null });
    return trace;
  } catch (err) {
    patch('session', (prev) => ({ ...prev, loading: false }));
    setError(err);
    return null;
  } finally {
    busy('openSession', false);
  }
}

/* ------------------------------------------------------------- trace ------ */

export async function refreshTrace(sessionId = state.session.id, { silent = true } = {}) {
  if (!sessionId) return null;
  if (!silent) patch('trace', (prev) => ({ ...prev, status: 'loading' }));
  try {
    const trace = await api.getTrace(sessionId);
    applyTrace(trace);
    return trace;
  } catch (err) {
    patch('trace', (prev) => ({ ...prev, status: 'error' }));
    setError(err);
    return null;
  }
}

function applyTrace(trace) {
  const graph = buildGraph(trace);
  schemaFromTrace(trace);
  patch('trace', { data: trace, graph, status: 'ready', fetchedAt: Date.now() });
  patch('session', (prev) => ({
    ...prev,
    id: graph.session?.id ?? prev.id,
    request: graph.session?.request ?? prev.request,
    status: graph.session?.status ?? prev.status,
    current: graph.session?.currentStateId ?? prev.current,
  }));
  patch('capabilities', (prev) => ({ ...prev, online: true }));
}

export function selectNode(id) {
  patch('selection', { id: id ? String(id) : null });
}

/**
 * Dragging a node is a purely visual, local override. The graph structure
 * itself always comes from the backend trace.
 */
export function setNodePosition(id, position) {
  if (!id || !position) return;
  patch('trace', (prev) => {
    const nodes = prev.graph.nodes.map((node) => (node.id === id ? { ...node, position } : node));
    return { ...prev, graph: { ...prev.graph, nodes } };
  });
}

/* --------------------------------------------------------------- run ------ */

/**
 * Start the decide -> apply loop.
 *
 * mode 'auto'  : run until FINISH / failure / maxSteps / abort
 * mode 'step'  : run one step, then park in phase 'paused'
 */
export async function startRun(prompt, { mode = 'auto', maxSteps = MAX_RUN_STEPS, stepDelayMs = STEP_DELAY_MS } = {}) {
  if (state.run.controller) return null;

  const text = String(prompt ?? '').trim();
  if (!text) {
    setError(new ApiError('Enter a query first.', { code: API_ERROR.PREFLIGHT }));
    return null;
  }

  const controller = new AbortController();
  set({
    error: null,
    result: null,
    selection: { id: null },
    session: { id: null, request: text, status: 'new', current: null, loading: true },
    trace: { ...initialState().trace },
    run: { phase: 'running', mode, stepIndex: 0, lastAction: null, nextAction: null, startedAt: Date.now(), controller },
  });

  try {
    const session = await api.createSession(text, { signal: controller.signal });
    patch('session', (prev) => ({ ...prev, id: session.id, status: session.status, current: session.currentStateId, loading: false }));
    await refreshTrace(session.id, { silent: true });
    await loadSessions();
  } catch (err) {
    finishRun(err);
    return null;
  }

  await runLoop({ maxSteps, stepDelayMs, single: mode === 'step' });
  return getState().run;
}

/** Run one step from phase 'paused'. */
export async function stepOnce({ stepDelayMs = 0 } = {}) {
  const { phase, controller } = state.run;
  if (!controller) return null;
  if (phase !== 'paused' && phase !== 'idle') return null;
  patch('run', (prev) => ({ ...prev, phase: 'running' }));
  await runLoop({ maxSteps: MAX_RUN_STEPS, stepDelayMs, single: true });
  return getState().run;
}

export function pauseRun() {
  if (state.run.phase !== 'running') return;
  patch('run', (prev) => ({ ...prev, phase: 'paused' }));
}

export function resumeRun({ stepDelayMs = STEP_DELAY_MS } = {}) {
  if (state.run.phase !== 'paused') return;
  patch('run', (prev) => ({ ...prev, phase: 'running' }));
  return runLoop({ maxSteps: MAX_RUN_STEPS, stepDelayMs });
}

export function abortRun() {
  const { controller } = state.run;
  controller?.abort?.();
  if (state.run.phase === 'running' || state.run.phase === 'paused') {
    patch('run', (prev) => ({ ...prev, phase: 'aborted', controller: null }));
  }
}

export function resetRun() {
  abortRun();
  patch('run', initialState().run);
  patch('error', null);
}

function finishRun(err) {
  const controller = state.run.controller;
  controller?.abort?.();
  if (err) {
    if (isOffline(err)) patch('capabilities', (prev) => ({ ...prev, online: false }));
    setError(err);
    patch('session', (prev) => ({ ...prev, loading: false }));
    patch('run', (prev) => ({ ...prev, phase: err.isAborted ? 'aborted' : 'failed', controller: null }));
  }
}

async function runLoop({ maxSteps, stepDelayMs, single = false }) {
  const controller = state.run.controller;
  if (!controller) return;

  while (true) {
    const { phase, stepIndex } = state.run;
    if (phase !== 'running') return;
    if (controller.signal?.aborted) {
      patch('run', (prev) => ({ ...prev, phase: 'aborted', controller: null }));
      return;
    }
    if (stepIndex >= maxSteps) {
      finishRun(
        new ApiError(`Stopped after ${maxSteps} steps without finishing.`, { code: API_ERROR.BAD_REQUEST }),
      );
      return;
    }

    const sessionId = state.session.id;
    if (!sessionId) {
      finishRun(new ApiError('No active session.', { code: API_ERROR.PREFLIGHT }));
      return;
    }

    await delay(stepDelayMs, controller.signal);

    try {
      const result = await api.step(sessionId, { signal: controller.signal });
      const decision = result.decision;

      patch('run', (prev) => ({
        ...prev,
        stepIndex: prev.stepIndex + 1,
        lastAction: decision ?? prev.lastAction,
        nextAction: null,
      }));

      await refreshTrace(sessionId, { silent: true });

      if (result.failure) {
        patch('run', (prev) => ({ ...prev, phase: 'failed', controller: null }));
        setError(
          new ApiError(`${result.failure.actionType ?? 'Action'} failed: ${result.failure.message}`, {
            code: API_ERROR.BAD_REQUEST,
            detail: result.failure,
          }),
        );
        return;
      }

      if (decision?.action_type === 'FINISH') {
        const finished = await api.finish(sessionId, { signal: controller.signal });
        patch('result', finished);
        patch('session', (prev) => ({ ...prev, status: 'completed' }));
        patch('run', (prev) => ({ ...prev, phase: 'finished', controller: null }));
        await refreshTrace(sessionId, { silent: true });
        return;
      }

      if (single) {
        patch('run', (prev) => ({ ...prev, phase: 'paused' }));
        return;
      }
    } catch (err) {
      finishRun(err);
      return;
    }
  }
}

/* --------------------------------------------- checkpoints & recovery ----- */

/**
 * Pin a checkpoint on a specific state.
 * Returns the checkpoint, or null when it cannot be pinned.
 */
export async function setCheckpoint(stateId, label = null) {
  const sessionId = state.session.id;
  if (!sessionId) {
    setError(new ApiError('No active session to checkpoint.', { code: API_ERROR.PREFLIGHT }));
    return null;
  }
  const target = stateId ?? state.selection.id ?? state.session.current;
  if (!target) {
    setError(new ApiError('Select a node to checkpoint.', { code: API_ERROR.PREFLIGHT }));
    return null;
  }

  busy('checkpoint', true);
  try {
    const checkpoint = await api.createCheckpoint(sessionId, { stateId: target, label });
    await refreshTrace(sessionId);
    patch('capabilities', (prev) => ({
      ...prev,
      checkpointStateId: checkpoint.pinnedToCurrentState ? false : true,
    }));
    if (checkpoint.pinnedToCurrentState) {
      console.warn('[queryStore] backend pinned the checkpoint to the current state; state_id was ignored.');
    }
    return checkpoint;
  } catch (err) {
    setError(err);
    return null;
  } finally {
    busy('checkpoint', false);
  }
}

export function listCheckpoints() {
  return state.trace.graph.checkpoints;
}

/**
 * Branch from a checkpoint with a structured correction.
 *
 * Checkpoint resolution order:
 *   explicit checkpointId -> checkpoint on `stateId` -> checkpoint on the
 *   selected node -> create one on the selected node.
 * If nothing can be resolved, rejects with NO_CHECKPOINT instead of sending
 * a fabricated id (which the backend 404s on).
 */
export async function recover({ checkpointId, stateId, action } = {}) {
  const sessionId = state.session.id;
  if (!sessionId) {
    const err = new ApiError('No active session to recover.', { code: API_ERROR.PREFLIGHT });
    setError(err);
    throw err;
  }

  busy('recover', true);
  try {
    const graph = state.trace.graph;
    let cpId = checkpointId ?? null;

    if (!cpId) {
      const target = stateId ?? state.selection.id ?? state.session.current;
      cpId = target ? graph.checkpointsByState.get(String(target))?.id ?? null : null;
    }

    if (!cpId) {
      const created = await setCheckpoint(stateId ?? state.selection.id ?? state.session.current, 'recovery-base');
      cpId = created?.id ?? null;
    }

    if (!cpId) {
      const err = new ApiError('No checkpoint available. Set one on the node you want to branch from.', {
        code: API_ERROR.NO_CHECKPOINT,
        fields: ['checkpoint_id'],
      });
      setError(err);
      throw err;
    }

    const result = await api.recover(sessionId, { checkpointId: cpId, action });
    await refreshTrace(sessionId);

    if (result.state?.id) selectNode(result.state.id);
    if (result.failure) {
      setError(
        new ApiError(`${result.failure.actionType ?? 'Correction'} failed: ${result.failure.message}`, {
          code: API_ERROR.BAD_REQUEST,
          detail: result.failure,
        }),
      );
    }
    return { ...result, checkpointId: cpId };
  } catch (err) {
    setError(err);
    throw err;
  } finally {
    busy('recover', false);
  }
}

/**
 * Explicit FINISH. The run loop calls this itself when the agent decides to
 * finish; the button exists because the spec asks for a manual finish.
 */
export async function finishNow() {
  const sessionId = state.session.id;
  if (!sessionId) {
    setError(new ApiError('No active session to finish.', { code: API_ERROR.PREFLIGHT }));
    return null;
  }
  busy('finishing', true);
  try {
    const result = await api.finish(sessionId);
    patch('result', () => result);
    await refreshTrace(sessionId);
    patch('run', (prev) => ({ ...prev, phase: 'finished', controller: null }));
    return result;
  } catch (err) {
    setError(err);
    return null;
  } finally {
    busy('finishing', false);
  }
}

/**
 * Deterministic demo failure: the backend always rejects column 'CGPA'.
 * Lets the recovery demo run without depending on the LLM misbehaving.
 */
export function forceFailure() {
  return applyRawAction(DEMO_FAILURE_ACTION);
}

/** Apply one explicit action, then refresh the trace. */
export async function applyRawAction(action) {
  const sessionId = state.session.id;
  if (!sessionId) {
    setError(new ApiError('No active session.', { code: API_ERROR.PREFLIGHT }));
    return null;
  }
  busy('applyAction', true);
  try {
    const result = await api.applyAction(sessionId, action);
    await refreshTrace(sessionId);
    if (result.state?.id) selectNode(result.state.id);
    if (result.failure) {
      setError(
        new ApiError(`${result.failure.actionType ?? 'Action'} failed: ${result.failure.message}`, {
          code: API_ERROR.BAD_REQUEST,
          detail: result.failure,
        }),
      );
    }
    return result;
  } catch (err) {
    setError(err);
    return null;
  } finally {
    busy('applyAction', false);
  }
}

/** Cached preview for a node — no network, the trace already carries it. */
export function previewState(stateId) {
  const id = stateId ?? state.selection.id;
  if (!id) return null;
  return state.trace.graph.byId.get(String(id))?.preview ?? null;
}

export function clearError() {
  patch('error', null);
}

export function reset() {
  resetSession();
  resetRun();
  patch('result', null);
}

/* ------------------------------------------------- schema (advisory) ------ */

export { setSchema, loadSchema };
