import WebSocket from "ws";

const API_KEY = process.env.GEMINI_API_KEY;
const WS_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function parseMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch (err) {
    console.warn("[gemini-live] invalid server message", err.message);
    return null;
  }
}

function cleanTranscript(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export async function createGeminiLiveSession({
  model = "gemini-3.1-flash-live-preview",
  voice = "Kore",
  thinkingLevel = "minimal",
  systemPrompt,
  onAudio,
  onInputTranscript,
  onOutputTranscript,
  onInterrupted,
  onError,
  onClose,
}) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not configured");

  const url = `${WS_ENDPOINT}?key=${encodeURIComponent(API_KEY)}`;
  const ws = new WebSocket(url, {
    handshakeTimeout: Number(process.env.GEMINI_LIVE_CONNECT_TIMEOUT_MS || 15000),
  });

  let ready = false;
  let closed = false;
  let inputBuffer = "";
  let outputBuffer = "";
  const pending = [];

  const setupPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Gemini Live setup timed out")),
      Number(process.env.GEMINI_LIVE_SETUP_TIMEOUT_MS || 20000)
    );

    ws.once("open", () => {
      const setup = {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice },
              },
            },
            thinkingConfig: { thinkingLevel },
          },
          systemInstruction: {
            parts: [{ text: systemPrompt || "You are a helpful voice assistant." }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              prefixPaddingMs: 120,
              silenceDurationMs: 450,
            },
          },
          contextWindowCompression: {
            triggerTokens: "25000",
            slidingWindow: { targetTokens: "8000" },
          },
        },
      };
      ws.send(JSON.stringify(setup));
    });

    ws.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message) return;

      if (message.setupComplete) {
        clearTimeout(timeout);
        ready = true;
        for (const item of pending.splice(0)) ws.send(item);
        resolve();
        return;
      }

      const serverContent = message.serverContent;
      if (serverContent) {
        const parts = serverContent.modelTurn?.parts || [];
        for (const part of parts) {
          const inline = part.inlineData || part.inline_data;
          if (inline?.data) {
            try {
              onAudio?.(Buffer.from(inline.data, "base64"), inline.mimeType || inline.mime_type);
            } catch (err) {
              onError?.(err);
            }
          }
        }

        const inputText = cleanTranscript(
          serverContent.inputTranscription?.text || serverContent.input_transcription?.text
        );
        if (inputText) inputBuffer = `${inputBuffer} ${inputText}`.trim();

        const outputText = cleanTranscript(
          serverContent.outputTranscription?.text || serverContent.output_transcription?.text
        );
        if (outputText) outputBuffer = `${outputBuffer} ${outputText}`.trim();

        if (serverContent.interrupted) {
          outputBuffer = "";
          onInterrupted?.();
        }

        if (serverContent.turnComplete || serverContent.turn_complete) {
          if (inputBuffer) onInputTranscript?.(cleanTranscript(inputBuffer));
          if (outputBuffer) onOutputTranscript?.(cleanTranscript(outputBuffer));
          inputBuffer = "";
          outputBuffer = "";
        }
      }

      if (message.goAway) {
        console.warn("[gemini-live] server requested reconnect", message.goAway);
      }
    });

    ws.once("error", (err) => {
      clearTimeout(timeout);
      if (!ready) reject(err);
      onError?.(err);
    });

    ws.once("close", (code, reason) => {
      clearTimeout(timeout);
      closed = true;
      const detail = reason?.toString?.() || "";
      if (!ready) reject(new Error(`Gemini Live closed during setup (${code}): ${detail}`));
      onClose?.({ code, reason: detail });
    });
  });

  await setupPromise;

  function send(payload) {
    if (closed) return false;
    const encoded = JSON.stringify(payload);
    if (!ready || ws.readyState !== WebSocket.OPEN) {
      pending.push(encoded);
      return true;
    }
    ws.send(encoded);
    return true;
  }

  return {
    model,
    voice,
    sendAudio(pcm16k) {
      if (!pcm16k?.length) return false;
      return send({
        realtimeInput: {
          audio: {
            data: pcm16k.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      });
    },
    sendText(text) {
      const value = String(text || "").trim();
      if (!value) return false;
      return send({ realtimeInput: { text: value } });
    },
    close() {
      if (closed) return;
      closed = true;
      try { ws.close(1000, "call ended"); } catch (_) {}
    },
  };
}
