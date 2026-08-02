import type { FastifyInstance } from "fastify";
import { addLiveClient, liveClientCount } from "./hub.js";

export async function liveStreamRoutes(app: FastifyInstance) {
  app.get("/api/live/ws", { websocket: true } as any, (connection: any) => {
    const socket = connection.socket;
    const removeClient = addLiveClient(socket);
    socket.on("close", removeClient);
    socket.on("error", removeClient);
  });

  app.get("/api/live/status", async () => ({
    websocket: true,
    connectedClients: liveClientCount()
  }));
}
