import axios from "axios";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL || MODEL;
const STT_URL = process.env.STT_SERVICE_URL || "http://stt-service:7000";
const STT_PROVIDER = String(process.env.STT_PROVIDER || "local").trim().toLowerCase();

function assertGeminiConfigured() {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not configured");
}

function extractText(data, fallback = "") {
  return (
    data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || fallback
  ).trim();
}

export async function generateReply(history, systemPrompt, options = {}) {
  assertGeminiConfigured();
  const model = String(options.model || MODEL).trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;

  const contents = history.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.text }],
  }));

  const body = {
    contents,
    ...(systemPrompt
      ? { systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: { maxOutputTokens: Number(options.maxOutputTokens || 300) },
  };

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: Number(options.timeoutMs || 30000),
  });

  return extractText(data, "Sorry, I couldn't come up with a response.");
}

async function transcribeLocally(audioBuffer, mimeType) {
  const { data } = await axios.post(`${STT_URL}/transcribe`, audioBuffer, {
    headers: { "Content-Type": mimeType || "audio/wav" },
    timeout: 120000,
    maxContentLength: 25 * 1024 * 1024,
    maxBodyLength: 25 * 1024 * 1024,
  });
  return String(data?.text || "").trim();
}

async function transcribeWithGemini(audioBuffer, mimeType) {
  assertGeminiConfigured();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AUDIO_MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBuffer.toString("base64"),
            },
          },
          {
            text:
              "Transcribe only the human speech in this short phone-call audio. " +
              "Return only the exact spoken words, without labels, timestamps, markdown, or explanation. " +
              "Preserve the speaker's language. If there is no intelligible speech, return exactly [NO_SPEECH].",
          },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 180 },
  };

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const transcript = extractText(data);
  if (!transcript || /^\[?NO[_ ]SPEECH\]?$/i.test(transcript)) return "";
  return transcript;
}

export async function transcribeAudio(audioBuffer, mimeType = "audio/wav") {
  if (!audioBuffer?.length) return "";

  if (STT_PROVIDER === "gemini") {
    return transcribeWithGemini(audioBuffer, mimeType);
  }

  if (STT_PROVIDER === "auto") {
    try {
      return await transcribeLocally(audioBuffer, mimeType);
    } catch (err) {
      console.warn("[stt] local service failed; falling back to Gemini", err.message);
      return transcribeWithGemini(audioBuffer, mimeType);
    }
  }

  return transcribeLocally(audioBuffer, mimeType);
}
