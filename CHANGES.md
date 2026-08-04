# What was fixed

## 5. Calls stuck at "ringing" again after a redeploy, Answer returns 409

The `sessions` Map in `callHandler.js` that holds each call's live WebRTC peer
connection and its ring-timeout timer is **in-memory only**. Every time the
backend process restarts — a `docker compose up --build`, a crash, anything —
that Map is wiped, but any DB rows that were `ringing`/`connected` at that
moment stay exactly as they were, forever, because nothing is left running to
ever update them. Clicking "Answer" on one of those rows 409s because there's
no session behind it to claim.

Fix: added `reconcileStaleCalls()` in `callHandler.js`, run once on backend
startup and then every 60s as a safety net. It finds any `ringing`/`connected`
call with no matching in-memory session, best-effort tells WhatsApp to
terminate it, and marks it `missed` in the DB — so stale rows stop showing a
dead "Answer" button and stop lying about being an active call.

**Practical implication:** don't restart/redeploy the backend while a real
call is in progress — there's currently no way to hand a live WebRTC session
off across a process restart, so it will always end up marked `missed`. The
three rows you saw stuck at "ringing" were from calls that were in flight
across earlier deploys; they'll clear to `missed` the next time the backend
starts.

## 6. TTS audio in calls — still not wired up (expected, not new)

To be clear on where this stands: `playGreeting()` in `callHandler.js` calls
the TTS service and gets an mp3 back, but it only logs the byte count — it
does not yet transcode that into the outbound Opus/RTP track werift sends to
WhatsApp. That's the same pre-existing gap called out in item 4 below (the
agent audio bridge) — this is the bot-side equivalent of it, and also needs a
live calling sandbox to build/verify against. So "no TTS heard" on a call
right now is expected, not a regression.


## 1. Calls stuck on "ringing" / bot never answers (the main bug)

`backend/src/services/callHandler.js` created the WebRTC peer connection like this:

```js
const pc = new RTCPeerConnection({ codecs: { audio: [] } });
```

The `audio` codec list was empty. WhatsApp Calling sends an Opus SDP offer, and with
no codec registered, werift can't negotiate it — `setRemoteDescription`/`createAnswer`
throws. That exception happened *after* the DB row was already inserted with
`status = 'ringing'`, and the only place catching it was a generic `try/catch` in
`webhook.js` that just logs to the console. So every inbound call got stuck at
`ringing` forever, and the bot never got a chance to answer.

Fix: register the Opus codec explicitly:

```js
new RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 })
```

I also wrapped the whole call-setup path in try/catch: if anything fails now, the
call is marked `status = 'failed'`, WhatsApp is sent a `reject`, and the dashboard
gets a live socket update — instead of hanging at "ringing" indefinitely.

## 2. "Request" button (call permission) failing with a bare 500

Two things were wrong:
- The backend gave no detail back to the frontend (`err.message` only, and only in
  the console) — I now surface Meta's actual Graph API error message and status
  code, and validate that `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN`
  are actually set before calling out, with a clear error instead of an opaque
  Axios failure.
- The frontend didn't render request errors at all — the `Calls.jsx` page now
  shows the real error message under the Request button.
- **You still need to check**: that `WHATSAPP_PHONE_NUMBER_ID` and
  `WHATSAPP_ACCESS_TOKEN` are set in your `.env`, and that the `call_permission_request`
  template (or whatever `templateName` you pass) is an approved template in your
  Meta App dashboard. The improved error message will now tell you exactly which
  of these is wrong instead of just "500".

## 3. Security: removed a duplicate, unauthenticated endpoint

`webhook.js` (mounted publicly, no login required, since Meta needs to hit it)
had its own copy of `POST /request-call-permission`. Anyone on the internet could
have called it to fire off WhatsApp template messages. The dashboard actually
uses the authenticated copy in `routes/calls.js`, so I removed the stray one.

## 4. New feature: ring agents first, fall back to the bot

This is the new call flow in `callHandler.js`:

1. Inbound call arrives → row created with `status='ringing'`, WebRTC pre-accept
   sent immediately (this is what lets the call keep "ringing" on the caller's
   phone while you decide who picks up).
2. Dashboard gets a `call:incoming` socket event and shows a green **Answer**
   banner with a live countdown (default **20 seconds**, configurable via
   `AGENT_RING_TIMEOUT_MS` in `.env`).
3. If an agent clicks **Answer** in time → `POST /api/calls/:id/answer` claims
   the call, cancels the auto-bot timer, and marks it `handled_by = agent:<id>`.
4. If nobody answers in time → the backend automatically accepts the call as the
   bot (`handled_by = 'bot'`) and plays the AI greeting.

The dashboard also now listens on socket.io (`frontend/src/socket.js`) instead of
only polling every 5s, so call status changes show up instantly.

### Honest caveat (already flagged in the original code, still true)

Actually piping **live two-way audio** into an agent's browser tab when they
click "Answer" is a separate, bigger piece of work — a real-time WebRTC bridge
between the agent's browser and the werift peer connection already talking to
WhatsApp. That was flagged as "the next build milestone" in the original code
(`routes/calls.js`, the `/take-over` comment) and I haven't built it in this pass —
it needs a live Meta calling sandbox to develop and test against RTP-level audio
mixing, which isn't something I can verify from here. What I *did* build is the
full signaling/state/timer layer around it (claiming the call, stopping the bot
from taking over, DB + socket state), so that bridge is the only remaining piece
once you're ready to test against a real sandbox. Similarly, the bot's TTS
greeting is generated but not yet transcoded into the outbound RTP track
(`playGreeting` in `callHandler.js` — same pre-existing TODO, unrelated to the
ringing bug, left as-is with the note in place).

## Files touched
- `backend/src/services/callHandler.js` — codec fix, error handling, ring→agent→bot flow
- `backend/src/services/whatsapp.js` — config validation
- `backend/src/routes/calls.js` — better error messages, new `/answer` route
- `backend/src/routes/webhook.js` — removed insecure duplicate route, added socket emit for new messages
- `backend/src/db/schema.sql` — comment update for new status/handled_by values
- `frontend/src/socket.js` — new, shared socket.io client
- `frontend/src/pages/Calls.jsx` — live ring banner + countdown + Answer button, error display
