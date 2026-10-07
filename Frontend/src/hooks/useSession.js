/**
 * hooks/useSession.js
 * ---------------------------------------------------------------------------
 * The current session: trace-derived graph, selection, checkpoints, recovery.
 *
 * Orchestration only — every action delegates to the store.
 * ---------------------------------------------------------------------------
 */

import { useEffect, useMemo } from 'react';
import {
  getState,
  useQueryStore,
  probe,
  refreshAgent,
  refreshTrace,
  selectNode,
  setCheckpoint,
  recover as recoverAction,
  forceFailure,
  applyRawAction,
  previewState,
  openSession,
  clearError,
} from '../store/queryStore';

export function useSession({ autoLoad = true } = {}) {
  const { session, trace, selection, busy, capabilities, error } = useQueryStore();

  useEffect(() => {
    if (!autoLoad) return;
    probe();
    refreshAgent();
  }, [autoLoad]);

  const graph = trace.graph;

  const selectedNode = selection.id ? (graph.nodesById.get(selection.id) ?? null) : null;

  const checkpointsForState = useMemo(() => graph.checkpointsByState, [graph]);

  return {
    /* data */
    session,
    trace: trace.data,
    graph,
    nodes: graph.nodes,
    edges: graph.edges,
    stats: graph.stats,
    checkpoints: graph.checkpoints,
    failures: graph.failures,
    activePath: graph.activePath,
    current: graph.current,

    /* selection */
    selectedNodeId: selection.id,
    selectedNode,
    selectNode,

    /* status */
    traceStatus: trace.status,
    fetchedAt: trace.fetchedAt,
    isBusy: Boolean(busy.checkpoint || busy.recover || busy.applyAction || busy.openSession),
    isOnline: capabilities.online !== false,
    capabilities,
    error,
    clearError,

    /* actions */
    refresh: () => refreshTrace(),
    openSession,
    setCheckpoint,
    listCheckpoints: () => getState().trace.graph.checkpoints,
    checkpointsForState,
    checkpointFor: (stateId) => (stateId ? checkpointsForState.get(String(stateId)) ?? null : null),
    recover: recoverAction,
    forceFailure,
    applyAction: applyRawAction,
    previewState,
  };
}
