import axios from "axios";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const AUDIO_MODEL = process.env.GEMINI_AUDIO_MODEL || MODEL;

function assertConfigured() {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not configured");
}

function extractText(data, fallback = "") {
  return (
    data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || fallback
  ).trim();
}

export async function generateReply(history, systemPrompt) {
  assertConfigured();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const contents = history.map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.text }],
  }));

  const body = {
    contents,
    ...(systemPrompt
      ? { systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: { temperature: 0.55, maxOutputTokens: 300 },
  };

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  return extractText(data, "Sorry, I couldn't come up with a response.");
}

export async function transcribeAudio(audioBuffer, mimeType = "audio/wav") {
  assertConfigured();
  if (!audioBuffer?.length) return "";

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
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 180,
    },
  };

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  const transcript = extractText(data);
  if (!transcript || /^\[?NO[_ ]SPEECH\]?$/i.test(transcript)) return "";
  return transcript;
}
