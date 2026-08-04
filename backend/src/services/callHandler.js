import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dgram from "dgram";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
} from "werift";
import { query } from "../db/index.js";
import { preAcceptCall, acceptCall, rejectCall, terminateCall } from "./whatsapp.js";
import { synthesizeWithMetadata } from "./tts.js";
import { generateReply, transcribeAudio } from "./gemini.js";
import { startLiveTranscriber } from "./callTranscriber.js";
import { emitToDashboard, getOnlineAgentCount } from "../sockets.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 15000);
const ICE_MIN_PORT = Number(process.env.WEBRTC_ICE_MIN_PORT || 50000);
const ICE_MAX_PORT = Number(process.env.WEBRTC_ICE_MAX_PORT || 50010);
const FAST_ICE_WAIT_MS = Number(process.env.WEBRTC_FAST_ICE_WAIT_MS || 200);
const AGENT_ICE_WAIT_MS = Number(process.env.WEBRTC_AGENT_ICE_WAIT_MS || 1200);
const CALL_AI_ENABLED = String(process.env.CALL_AI_ENABLED || "true").toLowerCase() !== "false";
const CALL_AI_SYSTEM_PROMPT =
  process.env.CALL_AI_SYSTEM_PROMPT ||
  "You are a helpful, concise customer support voice assistant. Reply naturally in the caller's language. Keep each spoken response under three short sentences. Ask one question at a time.";
const sessions = new Map();

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function makePeerConnection() {
  const iceServers = process.env.WEBRTC_STUN_URL
    ? [{ urls: process.env.WEBRTC_STUN_URL }]
    : [{ urls: "stun:stun.l.google.com:19302" }];

  const config = {
    iceServers,
    icePortRange: [ICE_MIN_PORT, ICE_MAX_PORT],
    iceUseIpv4: true,
    iceUseIpv6: false,
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
          payloadType: 111,
          parameters: "minptime=10;useinbandfec=1",
        }),
      ],
    },
  };

  if (process.env.WEBRTC_PUBLIC_IP) {
    config.iceAdditionalHostAddresses = [process.env.WEBRTC_PUBLIC_IP];
  }

  return new RTCPeerConnection(config);
}

async function waitForIce(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    let subscription;
    const timer = setTimeout(() => {
      subscription?.unSubscribe?.();
      resolve();
    }, timeoutMs);
    subscription = pc.iceGatheringStateChange.subscribe((state) => {
      if (state !== "complete") return;
      clearTimeout(timer);
      subscription?.unSubscribe?.();
      resolve();
    });
  });
}

async function waitForConnected(pc, timeoutMs = 5000) {
  if (pc.connectionState === "connected") return true;
  return new Promise((resolve) => {
    let subscription;
    const timer = setTimeout(() => {
      subscription?.unSubscribe?.();
      resolve(false);
    }, timeoutMs);
    subscription = pc.connectionStateChange.subscribe((state) => {
      if (state !== "connected") return;
      clearTimeout(timer);
      subscription?.unSubscribe?.();
      resolve(true);
    });
  });
}

function noRecording() {
  return {
    outputPath: null,
    feed() {},
    stop() {},
  };
}

function closePeer(pc) {
  try { pc?.close(); } catch (_) {}
}

