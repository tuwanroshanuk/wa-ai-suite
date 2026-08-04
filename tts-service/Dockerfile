FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Include a small curated set of local neural voices. Docker caches this layer,
# so normal source-only redeploys do not download the models again.
RUN mkdir -p /models \
    && python -m piper.download_voices \
       en_US-lessac-medium \
       en_US-amy-medium \
       en_GB-alan-medium \
       en_GB-cori-medium \
       --data-dir /models

COPY app.py .

ENV TTS_MODEL_DIR=/models
ENV TTS_PROVIDER=piper
ENV TTS_DEFAULT_VOICE=en_US-lessac-medium

EXPOSE 6000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "6000"]
