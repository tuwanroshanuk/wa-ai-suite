import axios from "axios";

const TTS_URL = process.env.TTS_SERVICE_URL || "http://tts-service:6000";

// Returns an mp3 Buffer for the given text.
export async function synthesize(text, voice) {
  const { data } = await axios.post(
    `${TTS_URL}/speak`,
    { text, voice: voice || process.env.TTS_DEFAULT_VOICE },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(data);
}

// Returns a readable stream of mp3 chunks for lower-latency playback during live calls.
export async function synthesizeStream(text, voice) {
  const response = await axios.post(
    `${TTS_URL}/speak-stream`,
    { text, voice: voice || process.env.TTS_DEFAULT_VOICE },
    { responseType: "stream" }
  );
  return response.data; // a Node readable stream
}
