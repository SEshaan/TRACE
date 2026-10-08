/**
 * lib/traceGraph.js
 * ---------------------------------------------------------------------------
 * The ONE canonical conversion: trace -> graph.
 *
 *   trace -> { nodes, edges, checkpoints, failures, activePath, stats }
 *
 * Rules:
 *   - node.id is the backend state id; collisions get a '#n' suffix and a
 *     console warning, never a silent duplicate (React Flow breaks on dupes).
 *   - missing data stays null. Nothing is invented.
 *   - `raw` is preserved on every node.
 *   - positions come from lib/layout.js, which is pure.
 * ---------------------------------------------------------------------------
 */

import { normalizeTrace } from './normalize';
import { describeAction } from './actions';
import { tidyTreeLayout } from './layout';

export const EDGE_KIND = {
  SUCCESS: 'success',
  FAILED: 'failed',
  RECOVERED: 'recovered',
  INACTIVE: 'inactive',
};

export const EDGE_STYLE = {
  [EDGE_KIND.SUCCESS]: { stroke: '#10b981', strokeWidth: 2, animated: false, dash: undefined },
  [EDGE_KIND.FAILED]: { stroke: '#ef4444', strokeWidth: 2, animated: false, dash: '5 5' },
  [EDGE_KIND.RECOVERED]: { stroke: '#3b82f6', strokeWidth: 2.5, animated: true, dash: undefined },
  [EDGE_KIND.INACTIVE]: { stroke: '#9ca3af', strokeWidth: 1.5, animated: false, dash: '4 4' },
};

/**
 * @param {object} trace  normalized trace (from api/client.getTrace)
 * @returns the graph shape the UI consumes
 */
export function buildGraph(trace) {
  const normalized = trace?.states?.[0]?.raw !== undefined ? trace : normalizeTrace(trace);

  const empty = {
    session: normalized?.session ?? null,
    current: null,
    nodes: [],
    edges: [],
    byId: new Map(),
    nodesById: new Map(),
    childrenOf: new Map(),
    checkpoints: [],
    failures: [],
    checkpointsByState: new Map(),
    failuresByState: new Map(),
    activePath: [],
    stats: emptyStats(),
  };

  if (!normalized || !Array.isArray(normalized.states) || normalized.states.length === 0) {
    return empty;
  }

  /* ------------------------------------------------ unique node identities */
  const seen = new Map();
  const entries = [];
  for (const state of normalized.states) {
    if (!state?.id) continue;
    const n = seen.get(state.id) ?? 0;
    seen.set(state.id, n + 1);
    entries.push({ state, id: n === 0 ? String(state.id) : `${state.id}#${n + 1}` });
    if (n > 0) {
      console.warn(`[traceGraph] duplicate state id '${state.id}' -> '${state.id}#${n + 1}'`);
    }
  }

  const byId = new Map(entries.map((e) => [e.id, e.state]));
  const childrenOf = new Map();
  const childIdsOf = new Map();

  for (const { state, id } of entries) {
    const parentId = state.parentId ? String(state.parentId) : null;
    // A state whose parent is absent from the trace is treated as a root.
    const link = parentId && byId.has(parentId) ? parentId : null;
    if (link) {
      if (!childrenOf.has(link)) childrenOf.set(link, []);
      childrenOf.get(link).push(id);
      childIdsOf.set(id, link);
    }
  }

  const roots = entries.filter(({ id }) => !childIdsOf.has(id)).map(({ id }) => id);

  /* ----------------------------------------------------------- depth pass */
  const depthOf = new Map();
  const assignDepth = (id, depth) => {
    depthOf.set(id, depth);
    for (const child of childrenOf.get(id) ?? []) {
      if (!depthOf.has(child)) assignDepth(child, depth + 1);
    }
  };
  roots.forEach((id) => assignDepth(id, 0));
  for (const { id } of entries) if (!depthOf.has(id)) depthOf.set(id, 0);

  /* -------------------------------------------------------- active branch */
  const currentStateId = normalized.session?.currentStateId ? String(normalized.session.currentStateId) : null;
  const activePath = deriveActivePath(currentStateId, childIdsOf);
  const activeSet = new Set(activePath);

  /* --------------------------------------------- checkpoint / failure maps */
  const checkpointsByState = new Map();
  for (const cp of normalized.checkpoints) {
    if (cp?.stateId) checkpointsByState.set(String(cp.stateId), cp);
  }

  const failuresByState = new Map();
  for (const failure of normalized.failures) {
    const key = failure?.stateId ? String(failure.stateId) : null;
    if (key && byId.has(key)) {
      if (!failuresByState.has(key)) failuresByState.set(key, []);
      failuresByState.get(key).push(failure);
    }
  }
  // Failures with no state_id (older backend builds) attach to the state the
  // failure response echoed, flagged so the UI can say "approximate".
  for (const { state, id } of entries) {
    if (state.failure && !failuresByState.has(id)) failuresByState.set(id, [state.failure]);
  }

  /* ------------------------------------------------------------ branch ids */
  const branchOf = new Map();
  const assignBranch = (id, branchId) => {
    branchOf.set(id, branchId);
    const children = childrenOf.get(id) ?? [];
    children.forEach((child, index) => {
      const keepActive = activeSet.has(child) || index === 0;
      assignBranch(child, keepActive ? branchId : `${branchId}.${index}`);
    });
  };
  roots.forEach((id, index) => assignBranch(id, index === 0 ? 'main' : `branch-${index + 1}`));

  /* ------------------------------------------------------------- the nodes */
  const positions = tidyTreeLayout(
    entries.map(({ id }) => ({ id, parentId: childIdsOf.get(id) ?? null, depth: depthOf.get(id) ?? 0 })),
    { roots },
  );

  const nodes = entries.map(({ state, id }) => {
    const failures = failuresByState.get(id) ?? [];
    const checkpoint = checkpointsByState.get(id) ?? null;
    const action = state.action;

    return {
      id,
      parentId: childIdsOf.get(id) ?? null,
      depth: depthOf.get(id) ?? 0,
      branchId: branchOf.get(id) ?? 'main',
      position: positions.get(id) ?? { x: 0, y: 0 },

      status: state.status,
      actionType: action?.type ?? null,
      params: action?.params ?? null,
      confidence: action?.confidence ?? state.decision?.confidence ?? null,
      // The original natural-language request, threaded to the start node so it
      // can render as a distinct "START" card instead of a generic ACTION.
      request: normalized.session?.request ?? null,
      decision: state.decision ?? null,
      label: action?.type ? describeAction(action.type, action.params ?? {}) : null,

      sql: state.sql ?? null,
      displaySql: state.displaySql ?? null,
      preview: state.preview ?? null,
      actionCount: state.actionCount ?? 0,

      checkpoint,
      checkpointId: checkpoint?.id ?? null,
      checkpointLabel: checkpoint?.label ?? null,

      failure: failures[0] ?? null,
      failures,

      isCurrent: id === currentStateId,
      isTerminal: state.status === 'failed' || state.status === 'completed',
      onActivePath: activeSet.has(id),
      hasChildren: (childrenOf.get(id) ?? []).length > 0,

      raw: state.raw ?? state,
    };
  });

  /* ------------------------------------------------------------- the edges */
  const edges = [];
  for (const { state, id } of entries) {
    const parentId = childIdsOf.get(id);
    if (!parentId) continue;

    const kind = edgeKind({
      childState: state,
      childId: id,
      parentId,
      activeSet,
      checkpointsByState,
      failuresByState,
    });
    const style = EDGE_STYLE[kind];
    const childAction = state.action;

    edges.push({
      id: `e-${parentId}-${id}`,
      source: parentId,
      target: id,
      kind,
      type: 'smoothstep',
      animated: style.animated,
      label: kind === EDGE_KIND.RECOVERED && childAction?.type
        ? describeAction(childAction.type, childAction.params ?? {})
        : undefined,
      labelShowBg: kind === EDGE_KIND.RECOVERED,
      style: { stroke: style.stroke, strokeWidth: style.strokeWidth, strokeDasharray: style.dash },
      markerEnd: { type: 'arrowclosed', color: style.stroke, width: 18, height: 18 },
    });
  }

  return {
    session: normalized.session,
    current: currentStateId,
    nodes,
    edges,
    byId,
    nodesById: new Map(nodes.map((n) => [n.id, n])),
    childrenOf,
    checkpoints: normalized.checkpoints,
    failures: normalized.failures,
    checkpointsByState,
    failuresByState,
    activePath,
    stats: graphStats({ normalized, nodes, activeSet, currentStateId }),
  };
}

