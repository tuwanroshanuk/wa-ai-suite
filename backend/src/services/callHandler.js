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

// How long an incoming call rings on the dashboard before we auto-route it
// to the bot. Configurable via env; defaults to 20s.
const AGENT_RING_TIMEOUT_MS = Number(process.env.AGENT_RING_TIMEOUT_MS || 20000);

// Active call sessions keyed by WhatsApp's call_id.
// Each session: { pc, call, recording, contact, ringTimer, decided }
//
// IMPORTANT: this is in-memory only. If the backend process restarts (a
// redeploy, a crash, `docker compose up --build`, nodemon/--watch reload,
// etc.) every entry here is lost - including the werift peer connection and
// the setTimeout that would have auto-routed the call to the bot. There is
// no way to resume a WebRTC session after the process that held it is gone,
// so any call left at status='ringing' or 'connected' from a *previous*
// process lifetime is permanently stuck and must be reconciled below,
// otherwise it sits there forever and the dashboard's "Answer" button 409s
// on it (no session to answer).
const sessions = new Map();

// WhatsApp Calling uses Opus. werift needs the codec explicitly registered
// (payloadType 111 is the de-facto standard dynamic PT WhatsApp/Meta send in
// their SDP offers) or SDP negotiation silently fails and the peer connection
// never completes - which is why calls were getting stuck at "ringing".
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

/**
 * Called from routes/webhook.js when Meta sends a `connect` call event
 * (an inbound call with an SDP offer).
 *
 * Flow:
 *  1. Create the call row (status='ringing') and a WebRTC peer connection,
 *     set the remote offer, and pre_accept immediately so media is ready
 *     the moment anyone (agent or bot) decides to answer.
 *  2. Notify the dashboard in real time (`call:incoming`) so an agent has
 *     AGENT_RING_TIMEOUT_MS to click "Answer".
 *  3. If nobody answers in time, auto-route to the bot (answerWithBot).
 *
 * Any failure along the way rejects the call and marks it 'failed' instead
 * of leaving it stuck at 'ringing' forever.
 */
export async function handleIncomingCall({ waCallId, fromWaId, offerSdp, contact }) {
  const callRow = await query(
    `INSERT INTO calls (contact_id, wa_call_id, direction, handled_by, status, consent_status)
     VALUES ($1, $2, 'inbound', 'unassigned', 'ringing', 'not_required')
     ON CONFLICT (wa_call_id) DO UPDATE SET status = 'ringing'
     RETURNING *`,
    [contact.id, waCallId]
  );
  const call = callRow.rows[0];

  try {
    const pc = makePeerConnection();
    const recording = startRecording(waCallId);

    pc.onTrack.subscribe((track) => {
      if (track.kind !== "audio") return;
      track.onReceiveRtp.subscribe((rtp) => {
        recording.feed(rtp);
      });
    });

    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Early media / ringback - lets the call stay "ringing" on the caller's
    // side while we decide who answers, per WhatsApp's two-step accept flow.
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
      answerWithBot(waCallId).catch((err) => {
        console.error(`[call ${waCallId}] auto-answer-with-bot failed`, err);
      });
    }, AGENT_RING_TIMEOUT_MS);

    return call;
  } catch (err) {
    console.error(`[call ${waCallId}] failed to set up incoming call`, err);
    await failCall(waCallId, call.id, err);
    throw err;
  }
}

/**
 * An agent on the dashboard claims a still-ringing call within the ring
 * window. Cancels the auto-bot timer and formally accepts the call.
 *
 * NOTE: this finalizes the WhatsApp-side call (handled_by is now this
 * agent) and audio is flowing into our werift peer connection. Actually
 * bridging that audio into the agent's browser tab (two-way) is the
 * separate WebRTC-bridge milestone described in routes/calls.js /take-over
 * - not yet built. Until that bridge exists, "answering as agent" reserves
 * the call for the agent and stops the bot from taking it, but does not
 * yet pipe live audio to the agent's browser.
 */
export async function claimCallAsAgent(waCallId, user) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) {
    throw new Error("Call is no longer available to answer (already handled or ended).");
  }
  session.decided = true;
  clearTimeout(session.ringTimer);

  await acceptCall(waCallId, session.pc.localDescription.sdp);

  const handledBy = `agent:${user.id}`;
  await query("UPDATE calls SET status = 'connected', handled_by = $1 WHERE id = $2", [
    handledBy,
    session.call.id,
  ]);

  emitToDashboard("call:updated", {
    id: session.call.id,
    waCallId,
    status: "connected",
    handled_by: handledBy,
  });

  return session.call;
}

/**
 * No agent answered in time (or the bot is configured to answer instantly
 * for this contact) - accept the call as the AI bot and greet the caller.
 */
