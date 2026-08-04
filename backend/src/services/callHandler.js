import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dgram from "dgram";
import { RTCPeerConnection, RTCRtpCodecParameters } from "werift";
import { query } from "../db/index.js";
import { preAcceptCall, acceptCall, rejectCall, terminateCall } from "./whatsapp.js";
import { synthesize } from "./tts.js";
import { emitToDashboard } from "../sockets.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 20000);
const STALE_RINGING_MINUTES = Number(process.env.STALE_RINGING_MINUTES || 5);
const STALE_CONNECTED_HOURS = Number(process.env.STALE_CONNECTED_HOURS || 12);

// Active WebRTC sessions are process-local. Never classify a fresh database
// row as missed merely because this particular process cannot see a session;
// another replica may own it, or the Meta webhook may still be in flight.
const sessions = new Map();

function makePeerConnection() {
  return new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
          payloadType: 111,
        }),
      ],
    },
  });
}

export async function handleIncomingCall({ waCallId, offerSdp, contact }) {
  // Meta can retry the same connect webhook. Do not reset an existing
  // connected/ended call back to ringing and do not create a second session.
  if (sessions.has(waCallId)) return sessions.get(waCallId).call;

  const inserted = await query(
    `INSERT INTO calls (contact_id, wa_call_id, direction, handled_by, status, consent_status)
     VALUES ($1, $2, 'inbound', 'unassigned', 'ringing', 'not_required')
     ON CONFLICT (wa_call_id) DO NOTHING
     RETURNING *`,
    [contact.id, waCallId]
  );

  let call = inserted.rows[0];
  if (!call) {
    const existing = await query("SELECT * FROM calls WHERE wa_call_id = $1", [waCallId]);
    call = existing.rows[0];
    if (!call || call.status !== "ringing") return call;
  }

  try {
    const pc = makePeerConnection();
    const recording = startRecording(waCallId);

    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => recording.feed(rtp));
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await preAcceptCall(waCallId, pc.localDescription.sdp);

    const session = { pc, call, recording, contact, ringTimer: null, decided: false };
    sessions.set(waCallId, session);

    emitToDashboard("call:incoming", {
      id: call.id,
      waCallId,
      contact: { id: contact.id, name: contact.name, wa_id: contact.wa_id },
      ringTimeoutMs: AGENT_RING_TIMEOUT_MS,
      startedAt: call.started_at,
    });

    session.ringTimer = setTimeout(() => {
      answerWithBot(waCallId).catch((err) =>
        console.error(`[call ${waCallId}] auto-answer-with-bot failed`, err)
      );
    }, AGENT_RING_TIMEOUT_MS);

    return call;
  } catch (err) {
    console.error(`[call ${waCallId}] failed to set up incoming call`, err);
    await failCall(waCallId, call.id, err);
    throw err;
  }
}

export async function claimCallAsAgent(waCallId, user) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) {
    throw new Error("Call is no longer available to answer (already handled or ended).");
  }

  session.decided = true;
  clearTimeout(session.ringTimer);

  try {
    await acceptCall(waCallId, session.pc.localDescription.sdp);
    const handledBy = `agent:${user.id}`;
    const result = await query(
      "UPDATE calls SET status = 'connected', handled_by = $1 WHERE id = $2 RETURNING *",
      [handledBy, session.call.id]
    );
    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: handledBy,
    });
    return result.rows[0] || session.call;
  } catch (err) {
    session.decided = false;
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
    await acceptCall(waCallId, session.pc.localDescription.sdp);
    await query(
      "UPDATE calls SET status = 'connected', handled_by = 'bot' WHERE id = $1",
      [session.call.id]
    );
    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: "bot",
    });

    // Greeting generation currently exists, but outbound RTP injection still
    // needs to be implemented for the installed werift version.
    await playGreeting(
      waCallId,
      "Hi! Thanks for calling. This is our AI assistant, how can I help?"
    );
  } catch (err) {
    console.error(`[call ${waCallId}] bot failed to answer`, err);
    await failCall(waCallId, session.call.id, err);
  }
}

/**
 * Finalize a call even when its in-memory session is unavailable. Meta may
 * deliver termination to another replica or after a restart, so returning
 * early here leaves rows stuck or later misclassified as missed.
 */
