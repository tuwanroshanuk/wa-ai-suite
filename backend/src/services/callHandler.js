import { spawn } from "child_process";
import dgram from "dgram";
import fs from "fs";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
} from "werift";
import { query } from "../db/index.js";
import { preAcceptCall, acceptCall, rejectCall, terminateCall } from "./whatsapp.js";
import { synthesizeWithMetadata } from "./tts.js";
import { transcribeAudio } from "./stt.js";
import { startLiveTranscriber } from "./callTranscriber.js";
import { startCallRecorder, noCallRecorder } from "./callRecorder.js";
import {
  getIvrSession,
  handleIvrInput,
  startIvrSession,
  stopIvrSession,
} from "./ivrEngine.js";
import { emitToDashboard, getOnlineAgentCount } from "../sockets.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 15000);
const IVR_TRANSFER_TIMEOUT_MS = Number(process.env.IVR_TRANSFER_TIMEOUT_MS || 20000);
const ICE_MIN_PORT = Number(process.env.WEBRTC_ICE_MIN_PORT || 50000);
const ICE_MAX_PORT = Number(process.env.WEBRTC_ICE_MAX_PORT || 50010);
const FAST_ICE_WAIT_MS = Number(process.env.WEBRTC_FAST_ICE_WAIT_MS || 200);
const AGENT_ICE_WAIT_MS = Number(process.env.WEBRTC_AGENT_ICE_WAIT_MS || 1200);
const sessions = new Map();

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

function closePeer(pc) {
  try { pc?.close(); } catch (_) {}
}

async function appendTranscript(session, role, text, extra = {}) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return;
  const entry = { role, text: value, at: new Date().toISOString(), ...extra };
  await query(
    `UPDATE calls SET transcript=COALESCE(transcript,'[]'::jsonb) || $1::jsonb WHERE id=$2`,
    [JSON.stringify([entry]), session.call.id]
  );
  emitToDashboard("call:transcript", {
    id: session.call.id,
    waCallId: session.call.wa_call_id,
    entry,
  });
}

function emitIvrStatus(session, state, detail = {}) {
  emitToDashboard("call:ivr-status", {
    id: session.call.id,
    waCallId: session.call.wa_call_id,
    state,
    ...detail,
  });
}