async function appendTranscript(session, role, text, extra = {}) {
  const entry = {
    role,
    text,
    at: new Date().toISOString(),
    ...extra,
  };

  await query(
    `UPDATE calls
        SET transcript = COALESCE(transcript, '[]'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify([entry]), session.call.id]
  );

  emitToDashboard("call:transcript", {
    id: session.call.id,
    waCallId: session.call.wa_call_id,
    entry,
  });
}

async function processCallerTurn(waCallId, wavBuffer) {
  const session = sessions.get(waCallId);
  if (!session) return;

  let transcript;
  try {
    transcript = await transcribeAudio(wavBuffer, "audio/wav");
  } catch (err) {
    console.error(`[call ${waCallId}] caller transcription failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    return;
  }

  if (!transcript || transcript.length < 2) return;
  console.log(`[call ${waCallId}] caller transcript: ${transcript}`);
  await appendTranscript(session, "caller", transcript, { source: "speech" });

  if (!CALL_AI_ENABLED || session.mode !== "bot") return;

  session.aiHistory.push({ role: "user", text: transcript });
  session.aiHistory = session.aiHistory.slice(-12);

  let reply;
  try {
    reply = await generateReply(session.aiHistory, CALL_AI_SYSTEM_PROMPT);
  } catch (err) {
    console.error(`[call ${waCallId}] AI reply generation failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    return;
  }

  if (!reply) return;
  session.aiHistory.push({ role: "assistant", text: reply });
  session.aiHistory = session.aiHistory.slice(-12);
  await appendTranscript(session, "assistant", reply, { source: "gemini" });

  try {
    await playCallTts(waCallId, reply, "ai_reply");
  } catch (err) {
    console.error(`[call ${waCallId}] AI voice reply failed; call remains connected`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
  }
}

function startTranscriptionForSession(waCallId, session) {
  startLiveTranscriber({
    waCallId,
    recordingsDir: RECORDINGS_DIR,
    onTurn: (wavBuffer) => processCallerTurn(waCallId, wavBuffer),
  })
    .then((transcriber) => {
      if (sessions.get(waCallId) !== session) {
        transcriber.stop();
        return;
      }
      session.transcriber = transcriber;
    })
    .catch((err) => {
      console.error(`[call ${waCallId}] live transcription could not start`, err);
    });
}

export async function handleIncomingCall({ waCallId, offerSdp, contact }) {
  if (sessions.has(waCallId)) return sessions.get(waCallId).call;

  const inserted = await query(
    `INSERT INTO calls (contact_id, wa_call_id, direction, handled_by, status, consent_status)
     VALUES ($1,$2,'inbound','unassigned','ringing','not_required')
     ON CONFLICT (wa_call_id) DO NOTHING
     RETURNING *`,
    [contact.id, waCallId]
  );

  let call = inserted.rows[0];
  if (!call) {
    const existing = await query("SELECT * FROM calls WHERE wa_call_id=$1", [waCallId]);
    call = existing.rows[0];
    if (!call || call.status !== "ringing") return call;
  }

  let pc;
  let recording = noRecording();
  let sessionRef = null;

  try {
    console.log(`[call ${waCallId}] preparing WebRTC answer`);
    pc = makePeerConnection();
    const outboundTrack = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(outboundTrack, { direction: "sendrecv" });

    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      console.log(`[call ${waCallId}] WhatsApp inbound audio track received`);
      if (sessionRef) sessionRef.whatsappInboundTrack = track;
      track.onReceiveRtp.subscribe((rtp) => {
        recording.feed(rtp);
        sessionRef?.transcriber?.feed(rtp);
        try { sessionRef?.agentOutboundTrack?.writeRtp(rtp); } catch (_) {}
      });
    });

    pc.connectionStateChange.subscribe((state) => {
      console.log(`[call ${waCallId}] WhatsApp WebRTC state: ${state}`);
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc, FAST_ICE_WAIT_MS);

    if (!pc.localDescription?.sdp) throw new Error("WebRTC answer SDP was not generated");

    const autoTransferAt = new Date(Date.now() + AGENT_RING_TIMEOUT_MS).toISOString();
    const session = {
      pc,
      call,
      recording,
      outboundTrack,
      whatsappInboundTrack: null,
      agentPc: null,
      agentOutboundTrack: null,
      contact,
      ringTimer: null,
      transcriber: null,
      decided: false,
      acceptedBy: null,
      mode: "ringing",
      autoTransferAt,
      ttsQueue: Promise.resolve(),
      ttsPlaying: false,
      aiHistory: [],
    };
    sessionRef = session;
    sessions.set(waCallId, session);

    console.log(`[call ${waCallId}] sending pre_accept immediately`);
    await preAcceptCall(waCallId, pc.localDescription.sdp);
    console.log(`[call ${waCallId}] pre_accept completed`);

    recording = startRecording(waCallId);
    session.recording = recording;
    startTranscriptionForSession(waCallId, session);

    if (getOnlineAgentCount() > 0) {
      emitToDashboard("call:incoming", {
        id: call.id,
        waCallId,
        contact: { id: contact.id, name: contact.name, wa_id: contact.wa_id },
        startedAt: call.started_at,
        autoTransferAt,
      });
      console.log(`[call ${waCallId}] incoming-call popup emitted to dashboard`);
      session.ringTimer = setTimeout(() => {
        answerWithBot(waCallId).catch((err) =>
          console.error(`[call ${waCallId}] automatic AI answer failed`, err)
        );
      }, AGENT_RING_TIMEOUT_MS);
    } else {
      console.log(`[call ${waCallId}] no agent online; accepting with AI immediately`);
      setImmediate(() => answerWithBot(waCallId));
    }

    return call;
  } catch (err) {
    console.error(`[call ${waCallId}] setup failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
      stack: err.stack,
    });
    recording.stop();
    closePeer(pc);
    await failCall(waCallId, call.id, err);
    throw err;
  }
}