function edgeKind({ childState, childId, parentId, activeSet, checkpointsByState, failuresByState }) {
  if (childState?.status === 'failed' || failuresByState.has(childId)) return EDGE_KIND.FAILED;
  if (!activeSet.has(childId)) return EDGE_KIND.INACTIVE;
  if (checkpointsByState.has(parentId)) return EDGE_KIND.RECOVERED;
  return EDGE_KIND.SUCCESS;
}

/** Ancestors of the current state, root first. */
export function deriveActivePath(currentStateId, parentOf) {
  if (!currentStateId) return [];
  const path = [];
  const guard = new Set();
  let cursor = String(currentStateId);
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    path.push(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return path.reverse();
}

function emptyStats() {
  return {
    stateCount: 0,
    actionCount: 0,
    checkpointCount: 0,
    failureCount: 0,
    totalLatencyMs: null,
    rowCount: null,
    modelVersion: null,
    finishedAt: null,
  };
}

export function graphStats({ normalized, nodes, activeSet, currentStateId }) {
  const latencyValues = nodes
    .filter((n) => activeSet.has(n.id))
    .map((n) => n.preview?.executionTimeMs)
    .filter((v) => typeof v === 'number');

  const current = nodes.find((n) => n.id === currentStateId) ?? null;
  const completed = nodes.find((n) => n.status === 'completed') ?? null;

  return {
    stateCount: nodes.length,
    actionCount: Math.max(0, ...nodes.map((n) => n.actionCount ?? 0)),
    checkpointCount: normalized.checkpoints.length,
    failureCount: normalized.failures.length,
    totalLatencyMs: latencyValues.length > 0 ? Number(latencyValues.reduce((a, b) => a + b, 0).toFixed(2)) : null,
    rowCount: current?.preview?.rowCount ?? completed?.preview?.rowCount ?? null,
    modelVersion: normalized.session?.modelVersion ?? null,
    finishedAt: completed ? completed.raw?.created_at ?? null : null,
  };
}
