import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
} from "reactflow";
import "reactflow/dist/style.css";
import { api } from "../api";

const CATALOG = [
  { type: "start", label: "Start", description: "Entry point for every inbound call", accent: "#16a34a" },
  { type: "speak", label: "Speak", description: "Play local neural text-to-speech", accent: "#2563eb" },
  { type: "menu", label: "Voice menu", description: "Route callers by spoken choices", accent: "#7c3aed" },
  { type: "collect", label: "Collect speech", description: "Save the caller's answer to a variable", accent: "#0891b2" },
  { type: "condition", label: "Condition", description: "Branch using collected variables", accent: "#d97706" },
  { type: "transfer", label: "Transfer agent", description: "Ring the browser agent dashboard", accent: "#db2777" },
  { type: "webhook", label: "Webhook", description: "Call an external HTTP service", accent: "#475569" },
  { type: "delay", label: "Delay", description: "Wait before continuing", accent: "#64748b" },
  { type: "end", label: "End call", description: "Say a final message and hang up", accent: "#dc2626" },
];

const DEFAULTS = {
  start: { label: "Incoming call" },
  speak: { label: "Speak", text: "Thank you for calling." },
  menu: {
    label: "Voice menu",
    text: "Please say sales or support.",
    variable: "menu_choice",
    invalidText: "Sorry, I did not understand. Please try again.",
    maxAttempts: 3,
    choices: [
      { id: crypto.randomUUID(), label: "Sales", value: "sales", keywords: ["sales"] },
      { id: crypto.randomUUID(), label: "Support", value: "support", keywords: ["support", "help"] },
    ],
  },
  collect: { label: "Collect speech", prompt: "Please tell me your reference number.", variable: "reference" },
  condition: {
    label: "Condition",
    rules: [{ id: crypto.randomUUID(), label: "Matches", handle: "match", variable: "reference", operator: "equals", value: "" }],
  },
  transfer: { label: "Transfer to agent", message: "Please hold while I connect you to an agent.", team: "all" },
  webhook: { label: "Webhook", method: "POST", url: "https://", timeoutMs: 7000, responseVariable: "webhook", headers: {}, body: {} },
  delay: { label: "Delay", seconds: 1 },
  end: { label: "End call", message: "Thank you for calling. Goodbye.", reason: "completed" },
};

const NODE_TYPES = { ivrNode: IvrNode };
let sequence = 0;
const newId = (type) => `${type}_${Date.now()}_${sequence++}`;

function portsFor(node) {
  if (node.type === "menu") {
    return [
      ...(node.data?.choices || []).map((choice) => ({ id: choice.value, label: choice.label })),
      { id: "default", label: "No match" },
    ];
  }
  if (node.type === "condition") {
    return [
      ...(node.data?.rules || []).map((rule) => ({ id: rule.handle || rule.id, label: rule.label || "Rule" })),
      { id: "default", label: "Otherwise" },
    ];
  }
  if (node.type === "webhook") return [{ id: "success", label: "Success" }, { id: "error", label: "Error" }];
  if (["end", "transfer"].includes(node.type)) return [];
  return [{ id: "next", label: "Next" }];
}