async function processCallerTurn(waCallId, wavBuffer) {
  const session = sessions.get(waCallId);
  if (!session) return;

  let transcript;
  try {
    transcript = await transcribeAudio(wavBuffer, "audio/wav");
  } catch (error) {
    console.error(`[call ${waCallId}] local transcription failed`, {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    emitIvrStatus(session, "transcription_error", { error: error.message });
    return;
  }

  if (!transcript || transcript.length < 1) return;
  console.log(`[call ${waCallId}] caller transcript: ${transcript}`);
  await appendTranscript(session, "caller", transcript, { source: "local_whisper" });

  if (session.mode === "ivr") {
    const consumed = await handleIvrInput(waCallId, transcript);
    if (!consumed) emitIvrStatus(session, "input_ignored", { transcript });
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
      console.log(`[call ${waCallId}] local IVR transcription ready`);
    })
    .catch((error) => {
      console.error(`[call ${waCallId}] caller audio decoder could not start`, error);
    });
}

async function offerCallToAgents(session, source = "ivr_transfer") {
  const waCallId = session.call.wa_call_id;
  stopIvrSession(waCallId);
  session.mode = "ringing";
  session.decided = false;
  session.acceptedBy = null;
  clearTimeout(session.ringTimer);

  await query("UPDATE calls SET status='ringing',handled_by='unassigned' WHERE id=$1", [session.call.id]);
  emitToDashboard("call:incoming", {
    id: session.call.id,
    waCallId,
    contact: {
      id: session.contact.id,
      name: session.contact.name,
      wa_id: session.contact.wa_id,
    },
    startedAt: session.call.started_at,
    autoTransferAt: new Date(Date.now() + IVR_TRANSFER_TIMEOUT_MS).toISOString(),
    ringTimeoutMs: IVR_TRANSFER_TIMEOUT_MS,
    transcript: [],
    source,
    alreadyAccepted: true,
  });
  emitToDashboard("call:updated", {
    id: session.call.id,
    waCallId,
    status: "ringing",
    handled_by: "unassigned",
    transfer_source: source,
  });

  if (getOnlineAgentCount() === 0) {
    await playCallTts(waCallId, "No agent is currently available. Please call again later.", "ivr:no_agent");
    setImmediate(() => endCall(waCallId).catch(() => {}));
    return;
  }

  session.ringTimer = setTimeout(async () => {
    const active = sessions.get(waCallId);
    if (!active || active.mode !== "ringing") return;
    try {
      await playCallTts(waCallId, "No agent answered. Please call again later.", "ivr:agent_timeout");
    } finally {
      setImmediate(() => endCall(waCallId).catch(() => {}));
    }
  }, IVR_TRANSFER_TIMEOUT_MS);
}

async function startVisualIvr(waCallId, { announcement, reason, source = "automatic_timeout" } = {}) {
  const session = sessions.get(waCallId);
  if (!session) throw new Error("Call session is no longer available.");
  clearTimeout(session.ringTimer);
  session.decided = true;

  closePeer(session.agentPc);
  session.agentPc = null;
  session.agentOutboundTrack = null;

  if (!session.whatsappAccepted) {
    console.log(`[call ${waCallId}] sending final accept for visual IVR`);
    await acceptCall(waCallId);
    session.whatsappAccepted = true;
  }

  session.acceptedBy = "ivr";
  session.mode = "ivr";
  const result = await query(
    "UPDATE calls SET status='connected',handled_by='ivr' WHERE id=$1 RETURNING *",
    [session.call.id]
  );
  emitToDashboard("call:updated", {
    id: session.call.id,
    waCallId,
    status: "connected",
    handled_by: "ivr",
    transfer_source: source,
    reason: reason || null,
  });

  const connected = await waitForConnected(session.pc);
  console.log(`[call ${waCallId}] visual IVR started; media connected=${connected}`);
  emitIvrStatus(session, "starting", { source });

  await startIvrSession({
    waCallId,
    callId: session.call.id,
    contact: session.contact,
    announcement,
    actions: {
      speak: (text, nodeSource) => playCallTts(waCallId, text, nodeSource),
      transferAgent: ({ team }) => offerCallToAgents(session, `ivr:${team || "all"}`),
      end: (endReason) => {
        emitIvrStatus(session, "finished", { reason: endReason });
        setTimeout(() => endCall(waCallId).catch((error) =>
          console.error(`[call ${waCallId}] IVR end failed`, error)
        ), 250);
      },
    },
  });
  return result.rows[0] || session.call;
}

export async function handleIncomingCall({ waCallId, offerSdp, contact }) {
  if (sessions.has(waCallId)) return sessions.get(waCallId).call;

  const inserted = await query(
    `INSERT INTO calls (contact_id,wa_call_id,direction,handled_by,status,consent_status)
     VALUES ($1,$2,'inbound','unassigned','ringing','not_required')
     ON CONFLICT (wa_call_id) DO NOTHING RETURNING *`,
    [contact.id, waCallId]
  );
  let call = inserted.rows[0];
  if (!call) {
    const existing = await query("SELECT * FROM calls WHERE wa_call_id=$1", [waCallId]);
    call = existing.rows[0];
    if (!call || call.status !== "ringing") return call;
  }

  let pc;
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
        sessionRef?.recorder?.feedInbound(rtp);
        sessionRef?.transcriber?.feed(rtp);
        try { sessionRef?.agentOutboundTrack?.writeRtp(rtp); } catch (_) {}
      });
    });
    pc.connectionStateChange.subscribe((state) =>
      console.log(`[call ${waCallId}] WhatsApp WebRTC state: ${state}`)
    );

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc, FAST_ICE_WAIT_MS);
    if (!pc.localDescription?.sdp) throw new Error("WebRTC answer SDP was not generated");

    const autoTransferAt = new Date(Date.now() + AGENT_RING_TIMEOUT_MS).toISOString();
    const session = {
      pc,
      call,
      recorder: noCallRecorder(),
      transcriber: null,
      outboundTrack,
      whatsappInboundTrack: null,
      agentPc: null,
      agentOutboundTrack: null,
      contact,
      ringTimer: null,
      decided: false,
      acceptedBy: null,
      whatsappAccepted: false,
      mode: "ringing",
      ttsQueue: Promise.resolve(),
      autoTransferAt,
    };
    sessionRef = session;
    sessions.set(waCallId, session);

    console.log(`[call ${waCallId}] sending pre_accept immediately`);
    await preAcceptCall(waCallId, pc.localDescription.sdp);
    console.log(`[call ${waCallId}] pre_accept completed`);

    startCallRecorder({ waCallId, recordingsDir: RECORDINGS_DIR })
      .then((recorder) => {
        if (sessions.get(waCallId) !== session) return recorder.stop();
        session.recorder = recorder;
      })
      .catch((error) => console.error(`[call ${waCallId}] recording could not start`, error));
    startTranscriptionForSession(waCallId, session);

    if (getOnlineAgentCount() > 0) {
      emitToDashboard("call:incoming", {
        id: call.id,
        waCallId,
        contact: { id: contact.id, name: contact.name, wa_id: contact.wa_id },
        startedAt: call.started_at,
        autoTransferAt,
        ringTimeoutMs: AGENT_RING_TIMEOUT_MS,
        transcript: call.transcript || [],
      });
      console.log(`[call ${waCallId}] incoming-call popup emitted to dashboard`);
      session.ringTimer = setTimeout(() => {
        startVisualIvr(waCallId, { source: "automatic_timeout" }).catch((error) =>
          console.error(`[call ${waCallId}] automatic IVR answer failed`, error)
        );
      }, AGENT_RING_TIMEOUT_MS);
    } else {
      console.log(`[call ${waCallId}] no agent online; accepting with visual IVR immediately`);
      setImmediate(() => startVisualIvr(waCallId, { source: "no_agent_online" }));
    }
    return call;
  } catch (error) {
    console.error(`[call ${waCallId}] setup failed`, {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      stack: error.stack,
    });
    closePeer(pc);
    await failCall(waCallId, call.id, error);
    throw error;
  }
}

