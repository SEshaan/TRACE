import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { mockNodes } from "./mock";
import QueryActionNode from "./QueryActionNode";

const nodeTypes = {
  queryAction: QueryActionNode,
  trace: QueryActionNode,
};

// Generous spacing to accommodate rich action nodes and branching branches
const positions = {
  "1": { x: 320, y: 20 },
  "2": { x: 320, y: 180 },
  "3": { x: 320, y: 340 },
  "4": { x: 50,  y: 520 },  // Failed branch (left)
  "5": { x: 580, y: 520 },  // Recovered branch (right)
  "6": { x: 580, y: 700 },
  "7": { x: 580, y: 880 },
};

export default function FlowTest({
  nodes: externalNodes,
  edges: externalEdges,
  onSelectNode,
  selectedNodeId,
}) {
  const fallbackNodes = mockNodes.map((node) => ({
    id: node.id,
    type: "queryAction",
    position: positions[node.id] || { x: 300, y: 0 },
    selected: node.id === selectedNodeId,
    data: {
      ...node,
      isActiveBranch: node.is_active_branch,
      checkpointId: node.checkpoint_id,
    },
  }));

  const displayNodes = externalNodes !== undefined ? externalNodes : fallbackNodes;

  const edges = mockNodes
    .filter((node) => node.parent_id)
    .map((node) => {
      const isFailed = node.status === "FAILED";
      const isRecovered = Boolean(node.clarification);
      const isInactive = node.is_active_branch === false;

      let strokeColor = "#10b981"; // Green (success default)
      let isAnimated = false;
      let strokeDash = undefined;

      if (isFailed) {
        strokeColor = "#ef4444"; // Red (failure)
        strokeDash = "5 5";
      } else if (isRecovered) {
        strokeColor = "#3b82f6"; // Blue (recovery branch)
        isAnimated = true;
      } else if (isInactive) {
        strokeColor = "#9ca3af"; // Gray (inactive)
        strokeDash = "4 4";
      }

      return {
        id: `e-${node.parent_id}-${node.id}`,
        source: node.parent_id,
        target: node.id,
        type: "smoothstep",
        animated: isAnimated,
        label: node.clarification || undefined,
        labelStyle: {
          fill: "#1e40af",
          fontWeight: 600,
          fontSize: 11,
          fontFamily: "inherit",
        },
        labelBgStyle: {
          fill: "#eff6ff",
          stroke: "#93c5fd",
          strokeWidth: 1,
          rx: 4,
          ry: 4,
        },
        labelBgPadding: [6, 4],
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 14,
          height: 14,
        },
        style: {
          stroke: strokeColor,
          strokeWidth: 2,
          strokeDasharray: strokeDash,
        },
      };
    });

  const displayEdges = externalEdges !== undefined ? externalEdges : edges;

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={true}
        onNodeClick={(_, node) => onSelectNode?.(node.data)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
      >
        <Background gap={16} size={1} color="#e5e7eb" />
        <Controls />
      </ReactFlow>
    </div>
  );
}