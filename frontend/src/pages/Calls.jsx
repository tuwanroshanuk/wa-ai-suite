import { useEffect, useState } from "react";
import { api, API_URL } from "../api";

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [waId, setWaId] = useState("");

  function load() {
    api.get("/api/calls").then((r) => setCalls(r.data));
  }

  useEffect(() => {
    load();
    const i = setInterval(load, 5000);
    return () => clearInterval(i);
  }, []);

  async function requestPermission() {
    if (!waId) return;
    await api.post("/api/calls/request-permission", { waId });
    alert("Permission request sent to customer via WhatsApp template.");
  }

  async function takeOver(call) {
    await api.post(`/api/calls/${call.id}/take-over`, {});
    alert(
      "Marked as agent-handled. Browser audio bridging is a follow-up build step (see backend/src/routes/calls.js)."
    );
  }

  return (
    <div>
      <h1>Calls</h1>

      <div className="card">
        <h3>Request outbound call permission</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          WhatsApp requires customer consent before your business can call them.
          This sends the approved call-permission template.
        </p>
        <div className="row">
          <input
            placeholder="Customer WhatsApp number (e.g. 15551234567)"
            value={waId}
            onChange={(e) => setWaId(e.target.value)}
          />
          <button className="primary" onClick={requestPermission}>Request</button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Contact</th><th>Direction</th><th>Handled by</th><th>Status</th><th>Started</th><th>Recording</th><th></th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td>{c.contact_name || c.wa_id}</td>
                <td>{c.direction}</td>
                <td>{c.handled_by}</td>
                <td>{c.status}</td>
                <td>{new Date(c.started_at).toLocaleString()}</td>
                <td>
                  {c.recording_path ? (
                    <audio controls src={`${API_URL}/api/calls/${c.id}/recording`} style={{ height: 30 }} />
                  ) : (
                    "-"
                  )}
                </td>
                <td>
                  {c.status === "connected" && (
                    <button className="secondary" onClick={() => takeOver(c)}>Take over (browser)</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
