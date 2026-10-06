import {
  ReactFlow,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { mockNodes } from "./mock";

const positions = {
  "1": { x: 300, y: 0 },
  "2": { x: 300, y: 120 },
  "3": { x: 300, y: 240 },
  "4": { x: 80, y: 360 },
  "5": { x: 520, y: 360 },
  "6": { x: 520, y: 480 },
  "7": { x: 520, y: 600 },
};

export default function FlowTest() {
  const nodes = mockNodes.map((node) => ({
    id: node.id,
    position: positions[node.id],
    data: {
      label: `${node.action}: ${node.params}`,
    },
  }));

  const edges = mockNodes
    .filter((node) => node.parent_id)
    .map((node) => ({
      id: `e-${node.parent_id}-${node.id}`,
      source: node.parent_id,
      target: node.id,
    }));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}