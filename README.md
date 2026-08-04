# WhatsApp AI Suite (self-hosted)

A self-hostable suite: WhatsApp messaging inbox, Gemini-powered bot flows,
WhatsApp Business Calling (bot-answered + recorded), free self-hosted TTS,
and a React dashboard with login.

## What's fully working out of the box

- Web login + JWT auth, admin bootstrapped from `.env` on first boot
- WhatsApp Cloud API messaging: send/receive text, templates, audio
- Visual bot flow builder (React Flow) -> saved as JSON -> executed live
  by `backend/src/services/flowEngine.js` on every inbound message
- Gemini API integration for AI replies (free-tier key, set your own limits)
- Conversations inbox with bot on/off toggle per contact, manual agent reply
- Self-hosted free TTS microservice (`tts-service/`, uses `edge-tts`)
- Free pre-recorded audio clip library (upload + play from flow nodes)
- WhatsApp call **signaling**: consent/permission-request flow, inbound call
  webhook handling, pre-accept/accept/reject/terminate against the Graph API
- Call **recording** pipeline (RTP -> ffmpeg -> WAV on disk, downloadable
  from the Calls page)
- Postgres schema + docker-compose for one-shot Dokploy deployment

## What needs finishing/testing against YOUR live Meta calling sandbox

- **In-call bot speech (TTS -> live WebRTC audio):** `services/callHandler.js`
  generates the greeting audio and has the exact hook point
  (`playGreeting`) to inject it into the call, but wiring raw PCM/Opus
  frames into `werift`'s outbound RTP stream is the one piece whose exact
  API differs by library version - it's called out with a `TODO` and
  fallback notes right in that file. Budget real testing time here; it's the
  single most technical part of this project.
- **Browser-based agent calling:** the "Take over (browser)" button and
  `/api/calls/:id/take-over` route are stubbed. Bridging the agent's browser
  audio into the same call requires a second WebRTC leg + server-side audio
  mixing - a solid next milestone once bot calling is verified end-to-end.
- Your WABA needs Calling actually enabled by Meta (you confirmed this is
  already the case) and an **approved call-permission template** for
  outbound consent requests - create/name it, then reference that exact
  name where the code calls `requestCallPermission(...)`.

## Architecture

```
frontend (React, Vite, nginx)  ->  backend (Express, Socket.io, werift)
                                       |         |            |
                                  Postgres     Redis      tts-service (edge-tts)
                                       |
                                  /app/recordings (call audio + uploaded clips)
```

## Local / VPS setup

1. Copy `.env.example` to `.env` and fill in every value:
   - WhatsApp: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
     `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` - all from your Meta App
     Dashboard > WhatsApp > API Setup / App Settings.
   - `WHATSAPP_WEBHOOK_VERIFY_TOKEN` - make up any string, then enter that
     same string in Meta's webhook config screen.
   - `GEMINI_API_KEY` - from Google AI Studio (free tier).
   - `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` - your dashboard login.
2. In Meta's App Dashboard, set your webhook URL to
   `https://api.yourdomain.com/webhook` and subscribe to the `messages` and
   `calls` webhook fields.
3. Deploy via **Dokploy**: point it at this repo/zip, it will pick up
   `docker-compose.yml`. Set the `.env` values in Dokploy's environment
   variables UI (or upload the `.env` file directly).
4. Once containers are up: open `https://app.yourdomain.com`, log in with
   `ADMIN_EMAIL` / `ADMIN_PASSWORD`, and start building a flow under
   **Bot Flows**, then click **Set as live**.

## Local dev without Docker

```bash
# terminal 1
cd tts-service && pip install -r requirements.txt && uvicorn app:app --port 6000

# terminal 2 - needs a local Postgres running
cd backend && npm install && npm run dev

# terminal 3
cd frontend && npm install && npm run dev
```

## Notes on the "free" services used

- **Gemini free tier**: rate-limited (requests/minute and /day). Fine for a
  prototype or moderate volume; watch Google's current limits.
- **edge-tts**: free, no API key, self-hosted in `tts-service/`, but it is
  an *unofficial* wrapper around Microsoft Edge's voices - it can break if
  Microsoft changes their backend. If that happens, swap the implementation
  inside `tts-service/app.py` for any other engine; the HTTP contract the
  backend calls (`POST /speak`) stays the same either way.
