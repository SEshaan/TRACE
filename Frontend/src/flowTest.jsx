import { useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export default function FlowTest() {
  const [nodes] = useState([
    {
      id: "1",
      position: { x: 100, y: 100 },
      data: { label: "Hello React Flow" },
    },
    {
      id: "2",
      position: { x: 400, y: 200 },
      data: { label: "Second Node" },
    },
  ]);

  const [edges] = useState([
    {
      id: "e1-2",
      source: "1",
      target: "2",
    },
  ]);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow nodes={nodes} edges={edges}>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
