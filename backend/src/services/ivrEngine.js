import axios from "axios";
import { query } from "../db/index.js";
import { emitToDashboard, getOnlineAgentCount } from "../sockets.js";

const sessions = new Map();
const MAX_STEPS = 80;

const TYPES = new Set([
  "start",
  "speak",
  "menu",
  "collect",
  "condition",
  "transfer",
  "webhook",
  "delay",
  "end",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value).toLocaleLowerCase();
}

function graphParts(graph = {}) {
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
  };
}

function nodeById(graph, id) {
  return graph.nodes.find((node) => node.id === id) || null;
}

function outgoing(graph, id) {
  return graph.edges.filter((edge) => edge.source === id);
}

function nextId(graph, id, handle = null) {
  const edges = outgoing(graph, id);
  if (!edges.length) return null;
  if (handle !== null && handle !== undefined) {
    const exact = edges.find((edge) => String(edge.sourceHandle || "") === String(handle));
    if (exact) return exact.target;
  }
  const fallback = edges.find((edge) => ["default", "next", "success"].includes(String(edge.sourceHandle || "")));
  return fallback?.target || edges[0]?.target || null;
}

function interpolate(text, vars) {
  return String(text || "").replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const parts = key.split(".");
    let current = vars;
    for (const part of parts) current = current?.[part];
    return current === undefined || current === null ? "" : String(current);
  });
}

function compare(left, operator, right) {
  const l = normalize(left);
  const r = normalize(right);
  if (operator === "equals") return l === r;
  if (operator === "not_equals") return l !== r;
  if (operator === "contains") return l.includes(r);
  if (operator === "starts_with") return l.startsWith(r);
  if (operator === "ends_with") return l.endsWith(r);
  if (operator === "exists") return clean(left).length > 0;
  if (operator === "greater_than") return Number(left) > Number(right);
  if (operator === "less_than") return Number(left) < Number(right);
  return false;
}

