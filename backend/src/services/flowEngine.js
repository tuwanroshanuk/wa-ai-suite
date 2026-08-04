import { query } from "../db/index.js";
import { sendText, sendAudio } from "./whatsapp.js";
import { generateReply } from "./gemini.js";

/**
 * Flow graph shape (built by the React Flow UI, stored as JSON):
 * {
 *   nodes: [
 *     { id, type: 'start'|'message'|'audio'|'menu'|'ai_reply'|'handoff'|'end', data: {...} },
 *     ...
 *   ],
 *   edges: [ { id, source, target, sourceHandle? } ]
 * }
 *
 * Node data by type:
 *  message   -> { text }
 *  audio     -> { assetId, fallbackText }        // pre-recorded free audio clip
 *  menu      -> { text, options: [{label, value}] } // matched against next inbound text
 *  ai_reply  -> { systemPrompt }                  // hands the message to Gemini
 *  handoff   -> { note }                          // marks conversation for a human agent
 *  end       -> {}
 */

function findNode(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}

function findStartNode(graph) {
  return graph.nodes.find((n) => n.type === "start");
}

function nextNodeId(graph, currentId, handle) {
  const edge = graph.edges.find(
    (e) => e.source === currentId && (!handle || e.sourceHandle === handle)
  );
  return edge?.target || null;
}

async function getActiveFlow() {
  const result = await query(
    "SELECT * FROM flows WHERE is_active = true ORDER BY updated_at DESC LIMIT 1"
  );
  return result.rows[0] || null;
}

async function getAudioAsset(id) {
  const result = await query("SELECT * FROM audio_assets WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function recordOutbound(conversationId, sender, type, body) {
  await query(
    "INSERT INTO messages (conversation_id, direction, sender, type, body) VALUES ($1,'outbound',$2,$3,$4)",
    [conversationId, sender, type, body]
  );
}

/**
 * Runs one step of the flow for a given conversation, in response to an inbound
 * customer message. Advances flow_state.currentNodeId and sends whatever the
 * node produces, until it hits a node that needs to wait for the next customer
 * reply (menu) or reaches 'end'/'handoff'.
 */
export async function advanceFlow(conversation, contact, inboundText) {
  const flow = await getActiveFlow();
  if (!flow) {
    // No flow configured -> fall back straight to Gemini as a generic assistant.
    const reply = await generateReply(
      [{ role: "user", text: inboundText }],
      "You are a helpful, concise WhatsApp customer support assistant."
    );
    await sendText(contact.wa_id, reply);
    await recordOutbound(conversation.id, "bot", "text", reply);
    return;
  }

  const graph = flow.graph;
  let state = conversation.flow_state || {};
  let currentId = state.currentNodeId || findStartNode(graph)?.id;

  // If we were waiting on a menu choice, resolve it against the inbound text.
  const currentNode = currentId ? findNode(graph, currentId) : null;
  if (currentNode?.type === "menu") {
    const match = currentNode.data.options?.find(
      (o) => o.value.toLowerCase() === inboundText.trim().toLowerCase()
    );
    currentId = nextNodeId(graph, currentNode.id, match ? match.value : "default");
  } else if (!currentId) {
    currentId = findStartNode(graph)?.id;
  }

  // Walk forward through non-interactive nodes until we hit one that needs
  // to pause (menu) or terminates (end/handoff).
  let guard = 0;
  while (currentId && guard < 25) {
    guard++;
    const node = findNode(graph, currentId);
    if (!node) break;

    if (node.type === "start") {
      currentId = nextNodeId(graph, node.id);
      continue;
    }

    if (node.type === "message") {
      await sendText(contact.wa_id, node.data.text);
      await recordOutbound(conversation.id, "bot", "text", node.data.text);
      currentId = nextNodeId(graph, node.id);
      continue;
    }

    if (node.type === "audio") {
      const asset = node.data.assetId ? await getAudioAsset(node.data.assetId) : null;
      if (asset) {
        // In production, host recordings/ over HTTPS and pass the public URL here.
        await sendAudio(contact.wa_id, asset.file_path);
        await recordOutbound(conversation.id, "bot", "audio", asset.name);
      } else if (node.data.fallbackText) {
        await sendText(contact.wa_id, node.data.fallbackText);
        await recordOutbound(conversation.id, "bot", "text", node.data.fallbackText);
      }
      currentId = nextNodeId(graph, node.id);
      continue;
    }

    if (node.type === "menu") {
      await sendText(contact.wa_id, node.data.text);
      await recordOutbound(conversation.id, "bot", "text", node.data.text);
      state.currentNodeId = node.id; // pause here, wait for reply
      await query("UPDATE conversations SET flow_state = $1, active_flow_id = $2 WHERE id = $3", [
        state,
        flow.id,
        conversation.id,
      ]);
      return;
    }

    if (node.type === "ai_reply") {
      const history = await query(
        "SELECT direction, body FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 10",
        [conversation.id]
      );
      const chat = history.rows
        .reverse()
        .map((m) => ({ role: m.direction === "inbound" ? "user" : "assistant", text: m.body || "" }));
      chat.push({ role: "user", text: inboundText });

      const reply = await generateReply(chat, node.data.systemPrompt);
      await sendText(contact.wa_id, reply);
      await recordOutbound(conversation.id, "bot", "text", reply);
      currentId = nextNodeId(graph, node.id);
      continue;
    }

    if (node.type === "handoff") {
      await query("UPDATE conversations SET status = 'pending' WHERE id = $1", [conversation.id]);
      if (node.data.note) {
        await sendText(contact.wa_id, node.data.note);
        await recordOutbound(conversation.id, "bot", "text", node.data.note);
      }
      state.currentNodeId = null;
      await query("UPDATE conversations SET flow_state = $1 WHERE id = $2", [state, conversation.id]);
      return;
    }

    if (node.type === "end") {
      state.currentNodeId = null;
      await query("UPDATE conversations SET flow_state = $1, active_flow_id = $2 WHERE id = $3", [
        state,
        flow.id,
        conversation.id,
      ]);
      return;
    }

    break;
  }

  state.currentNodeId = currentId;
  await query("UPDATE conversations SET flow_state = $1, active_flow_id = $2 WHERE id = $3", [
    state,
    flow.id,
    conversation.id,
  ]);
}
