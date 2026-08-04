"""Self-hosted neural TTS service.

Piper is the default provider and runs fully locally. eSpeak remains only as an
emergency fallback so an accepted call is not dropped if a voice model cannot
load. The previous Edge read-aloud client was removed because Microsoft was
returning HTTP 403 for its unofficial consumer WebSocket endpoint.
"""

import asyncio
import io
import logging
import os
import threading
import wave
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from piper import PiperVoice, SynthesisConfig
from pydantic import BaseModel, Field

app = FastAPI(title="Local Neural TTS Service")
logger = logging.getLogger("tts")

MODEL_DIR = Path(os.environ.get("TTS_MODEL_DIR", "/models"))
DEFAULT_PROVIDER = os.environ.get("TTS_PROVIDER", "piper").strip().lower()
DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "en_US-lessac-medium")
ESPEAK_VOICE = os.environ.get("TTS_ESPEAK_VOICE", "en-us")
ESPEAK_BASE_SPEED = int(os.environ.get("TTS_ESPEAK_SPEED", "165"))

VOICE_CATALOG = [
    {
        "id": "en_US-lessac-medium",
        "name": "Lessac",
        "label": "Lessac — Natural US English",
        "locale": "en-US",
        "gender": "female",
        "provider": "piper",
        "quality": "medium",
    },
    {
        "id": "en_US-amy-medium",
        "name": "Amy",
        "label": "Amy — Warm US English",
        "locale": "en-US",
        "gender": "female",
        "provider": "piper",
        "quality": "medium",
    },
    {
        "id": "en_GB-alan-medium",
        "name": "Alan",
        "label": "Alan — British English",
        "locale": "en-GB",
        "gender": "male",
        "provider": "piper",
        "quality": "medium",
    },
    {
        "id": "en_GB-cori-medium",
        "name": "Cori",
        "label": "Cori — Natural British English",
        "locale": "en-GB",
        "gender": "female",
        "provider": "piper",
        "quality": "medium",
    },
    {
        "id": "en-us",
        "name": "eSpeak emergency fallback",
        "label": "eSpeak — Emergency fallback",
        "locale": "en-US",
        "gender": "unknown",
        "provider": "espeak",
        "quality": "fallback",
    },
]

VOICE_IDS = {voice["id"] for voice in VOICE_CATALOG}
_voice_cache: dict[str, PiperVoice] = {}
_voice_lock = threading.Lock()


class SpeakRequest(BaseModel):
    text: str
    provider: Optional[str] = None
    voice: Optional[str] = None
    speed: float = Field(default=1.0, ge=0.65, le=1.45)


def get_piper_voice(voice_id: str) -> PiperVoice:
    with _voice_lock:
        cached = _voice_cache.get(voice_id)
        if cached is not None:
            return cached

        model_path = MODEL_DIR / f"{voice_id}.onnx"
        if not model_path.exists():
            raise FileNotFoundError(f"Piper voice model is not installed: {voice_id}")

        logger.info("loading Piper voice %s", voice_id)
        loaded = PiperVoice.load(str(model_path))
        _voice_cache[voice_id] = loaded
        return loaded


def synthesize_piper_sync(text: str, voice_id: str, speed: float) -> bytes:
    voice = get_piper_voice(voice_id)
    output = io.BytesIO()
    config = SynthesisConfig(
        length_scale=max(0.55, min(1.55, 1.0 / speed)),
        normalize_audio=True,
    )
    with wave.open(output, "wb") as wav_file:
        voice.synthesize_wav(text, wav_file, syn_config=config)
    return output.getvalue()


async def synthesize_piper(req: SpeakRequest):
    voice_id = req.voice or DEFAULT_VOICE
    if voice_id not in VOICE_IDS or voice_id == "en-us":
        raise ValueError(f"Unsupported Piper voice: {voice_id}")
    audio = await asyncio.to_thread(synthesize_piper_sync, req.text, voice_id, req.speed)
    if not audio:
        raise RuntimeError("Piper returned no audio")
    return audio, "audio/wav", "piper", voice_id


async def synthesize_espeak(req: SpeakRequest):
    speed = max(90, min(260, round(ESPEAK_BASE_SPEED * req.speed)))
    voice = req.voice if req.voice == "en-us" else ESPEAK_VOICE
    process = await asyncio.create_subprocess_exec(
        "espeak-ng",
        "--stdout",
        "-v",
        voice,
        "-s",
        str(speed),
        req.text,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0 or not stdout:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"espeak-ng failed: {detail or process.returncode}")
    return stdout, "audio/wav", "espeak", voice


async def synthesize(req: SpeakRequest):
    provider = (req.provider or DEFAULT_PROVIDER).strip().lower()

    if provider == "espeak":
        return await synthesize_espeak(req)

    try:
        return await synthesize_piper(req)
    except Exception as exc:
        logger.exception("Piper synthesis failed; using emergency eSpeak fallback: %s", exc)
        return await synthesize_espeak(req)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "provider": DEFAULT_PROVIDER,
        "default_voice": DEFAULT_VOICE,
        "piper_models": [
            voice["id"]
            for voice in VOICE_CATALOG
            if voice["provider"] == "piper" and (MODEL_DIR / f"{voice['id']}.onnx").exists()
        ],
        "offline": True,
    }


@app.get("/voices")
async def voices():
    return {
        "default": {
            "provider": DEFAULT_PROVIDER,
            "voice": DEFAULT_VOICE,
            "speed": 1.0,
        },
        "voices": VOICE_CATALOG,
    }


@app.post("/speak")
async def speak(req: SpeakRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    try:
        audio, media_type, provider, voice = await synthesize(req)
    except Exception as exc:
        logger.exception("all TTS providers failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=audio,
        media_type=media_type,
        headers={
            "X-TTS-Provider": provider,
            "X-TTS-Voice": voice,
            "Cache-Control": "no-store",
        },
    )


@app.post("/speak-stream")
async def speak_stream(req: SpeakRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    try:
        audio, media_type, provider, voice = await synthesize(req)
    except Exception as exc:
        logger.exception("all TTS providers failed")
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    async def generate():
        chunk_size = 16 * 1024
        for offset in range(0, len(audio), chunk_size):
            yield audio[offset : offset + chunk_size]

    return StreamingResponse(
        generate(),
        media_type=media_type,
        headers={
            "X-TTS-Provider": provider,
            "X-TTS-Voice": voice,
            "Cache-Control": "no-store",
        },
    )
