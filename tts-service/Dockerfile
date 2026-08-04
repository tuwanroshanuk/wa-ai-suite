FROM python:3.11-slim

WORKDIR /app

# edge-tts is an unofficial online provider and can return 403 responses.
# espeak-ng provides a fully local fallback so an accepted call is never
# dropped only because the external TTS endpoint is unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 6000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "6000"]
