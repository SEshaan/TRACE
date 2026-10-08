/**
 * lib/flowMapping.js
 * ---------------------------------------------------------------------------
 * The only place domain graph nodes become React Flow nodes.
 *
 * Kept separate from lib/traceGraph.js so the graph model stays UI-free and
 * this mapping stays pure and testable. Field names here are the contract
 * QueryActionNode.jsx consumes; nothing is invented — a missing backend value
 * renders as '—' in the node, never as a guess.
 * ---------------------------------------------------------------------------
 */

import { EDGE_KIND } from './traceGraph';
import { FAIL_STATE_ACTION_TYPES } from '../constants/backend';

/** Backend state status -> the vocabulary QueryActionNode styles. */
export function toFlowStatus(node) {
  if (node.failure) return 'FAILED';
  return String(node.status ?? 'active').toUpperCase();
}

/**
 * @param {Array} nodes  graph.nodes from lib/traceGraph.buildGraph
 * @param {string} selectedId
 */
export function toFlowNodes(nodes, { selectedId = null, edges = [] } = {}) {
  const recovered = recoveredTargetSet(edges);

  return (nodes ?? []).map((node) => ({
    id: node.id,
    type: 'queryAction',
    position: node.position ?? { x: 0, y: 0 },
    selected: node.id === selectedId,
    draggable: false,
    data: {
      id: node.id,
      parentId: node.parentId ?? null,
      action: node.actionType,
      // Original request, shown on the START node.
      request: node.request ?? null,
      // Graceful agent decline (INSUFFICIENT_INFO / SCHEMA_MISSING / ABORT_QUERY).
      // Distinct from a hard failure so the UI can render an amber "declined" node.
      isDeclined: FAIL_STATE_ACTION_TYPES.includes(node.actionType ?? null),
      label: node.label,
      params: node.params,
      status: toFlowStatus(node),
      confidence: node.confidence ?? null,
      row_count: node.preview?.rowCount ?? null,
      execution_time_ms: node.preview?.executionTimeMs ?? null,
      checkpoint_id: node.checkpointId ?? null,
      checkpoint_label: node.checkpointLabel ?? null,
      // A graceful decline carries no `failure` object, so its reason lives in
      // the action params. Surface it here too as a fallback for any consumer
      // that reads failure_reason.
      failure_reason:
        node.failure?.message ??
        (node.actionType && FAIL_STATE_ACTION_TYPES.includes(node.actionType)
          ? node.params?.reason ?? null
          : null),
      failure_code: node.failure?.code ?? null,
      clarification: recovered.has(node.id)
        ? recoveryNote(node)
        : null,
      is_active_branch: node.onActivePath !== false,
      branch_id: node.branchId ?? 'main',
      sql: node.sql ?? null,
      displaySql: node.displaySql ?? null,
      preview: node.preview ?? null,
      depth: node.depth ?? 0,
      isCurrent: node.isCurrent === true,
    },
  }));
}

/**
 * @param {Array} edges  graph.edges from buildGraph
 */
export function toFlowEdges(edges) {
  return (edges ?? []).map((edge) => {
    const base = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type ?? 'smoothstep',
      kind: edge.kind,
      animated: edge.animated === true,
      style: edge.style,
      markerEnd: edge.markerEnd,
    };

    if (edge.label) {
      base.label = edge.label;
      base.labelStyle = { fill: '#1e40af', fontWeight: 600, fontSize: 11 };
      base.labelBgStyle = { fill: '#eff6ff', stroke: '#93c5fd', strokeWidth: 1, rx: 4, ry: 4 };
      base.labelBgPadding = [6, 4];
      base.labelBgBorderRadius = 4;
    }

    return base;
  });
}

/** Node ids whose incoming edge is a recovery branch. */
export function recoveredTargetSet(edges) {
  const set = new Set();
  for (const edge of edges ?? []) {
    if (edge.kind === EDGE_KIND.RECOVERED) set.add(edge.target);
  }
  return set;
}

function recoveryNote(node) {
  const label = node.checkpointLabel ? ` '${node.checkpointLabel}'` : '';
  return `Recovered from checkpoint${label}`;
}
