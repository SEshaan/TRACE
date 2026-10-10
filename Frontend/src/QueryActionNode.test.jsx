// @vitest-environment happy-dom
/**
 * QueryActionNode.test.jsx — focused render tests for the node's status/label/
 * param/confidence derivation. Panda's generated `css` module isn't present in
 * dev (it's codegen'd at build time), so we stub it to a constant className;
 * @xyflow/react + lucide-react resolve normally under happy-dom.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(cleanup);
import { ReactFlowProvider } from '@xyflow/react';

vi.mock('../styled-system/css', () => ({ css: (..._args) => 'panda-node' }));

import QueryActionNode from './QueryActionNode';

/** Render a single node inside a ReactFlowProvider (its @xyflow Handle needs one).
 * Returns the container for text queries. */
function renderNode(data, selected = false) {
  render(
    <ReactFlowProvider>
      <QueryActionNode data={data} selected={selected} />
    </ReactFlowProvider>,
  );
  return screen;
}

describe('QueryActionNode — START / action labels', () => {
  it('renders a distinct START card when there is no action', () => {
    const s = renderNode({ status: 'SUCCESS', request: 'do something useful for my students' });
    // The label lives in the header badge <span>; its wrapper div shares the text.
    expect(s.getByText('START', { selector: 'span' })).toBeInTheDocument();
    // The start node shows the original request in the params box (unique text).
    expect(s.getByText('do something useful for my students')).toBeInTheDocument();
  });

  it('labels each action type per its rule (ADD_ prefix stripped)', () => {
    const cases = [
      ['FILTER', 'gpa > 3.5'], // ADD_FILTER → FILTER
      ['JOIN', 'courses ON id'], // ADD_JOIN → JOIN
      ['GROUP_BY', 'x GROUP BY x'], // ADD_GROUP_BY → GROUP_BY
      ['HAVING', 'x HAVING x'], // ADD_HAVING → HAVING
    ];
    for (const [label, params] of cases) {
      const s = renderNode({ action_type: `ADD_${label}`, parameters: { table: 't' } });
      expect(s.getByText(label, { selector: 'span' })).toBeInTheDocument();
    }
  });

  it('shows the normalized action type name for unrecognized types', () => {
    // The default branch returns `norm || 'ACTION'`; since an unknown but
    // non-empty action_type is present, the badge shows that normalized name.
    const s = renderNode({ action_type: 'WEIRD_OP', params: {} });
    expect(s.getByText('WEIRD_OP', { selector: 'span' })).toBeInTheDocument();
  });
});

describe('QueryActionNode — status derivation (green/amber/red/blue)', () => {
  it('renders green "Completed" for a successful node', () => {
    const s = renderNode({ action_type: 'SELECT_TABLE', action: 'SELECT_TABLE', status: 'SUCCESS' });
    // Status badge lives in <span>; its pill wrapper div shares the text.
    expect(s.getByText('Completed', { selector: 'span' })).toBeInTheDocument();
  });

  it('renders red "Failed" only when there is no graceful decline', () => {
    const s = renderNode({ action: 'RUN_SQL', status: 'FAILED', params: {}, failure_reason: 'boom' });
    expect(s.getByText('Failed')).toBeInTheDocument();
    expect(s.getByText('boom')).toBeInTheDocument(); // failure reason callout
  });

  it('renders amber "Declined" for a graceful decline with no hard failure', () => {
    const s = renderNode({ action: 'INSUFFICIENT_INFO', status: 'failed', params: { reason: 'Too vague' } });
    expect(s.getByText('Declined')).toBeInTheDocument();
    expect(s.getByText('Too vague')).toBeInTheDocument(); // decline-reason callout
  });

  it('renders blue "Active" for an in-progress node', () => {
    const s = renderNode({ action: 'SELECT_TABLE', status: 'ACTIVE' });
    expect(s.getByText('Active')).toBeInTheDocument();
  });
});

describe('QueryActionNode — metrics bar (confidence / rows / time)', () => {
  it('formats confidence as a percentage and scales for >1 values', () => {
    const s = renderNode({ action: 'FILTER', params: {}, confidence: 0.95 });
    expect(s.getByText('95%')).toBeInTheDocument();

    const scaled = renderNode({ action: 'FILTER', params: {}, confidence: 1.2 });
    // >1 → rounded integer percent (matches the component's rounding rule)
    expect(scaled.getByText('1%')).toBeInTheDocument();
  });

  it('shows rows produced and execution time when present', () => {
    const s = renderNode({ action: 'SELECT_TABLE', params: {}, row_count: 42, execution_time_ms: 123 });
    expect(s.getByText('42 rows')).toBeInTheDocument();
    expect(s.getByText('123 ms')).toBeInTheDocument();
  });

  it('shows dashes when metrics are absent', () => {
    const s = renderNode({ action: 'SELECT_TABLE', params: {} });
    // The three metric cells all fall back to the "—" glyph.
    expect(s.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });
});

describe('QueryActionNode — selected preview panel', () => {
  it('expands a data table when selected with a preview', () => {
    const s = renderNode(
      {
        action: 'SELECT_TABLE',
        params: {},
        status: 'SUCCESS',
        selected: true,
        preview: { columns: ['id', 'gpa'], rows: [{ id: 1, gpa: 3.9 }, { id: 2, gpa: 4.1 }] },
      },
      true,
    );
    expect(s.getByText('Preview (2 rows)')).toBeInTheDocument();
    expect(s.getByText('id')).toBeInTheDocument(); // header cell
    expect(s.getByText('3.9')).toBeInTheDocument(); // data cell
  });

  it('hides the preview panel when not selected', () => {
    const s = renderNode(
      { action: 'SELECT_TABLE', params: {}, status: 'SUCCESS', preview: { columns: ['id'], rows: [] } },
      false,
    );
    expect(s.queryByText('Preview')).toBeNull();
  });
});
