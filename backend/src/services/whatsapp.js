import axios from "axios";

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

function assertConfigured() {
  const missing = [];
  if (!PHONE_NUMBER_ID) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!ACCESS_TOKEN) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (missing.length) {
    throw new Error(
      `WhatsApp API is not configured: missing ${missing.join(", ")}. Set these in your environment and restart the backend.`
    );
  }
}

const base = () => {
  assertConfigured();
  return `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;
};

const headers = () => ({
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  "Content-Type": "application/json",
});

async function post(path, payload, label) {
  try {
    const response = await axios.post(`${base()}${path}`, payload, {
      headers: headers(),
      timeout: Number(process.env.WHATSAPP_API_TIMEOUT_MS || 10000),
    });
    console.log(`[whatsapp] ${label} accepted`, response.data || { status: response.status });
    return response;
  } catch (err) {
    console.error(`[whatsapp] ${label} failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw err;
  }
}

export async function sendText(to, body) {
  return post(
    "/messages",
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    "send text"
  );
}

export async function sendTemplate(to, templateName, languageCode = "en", components = []) {
  const normalizedTo = String(to || "").replace(/\D/g, "");
  const normalizedName = String(templateName || "").trim();
  const normalizedLanguage = String(languageCode || "en").trim();

  if (!normalizedTo) throw new Error("A valid WhatsApp destination number is required");
  if (!normalizedName) throw new Error("A WhatsApp template name is required");

  return post(
    "/messages",
    {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "template",
      template: {
        name: normalizedName,
        language: { code: normalizedLanguage },
        components,
      },
    },
    `send template ${normalizedName}/${normalizedLanguage}`
  );
}

export async function requestCallPermission(
  to,
  templateName = "request_call_permission",
  languageCode = "en"
) {
  // Use the approved template shown in WhatsApp Manager. Do not allow an old
  // Dokploy environment value such as call_permission_request to silently
  // override the working default.
  const name = String(templateName || "request_call_permission").trim();
  const language = String(languageCode || "en").trim();
  return sendTemplate(to, name, language);
}

export async function markRead(waMessageId) {
  return post(
    "/messages",
    { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
    "mark read"
  );
}

export async function sendAudio(to, mediaUrlOrId, isId = false) {
  return post(
    "/messages",
    {
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: isId ? { id: mediaUrlOrId } : { link: mediaUrlOrId },
    },
    "send audio"
  );
}

export async function preAcceptCall(waCallId, sdpAnswer) {
  return post(
    "/calls",
    {
      messaging_product: "whatsapp",
      call_id: waCallId,
      action: "pre_accept",
      session: { sdp_type: "answer", sdp: sdpAnswer },
    },
    `pre_accept ${waCallId}`
  );
}

export async function acceptCall(waCallId) {
  return post(
    "/calls",
    { messaging_product: "whatsapp", call_id: waCallId, action: "accept" },
    `accept ${waCallId}`
  );
}

export async function rejectCall(waCallId) {
  return post(
    "/calls",
    { messaging_product: "whatsapp", call_id: waCallId, action: "reject" },
    `reject ${waCallId}`
  );
}

export async function terminateCall(waCallId) {
  return post(
    "/calls",
    { messaging_product: "whatsapp", call_id: waCallId, action: "terminate" },
    `terminate ${waCallId}`
  );
}

export async function initiateCall(to, sdpOffer) {
  return post(
    "/calls",
    {
      messaging_product: "whatsapp",
      to,
      action: "connect",
      session: { sdp_type: "offer", sdp: sdpOffer },
    },
    `connect outbound ${to}`
  );
}
