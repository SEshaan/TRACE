import { useEffect, useRef } from "react";
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

const FIT_VIEW_OPTIONS = {
  padding: 0.2,
  minZoom: 0.1,
  maxZoom: 1,
};

/**
 * Presentational canvas only.
 *
 * Nodes and edges arrive from the store:
 * backend trace -> lib/traceGraph -> lib/flowMapping
 *
 * This component owns no data and has no mock fallback.
 */
export default function FlowTest({
  nodes = [],
  edges = [],
  onSelectNode,
  onNodesChange,
  onEdgesChange,
}) {
  const reactFlowInstance = useRef(null);

  useEffect(() => {
    if (!reactFlowInstance.current) return undefined;

    const frame = requestAnimationFrame(() => {
      reactFlowInstance.current?.fitView(FIT_VIEW_OPTIONS);
    });

    return () => cancelAnimationFrame(frame);
  }, [nodes, edges]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",

        /* subtle tree-window treatment */
        background: "#ffffff",
        border: "2px solid #d9d9dd",
        borderRadius: "10px",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => onSelectNode?.(node.data)}
        onInit={(instance) => {
          reactFlowInstance.current = instance;
        }}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        proOptions={{ hideAttribution: true }}
        style={{
          background: "#ffffff",
        }}
      >
        <Background
          gap={16}
          size={1}
          color="#e5e7eb"
        />

        <Controls />
      </ReactFlow>
    </div>
  );
}