/**
 * lib/layout.js
 * ---------------------------------------------------------------------------
 * Pure, deterministic tree layout. No React, no side effects.
 *
 * Tidy-tree in one pass: a leaf takes the next free slot on its depth lane;
 * a parent sits at the mean of its children. Siblings of *different* parents
 * therefore never overlap, which is exactly what the old depth-index layout
 * got wrong.
 * ---------------------------------------------------------------------------
 */

export const DEFAULT_LAYOUT = {
  levelGap: 260,
  siblingGap: 380,
  originX: 320,
  originY: 20,
};

/**
 * @param {Array<{ id: string, parentId: string|null, depth: number }>} nodes
 * @param {object} options
 * @returns {Map<string, {x:number, y:number}>}
 */
export function tidyTreeLayout(nodes, options = {}) {
  const { levelGap, siblingGap, originX, originY } = { ...DEFAULT_LAYOUT, ...options };

  const list = Array.isArray(nodes) ? nodes.filter((n) => n?.id) : [];
  const positions = new Map();
  if (list.length === 0) return positions;

  const byId = new Map(list.map((n) => [n.id, n]));
  const childrenOf = new Map();
  const roots = [];

  for (const node of list) {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : null;
    if (parentId) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(node.id);
    } else {
      roots.push(node.id);
    }
  }

  const orderedRoots = options.roots?.length ? list.filter((n) => options.roots.includes(n.id)).map((n) => n.id) : roots;

  let cursor = 0;
  const placed = new Set();

  const place = (id) => {
    if (placed.has(id)) return positions.get(id);
    placed.add(id);

    const children = (childrenOf.get(id) ?? []).filter((c) => !placed.has(c));
    if (children.length === 0) {
      const x = originX + cursor * siblingGap;
      cursor += 1;
      positions.set(id, { x, y: originY + (byId.get(id)?.depth ?? 0) * levelGap });
      return positions.get(id);
    }

    const childPositions = children.map(place);
    const x = childPositions.reduce((sum, p) => sum + p.x, 0) / childPositions.length;
    positions.set(id, { x, y: originY + (byId.get(id)?.depth ?? 0) * levelGap });
    return positions.get(id);
  };

  // Roots first so the primary tree claims the leftmost lane.
  orderedRoots.forEach(place);
  // Anything unreachable from a root (broken parent chain) still gets a slot.
  list.forEach((n) => place(n.id));

  return positions;
}

/**
 * Shift every position so `focusId` lands at the viewport centre.
 * Pure: returns a new map.
 */
export function centerPositions(positions, focusId, { x: targetX = 480, y: targetY = 240 } = {}) {
  const focus = positions.get(focusId);
  if (!focus) return new Map(positions);
  const dx = targetX - focus.x;
  const dy = targetY - focus.y;
  const out = new Map();
  for (const [id, p] of positions) out.set(id, { x: p.x + dx, y: p.y + dy });
  return out;
}

/** No two nodes may share a position — push collisions into the next lane. */
export function resolveCollisions(positions, { siblingGap = DEFAULT_LAYOUT.siblingGap } = {}) {
  const taken = new Set();
  const out = new Map();
  for (const [id, p] of positions) {
    let { x, y } = p;
    while (taken.has(`${x}|${y}`)) x += siblingGap;
    taken.add(`${x}|${y}`);
    out.set(id, { x, y });
  }
  return out;
}
