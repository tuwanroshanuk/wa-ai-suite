import { useEffect, useRef, useState } from "react";
import { api, API_URL } from "../api";
import { getSocket } from "../socket";

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [waId, setWaId] = useState("");
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState(false);
  // callId -> ms remaining before it auto-routes to the bot
  const [ringing, setRinging] = useState({});
  const tickRef = useRef(null);

  function load() {
    api.get("/api/calls").then((r) => setCalls(r.data));
  }

  useEffect(() => {
    load();
    // Live updates come over the socket now; keep a slow poll as a fallback
    // in case a socket event is ever missed.
    const i = setInterval(load, 15000);

    const socket = getSocket();

    function onIncoming(payload) {
      setRinging((prev) => ({
        ...prev,
        [payload.id]: { ...payload, deadline: Date.now() + payload.ringTimeoutMs },
      }));
      load();
    }

    function onUpdated(payload) {
      setRinging((prev) => {
        if (!(payload.id in prev)) return prev;
        const next = { ...prev };
        delete next[payload.id];
        return next;
      });
      load();
    }

    socket.on("call:incoming", onIncoming);
    socket.on("call:updated", onUpdated);

    return () => {
      clearInterval(i);
      socket.off("call:incoming", onIncoming);
      socket.off("call:updated", onUpdated);
    };
  }, []);

  // Re-render every second so the countdown on ringing calls ticks down.
  useEffect(() => {
    tickRef.current = setInterval(() => setRinging((r) => ({ ...r })), 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  async function requestPermission() {
    if (!waId) return;
    setRequestError("");
    setRequesting(true);
    try {
      await api.post("/api/calls/request-permission", { waId });
      alert("Permission request sent to customer via WhatsApp template.");
      setWaId("");
    } catch (err) {
      setRequestError(
        err.response?.data?.error?.toString() ||
          err.message ||
          "Failed to send permission request."
      );
    } finally {
      setRequesting(false);
    }
  }

  async function answerCall(callId) {
    try {
      await api.post(`/api/calls/${callId}/answer`, {});
      setRinging((prev) => {
        const next = { ...prev };
        delete next[callId];
        return next;
      });
      load();
    } catch (err) {
      alert(err.response?.data?.error || err.message || "Could not answer the call.");
    }
  }

  async function takeOver(call) {
    await api.post(`/api/calls/${call.id}/take-over`, {});
    alert(
      "Marked as agent-handled. Browser audio bridging is a follow-up build step (see backend/src/routes/calls.js)."
    );
  }

  const ringingList = Object.values(ringing);

  return (
    <div>
      <h1>Calls</h1>

      {ringingList.map((r) => {
        const secondsLeft = Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
        return (
          <div
            key={r.id}
            className="card"
            style={{ borderLeft: "4px solid #25d366", display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <div>
              <strong>Incoming call</strong> from {r.contact?.name || r.contact?.wa_id}
              <div style={{ fontSize: 13, color: "#666" }}>
                Routes to the AI bot in {secondsLeft}s if no one answers.
              </div>
            </div>
            <button className="primary" onClick={() => answerCall(r.id)}>
              Answer
            </button>
          </div>
        );
      })}

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
          <button className="primary" onClick={requestPermission} disabled={requesting}>
            {requesting ? "Sending..." : "Request"}
          </button>
        </div>
        {requestError && (
          <p style={{ color: "#b91c1c", fontSize: 13, marginTop: -4 }}>{requestError}</p>
        )}
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
                  {c.status === "ringing" && (
                    <button className="primary" onClick={() => answerCall(c.id)}>Answer</button>
                  )}
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
