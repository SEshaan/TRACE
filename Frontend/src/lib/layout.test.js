import { describe, it, expect } from 'vitest';
import { tidyTreeLayout, centerPositions, resolveCollisions, DEFAULT_LAYOUT } from './layout';

const forkTree = [
  { id: 'root', parentId: null, depth: 0 },
  { id: 'A', parentId: 'root', depth: 1 },
  { id: 'B', parentId: 'root', depth: 1 },
  { id: 'A1', parentId: 'A', depth: 2 },
  { id: 'A2', parentId: 'A', depth: 2 },
  { id: 'B1', parentId: 'B', depth: 2 },
  { id: 'B2', parentId: 'B', depth: 2 },
];

describe('tidyTreeLayout', () => {
  const positions = tidyTreeLayout(forkTree);

  it('keeps enough room between node columns and depth levels', () => {
    expect(DEFAULT_LAYOUT.siblingGap).toBe(380);
    expect(DEFAULT_LAYOUT.levelGap).toBe(260);
  });

  it('places every node exactly once', () => {
    expect(positions.size).toBe(forkTree.length);
    for (const { id } of forkTree) expect(positions.has(id)).toBe(true);
  });

  it('never puts two nodes on the same point', () => {
    const points = [...positions.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(points).size).toBe(points.length);
  });

  it('does not overlap siblings of different parents (the old layout bug)', () => {
    const { siblingGap } = DEFAULT_LAYOUT;
    const pairs = [
      ['A1', 'B1'],
      ['A1', 'B2'],
      ['A2', 'B1'],
      ['A2', 'B2'],
    ];
    for (const [left, right] of pairs) {
      expect(Math.abs(positions.get(left).x - positions.get(right).x)).toBeGreaterThanOrEqual(siblingGap);
    }
  });

  it('centres a parent over its children', () => {
    const a = positions.get('A');
    const midpoint = (positions.get('A1').x + positions.get('A2').x) / 2;
    expect(a.x).toBeCloseTo(midpoint, 6);

    const root = positions.get('root');
    const childMid = (positions.get('A').x + positions.get('B').x) / 2;
    expect(root.x).toBeCloseTo(childMid, 6);
  });

  it('separates depth levels by levelGap', () => {
    expect(positions.get('root').y).toBe(DEFAULT_LAYOUT.originY);
    expect(positions.get('A').y - positions.get('root').y).toBe(DEFAULT_LAYOUT.levelGap);
    expect(positions.get('A1').y - positions.get('A').y).toBe(DEFAULT_LAYOUT.levelGap);
  });

  it('is deterministic across calls', () => {
    const first = tidyTreeLayout(forkTree);
    const second = tidyTreeLayout(forkTree);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('handles a linear chain', () => {
    const chain = [
      { id: '1', parentId: null, depth: 0 },
      { id: '2', parentId: '1', depth: 1 },
      { id: '3', parentId: '2', depth: 2 },
    ];
    const pos = tidyTreeLayout(chain);
    expect(pos.get('1').x).toBe(pos.get('2').x);
    expect(pos.get('2').x).toBe(pos.get('3').x);
  });

  it('gives a slot to nodes with a broken parent chain', () => {
    const pos = tidyTreeLayout([
      { id: 'a', parentId: null, depth: 0 },
      { id: 'orphan', parentId: 'ghost', depth: 3 },
    ]);
    expect(pos.size).toBe(2);
    expect(pos.get('a').x).not.toBe(pos.get('orphan').x);
  });

  it('returns an empty map for empty input', () => {
    expect(tidyTreeLayout([]).size).toBe(0);
    expect(tidyTreeLayout(null).size).toBe(0);
  });
});

describe('centerPositions', () => {
  it('moves the focus node to the requested centre', () => {
    const positions = tidyTreeLayout(forkTree);
    const centered = centerPositions(positions, 'A2', { x: 500, y: 300 });
    expect(centered.get('A2')).toEqual({ x: 500, y: 300 });
  });

  it('preserves relative spacing and does not mutate the input', () => {
    const positions = tidyTreeLayout(forkTree);
    const before = [...positions.entries()];
    const centered = centerPositions(positions, 'root', { x: 400, y: 200 });

    const dx = centered.get('A1').x - positions.get('A1').x;
    const dy = centered.get('A1').y - positions.get('A1').y;
    expect(centered.get('B2').x - positions.get('B2').x).toBe(dx);
    expect(centered.get('B2').y - positions.get('B2').y).toBe(dy);
    expect([...positions.entries()]).toEqual(before);
  });

  it('returns a copy when the focus id is unknown', () => {
    const positions = tidyTreeLayout(forkTree);
    expect([...centerPositions(positions, 'nope').entries()]).toEqual([...positions.entries()]);
  });
});

describe('resolveCollisions', () => {
  it('pushes duplicate points into the next lane', () => {
    const input = new Map([
      ['a', { x: 100, y: 0 }],
      ['b', { x: 100, y: 0 }],
      ['c', { x: 100, y: 0 }],
    ]);
    const out = resolveCollisions(input, { siblingGap: 250 });
    expect(out.get('a').x).toBe(100);
    expect(out.get('b').x).toBe(350);
    expect(out.get('c').x).toBe(600);
    expect(out.get('b').y).toBe(0);
  });

  it('leaves clean input untouched', () => {
    const positions = tidyTreeLayout(forkTree);
    expect([...resolveCollisions(positions).entries()]).toEqual([...positions.entries()]);
  });
});