function IvrNode({ data, selected }) {
  const meta = CATALOG.find((item) => item.type === data.nodeType) || CATALOG[1];
  const ports = portsFor({ type: data.nodeType, data });
  return (
    <div style={{ ...styles.node, borderColor: selected ? meta.accent : "#d8dee8", boxShadow: selected ? `0 0 0 3px ${meta.accent}22` : styles.node.boxShadow }}>
      {data.nodeType !== "start" && <Handle type="target" position={Position.Left} style={styles.handle} />}
      <div style={{ ...styles.nodeBar, background: meta.accent }} />
      <div style={styles.nodeBody}>
        <div style={styles.nodeTitle}>{data.label || meta.label}</div>
        <div style={styles.nodeSubtitle}>{previewFor(data.nodeType, data)}</div>
        {ports.map((port, index) => (
          <div key={port.id} style={styles.portLabel}>
            <span>{port.label}</span>
            <Handle
              type="source"
              id={port.id}
              position={Position.Right}
              style={{ ...styles.handle, top: 64 + index * 22, right: -7 }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function previewFor(type, data) {
  if (type === "speak") return data.text || "No speech configured";
  if (type === "menu") return `${data.choices?.length || 0} choices · ${data.variable || "menu_choice"}`;
  if (type === "collect") return `Save as {{${data.variable || "variable"}}}`;
  if (type === "condition") return `${data.rules?.length || 0} rules`;
  if (type === "transfer") return `Team: ${data.team || "all"}`;
  if (type === "webhook") return `${data.method || "POST"} ${data.url || ""}`;
  if (type === "delay") return `${data.seconds || 0} seconds`;
  if (type === "end") return data.reason || "completed";
  return "Call entry";
}

export default function FlowBuilder() {
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState(null);
  const [name, setName] = useState("New IVR");
  const [description, setDescription] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [validation, setValidation] = useState({ valid: false, errors: [], warnings: [] });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [simulationInputs, setSimulationInputs] = useState("support");
  const [trace, setTrace] = useState([]);

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) || null, [nodes, selectedId]);

  async function refreshFlows(selectId = null) {
    const response = await api.get("/api/flows");
    setFlows(response.data);
    if (selectId) {
      const flow = response.data.find((item) => item.id === selectId);
      if (flow) loadFlow(flow);
    }
  }

  useEffect(() => {
    refreshFlows().catch((error) => setNotice(error.response?.data?.error || error.message));
  }, []);

  function loadFlow(flow) {
    setFlowId(flow.id);
    setName(flow.name);
    setDescription(flow.description || "");
    setValidation(flow.validation || { valid: false, errors: [], warnings: [] });
    setNodes(
      (flow.graph?.nodes || []).map((node) => ({
        id: node.id,
        type: "ivrNode",
        position: node.position || { x: 80, y: 100 },
        data: { ...node.data, nodeType: node.type },
      }))
    );
    setEdges((flow.graph?.edges || []).map((edge) => ({ ...edge, animated: false })));
    setSelectedId(null);
    setTrace([]);
    setNotice("");
  }

  function createNew() {
    setFlowId(null);
    setName("New IVR");
    setDescription("");
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setValidation({ valid: false, errors: [], warnings: [] });
    setTrace([]);
  }

  const onConnect = useCallback(
    (connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `edge_${connection.source}_${connection.sourceHandle || "next"}_${connection.target}_${Date.now()}`,
            type: "smoothstep",
          },
          current.filter(
            (edge) => !(edge.source === connection.source && String(edge.sourceHandle || "") === String(connection.sourceHandle || ""))
          )
        )
      );
    },
    [setEdges]
  );

  function addNode(type) {
    if (type === "start" && nodes.some((node) => node.data.nodeType === "start")) {
      setNotice("Only one Start node is allowed.");
      return;
    }
    const id = newId(type);
    setNodes((current) => [
      ...current,
      {
        id,
        type: "ivrNode",
        position: { x: 80 + (current.length % 4) * 280, y: 80 + Math.floor(current.length / 4) * 210 },
        data: { ...structuredClone(DEFAULTS[type]), nodeType: type },
      },
    ]);
    setSelectedId(id);
  }

  function updateNode(patch) {
    setNodes((current) => current.map((node) => (node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node)));
  }

  function removeSelected() {
    if (!selected) return;
    setNodes((current) => current.filter((node) => node.id !== selected.id));
    setEdges((current) => current.filter((edge) => edge.source !== selected.id && edge.target !== selected.id));
    setSelectedId(null);
  }

  function graph() {
    return {
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.nodeType, position: node.position, data: stripNodeMeta(node.data) })),
      edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({ id, source, target, sourceHandle, targetHandle })),
    };
  }

  async function validate() {
    const response = await api.post("/api/flows/validate", { graph: graph() });
    setValidation(response.data);
    setNotice(response.data.valid ? "IVR validation passed." : "Fix the errors before publishing.");
    return response.data;
  }

  async function save() {
    setBusy(true);
    setNotice("");
    try {
      const payload = { name, description, graph: graph() };
      const response = flowId
        ? await api.put(`/api/flows/${flowId}`, payload)
        : await api.post("/api/flows", payload);
      setFlowId(response.data.id);
      setValidation(response.data.validation || validation);
      await refreshFlows();
      setNotice("IVR saved.");
    } catch (error) {
      setNotice(error.response?.data?.error || error.message);
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!flowId) {
      setNotice("Save the IVR before publishing.");
      return;
    }
    setBusy(true);
    try {
      const checked = await validate();
      if (!checked.valid) return;
      await api.post(`/api/flows/${flowId}/activate`);
      await refreshFlows();
      setNotice("This IVR is now live for inbound calls.");
    } catch (error) {
      const data = error.response?.data;
      setValidation(data?.validation || validation);
      setNotice(data?.error || error.message);
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!flowId) return;
    const response = await api.post(`/api/flows/${flowId}/duplicate`);
    await refreshFlows(response.data.id);
    setNotice("IVR duplicated.");
  }

  async function deleteFlow() {
    if (!flowId || !window.confirm("Delete this IVR permanently?")) return;
    try {
      await api.delete(`/api/flows/${flowId}`);
      createNew();
      await refreshFlows();
      setNotice("IVR deleted.");
    } catch (error) {
      setNotice(error.response?.data?.error || error.message);
    }
  }

  async function simulate() {
    const response = await api.post("/api/flows/simulate", {
      graph: graph(),
      inputs: simulationInputs.split("\n").map((value) => value.trim()).filter(Boolean),
    });
    setValidation(response.data);
    setTrace(response.data.trace || []);
    setNotice(response.data.valid ? "Simulation completed." : "Simulation could not run because the IVR is invalid.");
  }

  const currentFlow = flows.find((item) => item.id === flowId);

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div>
          <h1 style={{ margin: 0 }}>Visual IVR Builder</h1>
          <p style={styles.muted}>Build deterministic voice menus using local transcription and neural speech. No generative AI is used.</p>
        </div>
        <div style={styles.actions}>
          <button className="secondary" onClick={validate}>Validate</button>
          <button className="secondary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          <button className="primary" onClick={publish} disabled={busy}>Publish IVR</button>
        </div>
      </div>

      {notice && <div style={styles.notice}>{notice}</div>}

      <div style={styles.workspace}>
        <aside style={styles.leftPanel}>
          <div style={styles.panelBlock}>
            <label style={styles.label}>IVR flow</label>
            <select value={flowId || ""} onChange={(event) => {
              if (!event.target.value) createNew();
              else loadFlow(flows.find((item) => item.id === Number(event.target.value)));
            }} style={styles.input}>
              <option value="">Create new IVR</option>
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}{flow.is_active ? " — LIVE" : ""}</option>)}
            </select>
            <input value={name} onChange={(event) => setName(event.target.value)} style={styles.input} placeholder="IVR name" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} style={{ ...styles.input, minHeight: 70 }} placeholder="Description" />
            <div style={styles.smallActions}>
              <button className="secondary" onClick={createNew}>New</button>
              <button className="secondary" onClick={duplicate} disabled={!flowId}>Duplicate</button>
              <button className="secondary" onClick={deleteFlow} disabled={!flowId}>Delete</button>
            </div>
            {currentFlow && <div style={currentFlow.is_active ? styles.liveBadge : styles.draftBadge}>{currentFlow.is_active ? "LIVE" : `Draft v${currentFlow.version || 1}`}</div>}
          </div>

          <div style={styles.panelBlock}>
            <label style={styles.label}>Node library</label>
            {CATALOG.map((item) => (
              <button key={item.type} type="button" onClick={() => addNode(item.type)} style={styles.catalogItem}>
                <span style={{ ...styles.catalogDot, background: item.accent }} />
                <span><strong>{item.label}</strong><small style={styles.catalogDescription}>{item.description}</small></span>
              </button>
            ))}
          </div>

          <div style={styles.panelBlock}>
            <label style={styles.label}>Validation</label>
            <div style={validation.valid ? styles.valid : styles.invalid}>{validation.valid ? "Ready to publish" : `${validation.errors?.length || 0} errors`}</div>
            {(validation.errors || []).map((error) => <div key={error} style={styles.errorText}>{error}</div>)}
            {(validation.warnings || []).map((warning) => <div key={warning} style={styles.warningText}>{warning}</div>)}
          </div>

          <div style={styles.panelBlock}>
            <label style={styles.label}>Simulator inputs</label>
            <textarea value={simulationInputs} onChange={(event) => setSimulationInputs(event.target.value)} style={{ ...styles.input, minHeight: 72 }} placeholder="One caller answer per line" />
            <button className="secondary" style={{ width: "100%" }} onClick={simulate}>Run simulation</button>
            {trace.map((item, index) => <div key={`${item.nodeId}-${index}`} style={styles.trace}>{index + 1}. {item.label} <span>{item.type}</span></div>)}
          </div>
        </aside>

        <main style={styles.canvas}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            snapToGrid
            snapGrid={[16, 16]}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background gap={20} size={1} />
            <MiniMap pannable zoomable nodeColor={(node) => CATALOG.find((item) => item.type === node.data.nodeType)?.accent || "#64748b"} />
            <Controls />
          </ReactFlow>
        </main>

        <aside style={styles.rightPanel}>
          {selected ? (
            <NodeInspector node={selected} updateNode={updateNode} removeNode={removeSelected} />
          ) : (
            <div style={styles.emptyInspector}>
              <strong>Select a node</strong>
              <p style={styles.muted}>Edit prompts, choices, variables, conditions, transfer teams and webhooks here.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function NodeInspector({ node, updateNode, removeNode }) {
  const type = node.data.nodeType;
  const meta = CATALOG.find((item) => item.type === type);
  return (
    <div>
      <div style={styles.inspectorHeader}>
        <div><div style={{ ...styles.catalogDot, background: meta?.accent }} /><strong>{meta?.label}</strong></div>
        {type !== "start" && <button className="secondary" onClick={removeNode}>Remove</button>}
      </div>
      <Field label="Node label"><input value={node.data.label || ""} onChange={(event) => updateNode({ label: event.target.value })} style={styles.input} /></Field>
      {type === "speak" && <Field label="Text to speak"><textarea value={node.data.text || ""} onChange={(event) => updateNode({ text: event.target.value })} style={{ ...styles.input, minHeight: 130 }} /><Hint>Use variables such as {"{{contact_name}}"} or {"{{reference}}"}.</Hint></Field>}
      {type === "menu" && <MenuEditor data={node.data} update={updateNode} />}
      {type === "collect" && <>
        <Field label="Prompt"><textarea value={node.data.prompt || ""} onChange={(event) => updateNode({ prompt: event.target.value })} style={{ ...styles.input, minHeight: 100 }} /></Field>
        <Field label="Save answer as"><input value={node.data.variable || ""} onChange={(event) => updateNode({ variable: slug(event.target.value) })} style={styles.input} /><Hint>Reference later as {`{{${node.data.variable || "variable"}}}`}.</Hint></Field>
      </>}
      {type === "condition" && <ConditionEditor data={node.data} update={updateNode} />}
      {type === "transfer" && <>
        <Field label="Transfer announcement"><textarea value={node.data.message || ""} onChange={(event) => updateNode({ message: event.target.value })} style={{ ...styles.input, minHeight: 100 }} /></Field>
        <Field label="Agent team"><input value={node.data.team || "all"} onChange={(event) => updateNode({ team: event.target.value })} style={styles.input} /></Field>
      </>}
      {type === "webhook" && <WebhookEditor data={node.data} update={updateNode} />}
      {type === "delay" && <Field label="Seconds"><input type="number" min="0" max="30" value={node.data.seconds || 0} onChange={(event) => updateNode({ seconds: Number(event.target.value) })} style={styles.input} /></Field>}
      {type === "end" && <>
        <Field label="Final message"><textarea value={node.data.message || ""} onChange={(event) => updateNode({ message: event.target.value })} style={{ ...styles.input, minHeight: 100 }} /></Field>
        <Field label="Completion reason"><input value={node.data.reason || "completed"} onChange={(event) => updateNode({ reason: slug(event.target.value) })} style={styles.input} /></Field>
      </>}
      {type === "start" && <Hint>Every published IVR must have exactly one Start node.</Hint>}
    </div>
  );
}

function MenuEditor({ data, update }) {
  function updateChoice(id, patch) {
    update({ choices: (data.choices || []).map((choice) => choice.id === id ? { ...choice, ...patch } : choice) });
  }
  function addChoice() {
    const count = (data.choices || []).length + 1;
    update({ choices: [...(data.choices || []), { id: crypto.randomUUID(), label: `Option ${count}`, value: `option_${count}`, keywords: [] }] });
  }
  return <>
    <Field label="Menu prompt"><textarea value={data.text || ""} onChange={(event) => update({ text: event.target.value })} style={{ ...styles.input, minHeight: 110 }} /></Field>
    <Field label="Save choice as"><input value={data.variable || "menu_choice"} onChange={(event) => update({ variable: slug(event.target.value) })} style={styles.input} /></Field>
    <Field label="Invalid response message"><textarea value={data.invalidText || ""} onChange={(event) => update({ invalidText: event.target.value })} style={{ ...styles.input, minHeight: 80 }} /></Field>
    <Field label="Maximum attempts"><input type="number" min="1" max="10" value={data.maxAttempts || 3} onChange={(event) => update({ maxAttempts: Number(event.target.value) })} style={styles.input} /></Field>
    <div style={styles.sectionLabel}>Choices</div>
    {(data.choices || []).map((choice) => <div key={choice.id} style={styles.choiceCard}>
      <input value={choice.label} onChange={(event) => updateChoice(choice.id, { label: event.target.value })} style={styles.input} placeholder="Display label" />
      <input value={choice.value} onChange={(event) => updateChoice(choice.id, { value: slug(event.target.value) })} style={styles.input} placeholder="Connection value" />
      <input value={(choice.keywords || []).join(", ")} onChange={(event) => updateChoice(choice.id, { keywords: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} style={styles.input} placeholder="Keywords, comma separated" />
      <button className="secondary" onClick={() => update({ choices: data.choices.filter((item) => item.id !== choice.id) })}>Remove choice</button>
    </div>)}
    <button className="secondary" onClick={addChoice} style={{ width: "100%" }}>Add choice</button>
    <Hint>After editing a choice value, reconnect that output handle on the canvas.</Hint>
  </>;
}

function ConditionEditor({ data, update }) {
  function updateRule(id, patch) {
    update({ rules: (data.rules || []).map((rule) => rule.id === id ? { ...rule, ...patch } : rule) });
  }
  return <>
    <div style={styles.sectionLabel}>Rules</div>
    {(data.rules || []).map((rule) => <div key={rule.id} style={styles.choiceCard}>
      <input value={rule.label || ""} onChange={(event) => updateRule(rule.id, { label: event.target.value })} style={styles.input} placeholder="Rule label" />
      <input value={rule.variable || ""} onChange={(event) => updateRule(rule.id, { variable: slug(event.target.value) })} style={styles.input} placeholder="Variable" />
      <select value={rule.operator || "equals"} onChange={(event) => updateRule(rule.id, { operator: event.target.value })} style={styles.input}>
        <option value="equals">Equals</option><option value="not_equals">Does not equal</option><option value="contains">Contains</option><option value="starts_with">Starts with</option><option value="ends_with">Ends with</option><option value="exists">Exists</option><option value="greater_than">Greater than</option><option value="less_than">Less than</option>
      </select>
      <input value={rule.value || ""} onChange={(event) => updateRule(rule.id, { value: event.target.value })} style={styles.input} placeholder="Comparison value" />
      <input value={rule.handle || rule.id} onChange={(event) => updateRule(rule.id, { handle: slug(event.target.value) })} style={styles.input} placeholder="Connection handle" />
      <button className="secondary" onClick={() => update({ rules: data.rules.filter((item) => item.id !== rule.id) })}>Remove rule</button>
    </div>)}
    <button className="secondary" style={{ width: "100%" }} onClick={() => {
      const id = crypto.randomUUID();
      update({ rules: [...(data.rules || []), { id, label: "New rule", handle: `rule_${(data.rules || []).length + 1}`, variable: "", operator: "equals", value: "" }] });
    }}>Add rule</button>
  </>;
}

function WebhookEditor({ data, update }) {
  return <>
    <Field label="Method"><select value={data.method || "POST"} onChange={(event) => update({ method: event.target.value })} style={styles.input}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select></Field>
    <Field label="URL"><input value={data.url || ""} onChange={(event) => update({ url: event.target.value })} style={styles.input} placeholder="https://api.example.com/action" /></Field>
    <Field label="Timeout (milliseconds)"><input type="number" min="1000" max="15000" value={data.timeoutMs || 7000} onChange={(event) => update({ timeoutMs: Number(event.target.value) })} style={styles.input} /></Field>
    <Field label="Save response as"><input value={data.responseVariable || "webhook"} onChange={(event) => update({ responseVariable: slug(event.target.value) })} style={styles.input} /></Field>
    <Field label="Headers JSON"><textarea value={JSON.stringify(data.headers || {}, null, 2)} onChange={(event) => { try { update({ headers: JSON.parse(event.target.value) }); } catch (_) {} }} style={{ ...styles.input, minHeight: 90, fontFamily: "monospace" }} /></Field>
    <Field label="Body JSON"><textarea value={JSON.stringify(data.body || {}, null, 2)} onChange={(event) => { try { update({ body: JSON.parse(event.target.value) }); } catch (_) {} }} style={{ ...styles.input, minHeight: 110, fontFamily: "monospace" }} /></Field>
  </>;
}

function Field({ label, children }) { return <label style={styles.field}><span style={styles.label}>{label}</span>{children}</label>; }
function Hint({ children }) { return <div style={styles.hint}>{children}</div>; }
function stripNodeMeta(data) { const { nodeType, ...rest } = data; return rest; }
function slug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""); }

const styles = {
  page: { height: "calc(100vh - 48px)", display: "flex", flexDirection: "column", gap: 12 },
  topbar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
  actions: { display: "flex", gap: 8 },
  muted: { color: "#64748b", fontSize: 13, margin: "5px 0 0" },
  notice: { background: "#eef4ff", border: "1px solid #c7d7fe", borderRadius: 9, padding: "10px 13px", fontSize: 13 },
  workspace: { minHeight: 0, flex: 1, display: "grid", gridTemplateColumns: "260px minmax(520px,1fr) 330px", gap: 12 },
  leftPanel: { overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 },
  rightPanel: { overflowY: "auto", background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16 },
  panelBlock: { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 },
  canvas: { minWidth: 0, border: "1px solid #dbe3ee", borderRadius: 12, overflow: "hidden", background: "#fbfcfe" },
  label: { display: "block", color: "#334155", fontWeight: 650, fontSize: 12, marginBottom: 5 },
  input: { width: "100%", border: "1px solid #cbd5e1", borderRadius: 8, padding: "9px 10px", font: "inherit", boxSizing: "border-box", background: "white" },
  smallActions: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 },
  liveBadge: { background: "#dcfce7", color: "#166534", borderRadius: 999, padding: "5px 9px", fontWeight: 700, fontSize: 11, alignSelf: "flex-start" },
  draftBadge: { background: "#f1f5f9", color: "#475569", borderRadius: 999, padding: "5px 9px", fontWeight: 700, fontSize: 11, alignSelf: "flex-start" },
  catalogItem: { display: "flex", alignItems: "flex-start", gap: 9, textAlign: "left", border: "1px solid #e2e8f0", background: "#fff", padding: 9, borderRadius: 9, cursor: "pointer" },
  catalogDot: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginTop: 3, flex: "0 0 auto" },
  catalogDescription: { display: "block", color: "#64748b", fontSize: 11, marginTop: 2, lineHeight: 1.3 },
  node: { minWidth: 220, maxWidth: 260, background: "white", border: "1px solid", borderRadius: 11, overflow: "visible", boxShadow: "0 7px 22px rgba(15,23,42,.08)" },
  nodeBar: { height: 6, borderRadius: "10px 10px 0 0" },
  nodeBody: { padding: "11px 13px", minHeight: 58 },
  nodeTitle: { fontWeight: 750, color: "#0f172a", fontSize: 13 },
  nodeSubtitle: { color: "#64748b", fontSize: 10, lineHeight: 1.35, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 210 },
  portLabel: { position: "relative", display: "flex", justifyContent: "flex-end", color: "#475569", fontSize: 9, marginTop: 9, paddingRight: 4 },
  handle: { width: 11, height: 11, background: "#fff", border: "2px solid #64748b" },
  valid: { color: "#166534", fontWeight: 700, fontSize: 12 },
  invalid: { color: "#b91c1c", fontWeight: 700, fontSize: 12 },
  errorText: { color: "#b91c1c", fontSize: 11, lineHeight: 1.4 },
  warningText: { color: "#a16207", fontSize: 11, lineHeight: 1.4 },
  trace: { padding: "5px 0", borderBottom: "1px solid #eef2f7", fontSize: 11 },
  inspectorHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  emptyInspector: { padding: "36px 8px", textAlign: "center" },
  field: { display: "block", marginBottom: 13 },
  hint: { color: "#64748b", background: "#f8fafc", borderRadius: 7, padding: 8, fontSize: 11, lineHeight: 1.45, marginTop: 6 },
  sectionLabel: { fontWeight: 750, fontSize: 12, color: "#334155", margin: "14px 0 7px" },
  choiceCard: { border: "1px solid #e2e8f0", borderRadius: 9, padding: 9, display: "flex", flexDirection: "column", gap: 7, marginBottom: 8 },
};
