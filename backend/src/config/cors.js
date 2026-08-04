const DEFAULT_APP_ORIGINS = [
  "https://typebot.nexuscloud.uk",
  "http://localhost:5173",
  "http://localhost:3000",
];

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export function getAllowedOrigins() {
  const configured = [
    process.env.PUBLIC_APP_URL,
    ...(process.env.CORS_ORIGINS || "").split(","),
  ]
    .map(normalizeOrigin)
    .filter(Boolean);

  return new Set([...DEFAULT_APP_ORIGINS, ...configured].map(normalizeOrigin));
}

export function isOriginAllowed(origin) {
  // Requests without an Origin header include Meta webhooks, health checks,
  // Docker networking and other server-to-server traffic.
  if (!origin) return true;
  return getAllowedOrigins().has(normalizeOrigin(origin));
}

export function expressCorsOptions() {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      console.warn(`[cors] blocked origin: ${origin}`);
      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["Content-Length", "Content-Type"],
    credentials: false,
    maxAge: 86400,
    optionsSuccessStatus: 204,
  };
}

export function socketCorsOptions() {
  return {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      console.warn(`[socket:cors] blocked origin: ${origin}`);
      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: false,
  };
}
