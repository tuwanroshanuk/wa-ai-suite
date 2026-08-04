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

function writeRtpSdp(filePath, port, label) {
  fs.writeFileSync(
    filePath,
    [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      `s=${label}`,
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${port} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "a=recvonly",
      "",
    ].join("\r\n")
  );
}

/**
 * Creates one complete mono WAV by mixing:
 *   input 0: WhatsApp caller audio
 *   input 1: agent microphone, Gemini Live output, or generated TTS
 *
 * FFmpeg owns both receiving ports. Node uses separate sender sockets, waits
 * for FFmpeg to bind, and waits again at shutdown so the WAV is finalized
 * before recording_path is committed to Postgres.
 */
export async function startCallRecorder({ waCallId, recordingsDir }) {
  fs.mkdirSync(recordingsDir, { recursive: true });

  const fileName = safeName(waCallId);
  const outputPath = path.join(recordingsDir, `${fileName}.wav`);
  const inboundSdpPath = path.join(recordingsDir, `${fileName}.caller.sdp`);
  const outboundSdpPath = path.join(recordingsDir, `${fileName}.business.sdp`);
  const inboundPort = await reserveUdpPort();
  let outboundPort = await reserveUdpPort();
  while (outboundPort === inboundPort) outboundPort = await reserveUdpPort();

  const inboundSender = dgram.createSocket("udp4");
  const outboundSender = dgram.createSocket("udp4");
  let stopped = false;
  let ready = false;
  let ffmpegError = null;
  const pendingInbound = [];
  const pendingOutbound = [];

  writeRtpSdp(inboundSdpPath, inboundPort, "whatsapp-caller");
  writeRtpSdp(outboundSdpPath, outboundPort, "business-audio");
  try { fs.unlinkSync(outputPath); } catch (_) {}

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "1024",
    "-i", inboundSdpPath,
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "+genpts",
    "-use_wallclock_as_timestamps", "1",
    "-thread_queue_size", "1024",
    "-i", outboundSdpPath,
    "-filter_complex",
    "[0:a]aresample=16000,asetpts=N/SR/TB[caller];[1:a]aresample=16000,asetpts=N/SR/TB[business];[caller][business]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,volume=0.78[mixed]",
    "-map", "[mixed]",
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

  function sendPacket(sender, packet, port) {
    try { sender.send(packet, port, "127.0.0.1"); } catch (_) {}
  }

  function feedRtp(rtp, sender, port, pending) {
    if (stopped || !rtp) return;
    try {
      const packet = rtp.serialize();
      if (!ready) {
        if (pending.length < 750) pending.push(packet);
        return;
      }
      sendPacket(sender, packet, port);
    } catch (_) {}
  }

  const readyTimer = setTimeout(() => {
    if (stopped) return;
    ready = true;
    for (const packet of pendingInbound.splice(0)) {
      sendPacket(inboundSender, packet, inboundPort);
    }
    for (const packet of pendingOutbound.splice(0)) {
      sendPacket(outboundSender, packet, outboundPort);
    }
    console.log(
      `[call ${waCallId}] two-way recording started caller=${inboundPort} business=${outboundPort}`
    );
  }, 180);

  return {
    outputPath,
    feed(rtp) {
      feedRtp(rtp, inboundSender, inboundPort, pendingInbound);
    },
    feedInbound(rtp) {
      feedRtp(rtp, inboundSender, inboundPort, pendingInbound);
    },
    feedOutbound(rtp) {
      feedRtp(rtp, outboundSender, outboundPort, pendingOutbound);
    },
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
      try { inboundSender.close(); } catch (_) {}
      try { outboundSender.close(); } catch (_) {}
      try { fs.unlinkSync(inboundSdpPath); } catch (_) {}
      try { fs.unlinkSync(outboundSdpPath); } catch (_) {}

      if (ffmpegError) {
        try { fs.unlinkSync(outputPath); } catch (_) {}
        return null;
      }

      try {
        const size = fs.statSync(outputPath).size;
        if (size > 44) {
          console.log(`[call ${waCallId}] two-way recording finalized: ${size} bytes`);
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
