import fs from "fs";
import path from "path";
import dgram from "dgram";
import { spawn } from "child_process";

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const RMS_THRESHOLD = Number(process.env.CALL_STT_RMS_THRESHOLD || 420);
const MIN_SPEECH_MS = Number(process.env.CALL_STT_MIN_SPEECH_MS || 700);
const END_SILENCE_MS = Number(process.env.CALL_STT_END_SILENCE_MS || 850);
const MAX_TURN_MS = Number(process.env.CALL_STT_MAX_TURN_MS || 12000);
const PRE_ROLL_MS = Number(process.env.CALL_STT_PRE_ROLL_MS || 250);

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function durationMs(buffer) {
  return (buffer.length / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
}

function calculateRms(buffer) {
  if (!buffer?.length) return 0;
  let sum = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sum += sample * sample;
    count += 1;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  const blockAlign = BYTES_PER_SAMPLE;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function allocateUdpPort() {
  const probe = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.bind(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function startLiveTranscriber({ waCallId, recordingsDir, onTurn }) {
  const socket = dgram.createSocket("udp4");
  const udpPort = await allocateUdpPort();
  const sdpPath = path.join(recordingsDir, `${safeName(waCallId)}.stt.sdp`);
  fs.writeFileSync(
    sdpPath,
    [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=live-transcription",
      "c=IN IP4 127.0.0.1",
      "t=0 0",
      `m=audio ${udpPort} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
    ].join("\n")
  );

  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-analyzeduration", "0",
    "-probesize", "32",
    "-i", sdpPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-f", "s16le",
    "pipe:1",
  ]);

  let stopped = false;
  let speaking = false;
  let speechMs = 0;
  let silenceMs = 0;
  let speechBuffers = [];
  let preRollBuffers = [];
  let preRollBytes = 0;
  const maxPreRollBytes = Math.floor((PRE_ROLL_MS / 1000) * SAMPLE_RATE * BYTES_PER_SAMPLE);
  let turnQueue = Promise.resolve();

  function resetTurn() {
    speaking = false;
    speechMs = 0;
    silenceMs = 0;
    speechBuffers = [];
  }

  function rememberPreRoll(chunk) {
    preRollBuffers.push(chunk);
    preRollBytes += chunk.length;
    while (preRollBytes > maxPreRollBytes && preRollBuffers.length > 1) {
      const removed = preRollBuffers.shift();
      preRollBytes -= removed.length;
    }
  }

  function flushTurn() {
    if (!speechBuffers.length || speechMs < MIN_SPEECH_MS) {
      resetTurn();
      return;
    }

    const pcm = Buffer.concat(speechBuffers);
    resetTurn();
    const wav = wavFromPcm(pcm);
    turnQueue = turnQueue
      .then(() => onTurn(wav))
      .catch((err) => console.error(`[call ${waCallId}] transcription turn failed`, err));
  }

  ffmpeg.stdout.on("data", (chunk) => {
    if (stopped || !chunk?.length) return;
    const chunkMs = durationMs(chunk);
    const voiced = calculateRms(chunk) >= RMS_THRESHOLD;

    if (voiced) {
      if (!speaking) {
        speaking = true;
        speechBuffers = [...preRollBuffers];
        preRollBuffers = [];
        preRollBytes = 0;
      }
      speechBuffers.push(chunk);
      speechMs += chunkMs;
      silenceMs = 0;
    } else if (speaking) {
      speechBuffers.push(chunk);
      speechMs += chunkMs;
      silenceMs += chunkMs;
    } else {
      rememberPreRoll(chunk);
    }

    if (speaking && (silenceMs >= END_SILENCE_MS || speechMs >= MAX_TURN_MS)) {
      flushTurn();
    }
  });

  ffmpeg.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.warn(`[call ${waCallId}] STT decoder: ${text}`);
  });

  ffmpeg.once("error", (err) => {
    console.error(`[call ${waCallId}] live transcription decoder failed`, err);
  });

  ffmpeg.once("close", (code) => {
    if (!stopped && code !== 0) {
      console.warn(`[call ${waCallId}] live transcription decoder exited ${code}`);
    }
  });

  console.log(`[call ${waCallId}] live caller transcription pipeline started`);

  return {
    feed(rtp) {
      if (stopped) return;
      try { socket.send(rtp.serialize(), udpPort, "127.0.0.1"); } catch (_) {}
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (speaking) flushTurn();
      try { ffmpeg.kill("SIGINT"); } catch (_) {}
      try { socket.close(); } catch (_) {}
      try { fs.unlinkSync(sdpPath); } catch (_) {}
    },
  };
}
