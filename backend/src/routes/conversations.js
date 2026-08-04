import { Router } from "express";
import { query } from "../db/index.js";
import { sendText } from "../services/whatsapp.js";

const router = Router();

router.get("/", async (req, res) => {
  const result = await query(
    `SELECT c.*, ct.name AS contact_name, ct.wa_id
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     ORDER BY c.last_message_at DESC
     LIMIT 200`
  );
  res.json(result.rows);
});

router.get("/:id/messages", async (req, res) => {
  const result = await query(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
    [req.params.id]
  );
  res.json(result.rows);
});

// Agent sends a manual message, pausing the bot for this conversation.
router.post("/:id/reply", async (req, res) => {
  const { text } = req.body;
  const convResult = await query(
    "SELECT c.*, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1",
    [req.params.id]
  );
  const conversation = convResult.rows[0];
  if (!conversation) return res.status(404).json({ error: "not found" });

  await sendText(conversation.wa_id, text);
  await query(
    "INSERT INTO messages (conversation_id, direction, sender, type, body) VALUES ($1,'outbound',$2,'text',$3)",
    [conversation.id, `agent:${req.user.id}`, text]
  );
  await query("UPDATE conversations SET status='open', last_message_at=now() WHERE id=$1", [
    conversation.id,
  ]);
  res.json({ ok: true });
});

router.post("/:id/assign", async (req, res) => {
  await query("UPDATE conversations SET assigned_agent_id = $1 WHERE id = $2", [
    req.user.id,
    req.params.id,
  ]);
  res.json({ ok: true });
});

router.post("/:id/toggle-bot", async (req, res) => {
  const conv = await query("SELECT contact_id FROM conversations WHERE id=$1", [req.params.id]);
  const contactId = conv.rows[0]?.contact_id;
  if (!contactId) return res.status(404).json({ error: "not found" });
  const { enabled } = req.body;
  await query("UPDATE contacts SET bot_enabled = $1 WHERE id = $2", [enabled, contactId]);
  res.json({ ok: true });
});

router.post("/:id/close", async (req, res) => {
  await query("UPDATE conversations SET status = 'closed' WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

export default router;
