import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./infrastructure/config.js";
import { cleanupOperationalEvents, recordOperationalEvent } from "./infrastructure/observability/operational-events.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import { authRoutes, enforceSessionRevocation } from "./modules/auth/routes.js";
import { backtestRoutes } from "./modules/backtests/routes.js";
import { candleRoutes } from "./modules/candles/routes.js";
import { coreEngineRoutes } from "./modules/core-engines/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { importRoutes } from "./modules/imports/routes.js";
import { journalRoutes } from "./modules/journal/routes.js";
import { startLiveEventBridge, stopLiveEventBridge } from "./modules/live-stream/hub.js";
import { liveStreamRoutes } from "./modules/live-stream/routes.js";
import { marketDataRoutes } from "./modules/market-data/routes.js";
import { mobileRoutes } from "./modules/mobile/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { observationRoutes } from "./modules/observations/routes.js";
import { newsRoutes } from "./modules/news/routes.js";
import { riskRoutes } from "./modules/risk/routes.js";
import { sessionRoutes } from "./modules/sessions/routes.js";
import { setupRoutes } from "./modules/setups/routes.js";
import { strategyRoutes } from "./modules/strategies/routes.js";
import { tradeRoutes } from "./modules/trades/routes.js";

const app = Fastify({ logger: true, trustProxy: 1 });
const startedAtIso = new Date().toISOString();

app.addHook("onRequest", async (request) => {
  (request as any).startedAtMs = Date.now();
});

app.addHook("onResponse", async (request, reply) => {
  const durationMs = Date.now() - Number((request as any).startedAtMs ?? Date.now());
  const route = request.routeOptions.url ?? request.url;
  const statusCode = reply.statusCode;
  const slow = durationMs >= config.slowRequestThresholdMs;
  const failed = statusCode >= 500;
  const internalBundleRequest = request.headers["x-orb-internal-bundle"] === "1";
  if (!internalBundleRequest && (slow || failed)) {
    void recordOperationalEvent({
      severity: failed ? "ERROR" : "WARN",
      category: "API",
      eventType: failed ? "API_REQUEST_FAILED" : "API_REQUEST_SLOW",
      source: "api-server",
      requestId: request.id,
      route,
      method: request.method,
      statusCode,
      durationMs,
      message: `${request.method} ${route} completed with ${statusCode} in ${durationMs}ms.`,
      metadata: { url: request.url }
    });
  }
  if (!internalBundleRequest) void cleanupOperationalEvents();
});

await app.register(cors, {
  credentials: true,
  origin: (origin, callback) => {
    if (!origin || config.nodeEnv !== "production") return callback(null, true);
    const allowed = new Set([
      ...config.allowedOrigins,
      config.publicApiBaseUrl,
      config.publicWebBaseUrl,
      config.billingSuccessUrl ? new URL(config.billingSuccessUrl).origin : "",
      config.billingCancelUrl ? new URL(config.billingCancelUrl).origin : ""
    ].filter(Boolean));
    callback(null, allowed.has(origin));
  }
});
await app.register(websocket);
await startLiveEventBridge();
app.addHook("onClose", async () => stopLiveEventBridge());
await app.register(multipart, {
  limits: {
    files: 1,
    fileSize: 220 * 1024 * 1024
  }
});
app.addHook("preHandler", enforceSessionRevocation);
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(liveStreamRoutes);
await app.register(strategyRoutes);
await app.register(sessionRoutes);
await app.register(setupRoutes);
await app.register(tradeRoutes);
await app.register(riskRoutes);
await app.register(journalRoutes);
await app.register(backtestRoutes);
await app.register(analyticsRoutes);
await app.register(coreEngineRoutes);
await app.register(importRoutes);
await app.register(candleRoutes);
await app.register(marketDataRoutes);
await app.register(mobileRoutes);
await app.register(notificationRoutes);
await app.register(observationRoutes);
await app.register(newsRoutes);
await app.register(dashboardRoutes);

app.get("/api/health", async () => ({
  status: "ok",
  service: "personal-xauusd-orb-guide-api",
  version: appVersion(),
  nodeEnv: config.nodeEnv,
  deploySha: process.env.DEPLOY_SHA ?? process.env.COMMIT_SHA ?? null,
  startedAt: startedAtIso,
  uptimeSeconds: Math.round(process.uptime()),
  pid: process.pid
}));

await app.listen({ port: config.port, host: "0.0.0.0" });

function appVersion() {
  try {
    const content = readFileSync(resolve(process.cwd(), "../../package.json"), "utf8");
    return JSON.parse(content).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
