import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getSocket } from "../socket";

const FINAL_STATUSES = new Set(["ended", "missed", "rejected", "failed"]);

function waitForIceGathering(pc, timeoutMs = 2500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const onState = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

export default function IncomingCallOverlay() {
  const [incoming, setIncoming] = useState(null);
  const [phase, setPhase] = useState("ringing");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mediaState, setMediaState] = useState("idle");
  const [seconds, setSeconds] = useState(0);

  const pcRef = useRef(null);
  const micStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const incomingRef = useRef(null);

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  function cleanupMedia() {
    try { pcRef.current?.close(); } catch (_) {}
    pcRef.current = null;
    for (const track of micStreamRef.current?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    micStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setMuted(false);
    setMediaState("idle");
    setSeconds(0);
  }

  async function loadActiveCall() {
    try {
      const response = await api.get("/api/calls/active");
      if (response.data) {
        setIncoming(response.data);
        setPhase("ringing");
      } else if (phase === "ringing") {
        setIncoming(null);
      }
    } catch (err) {
      console.warn("[calls] could not recover active call", err.message);
    }
  }

  useEffect(() => {
    const socket = getSocket();

    const onIncoming = (payload) => {
      cleanupMedia();
      setIncoming(payload);
      setPhase("ringing");
      try {
        // Browsers may suppress this until the page has received one user
        // interaction, but the visual dialog still appears immediately.
        const audio = new Audio(
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        );
        audio.play().catch(() => {});
      } catch (_) {}
    };

    const onUpdated = (payload) => {
      const current = incomingRef.current;
      if (!current || current.id !== payload.id) return;

      if (FINAL_STATUSES.has(payload.status)) {
        cleanupMedia();
        setIncoming(null);
        setPhase("ringing");
        return;
      }

      if (payload.status === "connected") {
        // Another tab or the AI may win the race. A bot-connected call cannot
        // be attached to this browser after the final WhatsApp accept.
        if (payload.handled_by === "bot") {
          cleanupMedia();
          setIncoming(null);
          return;
        }
        setPhase("connected");
      }
    };

    const onAgentMedia = (payload) => {
      const current = incomingRef.current;
      if (current?.id === payload.id) setMediaState(payload.state);
    };

    const onConnect = () => loadActiveCall();

    socket.on("connect", onConnect);
    socket.on("call:incoming", onIncoming);
    socket.on("call:updated", onUpdated);
    socket.on("call:agent-media", onAgentMedia);
    loadActiveCall();

    return () => {
      socket.off("connect", onConnect);
      socket.off("call:incoming", onIncoming);
      socket.off("call:updated", onUpdated);
      socket.off("call:agent-media", onAgentMedia);
      cleanupMedia();
    };
  }, []);

  useEffect(() => {
    if (phase !== "connected") return undefined;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  if (!incoming) return null;

  async function answer() {
    setBusy(true);
    setPhase("connecting");
    setMediaState("requesting microphone");

    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone calling requires HTTPS and a supported browser.");
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micStreamRef.current = micStream;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => {
        setMediaState(pc.connectionState);
        if (["failed", "closed"].includes(pc.connectionState) && incomingRef.current) {
          console.warn(`[calls] browser media state: ${pc.connectionState}`);
        }
      };

      pc.ontrack = async (event) => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        if (!remoteAudioRef.current) return;
        remoteAudioRef.current.srcObject = stream;
        try { await remoteAudioRef.current.play(); } catch (_) {}
      };

      for (const track of micStream.getAudioTracks()) {
        pc.addTrack(track, micStream);
      }

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      const response = await api.post(`/api/calls/${incoming.id}/answer`, {
        offerSdp: pc.localDescription?.sdp,
      });

      if (!response.data?.answerSdp) {
        throw new Error("Server did not return a WebRTC audio answer.");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: response.data.answerSdp });
      setPhase("connected");
      setMediaState(pc.connectionState || "connecting");
      setSeconds(0);
    } catch (err) {
      cleanupMedia();
      if (err.response?.status === 409 || err.response?.status === 404) {
        setIncoming(null);
        await loadActiveCall();
      } else {
        setPhase("ringing");
        alert(err.response?.data?.error || err.message || "Could not connect the microphone call.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await api.post(`/api/calls/${incoming.id}/decline`, {});
      cleanupMedia();
      setIncoming(null);
    } catch (err) {
      if (err.response?.status === 409 || err.response?.status === 404) {
        cleanupMedia();
        setIncoming(null);
        await loadActiveCall();
        return;
      }
      alert(err.response?.data?.error || err.message || "Could not decline the call.");
    } finally {
      setBusy(false);
    }
  }

  async function hangup() {
    setBusy(true);
    try {
      await api.post(`/api/calls/${incoming.id}/end`, {});
    } catch (err) {
      if (![404, 409].includes(err.response?.status)) {
        alert(err.response?.data?.error || err.message || "Could not end the call.");
      }
    } finally {
      cleanupMedia();
      setIncoming(null);
      setBusy(false);
    }
  }

  function toggleMute() {
    const next = !muted;
    for (const track of micStreamRef.current?.getAudioTracks?.() || []) {
      track.enabled = !next;
    }
    setMuted(next);
  }

  const label = incoming.contact?.name || incoming.contact?.wa_id || "WhatsApp customer";
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const connected = phase === "connected";

  return (
    <div style={styles.backdrop}>
      <audio ref={remoteAudioRef} autoPlay playsInline />
      <div style={styles.dialog} role="dialog" aria-modal="true" aria-label="WhatsApp voice call">
        <div style={{ ...styles.icon, ...(connected ? styles.iconConnected : {}) }}>
          {connected ? "●" : "☎"}
        </div>
        <div style={styles.eyebrow}>
          {phase === "ringing" && "Incoming WhatsApp call"}
          {phase === "connecting" && "Connecting microphone…"}
          {phase === "connected" && `Live call · ${time}`}
        </div>
        <h2 style={styles.title}>{label}</h2>
        <p style={styles.description}>
          {phase === "ringing"
            ? "Answer in this browser or leave it ringing for the AI assistant."
            : phase === "connecting"
              ? "Allow microphone access. Caller audio will play through this device."
              : `${muted ? "Microphone muted" : "Microphone live"} · Media ${mediaState}`}
        </p>

        {!connected ? (
          <div style={styles.actions}>
            <button disabled={busy} onClick={decline} style={styles.decline}>Decline</button>
            <button disabled={busy} onClick={answer} style={styles.answer}>
              {phase === "connecting" ? "Connecting…" : "Answer"}
            </button>
          </div>
        ) : (
          <div style={styles.actions}>
            <button disabled={busy} onClick={toggleMute} style={styles.secondary}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button disabled={busy} onClick={hangup} style={styles.hangup}>End call</button>
          </div>
        )}
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
    background: "rgba(16,24,40,.52)",
    backdropFilter: "blur(7px)",
  },
  dialog: {
    width: "min(440px, 100%)",
    padding: 30,
    borderRadius: 22,
    background: "#fff",
    boxShadow: "0 24px 80px rgba(16,24,40,.3)",
    textAlign: "center",
  },
  icon: {
    width: 66,
    height: 66,
    margin: "0 auto 16px",
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: "#dcfce7",
    color: "#15803d",
    fontSize: 28,
  },
  iconConnected: {
    background: "#fee2e2",
    color: "#dc2626",
    fontSize: 20,
  },
  eyebrow: { fontSize: 13, color: "#667085", marginBottom: 6 },
  title: { margin: 0, fontSize: 23 },
  description: { color: "#667085", margin: "9px 0 24px", lineHeight: 1.5 },
  actions: { display: "flex", gap: 12 },
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
  secondary: {
    flex: 1,
    border: "1px solid #d0d5dd",
    borderRadius: 12,
    padding: "13px 18px",
    background: "#fff",
    color: "#344054",
    fontWeight: 700,
    cursor: "pointer",
  },
  hangup: {
    flex: 1,
    border: 0,
    borderRadius: 12,
    padding: "13px 18px",
    background: "#dc2626",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
};
