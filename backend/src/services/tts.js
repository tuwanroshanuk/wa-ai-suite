import axios from "axios";
import { query } from "../db/index.js";

const TTS_URL = process.env.TTS_SERVICE_URL || "http://tts-service:6000";
const SETTINGS_KEY = "call_voice";

const ENV_DEFAULTS = {
  provider: process.env.TTS_PROVIDER || "piper",
  voice: process.env.TTS_DEFAULT_VOICE || "en_US-lessac-medium",
  speed: Number(process.env.TTS_DEFAULT_SPEED || 1),
};

function normalizeSettings(value = {}) {
  const speed = Number(value.speed ?? ENV_DEFAULTS.speed);
  return {
    provider: String(value.provider || ENV_DEFAULTS.provider).trim().toLowerCase(),
    voice: String(value.voice || ENV_DEFAULTS.voice).trim(),
    speed: Math.max(0.65, Math.min(1.45, Number.isFinite(speed) ? speed : 1)),
  };
}

export async function getVoiceSettings() {
  try {
    const result = await query("SELECT value FROM app_settings WHERE key=$1", [SETTINGS_KEY]);
    return normalizeSettings(result.rows[0]?.value || ENV_DEFAULTS);
  } catch (err) {
    console.warn("[tts] could not read saved voice settings; using environment defaults", err.message);
    return normalizeSettings(ENV_DEFAULTS);
  }
}

export async function saveVoiceSettings(settings) {
  const value = normalizeSettings(settings);
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [SETTINGS_KEY, value]
  );
  return value;
}

export async function listVoices() {
  const { data } = await axios.get(`${TTS_URL}/voices`, { timeout: 30000 });
  return data;
}

function explicitOptions(value) {
  if (!value) return null;
  if (typeof value === "string") return { voice: value };
  return value;
}

export async function synthesizeWithMetadata(text, options) {
  const supplied = explicitOptions(options);
  const settings = normalizeSettings(supplied || (await getVoiceSettings()));

  const response = await axios.post(
    `${TTS_URL}/speak`,
    {
      text,
      provider: settings.provider,
      voice: settings.voice,
      speed: settings.speed,
    },
    {
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024,
    }
  );

  return {
    audio: Buffer.from(response.data),
    contentType: response.headers["content-type"] || "application/octet-stream",
    provider: response.headers["x-tts-provider"] || settings.provider || "unknown",
    voice: response.headers["x-tts-voice"] || settings.voice,
    speed: settings.speed,
  };
}

export async function synthesize(text, options) {
  const result = await synthesizeWithMetadata(text, options);
  return result.audio;
}

export async function synthesizeStream(text, options) {
  const supplied = explicitOptions(options);
  const settings = normalizeSettings(supplied || (await getVoiceSettings()));
  const response = await axios.post(
    `${TTS_URL}/speak-stream`,
    {
      text,
      provider: settings.provider,
      voice: settings.voice,
      speed: settings.speed,
    },
    { responseType: "stream", timeout: 120000 }
  );
  return response.data;
}
