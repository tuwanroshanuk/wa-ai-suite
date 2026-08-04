import { Router } from "express";
import path from "path";
import fs from "fs";
import { query } from "../db/index.js";
import { requestCallPermission } from "../services/whatsapp.js";
import { claimCallAsAgent } from "../services/callHandler.js";

const router = Router();
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";

router.get("/", async (req, res) => {
  const result = await query(
    `SELECT calls.*, contacts.name AS contact_name, contacts.wa_id
     FROM calls JOIN contacts ON contacts.id = calls.contact_id
     ORDER BY started_at DESC LIMIT 200`
  );
  res.json(result.rows);
});

router.get("/:id/recording", async (req, res) => {
  const result = await query("SELECT recording_path FROM calls WHERE id = $1", [req.params.id]);
  const filePath = result.rows[0]?.recording_path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: "not found" });
  res.sendFile(path.resolve(filePath));
});

// Step 1 of business-initiated calling: ask the customer for permission
// via WhatsApp's required interactive call-permission template.
router.post("/request-permission", async (req, res) => {
  const { waId, templateName } = req.body;
  if (!waId) return res.status(400).json({ error: "waId is required" });
  try {
    await requestCallPermission(waId, templateName);
    res.json({ ok: true });
  } catch (err) {
    // Surface Meta's actual error (bad template name, unconfigured
    // credentials, unverified number, etc.) instead of a bare 500 so the
    // dashboard can show the person what actually went wrong.
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    res.status(err.response?.status || 500).json({ error: detail });
  }
});

/**
 * An agent claims a still-ringing incoming call before the auto-answer
 * timeout routes it to the bot (see services/callHandler.js).
 */
router.post("/:id/answer", async (req, res) => {
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "ringing") {
    return res.status(409).json({ error: `Call is no longer ringing (status: ${row.status})` });
  }
  try {
    await claimCallAsAgent(row.wa_call_id, req.user);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/**
 * Browser-based agent calling ("call using browser"):
 * The agent's browser opens a WebRTC connection to THIS backend (via
 * socket.io signaling, see src/sockets.js), and the backend bridges that
 * audio with the werift peer connection already talking to WhatsApp
 * (see services/callHandler.js). That bridge - mixing/relaying two live
 * WebRTC audio streams server-side - is the next milestone to build and
 * load-test; wire it up once the bot-side calling in callHandler.js is
 * confirmed working end-to-end against your Meta calling sandbox, since
 * the agent bridge reuses the exact same peer connection object.
 * This endpoint is the placeholder the frontend's "Call" button hits.
 */
router.post("/:id/take-over", async (req, res) => {
  await query("UPDATE calls SET handled_by = $1 WHERE id = $2", [
    `agent:${req.user.id}`,
    req.params.id,
  ]);
  res.json({
    ok: true,
    note: "Call marked as agent-handled. Browser audio bridge is the next build milestone - see comment in this route.",
  });
});

export default router;
