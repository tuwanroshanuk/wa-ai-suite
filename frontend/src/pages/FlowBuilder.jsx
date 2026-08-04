import { useCallback, useEffect, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { api } from "../api";

const NODE_TYPES = [
  { type: "start", label: "Start" },
  { type: "message", label: "Send message" },
  { type: "audio", label: "Play audio clip" },
  { type: "menu", label: "Menu / options" },
  { type: "ai_reply", label: "AI reply (Gemini)" },
  { type: "handoff", label: "Hand off to agent" },
  { type: "end", label: "End" },
];

let idCounter = 1;
const genId = () => `node_${idCounter++}_${Date.now()}`;

export default function FlowBuilder() {
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState(null);
  const [flowName, setFlowName] = useState("New flow");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.get("/api/flows").then((r) => setFlows(r.data));
  }, []);

  function loadFlow(f) {
    setFlowId(f.id);
    setFlowName(f.name);
    setNodes(
      (f.graph.nodes || []).map((n) => ({
        id: n.id,
        position: n.position || { x: 100, y: 100 },
        data: { label: labelFor(n), ...n.data, nodeType: n.type },
        type: "default",
      }))
    );
    setEdges(f.graph.edges || []);
  }

  function labelFor(n) {
    const meta = NODE_TYPES.find((t) => t.type === n.type);
    return `${meta?.label || n.type}`;
  }

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  function addNode(type) {
    const id = genId();
    const meta = NODE_TYPES.find((t) => t.type === type);
    setNodes((nds) => [
      ...nds,
      {
        id,
        position: { x: 200 + nds.length * 30, y: 100 + nds.length * 40 },
        data: { label: meta.label, nodeType: type },
        type: "default",
      },
    ]);
  }

  function toGraph() {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.data.nodeType,
        position: n.position,
        data: stripMeta(n.data),
      })),
      edges: edges.map((e) => ({
        id: e.id || `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
      })),
    };
  }

  function stripMeta(data) {
    const { label, nodeType, ...rest } = data;
    return rest;
  }

  async function saveFlow() {
    const graph = toGraph();
    if (flowId) {
      const { data } = await api.put(`/api/flows/${flowId}`, { name: flowName, graph });
      alert("Saved");
    } else {
      const { data } = await api.post("/api/flows", { name: flowName, graph });
      setFlowId(data.id);
      const list = await api.get("/api/flows");
      setFlows(list.data);
    }
  }

  async function activateFlow() {
    if (!flowId) return alert("Save the flow first");
    await api.post(`/api/flows/${flowId}/activate`);
    alert("Flow is now live");
  }

  function updateSelectedData(field, value) {
    setNodes((nds) =>
      nds.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, [field]: value } } : n))
    );
    setSelected((s) => ({ ...s, data: { ...s.data, [field]: value } }));
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 48px)", gap: 16 }}>
      <div style={{ width: 220 }}>
        <div className="card">
          <select
            onChange={(e) => {
              const f = flows.find((x) => x.id === Number(e.target.value));
              if (f) loadFlow(f);
              else {
                setFlowId(null);
                setNodes([]);
                setEdges([]);
              }
            }}
          >
            <option value="">-- New flow --</option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} {f.is_active ? "(live)" : ""}
              </option>
            ))}
          </select>
          <input value={flowName} onChange={(e) => setFlowName(e.target.value)} />
          <button className="primary" onClick={saveFlow} style={{ width: "100%", marginBottom: 8 }}>
            Save
          </button>
          <button className="secondary" onClick={activateFlow} style={{ width: "100%" }}>
            Set as live
          </button>
        </div>
        <div className="card">
          <h4>Add node</h4>
          {NODE_TYPES.map((t) => (
            <button
              key={t.type}
              className="secondary"
              style={{ width: "100%", marginBottom: 6, textAlign: "left" }}
              onClick={() => addNode(t.type)}
            >
              + {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, border: "1px solid #ddd", borderRadius: 10, background: "#fff" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelected(node)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {selected && (
        <div className="card" style={{ width: 280 }}>
          <h4>{selected.data.label}</h4>
          <NodeEditor node={selected} onChange={updateSelectedData} />
        </div>
      )}
    </div>
  );
}

function NodeEditor({ node, onChange }) {
  const type = node.data.nodeType;

  if (type === "message" || type === "handoff") {
    return (
      <textarea
        rows={4}
        placeholder="Text to send"
        defaultValue={node.data.text || node.data.note || ""}
        onBlur={(e) => onChange(type === "handoff" ? "note" : "text", e.target.value)}
      />
    );
  }
  if (type === "ai_reply") {
    return (
      <textarea
        rows={5}
        placeholder="System prompt for Gemini"
        defaultValue={node.data.systemPrompt || ""}
        onBlur={(e) => onChange("systemPrompt", e.target.value)}
      />
    );
  }
  if (type === "menu") {
    return (
      <>
        <textarea
          rows={3}
          placeholder="Menu prompt text"
          defaultValue={node.data.text || ""}
          onBlur={(e) => onChange("text", e.target.value)}
        />
        <p style={{ fontSize: 12, color: "#666" }}>
          Options are matched by connecting edges: label each outgoing edge's
          sourceHandle with the exact reply text you expect (e.g. "1", "Sales").
        </p>
      </>
    );
  }
  if (type === "audio") {
    return (
      <>
        <input
          placeholder="Audio asset ID (see Settings > Audio Library)"
          defaultValue={node.data.assetId || ""}
          onBlur={(e) => onChange("assetId", Number(e.target.value))}
        />
        <input
          placeholder="Fallback text if no audio"
          defaultValue={node.data.fallbackText || ""}
          onBlur={(e) => onChange("fallbackText", e.target.value)}
        />
      </>
    );
  }
  return <p style={{ fontSize: 13, color: "#666" }}>No configuration needed.</p>;
}
