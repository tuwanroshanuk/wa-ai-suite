import { Router } from "express";
import crypto from "crypto";
import { query } from "../db/index.js";
import { advanceFlow } from "../services/flowEngine.js";
import { requestCallPermission } from "../services/whatsapp.js";
import {
  handleIncomingCall,
  handleCallTerminated,
  rejectIncomingCall,
} from "../services/callHandler.js";

const router = Router();

// ---- GET: Meta's webhook verification handshake ----
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- Signature verification middleware ----
function verifySignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret || !signature) return next(); // allow through in dev if not configured
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody || "").digest("hex");
  if (signature !== expected) {
    console.warn("[webhook] signature mismatch");
    return res.sendStatus(401);
  }
  next();
}

router.post("/", verifySignature, async (req, res) => {
  // Always ack fast; WhatsApp retries aggressively on non-2xx / slow responses.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    if (!value) return;

    if (value.messages) {
      for (const msg of value.messages) {
        await handleInboundMessage(value, msg);
      }
    }

    if (value.calls) {
      for (const call of value.calls) {
        await handleCallEvent(value, call);
      }
    }

    if (value.statuses) {
      // Delivery/read receipts for messages you sent - extend as needed.
    }
  } catch (err) {
    console.error("[webhook] error handling payload", err);
  }
});

async function getOrCreateContact(waId, profileName) {
  const existing = await query("SELECT * FROM contacts WHERE wa_id = $1", [waId]);
  if (existing.rows.length) return existing.rows[0];
  const inserted = await query(
    "INSERT INTO contacts (wa_id, name) VALUES ($1,$2) RETURNING *",
    [waId, profileName || null]
  );
  return inserted.rows[0];
}

async function getOrCreateConversation(contactId) {
  const existing = await query(
    "SELECT * FROM conversations WHERE contact_id = $1 AND status != 'closed' ORDER BY id DESC LIMIT 1",
    [contactId]
  );
  if (existing.rows.length) return existing.rows[0];
  const inserted = await query(
    "INSERT INTO conversations (contact_id) VALUES ($1) RETURNING *",
    [contactId]
  );
  return inserted.rows[0];
}

async function handleInboundMessage(value, msg) {
  const waId = msg.from;
  const profileName = value.contacts?.[0]?.profile?.name;
  const contact = await getOrCreateContact(waId, profileName);
  const conversation = await getOrCreateConversation(contact.id);

  const text =
    msg.text?.body ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.list_reply?.title ||
    "";

  await query(
    `INSERT INTO messages (conversation_id, direction, sender, wa_message_id, type, body, raw)
     VALUES ($1,'inbound','customer',$2,$3,$4,$5)`,
    [conversation.id, msg.id, msg.type, text, msg]
  );
  await query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [conversation.id]);

  // TODO: emit socket.io event here so the dashboard updates live (see src/sockets.js)

  if (contact.bot_enabled && conversation.status === "open") {
    await advanceFlow(conversation, contact, text);
  }
}

async function handleCallEvent(value, call) {
  const waCallId = call.id;
  const event = call.event; // e.g. 'connect' | 'terminate' | 'permission_denied' etc.
  const fromWaId = call.from;

  if (event === "connect") {
    const contact = await getOrCreateContact(fromWaId);
    if (!contact.bot_enabled) {
      // No bot handling configured for this contact -> reject or route to a human queue.
      await rejectIncomingCall(waCallId, "bot_disabled");
      return;
    }
    const offerSdp = call.session?.sdp;
    if (!offerSdp) return;
    await handleIncomingCall({ waCallId, fromWaId, offerSdp, contact });
  }

  if (event === "terminate" || event === "reject" || event === "timeout") {
    await handleCallTerminated(waCallId);
  }
}

// Convenience endpoint the dashboard can call to request outbound-call
// consent from a customer before the bot/agent tries to call them.
router.post("/request-call-permission", async (req, res) => {
  const { waId, templateName } = req.body;
  try {
    await requestCallPermission(waId, templateName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

export default router;
