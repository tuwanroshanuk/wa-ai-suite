import { Router } from "express";
import path from "path";
import fs from "fs";
import { query } from "../db/index.js";
import { requestCallPermission } from "../services/whatsapp.js";
import { claimCallAsAgent, rejectIncomingCall } from "../services/callHandler.js";

const router = Router();

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
            contacts.id AS contact_id, contacts.name, contacts.wa_id
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

router.post("/:id/decline", async (req, res) => {
  const result = await query("SELECT wa_call_id, status FROM calls WHERE id = $1", [req.params.id]);
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: "Call not found" });
  if (row.status !== "ringing") {
    return res.status(409).json({ error: `Call is no longer ringing (status: ${row.status})` });
  }
  await rejectIncomingCall(row.wa_call_id, "declined_by_agent");
  res.json({ ok: true });
});

router.post("/:id/take-over", async (req, res) => {
  res.status(501).json({
    error: "Browser audio takeover is not available for an already bot-connected call. Answer the incoming call from the realtime dialog instead.",
  });
});

export default router;
