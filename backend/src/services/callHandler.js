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
import { generateReply, transcribeAudio } from "./gemini.js";
import { createGeminiLiveSession } from "./geminiLive.js";
import { getAiAgentRuntime } from "./aiAgent.js";
import { startLiveTranscriber } from "./callTranscriber.js";
import { startCallRecorder, noCallRecorder } from "./callRecorder.js";
import { emitToDashboard, getOnlineAgentCount } from "../sockets.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 15000);
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

  const entry = {
    role,
    text: value,
    at: new Date().toISOString(),
    ...extra,
  };

  await query(
    `UPDATE calls
        SET transcript = COALESCE(transcript,'[]'::jsonb) || $1::jsonb
      WHERE id=$2`,
    [JSON.stringify([entry]), session.call.id]
  );

  emitToDashboard("call:transcript", {
    id: session.call.id,
    waCallId: session.call.wa_call_id,
    entry,
  });
}

function emitAiStatus(session, state, detail = {}) {
  emitToDashboard("call:ai-status", {
    id: session.call.id,
    waCallId: session.call.wa_call_id,
    state,
    ...detail,
  });
}

async function processCallerTurn(waCallId, wavBuffer) {
  const session = sessions.get(waCallId);
  if (!session || session.aiEngine === "gemini_live") return;

  let transcript;
  try {
    transcript = await transcribeAudio(wavBuffer, "audio/wav");
  } catch (err) {
    console.error(`[call ${waCallId}] local caller transcription failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    emitAiStatus(session, "transcription_error", { error: err.message });
    return;
  }

  if (!transcript || transcript.length < 2) return;
  console.log(`[call ${waCallId}] caller transcript: ${transcript}`);
  await appendTranscript(session, "caller", transcript, { source: "local_whisper" });

  if (session.mode !== "bot") return;

  const runtime = await getAiAgentRuntime(transcript);
  if (!runtime.settings.enabled) return;

  session.aiHistory.push({ role: "user", text: transcript });
  session.aiHistory = session.aiHistory.slice(-16);

  let reply;
  try {
    emitAiStatus(session, "thinking", { model: runtime.settings.textModel });
    reply = await generateReply(session.aiHistory, runtime.systemPrompt, {
      model: runtime.settings.textModel,
      maxOutputTokens: 300,
    });
  } catch (err) {
    const apiMessage = err.response?.data?.error?.message || err.message;
    console.error(`[call ${waCallId}] AI reply generation failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: apiMessage,
    });
    emitAiStatus(session, "model_error", {
      status: err.response?.status,
      error: apiMessage,
    });

    if (!session.aiUnavailableAnnounced) {
      session.aiUnavailableAnnounced = true;
      try {
        await playCallTts(waCallId, runtime.settings.fallbackMessage, "ai_unavailable");
      } catch (_) {}
    }
    return;
  }

  if (!reply) return;
  session.aiHistory.push({ role: "assistant", text: reply });
  session.aiHistory = session.aiHistory.slice(-16);
  await appendTranscript(session, "assistant", reply, {
    source: runtime.settings.textModel,
  });

  try {
    await playCallTts(waCallId, reply, "ai_reply");
    emitAiStatus(session, "listening", { engine: "standard" });
  } catch (err) {
    console.error(`[call ${waCallId}] AI voice reply failed`, err);
    emitAiStatus(session, "voice_error", { error: err.message });
  }
}

function startTranscriptionForSession(waCallId, session) {
  startLiveTranscriber({
    waCallId,
    recordingsDir: RECORDINGS_DIR,
    onTurn: (wavBuffer) => processCallerTurn(waCallId, wavBuffer),
    onPcmChunk: (chunk) => {
      try { session.liveSession?.sendAudio(chunk); } catch (_) {}
    },
  })
    .then((transcriber) => {
      if (sessions.get(waCallId) !== session) {
        transcriber.stop();
        return;
      }
      session.transcriber = transcriber;
    })
    .catch((err) => {
      console.error(`[call ${waCallId}] live caller audio decoder could not start`, err);
    });
}

