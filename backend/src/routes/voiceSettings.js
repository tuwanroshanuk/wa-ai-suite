import { Router } from "express";
import {
  getVoiceSettings,
  listVoices,
  saveVoiceSettings,
  synthesizeWithMetadata,
} from "../services/tts.js";

const router = Router();

function cleanSettings(input = {}) {
  const speed = Number(input.speed ?? 1);
  return {
    provider: String(input.provider || "piper").trim().toLowerCase(),
    voice: String(input.voice || "en_US-lessac-medium").trim(),
    speed: Math.max(0.65, Math.min(1.45, Number.isFinite(speed) ? speed : 1)),
  };
}

async function validateVoice(settings) {
  const catalog = await listVoices();
  const voices = Array.isArray(catalog) ? catalog : catalog.voices || [];
  const match = voices.find(
    (voice) => voice.id === settings.voice && voice.provider === settings.provider
  );
  if (!match) {
    const error = new Error("The selected voice is not available in the TTS service.");
    error.statusCode = 400;
    throw error;
  }
  return { catalog, match };
}

router.get("/", async (req, res) => {
  try {
    const [settings, catalog] = await Promise.all([getVoiceSettings(), listVoices()]);
    res.json({ settings, catalog });
  } catch (err) {
    res.status(502).json({ error: err.response?.data || err.message });
  }
});

router.post("/", async (req, res) => {
  const settings = cleanSettings(req.body);
  try {
    await validateVoice(settings);
    const saved = await saveVoiceSettings(settings);
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.response?.data || err.message });
  }
});

router.post("/preview", async (req, res) => {
  const settings = cleanSettings(req.body);
  const text = String(
    req.body?.text || "Hello. This is a preview of your selected call assistant voice."
  )
    .trim()
    .slice(0, 500);

  if (!text) return res.status(400).json({ error: "Preview text is required" });

  try {
    await validateVoice(settings);
    const result = await synthesizeWithMetadata(text, settings);
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("X-TTS-Provider", result.provider);
    res.setHeader("X-TTS-Voice", result.voice);
    res.setHeader("Cache-Control", "no-store");
    res.send(result.audio);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.response?.data || err.message });
  }
});

export default router;