export async function claimCallAsAgent(waCallId, user, browserOfferSdp) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) throw new Error("Call is no longer available.");
  if (!browserOfferSdp) throw new Error("Browser microphone WebRTC offer is required.");
  session.decided = true;
  clearTimeout(session.ringTimer);
  stopIvrSession(waCallId);

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
        session.recorder.feedOutbound(rtp);
        try { session.outboundTrack.writeRtp(rtp); } catch (_) {}
      });
    });
    agentPc.connectionStateChange.subscribe((state) => {
      console.log(`[call ${waCallId}] agent WebRTC state: ${state}`);
      emitToDashboard("call:agent-media", { id: session.call.id, waCallId, state });
    });

    await agentPc.setRemoteDescription({ type: "offer", sdp: browserOfferSdp });
    await agentPc.setLocalDescription(await agentPc.createAnswer());
    await waitForIce(agentPc, AGENT_ICE_WAIT_MS);
    if (!agentPc.localDescription?.sdp) throw new Error("Agent WebRTC answer SDP was not generated.");

    session.agentPc = agentPc;
    session.agentOutboundTrack = agentOutboundTrack;
    session.acceptedBy = `agent:${user.id}`;
    session.mode = "agent";
    if (!session.whatsappAccepted) {
      await acceptCall(waCallId);
      session.whatsappAccepted = true;
    }

    const result = await query(
      "UPDATE calls SET status='connected',handled_by=$1 WHERE id=$2 RETURNING *",
      [session.acceptedBy, session.call.id]
    );
    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: session.acceptedBy,
    });
    console.log(`[call ${waCallId}] agent accepted; browser bridge SDP returned`);
    return { call: result.rows[0] || session.call, answerSdp: agentPc.localDescription.sdp };
  } catch (error) {
    closePeer(agentPc);
    session.agentPc = null;
    session.agentOutboundTrack = null;
    session.acceptedBy = null;
    session.mode = "ringing";
    session.decided = false;
    setImmediate(() => startVisualIvr(waCallId, { source: "agent_bridge_failure" }).catch(() => {}));
    throw error;
  }
}

export async function transferCallToBot(waCallId, options = {}) {
  return startVisualIvr(waCallId, options);
}

export async function answerWithBot(waCallId) {
  return startVisualIvr(waCallId, { source: "automatic_timeout" });
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
    voice: result.voice,
  });
  return result;
}

