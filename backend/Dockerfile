FROM node:20-slim

WORKDIR /app

# WhatsApp call recording and TTS streaming both spawn ffmpeg.
# Install it in the backend image and keep the image cache small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/recordings

EXPOSE 4000
CMD ["node", "src/index.js"]
