import axios from "axios";

const TTS_URL = process.env.TTS_SERVICE_URL || "http://tts-service:6000";

export async function synthesizeWithMetadata(text, voice) {
  const response = await axios.post(
    `${TTS_URL}/speak`,
    { text, voice: voice || process.env.TTS_DEFAULT_VOICE },
    { responseType: "arraybuffer" }
  );

  return {
    audio: Buffer.from(response.data),
    contentType: response.headers["content-type"] || "application/octet-stream",
    provider: response.headers["x-tts-provider"] || "unknown",
  };
}

export async function synthesize(text, voice) {
  const result = await synthesizeWithMetadata(text, voice);
  return result.audio;
}

export async function synthesizeStream(text, voice) {
  const response = await axios.post(
    `${TTS_URL}/speak-stream`,
    { text, voice: voice || process.env.TTS_DEFAULT_VOICE },
    { responseType: "stream" }
  );
  return response.data;
}
