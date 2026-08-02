import { Redis } from "ioredis";
import { config } from "../config.js";

let redis: Redis | null | undefined;

export function redisClient() {
  if (!config.redisUrl) return null;
  if (redis !== undefined) return redis;
  redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false
  });
  redis.on("error", () => undefined);
  return redis;
}

export async function redisHealth() {
  const client = redisClient();
  if (!client) {
    return {
      status: config.redisRequired ? "CRITICAL" : "DISABLED",
      message: config.redisRequired ? "Redis is required but REDIS_URL is not configured." : "Redis is optional and not configured.",
      configured: false,
      required: config.redisRequired
    };
  }
  const started = Date.now();
  try {
    if (client.status === "wait" || client.status === "end") await client.connect();
    const pong = await client.ping();
    const info = await client.info("memory").catch(() => "");
    return {
      status: pong === "PONG" ? "HEALTHY" : "DEGRADED",
      message: pong === "PONG" ? `Redis responded in ${Date.now() - started}ms.` : "Redis ping returned an unexpected response.",
      configured: true,
      required: config.redisRequired,
      latencyMs: Date.now() - started,
      connectionStatus: client.status,
      memory: parseRedisInfo(info)
    };
  } catch (error) {
    return {
      status: config.redisRequired ? "CRITICAL" : "DEGRADED",
      message: `Redis is configured but unavailable: ${(error as Error).message}`,
      configured: true,
      required: config.redisRequired,
      latencyMs: Date.now() - started,
      connectionStatus: client.status,
      error: (error as Error).message
    };
  }
}

function parseRedisInfo(info: string) {
  const used = info.match(/^used_memory_human:(.+)$/m)?.[1]?.trim();
  const peak = info.match(/^used_memory_peak_human:(.+)$/m)?.[1]?.trim();
  return { used, peak };
}
