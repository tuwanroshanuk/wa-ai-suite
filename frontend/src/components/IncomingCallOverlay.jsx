import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getSocket } from "../socket";

const FINAL = new Set(["ended", "missed", "rejected", "failed"]);

function waitForIce(pc, timeout = 2500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    const listener = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", listener);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", listener);
  });
}

function startRingtone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return () => {};
  const context = new AudioContext();
  let timer;
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    context.resume().catch(() => {});
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
    const a = context.createOscillator();
    const b = context.createOscillator();
    a.frequency.value = 523.25;
    b.frequency.value = 659.25;
    a.connect(gain);
    b.connect(gain);
    gain.connect(context.destination);
    a.start(now); b.start(now);
    a.stop(now + 1.2); b.stop(now + 1.2);
  };
  ring();
  timer = setInterval(ring, 2800);
  return () => {
    stopped = true;
    clearInterval(timer);
    context.close().catch(() => {});
  };
}

export default function IncomingCallOverlay() {
  const [call, setCall] = useState(null);
  const [phase, setPhase] = useState("ringing");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(15);
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [mediaState, setMediaState] = useState("idle");
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [transcript, setTranscript] = useState([]);

  const callRef = useRef(null);
  const phaseRef = useRef("ringing");
  const pcRef = useRef(null);
  const micRef = useRef(null);
  const remoteRef = useRef(null);
  const ringStopRef = useRef(null);
  const audioContextRef = useRef(null);
  const destinationRef = useRef(null);
  const micGainRef = useRef(null);

  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  function stopRing() {
    ringStopRef.current?.();
    ringStopRef.current = null;
  }

  function cleanupMedia() {
    try { pcRef.current?.close(); } catch (_) {}
    pcRef.current = null;
    micRef.current?.getTracks?.().forEach((track) => track.stop());
    micRef.current = null;
    if (remoteRef.current) remoteRef.current.srcObject = null;
    try { audioContextRef.current?.close(); } catch (_) {}
    audioContextRef.current = null;
    destinationRef.current = null;
    micGainRef.current = null;
    setMediaState("idle");
    setMuted(false);
  }

  function closeDialog() {
    stopRing();
    cleanupMedia();
    setCall(null);
    setPhase("ringing");
    setReason("");
    setShowReason(false);
    setPrompt("");
    setTranscript([]);
    setSeconds(0);
  }

  function begin(payload) {
    stopRing();
    cleanupMedia();
    setCall(payload);
    setTranscript(Array.isArray(payload.transcript) ? payload.transcript : []);
    setPhase("ringing");
    setShowReason(false);
    setRemaining(Math.ceil(Number(payload.ringTimeoutMs || 15000) / 1000));
    ringStopRef.current = startRingtone();
  }

  async function recover() {
    try {
      const response = await api.get("/api/calls/active");
      if (response.data && callRef.current?.id !== response.data.id) begin(response.data);
      if (!response.data && phaseRef.current === "ringing") {
        stopRing();
        setCall(null);
      }
    } catch (error) {
      console.warn("[calls] active call recovery failed", error.message);
    }
  }

  useEffect(() => {
    const socket = getSocket();
    const incoming = (payload) => begin(payload);
    const updated = (payload) => {
      if (callRef.current?.id !== payload.id) return;
      if (FINAL.has(payload.status)) return closeDialog();
      if (payload.status === "connected" && payload.handled_by === "ivr") {
        stopRing();
        cleanupMedia();
        setPhase("ivr");
        setTimeout(() => callRef.current?.id === payload.id && closeDialog(), 1800);
      } else if (payload.status === "connected") {
        stopRing();
        setPhase("connected");
      }
    };
    const media = (payload) => callRef.current?.id === payload.id && setMediaState(payload.state);
    const text = (payload) => {
      if (callRef.current?.id === payload.id && payload.entry) {
        setTranscript((items) => [...items, payload.entry].slice(-20));
      }
    };
    socket.on("connect", recover);
    socket.on("call:incoming", incoming);
    socket.on("call:updated", updated);
    socket.on("call:agent-media", media);
    socket.on("call:transcript", text);
    recover();
    return () => {
      socket.off("connect", recover);
      socket.off("call:incoming", incoming);
      socket.off("call:updated", updated);
      socket.off("call:agent-media", media);
      socket.off("call:transcript", text);
      stopRing();
      cleanupMedia();
    };
  }, []);

  useEffect(() => {
    if (!call || phase !== "ringing") return;
    const fallback = Date.now() + Number(call.ringTimeoutMs || 15000);
    const tick = () => {
      const deadline = call.autoTransferAt ? new Date(call.autoTransferAt).getTime() : fallback;
      const value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(value);
      if (!value) {
        stopRing();
        setPhase("ivr");
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [call?.id, call?.autoTransferAt, phase]);

  useEffect(() => {
    if (phase !== "connected") return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  if (!call) return null;

  async function answer() {
    setBusy(true);
    stopRing();
    setPhase("connecting");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Browser calling requires HTTPS and microphone support.");
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
      micRef.current = mic;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(mic);
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(destination);
      audioContextRef.current = context;
      destinationRef.current = destination;
      micGainRef.current = gain;

      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      pcRef.current = pc;
      pc.onconnectionstatechange = () => setMediaState(pc.connectionState);
      pc.ontrack = async (event) => {
        if (!remoteRef.current) return;
        remoteRef.current.srcObject = event.streams?.[0] || new MediaStream([event.track]);
        await remoteRef.current.play().catch(() => {});
      };
      pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
      await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
      await waitForIce(pc);
      const response = await api.post(`/api/calls/${call.id}/answer`, { offerSdp: pc.localDescription?.sdp });
      await pc.setRemoteDescription({ type: "answer", sdp: response.data.answerSdp });
      setPhase("connected");
      setSeconds(0);
    } catch (error) {
      cleanupMedia();
      if ([404, 409].includes(error.response?.status)) {
        closeDialog();
        await recover();
      } else {
        setPhase("ringing");
        ringStopRef.current = startRingtone();
        alert(error.response?.data?.error || error.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function declineToIvr() {
    if (!showReason) return setShowReason(true);
    setBusy(true);
    stopRing();
    setPhase("ivr");
    try {
      await api.post(`/api/calls/${call.id}/decline`, { reason });
    } catch (error) {
      setPhase("ringing");
      ringStopRef.current = startRingtone();
      alert(error.response?.data?.error || error.message);
    } finally {
      setBusy(false);
    }
  }

  async function transferToIvr() {
    setBusy(true);
    setPhase("ivr");
    try {
      await api.post(`/api/calls/${call.id}/transfer-to-ivr`, { reason });
      cleanupMedia();
    } catch (error) {
      setPhase("connected");
      alert(error.response?.data?.error || error.message);
    } finally {
      setBusy(false);
    }
  }

  async function playPrompt() {
    if (!prompt.trim() || !audioContextRef.current || !destinationRef.current) return;
    setBusy(true);
    try {
      const response = await api.post(`/api/calls/${call.id}/prompt-audio`, { text: prompt.trim() }, { responseType: "arraybuffer" });
      const buffer = await audioContextRef.current.decodeAudioData(response.data.slice(0));
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(destinationRef.current);
      source.connect(audioContextRef.current.destination);
      source.start();
      await new Promise((resolve) => { source.onended = resolve; });
      setPrompt("");
    } catch (error) {
      alert(error.response?.data?.error || error.message);
    } finally {
      setBusy(false);
    }
  }

  async function hangup() {
    setBusy(true);
    try { await api.post(`/api/calls/${call.id}/end`, {}); } catch (_) {}
    closeDialog();
    setBusy(false);
  }

  const caller = call.contact?.name || call.contact?.wa_id || "WhatsApp customer";
  const timer = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div style={styles.backdrop}>
      <audio ref={remoteRef} autoPlay playsInline />
      <div style={styles.dialog}>
        <div style={styles.icon}>{phase === "ivr" ? "IVR" : phase === "connected" ? "●" : "☎"}</div>
        <div style={styles.eyebrow}>
          {phase === "ringing" && `Incoming WhatsApp call · IVR in ${remaining}s`}
          {phase === "connecting" && "Connecting microphone…"}
          {phase === "ivr" && "Transferring to automated phone menu…"}
          {phase === "connected" && `Live browser call · ${timer}`}
        </div>
        <h2 style={{ margin: "5px 0" }}>{caller}</h2>
        <p style={styles.description}>
          {phase === "ringing" && "Answer in this browser or route the caller into the published visual IVR."}
          {phase === "connecting" && "Allow microphone access to complete the browser audio bridge."}
          {phase === "ivr" && "Local speech recognition and neural voice prompts will continue the call."}
          {phase === "connected" && `${muted ? "Microphone muted" : "Microphone live"} · Media ${mediaState}`}
        </p>

        {phase === "ringing" && showReason && <div style={styles.panel}>
          <label style={styles.label}>Optional reason spoken before the IVR starts</label>
          <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} style={styles.input} placeholder="All agents are assisting other customers." />
        </div>}

        {phase === "connected" && <>
          <div style={styles.panel}>
            <label style={styles.label}>Play a local neural voice prompt during the call</label>
            <textarea rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} style={styles.input} placeholder="Type the prompt to play alongside your microphone." />
            <button className="secondary" disabled={busy || !prompt.trim()} onClick={playPrompt} style={{ width: "100%", marginTop: 8 }}>Play voice prompt</button>
          </div>
          <div style={styles.panel}>
            <label style={styles.label}>Optional transfer reason</label>
            <input value={reason} onChange={(event) => setReason(event.target.value)} style={styles.input} />
          </div>
        </>}

        {transcript.length > 0 && <div style={styles.transcript}>
          <strong style={{ fontSize: 12 }}>Live transcript</strong>
          {transcript.slice(-5).map((entry, index) => <div key={`${entry.at || index}-${index}`} style={styles.line}>
            <b>{entry.role === "caller" ? "Caller" : entry.role === "ivr" ? "IVR" : "Agent"}:</b> {entry.text}
          </div>)}
        </div>}

        {phase === "ringing" && <div style={styles.actions}>
          <button disabled={busy} onClick={declineToIvr} style={styles.decline}>{showReason ? "Start IVR" : "Decline → IVR"}</button>
          <button disabled={busy} onClick={answer} style={styles.answer}>Answer</button>
        </div>}
        {phase === "connected" && <div style={styles.connectedActions}>
          <button className="secondary" disabled={busy} onClick={() => {
            const next = !muted;
            if (micGainRef.current) micGainRef.current.gain.value = next ? 0 : 1;
            setMuted(next);
          }}>{muted ? "Unmute" : "Mute"}</button>
          <button disabled={busy} onClick={transferToIvr} style={styles.transfer}>Transfer to IVR</button>
          <button disabled={busy} onClick={hangup} style={styles.hangup}>End call</button>
        </div>}
      </div>
    </div>
  );
}

const styles = {
  backdrop: { position: "fixed", inset: 0, zIndex: 9999, display: "grid", placeItems: "center", padding: 20, background: "rgba(15,23,42,.58)", backdropFilter: "blur(7px)" },
  dialog: { width: "min(520px,100%)", maxHeight: "calc(100vh - 40px)", overflowY: "auto", background: "white", padding: 28, borderRadius: 22, boxShadow: "0 25px 80px rgba(15,23,42,.32)", textAlign: "center" },
  icon: { width: 66, height: 66, margin: "0 auto 15px", borderRadius: "50%", display: "grid", placeItems: "center", background: "#e8eeff", color: "#0738F9", fontWeight: 800, fontSize: 17 },
  eyebrow: { color: "#64748b", fontSize: 13 },
  description: { color: "#64748b", lineHeight: 1.5, margin: "8px 0 18px" },
  panel: { background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 13, padding: 13, marginBottom: 13, textAlign: "left" },
  label: { display: "block", color: "#334155", fontWeight: 700, fontSize: 12, marginBottom: 6 },
  input: { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 9, padding: 10, font: "inherit" },
  transcript: { background: "#f1f5f9", borderRadius: 12, padding: 12, marginBottom: 15, textAlign: "left", maxHeight: 150, overflowY: "auto" },
  line: { color: "#475569", fontSize: 12, lineHeight: 1.45, marginTop: 5 },
  actions: { display: "flex", gap: 10 },
  connectedActions: { display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr", gap: 8 },
  answer: { flex: 1, border: 0, borderRadius: 11, padding: 13, background: "#16a34a", color: "white", fontWeight: 750 },
  decline: { flex: 1, border: "1px solid #d8dee8", borderRadius: 11, padding: 13, background: "white", color: "#b42318", fontWeight: 750 },
  transfer: { border: 0, borderRadius: 11, padding: 12, background: "#0738F9", color: "white", fontWeight: 750 },
  hangup: { border: 0, borderRadius: 11, padding: 12, background: "#dc2626", color: "white", fontWeight: 750 },
};
