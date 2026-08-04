import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { initDb } from "./db/index.js";
import { requireAuth } from "./middleware/auth.js";
import { initSockets } from "./sockets.js";
import { expressCorsOptions } from "./config/cors.js";

import authRoutes, { bootstrapAdmin } from "./routes/auth.js";
import webhookRoutes from "./routes/webhook.js";
import conversationRoutes from "./routes/conversations.js";
import contactRoutes from "./routes/contacts.js";
import flowRoutes from "./routes/flows.js";
import callRoutes from "./routes/calls.js";
import audioRoutes from "./routes/audio.js";
import { reconcileStaleCalls } from "./services/callHandler.js";

const app = express();
const corsOptions = expressCorsOptions();

// Apply CORS before auth and every API route so browser preflight requests
// from the dashboard are answered without requiring a JWT.
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Capture the raw body for webhook signature verification, while still
// parsing JSON everywhere else.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Public
app.use("/auth", authRoutes);
app.use("/webhook", webhookRoutes); // Meta calls this directly, no JWT

// Authenticated dashboard API
app.use("/api/conversations", requireAuth, conversationRoutes);
app.use("/api/contacts", requireAuth, contactRoutes);
app.use("/api/flows", requireAuth, flowRoutes);
app.use("/api/calls", requireAuth, callRoutes);
app.use("/api/audio", requireAuth, audioRoutes);

const server = http.createServer(app);
initSockets(server);

const PORT = process.env.PORT || 4000;

async function start() {
  await initDb();
  await bootstrapAdmin();
  await reconcileStaleCalls();
  server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}

start().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});
