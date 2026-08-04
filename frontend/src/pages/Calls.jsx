import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getSocket } from "../socket";

function RecordingPlayer({ callId }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  async function loadRecording() {
    setLoading(true);
    setError("");
    try {
      const response = await api.get(`/api/calls/${callId}/recording`, {
        responseType: "blob",
      });
      if (url) URL.revokeObjectURL(url);
      setUrl(URL.createObjectURL(response.data));
    } catch (err) {
      setError(
        err.response?.status === 404
          ? "Recording file is unavailable."
          : err.response?.data?.error || err.message || "Could not load recording."
      );
    } finally {
      setLoading(false);
    }
  }

  if (url) {
    return <audio controls src={url} preload="metadata" style={{ width: 220, height: 34 }} />;
  }

  return (
    <div>
      <button onClick={loadRecording} disabled={loading}>
        {loading ? "Loading…" : "Play recording"}
      </button>
      {error && <div style={{ fontSize: 11, color: "#b42318", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

export default function Calls() {
  const [calls, setCalls] = useState([]);
  const [waId, setWaId] = useState("");
  const [requestError, setRequestError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [ringing, setRinging] = useState({});
  const tickRef = useRef(null);

  async function load() {
    try {
      const response = await api.get("/api/calls");
      setCalls(response.data);
    } catch (err) {
      console.warn("[calls] list refresh failed", err.message);
    }
  }

  useEffect(() => {
    load();
    const poll = setInterval(load, 15000);
    const socket = getSocket();

    function onIncoming(payload) {
      const deadline = payload.autoTransferAt
        ? new Date(payload.autoTransferAt).getTime()
        : Date.now() + Number(payload.ringTimeoutMs || 15000);
      setRinging((previous) => ({
        ...previous,
        [payload.id]: { ...payload, deadline },
      }));
      load();
    }

    function onUpdated(payload) {
      setRinging((previous) => {
        if (!(payload.id in previous)) return previous;
        const next = { ...previous };
        delete next[payload.id];
        return next;
      });
      load();
    }

    socket.on("call:incoming", onIncoming);
    socket.on("call:updated", onUpdated);

    return () => {
      clearInterval(poll);
      socket.off("call:incoming", onIncoming);
      socket.off("call:updated", onUpdated);
    };
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => setRinging((value) => ({ ...value })), 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  async function requestPermission() {
    if (!waId) return;
    setRequestError("");
    setRequesting(true);
    try {
      await api.post("/api/calls/request-permission", { waId });
      alert("Permission request sent to the customer.");
      setWaId("");
    } catch (err) {
      setRequestError(
        err.response?.data?.error?.toString() || err.message || "Failed to send permission request."
      );
    } finally {
      setRequesting(false);
    }
  }

  const ringingList = Object.values(ringing);

  return (
    <div>
      <h1>Calls</h1>

      {ringingList.map((call) => {
        const secondsLeft = Math.max(0, Math.ceil((call.deadline - Date.now()) / 1000));
        return (
          <div
            key={call.id}
            className="card"
            style={{
              borderLeft: "4px solid #25d366",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div>
              <strong>Incoming call</strong> from {call.contact?.name || call.contact?.wa_id}
              <div style={{ fontSize: 13, color: "#666" }}>
                The global call dialog handles microphone answering. Automatically transfers to AI in {secondsLeft}s.
              </div>
            </div>
          </div>
        );
      })}

      <div className="card">
        <h3>Request outbound call permission</h3>
        <p style={{ fontSize: 13, color: "#666" }}>
          WhatsApp requires customer consent before your business can call them.
        </p>
        <div className="row">
          <input
            placeholder="Customer WhatsApp number (e.g. 15551234567)"
            value={waId}
            onChange={(event) => setWaId(event.target.value)}
          />
          <button className="primary" onClick={requestPermission} disabled={requesting}>
            {requesting ? "Sending…" : "Request"}
          </button>
        </div>
        {requestError && (
          <p style={{ color: "#b91c1c", fontSize: 13, marginTop: -4 }}>{requestError}</p>
        )}
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Direction</th>
              <th>Handled by</th>
              <th>Status</th>
              <th>Started</th>
              <th>Transcript</th>
              <th>Recording</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.id}>
                <td>{call.contact_name || call.wa_id}</td>
                <td>{call.direction}</td>
                <td>{call.handled_by}</td>
                <td>{call.status}</td>
                <td>{new Date(call.started_at).toLocaleString()}</td>
                <td>{Array.isArray(call.transcript) ? `${call.transcript.length} entries` : "0 entries"}</td>
                <td>
                  {call.recording_path ? <RecordingPlayer callId={call.id} /> : "Not available"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
