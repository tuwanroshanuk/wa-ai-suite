import { Router } from "express";
import path from "path";
import fs from "fs";
import { query } from "../db/index.js";
import { requestCallPermission } from "../services/whatsapp.js";
import {
  claimCallAsAgent,
  rejectIncomingCall,
  transferCallToBot,
  createAgentPromptAudio,
  endCall,
} from "../services/callHandler.js";

const router = Router();
const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 15000);

router.get("/", async (req, res) => {
  const result = await query(
    `SELECT calls.*, contacts.name AS contact_name, contacts.wa_id
     FROM calls JOIN contacts ON contacts.id = calls.contact_id
     ORDER BY started_at DESC LIMIT 200`
  );
  res.json(result.rows);
});

router.get("/active", async (req, res) => {
  const result = await query(
    `SELECT calls.id, calls.wa_call_id AS "waCallId", calls.started_at AS "startedAt",
            calls.transcript, contacts.id AS contact_id, contacts.name, contacts.wa_id
       FROM calls JOIN contacts ON contacts.id = calls.contact_id
      WHERE calls.status = 'ringing'
      ORDER BY calls.started_at DESC LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return res.json(null);
  res.json({
    id: row.id,
    waCallId: row.waCallId,
    startedAt: row.startedAt,
    autoTransferAt: new Date(new Date(row.startedAt).getTime() + AGENT_RING_TIMEOUT_MS).toISOString(),
    transcript: row.transcript || [],
    contact: { id: row.contact_id, name: row.name, wa_id: row.wa_id },
  });
});

router.get("/:id/recording", async (req, res) => {
  const result = await query("SELECT recording_path FROM calls WHERE id = $1", [req.params.id]);
  const filePath = result.rows[0]?.recording_path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  res.sendFile(path.resolve(filePath));
});

router.post("/request-permission", async (req, res) => {
  const { waId, templateName } = req.body;
  if (!waId) return res.status(400).json({ error: "waId is required" });
  try {
    await requestCallPermission(waId, templateName);
    res.json({ ok: true });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    res.status(err.response?.status || 500).json({ error: detail });
  }
});

router.post("/:id/answer", async (req, res) => {
  const { offerSdp } = req.body || {};
  if (!offerSdp) {
    return res.status(400).json({ error: "Microphone WebRTC offer is required" });
  }

  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "ringing") {
    return res.status(409).json({ error: `Call is no longer ringing (status: ${row.status})` });
  }

  try {
    const claimed = await claimCallAsAgent(row.wa_call_id, req.user, offerSdp);
    res.json({ ok: true, answerSdp: claimed.answerSdp, call: claimed.call });
  } catch (err) {
    console.error(`[call ${row.wa_call_id}] browser answer failed`, err);
    res.status(409).json({ error: err.message });
  }
});

router.post("/:id/decline", async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "ringing") {
    return res.status(409).json({ error: `Call is no longer ringing (status: ${row.status})` });
  }

  const announcement = reason
    ? `Sorry, the agent is currently unavailable and declined the call. The agent left this message: ${reason}. You are now connected to our AI assistant. How can I help?`
    : "Sorry, the agent is currently unavailable and declined the call. You are now connected to our AI assistant. How can I help?";

  try {
    await transferCallToBot(row.wa_call_id, {
      announcement,
      reason: reason || null,
      source: "declined_by_agent",
    });
    res.json({ ok: true, transferredTo: "bot" });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.post("/:id/transfer-to-bot", async (req, res) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (!["ringing", "connected"].includes(row.status)) {
    return res.status(409).json({ error: `Call already ended (status: ${row.status})` });
  }

  const announcement = reason
    ? `Please hold. The agent is transferring your call to our AI assistant because: ${reason}. How can I help you now?`
    : "Please hold. Your call is now being transferred to our AI assistant. How can I help?";

  try {
    await transferCallToBot(row.wa_call_id, {
      announcement,
      reason: reason || null,
      source: "transferred_by_agent",
    });
    res.json({ ok: true, transferredTo: "bot" });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

router.post("/:id/prompt-audio", async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: "Prompt text is required" });

  const result = await query("SELECT wa_call_id, status, handled_by FROM calls WHERE id = $1", [
    req.params.id,
  ]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "connected" || !String(row.handled_by).startsWith("agent:")) {
    return res.status(409).json({ error: "An agent-connected call is required" });
  }

  try {
    const audio = await createAgentPromptAudio(row.wa_call_id, text, req.user);
    res.setHeader("Content-Type", audio.contentType);
    res.setHeader("X-TTS-Provider", audio.provider);
    res.setHeader("Cache-Control", "no-store");
    res.send(audio.audio);
  } catch (err) {
    res.status(502).json({ error: err.response?.data || err.message });
  }
});

router.post("/:id/end", async (req, res) => {
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (!["ringing", "connected"].includes(row.status)) {
    return res.status(409).json({ error: `Call already ended (status: ${row.status})` });
  }

  try {
    await endCall(row.wa_call_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.response?.data || err.message });
  }
});

router.post("/:id/reject", async (req, res) => {
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "ringing") {
    return res.status(409).json({ error: `Call is no longer ringing (status: ${row.status})` });
  }
  await rejectIncomingCall(row.wa_call_id, "hard_reject_by_agent");
  res.json({ ok: true });
});

router.post("/:id/take-over", async (req, res) => {
  res.status(409).json({
    error: "Takeover must begin while the incoming call is ringing. Use the realtime Answer dialog so the browser microphone can negotiate before WhatsApp accepts the call.",
  });
});

export default router;
