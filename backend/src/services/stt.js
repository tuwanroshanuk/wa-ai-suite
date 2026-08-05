import axios from "axios";

const STT_SERVICE_URL = process.env.STT_SERVICE_URL || "http://stt-service:7000";

export async function transcribeAudio(audio, contentType = "audio/wav") {
  if (!audio?.length) return "";
  const response = await axios.post(`${STT_SERVICE_URL}/transcribe`, audio, {
    headers: { "Content-Type": contentType },
    responseType: "json",
    timeout: Number(process.env.STT_TIMEOUT_MS || 45000),
    maxBodyLength: 25 * 1024 * 1024,
  });
  return String(response.data?.text || "").trim();
}
