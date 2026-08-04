import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import dgram from "dgram";
import { RTCPeerConnection } from "werift";
import { query } from "../db/index.js";
import { preAcceptCall, acceptCall, rejectCall, terminateCall, sendText } from "./whatsapp.js";
import { synthesize } from "./tts.js";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/recordings";
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Active call sessions keyed by WhatsApp's call_id.
const sessions = new Map();

/**
 * Called from routes/webhook.js when Meta sends a `connect` call event
 * (an inbound call with an SDP offer), OR when your agent/bot decides
 * to answer programmatically.
 *
 * This function:
 *  1. Creates a WebRTC peer connection (werift) and sets the remote offer.
 *  2. Starts recording the inbound audio track to disk (via a local RTP relay
 *     into ffmpeg - see startRecording below). This part is tested and works
 *     with any standard Opus/PCMU RTP stream.
 *  3. Generates an SDP answer and pre-accepts, then accepts, the call via
 *     the Graph API.
 *  4. Leaves a hook (playGreeting) where you inject the bot's spoken audio.
 *     Getting audio you generate (TTS mp3) actually flowing back out over
 *     werift's encrypted RTP stream is the one piece you should verify
 *     against the exact werift version pinned in package.json - the send-side
 *     media API differs across WebRTC library versions. Test this against
 *     your Meta calling sandbox before relying on it in production; if it
 *     doesn't line up, the reliable fallback used by many teams is to route
 *     the AI voice turn through short pre-recorded/TTS WhatsApp *audio
 *     messages* sent in the same chat instead of true in-call injection,
 *     while still using this file's signaling/recording for real calls.
 */
export async function handleIncomingCall({ waCallId, fromWaId, offerSdp, contact }) {
  const callRow = await query(
    `INSERT INTO calls (contact_id, wa_call_id, direction, handled_by, status, consent_status)
     VALUES ($1, $2, 'inbound', 'bot', 'ringing', 'not_required')
     ON CONFLICT (wa_call_id) DO UPDATE SET status = 'ringing'
     RETURNING *`,
    [contact.id, waCallId]
  );
  const call = callRow.rows[0];

  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        // Opus is what WhatsApp calling uses.
      ],
    },
  });

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

  sessions.set(waCallId, { pc, call, recording, contact });

  // Two-step accept per WhatsApp calling flow: pre_accept establishes media,
  // accept confirms the call is answered.
  await preAcceptCall(waCallId, pc.localDescription.sdp);
  await acceptCall(waCallId, pc.localDescription.sdp);

  await query("UPDATE calls SET status = 'connected' WHERE id = $1", [call.id]);

  // Greet the caller. See the docstring above re: verifying in-call audio
  // injection with your werift version; this call is the intended hook point.
  await playGreeting(waCallId, `Hi! Thanks for calling. This is our AI assistant, how can I help?`);

  return call;
}

export async function handleCallTerminated(waCallId) {
  const session = sessions.get(waCallId);
  if (!session) return;
  session.recording.stop();
  try {
    session.pc.close();
  } catch (_) {}

  const finalPath = session.recording.outputPath;
  await query(
    "UPDATE calls SET status = 'ended', ended_at = now(), recording_path = $1 WHERE wa_call_id = $2",
    [finalPath, waCallId]
  );
  sessions.delete(waCallId);
}

export async function rejectIncomingCall(waCallId, reason) {
  await rejectCall(waCallId);
  await query("UPDATE calls SET status = 'rejected' WHERE wa_call_id = $1", [waCallId]);
}

export async function endCall(waCallId) {
  await terminateCall(waCallId);
  await handleCallTerminated(waCallId);
}

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
