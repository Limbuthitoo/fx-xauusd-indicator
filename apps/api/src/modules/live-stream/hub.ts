type LiveSocket = {
  readyState: number;
  send: (data: string) => void;
};

const OPEN = 1;
const clients = new Set<LiveSocket>();

export function addLiveClient(socket: LiveSocket) {
  clients.add(socket);
  socket.send(JSON.stringify({ type: "connected", connectedClients: clients.size, sentAt: new Date().toISOString() }));
  return () => {
    clients.delete(socket);
  };
}

export function broadcastLiveEvent(payload: Record<string, unknown>) {
  const message = JSON.stringify({ ...payload, sentAt: new Date().toISOString() });
  for (const socket of clients) {
    if (socket.readyState !== OPEN) {
      clients.delete(socket);
      continue;
    }
    socket.send(message);
  }
}

export function liveClientCount() {
  return clients.size;
}