export async function claimCallAsAgent(waCallId, user, browserOfferSdp) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) throw new Error("Call is no longer available.");
  if (!browserOfferSdp) throw new Error("Browser microphone WebRTC offer is required.");

  session.decided = true;
  clearTimeout(session.ringTimer);

  let agentPc;
  try {
    console.log(`[call ${waCallId}] preparing browser audio bridge for agent ${user.id}`);
    agentPc = makePeerConnection();
    const agentOutboundTrack = new MediaStreamTrack({ kind: "audio" });
    agentPc.addTransceiver(agentOutboundTrack, { direction: "sendrecv" });

    agentPc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      console.log(`[call ${waCallId}] agent microphone track received`);
      track.onReceiveRtp.subscribe((rtp) => {
        try { session.outboundTrack.writeRtp(rtp); } catch (_) {}
      });
    });

    agentPc.connectionStateChange.subscribe((state) => {
      console.log(`[call ${waCallId}] agent WebRTC state: ${state}`);
      emitToDashboard("call:agent-media", {
        id: session.call.id,
        waCallId,
        state,
      });
    });

    await agentPc.setRemoteDescription({ type: "offer", sdp: browserOfferSdp });
    await agentPc.setLocalDescription(await agentPc.createAnswer());
    await waitForIce(agentPc, AGENT_ICE_WAIT_MS);

    if (!agentPc.localDescription?.sdp) {
      throw new Error("Agent WebRTC answer SDP was not generated.");
    }

    session.agentPc = agentPc;
    session.agentOutboundTrack = agentOutboundTrack;
    session.acceptedBy = `agent:${user.id}`;
    session.mode = "agent";

    await acceptCall(waCallId);

    const handledBy = session.acceptedBy;
    const result = await query(
      "UPDATE calls SET status='connected',handled_by=$1 WHERE id=$2 RETURNING *",
      [handledBy, session.call.id]
    );

    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: handledBy,
    });

    console.log(`[call ${waCallId}] agent accepted; browser bridge SDP returned`);
    return {
      call: result.rows[0] || session.call,
      answerSdp: agentPc.localDescription.sdp,
    };
  } catch (err) {
    closePeer(agentPc);
    session.agentPc = null;
    session.agentOutboundTrack = null;
    session.acceptedBy = null;
    session.mode = "ringing";
    session.decided = false;

    setImmediate(() => {
      answerWithBot(waCallId).catch((botErr) =>
        console.error(`[call ${waCallId}] agent bridge and AI fallback failed`, botErr)
      );
    });
    throw err;
  }
}

export async function transferCallToBot(
  waCallId,
  {
    announcement,
    reason,
    source = "manual",
  } = {}
) {
  const session = sessions.get(waCallId);
  if (!session) throw new Error("Call session is no longer available.");

  clearTimeout(session.ringTimer);
  session.decided = true;

  if (session.acceptedBy === "bot") {
    if (announcement) setImmediate(() => playCallTts(waCallId, announcement, source));
    return session.call;
  }

  const wasAlreadyAccepted = Boolean(session.acceptedBy);
  closePeer(session.agentPc);
  session.agentPc = null;
  session.agentOutboundTrack = null;

  if (!wasAlreadyAccepted) {
    console.log(`[call ${waCallId}] sending final accept for AI bot`);
    await acceptCall(waCallId);
  }

  session.acceptedBy = "bot";
  session.mode = "bot";
  const result = await query(
    "UPDATE calls SET status='connected',handled_by='bot' WHERE id=$1 RETURNING *",
    [session.call.id]
  );

  emitToDashboard("call:updated", {
    id: session.call.id,
    waCallId,
    status: "connected",
    handled_by: "bot",
    transfer_source: source,
    reason: reason || null,
  });

  const connected = await waitForConnected(session.pc);
  console.log(`[call ${waCallId}] transferred to AI; media connected=${connected}`);

  if (announcement) {
    setImmediate(() => {
      playCallTts(waCallId, announcement, source).catch((err) =>
        console.error(`[call ${waCallId}] transfer announcement failed`, err)
      );
    });
  }

  return result.rows[0] || session.call;
}