async function playCallTts(waCallId, text, source = "tts") {
  const session = sessions.get(waCallId);
  if (!session || !text?.trim()) return;
  const task = async () => {
    const active = sessions.get(waCallId);
    if (!active) return;
    emitToDashboard("call:prompt-state", {
      id: active.call.id,
      waCallId,
      state: "playing",
      source,
      text,
    });
    await appendTranscript(active, "ivr", text, { source });

    let receiver;
    try {
      const { audio, provider, voice } = await synthesizeWithMetadata(text.trim());
      receiver = dgram.createSocket("udp4");
      await new Promise((resolve, reject) => {
        receiver.once("error", reject);
        receiver.bind(0, "127.0.0.1", resolve);
      });
      const port = receiver.address().port;
      receiver.on("message", (data) => {
        try {
          const packet = RtpPacket.deSerialize(data);
          packet.header.payloadType = 111;
          active.recorder.feedOutbound(packet);
          active.outboundTrack.writeRtp(packet);
        } catch (error) {
          console.warn(`[call ${waCallId}] invalid generated RTP packet`, error.message);
        }
      });

      const ffmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "warning", "-re", "-i", "pipe:0",
        "-vn", "-acodec", "libopus", "-ar", "48000", "-ac", "2",
        "-application", "voip", "-frame_duration", "20", "-payload_type", "111",
        "-f", "rtp", `rtp://127.0.0.1:${port}`,
      ]);
      ffmpeg.stderr.on("data", (chunk) => {
        const value = chunk.toString().trim();
        if (value) console.warn(`[call ${waCallId}] TTS encoder: ${value}`);
      });
      const completed = new Promise((resolve, reject) => {
        ffmpeg.once("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`)));
        ffmpeg.once("error", reject);
      });
      ffmpeg.stdin.end(audio);
      await completed;
      console.log(`[call ${waCallId}] TTS finished source=${source} provider=${provider} voice=${voice}`);
    } finally {
      try { receiver?.close(); } catch (_) {}
      emitToDashboard("call:prompt-state", {
        id: active.call.id,
        waCallId,
        state: "idle",
        source,
      });
    }
  };
  session.ttsQueue = session.ttsQueue.then(task, task);
  return session.ttsQueue;
}

async function closeSessionMedia(session) {
  if (!session) return null;
  clearTimeout(session.ringTimer);
  stopIvrSession(session.call.wa_call_id);
  session.transcriber?.stop();
  closePeer(session.agentPc);
  closePeer(session.pc);
  try {
    return await session.recorder.stop();
  } catch (error) {
    console.error(`[call ${session.call.wa_call_id}] recording finalization failed`, error);
    return null;
  }
}

export async function handleCallTerminated(waCallId, outcome = "terminate") {
  const session = sessions.get(waCallId);
  const recordingPath = await closeSessionMedia(session);
  const existing = await query("SELECT id,status FROM calls WHERE wa_call_id=$1", [waCallId]);
  const row = existing.rows[0];
  sessions.delete(waCallId);
  if (!row) return;

  let finalStatus = "missed";
  if (outcome === "reject") finalStatus = "rejected";
  else if (row.status === "connected" || session?.whatsappAccepted) finalStatus = "ended";
  else if (row.status === "failed") finalStatus = "failed";

  const result = await query(
    `UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()),recording_path=COALESCE($2,recording_path)
      WHERE wa_call_id=$3 RETURNING id,status,recording_path`,
    [finalStatus, recordingPath, waCallId]
  );
  if (result.rows[0]) {
    emitToDashboard("call:updated", {
      id: result.rows[0].id,
      waCallId,
      status: result.rows[0].status,
      recording_available: Boolean(result.rows[0].recording_path),
    });
  }
}

export async function rejectIncomingCall(waCallId, reason) {
  const session = sessions.get(waCallId);
  const recordingPath = await closeSessionMedia(session);
  try { await rejectCall(waCallId); } catch (_) {}
  const result = await query(
    `UPDATE calls SET status='rejected',ended_at=now(),recording_path=COALESCE($2,recording_path)
      WHERE wa_call_id=$1 RETURNING id`,
    [waCallId, recordingPath]
  );
  sessions.delete(waCallId);
  if (result.rows[0]) {
    emitToDashboard("call:updated", { id: result.rows[0].id, waCallId, status: "rejected", reason });
  }
}

export async function endCall(waCallId) {
  try { await terminateCall(waCallId); } finally {
    await handleCallTerminated(waCallId, "terminate");
  }
}

async function failCall(waCallId, callId, error) {
  const session = sessions.get(waCallId);
  const recordingPath = await closeSessionMedia(session);
  try { await rejectCall(waCallId); } catch (_) {}
  await query(
    `UPDATE calls SET status='failed',ended_at=now(),recording_path=COALESCE($2,recording_path) WHERE id=$1`,
    [callId, recordingPath]
  );
  sessions.delete(waCallId);
  emitToDashboard("call:updated", {
    id: callId,
    waCallId,
    status: "failed",
    error: error?.response?.data || error?.message || String(error),
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
    await query("UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()) WHERE id=$2", [status, row.id]);
    emitToDashboard("call:updated", { id: row.id, waCallId: row.wa_call_id, status });
  }
}

setInterval(() => {
  reconcileStaleCalls().catch((error) => console.error("[calls] stale sweep failed", error));
}, 300000);
