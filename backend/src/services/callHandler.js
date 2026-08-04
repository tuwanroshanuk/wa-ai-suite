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
import { synthesize } from "./tts.js";
import { emitToDashboard, getOnlineAgentCount } from "../sockets.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 15000);
const ICE_MIN_PORT = Number(process.env.WEBRTC_ICE_MIN_PORT || 50000);
const ICE_MAX_PORT = Number(process.env.WEBRTC_ICE_MAX_PORT || 50010);
const FAST_ICE_WAIT_MS = Number(process.env.WEBRTC_FAST_ICE_WAIT_MS || 200);
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

  // On a Docker host the public address is not a local interface. Werift can
  // still advertise it as an additional host candidate while binding UDP on
  // the container interface. Set this to the VPS public IPv4 in Dokploy.
  if (process.env.WEBRTC_PUBLIC_IP) {
    config.iceAdditionalHostAddresses = [process.env.WEBRTC_PUBLIC_IP];
  }

  return new RTCPeerConnection(config);
}

async function shortIceWait(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    let subscription;
    const timer = setTimeout(() => {
      subscription?.unSubscribe?.();
      resolve();
    }, FAST_ICE_WAIT_MS);
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
  let recording;
  try {
    console.log(`[call ${waCallId}] preparing WebRTC answer`);
    pc = makePeerConnection();
    const outboundTrack = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(outboundTrack, { direction: "sendrecv" });
    recording = startRecording(waCallId);

    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => recording.feed(rtp));
    });

    pc.connectionStateChange.subscribe((state) => {
      console.log(`[call ${waCallId}] WebRTC state: ${state}`);
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());

    // Meta is terminating these calls around 1–2 seconds after CONNECT. The
    // old code waited up to 8 seconds for ICE before pre_accept, so Meta never
    // received a response in time. Give gathering only a tiny head start and
    // pre_accept immediately with the current SDP.
    await shortIceWait(pc);
    if (!pc.localDescription?.sdp) throw new Error("WebRTC answer SDP was not generated");

    const session = {
      pc,
      call,
      recording,
      outboundTrack,
      contact,
      ringTimer: null,
      decided: false,
    };
    sessions.set(waCallId, session);

    console.log(`[call ${waCallId}] sending pre_accept immediately`);
    await preAcceptCall(waCallId, pc.localDescription.sdp);
    console.log(`[call ${waCallId}] pre_accept completed`);

    if (getOnlineAgentCount() > 0) {
      emitToDashboard("call:incoming", {
        id: call.id,
        waCallId,
        contact: { id: contact.id, name: contact.name, wa_id: contact.wa_id },
        startedAt: call.started_at,
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
    if (recording) recording.stop();
    try { pc?.close(); } catch (_) {}
    await failCall(waCallId, call.id, err);
    throw err;
  }
}

export async function claimCallAsAgent(waCallId, user) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) throw new Error("Call is no longer available.");

  session.decided = true;
  clearTimeout(session.ringTimer);
  try {
    await acceptCall(waCallId);
    const connected = await waitForConnected(session.pc);
    const handledBy = `agent:${user.id}`;
    const result = await query(
      "UPDATE calls SET status='connected',handled_by=$1 WHERE id=$2 RETURNING *",
      [handledBy, session.call.id]
    );
    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: handledBy,
      media_connected: connected,
    });
    return result.rows[0] || session.call;
  } catch (err) {
    await failCall(waCallId, session.call.id, err);
    throw err;
  }
}

export async function answerWithBot(waCallId) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) return;

  session.decided = true;
  clearTimeout(session.ringTimer);
  try {
    console.log(`[call ${waCallId}] sending final accept for AI bot`);
    await acceptCall(waCallId);
    await query("UPDATE calls SET status='connected',handled_by='bot' WHERE id=$1", [
      session.call.id,
    ]);
    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: "bot",
    });

    const connected = await waitForConnected(session.pc);
    console.log(`[call ${waCallId}] media connected=${connected}`);
    await playGreeting(
      waCallId,
      process.env.CALL_GREETING ||
        "Hi! Thanks for calling. This is our AI assistant. How can I help?"
    );
  } catch (err) {
    console.error(`[call ${waCallId}] bot answer failed`, {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    await failCall(waCallId, session.call.id, err);
  }
}

export async function handleCallTerminated(waCallId, outcome = "terminate") {
  const session = sessions.get(waCallId);
  let recordingPath = null;
  if (session) {
    clearTimeout(session.ringTimer);
    session.recording.stop();
    recordingPath = session.recording.outputPath;
    try { session.pc.close(); } catch (_) {}
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
    session.recording.stop();
    try { session.pc.close(); } catch (_) {}
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
  await terminateCall(waCallId);
  await handleCallTerminated(waCallId, "terminate");
}

async function failCall(waCallId, callId, err) {
  const session = sessions.get(waCallId);
  if (session) {
    clearTimeout(session.ringTimer);
    session.recording.stop();
    try { session.pc.close(); } catch (_) {}
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
    await query("UPDATE calls SET status=$1,ended_at=COALESCE(ended_at,now()) WHERE id=$2", [status, row.id]);
    emitToDashboard("call:updated", { id: row.id, waCallId: row.wa_call_id, status });
  }
}

setInterval(() => {
  reconcileStaleCalls().catch((err) => console.error("[calls] stale sweep failed", err));
}, 300000);

async function playGreeting(waCallId, text) {
  const session = sessions.get(waCallId);
  if (!session) return;

  const mp3 = await synthesize(text);
  const udp = dgram.createSocket("udp4");
  const port = 30000 + Math.floor(Math.random() * 9000);
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, "127.0.0.1", resolve);
  });

  udp.on("message", (data) => {
    try {
      const packet = RtpPacket.deSerialize(data);
      packet.header.payloadType = 111;
      session.outboundTrack.writeRtp(packet);
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
  ffmpeg.stdin.end(mp3);
  ffmpeg.stderr.on("data", (data) =>
    console.error(`[call ${waCallId}] ffmpeg TTS: ${data.toString().trim()}`)
  );
  await new Promise((resolve) => {
    ffmpeg.once("close", resolve);
    ffmpeg.once("error", resolve);
  });
  udp.close();
  console.log(`[call ${waCallId}] TTS greeting streamed into WhatsApp call`);
}

function startRecording(waCallId) {
  const udpPort = 40000 + Math.floor(Math.random() * 10000);
  const socket = dgram.createSocket("udp4");
  const outputPath = path.join(RECORDINGS_DIR, `${waCallId}.wav`);
  const sdpPath = path.join(RECORDINGS_DIR, `${waCallId}.sdp`);
  fs.writeFileSync(
    sdpPath,
    [
      "v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=recording",
      "c=IN IP4 127.0.0.1", "t=0 0", `m=audio ${udpPort} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
    ].join("\n")
  );
  const ffmpeg = spawn("ffmpeg", [
    "-protocol_whitelist", "file,udp,rtp", "-i", sdpPath, "-y", outputPath,
  ]);
  ffmpeg.stderr.on("data", () => {});
  return {
    outputPath,
    feed(rtp) {
      try { socket.send(rtp.serialize(), udpPort, "127.0.0.1"); } catch (_) {}
    },
    stop() {
      try { ffmpeg.kill("SIGINT"); } catch (_) {}
      try { socket.close(); } catch (_) {}
    },
  };
}
