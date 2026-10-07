import { describe, it, expect } from 'vitest';
import { buildGraph, EDGE_KIND } from './traceGraph';
import traceRecovered from '../fixtures/api/trace.recovered.json';
import traceDuplicate from '../fixtures/api/trace.duplicateStates.json';

const IDS = {
  root: '3b58d100-0000-4000-8000-000000000001',
  table: '389b658f-0000-4000-8000-000000000002',
  column: 'bafbad16-0000-4000-8000-000000000003',
  clone: '72908499-0000-4000-8000-000000000004',
  filter: 'a1d6a4af-0000-4000-8000-000000000005',
};

describe('buildGraph — the 5-state recovered trace', () => {
  const graph = buildGraph(traceRecovered);

  it('produces one node per state, one edge per parent link', () => {
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(4);
  });

  it('uses backend state ids as node ids', () => {
    expect(graph.nodes.map((n) => n.id)).toEqual([IDS.root, IDS.table, IDS.column, IDS.clone, IDS.filter]);
  });

  it('walks the active path from the current state back to the root', () => {
    expect(graph.activePath).toEqual([IDS.root, IDS.table, IDS.column, IDS.clone, IDS.filter]);
    expect(graph.current).toBe(IDS.filter);
  });

  it('marks exactly one node as current', () => {
    expect(graph.nodes.filter((n) => n.isCurrent).map((n) => n.id)).toEqual([IDS.filter]);
  });

  it('links the checkpoint to its state, not to the current state', () => {
    const node = graph.nodesById.get(IDS.column);
    expect(node.checkpoint?.id).toBe('e7590711-0000-4000-8000-0000000000c4');
    expect(node.checkpointLabel).toBe('base');
    expect(graph.nodesById.get(IDS.filter).checkpoint).toBeNull();
  });

  it('paints the branch edge out of the checkpoint as recovered', () => {
    const kinds = Object.fromEntries(graph.edges.map((e) => [e.target, e.kind]));
    expect(kinds[IDS.table]).toBe(EDGE_KIND.SUCCESS);
    expect(kinds[IDS.column]).toBe(EDGE_KIND.SUCCESS);
    expect(kinds[IDS.clone]).toBe(EDGE_KIND.RECOVERED);
    expect(kinds[IDS.filter]).toBe(EDGE_KIND.SUCCESS);
  });

  it('labels the recovered edge with the correction, not a fabricated string', () => {
    const recovered = graph.edges.find((e) => e.kind === EDGE_KIND.RECOVERED);
    expect(recovered.label).toBe('SELECT *');
  });

  it('gives every edge an arrowhead', () => {
    for (const edge of graph.edges) {
      expect(edge.markerEnd?.type).toBe('arrowclosed');
      expect(edge.style.stroke).toBeTruthy();
    }
  });

  it('carries the real preview rows and row counts', () => {
    expect(graph.nodesById.get(IDS.table).preview.rowCount).toBe(8);
    expect(graph.nodesById.get(IDS.filter).preview.rowCount).toBe(4);
    expect(graph.nodesById.get(IDS.root).preview).toBeNull();
  });

  it('does not invent confidence for a state with no action', () => {
    expect(graph.nodesById.get(IDS.root).confidence).toBeNull();
    expect(graph.nodesById.get(IDS.root).actionType).toBeNull();
    expect(graph.nodesById.get(IDS.root).label).toBeNull();
  });

  it('reports the real action confidence', () => {
    expect(graph.nodesById.get(IDS.filter).confidence).toBe(1.0);
    expect(graph.nodesById.get(IDS.filter).params).toMatchObject({ column: 'gpa', operator: '>', value: 8.5 });
  });

  it('sums latency over the active path only', () => {
    expect(graph.stats.totalLatencyMs).toBe(3.28);
    expect(graph.stats.stateCount).toBe(5);
    expect(graph.stats.actionCount).toBe(3);
    expect(graph.stats.checkpointCount).toBe(1);
    expect(graph.stats.failureCount).toBe(1);
    expect(graph.stats.rowCount).toBe(4);
  });

  it('assigns positions to every node', () => {
    for (const node of graph.nodes) {
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
    }
  });

  it('preserves the untouched server payload on each node', () => {
    expect(graph.nodesById.get(IDS.filter).raw.action.parameters ?? graph.nodesById.get(IDS.filter).raw.action.value).toBeTruthy();
    expect(graph.nodesById.get(IDS.filter).raw.parent_id).toBe(IDS.clone);
  });
});

describe('buildGraph — duplicate state ids', () => {
  const graph = buildGraph(traceDuplicate);

  it('never emits two nodes with the same id', () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('suffixes the collision instead of dropping the node', () => {
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.map((n) => n.id)).toContain(`${IDS.column}#2`);
  });

  it('attaches the failure to a node so the failed branch is renderable', () => {
    const failed = graph.nodes.find((n) => n.failure);
    expect(failed).toBeTruthy();
    expect(failed.failure.code).toBe('VALIDATION_FAILED');
    expect(failed.failure.message).toContain('CGPA');
  });

  it('paints the edge into a failed node as failed', () => {
    const failed = graph.nodes.find((n) => n.failure);
    const edge = graph.edges.find((e) => e.target === failed.id);
    expect(edge.kind).toBe(EDGE_KIND.FAILED);
  });
});

describe('buildGraph — degenerate input', () => {
  it('returns an empty graph shape for null', () => {
    const graph = buildGraph(null);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.activePath).toEqual([]);
    expect(graph.stats.stateCount).toBe(0);
  });

  it('treats a state with an unknown parent as a root', () => {
    const graph = buildGraph({
      session: { id: 's', current_state_id: 'b' },
      states: [
        { id: 'a', parent_id: 'missing', status: 'active', action_count: 1, action: { action_type: 'LIMIT', limit: 5 } },
        { id: 'b', parent_id: 'a', status: 'active', action_count: 2, action: { action_type: 'FINISH' } },
      ],
      checkpoints: [],
      failures: [],
    });
    expect(graph.edges.filter((e) => e.source === 'missing')).toHaveLength(0);
    expect(graph.nodes.find((n) => n.id === 'a').parentId).toBeNull();
    expect(graph.activePath).toEqual(['a', 'b']);
  });

  it('terminates on a parent cycle', () => {
    const graph = buildGraph({
      session: { id: 's', current_state_id: 'b' },
      states: [
        { id: 'a', parent_id: 'b', status: 'active', action_count: 1 },
        { id: 'b', parent_id: 'a', status: 'active', action_count: 1 },
      ],
      checkpoints: [],
      failures: [],
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.activePath.length).toBeGreaterThan(0);
  });
});