export async function handleCallTerminated(waCallId, outcome = "terminate") {
  const session = sessions.get(waCallId);
  let recordingPath = null;

  if (session) {
    clearTimeout(session.ringTimer);
    session.recording.stop();
    recordingPath = session.recording.outputPath;
    try {
      session.pc.close();
    } catch (_) {}
  }

  const existing = await query(
    "SELECT id, status, handled_by, recording_path FROM calls WHERE wa_call_id = $1",
    [waCallId]
  );
  const row = existing.rows[0];
  sessions.delete(waCallId);
  if (!row) return;

  let finalStatus;
  if (outcome === "timeout") finalStatus = "missed";
  else if (outcome === "reject") finalStatus = "rejected";
  else finalStatus = row.status === "connected" ? "ended" : "missed";

  // Never downgrade a call already recorded as failed/rejected/ended.
  if (["failed", "rejected", "ended"].includes(row.status)) finalStatus = row.status;

  const result = await query(
    `UPDATE calls
       SET status = $1,
           ended_at = COALESCE(ended_at, now()),
           recording_path = COALESCE($2, recording_path)
     WHERE wa_call_id = $3
     RETURNING id, status`,
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
    try {
      session.pc.close();
    } catch (_) {}
  }

  try {
    await rejectCall(waCallId);
  } finally {
    const result = await query(
      "UPDATE calls SET status = 'rejected', ended_at = now() WHERE wa_call_id = $1 RETURNING id",
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
    try {
      session.pc.close();
    } catch (_) {}
  }

  try {
    await rejectCall(waCallId);
  } catch (_) {}

  await query("UPDATE calls SET status = 'failed', ended_at = now() WHERE id = $1", [callId]);
  sessions.delete(waCallId);
  emitToDashboard("call:updated", {
    id: callId,
    waCallId,
    status: "failed",
    error: err?.response?.data || err?.message || String(err),
  });
}

/**
 * Reconcile only genuinely old rows. The old implementation marked every
 * session not found in this process as missed, which broke active calls on
 * restarts and multi-replica deployments.
 */
export async function reconcileStaleCalls() {
  const stale = await query(
    `SELECT id, wa_call_id, status
       FROM calls
      WHERE (status = 'ringing' AND started_at < now() - ($1 * interval '1 minute'))
         OR (status = 'connected' AND started_at < now() - ($2 * interval '1 hour'))`,
    [STALE_RINGING_MINUTES, STALE_CONNECTED_HOURS]
  );

  let reconciled = 0;
  for (const row of stale.rows) {
    if (sessions.has(row.wa_call_id)) continue;
    try {
      await terminateCall(row.wa_call_id);
    } catch (_) {}

    const finalStatus = row.status === "connected" ? "ended" : "missed";
    await query(
      "UPDATE calls SET status = $1, ended_at = COALESCE(ended_at, now()) WHERE id = $2",
      [finalStatus, row.id]
    );
    emitToDashboard("call:updated", {
      id: row.id,
      waCallId: row.wa_call_id,
      status: finalStatus,
    });
    reconciled += 1;
  }

  if (reconciled) console.log(`[calls] reconciled ${reconciled} genuinely stale call(s)`);
}

// A five-minute cadence matches the minimum stale ringing threshold and
// avoids racing fresh Meta webhook events.
setInterval(() => {
  reconcileStaleCalls().catch((err) => console.error("[calls] stale-call sweep failed", err));
}, 300000);

async function playGreeting(waCallId, text) {
  const session = sessions.get(waCallId);
  if (!session) return;
  const mp3 = await synthesize(text);
  console.log(
    `[call ${waCallId}] TTS greeting generated (${mp3.length} bytes) - wire into outbound track`
  );
}

function startRecording(waCallId) {
  const udpPort = 40000 + Math.floor(Math.random() * 10000);
  const socket = dgram.createSocket("udp4");
  const outputPath = path.join(RECORDINGS_DIR, `${waCallId}.wav`);
  const sdpPath = path.join(RECORDINGS_DIR, `${waCallId}.sdp`);

  fs.writeFileSync(
    sdpPath,
    [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=recording",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${udpPort} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
    ].join("\n")
  );

  const ffmpeg = spawn("ffmpeg", [
    "-protocol_whitelist",
    "file,udp,rtp",
    "-i",
    sdpPath,
    "-y",
    outputPath,
  ]);
  ffmpeg.stderr.on("data", () => {});

  return {
    outputPath,
    feed(rtp) {
      try {
        socket.send(rtp.serialize(), udpPort, "127.0.0.1");
      } catch (_) {}
    },
    stop() {
      try {
        ffmpeg.kill("SIGINT");
        socket.close();
      } catch (_) {}
    },
  };
}