async function startPcmToWhatsApp(session) {
  const receiver = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.bind(0, "127.0.0.1", resolve);
  });
  const port = receiver.address().port;

  receiver.on("message", (data) => {
    try {
      const packet = RtpPacket.deSerialize(data);
      packet.header.payloadType = 111;
      session.outboundTrack.writeRtp(packet);
    } catch (err) {
      console.warn(`[call ${session.call.wa_call_id}] invalid Gemini audio RTP`, err.message);
    }
  });

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
    "-vn", "-acodec", "libopus", "-ar", "48000", "-ac", "2",
    "-application", "voip", "-frame_duration", "20", "-payload_type", "111",
    "-f", "rtp", `rtp://127.0.0.1:${port}`,
  ]);

  ffmpeg.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.warn(`[call ${session.call.wa_call_id}] Gemini audio encoder: ${text}`);
  });
  ffmpeg.once("error", (err) => {
    console.error(`[call ${session.call.wa_call_id}] Gemini audio encoder failed`, err);
  });

  let closed = false;
  return {
    write(pcm24k) {
      if (closed || !pcm24k?.length || ffmpeg.stdin.destroyed) return;
      try { ffmpeg.stdin.write(pcm24k); } catch (_) {}
    },
    close() {
      if (closed) return;
      closed = true;
      try { ffmpeg.stdin.end(); } catch (_) {}
      setTimeout(() => {
        try { ffmpeg.kill("SIGINT"); } catch (_) {}
        try { receiver.close(); } catch (_) {}
      }, 250);
    },
  };
}

async function startGeminiLiveForSession(waCallId, session, runtime) {
  const writer = await startPcmToWhatsApp(session);
  session.liveAudioWriter = writer;

  const live = await createGeminiLiveSession({
    model: runtime.settings.liveModel,
    voice: runtime.settings.liveVoice,
    thinkingLevel: runtime.settings.thinkingLevel,
    systemPrompt: runtime.systemPrompt,
    onAudio: (audio) => writer.write(audio),
    onInputTranscript: (text) => {
      appendTranscript(session, "caller", text, { source: "gemini_live" }).catch((err) =>
        console.error(`[call ${waCallId}] live input transcript save failed`, err)
      );
    },
    onOutputTranscript: (text) => {
      appendTranscript(session, "assistant", text, {
        source: runtime.settings.liveModel,
      }).catch((err) =>
        console.error(`[call ${waCallId}] live output transcript save failed`, err)
      );
    },
    onInterrupted: () => emitAiStatus(session, "interrupted"),
    onError: (err) => {
      console.error(`[call ${waCallId}] Gemini Live error`, err);
      emitAiStatus(session, "live_error", { error: err.message });
    },
    onClose: ({ code, reason }) => {
      console.warn(`[call ${waCallId}] Gemini Live closed code=${code} reason=${reason}`);
      emitAiStatus(session, "live_closed", { code, reason });
    },
  });

  session.liveSession = live;
  emitAiStatus(session, "listening", {
    engine: "gemini_live",
    model: runtime.settings.liveModel,
    voice: runtime.settings.liveVoice,
  });
  console.log(
    `[call ${waCallId}] Gemini Live connected model=${runtime.settings.liveModel} voice=${runtime.settings.liveVoice}`
  );
  return live;
}

