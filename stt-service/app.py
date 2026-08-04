import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

app = FastAPI(title="Local Call Speech-to-Text")
logger = logging.getLogger("stt")

MODEL_NAME = os.environ.get("STT_MODEL", "base")
DEVICE = os.environ.get("STT_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")
MODEL_DIR = os.environ.get("STT_MODEL_DIR", "/models")
CPU_THREADS = int(os.environ.get("STT_CPU_THREADS", "4"))

_model = None
_model_lock = asyncio.Lock()


async def get_model() -> WhisperModel:
    global _model
    if _model is not None:
        return _model

    async with _model_lock:
        if _model is None:
            logger.info(
                "loading faster-whisper model=%s device=%s compute_type=%s",
                MODEL_NAME,
                DEVICE,
                COMPUTE_TYPE,
            )
            _model = await asyncio.to_thread(
                WhisperModel,
                MODEL_NAME,
                device=DEVICE,
                compute_type=COMPUTE_TYPE,
                download_root=MODEL_DIR,
                cpu_threads=CPU_THREADS,
            )
            logger.info("faster-whisper model loaded")
    return _model


def transcribe_file(model: WhisperModel, file_path: str):
    segments, info = model.transcribe(
        file_path,
        beam_size=1,
        best_of=1,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 350,
            "speech_pad_ms": 120,
        },
        condition_on_previous_text=False,
        temperature=0,
        word_timestamps=False,
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    return {
        "text": text,
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", None),
    }


@app.on_event("startup")
async def warm_model():
    # Load once at startup so the first live call does not pay model-startup latency.
    try:
        await get_model()
    except Exception:
        logger.exception("could not warm the local STT model")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "loaded": _model is not None,
    }


@app.post("/transcribe")
async def transcribe(request: Request):
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="audio body is required")

    suffix = ".wav"
    content_type = request.headers.get("content-type", "")
    if "mpeg" in content_type or "mp3" in content_type:
        suffix = ".mp3"
    elif "ogg" in content_type:
        suffix = ".ogg"
    elif "webm" in content_type:
        suffix = ".webm"

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_file.write(audio)
            temp_path = temp_file.name

        model = await get_model()
        result = await asyncio.to_thread(transcribe_file, model, temp_path)
        return result
    except Exception as exc:
        logger.exception("local transcription failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        if temp_path:
            try:
                Path(temp_path).unlink(missing_ok=True)
            except Exception:
                pass
