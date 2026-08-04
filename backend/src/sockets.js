import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let io;

export function initSockets(httpServer) {
  io = new Server(httpServer, { cors: { origin: "*" } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch (err) {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    console.log(`[socket] agent connected: ${socket.user?.email}`);
    socket.join("dashboard");
  });

  return io;
}

export function emitToDashboard(event, payload) {
  if (!io) return;
  io.to("dashboard").emit(event, payload);
}
