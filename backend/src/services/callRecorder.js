import dgram from "dgram";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function reserveUdpPort() {
  const probe = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.bind(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waitForExit(process, timeoutMs = 5000) {
  if (!process) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { process.kill("SIGKILL"); } catch (_) {}
      done();
    }, timeoutMs);
    process.once("close", done);
    process.once("error", done);
  });
}

/**
 * Records the WhatsApp caller RTP stream as a finalized mono WAV file.
 *
 * FFmpeg is the only process bound to the RTP receiving port. Node sends RTP
 * from a separate ephemeral socket, avoiding the old address-in-use/empty-file
 * failure. Shutdown waits for FFmpeg to finalize the WAV header before the
 * recording path is stored in Postgres.
 */
export async function startCallRecorder({ waCallId, recordingsDir }) {
  fs.mkdirSync(recordingsDir, { recursive: true });

  const fileName = safeName(waCallId);
  const outputPath = path.join(recordingsDir, `${fileName}.wav`);
  const sdpPath = path.join(recordingsDir, `${fileName}.recording.sdp`);
  const udpPort = await reserveUdpPort();
  const sender = dgram.createSocket("udp4");
  let stopped = false;
  let ready = false;
  let ffmpegError = null;
  const pending = [];

  fs.writeFileSync(
    sdpPath,
    [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=whatsapp-call-recording",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${udpPort} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "a=recvonly",
      "",
    ].join("\r\n")
  );

  try { fs.unlinkSync(outputPath); } catch (_) {}

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "1024",
    "-i", sdpPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-y",
    outputPath,
  ]);

  ffmpeg.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) console.warn(`[call ${waCallId}] recorder: ${message}`);
  });
  ffmpeg.once("error", (err) => {
    ffmpegError = err;
    console.error(`[call ${waCallId}] recorder FFmpeg failed`, err);
  });

  const readyTimer = setTimeout(() => {
    if (stopped) return;
    ready = true;
    for (const packet of pending.splice(0)) {
      try { sender.send(packet, udpPort, "127.0.0.1"); } catch (_) {}
    }
    console.log(`[call ${waCallId}] recording started on UDP ${udpPort}`);
  }, 150);

  function feedCallerRtp(rtp) {
    if (stopped || !rtp) return;
    try {
      const packet = rtp.serialize();
      if (!ready) {
        if (pending.length < 750) pending.push(packet);
        return;
      }
      sender.send(packet, udpPort, "127.0.0.1");
    } catch (_) {}
  }

  return {
    outputPath,
    feed: feedCallerRtp,
    feedInbound: feedCallerRtp,
    // Reserved for a future dual-channel mix. Caller recording remains stable
    // even when no business-side RTP is available.
    feedOutbound() {},
    async stop() {
      if (stopped) {
        try {
          return fs.statSync(outputPath).size > 44 ? outputPath : null;
        } catch (_) {
          return null;
        }
      }

      stopped = true;
      clearTimeout(readyTimer);
      try { ffmpeg.kill("SIGINT"); } catch (_) {}
      await waitForExit(ffmpeg);
      try { sender.close(); } catch (_) {}
      try { fs.unlinkSync(sdpPath); } catch (_) {}

      if (ffmpegError) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        return null;
      }

      try {
        const size = fs.statSync(outputPath).size;
        if (size > 44) {
          console.log(`[call ${waCallId}] recording finalized: ${size} bytes`);
          return outputPath;
        }
      } catch (_) {}

      console.warn(`[call ${waCallId}] recording did not contain playable audio`);
      try { fs.unlinkSync(outputPath); } catch (_) {}
      return null;
    },
  };
}

export function noCallRecorder() {
  return {
    outputPath: null,
    feed() {},
    feedInbound() {},
    feedOutbound() {},
    async stop() { return null; },
  };
}
