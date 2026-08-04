import { Router } from "express";
import crypto from "crypto";
import { query } from "../db/index.js";
import { advanceFlow } from "../services/flowEngine.js";
import {
  handleIncomingCall,
  handleCallTerminated,
  rejectIncomingCall,
} from "../services/callHandler.js";
import { emitToDashboard } from "../sockets.js";

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
  if (!appSecret || !signature) return next();

  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody || "").digest("hex");

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    console.warn("[webhook] signature mismatch");
    return res.sendStatus(401);
  }
  next();
}

router.post("/", verifySignature, async (req, res) => {
  // Acknowledge immediately; Meta retries slow or non-2xx webhooks.
  res.sendStatus(200);

  try {
    // A payload may contain multiple entries and changes. Processing only [0]
    // can silently drop call lifecycle events and leave incorrect statuses.
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change?.value;
        if (!value) continue;

        for (const msg of value.messages || []) {
          await handleInboundMessage(value, msg);
        }

        for (const call of value.calls || []) {
          await handleCallEvent(call);
        }
      }
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

  emitToDashboard("message:new", {
    conversationId: conversation.id,
    contactId: contact.id,
    text,
    type: msg.type,
  });

  if (contact.bot_enabled && conversation.status === "open") {
    await advanceFlow(conversation, contact, text);
  }
}

async function handleCallEvent(call) {
  const waCallId = call.id;
  const event = call.event;
  const fromWaId = call.from;

  console.log(`[call ${waCallId}] webhook event: ${event}`);

  if (event === "connect") {
    if (!fromWaId) {
      console.warn(`[call ${waCallId}] connect event missing caller id`);
      return;
    }

    const contact = await getOrCreateContact(fromWaId);
    if (!contact.bot_enabled) {
      await rejectIncomingCall(waCallId, "bot_disabled");
      return;
    }

    const offerSdp = call.session?.sdp;
    if (!offerSdp) {
      console.warn(`[call ${waCallId}] connect event missing SDP offer`);
      return;
    }

    await handleIncomingCall({ waCallId, offerSdp, contact });
    return;
  }

  // Preserve Meta's final outcome instead of collapsing every event into
  // one generic termination path.
  if (event === "terminate") {
    await handleCallTerminated(waCallId, "terminate");
    return;
  }

  if (event === "reject") {
    await handleCallTerminated(waCallId, "reject");
    return;
  }

  if (event === "timeout") {
    await handleCallTerminated(waCallId, "timeout");
  }
}

export default router;