export function validateIvrGraph(input) {
  const graph = graphParts(input);
  const errors = [];
  const warnings = [];
  const ids = new Set();

  for (const node of graph.nodes) {
    if (!node?.id) errors.push("Every node requires a unique id.");
    else if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    else ids.add(node.id);
    if (!TYPES.has(node?.type)) errors.push(`Unsupported node type: ${node?.type || "missing"}`);
  }

  const starts = graph.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) errors.push("The IVR must contain exactly one Start node.");
  if (!graph.nodes.some((node) => node.type === "end")) errors.push("The IVR requires at least one End node.");

  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id || ""} has a missing source.`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id || ""} has a missing target.`);
  }

  for (const node of graph.nodes) {
    const edges = outgoing(graph, node.id);
    if (!['end', 'transfer'].includes(node.type) && edges.length === 0) {
      warnings.push(`${node.data?.label || node.id} has no outgoing connection.`);
    }
    if (node.type === "speak" && !clean(node.data?.text)) errors.push(`Speak node ${node.id} needs text.`);
    if (node.type === "menu") {
      const choices = Array.isArray(node.data?.choices) ? node.data.choices : [];
      if (!clean(node.data?.text)) errors.push(`Menu node ${node.id} needs a prompt.`);
      if (!choices.length) errors.push(`Menu node ${node.id} needs at least one choice.`);
      for (const choice of choices) {
        if (!clean(choice.value)) errors.push(`Menu node ${node.id} has a choice without a value.`);
        if (!edges.some((edge) => String(edge.sourceHandle || "") === String(choice.value))) {
          errors.push(`Menu choice “${choice.label || choice.value}” is not connected.`);
        }
      }
    }
    if (node.type === "collect" && !clean(node.data?.variable)) errors.push(`Collect node ${node.id} needs a variable name.`);
    if (node.type === "condition") {
      const rules = Array.isArray(node.data?.rules) ? node.data.rules : [];
      if (!rules.length) errors.push(`Condition node ${node.id} needs at least one rule.`);
      for (const rule of rules) {
        if (!edges.some((edge) => String(edge.sourceHandle || "") === String(rule.handle || rule.id))) {
          errors.push(`Condition rule ${rule.label || rule.id || "unknown"} is not connected.`);
        }
      }
    }
    if (node.type === "webhook" && !/^https?:\/\//i.test(clean(node.data?.url))) {
      errors.push(`Webhook node ${node.id} needs an http(s) URL.`);
    }
  }

  if (starts.length === 1) {
    const reachable = new Set();
    const queue = [starts[0].id];
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      outgoing(graph, id).forEach((edge) => queue.push(edge.target));
    }
    graph.nodes.filter((node) => !reachable.has(node.id)).forEach((node) => warnings.push(`${node.data?.label || node.id} is unreachable.`));
    if (!graph.nodes.some((node) => node.type === "end" && reachable.has(node.id))) {
      errors.push("No End node is reachable from Start.");
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export async function getActiveIvrFlow() {
  const result = await query("SELECT * FROM flows WHERE is_active=true ORDER BY updated_at DESC LIMIT 1");
  return result.rows[0] || null;
}

async function logEvent(session, eventType, node, payload = {}) {
  try {
    await query(
      `INSERT INTO ivr_events (call_id,flow_id,node_id,event_type,payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.callId, session.flow.id, node?.id || null, eventType, payload]
    );
  } catch (error) {
    console.warn(`[ivr ${session.waCallId}] event log failed`, error.message);
  }
  emitToDashboard("call:ivr", {
    id: session.callId,
    waCallId: session.waCallId,
    flowId: session.flow.id,
    nodeId: node?.id || null,
    eventType,
    payload,
  });
}

async function finish(session, reason = "completed") {
  session.waiting = null;
  await logEvent(session, "finished", nodeById(session.graph, session.currentNodeId), { reason, variables: session.variables });
  sessions.delete(session.waCallId);
  await session.actions.end?.(reason);
}

async function execute(session, startId) {
  let currentId = startId;
  let steps = 0;

  while (currentId && steps++ < MAX_STEPS) {
    const node = nodeById(session.graph, currentId);
    if (!node) return finish(session, "missing_node");
    session.currentNodeId = node.id;
    await logEvent(session, "entered", node, { type: node.type });

    if (node.type === "start") {
      currentId = nextId(session.graph, node.id);
      continue;
    }

    if (node.type === "speak") {
      const text = interpolate(node.data?.text, session.variables);
      if (text) await session.actions.speak(text, `ivr:${node.id}`);
      currentId = nextId(session.graph, node.id);
      continue;
    }

    if (node.type === "delay") {
      const ms = Math.min(30000, Math.max(0, Number(node.data?.seconds || 1) * 1000));
      await new Promise((resolve) => setTimeout(resolve, ms));
      currentId = nextId(session.graph, node.id);
      continue;
    }

    if (node.type === "menu") {
      const text = interpolate(node.data?.text, session.variables);
      if (text && session.lastPromptNodeId !== node.id) await session.actions.speak(text, `ivr:${node.id}`);
      session.lastPromptNodeId = node.id;
      session.waiting = { type: "menu", nodeId: node.id, attempts: session.waiting?.nodeId === node.id ? session.waiting.attempts : 0 };
      await logEvent(session, "waiting", node, { input: "menu" });
      return;
    }

    if (node.type === "collect") {
      const prompt = interpolate(node.data?.prompt, session.variables);
      if (prompt && session.lastPromptNodeId !== node.id) await session.actions.speak(prompt, `ivr:${node.id}`);
      session.lastPromptNodeId = node.id;
      session.waiting = { type: "collect", nodeId: node.id, variable: clean(node.data?.variable), attempts: 0 };
      await logEvent(session, "waiting", node, { input: "speech", variable: node.data?.variable });
      return;
    }

    if (node.type === "condition") {
      const rules = Array.isArray(node.data?.rules) ? node.data.rules : [];
      const matched = rules.find((rule) => compare(session.variables[rule.variable], rule.operator || "equals", interpolate(rule.value, session.variables)));
      currentId = nextId(session.graph, node.id, matched ? matched.handle || matched.id : "default");
      continue;
    }

    if (node.type === "webhook") {
      let handle = "success";
      try {
        const method = String(node.data?.method || "POST").toUpperCase();
        const response = await axios({
          method,
          url: interpolate(node.data?.url, session.variables),
          timeout: Math.min(15000, Math.max(1000, Number(node.data?.timeoutMs || 7000))),
          headers: node.data?.headers || {},
          data: method === "GET" ? undefined : { ...session.variables, ...(node.data?.body || {}) },
          params: method === "GET" ? session.variables : undefined,
        });
        const variable = clean(node.data?.responseVariable || "webhook");
        session.variables[variable] = response.data;
        await logEvent(session, "webhook_success", node, { status: response.status, variable });
      } catch (error) {
        handle = "error";
        session.variables.webhook_error = error.message;
        await logEvent(session, "webhook_error", node, { error: error.message, status: error.response?.status });
      }
      currentId = nextId(session.graph, node.id, handle);
      continue;
    }

    if (node.type === "transfer") {
      const message = interpolate(node.data?.message || "Please hold while I connect you to an agent.", session.variables);
      if (message) await session.actions.speak(message, `ivr:${node.id}`);
      await logEvent(session, "transfer_requested", node, { team: node.data?.team || "all" });
      sessions.delete(session.waCallId);
      await session.actions.transferAgent({ team: node.data?.team || "all", message, onlineAgents: getOnlineAgentCount() });
      return;
    }

    if (node.type === "end") {
      const message = interpolate(node.data?.message, session.variables);
      if (message) await session.actions.speak(message, `ivr:${node.id}`);
      return finish(session, node.data?.reason || "completed");
    }

    return finish(session, "unsupported_node");
  }

  if (steps >= MAX_STEPS) return finish(session, "step_limit");
  return finish(session, "no_next_node");
}

export async function startIvrSession({ waCallId, callId, contact, actions, announcement }) {
  const flow = await getActiveIvrFlow();
  if (!flow) {
    const text = announcement || "Thank you for calling. No phone menu is currently configured. Please try again later.";
    await actions.speak(text, "ivr:no_flow");
    await actions.end?.("no_active_flow");
    return null;
  }

  const validation = validateIvrGraph(flow.graph);
  if (!validation.valid) {
    console.error(`[ivr ${waCallId}] active flow is invalid`, validation.errors);
    await actions.speak("Our phone menu is temporarily unavailable. Please try again later.", "ivr:invalid");
    await actions.end?.("invalid_flow");
    return null;
  }

  const graph = graphParts(flow.graph);
  const start = graph.nodes.find((node) => node.type === "start");
  const session = {
    waCallId,
    callId,
    contact,
    flow,
    graph,
    actions,
    currentNodeId: start.id,
    waiting: null,
    lastPromptNodeId: null,
    variables: {
      caller: contact?.wa_id || "",
      contact_name: contact?.name || "",
      call_id: callId,
      wa_call_id: waCallId,
      started_at: new Date().toISOString(),
    },
  };
  sessions.set(waCallId, session);
  await logEvent(session, "started", start, { flowName: flow.name });
  if (announcement) await actions.speak(announcement, "ivr:transfer_announcement");
  await execute(session, start.id);
  return session;
}

export async function handleIvrInput(waCallId, input) {
  const session = sessions.get(waCallId);
  if (!session || !session.waiting) return false;
  const node = nodeById(session.graph, session.waiting.nodeId);
  if (!node) return false;
  const value = clean(input);
  session.variables.last_input = value;
  await logEvent(session, "input", node, { text: value });

  if (session.waiting.type === "collect") {
    session.variables[session.waiting.variable] = value;
    session.waiting = null;
    session.lastPromptNodeId = null;
    await execute(session, nextId(session.graph, node.id));
    return true;
  }

  const choices = Array.isArray(node.data?.choices) ? node.data.choices : [];
  const normalized = normalize(value);
  const choice = choices.find((item) => {
    const candidates = [item.value, item.label, ...(Array.isArray(item.keywords) ? item.keywords : [])].map(normalize).filter(Boolean);
    return candidates.some((candidate) => normalized === candidate || normalized.includes(candidate));
  });

  if (choice) {
    session.variables[node.data?.variable || "menu_choice"] = choice.value;
    session.waiting = null;
    session.lastPromptNodeId = null;
    await execute(session, nextId(session.graph, node.id, choice.value));
    return true;
  }

  session.waiting.attempts += 1;
  const maxAttempts = Math.max(1, Number(node.data?.maxAttempts || 3));
  if (session.waiting.attempts >= maxAttempts) {
    session.waiting = null;
    session.lastPromptNodeId = null;
    await execute(session, nextId(session.graph, node.id, "default"));
  } else {
    await session.actions.speak(interpolate(node.data?.invalidText || "Sorry, I did not understand. Please try again.", session.variables), `ivr:${node.id}:retry`);
    session.lastPromptNodeId = null;
    await execute(session, node.id);
  }
  return true;
}

export function stopIvrSession(waCallId) {
  sessions.delete(waCallId);
}

export function getIvrSession(waCallId) {
  return sessions.get(waCallId) || null;
}

export async function simulateIvr(graph, inputs = []) {
  const validation = validateIvrGraph(graph);
  if (!validation.valid) return { ...validation, trace: [] };
  const trace = [];
  const vars = {};
  const parts = graphParts(graph);
  let current = parts.nodes.find((node) => node.type === "start")?.id;
  let inputIndex = 0;
  for (let steps = 0; current && steps < MAX_STEPS; steps++) {
    const node = nodeById(parts, current);
    trace.push({ nodeId: node.id, type: node.type, label: node.data?.label || node.type });
    if (node.type === "menu") {
      const input = clean(inputs[inputIndex++]);
      const choice = (node.data?.choices || []).find((item) => [item.value, item.label, ...(item.keywords || [])].map(normalize).includes(normalize(input)));
      current = nextId(parts, node.id, choice?.value || "default");
    } else if (node.type === "collect") {
      vars[node.data?.variable] = clean(inputs[inputIndex++]);
      current = nextId(parts, node.id);
    } else if (node.type === "condition") {
      const matched = (node.data?.rules || []).find((rule) => compare(vars[rule.variable], rule.operator || "equals", rule.value));
      current = nextId(parts, node.id, matched ? matched.handle || matched.id : "default");
    } else if (["end", "transfer"].includes(node.type)) {
      current = null;
    } else {
      current = nextId(parts, node.id, node.type === "webhook" ? "success" : null);
    }
  }
  return { valid: true, errors: [], warnings: validation.warnings, trace, variables: vars };
}
