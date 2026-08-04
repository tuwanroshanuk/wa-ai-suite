import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { socketCorsOptions } from "./config/cors.js";

let io;
const connectedAgents = new Map();

export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: socketCorsOptions(),
    transports: ["websocket", "polling"],
    pingTimeout: 20000,
    pingInterval: 10000,
  });

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
    connectedAgents.set(socket.id, socket.user);
    socket.join("dashboard");
    io.to("dashboard").emit("presence:agents", { online: connectedAgents.size });

    socket.on("disconnect", () => {
      connectedAgents.delete(socket.id);
      io?.to("dashboard").emit("presence:agents", { online: connectedAgents.size });
      console.log(`[socket] agent disconnected: ${socket.user?.email}`);
    });
  });

  return io;
}

export function getOnlineAgentCount() {
  return connectedAgents.size;
}

export function emitToDashboard(event, payload) {
  if (!io) return;
  io.to("dashboard").emit(event, payload);
}
