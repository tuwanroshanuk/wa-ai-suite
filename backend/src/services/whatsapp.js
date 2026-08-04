import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const base = () => `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;
const headers = () => ({
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  "Content-Type": "application/json",
});

// ---------- Messaging ----------

export async function sendText(to, body) {
  return axios.post(
    `${base()}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    { headers: headers() }
  );
}

export async function sendTemplate(to, templateName, languageCode = "en_US", components = []) {
  return axios.post(
    `${base()}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: languageCode }, components },
    },
    { headers: headers() }
  );
}

// Sends WhatsApp's "call permission request" interactive template.
// Meta requires customers to grant permission before you can call them.
// You must create/approve a call-permission template in the Meta dashboard first;
// pass its exact name here.
export async function requestCallPermission(to, templateName = "call_permission_request") {
  return sendTemplate(to, templateName, "en_US");
}

export async function markRead(waMessageId) {
  return axios.post(
    `${base()}/messages`,
    { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
    { headers: headers() }
  );
}

export async function sendAudio(to, mediaUrlOrId, isId = false) {
  return axios.post(
    `${base()}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: isId ? { id: mediaUrlOrId } : { link: mediaUrlOrId },
    },
    { headers: headers() }
  );
}

// ---------- Calling ----------
// WhatsApp Calling exchanges WebRTC SDP through these Graph endpoints rather
// than raw SIP. Your backend is a real WebRTC peer (see services/callHandler.js).

export async function preAcceptCall(waCallId, sdpAnswer) {
  return axios.post(
    `${base()}/calls`,
    {
      messaging_product: "whatsapp",
      call_id: waCallId,
      action: "pre_accept",
      session: { sdp_type: "answer", sdp: sdpAnswer },
    },
    { headers: headers() }
  );
}

export async function acceptCall(waCallId, sdpAnswer) {
  return axios.post(
    `${base()}/calls`,
    {
      messaging_product: "whatsapp",
      call_id: waCallId,
      action: "accept",
      session: { sdp_type: "answer", sdp: sdpAnswer },
    },
    { headers: headers() }
  );
}

export async function rejectCall(waCallId) {
  return axios.post(
    `${base()}/calls`,
    { messaging_product: "whatsapp", call_id: waCallId, action: "reject" },
    { headers: headers() }
  );
}

export async function terminateCall(waCallId) {
  return axios.post(
    `${base()}/calls`,
    { messaging_product: "whatsapp", call_id: waCallId, action: "terminate" },
    { headers: headers() }
  );
}

// Business-initiated outbound call (only valid once the customer has granted
// call permission - see requestCallPermission above).
export async function initiateCall(to, sdpOffer) {
  return axios.post(
    `${base()}/calls`,
    {
      messaging_product: "whatsapp",
      to,
      action: "connect",
      session: { sdp_type: "offer", sdp: sdpOffer },
    },
    { headers: headers() }
  );
}
