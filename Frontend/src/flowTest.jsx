import {
  ReactFlow,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import TraceNode from "./TraceNode";

const nodeTypes = {
  trace: TraceNode,
};

function getTreePositions(nodes) {
  const childrenByParent = new Map();
  const positions = new Map();

  nodes.forEach((node) => {
    const children = childrenByParent.get(node.parent_id) ?? [];
    children.push(node);
    childrenByParent.set(node.parent_id, children);
  });

  let nextLeafX = 0;

  function placeNode(node, depth) {
    const children = childrenByParent.get(node.id) ?? [];

    if (children.length === 0) {
      positions.set(node.id, { x: nextLeafX * 240, y: depth * 140 });
      nextLeafX += 1;
      return positions.get(node.id).x;
    }

    const childXPositions = children.map((child) => placeNode(child, depth + 1));
    const x = childXPositions.reduce((total, childX) => total + childX, 0) / childXPositions.length;
    positions.set(node.id, { x, y: depth * 140 });
    return x;
  }

  const roots = childrenByParent.get(null) ?? [];
  roots.forEach((root) => placeNode(root, 0));

  return Object.fromEntries(positions);
}

export default function FlowTest({
  nodes: incomingNodes = [],
  onSelectNode,
  selectedNodeId,
}) {
  const positions = getTreePositions(incomingNodes);

  const nodes = incomingNodes.map((node) => ({
    id: node.id,
    type: "trace",
    position: positions[node.id] ?? { x: 0, y: 0 },
    selected: node.id === selectedNodeId,
    data: {
      ...node,
      checkpointId: node.checkpoint_id,
      isActiveBranch: true,
    },
  }));

  const edges = incomingNodes
    .filter((node) => node.parent_id)
    .map((node) => ({
      id: `e-${node.parent_id}-${node.id}`,
      source: node.parent_id,
      target: node.id,
      label: node.clarification || undefined,
    }));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        onNodeClick={(_, node) => onSelectNode?.(node.data)}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}