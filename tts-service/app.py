"""
Self-hosted, free TTS microservice.

Uses `edge-tts` (unofficial wrapper around Microsoft Edge's read-aloud voices).
It is free and needs no API key, but it is an UNOFFICIAL client against a
Microsoft service, so it can occasionally break if Microsoft changes things.
Swap PROVIDER logic below for a paid API later without touching the backend,
since the backend only talks to this service's HTTP contract.

Endpoints:
  GET  /voices              -> list available voices
  POST /speak               -> { text, voice? } -> returns audio/mpeg (mp3) bytes
  POST /speak-stream        -> same, but streamed chunk by chunk (lower latency)
"""

import io
import os
from typing import Optional

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Free Self-Hosted TTS Service")

DEFAULT_VOICE = os.environ.get("TTS_DEFAULT_VOICE", "en-US-AriaNeural")


class SpeakRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    rate: Optional[str] = "+0%"
    pitch: Optional[str] = "+0Hz"


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/voices")
async def voices():
    vs = await edge_tts.list_voices()
    return [{"name": v["ShortName"], "locale": v["Locale"], "gender": v["Gender"]} for v in vs]


@app.post("/speak")
async def speak(req: SpeakRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    voice = req.voice or DEFAULT_VOICE
    communicate = edge_tts.Communicate(req.text, voice, rate=req.rate, pitch=req.pitch)

    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    buf.seek(0)

    return StreamingResponse(buf, media_type="audio/mpeg")


@app.post("/speak-stream")
async def speak_stream(req: SpeakRequest):
    """Lower-latency variant: starts sending audio chunks as they're generated,
    instead of waiting for the whole utterance. Useful for the live-call pipeline."""
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    voice = req.voice or DEFAULT_VOICE
    communicate = edge_tts.Communicate(req.text, voice, rate=req.rate, pitch=req.pitch)

    async def gen():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]

    return StreamingResponse(gen(), media_type="audio/mpeg")
