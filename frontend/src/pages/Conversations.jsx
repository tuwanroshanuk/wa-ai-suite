import { useEffect, useState } from "react";
import { api } from "../api";

export default function Conversations() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");

  function loadConversations() {
    api.get("/api/conversations").then((r) => setConversations(r.data));
  }

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!activeId) return;
    api.get(`/api/conversations/${activeId}/messages`).then((r) => setMessages(r.data));
  }, [activeId]);

  async function sendReply() {
    if (!draft.trim()) return;
    await api.post(`/api/conversations/${activeId}/reply`, { text: draft });
    setDraft("");
    const r = await api.get(`/api/conversations/${activeId}/messages`);
    setMessages(r.data);
  }

  async function toggleBot(conv, enabled) {
    await api.post(`/api/conversations/${conv.id}/toggle-bot`, { enabled });
    loadConversations();
  }

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div className="conv-list">
      <div className="conv-sidebar card">
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`conv-item ${c.id === activeId ? "active" : ""}`}
            onClick={() => setActiveId(c.id)}
          >
            <strong>{c.contact_name || c.wa_id}</strong>
            <div style={{ fontSize: 12, color: "#666" }}>{c.status}</div>
          </div>
        ))}
      </div>

      <div className="chat-window card">
        {active ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <strong>{active.contact_name || active.wa_id}</strong>
              <label style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  defaultChecked
                  onChange={(e) => toggleBot(active, e.target.checked)}
                  style={{ width: "auto", marginRight: 6 }}
                />
                Bot enabled
              </label>
            </div>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.direction}`}>
                  <div>{m.body}</div>
                  <div style={{ fontSize: 10, color: "#888" }}>{m.sender}</div>
                </div>
              ))}
            </div>
            <div className="row">
              <input
                placeholder="Type a reply..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendReply()}
              />
              <button className="primary" onClick={sendReply}>Send</button>
            </div>
          </>
        ) : (
          <p style={{ color: "#888" }}>Select a conversation</p>
        )}
      </div>
    </div>
  );
}
