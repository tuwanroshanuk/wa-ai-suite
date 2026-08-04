import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";

const DEFAULT_PREVIEW =
  "Hello. Thanks for calling Nexus Support. This is a preview of your selected assistant voice.";

export default function Settings() {
  const [assets, setAssets] = useState([]);
  const [name, setName] = useState("");
  const [file, setFile] = useState(null);

  const [voiceCatalog, setVoiceCatalog] = useState([]);
  const [voiceSettings, setVoiceSettings] = useState({
    provider: "piper",
    voice: "en_US-lessac-medium",
    speed: 1,
  });
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW);
  const [previewUrl, setPreviewUrl] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState("");
  const previewAudioRef = useRef(null);

  const selectedKey = `${voiceSettings.provider}:${voiceSettings.voice}`;
  const selectedVoice = useMemo(
    () =>
      voiceCatalog.find(
        (voice) => `${voice.provider}:${voice.id}` === selectedKey
      ),
    [selectedKey, voiceCatalog]
  );

  async function load() {
    const [audioResponse, voiceResponse] = await Promise.all([
      api.get("/api/audio"),
      api.get("/api/voice-settings"),
    ]);
    setAssets(audioResponse.data);
    setVoiceSettings(voiceResponse.data.settings);
    setVoiceCatalog(voiceResponse.data.catalog?.voices || []);
  }

  useEffect(() => {
    load().catch((err) => {
      setVoiceMessage(err.response?.data?.error || err.message || "Could not load settings.");
    });
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function upload() {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("name", name || file.name);
    await api.post("/api/audio", form, { headers: { "Content-Type": "multipart/form-data" } });
    setName("");
    setFile(null);
    await load();
  }

  function chooseVoice(event) {
    const [provider, ...voiceParts] = event.target.value.split(":");
    setVoiceSettings((current) => ({
      ...current,
      provider,
      voice: voiceParts.join(":"),
    }));
    setVoiceMessage("");
  }

  async function saveVoice() {
    setVoiceBusy(true);
    setVoiceMessage("");
    try {
      const response = await api.post("/api/voice-settings", voiceSettings);
      setVoiceSettings(response.data.settings);
      setVoiceMessage("Voice settings saved. New call prompts will use this voice.");
    } catch (err) {
      setVoiceMessage(err.response?.data?.error || err.message || "Could not save voice settings.");
    } finally {
      setVoiceBusy(false);
    }
  }

  async function previewVoice() {
    setVoiceBusy(true);
    setVoiceMessage("Generating local preview…");
    try {
      const response = await api.post(
        "/api/voice-settings/preview",
        { ...voiceSettings, text: previewText },
        { responseType: "blob" }
      );
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const url = URL.createObjectURL(response.data);
      setPreviewUrl(url);
      setVoiceMessage(
        `Preview ready · ${selectedVoice?.label || voiceSettings.voice} · ${voiceSettings.speed.toFixed(2)}×`
      );
      window.setTimeout(() => previewAudioRef.current?.play().catch(() => {}), 0);
    } catch (err) {
      let detail = err.message || "Could not generate preview.";
      if (err.response?.data instanceof Blob) {
        try {
          const parsed = JSON.parse(await err.response.data.text());
          detail = parsed.error || detail;
        } catch (_) {}
      } else if (err.response?.data?.error) {
        detail = err.response.data.error;
      }
      setVoiceMessage(detail);
    } finally {
      setVoiceBusy(false);
    }
  }

  return (
    <div>
      <h1>Settings</h1>

      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
          <div>
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Call assistant voice</h3>
            <p style={{ fontSize: 13, color: "#667085", margin: 0 }}>
              Select a fully local Piper neural voice. It is used for AI replies,
              decline reasons, transfers, greetings and in-call prompts.
            </p>
          </div>
          <span style={styles.badge}>Local neural TTS</span>
        </div>

        <div style={styles.voiceGrid}>
          <label style={styles.label}>
            Voice
            <select value={selectedKey} onChange={chooseVoice} style={styles.control}>
              {voiceCatalog.map((voice) => (
                <option key={`${voice.provider}:${voice.id}`} value={`${voice.provider}:${voice.id}`}>
                  {voice.label || voice.name || voice.id}
                  {voice.provider === "espeak" ? " (fallback)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label style={styles.label}>
            Speaking speed
            <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 42 }}>
              <input
                type="range"
                min="0.70"
                max="1.35"
                step="0.05"
                value={voiceSettings.speed}
                onChange={(event) =>
                  setVoiceSettings((current) => ({
                    ...current,
                    speed: Number(event.target.value),
                  }))
                }
                style={{ flex: 1 }}
              />
              <strong style={{ minWidth: 48 }}>{voiceSettings.speed.toFixed(2)}×</strong>
            </div>
          </label>
        </div>

        <label style={{ ...styles.label, marginTop: 14 }}>
          Preview text
          <textarea
            value={previewText}
            onChange={(event) => setPreviewText(event.target.value)}
            rows={3}
            maxLength={500}
            style={{ ...styles.control, resize: "vertical", lineHeight: 1.5 }}
          />
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <button className="primary" disabled={voiceBusy || !voiceCatalog.length} onClick={previewVoice}>
            {voiceBusy ? "Working…" : "Preview voice"}
          </button>
          <button disabled={voiceBusy || !voiceCatalog.length} onClick={saveVoice}>
            Save voice
          </button>
        </div>

        {previewUrl && (
          <audio
            ref={previewAudioRef}
            src={previewUrl}
            controls
            preload="auto"
            style={{ width: "100%", marginTop: 16 }}
          />
        )}

        {voiceMessage && (
          <div style={styles.message}>{voiceMessage}</div>
        )}

        <p style={{ fontSize: 12, color: "#667085", margin: "14px 0 0" }}>
          Piper voices run inside your own TTS container. The eSpeak option is retained only as an emergency fallback.
        </p>
      </div>

      <div className="card">
        <h3>Audio library (free pre-recorded clips)</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          Upload greeting or menu audio files here, then reference their ID in
          the “Play audio clip” node inside the Bot Flow builder.
        </p>
        <input placeholder="Clip name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="file" accept="audio/*" onChange={(e) => setFile(e.target.files[0])} />
        <button className="primary" onClick={upload}>Upload</button>

        <table style={{ marginTop: 16 }}>
          <thead><tr><th>ID</th><th>Name</th></tr></thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={asset.id}><td>{asset.id}</td><td>{asset.name}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Credentials and AI provider</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          WhatsApp and Gemini credentials remain server-side environment variables.
          Live speech transcription now runs locally with faster-whisper and does
          not consume Gemini quota. Gemini is used only to generate the bot’s reply text.
        </p>
      </div>
    </div>
  );
}

const styles = {
  badge: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "6px 10px",
    background: "#ecfdf3",
    color: "#027a48",
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  voiceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 16,
    marginTop: 20,
  },
  label: {
    display: "grid",
    gap: 7,
    color: "#344054",
    fontSize: 13,
    fontWeight: 700,
  },
  control: {
    width: "100%",
    minHeight: 42,
    border: "1px solid #d0d5dd",
    borderRadius: 10,
    padding: "10px 12px",
    background: "#fff",
    color: "#101828",
    font: "inherit",
    boxSizing: "border-box",
  },
  message: {
    marginTop: 14,
    borderRadius: 10,
    padding: "10px 12px",
    background: "#f2f4f7",
    color: "#344054",
    fontSize: 13,
  },
};
