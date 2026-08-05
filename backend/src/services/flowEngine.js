import { query } from "../db/index.js";
import { sendText, sendAudio } from "./whatsapp.js";

function nodeById(graph, id) {
  return (graph.nodes || []).find((node) => node.id === id) || null;
}

function nextId(graph, id, handle = null) {
  const edges = (graph.edges || []).filter((edge) => edge.source === id);
  if (handle !== null) {
    const exact = edges.find((edge) => String(edge.sourceHandle || "") === String(handle));
    if (exact) return exact.target;
  }
  return edges.find((edge) => ["default", "next"].includes(String(edge.sourceHandle || "")))?.target || edges[0]?.target || null;
}

async function activeFlow() {
  const result = await query("SELECT * FROM flows WHERE is_active=true ORDER BY updated_at DESC LIMIT 1");
  return result.rows[0] || null;
}

async function record(conversationId, type, body) {
  await query(
    "INSERT INTO messages (conversation_id,direction,sender,type,body) VALUES ($1,'outbound','bot',$2,$3)",
    [conversationId, type, body]
  );
}

async function sendMessage(contact, conversationId, text) {
  if (!text) return;
  await sendText(contact.wa_id, text);
  await record(conversationId, "text", text);
}

export async function advanceFlow(conversation, contact, inboundText) {
  const flow = await activeFlow();
  if (!flow) {
    await sendMessage(contact, conversation.id, "Thanks for your message. An agent will reply as soon as possible.");
    await query("UPDATE conversations SET status='pending' WHERE id=$1", [conversation.id]);
    return;
  }

  const graph = flow.graph || { nodes: [], edges: [] };
  const start = (graph.nodes || []).find((node) => node.type === "start");
  const state = conversation.flow_state || {};
  let current = state.currentNodeId || start?.id;
  let node = current ? nodeById(graph, current) : null;

  if (node?.type === "menu") {
    const input = String(inboundText || "").trim().toLowerCase();
    const choice = (node.data?.choices || []).find((item) =>
      [item.value, item.label, ...(item.keywords || [])]
        .map((value) => String(value || "").toLowerCase())
        .some((value) => value && (input === value || input.includes(value)))
    );
    current = nextId(graph, node.id, choice?.value || "default");
  } else if (node?.type === "collect") {
    state.variables = { ...(state.variables || {}), [node.data?.variable || "answer"]: inboundText };
    current = nextId(graph, node.id);
  }

  let guard = 0;
  while (current && guard++ < 60) {
    node = nodeById(graph, current);
    if (!node) break;

    if (node.type === "start") {
      current = nextId(graph, node.id);
      continue;
    }

    if (node.type === "speak" || node.type === "message") {
      await sendMessage(contact, conversation.id, node.data?.text || "");
      current = nextId(graph, node.id);
      continue;
    }

    if (node.type === "audio") {
      const asset = node.data?.assetId
        ? (await query("SELECT * FROM audio_assets WHERE id=$1", [node.data.assetId])).rows[0]
        : null;
      if (asset) {
        await sendAudio(contact.wa_id, asset.file_path);
        await record(conversation.id, "audio", asset.name);
      } else {
        await sendMessage(contact, conversation.id, node.data?.fallbackText || "");
      }
      current = nextId(graph, node.id);
      continue;
    }

    if (node.type === "menu") {
      await sendMessage(contact, conversation.id, node.data?.text || "Please choose an option.");
      state.currentNodeId = node.id;
      await query("UPDATE conversations SET flow_state=$1,active_flow_id=$2 WHERE id=$3", [state, flow.id, conversation.id]);
      return;
    }

    if (node.type === "collect") {
      await sendMessage(contact, conversation.id, node.data?.prompt || "Please provide the requested information.");
      state.currentNodeId = node.id;
      await query("UPDATE conversations SET flow_state=$1,active_flow_id=$2 WHERE id=$3", [state, flow.id, conversation.id]);
      return;
    }

    if (node.type === "transfer" || node.type === "handoff") {
      await sendMessage(contact, conversation.id, node.data?.message || node.data?.note || "An agent will assist you shortly.");
      await query("UPDATE conversations SET status='pending',flow_state=$1,active_flow_id=$2 WHERE id=$3", [{ ...state, currentNodeId: null }, flow.id, conversation.id]);
      return;
    }

    if (node.type === "end") {
      await sendMessage(contact, conversation.id, node.data?.message || "");
      await query("UPDATE conversations SET flow_state=$1,active_flow_id=$2 WHERE id=$3", [{ ...state, currentNodeId: null }, flow.id, conversation.id]);
      return;
    }

    // Voice-only nodes are skipped safely in text conversations.
    current = nextId(graph, node.id, node.type === "webhook" ? "success" : null);
  }

  await query("UPDATE conversations SET flow_state=$1,active_flow_id=$2 WHERE id=$3", [{ ...state, currentNodeId: current }, flow.id, conversation.id]);
}
