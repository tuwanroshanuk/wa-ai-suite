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

function startOriginalRingtone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return () => {};

  const context = new AudioContextClass();
  let stopped = false;
  let timer = null;

  const ring = () => {
    if (stopped) return;
    context.resume().catch(() => {});
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.03);
    gain.gain.setValueAtTime(0.13, now + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    gain.gain.setValueAtTime(0.0001, now + 0.66);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.7);
    gain.gain.setValueAtTime(0.13, now + 1.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.18);
    gain.connect(context.destination);

    const low = context.createOscillator();
    const high = context.createOscillator();
    low.type = "sine";
    high.type = "sine";
    low.frequency.value = 523.25;
    high.frequency.value = 659.25;
    low.connect(gain);
    high.connect(gain);
    low.start(now);
    high.start(now);
    low.stop(now + 1.2);
    high.stop(now + 1.2);
  };

  ring();
  timer = window.setInterval(ring, 2850);

  return () => {
    stopped = true;
    if (timer) window.clearInterval(timer);
    context.close().catch(() => {});
  };
}

export default function IncomingCallOverlay() {
  const [incoming, setIncoming] = useState(null);
  const [phase, setPhase] = useState("ringing");
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mediaState, setMediaState] = useState("idle");
  const [seconds, setSeconds] = useState(0);
  const [remaining, setRemaining] = useState(15);
  const [showDeclineReason, setShowDeclineReason] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [promptText, setPromptText] = useState("");
  const [promptState, setPromptState] = useState("idle");
  const [transcript, setTranscript] = useState([]);

  const pcRef = useRef(null);
  const micStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const incomingRef = useRef(null);
  const phaseRef = useRef("ringing");
  const ringtoneStopRef = useRef(null);
  const audioContextRef = useRef(null);
  const mixDestinationRef = useRef(null);
  const micGainRef = useRef(null);

  useEffect(() => {
    incomingRef.current = incoming;
  }, [incoming]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  function stopRingtone() {
    ringtoneStopRef.current?.();
    ringtoneStopRef.current = null;
  }

  function cleanupMedia() {
    try { pcRef.current?.close(); } catch (_) {}
    pcRef.current = null;
    for (const track of micStreamRef.current?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    micStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    try { audioContextRef.current?.close(); } catch (_) {}
    audioContextRef.current = null;
    mixDestinationRef.current = null;
    micGainRef.current = null;
    setMuted(false);
    setMediaState("idle");
    setSeconds(0);
    setPromptState("idle");
  }

  function resetDialog() {
    stopRingtone();
    cleanupMedia();
    setIncoming(null);
    setPhase("ringing");
    setShowDeclineReason(false);
    setDeclineReason("");
    setTransferReason("");
    setPromptText("");
    setTranscript([]);
  }

  function beginRinging(payload) {
    stopRingtone();
    cleanupMedia();
    setIncoming(payload);
    setTranscript(Array.isArray(payload.transcript) ? payload.transcript : []);
    setPhase("ringing");
    setShowDeclineReason(false);
    setRemaining(15);
    ringtoneStopRef.current = startOriginalRingtone();
  }

  async function loadActiveCall() {
    try {
      const response = await api.get("/api/calls/active");
      if (response.data) {
        const current = incomingRef.current;
        if (!current || current.id !== response.data.id) beginRinging(response.data);
      } else if (phaseRef.current === "ringing") {
        stopRingtone();
        setIncoming(null);
      }
    } catch (err) {
      console.warn("[calls] could not recover active call", err.message);
    }
  }

  useEffect(() => {
    const socket = getSocket();

    const onIncoming = (payload) => beginRinging(payload);

    const onUpdated = (payload) => {
      const current = incomingRef.current;
      if (!current || current.id !== payload.id) return;

      if (FINAL_STATUSES.has(payload.status)) {
        resetDialog();
        return;
      }

      if (payload.status === "connected") {
        stopRingtone();
        if (payload.handled_by === "bot") {
          setPhase("transferring");
          cleanupMedia();
          window.setTimeout(() => {
            if (incomingRef.current?.id === payload.id) resetDialog();
          }, 1800);
          return;
        }
        setPhase("connected");
      }
    };

    const onAgentMedia = (payload) => {
      const current = incomingRef.current;
      if (current?.id === payload.id) setMediaState(payload.state);
    };

    const onTranscript = (payload) => {
      const current = incomingRef.current;
      if (current?.id !== payload.id || !payload.entry) return;
      setTranscript((items) => [...items, payload.entry].slice(-12));
    };

    const onPromptState = (payload) => {
      const current = incomingRef.current;
      if (current?.id === payload.id) setPromptState(payload.state || "idle");
    };

    const onConnect = () => loadActiveCall();

    socket.on("connect", onConnect);
    socket.on("call:incoming", onIncoming);
    socket.on("call:updated", onUpdated);
    socket.on("call:agent-media", onAgentMedia);
    socket.on("call:transcript", onTranscript);
    socket.on("call:prompt-state", onPromptState);
    loadActiveCall();

    return () => {
      socket.off("connect", onConnect);
      socket.off("call:incoming", onIncoming);
      socket.off("call:updated", onUpdated);
      socket.off("call:agent-media", onAgentMedia);
      socket.off("call:transcript", onTranscript);
      socket.off("call:prompt-state", onPromptState);
      stopRingtone();
      cleanupMedia();
    };
  }, []);

  useEffect(() => {
    if (!incoming || phase !== "ringing") return undefined;

    const fallbackTarget = Date.now() + 15000;
    const update = () => {
      const target = incoming.autoTransferAt
        ? new Date(incoming.autoTransferAt).getTime()
        : fallbackTarget;
      const value = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(value);
      if (value <= 0) {
        stopRingtone();
        setPhase("transferring");
      }
    };

    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [incoming?.id, incoming?.autoTransferAt, phase]);

  useEffect(() => {
    if (phase !== "connected") return undefined;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  if (!incoming) return null;

  async function answer() {
    setBusy(true);
    stopRingtone();
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

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioContextClass();
      await audioContext.resume();
      const micSource = audioContext.createMediaStreamSource(micStream);
      const micGain = audioContext.createGain();
      const destination = audioContext.createMediaStreamDestination();
      micSource.connect(micGain);
      micGain.connect(destination);
      audioContextRef.current = audioContext;
      micGainRef.current = micGain;
      mixDestinationRef.current = destination;

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

      const mixedTrack = destination.stream.getAudioTracks()[0];
      pc.addTrack(mixedTrack, destination.stream);

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
        ringtoneStopRef.current = startOriginalRingtone();
        alert(err.response?.data?.error || err.message || "Could not connect the microphone call.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function declineToAi() {
    if (!showDeclineReason) {
      setShowDeclineReason(true);
      return;
    }

    setBusy(true);
    stopRingtone();
    setPhase("transferring");
    try {
      await api.post(`/api/calls/${incoming.id}/decline`, { reason: declineReason });
    } catch (err) {
      if (err.response?.status === 409 || err.response?.status === 404) {
        resetDialog();
        await loadActiveCall();
      } else {
        setPhase("ringing");
        ringtoneStopRef.current = startOriginalRingtone();
        alert(err.response?.data?.error || err.message || "Could not transfer the call to AI.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function transferToAi() {
    setBusy(true);
    setPhase("transferring");
    try {
      await api.post(`/api/calls/${incoming.id}/transfer-to-bot`, {
        reason: transferReason,
      });
      cleanupMedia();
    } catch (err) {
      setPhase("connected");
      alert(err.response?.data?.error || err.message || "Could not transfer the call to AI.");
    } finally {
      setBusy(false);
    }
  }

  async function playAiPrompt() {
    const text = promptText.trim();
    if (!text || !audioContextRef.current || !mixDestinationRef.current) return;

    setBusy(true);
    setPromptState("generating");
    try {
      const response = await api.post(
        `/api/calls/${incoming.id}/prompt-audio`,
        { text },
        { responseType: "arraybuffer" }
      );

      const context = audioContextRef.current;
      const audioBuffer = await context.decodeAudioData(response.data.slice(0));
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(mixDestinationRef.current);
      source.connect(context.destination);
      setPromptState("playing");
      source.start();
      await new Promise((resolve) => {
        source.onended = resolve;
      });
      setPromptText("");
      setPromptState("idle");
    } catch (err) {
      setPromptState("idle");
      alert(err.response?.data?.error || err.message || "Could not play the AI voice prompt.");
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
      resetDialog();
      setBusy(false);
    }
  }

  function toggleMute() {
    const next = !muted;
    if (micGainRef.current) micGainRef.current.gain.value = next ? 0 : 1;
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
          {connected ? "●" : phase === "transferring" ? "AI" : "☎"}
        </div>

        <div style={styles.eyebrow}>
          {phase === "ringing" && `Incoming WhatsApp call · AI in ${remaining}s`}
          {phase === "connecting" && "Connecting microphone…"}
          {phase === "transferring" && "Transferring to AI assistant…"}
          {phase === "connected" && `Live call · ${time}`}
        </div>
        <h2 style={styles.title}>{label}</h2>
        <p style={styles.description}>
          {phase === "ringing"
            ? "Answer in this browser. Decline transfers the caller to AI instead of ending the call."
            : phase === "connecting"
              ? "Allow microphone access. Caller audio will play through this device."
              : phase === "transferring"
                ? "The caller will hear a transfer message, then the AI will continue the conversation."
                : `${muted ? "Microphone muted" : "Microphone live"} · Media ${mediaState}`}
        </p>

        {phase === "ringing" && showDeclineReason && (
          <div style={styles.panel}>
            <label style={styles.label}>Optional decline reason spoken to the caller</label>
            <textarea
              rows={3}
              value={declineReason}
              onChange={(event) => setDeclineReason(event.target.value)}
              placeholder="Example: All agents are helping other customers right now."
              style={styles.textarea}
            />
            <button
              type="button"
              onClick={() => setShowDeclineReason(false)}
              style={styles.linkButton}
            >
              Cancel
            </button>
          </div>
        )}

        {connected && (
          <>
            <div style={styles.panel}>
              <label style={styles.label}>AI voice prompt mixed with your microphone</label>
              <textarea
                rows={2}
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="Type something for the AI voice to say to the caller…"
                style={styles.textarea}
              />
              <button
                disabled={busy || !promptText.trim()}
                onClick={playAiPrompt}
                style={styles.promptButton}
              >
                {promptState === "generating"
                  ? "Generating voice…"
                  : promptState === "playing"
                    ? "Playing…"
                    : "Play AI voice"}
              </button>
            </div>

            <div style={styles.panel}>
              <label style={styles.label}>Transfer to AI assistant</label>
              <input
                value={transferReason}
                onChange={(event) => setTransferReason(event.target.value)}
                placeholder="Optional transfer reason"
                style={styles.input}
              />
            </div>
          </>
        )}

        {transcript.length > 0 && (
          <div style={styles.transcript}>
            <div style={styles.label}>Live transcript</div>
            {transcript.slice(-4).map((entry, index) => (
              <div key={`${entry.at || index}-${index}`} style={styles.transcriptLine}>
                <strong>{entry.role === "caller" ? "Caller" : entry.role === "assistant" ? "AI" : "Agent"}:</strong>{" "}
                {entry.text}
              </div>
            ))}
          </div>
        )}

        {phase === "ringing" ? (
          <div style={styles.actions}>
            <button disabled={busy} onClick={declineToAi} style={styles.decline}>
              {showDeclineReason ? "Transfer to AI" : "Decline → AI"}
            </button>
            <button disabled={busy} onClick={answer} style={styles.answer}>Answer</button>
          </div>
        ) : connected ? (
          <div style={styles.actionsWrap}>
            <button disabled={busy} onClick={toggleMute} style={styles.secondary}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button disabled={busy} onClick={transferToAi} style={styles.transfer}>
              Transfer to AI
            </button>
            <button disabled={busy} onClick={hangup} style={styles.hangup}>End call</button>
          </div>
        ) : null}
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
    background: "rgba(16,24,40,.55)",
    backdropFilter: "blur(7px)",
    overflowY: "auto",
  },
  dialog: {
    width: "min(520px, 100%)",
    maxHeight: "calc(100vh - 40px)",
    overflowY: "auto",
    padding: 28,
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
    fontSize: 26,
    fontWeight: 800,
  },
  iconConnected: {
    background: "#fee2e2",
    color: "#dc2626",
    fontSize: 20,
  },
  eyebrow: { fontSize: 13, color: "#667085", marginBottom: 6 },
  title: { margin: 0, fontSize: 23 },
  description: { color: "#667085", margin: "9px 0 20px", lineHeight: 1.5 },
  panel: {
    padding: 14,
    marginBottom: 14,
    border: "1px solid #e4e7ec",
    borderRadius: 14,
    background: "#f9fafb",
    textAlign: "left",
  },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "#344054", marginBottom: 7 },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
    border: "1px solid #d0d5dd",
    borderRadius: 10,
    padding: 10,
    font: "inherit",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid #d0d5dd",
    borderRadius: 10,
    padding: 10,
    font: "inherit",
  },
  transcript: {
    padding: 13,
    marginBottom: 16,
    borderRadius: 12,
    background: "#f2f4f7",
    textAlign: "left",
    maxHeight: 150,
    overflowY: "auto",
  },
  transcriptLine: { fontSize: 12, lineHeight: 1.45, color: "#475467", marginTop: 5 },
  actions: { display: "flex", gap: 12 },
  actionsWrap: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
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
    border: "1px solid #d0d5dd",
    borderRadius: 12,
    padding: "12px 10px",
    background: "#fff",
    color: "#344054",
    fontWeight: 700,
    cursor: "pointer",
  },
  transfer: {
    border: 0,
    borderRadius: 12,
    padding: "12px 10px",
    background: "#0738F9",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  hangup: {
    border: 0,
    borderRadius: 12,
    padding: "12px 10px",
    background: "#dc2626",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  promptButton: {
    width: "100%",
    marginTop: 9,
    border: 0,
    borderRadius: 10,
    padding: "10px 12px",
    background: "#111827",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer",
  },
  linkButton: {
    marginTop: 6,
    padding: 0,
    border: 0,
    background: "transparent",
    color: "#475467",
    cursor: "pointer",
  },
};
