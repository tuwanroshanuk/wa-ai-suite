FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the default multilingual model into the image so the first live call
# does not wait for a model download. Docker will cache this layer.
ARG STT_MODEL=base
RUN mkdir -p /models \
    && python -c "from faster_whisper import WhisperModel; WhisperModel('${STT_MODEL}', device='cpu', compute_type='int8', download_root='/models')"

COPY app.py .

ENV STT_MODEL=${STT_MODEL}
ENV STT_MODEL_DIR=/models

EXPOSE 7000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