export async function answerWithBot(waCallId) {
  const greeting =
    process.env.CALL_GREETING ||
    "Hi! Thanks for calling. This is our AI assistant. How can I help?";
  return transferCallToBot(waCallId, {
    announcement: greeting,
    source: "automatic_timeout",
  });
}

export async function createAgentPromptAudio(waCallId, text, user) {
  const session = sessions.get(waCallId);
  if (!session || session.mode !== "agent") {
    throw new Error("An agent-connected call is required to play a browser prompt.");
  }
  if (!text?.trim()) throw new Error("Prompt text is required.");

  const result = await synthesizeWithMetadata(text.trim());
  await appendTranscript(session, "agent_prompt", text.trim(), {
    source: `agent:${user.id}`,
    provider: result.provider,
  });
  return result;
}

async function playCallTts(waCallId, text, source = "tts") {
  const session = sessions.get(waCallId);
  if (!session || !text?.trim()) return;

  const task = async () => {
    const active = sessions.get(waCallId);
    if (!active) return;

    active.ttsPlaying = true;
    emitToDashboard("call:prompt-state", {
      id: active.call.id,
      waCallId,
      state: "playing",
      source,
      text,
    });

    try {
      const { audio, provider } = await synthesizeWithMetadata(text.trim());
      const udp = dgram.createSocket("udp4");
      await new Promise((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(0, "127.0.0.1", resolve);
      });
      const port = udp.address().port;

      udp.on("message", (data) => {
        try {
          const packet = RtpPacket.deSerialize(data);
          packet.header.payloadType = 111;
          active.outboundTrack.writeRtp(packet);
        } catch (err) {
          console.warn(`[call ${waCallId}] invalid generated RTP packet`, err.message);
        }
      });

      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-re", "-i", "pipe:0",
        "-vn", "-acodec", "libopus", "-ar", "48000", "-ac", "2",
        "-application", "voip", "-frame_duration", "20", "-payload_type", "111",
        "-f", "rtp", `rtp://127.0.0.1:${port}`,
      ]);

      ffmpeg.stderr?.on("data", (data) =>
        console.error(`[call ${waCallId}] ffmpeg TTS: ${data.toString().trim()}`)
      );

      const completed = new Promise((resolve, reject) => {
        ffmpeg.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))
        );
        ffmpeg.once("error", reject);
      });

      ffmpeg.stdin?.end(audio);
      try {
        await completed;
      } finally {
        try { udp.close(); } catch (_) {}
      }
      console.log(`[call ${waCallId}] TTS finished source=${source} provider=${provider}`);
    } finally {
      const current = sessions.get(waCallId);
      if (current) current.ttsPlaying = false;
      emitToDashboard("call:prompt-state", {
        id: session.call.id,
        waCallId,
        state: "idle",
        source,
      });
    }
  };

  session.ttsQueue = session.ttsQueue.then(task, task);
  return session.ttsQueue;
}

export async function handleCallTerminated(waCallId, outcome = "terminate") {
  const session = sessions.get(waCallId);
  let recordingPath = null;
  if (session) {
    clearTimeout(session.ringTimer);
    session.transcriber?.stop();
    session.recording.stop();
    recordingPath = session.recording.outputPath;
    closePeer(session.agentPc);
    closePeer(session.pc);
  }

  const existing = await query("SELECT id,status FROM calls WHERE wa_call_id=$1", [waCallId]);
  const row = existing.rows[0];
  sessions.delete(waCallId);
  if (!row) return;

  let finalStatus = "missed";
  if (outcome === "reject") finalStatus = "rejected";
  else if (row.status === "connected") finalStatus = "ended";
  else if (row.status === "failed") finalStatus = "failed";

  const result = await query(
    `UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()),
       recording_path=COALESCE($2,recording_path)
     WHERE wa_call_id=$3 RETURNING id,status`,
    [finalStatus, recordingPath, waCallId]
  );
  if (result.rows[0]) {
    emitToDashboard("call:updated", {
      id: result.rows[0].id,
      waCallId,
      status: result.rows[0].status,
    });
  }
}