export async function handleIncomingCall({ waCallId, offerSdp, contact }) {
  if (sessions.has(waCallId)) return sessions.get(waCallId).call;

  const inserted = await query(
    `INSERT INTO calls (contact_id,wa_call_id,direction,handled_by,status,consent_status)
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
        sessionRef?.recorder?.feed(rtp);
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
      mode: "ringing",
      aiEngine: null,
      aiHistory: [],
      aiUnavailableAnnounced: false,
      liveSession: null,
      liveAudioWriter: null,
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
        if (sessions.get(waCallId) !== session) {
          recorder.stop();
          return;
        }
        session.recorder = recorder;
      })
      .catch((err) => console.error(`[call ${waCallId}] recording could not start`, err));

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
    session.aiEngine = null;

    await acceptCall(waCallId);

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
  { announcement, reason, source = "manual" } = {}
) {
  const session = sessions.get(waCallId);
  if (!session) throw new Error("Call session is no longer available.");

  clearTimeout(session.ringTimer);
  session.decided = true;

  if (session.mode === "bot") return session.call;

  const wasAccepted = Boolean(session.acceptedBy);
  closePeer(session.agentPc);
  session.agentPc = null;
  session.agentOutboundTrack = null;

  if (!wasAccepted) {
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

  const runtime = await getAiAgentRuntime("", { allKnowledge: true });
  const spokenAnnouncement = announcement || runtime.settings.greeting;
  session.aiEngine = runtime.settings.engine;

  if (runtime.settings.engine === "gemini_live") {
    try {
      const live = await startGeminiLiveForSession(waCallId, session, runtime);
      live.sendText(spokenAnnouncement);
      return result.rows[0] || session.call;
    } catch (err) {
      console.error(`[call ${waCallId}] Gemini Live unavailable; using standard pipeline`, {
        message: err.message,
        status: err.response?.status,
      });
      session.liveSession?.close();
      session.liveAudioWriter?.close();
      session.liveSession = null;
      session.liveAudioWriter = null;
      session.aiEngine = "standard";
      emitAiStatus(session, "live_fallback", { error: err.message });
    }
  }

  setImmediate(() => {
    playCallTts(waCallId, spokenAnnouncement, source).catch((err) =>
      console.error(`[call ${waCallId}] transfer announcement failed`, err)
    );
  });
  emitAiStatus(session, "listening", {
    engine: "standard",
    model: runtime.settings.textModel,
  });
  return result.rows[0] || session.call;
}

export async function answerWithBot(waCallId) {
  return transferCallToBot(waCallId, { source: "automatic_timeout" });
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
          active.outboundTrack.writeRtp(packet);
        } catch (err) {
          console.warn(`[call ${waCallId}] invalid generated RTP packet`, err.message);
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
        ffmpeg.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exited ${code}`))
        );
        ffmpeg.once("error", reject);
      });

      ffmpeg.stdin.end(audio);
      await completed;
      console.log(`[call ${waCallId}] TTS finished source=${source} provider=${provider} voice=${voice}`);
    } finally {
      try { receiver?.close(); } catch (_) {}
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

async function closeSessionMedia(session) {
  if (!session) return null;
  clearTimeout(session.ringTimer);
  session.transcriber?.stop();
  session.liveSession?.close();
  session.liveAudioWriter?.close();
  closePeer(session.agentPc);
  closePeer(session.pc);
  try {
    return await session.recorder.stop();
  } catch (err) {
    console.error(`[call ${session.call.wa_call_id}] recording finalization failed`, err);
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
  else if (row.status === "connected") finalStatus = "ended";
  else if (row.status === "failed") finalStatus = "failed";

  const result = await query(
    `UPDATE calls
        SET status=$1,ended_at=COALESCE(ended_at,now()),
            recording_path=COALESCE($2,recording_path)
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
    `UPDATE calls
        SET status='rejected',ended_at=now(),recording_path=COALESCE($2,recording_path)
      WHERE wa_call_id=$1 RETURNING id`,
    [waCallId, recordingPath]
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
  const recordingPath = await closeSessionMedia(session);
  try { await rejectCall(waCallId); } catch (_) {}
  await query(
    `UPDATE calls
        SET status='failed',ended_at=now(),recording_path=COALESCE($2,recording_path)
      WHERE id=$1`,
    [callId, recordingPath]
  );
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
    await query(
      "UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()) WHERE id=$2",
      [status, row.id]
    );
    emitToDashboard("call:updated", { id: row.id, waCallId: row.wa_call_id, status });
  }
}

setInterval(() => {
  reconcileStaleCalls().catch((err) => console.error("[calls] stale sweep failed", err));
}, 300000);
