import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const EMPTY_KNOWLEDGE = {
  id: null,
  title: "",
  content: "",
  tags: "",
  isActive: true,
};

export default function AIAgent() {
  const [settings, setSettings] = useState(null);
  const [knowledge, setKnowledge] = useState([]);
  const [liveVoices, setLiveVoices] = useState([]);
  const [entry, setEntry] = useState(EMPTY_KNOWLEDGE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [testInput, setTestInput] = useState("What services does your company provide?");
  const [testReply, setTestReply] = useState("");
  const [testBusy, setTestBusy] = useState(false);

  async function load() {
    const response = await api.get("/api/ai-agent");
    setSettings(response.data.settings);
    setKnowledge(response.data.knowledge || []);
    setLiveVoices(response.data.liveVoices || []);
  }

  useEffect(() => {
    load().catch((err) => setMessage(err.response?.data?.error || err.message));
  }, []);

  const activeKnowledge = useMemo(
    () => knowledge.filter((item) => item.is_active).length,
    [knowledge]
  );

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
    setMessage("");
  }

  async function saveSettings() {
    setBusy(true);
    setMessage("");
    try {
      const response = await api.post("/api/ai-agent/settings", settings);
      setSettings(response.data.settings);
      setMessage("AI agent settings saved. New calls will use this configuration.");
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || "Could not save AI settings.");
    } finally {
      setBusy(false);
    }
  }

  function editKnowledge(item) {
    setEntry({
      id: item.id,
      title: item.title,
      content: item.content,
      tags: (item.tags || []).join(", "),
      isActive: item.is_active,
    });
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  async function saveKnowledge() {
    if (!entry.title.trim() || !entry.content.trim()) {
      setMessage("Knowledge title and content are required.");
      return;
    }

    setBusy(true);
    setMessage("");
    const payload = {
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      isActive: entry.isActive,
    };

    try {
      if (entry.id) {
        await api.put(`/api/ai-agent/knowledge/${entry.id}`, payload);
      } else {
        await api.post("/api/ai-agent/knowledge", payload);
      }
      setEntry(EMPTY_KNOWLEDGE);
      await load();
      setMessage("Knowledge base updated.");
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || "Could not save knowledge.");
    } finally {
      setBusy(false);
    }
  }

  async function removeKnowledge(id) {
    if (!window.confirm("Delete this knowledge entry?")) return;
    setBusy(true);
    try {
      await api.delete(`/api/ai-agent/knowledge/${id}`);
      if (entry.id === id) setEntry(EMPTY_KNOWLEDGE);
      await load();
      setMessage("Knowledge entry deleted.");
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || "Could not delete knowledge.");
    } finally {
      setBusy(false);
    }
  }

  async function testAgent() {
    if (!testInput.trim()) return;
    setTestBusy(true);
    setTestReply("");
    setMessage("");
    try {
      const response = await api.post("/api/ai-agent/test", { message: testInput });
      setTestReply(response.data.reply);
    } catch (err) {
      setMessage(
        err.response?.data?.error ||
          err.message ||
          "The model could not answer the test message."
      );
    } finally {
      setTestBusy(false);
    }
  }

  if (!settings) {
    return <div className="card">Loading AI agent configuration…</div>;
  }

  return (
    <div>
      <div style={styles.header}>
        <div>
          <h1 style={{ marginBottom: 6 }}>AI Agent</h1>
          <p style={styles.muted}>
            Build the voice agent’s behaviour, model, language rules and company knowledge.
          </p>
        </div>
        <div style={styles.statusGroup}>
          <span style={styles.status}>{settings.enabled ? "Agent enabled" : "Agent disabled"}</span>
          <span style={styles.status}>{activeKnowledge} active knowledge entries</span>
        </div>
      </div>

      {message && <div style={styles.notice}>{message}</div>}

      <div className="card">
        <div style={styles.sectionHeading}>
          <div>
            <h3 style={styles.h3}>Voice AI engine</h3>
            <p style={styles.muted}>Choose the real-time native audio model or the resilient local pipeline.</p>
          </div>
          <label style={styles.switchLabel}>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => updateSetting("enabled", event.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div style={styles.engineGrid}>
          <button
            type="button"
            onClick={() => updateSetting("engine", "gemini_live")}
            style={{
              ...styles.engineCard,
              ...(settings.engine === "gemini_live" ? styles.engineCardActive : {}),
            }}
          >
            <strong>Gemini 3.1 Flash Live</strong>
            <span style={styles.engineText}>
              Native audio-to-audio, low latency, natural interruption handling and multilingual speech.
            </span>
            <span style={styles.tag}>Recommended for natural calls</span>
          </button>

          <button
            type="button"
            onClick={() => updateSetting("engine", "standard")}
            style={{
              ...styles.engineCard,
              ...(settings.engine === "standard" ? styles.engineCardActive : {}),
            }}
          >
            <strong>Standard resilient pipeline</strong>
            <span style={styles.engineText}>
              Local faster-whisper transcription, Gemini text reply and local Piper neural speech.
            </span>
            <span style={styles.tag}>Works without STT/TTS API quota</span>
          </button>
        </div>

        <div style={styles.grid}>
          <Field label="Text model">
            <select
              value={settings.textModel}
              onChange={(event) => updateSetting("textModel", event.target.value)}
              style={styles.control}
            >
              <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash-Lite — fast and economical</option>
              <option value="gemini-3.6-flash">Gemini 3.6 Flash — stronger reasoning</option>
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite — stable fallback</option>
            </select>
          </Field>

          <Field label="Live model">
            <input
              value={settings.liveModel}
              onChange={(event) => updateSetting("liveModel", event.target.value)}
              style={styles.control}
            />
          </Field>

          <Field label="Gemini Live voice">
            <select
              value={settings.liveVoice}
              onChange={(event) => updateSetting("liveVoice", event.target.value)}
              style={styles.control}
            >
              {liveVoices.map((voice) => (
                <option key={voice.id} value={voice.id}>{voice.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Thinking level">
            <select
              value={settings.thinkingLevel}
              onChange={(event) => updateSetting("thinkingLevel", event.target.value)}
              style={styles.control}
            >
              <option value="minimal">Minimal — lowest latency</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High — slower, deeper</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="card">
        <h3 style={styles.h3}>Prompt builder</h3>
        <p style={styles.muted}>
          These sections are assembled into the system instruction used for every AI call.
        </p>

        <div style={styles.grid}>
          <Field label="Agent name">
            <input value={settings.agentName} onChange={(e) => updateSetting("agentName", e.target.value)} style={styles.control} />
          </Field>
          <Field label="Company name">
            <input value={settings.companyName} onChange={(e) => updateSetting("companyName", e.target.value)} style={styles.control} />
          </Field>
          <Field label="Role">
            <input value={settings.role} onChange={(e) => updateSetting("role", e.target.value)} style={styles.control} />
          </Field>
          <Field label="Language behaviour">
            <select value={settings.languageMode} onChange={(e) => updateSetting("languageMode", e.target.value)} style={styles.control}>
              <option value="match_caller">Automatically reply in the caller’s language</option>
              <option value="english_only">English only</option>
            </select>
          </Field>
        </div>

        <PromptArea label="Objective" value={settings.objective} onChange={(value) => updateSetting("objective", value)} />
        <PromptArea label="Tone and speaking style" value={settings.tone} onChange={(value) => updateSetting("tone", value)} />
        <PromptArea label="Operating instructions" value={settings.instructions} onChange={(value) => updateSetting("instructions", value)} rows={5} />
        <PromptArea label="Guardrails and accuracy rules" value={settings.guardrails} onChange={(value) => updateSetting("guardrails", value)} rows={5} />
        <PromptArea label="Opening greeting" value={settings.greeting} onChange={(value) => updateSetting("greeting", value)} />
        <PromptArea label="AI unavailable fallback" value={settings.fallbackMessage} onChange={(value) => updateSetting("fallbackMessage", value)} />

        <div style={{ ...styles.grid, marginTop: 16 }}>
          <label style={styles.switchLabel}>
            <input
              type="checkbox"
              checked={settings.knowledgeEnabled}
              onChange={(event) => updateSetting("knowledgeEnabled", event.target.checked)}
            />
            Use company knowledge
          </label>
          <Field label="Maximum knowledge characters per request">
            <input
              type="number"
              min="1000"
              max="40000"
              step="1000"
              value={settings.maxKnowledgeChars}
              onChange={(event) => updateSetting("maxKnowledgeChars", Number(event.target.value))}
              style={styles.control}
            />
          </Field>
        </div>

        <button className="primary" disabled={busy} onClick={saveSettings} style={{ marginTop: 18 }}>
          {busy ? "Saving…" : "Save AI agent"}
        </button>
      </div>

      <div className="card">
        <h3 style={styles.h3}>Test the agent</h3>
        <p style={styles.muted}>Tests the saved prompt and relevant knowledge using the selected text model.</p>
        <textarea
          rows={3}
          value={testInput}
          onChange={(event) => setTestInput(event.target.value)}
          style={{ ...styles.control, resize: "vertical" }}
        />
        <button className="primary" disabled={testBusy} onClick={testAgent} style={{ marginTop: 10 }}>
          {testBusy ? "Generating…" : "Generate test response"}
        </button>
        {testReply && <div style={styles.testReply}>{testReply}</div>}
      </div>

      <div className="card">
        <div style={styles.sectionHeading}>
          <div>
            <h3 style={styles.h3}>Company knowledge base</h3>
            <p style={styles.muted}>Add policies, services, prices, FAQs and operating details the agent may use.</p>
          </div>
          <span style={styles.status}>{knowledge.length} total</span>
        </div>

        <div style={styles.knowledgeList}>
          {knowledge.length === 0 && <p style={styles.muted}>No knowledge entries yet.</p>}
          {knowledge.map((item) => (
            <div key={item.id} style={styles.knowledgeCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong>{item.title}</strong>
                  <span style={item.is_active ? styles.activePill : styles.inactivePill}>
                    {item.is_active ? "Active" : "Disabled"}
                  </span>
                </div>
                <p style={{ ...styles.muted, marginTop: 8, whiteSpace: "pre-wrap" }}>
                  {item.content.length > 240 ? `${item.content.slice(0, 240)}…` : item.content}
                </p>
                {(item.tags || []).length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {item.tags.map((tag) => <span key={tag} style={styles.tag}>{tag}</span>)}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => editKnowledge(item)}>Edit</button>
                <button onClick={() => removeKnowledge(item.id)} style={{ color: "#b42318" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={styles.h3}>{entry.id ? "Edit knowledge entry" : "Add knowledge entry"}</h3>
        <div style={styles.grid}>
          <Field label="Title">
            <input value={entry.title} onChange={(e) => setEntry({ ...entry, title: e.target.value })} style={styles.control} placeholder="Example: Service pricing" />
          </Field>
          <Field label="Tags (comma separated)">
            <input value={entry.tags} onChange={(e) => setEntry({ ...entry, tags: e.target.value })} style={styles.control} placeholder="pricing, services, support" />
          </Field>
        </div>
        <Field label="Knowledge content">
          <textarea
            rows={9}
            value={entry.content}
            onChange={(e) => setEntry({ ...entry, content: e.target.value })}
            style={{ ...styles.control, resize: "vertical", lineHeight: 1.55 }}
            placeholder="Write complete, factual information the agent may quote or explain."
          />
        </Field>
        <label style={{ ...styles.switchLabel, marginTop: 12 }}>
          <input type="checkbox" checked={entry.isActive} onChange={(e) => setEntry({ ...entry, isActive: e.target.checked })} />
          Active and available to the AI agent
        </label>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="primary" disabled={busy} onClick={saveKnowledge}>
            {entry.id ? "Update entry" : "Add to knowledge base"}
          </button>
          {entry.id && <button onClick={() => setEntry(EMPTY_KNOWLEDGE)}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={styles.field}><span>{label}</span>{children}</label>;
}

function PromptArea({ label, value, onChange, rows = 3 }) {
  return (
    <Field label={label}>
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ ...styles.control, resize: "vertical", lineHeight: 1.55 }}
      />
    </Field>
  );
}

const styles = {
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 18, flexWrap: "wrap" },
  statusGroup: { display: "flex", gap: 8, flexWrap: "wrap" },
  status: { background: "#f2f4f7", color: "#344054", borderRadius: 999, padding: "7px 11px", fontSize: 12, fontWeight: 700 },
  notice: { background: "#eff6ff", color: "#1d4ed8", padding: "11px 13px", borderRadius: 10, marginBottom: 16, fontSize: 13 },
  h3: { marginTop: 0, marginBottom: 6 },
  muted: { color: "#667085", fontSize: 13, lineHeight: 1.5, margin: 0 },
  sectionHeading: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap" },
  engineGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12, margin: "18px 0" },
  engineCard: { textAlign: "left", display: "grid", gap: 8, padding: 18, border: "1px solid #d0d5dd", borderRadius: 14, background: "#fff", cursor: "pointer", color: "#101828" },
  engineCardActive: { border: "2px solid #0738F9", background: "#f5f7ff", boxShadow: "0 0 0 3px rgba(7,56,249,.08)" },
  engineText: { fontSize: 13, lineHeight: 1.5, color: "#667085", fontWeight: 400 },
  tag: { display: "inline-flex", width: "fit-content", background: "#f2f4f7", color: "#475467", borderRadius: 999, padding: "4px 8px", fontSize: 11, fontWeight: 700 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginTop: 14 },
  field: { display: "grid", gap: 7, color: "#344054", fontSize: 13, fontWeight: 700, marginTop: 14 },
  control: { width: "100%", boxSizing: "border-box", border: "1px solid #d0d5dd", borderRadius: 10, padding: "10px 12px", background: "#fff", color: "#101828", font: "inherit", minHeight: 42 },
  switchLabel: { display: "inline-flex", alignItems: "center", gap: 8, color: "#344054", fontSize: 13, fontWeight: 700 },
  testReply: { marginTop: 14, padding: 15, borderRadius: 12, background: "#f8fafc", color: "#1f2937", whiteSpace: "pre-wrap", lineHeight: 1.55 },
  knowledgeList: { display: "grid", gap: 10, marginTop: 18 },
  knowledgeCard: { display: "flex", justifyContent: "space-between", gap: 16, padding: 16, border: "1px solid #e4e7ec", borderRadius: 12, alignItems: "flex-start", flexWrap: "wrap" },
  activePill: { background: "#ecfdf3", color: "#027a48", borderRadius: 999, padding: "3px 7px", fontSize: 11, fontWeight: 700 },
  inactivePill: { background: "#f2f4f7", color: "#667085", borderRadius: 999, padding: "3px 7px", fontSize: 11, fontWeight: 700 },
};
