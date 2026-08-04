import { io } from "socket.io-client";
import { API_URL } from "./api";
import { useAuthStore } from "./store/auth";

let socket;

// Lazily creates (or reuses) a single authenticated Socket.IO connection.
// Prefer WebSocket to avoid repeated long-polling preflight requests, while
// keeping polling as a fallback for restrictive networks.
export function getSocket() {
  const token = useAuthStore.getState().token;

  if (socket) {
    socket.auth = { token };
    if (token && !socket.connected) socket.connect();
    return socket;
  }

  socket = io(API_URL, {
    auth: { token },
    autoConnect: !!token,
    transports: ["websocket", "polling"],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  return socket;
}
