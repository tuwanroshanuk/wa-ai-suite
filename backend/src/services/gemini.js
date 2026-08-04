import axios from "axios";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

/**
 * Sends conversation history to Gemini and returns the assistant's reply text.
 * history: [{ role: 'user'|'model', text: string }]
 */
export async function generateReply(history, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const contents = history.map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text }],
  }));

  const body = {
    contents,
    ...(systemPrompt
      ? { systemInstruction: { role: "system", parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: { temperature: 0.6, maxOutputTokens: 400 },
  };

  const { data } = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
  });

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "Sorry, I couldn't come up with a response.";
  return text.trim();
}
