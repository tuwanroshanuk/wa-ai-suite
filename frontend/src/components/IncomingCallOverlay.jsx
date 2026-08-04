import { useEffect, useState } from "react";
import { api } from "../api";
import { getSocket } from "../socket";

export default function IncomingCallOverlay() {
  const [incoming, setIncoming] = useState(null);
  const [busy, setBusy] = useState(false);

  async function loadActiveCall() {
    try {
      const response = await api.get("/api/calls/active");
      setIncoming(response.data || null);
    } catch (err) {
      // CORS/network errors are logged once by the browser. Keep the existing
      // realtime popup instead of clearing it during a temporary reconnect.
      console.warn("[calls] could not recover active call", err.message);
    }
  }

  useEffect(() => {
    const socket = getSocket();

    const onIncoming = (payload) => {
      setIncoming(payload);
      try {
        const audio = new Audio(
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        );
        audio.play().catch(() => {});
      } catch (_) {}
    };

    const onUpdated = (payload) => {
      setIncoming((current) => (current?.id === payload.id ? null : current));
    };

    const onConnect = () => {
      loadActiveCall();
    };

    socket.on("connect", onConnect);
    socket.on("call:incoming", onIncoming);
    socket.on("call:updated", onUpdated);

    // Recover a call that began while the page was refreshing or while
    // Socket.IO was reconnecting.
    loadActiveCall();

    return () => {
      socket.off("connect", onConnect);
      socket.off("call:incoming", onIncoming);
      socket.off("call:updated", onUpdated);
    };
  }, []);

  if (!incoming) return null;

  async function answer() {
    setBusy(true);
    try {
      await api.post(`/api/calls/${incoming.id}/answer`, {});
      setIncoming(null);
    } catch (err) {
      if (err.response?.status === 409 || err.response?.status === 404) {
        // The call ended or was handled while this tab was reconnecting.
        setIncoming(null);
        await loadActiveCall();
        return;
      }
      alert(err.response?.data?.error || err.message || "Could not answer the call.");
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api.post(`/api/calls/${incoming.id}/decline`, {});
      setIncoming(null);
    } catch (err) {
      if (err.response?.status === 409 || err.response?.status === 404) {
        setIncoming(null);
        await loadActiveCall();
        return;
      }
      alert(err.response?.data?.error || err.message || "Could not decline the call.");
    } finally {
      setBusy(false);
    }
  }

  const label = incoming.contact?.name || incoming.contact?.wa_id || "WhatsApp customer";

  return (
    <div style={styles.backdrop}>
      <div style={styles.dialog} role="dialog" aria-modal="true" aria-label="Incoming WhatsApp call">
        <div style={styles.icon}>☎</div>
        <div style={{ fontSize: 13, color: "#667085", marginBottom: 5 }}>Incoming WhatsApp call</div>
        <h2 style={{ margin: 0, fontSize: 22 }}>{label}</h2>
        <p style={{ color: "#667085", margin: "8px 0 22px" }}>
          Answer now or leave it ringing. The AI assistant will take over automatically when the agent window expires.
        </p>
        <div style={{ display: "flex", gap: 12 }}>
          <button disabled={busy} onClick={decline} style={styles.decline}>Decline</button>
          <button disabled={busy} onClick={answer} style={styles.answer}>Answer</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    display: "grid",
    placeItems: "center",
    padding: 20,
    background: "rgba(16,24,40,.46)",
    backdropFilter: "blur(5px)",
  },
  dialog: {
    width: "min(430px, 100%)",
    padding: 28,
    borderRadius: 20,
    background: "#fff",
    boxShadow: "0 24px 80px rgba(16,24,40,.28)",
    textAlign: "center",
  },
  icon: {
    width: 62,
    height: 62,
    margin: "0 auto 16px",
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: "#dcfce7",
    color: "#15803d",
    fontSize: 27,
  },
  answer: {
    flex: 1,
    border: 0,
    borderRadius: 12,
    padding: "13px 18px",
    background: "#16a34a",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  decline: {
    flex: 1,
    border: "1px solid #e4e7ec",
    borderRadius: 12,
    padding: "13px 18px",
    background: "#fff",
    color: "#b42318",
    fontWeight: 700,
    cursor: "pointer",
  },
};