export async function rejectIncomingCall(waCallId, reason) {
  const session = sessions.get(waCallId);
  if (session) {
    clearTimeout(session.ringTimer);
    session.transcriber?.stop();
    session.recording.stop();
    closePeer(session.agentPc);
    closePeer(session.pc);
  }
  try { await rejectCall(waCallId); } catch (_) {}
  const result = await query(
    "UPDATE calls SET status='rejected',ended_at=now() WHERE wa_call_id=$1 RETURNING id",
    [waCallId]
  );
  sessions.delete(waCallId);
  if (result.rows[0]) {
    emitToDashboard("call:updated", {
      id: result.rows[0].id,
      waCallId,
      status: "rejected",
      reason,
    });
  }
}

export async function endCall(waCallId) {
  try { await terminateCall(waCallId); } finally {
    await handleCallTerminated(waCallId, "terminate");
  }
}

async function failCall(waCallId, callId, err) {
  const session = sessions.get(waCallId);
  if (session) {
    clearTimeout(session.ringTimer);
    session.transcriber?.stop();
    session.recording.stop();
    closePeer(session.agentPc);
    closePeer(session.pc);
  }
  try { await rejectCall(waCallId); } catch (_) {}
  await query("UPDATE calls SET status='failed',ended_at=now() WHERE id=$1", [callId]);
  sessions.delete(waCallId);
  emitToDashboard("call:updated", {
    id: callId,
    waCallId,
    status: "failed",
    error: err?.response?.data || err?.message || String(err),
  });
}

export async function reconcileStaleCalls() {
  const stale = await query(
    `SELECT id,wa_call_id,status FROM calls
     WHERE (status='ringing' AND started_at < now() - interval '5 minutes')
        OR (status='connected' AND started_at < now() - interval '12 hours')`
  );
  for (const row of stale.rows) {
    if (sessions.has(row.wa_call_id)) continue;
    try { await terminateCall(row.wa_call_id); } catch (_) {}
    const status = row.status === "connected" ? "ended" : "missed";
    await query("UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()) WHERE id=$2", [
      status,
      row.id,
    ]);
    emitToDashboard("call:updated", { id: row.id, waCallId: row.wa_call_id, status });
  }
}

setInterval(() => {
  reconcileStaleCalls().catch((err) => console.error("[calls] stale sweep failed", err));
}, 300000);

function startRecording(waCallId) {
  const socket = dgram.createSocket("udp4");
  const fileName = safeName(waCallId);
  const outputPath = path.join(RECORDINGS_DIR, `${fileName}.wav`);
  const sdpPath = path.join(RECORDINGS_DIR, `${fileName}.sdp`);
  let enabled = true;
  let stopped = false;
  let udpPort = null;
  let ffmpeg = null;
  const pending = [];

  socket.once("error", (err) => {
    enabled = false;
    console.error(`[call ${waCallId}] recording socket failed`, err);
  });

  socket.bind(0, "127.0.0.1", () => {
    if (stopped || !enabled) return;
    udpPort = socket.address().port;
    try {
      fs.writeFileSync(
        sdpPath,
        [
          "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=recording",
          "c=IN IP4 127.0.0.1", "t=0 0", `m=audio ${udpPort} RTP/AVP 111`,
          "a=rtpmap:111 opus/48000/2",
        ].join("\n")
      );
    } catch (err) {
      enabled = false;
      console.error(`[call ${waCallId}] recording SDP could not be created`, err);
      return;
    }

    ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-protocol_whitelist", "file,udp,rtp", "-i", sdpPath, "-y", outputPath,
    ]);
    ffmpeg.once("error", (err) => {
      enabled = false;
      console.error(`[call ${waCallId}] recording disabled because FFmpeg could not start`, err);
    });
    ffmpeg.once("close", () => {
      enabled = false;
    });

    for (const packet of pending.splice(0)) {
      try { socket.send(packet, udpPort, "127.0.0.1"); } catch (_) {}
    }
  });

  return {
    get outputPath() {
      return enabled || fs.existsSync(outputPath) ? outputPath : null;
    },
    feed(rtp) {
      if (!enabled || stopped) return;
      try {
        const packet = rtp.serialize();
        if (!udpPort) {
          if (pending.length < 100) pending.push(packet);
          return;
        }
        socket.send(packet, udpPort, "127.0.0.1");
      } catch (_) {}
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { ffmpeg?.kill("SIGINT"); } catch (_) {}
      try { socket.close(); } catch (_) {}
      try { fs.unlinkSync(sdpPath); } catch (_) {}
    },
  };
}
