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
import voiceSettingsRoutes from "./routes/voiceSettings.js";
import aiAgentRoutes from "./routes/aiAgent.js";
import { reconcileStaleCalls } from "./services/callHandler.js";

const app = express();
const corsOptions = expressCorsOptions();

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(
  express.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/auth", authRoutes);
app.use("/webhook", webhookRoutes);

app.use("/api/conversations", requireAuth, conversationRoutes);
app.use("/api/contacts", requireAuth, contactRoutes);
app.use("/api/flows", requireAuth, flowRoutes);
app.use("/api/calls", requireAuth, callRoutes);
app.use("/api/audio", requireAuth, audioRoutes);
app.use("/api/voice-settings", requireAuth, voiceSettingsRoutes);
app.use("/api/ai-agent", requireAuth, aiAgentRoutes);

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
