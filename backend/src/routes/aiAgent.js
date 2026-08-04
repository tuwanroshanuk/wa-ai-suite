import { Router } from "express";
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  getAiAgentRuntime,
  getAiAgentSettings,
  getLiveVoiceCatalog,
  listKnowledgeEntries,
  saveAiAgentSettings,
  updateKnowledgeEntry,
} from "../services/aiAgent.js";
import { generateReply } from "../services/gemini.js";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const [settings, knowledge] = await Promise.all([
      getAiAgentSettings(),
      listKnowledgeEntries(),
    ]);
    res.json({ settings, knowledge, liveVoices: getLiveVoiceCatalog() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/settings", async (req, res) => {
  try {
    const settings = await saveAiAgentSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/test", async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Test message is required." });

  try {
    const runtime = await getAiAgentRuntime(message);
    const reply = await generateReply(
      [{ role: "user", text: message }],
      runtime.systemPrompt,
      { model: runtime.settings.textModel }
    );
    res.json({ reply, model: runtime.settings.textModel });
  } catch (err) {
    res.status(err.response?.status || 502).json({
      error: err.response?.data?.error?.message || err.message,
      detail: err.response?.data || null,
    });
  }
});

router.post("/knowledge", async (req, res) => {
  try {
    const entry = await createKnowledgeEntry(req.body || {});
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/knowledge/:id", async (req, res) => {
  try {
    const entry = await updateKnowledgeEntry(req.params.id, req.body || {});
    res.json(entry);
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 400).json({ error: err.message });
  }
});

router.delete("/knowledge/:id", async (req, res) => {
  try {
    const deleted = await deleteKnowledgeEntry(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Knowledge entry not found." });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