export async function answerWithBot(waCallId) {
  const session = sessions.get(waCallId);
  if (!session || session.decided) return;
  session.decided = true;
  clearTimeout(session.ringTimer);

  try {
    await acceptCall(waCallId, session.pc.localDescription.sdp);

    await query("UPDATE calls SET status = 'connected', handled_by = 'bot' WHERE id = $1", [
      session.call.id,
    ]);

    emitToDashboard("call:updated", {
      id: session.call.id,
      waCallId,
      status: "connected",
      handled_by: "bot",
    });

    // Greet the caller. See the docstring on playGreeting re: verifying
    // in-call audio injection with your werift version.
    await playGreeting(waCallId, `Hi! Thanks for calling. This is our AI assistant, how can I help?`);
  } catch (err) {
    console.error(`[call ${waCallId}] bot failed to answer`, err);
    await failCall(waCallId, session.call.id, err);
  }
}

export async function handleCallTerminated(waCallId) {
  const session = sessions.get(waCallId);
  if (!session) return;
  clearTimeout(session.ringTimer);
  session.recording.stop();
  try {
    session.pc.close();
  } catch (_) {}

  const finalPath = session.recording.outputPath;
  const result = await query(
    "UPDATE calls SET status = 'ended', ended_at = now(), recording_path = $1 WHERE wa_call_id = $2 RETURNING id",
    [finalPath, waCallId]
  );
  sessions.delete(waCallId);

  if (result.rows[0]) {
    emitToDashboard("call:updated", { id: result.rows[0].id, waCallId, status: "ended" });
  }
}

export async function rejectIncomingCall(waCallId, reason) {
  const session = sessions.get(waCallId);
  if (session) clearTimeout(session.ringTimer);
  await rejectCall(waCallId);
  const result = await query(
    "UPDATE calls SET status = 'rejected' WHERE wa_call_id = $1 RETURNING id",
    [waCallId]
  );
  sessions.delete(waCallId);
  if (result.rows[0]) {
    emitToDashboard("call:updated", { id: result.rows[0].id, waCallId, status: "rejected", reason });
  }
}

export async function endCall(waCallId) {
  await terminateCall(waCallId);
  await handleCallTerminated(waCallId);
}

// Marks a call as failed and tries to politely reject it on the WhatsApp
// side instead of leaving the caller hanging and the dashboard stuck on
// "ringing" forever.
async function failCall(waCallId, callId, err) {
  const session = sessions.get(waCallId);
  if (session) clearTimeout(session.ringTimer);
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
 * Closes out any call rows left at 'ringing' or 'connected' that don't have
 * a matching in-memory session - meaning they belong to a process lifetime
 * that no longer exists (see the big comment on `sessions` above). Marks
 * them 'missed' so they stop showing a live "Answer" button and stop
 * looking like an active call that's just... never progressing.
 *
 * Called once on startup (covers calls orphaned by the previous deploy) and
 * on a recurring timer (covers calls orphaned by a crash/restart that
 * happens *while* this process is up, e.g. a `docker compose restart` you
 * trigger mid-call).
 */
export async function reconcileStaleCalls() {
  const stale = await query(
    "SELECT id, wa_call_id, status FROM calls WHERE status IN ('ringing', 'connected')"
  );
  for (const row of stale.rows) {
    if (sessions.has(row.wa_call_id)) continue; // genuinely still in progress in this process
    try {
      await terminateCall(row.wa_call_id);
    } catch (_) {
      // Call may already be gone on WhatsApp's side (it auto-times-out
      // un-accepted calls after ~30-60s) - that's fine, we just want our
      // own DB/UI to stop lying about it.
    }
    await query("UPDATE calls SET status = 'missed', ended_at = now() WHERE id = $1", [row.id]);
    emitToDashboard("call:updated", { id: row.id, waCallId: row.wa_call_id, status: "missed" });
  }
  if (stale.rows.length) {
    console.log(`[calls] reconciled ${stale.rows.length} stale call(s) orphaned by a previous process`);
  }
}

// Re-run the sweep periodically too, in case this process itself loses a
// session mid-flight for a reason other than a full restart.
setInterval(() => {
  reconcileStaleCalls().catch((err) => console.error("[calls] stale-call sweep failed", err));
}, 60000);

// Speaks text into an active call via the self-hosted TTS service.
// See docstring above: verify this against your werift version's outbound
// media API (e.g. pc.addTrack with a custom source, or transceiver.sender).
async function playGreeting(waCallId, text) {
  const session = sessions.get(waCallId);
  if (!session) return;
  const mp3 = await synthesize(text);
  // TODO: feed `mp3` (transcode to Opus PCM frames, e.g. via ffmpeg) into
  // session.pc's outbound audio track. Left as the integration point to
  // finish/test live, per the note in handleIncomingCall.
  console.log(`[call ${waCallId}] TTS greeting generated (${mp3.length} bytes) - wire into outbound track`);
}

/**
 * Recording pipeline: relays incoming RTP packets to a local UDP port and
 * has ffmpeg consume them via an SDP file, writing a clean WAV/MP3 to disk.
 * This pattern is well-tested and doesn't depend on werift internals.
 */
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
  ffmpeg.stderr.on("data", () => {}); // silence ffmpeg logs; enable for debugging

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
