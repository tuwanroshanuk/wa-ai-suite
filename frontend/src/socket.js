import { io } from "socket.io-client";
import { API_URL } from "./api";
import { useAuthStore } from "./store/auth";

let socket;

// Lazily creates (or reuses) a single authenticated socket.io connection to
// the backend, so every page that needs live updates (incoming calls, new
// messages, etc.) shares one connection instead of opening its own.
export function getSocket() {
  if (socket) return socket;
  const token = useAuthStore.getState().token;
  socket = io(API_URL, {
    auth: { token },
    autoConnect: !!token,
  });
  return socket;
}
