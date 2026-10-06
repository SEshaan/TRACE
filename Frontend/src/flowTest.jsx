import {
  ReactFlow,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { mockNodes } from "./mock";
import TraceNode from "./TraceNode";

const nodeTypes = {
  trace: TraceNode,
};

const positions = {
  "1": { x: 300, y: 0 },
  "2": { x: 300, y: 120 },
  "3": { x: 300, y: 240 },
  "4": { x: 80, y: 360 },
  "5": { x: 520, y: 360 },
  "6": { x: 520, y: 480 },
  "7": { x: 520, y: 600 },
};

export default function FlowTest({
  onSelectNode,
  selectedNodeId,
}) {
  const nodes = mockNodes.map((node) => ({
    id: node.id,
    type: "trace",
    position: positions[node.id],

    selected: node.id === selectedNodeId,

    data: {
      ...node,
      isActiveBranch: node.is_active_branch,
      checkpointId: node.checkpoint_id,
    },
  }));

  const edges = mockNodes
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