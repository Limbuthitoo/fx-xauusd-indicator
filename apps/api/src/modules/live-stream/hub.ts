import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { redisClient } from "../../infrastructure/redis/client.js";

type LiveSocket = {
  readyState: number;
  send: (data: string) => void;
};

const OPEN = 1;
const LIVE_EVENT_CHANNEL = "xauusd:live-events:v1";
const processOrigin = `${process.pid}:${randomUUID()}`;
const clients = new Set<LiveSocket>();
let subscriber: Redis | null = null;

export function addLiveClient(socket: LiveSocket) {
  clients.add(socket);
  socket.send(JSON.stringify({ type: "connected", connectedClients: clients.size, sentAt: new Date().toISOString() }));
  return () => {
    clients.delete(socket);
  };
}

export function broadcastLiveEvent(payload: Record<string, unknown>) {
  const event = publicLiveEvent(payload);
  broadcastLocal(event);
  void publishLiveEvent(event);
}

export async function startLiveEventBridge() {
  if (subscriber) return;
  const client = redisClient();
  if (!client) return;
  subscriber = client.duplicate({ lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  subscriber.on("error", () => undefined);
  if (subscriber.status === "wait" || subscriber.status === "end") await subscriber.connect();
  subscriber.on("message", (_channel, raw) => {
    try {
      const envelope = JSON.parse(raw) as { origin?: string; event?: Record<string, unknown> };
      if (envelope.origin === processOrigin || !envelope.event) return;
      broadcastLocal(envelope.event);
    } catch {
      // Ignore malformed distributed events; HTTP refresh remains the client fallback.
    }
  });
  await subscriber.subscribe(LIVE_EVENT_CHANNEL);
}

export async function stopLiveEventBridge() {
  const current = subscriber;
  subscriber = null;
  if (!current) return;
  await current.unsubscribe(LIVE_EVENT_CHANNEL).catch(() => undefined);
  current.disconnect();
}

function broadcastLocal(payload: Record<string, unknown>) {
  const message = JSON.stringify(payload);
  for (const socket of clients) {
    if (socket.readyState !== OPEN) {
      clients.delete(socket);
      continue;
    }
    socket.send(message);
  }
}

async function publishLiveEvent(event: Record<string, unknown>) {
  const client = redisClient();
  if (!client) return;
  try {
    if (client.status === "wait" || client.status === "end") await client.connect();
    await client.publish(LIVE_EVENT_CHANNEL, JSON.stringify({ origin: processOrigin, event }));
  } catch {
    // Redis/WebSocket acceleration is optional; PostgreSQL and HTTP remain authoritative.
  }
}

function publicLiveEvent(payload: Record<string, unknown>) {
  if (payload.type === "candle") {
    return {
      type: "candle",
      provider: payload.provider,
      symbol: payload.symbol,
      timeframeMinutes: payload.timeframeMinutes,
      candle: payload.candle,
      automation: Boolean(payload.automation),
      sentAt: new Date().toISOString()
    };
  }
  return {
    type: "automation.changed",
    symbol: payload.symbol ?? "XAUUSD",
    automation: true,
    sentAt: new Date().toISOString()
  };
}

export function liveClientCount() {
  return clients.size;
}
