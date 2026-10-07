import {
  ReactFlow,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import QueryActionNode from "./QueryActionNode";

const nodeTypes = {
  queryAction: QueryActionNode,
  trace: QueryActionNode,
};

/**
 * Presentational canvas only. Nodes and edges arrive from the store
 * (backend trace -> lib/traceGraph -> lib/flowMapping); this component owns
 * no data and has no mock fallback.
 */
export default function FlowTest({
  nodes = [],
  edges = [],
  onSelectNode,
  onNodesChange,
  onEdgesChange,
}) {
  return (
    <div style={{ width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelectNode?.(node.data)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="#e5e7eb" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
