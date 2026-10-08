import { describe, it, expect } from 'vitest';
import { toFlowNodes, toFlowEdges, toFlowStatus, recoveredTargetSet } from './flowMapping';
import { buildGraph, EDGE_KIND } from './traceGraph';
import traceRecovered from '../fixtures/api/trace.recovered.json';
import traceDuplicate from '../fixtures/api/trace.duplicateStates.json';

const graph = buildGraph(traceRecovered);
const flowNodes = toFlowNodes(graph.nodes, { edges: graph.edges });
const flowEdges = toFlowEdges(graph.edges);

describe('toFlowNodes', () => {
  it('produces the shape React Flow requires', () => {
    for (const node of flowNodes) {
      expect(typeof node.id).toBe('string');
      expect(node.type).toBe('queryAction');
      expect(typeof node.position.x).toBe('number');
      expect(typeof node.position.y).toBe('number');
      expect(node.data).toBeTypeOf('object');
    }
  });

  it('carries the field names QueryActionNode reads', () => {
    const filter = flowNodes.find((n) => n.data.action === 'FILTER');
    expect(filter.data.params).toMatchObject({ column: 'gpa', operator: '>', value: 8.5 });
    expect(filter.data.row_count).toBe(4);
    expect(filter.data.execution_time_ms).toBeTypeOf('number');
    expect(filter.data.confidence).toBe(1);
    expect(filter.data.branch_id).toBeTruthy();
  });

  it('marks the checkpointed node so the amber badge renders', () => {
    const cp = flowNodes.find((n) => n.data.checkpoint_id);
    expect(cp.data.checkpoint_id).toBe('e7590711-0000-4000-8000-0000000000c4');
    expect(flowNodes.filter((n) => n.data.checkpoint_id)).toHaveLength(1);
  });

  it('labels the recovery branch, and only the recovery branch', () => {
    const noted = flowNodes.filter((n) => n.data.clarification);
    expect(noted).toHaveLength(1);
    expect(noted[0].data.clarification).toContain('Recovered from checkpoint');
  });

  it('flags off-branch nodes as inactive', () => {
    const inactive = flowNodes.filter((n) => n.data.is_active_branch === false);
    expect(inactive.length).toBeGreaterThanOrEqual(0);
    for (const node of flowNodes) {
      expect(typeof node.data.is_active_branch).toBe('boolean');
    }
  });

  it('marks exactly one node as current and selected', () => {
    expect(flowNodes.filter((n) => n.data.isCurrent)).toHaveLength(1);
    const selected = toFlowNodes(graph.nodes, { edges: graph.edges, selectedId: graph.current });
    expect(selected.filter((n) => n.selected)).toHaveLength(1);
  });

  it('never invents a value the backend did not send', () => {
    const root = flowNodes.find((n) => n.id === flowNodes[0].id);
    expect(root.data.action).toBeNull();
    expect(root.data.confidence).toBeNull();
    expect(root.data.row_count).toBeNull();
    expect(root.data.execution_time_ms).toBeNull();
  });

  it('renders a failed state as FAILED', () => {
    const failedGraph = buildGraph(traceDuplicate);
    const nodes = toFlowNodes(failedGraph.nodes, { edges: failedGraph.edges });
    expect(nodes.some((n) => n.data.status === 'FAILED')).toBe(true);
    expect(nodes.some((n) => n.data.failure_reason)).toBe(true);
  });

  it('flags a graceful decline and surfaces its reason without inventing a failure', () => {
    // A fail-action node: status=failed but NO failure object; the reason lives
    // in the action params. toFlowNodes must surface both for QueryActionNode.
    const nodes = toFlowNodes(
      [
        {
          id: 'decl-1',
          parentId: null,
          depth: 0,
          branchId: 'main',
          position: { x: 0, y: 0 },
          status: 'failed',
          actionType: 'ABORT_QUERY',
          params: { reason: 'No matching table.' },
          confidence: null,
          decision: null,
          label: 'ABORT_QUERY',
          sql: null,
          preview: null,
          actionCount: 1,
          checkpoint: null,
          failure: null,
          failures: [],
          isCurrent: false,
          isTerminal: true,
          onActivePath: true,
          hasChildren: false,
          raw: {},
        },
      ],
      { edges: [] },
    );
    expect(nodes[0].data.isDeclined).toBe(true);
    expect(nodes[0].data.action).toBe('ABORT_QUERY');
    expect(nodes[0].data.failure_reason).toBe('No matching table.');
    // the decline reason comes from params, not a failure object
    expect(nodes[0].data.failure_code).toBeNull();
  });

  it('is safe on empty input', () => {
    expect(toFlowNodes([], { edges: [] })).toEqual([]);
    expect(toFlowNodes(null, { edges: null })).toEqual([]);
  });
});

describe('toFlowStatus', () => {
  it('maps backend statuses onto the node vocabulary', () => {
    expect(toFlowStatus({ status: 'active' })).toBe('ACTIVE');
    expect(toFlowStatus({ status: 'new' })).toBe('NEW');
    expect(toFlowStatus({ status: 'completed' })).toBe('COMPLETED');
    expect(toFlowStatus({ status: 'failed' })).toBe('FAILED');
    expect(toFlowStatus({})).toBe('ACTIVE');
  });

  it('a state carrying a failure is FAILED even when the backend says active', () => {
    expect(toFlowStatus({ status: 'active', failure: { code: 'VALIDATION_FAILED' } })).toBe('FAILED');
  });
});

describe('toFlowEdges', () => {
  it('keeps the kind-based styling produced by the graph', () => {
    for (const edge of flowEdges) {
      expect(edge.style.stroke).toMatch(/^#/);
      expect(edge.markerEnd.type).toBe('arrowclosed');
      expect(edge.markerEnd.color).toBe(edge.style.stroke);
      expect(edge.type).toBe('smoothstep');
    }
  });

  it('gives the recovered edge an animated, labelled, pill-backed label', () => {
    const recovered = flowEdges.find((e) => e.kind === EDGE_KIND.RECOVERED);
    expect(recovered.animated).toBe(true);
    expect(recovered.label).toBeTruthy();
    expect(recovered.labelBgPadding).toEqual([6, 4]);
  });

  it('leaves plain edges unlabelled', () => {
    for (const edge of flowEdges.filter((e) => e.kind === EDGE_KIND.SUCCESS)) {
      expect(edge.label).toBeUndefined();
      expect(edge.animated).toBe(false);
    }
  });

  it('is safe on empty input', () => {
    expect(toFlowEdges([])).toEqual([]);
    expect(toFlowEdges(null)).toEqual([]);
  });
});

describe('recoveredTargetSet', () => {
  it('finds the clone node created by the recovery', () => {
    expect([...recoveredTargetSet(graph.edges)]).toEqual([
      graph.nodes.find((n) => n.parentId === 'bafbad16-0000-4000-8000-000000000003').id,
    ]);
  });

  it('returns an empty set when there is no recovery', () => {
    expect(recoveredTargetSet([]).size).toBe(0);
  });
});
