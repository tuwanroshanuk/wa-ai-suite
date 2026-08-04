import { Router } from "express";
import path from "path";
import fs from "fs";
import { query } from "../db/index.js";
import { requestCallPermission } from "../services/whatsapp.js";

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
  try {
    await requestCallPermission(waId, templateName);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
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
