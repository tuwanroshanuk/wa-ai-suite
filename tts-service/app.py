"""Small TTS microservice with an online neural voice and offline fallback.

Provider modes:
  auto   -> try edge-tts, then fall back to local espeak-ng
  edge   -> use edge-tts only
  espeak -> use local espeak-ng only
"""

import asyncio
import io
import logging
import os
from typing import Optional

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Self-Hosted TTS Service")
logger = logging.getLogger("tts")

DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "en-US-AriaNeural")
PROVIDER = os.environ.get("TTS_PROVIDER", "auto").strip().lower()
ESPEAK_VOICE = os.environ.get("TTS_ESPEAK_VOICE", "en-us")
ESPEAK_SPEED = os.environ.get("TTS_ESPEAK_SPEED", "165")


class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    rate: Optional[str] = "+0%"
    pitch: Optional[str] = "+0Hz"


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "provider": PROVIDER,
        "offline_fallback": True,
    }


@app.get("/voices")
async def voices():
    if PROVIDER == "espeak":
        return [{"name": ESPEAK_VOICE, "locale": ESPEAK_VOICE, "gender": "unknown"}]

    try:
        vs = await edge_tts.list_voices()
        return [
            {"name": v["ShortName"], "locale": v["Locale"], "gender": v["Gender"]}
            for v in vs
        ]
    except Exception as exc:
        logger.warning("edge-tts voice list failed; returning local fallback: %s", exc)
        return [{"name": ESPEAK_VOICE, "locale": ESPEAK_VOICE, "gender": "unknown"}]


async def synthesize_edge(req: SpeakRequest) -> tuple[bytes, str, str]:
    voice = req.voice or DEFAULT_VOICE
    communicate = edge_tts.Communicate(req.text, voice, rate=req.rate, pitch=req.pitch)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    audio = buf.getvalue()
    if not audio:
        raise RuntimeError("edge-tts returned no audio")
    return audio, "audio/mpeg", "edge"


async def synthesize_espeak(req: SpeakRequest) -> tuple[bytes, str, str]:
    # espeak-ng writes a complete WAV stream to stdout. It is local, needs no
    # API key and remains available when the external neural voice endpoint is
    # blocked or rate-limited.
    process = await asyncio.create_subprocess_exec(
        "espeak-ng",
        "--stdout",
        "-v",
        ESPEAK_VOICE,
        "-s",
        ESPEAK_SPEED,
        req.text,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0 or not stdout:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"espeak-ng failed: {detail or process.returncode}")
    return stdout, "audio/wav", "espeak"


async def synthesize(req: SpeakRequest) -> tuple[bytes, str, str]:
    if PROVIDER == "espeak":
        return await synthesize_espeak(req)

    try:
        return await synthesize_edge(req)
    except Exception as exc:
        if PROVIDER == "edge":
            raise
        logger.warning("edge-tts failed; using local espeak-ng fallback: %s", exc)
        return await synthesize_espeak(req)


@app.post("/speak")
async def speak(req: SpeakRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    try:
        audio, media_type, provider = await synthesize(req)
    except Exception as exc:
        logger.exception("all TTS providers failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=audio,
        media_type=media_type,
        headers={"X-TTS-Provider": provider},
    )


@app.post("/speak-stream")
async def speak_stream(req: SpeakRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    try:
        audio, media_type, provider = await synthesize(req)
    except Exception as exc:
        logger.exception("all TTS providers failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    async def gen():
        # Yield moderate chunks so callers can begin consuming promptly while
        # keeping the same endpoint contract for both MP3 and WAV providers.
        chunk_size = 16 * 1024
        for offset in range(0, len(audio), chunk_size):
            yield audio[offset : offset + chunk_size]

    return StreamingResponse(
        gen(),
        media_type=media_type,
        headers={"X-TTS-Provider": provider},
    )
