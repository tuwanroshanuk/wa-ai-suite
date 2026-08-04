import { useEffect, useState } from "react";
import { api } from "../api";

export default function Dashboard() {
  const [conversations, setConversations] = useState([]);
  const [calls, setCalls] = useState([]);

  useEffect(() => {
    api.get("/api/conversations").then((r) => setConversations(r.data));
    api.get("/api/calls").then((r) => setCalls(r.data));
  }, []);

  const open = conversations.filter((c) => c.status === "open").length;
  const pending = conversations.filter((c) => c.status === "pending").length;
  const activeCalls = calls.filter((c) => c.status === "connected").length;

  return (
    <div>
      <h1>Overview</h1>
      <div className="row" style={{ gap: 16 }}>
        <div className="card" style={{ flex: 1 }}>
          <h3>Open conversations</h3>
          <p style={{ fontSize: 32, margin: 0 }}>{open}</p>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h3>Waiting for agent</h3>
          <p style={{ fontSize: 32, margin: 0 }}>{pending}</p>
        </div>
        <div className="card" style={{ flex: 1 }}>
          <h3>Live calls</h3>
          <p style={{ fontSize: 32, margin: 0 }}>{activeCalls}</p>
        </div>
      </div>

      <div className="card">
        <h3>Recent conversations</h3>
        <table>
          <thead>
            <tr><th>Contact</th><th>Status</th><th>Last message</th></tr>
          </thead>
          <tbody>
            {conversations.slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td>{c.contact_name || c.wa_id}</td>
                <td>{c.status}</td>
                <td>{new Date(c.last_message_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
