import type { FastifyInstance } from "fastify";
import { evaluateLiquiditySweepSetup } from "@orb-guide/liquidity-sweep-engine";
import { calculateRisk } from "@orb-guide/risk-engine";
import type { Candle, RuleContext } from "@orb-guide/shared-types";
import { buildOpeningRange, evaluateSetup } from "@orb-guide/strategy-engine";
import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";
import { recordOperationalEvent } from "../../infrastructure/observability/operational-events.js";
import { redisClient } from "../../infrastructure/redis/client.js";
import { newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { runDeterministicStrategyCoachPython, runMainBrainPython, runModule2LearningPython, runOrbLearningPython } from "../admin/learning.js";
import { getRuntimeSettings, getTenantModuleStrategyConfiguration, getTenantOrbStrategyConfiguration, type RuntimeSettings } from "../admin/settings.js";
import { requireAdmin, requireTenantModule } from "../auth/routes.js";
import { canCreateTenantNotification } from "../billing/limits.js";
import { broadcastLiveEvent, liveClientCount } from "../live-stream/hub.js";
import { sendTenantPush } from "../notifications/push.js";

type TwelveDataTimeSeriesResponse = {
  status?: "ok" | "error";
  code?: number;
  message?: string;
  meta?: {
    symbol?: string;
    interval?: string;
    currency_base?: string;
    currency_quote?: string;
    type?: string;
  };
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
};

type TwelveDataWorkerState = {
  running: boolean;
  provider: "TWELVE_DATA";
  configured: boolean;
  symbol: string;
  providerSymbol: string;
  timeframeMinutes: number;
  interval: string;
  pollSeconds: number;
  count: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastSyncAt: string | null;
  lastImported: number;
  lastRequestedCount: number;
  lastError: string | null;
  lastEvaluationAt: string | null;
  cycles: number;
};

type AutoRunState = {
  enabled: boolean;
  running: boolean;
  phase: "STARTING" | "API_KEY_MISSING" | "PRE_SESSION" | "CATCH_UP" | "MONITORING" | "AFTER_WINDOW" | "PAUSED" | "ERROR";
  symbol: string;
  timeframeMinutes: number;
  provider: "TWELVE_DATA";
  startLeadMinutes: number;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
  lastError: string | null;
  sessionId: string | null;
  sessionState: string | null;
  sessionStartAt: string | null;
  openingRangeEndAt: string | null;
  signalWindowEndAt: string | null;
  apiStartAt: string | null;
  apiStopAt: string | null;
  nextActionAt: string | null;
  lastLearningRunAt: string | null;
  lastLearningSessionId: string | null;
  lastLearningResult: Record<string, unknown> | null;
  reason: string;
};

type TenantAutoRunState = AutoRunState & {
  tenantId: string;
  tenantName: string;
  moduleCode: string;
  moduleName: string;
  latestCandleAt: string | null;
  latestSetupId: string | null;
  latestTradeId: string | null;
};

const AUTO_API_START_LEAD_MINUTES = 15;
const DEFAULT_TENANT_SLUG = "default-orb-tenant";
const LIVE_CANDLE_CACHE_DAYS = 7;
const TWELVE_DATA_STARTUP_BACKFILL_COUNT = 7 * 24 * 12;
const TWELVE_DATA_LIVE_POLL_COUNT = 2;
const TWELVE_DATA_CATCHUP_MINIMUM_COUNT = 8;
const TWELVE_DATA_CALL_LOCK_ID = 2026080201;
const SHARED_TWELVE_DATA_SOURCE_TIMEFRAME = 5;
const ORB_RANGE_TIMEFRAME_MINUTES = 5;
const ORB_RANGE_SOURCE_CANDLES = 3;
const ORB_SESSION_PRESETS = [
  { preset: "SYDNEY_ORB", label: "Sydney", sessionStart: "17:00", tradeWindowEnd: "02:00" },
  { preset: "TOKYO_ORB", label: "Tokyo", sessionStart: "20:00", tradeWindowEnd: "05:00" },
  { preset: "LONDON_ORB", label: "London", sessionStart: "03:00", tradeWindowEnd: "12:00" },
  { preset: "NEW_YORK_ORB", label: "New York", sessionStart: "09:15", tradeWindowEnd: "16:00" }
] as const;
const DEFAULT_TWELVE_DATA_TIMEFRAME = twelveIntervalToTimeframe(config.twelveDataInterval) || SHARED_TWELVE_DATA_SOURCE_TIMEFRAME;
const XAUUSD_PAPER_SPEC = {
  contractSize: 100,
  tickSize: 0.01,
  tickValue: 1,
  minimumLot: 0.01,
  lotStep: 0.01,
  maximumLot: 50,
  commissionPerLot: 0
};
let runtimeSettings: RuntimeSettings | null = null;
const tenantAutomationStates = new Map<string, TenantAutoRunState>();

type LiveCandle = {
  timestampUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  spread: number | null;
  source: string;
  receivedAt: string;
};

const liveCandleCache = new Map<string, LiveCandle[]>();

let twelveDataTimer: NodeJS.Timeout | null = null;
const twelveDataState: TwelveDataWorkerState = {
  running: false,
  provider: "TWELVE_DATA",
  configured: Boolean(config.twelveDataApiKey),
  symbol: "XAUUSD",
  providerSymbol: config.twelveDataSymbol,
  timeframeMinutes: DEFAULT_TWELVE_DATA_TIMEFRAME,
  interval: timeframeToTwelveInterval(DEFAULT_TWELVE_DATA_TIMEFRAME),
  pollSeconds: Math.max(config.twelveDataPollSeconds, 300),
  count: 200,
  startedAt: null,
  stoppedAt: null,
  lastSyncAt: null,
  lastImported: 0,
  lastRequestedCount: 0,
  lastError: null,
  lastEvaluationAt: null,
  cycles: 0
};

let autoRunTimer: NodeJS.Timeout | null = null;
let offSessionCatchupAttemptAt: number | null = null;
const autoRunState: AutoRunState = {
  enabled: true,
  running: false,
  phase: "STARTING",
  symbol: "XAUUSD",
  timeframeMinutes: DEFAULT_TWELVE_DATA_TIMEFRAME,
  provider: "TWELVE_DATA",
  startLeadMinutes: AUTO_API_START_LEAD_MINUTES,
  lastCheckedAt: null,
  lastActionAt: null,
  lastError: null,
  sessionId: null,
  sessionState: null,
  sessionStartAt: null,
  openingRangeEndAt: null,
  signalWindowEndAt: null,
  apiStartAt: null,
  apiStopAt: null,
  nextActionAt: null,
  lastLearningRunAt: null,
  lastLearningSessionId: null,
  lastLearningResult: null,
  reason: "Auto-run is starting."
};

export async function marketDataRoutes(app: FastifyInstance) {
  if (config.embeddedMarketDataWorker) startMarketDataWorker();

  app.get("/api/market-data/providers", async () => {
    const settings = await refreshRuntimeSettings();
    return [
      {
        code: "TWELVE_DATA",
        name: "Twelve Data XAU/USD REST feed",
        cost: "Free Basic plan: 800 credits/day, 8 credits/min",
        writesToPostgres: settings.feed.rawCandleStorage,
        statusEndpoint: "/api/market-data/twelve-data/live/status",
        recommended: true,
        note: settings.feed.rawCandleStorage
          ? "Poll live during New York and use shared catch-up for other ORB sessions; raw candles are persisted."
          : "Poll live during New York and use shared catch-up for other ORB sessions. Only valid records are persisted."
      },
      {
      code: "CSV",
      name: "CSV import",
      cost: "Free",
      writesToPostgres: true,
      statusEndpoint: "/api/imports/candles"
    },
    {
      code: "DEMO",
      name: "Local simulated candles",
      cost: "Free",
      writesToPostgres: true,
      statusEndpoint: "/api/imports/demo-candles"
    },
    ];
  });

  app.get("/api/market-data/twelve-data/status", async () => {
    const settings = await refreshRuntimeSettings();
    return {
      provider: "TWELVE_DATA",
      configured: Boolean(config.twelveDataApiKey),
      symbol: twelveDataState.symbol,
      providerSymbol: twelveDataState.providerSymbol,
      interval: twelveDataState.interval,
      pollSeconds: twelveDataState.pollSeconds,
      catchupSeconds: config.twelveDataCatchupSeconds,
      startupBackfillCount: settings.feed.startupBackfillCount,
      livePollCount: settings.feed.livePollCount,
      schedulerMode: twelveDataState.running ? "NY_LIVE_60S" : autoRunState.phase === "CATCH_UP" ? "OFF_SESSION_30M" : "PAUSED",
      lastRequestedCount: twelveDataState.lastRequestedCount,
      persistRawCandles: settings.feed.rawCandleStorage,
      liveCacheDays: settings.feed.cacheDays,
      cachedCandles: getCachedCandles(twelveDataState.symbol, twelveDataState.timeframeMinutes).length,
      message: config.twelveDataApiKey
        ? settings.feed.rawCandleStorage
          ? "Twelve Data API key is configured. Raw candles are persisted."
          : "Twelve Data API key is configured. Raw candles stay in memory; only valid ORB records are persisted."
        : "Set TWELVE_DATA_API_KEY in .env, then restart the API."
    };
  });

  app.post("/api/market-data/twelve-data/sync", async (request) => {
    const session = requireAdmin(request);
    const body = request.body as { symbol?: string; providerSymbol?: string; timeframeMinutes?: number; interval?: string; count?: number; autoEvaluate?: boolean; force?: boolean; reason?: string };
    if (!body.force && !session.platformSuperAdmin) {
      const error = new Error("Manual Twelve Data sync requires platform admin force mode.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    return syncTwelveDataCandles({
      symbol: body.symbol ?? twelveDataState.symbol,
      providerSymbol: body.providerSymbol ?? twelveDataState.providerSymbol,
      timeframeMinutes: body.timeframeMinutes ?? twelveIntervalToTimeframe(body.interval ?? twelveDataState.interval),
      interval: body.interval ?? timeframeToTwelveInterval(body.timeframeMinutes ?? twelveDataState.timeframeMinutes),
      count: body.count ?? twelveDataState.count,
      autoEvaluate: body.autoEvaluate ?? true,
      force: body.force === true && session.platformSuperAdmin,
      triggerSource: "MANUAL_ADMIN_SYNC",
      usageReason: body.reason ?? "Manual admin Twelve Data sync"
    });
  });

  app.post("/api/market-data/twelve-data/chart-sync", async (request) => {
    const settings = await refreshRuntimeSettings();
    const body = request.body as { symbol?: string; providerSymbol?: string; timeframeMinutes?: number; moduleCode?: string };
    const moduleCode = body.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const timeframe = body.timeframeMinutes ?? moduleTimeframeMinutes(moduleCode, settings);
    const symbol = body.symbol ?? settings.symbol;
    const providerSymbol = body.providerSymbol ?? settings.feed.providerSymbol;
    try {
      return await syncTwelveDataChartCandles({
        symbol,
        providerSymbol,
        timeframeMinutes: timeframe,
        moduleCode,
        tenantId: auth.tenantId,
        startupBackfillCount: settings.feed.startupBackfillCount,
        livePollCount: settings.feed.livePollCount
      });
    } catch (error) {
      const cached = getCachedCandles(symbol, timeframe);
      await recordOperationalEvent({
        severity: "ERROR",
        category: "TWELVE_DATA",
        eventType: "TWELVE_DATA_CHART_SYNC_ERROR",
        source: "market-data-api",
        message: `Twelve Data chart sync failed: ${(error as Error).message}`,
        metadata: { symbol, timeframeMinutes: timeframe, moduleCode, tenantId: auth.tenantId, error: (error as Error).message }
      }).catch(() => undefined);
      return {
        connected: false,
        provider: "TWELVE_DATA",
        symbol,
        timeframeMinutes: timeframe,
        imported: 0,
        skipped: true,
        reason: "TWELVE_DATA_CHART_SYNC_ERROR",
        error: (error as Error).message,
        cachedCandles: cached.length,
        latestCandle: cached.at(-1) ?? null
      };
    }
  });

  app.post("/api/market-data/twelve-data/live/start", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const settings = await refreshRuntimeSettings();
    const body = request.body as { symbol?: string; providerSymbol?: string; timeframeMinutes?: number; interval?: string; pollSeconds?: number; count?: number };
    return startTwelveDataLive({
      symbol: body.symbol ?? settings.symbol,
      providerSymbol: body.providerSymbol ?? settings.feed.providerSymbol,
      timeframeMinutes: body.timeframeMinutes ?? settings.timeframeMinutes,
      interval: body.interval,
      pollSeconds: body.pollSeconds ?? settings.feed.pollSeconds,
      count: body.count,
      notify: true
    });
  });

  app.post("/api/market-data/twelve-data/live/stop", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    return stopTwelveDataLive({ notify: true });
  });

  app.get("/api/market-data/twelve-data/live/status", async () => {
    const settings = await refreshRuntimeSettings();
    const postgresCount = await query(
      "SELECT count(*)::int AS count FROM candles WHERE symbol = $1 AND timeframe_minutes = $2 AND source LIKE 'TWELVE_DATA%'",
      [twelveDataState.symbol, twelveDataState.timeframeMinutes]
    ).catch(() => ({ rows: [{ count: 0 }] }));
    const memoryCandles = getCachedCandles(twelveDataState.symbol, twelveDataState.timeframeMinutes).length;
    return {
      ...twelveDataState,
      configured: Boolean(config.twelveDataApiKey),
      startupBackfillCount: settings.feed.startupBackfillCount,
      livePollCount: settings.feed.livePollCount,
      catchupSeconds: config.twelveDataCatchupSeconds,
      schedulerMode: twelveDataState.running ? "NY_LIVE_60S" : autoRunState.phase === "CATCH_UP" ? "OFF_SESSION_30M" : "PAUSED",
      persistRawCandles: settings.feed.rawCandleStorage,
      liveCacheDays: settings.feed.cacheDays,
      memoryCandles,
      postgresCandles: Number(postgresCount.rows[0]?.count ?? 0),
      cachedCandles: memoryCandles + Number(postgresCount.rows[0]?.count ?? 0)
    };
  });

  app.get("/api/market-data/live/cache", async (request) => {
    const settings = await refreshRuntimeSettings();
    const search = request.query as { symbol?: string; timeframeMinutes?: string; limit?: string };
    const symbol = search.symbol ?? settings.symbol;
    const timeframe = Number(search.timeframeMinutes ?? settings.timeframeMinutes);
    const limit = Math.min(Number(search.limit ?? liveCandleCacheLimit(timeframe)), liveCandleCacheLimit(timeframe));
    const cached = getCachedCandles(symbol, timeframe);
    const postgresRows = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source LIKE 'TWELVE_DATA%'
       ORDER BY timestamp_utc DESC
       LIMIT $3`,
      [symbol, timeframe, limit]
    ).catch(() => ({ rows: [] as any[] }));
    const postgresCandles = postgresRows.rows.reverse().map((row: any) => ({
      timestampUtc: row.timestamp_utc,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume == null ? null : Number(row.volume),
      spread: row.spread == null ? null : Number(row.spread),
      source: row.source,
      receivedAt: row.created_at
    }));
    const candles = normalizeLiveCandles([...postgresCandles, ...cached]).slice(-limit);
    return {
      symbol,
      timeframeMinutes: timeframe,
      cacheDays: settings.feed.cacheDays,
      cacheLimit: liveCandleCacheLimit(timeframe),
      memoryCandles: cached.length,
      postgresCandles: Number(postgresRows.rows.length ?? 0),
      cachedCandles: candles.length,
      persistRawCandles: settings.feed.rawCandleStorage,
      latestCandle: candles.at(-1) ?? null,
      candles
    };
  });

  app.delete("/api/market-data/live/cache", async (request) => {
    const settings = await refreshRuntimeSettings();
    const search = request.query as { symbol?: string; timeframeMinutes?: string };
    const symbol = search.symbol ?? settings.symbol;
    const timeframe = Number(search.timeframeMinutes ?? settings.timeframeMinutes);
    const key = cacheKey(symbol, timeframe);
    const cleared = liveCandleCache.get(key)?.length ?? 0;
    liveCandleCache.delete(key);
    return { symbol, timeframeMinutes: timeframe, cleared, cachedCandles: 0 };
  });

  app.get("/api/orb/data-readiness", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    const settings = await getRuntimeSettings(session.tenantId);
    return buildOrbDataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays, settings);
  });

  app.post("/api/orb/data-readiness/backfill", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    const settings = await getRuntimeSettings(session.tenantId);
    await hydrateChartCacheFromPostgres(settings.symbol, settings.timeframeMinutes, settings.feed.startupBackfillCount);
    const readiness = await buildOrbDataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays, settings);
    return {
      provider: "TWELVE_DATA",
      symbol: settings.symbol,
      timeframeMinutes: settings.timeframeMinutes,
      requestedCount: 0,
      estimatedApiCreditsUsed: 0,
      persistRawCandles: settings.feed.rawCandleStorage,
      result: { connected: true, skipped: true, reason: "SHARED_POSTGRES_FEED_ONLY" },
      before: readiness,
      after: readiness
    };
  });

  app.get("/api/automation/status", async () => {
    const settings = await refreshRuntimeSettings();
    const tenantId = await defaultTenantId();
    const tenantState = tenantId ? tenantAutomationStates.get(tenantStateKey(tenantId, "orb_max_options")) : null;
    const state = tenantState ?? autoRunState;
    return {
      ...state,
      settings,
      nepalSchedule: {
        apiStart: formatNepalTime(state.apiStartAt),
        sessionStart: formatNepalTime(state.sessionStartAt),
        apiStop: formatNepalTime(state.apiStopAt),
        nextAction: formatNepalTime(state.nextActionAt)
      },
      feed: {
        ...twelveDataState,
        configured: Boolean(config.twelveDataApiKey),
        startupBackfillCount: settings.feed.startupBackfillCount,
        livePollCount: settings.feed.livePollCount,
        persistRawCandles: settings.feed.rawCandleStorage,
        liveCacheDays: settings.feed.cacheDays,
        cachedCandles: getCachedCandles(twelveDataState.symbol, twelveDataState.timeframeMinutes).length
      }
    };
  });

  app.get("/api/tenant/automation/status", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    if (!session.tenantId) return null;
    const settings = await getRuntimeSettings(session.tenantId);
    const state = tenantAutomationStates.get(tenantStateKey(session.tenantId, moduleCode)) ?? (await loadTenantAutomationState(session.tenantId, moduleCode));
    return {
      ...state,
      settings,
      nepalSchedule: {
        apiStart: formatNepalTime(state.apiStartAt),
        sessionStart: formatNepalTime(state.sessionStartAt),
        apiStop: formatNepalTime(state.apiStopAt),
        nextAction: formatNepalTime(state.nextActionAt)
      }
    };
  });

  app.get("/api/module2/readiness", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Readiness(session.tenantId, false);
  });

  app.post("/api/module2/readiness/dry-run", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Readiness(session.tenantId, true);
  });

  app.get("/api/module2/health", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Health(session.tenantId, false);
  });

  app.post("/api/module2/health/run", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Health(session.tenantId, true);
  });

  app.get("/api/module2/data-readiness", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const settings = await getRuntimeSettings(session.tenantId);
    return buildModule2DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
  });

  app.post("/api/module2/data-readiness/backfill", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const settings = await getRuntimeSettings(session.tenantId);
    await hydrateChartCacheFromPostgres(settings.symbol, 5, settings.feed.startupBackfillCount);
    const readiness = await buildModule2DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
    return {
      provider: "TWELVE_DATA",
      symbol: settings.symbol,
      timeframeMinutes: 5,
      requestedCount: 0,
      estimatedApiCreditsUsed: 0,
      persistRawCandles: settings.feed.rawCandleStorage,
      result: { connected: true, skipped: true, reason: "SHARED_POSTGRES_FEED_ONLY" },
      before: readiness,
      after: readiness
    };
  });

  app.get("/api/strategy-coach/latest", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    const search = request.query as { moduleCode?: string };
    if (search.moduleCode) return latestModuleLearningSnapshot(session.tenantId, search.moduleCode);
    return latestStrategyCoachSnapshots(session.tenantId);
  });

  app.post("/api/strategy-coach/run", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    if (!session.tenantId) return { error: "Tenant account is required for strategy coach learning." };
    const body = request.body as { moduleCode?: string };
    if (body.moduleCode) await requireTenantModule(request, body.moduleCode);
    const result = await runDeterministicStrategyCoachPython(session.tenantId, body.moduleCode);
    return { result, latest: body.moduleCode ? await latestModuleLearningSnapshot(session.tenantId, body.moduleCode) : await latestStrategyCoachSnapshots(session.tenantId) };
  });

  app.get("/api/main-brain/latest", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    const search = request.query as { moduleCode?: string };
    return latestMainBrainDecisions(session.tenantId, search.moduleCode);
  });

  app.post("/api/main-brain/run", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    if (!session.tenantId) return { error: "Tenant account is required for main brain decisions." };
    const body = request.body as { moduleCode?: string };
    if (body.moduleCode) await requireTenantModule(request, body.moduleCode);
    const result = await runMainBrainPython(session.tenantId, body.moduleCode);
    return { result, latest: await latestMainBrainDecisions(session.tenantId, body.moduleCode) };
  });

  app.get("/api/module2/operator", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Operator(session.tenantId, false);
  });

  app.post("/api/module2/launch-rehearsal", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2Operator(session.tenantId, true);
  });

  app.get("/api/module2/launch-rehearsals", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const rows = await query(
      `SELECT id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
       ORDER BY created_at DESC
       LIMIT 20`,
      [session.tenantId]
    );
    return rows.rows;
  });

  app.get("/api/module2/closeouts", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const rows = await module2CloseoutRows(session.tenantId);
    return rows;
  });

  app.post("/api/module2/closeouts/rerun", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { sessionDate?: string };
    const tradingSession = await module2SessionForCloseout(session.tenantId, body.sessionDate);
    if (!tradingSession) return { error: "No Module 2 session found for that NY date." };
    await query("DELETE FROM module_session_closeouts WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2' AND session_date = $2", [session.tenantId, tradingSession.session_date]);
    const closeout = await runModule2CloseoutAfterSession(tradingSession);
    return { closeout, history: await module2CloseoutRows(session.tenantId) };
  });

  app.post("/api/module2/closeouts/report-only", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { sessionDate?: string };
    const tradingSession = await module2SessionForCloseout(session.tenantId, body.sessionDate);
    if (!tradingSession) return { error: "No Module 2 session found for that NY date." };
    const report = await generateModule2AutoSessionReport(tradingSession);
    return { report, history: await module2CloseoutRows(session.tenantId) };
  });

  app.post("/api/module2/closeouts/learning-only", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    if (!session.tenantId) return { error: "Tenant account is required." };
    const learning = await runModule2LearningPython(session.tenantId);
    return { learning };
  });

  app.post("/api/module2/closeouts/reseed-reviews", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    if (!session.tenantId) return { error: "Tenant account is required." };
    const latest = await latestModule2LearningSnapshot(session.tenantId);
    if (!latest?.id) return { error: "No Module 2 learning run is available to seed reviews." };
    const created = await seedModule2LearningReviewItems(session.tenantId, latest.id);
    return { created };
  });

  app.get("/api/platform/automation/status", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const rows = await platformAutomationStatusRows();
    return rows;
  });

  app.post("/api/platform/automation/run", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    return runAutoRunCycle();
  });

  app.post("/api/platform/market-data/force-sync", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const settings = await refreshRuntimeSettings();
    const body = request.body as { count?: number; reason?: string };
    const count = Math.min(Math.max(Number(body.count ?? settings.feed.livePollCount), 1), settings.feed.startupBackfillCount);
    return syncTwelveDataCandles({
      symbol: settings.symbol,
      providerSymbol: settings.feed.providerSymbol,
      timeframeMinutes: SHARED_TWELVE_DATA_SOURCE_TIMEFRAME,
      interval: timeframeToTwelveInterval(SHARED_TWELVE_DATA_SOURCE_TIMEFRAME),
      count,
      autoEvaluate: false,
      force: true,
      triggerSource: "PLATFORM_FORCE_SYNC",
      usageReason: body.reason ?? "Platform admin forced guarded market-data sync"
    });
  });

  app.put("/api/platform/tenants/:id/automation", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const { id } = request.params as { id: string };
    const body = request.body as { enabled?: boolean };
    const enabled = body.enabled !== false;
    const tenant = await query("SELECT id, name, slug FROM platform_tenants WHERE id = $1", [id]);
    if (!tenant.rows[0]) {
      const error = new Error("Tenant not found.") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const settings = await getRuntimeSettings(id);
    const state = tenantStateFor(tenant.rows[0], settings);
    state.enabled = enabled;
    state.running = enabled ? state.running : false;
    state.phase = enabled ? state.phase : "PAUSED";
    state.reason = enabled ? "Automation resumed by platform admin." : "Automation paused by platform admin.";
    state.lastActionAt = new Date().toISOString();
    tenantAutomationStates.set(id, state);
    await persistTenantAutomationState(state);
    await runAutoRunCycle();
    return state;
  });

  app.get("/api/platform/usage/twelve-data", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    return twelveDataUsageSummary();
  });

  app.get("/api/market-data/live/status", async (request) => {
    const settings = await refreshRuntimeSettings();
    const search = request.query as { symbol?: string; timeframeMinutes?: string; staleAfterSeconds?: string };
    const symbol = search.symbol ?? settings.symbol;
    const timeframe = Number(search.timeframeMinutes ?? settings.timeframeMinutes);
    const staleAfterSeconds = Number(search.staleAfterSeconds ?? timeframe * 60 * 2);
    const latestTwelveResult = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source = 'TWELVE_DATA'
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const cachedLatest = getCachedCandles(symbol, timeframe).at(-1);
    const latestTwelve = cachedLatest ? liveCandleToRow(cachedLatest) : undefined;
    const latest = latestTwelve ?? latestTwelveResult.rows[0] as any | undefined;
    const receivedAt = latest?.created_at ? new Date(latest.created_at) : null;
    const ageSeconds = receivedAt ? Math.max(0, Math.round((Date.now() - receivedAt.getTime()) / 1000)) : null;
    const live = ageSeconds != null && ageSeconds <= staleAfterSeconds;
    return {
      symbol,
      timeframeMinutes: timeframe,
      provider: latest?.source === "TWELVE_DATA" ? "TWELVE_DATA" : "NONE",
      live,
      stale: !live,
      testMode: false,
      staleAfterSeconds,
      ageSeconds,
      persistRawCandles: settings.feed.rawCandleStorage,
      liveCacheDays: settings.feed.cacheDays,
      cachedCandles: getCachedCandles(symbol, timeframe).length,
      connectedSocketClients: liveClientCount(),
      latestCandle: latest
        ? {
            timestampUtc: latest.timestamp_utc,
            receivedAt: latest.created_at,
            source: latest.source,
            open: Number(latest.open),
            high: Number(latest.high),
            low: Number(latest.low),
            close: Number(latest.close),
            volume: latest.volume == null ? null : Number(latest.volume),
            spread: latest.spread == null ? null : Number(latest.spread)
          }
        : null
    };
  });
}

export function startMarketDataWorker() {
  if (autoRunTimer) return;
  runAutoRunCycle().catch((error) => {
    autoRunState.phase = "ERROR";
    autoRunState.lastError = (error as Error).message;
    autoRunState.reason = "Auto-run failed during startup.";
  });
  autoRunTimer = setInterval(() => {
    runAutoRunCycle().catch((error) => {
      autoRunState.phase = "ERROR";
      autoRunState.lastError = (error as Error).message;
      autoRunState.reason = "Auto-run cycle failed.";
    });
  }, config.autoRunSupervisorSeconds * 1000);
}

function formatNepalTime(value: string | null) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true
  }).format(new Date(value));
}

async function refreshRuntimeSettings() {
  runtimeSettings = await getRuntimeSettings(await defaultTenantId());
  return runtimeSettings;
}

async function runLearningAfterSession(session: any) {
  const sessionId = String(session.id);
  const tenantId = String(session.tenant_id);
  if (autoRunState.lastLearningSessionId === sessionId) return;
  try {
    const result = await runOrbLearningPython(tenantId);
    const coach = await runProductionLearningCoach(tenantId, "orb_max_options", sessionId);
    autoRunState.lastLearningSessionId = sessionId;
    autoRunState.lastLearningRunAt = new Date().toISOString();
    autoRunState.lastLearningResult = { ...result, coach };
    await notifyTenantOnce(
      tenantId,
      `orb-learning-${sessionId}`,
      "ORB_LEARNING_COMPLETED",
      "ORB learning updated",
      `Python learning reviewed ${result.sampleSize ?? 0} results and produced ${result.recommendations ?? 0} recommendations. Coach ${coach.status}.`
    );
  } catch (error) {
    autoRunState.lastLearningRunAt = new Date().toISOString();
    autoRunState.lastLearningResult = { error: (error as Error).message };
  }
}

async function runModule2CloseoutAfterSession(session: any) {
  const moduleCode = "high_probability_strategy_2";
  const existing = await query(
    `SELECT *
     FROM module_session_closeouts
     WHERE tenant_id = $1 AND module_code = $2 AND session_date = $3
     LIMIT 1`,
    [session.tenant_id, moduleCode, session.session_date]
  );
  const current = existing.rows[0] as any;
  if (current?.status === "COMPLETED") return current;
  const closeout = current ?? (await query(
    `INSERT INTO module_session_closeouts (tenant_id, module_code, session_id, session_date, status)
     VALUES ($1,$2,$3,$4,'RUNNING')
     ON CONFLICT (tenant_id, module_code, session_date) DO UPDATE SET status = 'RUNNING', error = NULL, started_at = now()
     RETURNING *`,
    [session.tenant_id, moduleCode, session.id, session.session_date]
  )).rows[0];
  try {
    const report = await generateModule2AutoSessionReport(session);
    const closedTrades = Number(report.summary?.paperTrades ?? 0) - Number(report.summary?.active ?? 0);
    const learning = closedTrades > 0 && session.tenant_id ? await runModule2LearningPython(session.tenant_id) : null;
    const coach = await runProductionLearningCoach(session.tenant_id, moduleCode, session.id);
    const reviewItemsCreated = learning ? await seedModule2LearningReviewItems(session.tenant_id, learning.runId) : 0;
    const updated = await query(
      `UPDATE module_session_closeouts
       SET status = 'COMPLETED',
           report_id = $2,
           learning_run_id = $3,
           review_items_created = $4,
           summary = $5::jsonb,
           completed_at = now(),
           error = NULL
       WHERE id = $1
       RETURNING *`,
      [
        closeout.id,
        report.id,
        learning?.runId ?? null,
        reviewItemsCreated,
        JSON.stringify({ reportStatus: report.final_status, trades: report.summary?.paperTrades ?? 0, totalR: report.summary?.totalR ?? 0, learning: learning?.status ?? "SKIPPED", coach })
      ]
    );
    await notifyTenantOnce(
      session.tenant_id,
      `module2-closeout-${session.id}`,
      "MODULE2_DAILY_REPORT_READY",
      "Module 2 daily report ready",
      `Status ${report.final_status}. Trades ${report.summary?.paperTrades ?? 0}, total R ${Number(report.summary?.totalR ?? 0).toFixed(2)}, blocked setups ${report.summary?.blockedSetups ?? 0}.`,
      report.final_status === "GO" ? "NORMAL" : "HIGH"
    );
    return updated.rows[0];
  } catch (error) {
    const failed = await query(
      `UPDATE module_session_closeouts
       SET status = 'FAILED', error = $2, completed_at = now()
       WHERE id = $1
       RETURNING *`,
      [closeout.id, (error as Error).message]
    );
    await notifyTenantOnce(session.tenant_id, `module2-closeout-failed-${session.id}`, "MODULE2_CLOSEOUT_FAILED", "Module 2 closeout failed", (error as Error).message, "HIGH");
    return failed.rows[0];
  }
}

async function module2CloseoutRows(tenantId: string | null) {
  const rows = await query(
    `SELECT
       c.*,
       r.final_status AS report_status,
       r.summary AS report_summary,
       lr.status AS learning_status,
       lr.sample_size AS learning_sample_size,
       n.id AS notification_id,
       n.created_at AS notification_created_at
     FROM module_session_closeouts c
     LEFT JOIN module_session_reports r ON r.id = c.report_id
     LEFT JOIN module_learning_runs lr ON lr.id = c.learning_run_id
     LEFT JOIN notifications n ON n.tenant_id = c.tenant_id AND n.event_key = 'module2-closeout-' || c.session_id::text
     WHERE c.tenant_id = $1 AND c.module_code = 'high_probability_strategy_2'
     ORDER BY c.session_date DESC
     LIMIT 30`,
    [tenantId]
  );
  return rows.rows;
}

async function runProductionLearningCoach(tenantId: string | null, moduleCode: string, sessionId: string) {
  if (!tenantId) return { status: "SKIPPED", reason: "TENANT_REQUIRED" };
  try {
    const result = await runDeterministicStrategyCoachPython(tenantId, moduleCode);
    return {
      status: result?.status ?? "COMPLETED",
      moduleCode,
      sessionId,
      recommendations: Number(result?.summary?.recommendations ?? result?.modules?.[0]?.recommendations ?? 0),
      readySetupsWithoutPaperTrade: Number(result?.summary?.readySetupsWithoutPaperTrade ?? result?.modules?.[0]?.summary?.automation?.readyWithoutPaperTrade ?? 0),
      closedPaperTrades: Number(result?.summary?.closedPaperTrades ?? result?.modules?.[0]?.summary?.outcomes?.trades ?? 0)
    };
  } catch (error) {
    await query(
      `INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
       VALUES ('ERROR', 'SYSTEM', 'LEARNING_COACH_FAILED', 'market-data-worker', $1, $2, $3::jsonb)`,
      [
        tenantId,
        `Python learning coach failed for ${moduleCode}.`,
        JSON.stringify({
          moduleCode,
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      ]
    );
    return { status: "FAILED", moduleCode, sessionId, error: error instanceof Error ? error.message : String(error) };
  }
}

async function module2SessionForCloseout(tenantId: string | null, sessionDate?: string) {
  const date = sessionDate ?? newYorkDate();
  const result = await query(
    `SELECT *
     FROM trading_sessions
     WHERE tenant_id = $1
       AND module_code = 'high_probability_strategy_2'
       AND session_date = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, date]
  );
  return result.rows[0] as any;
}

async function generateModule2AutoSessionReport(session: any) {
  const moduleCode = "high_probability_strategy_2";
  const [candles, setups, trades, failedRules, latestRehearsal, learning, configSnapshot] = await Promise.all([
    query(
      `SELECT count(*)::int AS count, min(timestamp_utc) AS first, max(timestamp_utc) AS latest
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = 5 AND timestamp_utc >= $2 AND timestamp_utc <= $3`,
      [session.symbol, session.session_start_at, session.signal_window_end_at]
    ),
    query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status IN ('LONG SETUP READY','SHORT SETUP READY','PAPER_TRADE_OPENED','TRADE_PLANNED'))::int AS valid_setups,
         count(*) FILTER (WHERE status IN ('NO TRADE','BLOCKED'))::int AS blocked_setups,
         max(detected_at) AS latest_setup_at
       FROM setup_candidates
       WHERE tenant_id = $1 AND module_code = $2 AND session_id = $3 AND status <> 'TEST_CLEARED'`,
      [session.tenant_id, moduleCode, session.id]
    ),
    query(
      `SELECT
         count(t.id)::int AS total,
         count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
         count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
         count(t.id) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
         count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
         COALESCE(sum(t.result_r), 0)::float AS total_r
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.session_id = $3
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [session.tenant_id, moduleCode, session.id]
    ),
    query(
      `SELECT sre.rule_code, sre.name, sre.status, count(*)::int AS count
       FROM setup_rule_evaluations sre
       JOIN setup_candidates sc ON sc.id = sre.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND sc.session_id = $3 AND sre.status <> 'PASS'
       GROUP BY sre.rule_code, sre.name, sre.status
       ORDER BY count(*) DESC
       LIMIT 12`,
      [session.tenant_id, moduleCode, session.id]
    ),
    query(
      `SELECT final_status, checklist_json, health_json, dry_run_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1 AND module_code = $2
         AND created_at >= $3::timestamptz - interval '12 hours'
         AND created_at <= $4::timestamptz + interval '12 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [session.tenant_id, moduleCode, session.session_start_at, session.signal_window_end_at]
    ),
    latestModule2LearningSnapshot(session.tenant_id),
    module2ConfigSnapshot(session.tenant_id)
  ]);
  const candleRow = candles.rows[0] ?? {};
  const setupRow = setups.rows[0] ?? {};
  const tradeRow = trades.rows[0] ?? {};
  const rehearsal = latestRehearsal.rows[0] ?? null;
  const dominantOutcome = Number(tradeRow.wins ?? 0) > 0 ? "WIN" : Number(tradeRow.losses ?? 0) > 0 ? "LOSS" : Number(tradeRow.active ?? 0) > 0 ? "ACTIVE" : "NONE";
  const blockedReasons = [
    Number(candleRow.count ?? 0) < 10 ? "Too few 5M candles were stored for the session." : null,
    rehearsal?.final_status !== "GO" ? "Latest launch rehearsal did not pass GO." : null,
    Number(setupRow.valid_setups ?? 0) === 0 ? "No valid Module 2 setup reached paper-trade readiness." : null,
    ...failedRules.rows.slice(0, 5).map((row: any) => `${row.rule_code}: ${row.count}`)
  ].filter(Boolean);
  const finalStatus = blockedReasons.length === 0 ? "GO" : Number(setupRow.total ?? 0) > 0 || Number(candleRow.count ?? 0) > 0 ? "REVIEW" : "NO_GO";
  const summary = {
    sessionDate: session.session_date,
    symbol: session.symbol,
    sessionFound: true,
    validSetups: Number(setupRow.valid_setups ?? 0),
    blockedSetups: Number(setupRow.blocked_setups ?? 0),
    paperTrades: Number(tradeRow.total ?? 0),
    wins: Number(tradeRow.wins ?? 0),
    losses: Number(tradeRow.losses ?? 0),
    active: Number(tradeRow.active ?? 0),
    totalR: Number(tradeRow.total_r ?? 0)
  };
  const saved = await query(
    `INSERT INTO module_session_reports (
      tenant_id, module_code, session_id, session_date, final_status,
      summary, feed_snapshot, setup_snapshot, trade_snapshot, blocked_reasons,
      checklist_summary, learning_notes
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)
     ON CONFLICT (tenant_id, module_code, session_date)
     DO UPDATE SET
       session_id = EXCLUDED.session_id,
       final_status = EXCLUDED.final_status,
       summary = EXCLUDED.summary,
       feed_snapshot = EXCLUDED.feed_snapshot,
       setup_snapshot = EXCLUDED.setup_snapshot,
       trade_snapshot = EXCLUDED.trade_snapshot,
       blocked_reasons = EXCLUDED.blocked_reasons,
       checklist_summary = EXCLUDED.checklist_summary,
       learning_notes = EXCLUDED.learning_notes,
       generated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      session.tenant_id,
      moduleCode,
      session.id,
      session.session_date,
      finalStatus,
      JSON.stringify(summary),
      JSON.stringify({ candles5m: Number(candleRow.count ?? 0), firstCandleAt: candleRow.first ?? null, latestCandleAt: candleRow.latest ?? null }),
      JSON.stringify({ total: Number(setupRow.total ?? 0), valid: Number(setupRow.valid_setups ?? 0), blocked: Number(setupRow.blocked_setups ?? 0), latestSetupAt: setupRow.latest_setup_at ?? null }),
      JSON.stringify({ ...tradeRow, dominantOutcome }),
      JSON.stringify(blockedReasons),
      JSON.stringify({ latestRehearsal: rehearsal, failedRules: failedRules.rows, configSnapshot }),
      JSON.stringify({ latestLearningAt: learning?.completed_at ?? null, sampleSize: learning?.sample_size ?? 0, recommendations: learning?.recommendations ?? [] })
    ]
  );
  return saved.rows[0];
}

async function latestModule2LearningSnapshot(tenantId: string | null) {
  const run = await query(
    `SELECT *
     FROM module_learning_runs
     WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId]
  );
  const row = run.rows[0] as any;
  if (!row) return null;
  const recommendations = await query(
    `SELECT *
     FROM module_learning_recommendations
     WHERE learning_run_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [row.id]
  );
  return { ...row, recommendations: recommendations.rows };
}

async function module2ConfigSnapshot(tenantId: string | null) {
  const setting = await query(
    `SELECT updated_at
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2' AND key = 'liquiditySweep.strategy'
     LIMIT 1`,
    [tenantId]
  );
  return {
    moduleCode: "high_probability_strategy_2",
    settingKey: "liquiditySweep.strategy",
    updatedAt: setting.rows[0]?.updated_at ?? null
  };
}

async function seedModule2LearningReviewItems(tenantId: string | null, learningRunId: string) {
  if (!tenantId) return 0;
  const recommendations = await query(
    `SELECT *
     FROM module_learning_recommendations
     WHERE learning_run_id = $1 AND module_code = 'high_probability_strategy_2'
     ORDER BY created_at DESC
     LIMIT 10`,
    [learningRunId]
  );
  let created = 0;
  for (const recommendation of recommendations.rows as any[]) {
    const existing = await query("SELECT id FROM module_learning_reviews WHERE tenant_id = $1 AND recommendation_id = $2 LIMIT 1", [tenantId, recommendation.id]);
    if (existing.rows[0]) continue;
    const proposed = module2LearningProposedChangeForCloseout(recommendation);
    const guardrails = module2LearningGuardrailsForCloseout(recommendation, proposed);
    await query(
      `INSERT INTO module_learning_reviews (
        tenant_id, module_code, recommendation_id, status, title, rationale, proposed_change, guardrails
       ) VALUES ($1,'high_probability_strategy_2',$2,'PENDING',$3,$4,$5::jsonb,$6::jsonb)`,
      [tenantId, recommendation.id, recommendation.title, recommendation.rationale, JSON.stringify(proposed), JSON.stringify(guardrails)]
    );
    created += 1;
  }
  return created;
}

function module2LearningProposedChangeForCloseout(recommendation: any) {
  const action = recommendation.suggested_action ?? {};
  const kind = recommendation.recommendation_type;
  if (kind === "RAISE_QUALITY_THRESHOLD" || action.action === "RESTRICT_GRADE") {
    return {
      mode: "QA_ONLY_TUNING_REVIEW",
      settingKey: "liquiditySweep.strategy",
      changes: { minimumSignalScore: 85, minimumRiskReward: 2 },
      reason: "Auto-closeout created this QA review from weak lower-grade learning."
    };
  }
  if (kind === "RULE_FAILURE_FOCUS" || action.action === "REVIEW_RULE") {
    const ruleCode = action.ruleCode ?? recommendation.metrics?.ruleCode;
    const layer = module2RuleLayerForCloseout(ruleCode);
    return {
      mode: layer === "hard" ? "OBSERVE_ONLY" : "QA_ONLY_TUNING_REVIEW",
      settingKey: "liquiditySweep.strategy",
      changes: layer === "quality" ? { minimumRiskReward: 2 } : layer === "confirmation" ? { minimumSignalScore: 80 } : {},
      focusRule: ruleCode,
      reason: "Auto-closeout review item. Hard rules remain locked."
    };
  }
  if (kind === "PRODUCTION_READY" || action.action === "ALLOW_PROMOTION_REVIEW") {
    return { mode: "PROMOTION_REVIEW", settingKey: "liquiditySweep.strategy", changes: {}, reason: "Eligible for tuning-lab promotion review." };
  }
  return { mode: "OBSERVE_ONLY", settingKey: "liquiditySweep.strategy", changes: {}, reason: "Informational learning item." };
}

function module2LearningGuardrailsForCloseout(recommendation: any, proposed: any) {
  const action = recommendation.suggested_action ?? {};
  const sampleSize = Number(recommendation.sample_size ?? 0);
  const changes = proposed.changes ?? {};
  const focusRule = proposed.focusRule ?? action.ruleCode;
  const layer = module2RuleLayerForCloseout(focusRule);
  return [
    { code: "MINIMUM_SAMPLE_SIZE", status: sampleSize >= 20 || proposed.mode === "OBSERVE_ONLY" ? "PASS" : "WARN", detail: { sampleSize, minimum: 20 } },
    { code: "NO_QA_REPLAY_DATA", status: "PASS", detail: "Module 2 learning excludes QA_TEST_SIGNAL and replay=true setup rows." },
    { code: "MINIMUM_RR_PROTECTED", status: changes.minimumRiskReward == null || Number(changes.minimumRiskReward) >= 2 ? "PASS" : "FAIL", detail: { proposedMinimumRiskReward: changes.minimumRiskReward ?? null, floor: 2 } },
    { code: "HARD_RULES_LOCKED", status: layer === "hard" && Object.keys(changes).length > 0 ? "FAIL" : "PASS", detail: { focusRule: focusRule ?? null, layer } },
    { code: "ONLY_CONFIRMATION_OR_QUALITY_TUNING", status: ["OBSERVE_ONLY", "PROMOTION_REVIEW"].includes(proposed.mode) || Object.keys(changes).every((key) => ["minimumSignalScore", "minimumRiskReward"].includes(key)) ? "PASS" : "FAIL", detail: { changes } }
  ];
}

function module2RuleLayerForCloseout(code?: string) {
  if (!code) return "none";
  if (code.startsWith("CONFIRM_") || code === "CONFIRMATION_COUNT") return "confirmation";
  if (code.startsWith("QUALITY_") || code === "QUALITY_FILTER_COUNT") return "quality";
  if (["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED"].includes(code)) return "hard";
  if (code === "VARIANT_SELECTED") return "final";
  return "other";
}

async function runAutoRunCycle() {
  const tenants = await activeAutomationModules();
  const defaultTenant = tenants.find((tenant) => tenant.slug === DEFAULT_TENANT_SLUG) ?? tenants[0];
  const settings = await getRuntimeSettings(defaultTenant?.id ?? (await defaultTenantId()));
  autoRunState.lastCheckedAt = new Date().toISOString();
  autoRunState.lastError = null;
  autoRunState.running = twelveDataState.running;
  autoRunState.provider = "TWELVE_DATA";
  autoRunState.symbol = settings.symbol;
  autoRunState.timeframeMinutes = settings.timeframeMinutes;
  autoRunState.startLeadMinutes = settings.orb.apiStartLeadMinutes;

  if (!config.twelveDataApiKey) {
    autoRunState.phase = "API_KEY_MISSING";
    autoRunState.reason = "Twelve Data API key is missing. Auto-run cannot fetch live candles.";
    for (const tenant of tenants) {
      const tenantState = tenantStateFor(tenant, settings);
      tenantState.phase = "API_KEY_MISSING";
      tenantState.running = false;
      tenantState.lastCheckedAt = autoRunState.lastCheckedAt;
      tenantState.reason = autoRunState.reason;
      await persistTenantAutomationState(tenantState);
    }
    await stopTwelveDataLive({ notify: false });
    return autoRunState;
  }

  const tenantCycles = [];
  for (const tenant of tenants) {
    const tenantSettings = await getRuntimeSettings(tenant.id);
    const state = await evaluateTenantSchedule(tenant, tenantSettings);
    await persistTenantAutomationState(state);
    tenantCycles.push({ tenant, settings: tenantSettings, state });
  }

  const monitoring = tenantCycles.filter((item) => item.state.phase === "MONITORING");
  const primary = tenantCycles.find((item) => item.tenant.id === defaultTenant?.id) ?? tenantCycles[0];
  if (primary) {
    autoRunState.phase = primary.state.phase;
    autoRunState.running = monitoring.length > 0 && twelveDataState.running;
    autoRunState.symbol = primary.settings.symbol;
    autoRunState.timeframeMinutes = primary.settings.timeframeMinutes;
    autoRunState.startLeadMinutes = primary.settings.orb.apiStartLeadMinutes;
    autoRunState.sessionId = primary.state.sessionId;
    autoRunState.sessionState = primary.state.sessionState;
    autoRunState.sessionStartAt = primary.state.sessionStartAt;
    autoRunState.openingRangeEndAt = primary.state.openingRangeEndAt;
    autoRunState.signalWindowEndAt = primary.state.signalWindowEndAt;
    autoRunState.apiStartAt = primary.state.apiStartAt;
    autoRunState.apiStopAt = primary.state.apiStopAt;
    autoRunState.nextActionAt = primary.state.nextActionAt;
    autoRunState.reason = primary.state.reason;
  }

  if (monitoring.length === 0) {
    await stopTwelveDataLive({ notify: false });
    autoRunState.running = false;
    const catchup = await runOffSessionCatchup(tenantCycles);
    if (catchup.eligible) {
      autoRunState.phase = "CATCH_UP";
      autoRunState.lastActionAt = catchup.syncedAt ?? autoRunState.lastActionAt;
      autoRunState.nextActionAt = catchup.nextSyncAt ?? autoRunState.nextActionAt;
      autoRunState.reason = catchup.performed
        ? `Off-session XAUUSD catch-up imported ${catchup.imported ?? 0} candle(s). Module 1 remains paused until New York.`
        : `Off-session XAUUSD catch-up is current. Next shared sync is scheduled for ${catchup.nextSyncAt}.`;
    }
    return autoRunState;
  }

  const first = monitoring[0];
  autoRunState.phase = "MONITORING";
  autoRunState.running = true;
  autoRunState.reason = `Monitoring ${monitoring.length} active tenant(s). Twelve Data calls are grouped by symbol/timeframe.`;
  if (!twelveDataState.running) {
    await startTwelveDataLive({
      symbol: first.settings.symbol,
      providerSymbol: first.settings.feed.providerSymbol,
      timeframeMinutes: SHARED_TWELVE_DATA_SOURCE_TIMEFRAME,
      interval: timeframeToTwelveInterval(SHARED_TWELVE_DATA_SOURCE_TIMEFRAME),
      pollSeconds: first.settings.feed.pollSeconds,
      count: first.settings.feed.startupBackfillCount,
      notify: true
    });
    autoRunState.lastActionAt = new Date().toISOString();
  }
  return autoRunState;
}

async function runOffSessionCatchup(tenantCycles: Array<{ tenant: any; settings: RuntimeSettings; state: TenantAutoRunState }>) {
  const first = tenantCycles[0];
  const market = marketClosedReason();
  if (!first || market.closed) return { eligible: false, performed: false, reason: market.reason };

  const last = await query(
    `SELECT created_at
     FROM api_usage_events
     WHERE provider = 'TWELVE_DATA'
       AND trigger_source = 'MARKET_DATA_CATCH_UP'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  const lastSyncAt = last.rows[0]?.created_at ? new Date(last.rows[0].created_at) : null;
  const latestAttemptAt = Math.max(lastSyncAt?.getTime() ?? 0, offSessionCatchupAttemptAt ?? 0);
  const dueAt = latestAttemptAt > 0 ? latestAttemptAt + config.twelveDataCatchupSeconds * 1000 : 0;
  if (Date.now() < dueAt) {
    return { eligible: true, performed: false, nextSyncAt: new Date(dueAt).toISOString() };
  }

  const settings = first.settings;
  const sourceTimeframe = SHARED_TWELVE_DATA_SOURCE_TIMEFRAME;
  const latest = await query(
    `SELECT max(timestamp_utc) AS latest
     FROM candles
     WHERE symbol = $1 AND timeframe_minutes = $2`,
    [settings.symbol, sourceTimeframe]
  );
  const latestAt = latest.rows[0]?.latest ? new Date(latest.rows[0].latest).getTime() : null;
  const firstWorkerSync = twelveDataState.lastSyncAt == null && getCachedCandles(settings.symbol, sourceTimeframe).length === 0;
  const requestedCount = calculateCatchupRequestCount({
    latestAt,
    now: Date.now(),
    timeframeMinutes: sourceTimeframe,
    startupBackfillCount: settings.feed.startupBackfillCount,
    firstWorkerSync
  });
  const tenantIds = [...new Set(tenantCycles.map((item) => item.tenant.id))];
  offSessionCatchupAttemptAt = Date.now();
  const result = await syncTwelveDataCandles({
    symbol: settings.symbol,
    providerSymbol: settings.feed.providerSymbol,
    timeframeMinutes: sourceTimeframe,
    interval: timeframeToTwelveInterval(sourceTimeframe),
    count: requestedCount,
    autoEvaluate: false,
    usageTenantIds: tenantIds,
    triggerSource: "MARKET_DATA_CATCH_UP",
    usageReason: `Shared 5-minute off-session catch-up for ${tenantIds.length} subscriber(s)`
  });
  const moduleTimeframes = tenantCycles.map((item) => moduleTimeframeMinutes(item.tenant.module_code, item.settings));
  await refreshDerivedCandles(settings.symbol, sourceTimeframe, [...moduleTimeframes, 15]);
  const syncedAt = new Date().toISOString();
  for (const item of tenantCycles) {
    const timeframe = moduleTimeframeMinutes(item.tenant.module_code, item.settings);
    const state = item.state;
    try {
      const evaluation = await processModuleLiveSession(item.tenant.module_code, item.settings.symbol, timeframe, [], item.tenant.id);
      state.latestSetupId = evaluation.setupId ?? state.latestSetupId ?? null;
      state.latestCandleAt = getCachedCandles(item.settings.symbol, timeframe).at(-1)?.timestampUtc ?? state.latestCandleAt;
      state.lastError = result.connected ? null : result.error ?? null;
      state.lastActionAt = syncedAt;
      state.reason = evaluation.evaluation ?? evaluation.setupStatus ?? state.reason;
      await persistTenantAutomationState(state);
    } catch (error) {
      state.lastError = (error as Error).message;
      state.reason = `${moduleDisplayName(item.tenant.module_code)} catch-up evaluation failed.`;
      await persistTenantAutomationState(state);
    }
  }
  twelveDataState.lastSyncAt = syncedAt;
  twelveDataState.lastImported = result.imported ?? 0;
  twelveDataState.lastRequestedCount = requestedCount;
  twelveDataState.lastError = result.connected ? null : result.error ?? "Off-session catch-up failed.";
  twelveDataState.cycles += 1;
  return {
    eligible: true,
    performed: Boolean(result.connected),
    imported: result.imported ?? 0,
    requestedCount,
    evaluations: [],
    syncedAt,
    nextSyncAt: new Date(Date.now() + config.twelveDataCatchupSeconds * 1000).toISOString(),
    error: result.error ?? null
  };
}

export function calculateCatchupRequestCount(input: {
  latestAt: number | null;
  now: number;
  timeframeMinutes: number;
  startupBackfillCount: number;
  firstWorkerSync: boolean;
}) {
  if (input.firstWorkerSync || input.latestAt == null) return input.startupBackfillCount;
  const missingBars = Math.ceil(Math.max(0, input.now - input.latestAt) / (input.timeframeMinutes * 60_000)) + 2;
  return Math.min(input.startupBackfillCount, Math.max(TWELVE_DATA_CATCHUP_MINIMUM_COUNT, missingBars));
}

async function evaluateTenantSchedule(tenant: any, settings: RuntimeSettings) {
  const state = tenantStateFor(tenant, settings);
  state.lastCheckedAt = new Date().toISOString();
  state.lastError = null;
  state.symbol = settings.symbol;
  state.timeframeMinutes = moduleTimeframeMinutes(tenant.module_code, settings);
  state.startLeadMinutes = settings.orb.apiStartLeadMinutes;

  const sessionDate = newYorkDate();
  const closed = marketClosedReason(sessionDate);
  if (closed.closed) {
    state.phase = "AFTER_WINDOW";
    state.running = false;
    state.sessionId = null;
    state.sessionState = "MARKET_CLOSED";
    state.sessionStartAt = null;
    state.openingRangeEndAt = null;
    state.signalWindowEndAt = null;
    state.apiStartAt = null;
    state.apiStopAt = null;
    state.nextActionAt = nextNewYorkTradingApiStart(settings);
    state.reason = `${state.moduleName} is closed. ${closed.message}`;
    return state;
  }

  const session = await ensureTodayAutoSession(settings.symbol, settings, tenant.id, tenant.module_code);
  state.sessionId = session.id;
  state.sessionState = session.state;
  state.sessionStartAt = session.session_start_at;
  state.openingRangeEndAt = session.opening_range_end_at;
  state.signalWindowEndAt = session.signal_window_end_at;

  const now = Date.now();
  const sessionStart = new Date(session.session_start_at).getTime();
  const sessionEnd = new Date(session.signal_window_end_at).getTime();
  const sharedFeedWindow = sharedNewYorkFeedWindow(newYorkDate());
  const sharedNyStart = new Date(sharedFeedWindow.startAt).getTime();
  const sharedNyEnd = new Date(sharedFeedWindow.endAt).getTime();
  const insideSharedNyFeed = now >= sharedNyStart && now <= sharedNyEnd;
  const apiStart = tenant.module_code === "orb_max_options"
    ? Math.max(sessionStart - settings.orb.apiStartLeadMinutes * 60_000, sharedNyStart)
    : Math.max(sessionStart - settings.orb.apiStartLeadMinutes * 60_000, sharedNyStart);
  const apiStop = Math.min(sessionEnd, sharedNyEnd);
  state.apiStartAt = new Date(apiStart).toISOString();
  state.apiStopAt = new Date(apiStop).toISOString();

  if (tenant.module_code === "orb_max_options" && now >= sessionStart && now <= sessionEnd && !insideSharedNyFeed) {
    state.phase = "CATCH_UP";
    state.nextActionAt = new Date(Date.now() + config.twelveDataCatchupSeconds * 1000).toISOString();
    state.reason = `${state.moduleName} is tracking ${orbSessionLabel(session.session_preset)} with the shared 5-minute XAUUSD candle feed.`;
    state.running = false;
    return state;
  }

  if (now < apiStart) {
    state.phase = "PRE_SESSION";
    state.nextActionAt = new Date(apiStart).toISOString();
    state.reason = "Scheduled. The shared Twelve Data 5-minute feed keeps ORB sessions current on market weekdays.";
    state.running = false;
    const minutesUntilApiStart = Math.round((apiStart - now) / 60_000);
    if (minutesUntilApiStart <= settings.orb.apiStartLeadMinutes && minutesUntilApiStart >= 0) {
      const modulePrefix = tenant.module_code === "orb_max_options"
        ? "MODULE1"
        : "MODULE2";
      await notifyTenantOnce(
        tenant.id,
        `mobile-ny-pre-session-${tenant.module_code}-${session.id}`,
        `${modulePrefix}_NY_PRE_SESSION`,
        `${state.moduleName} starts soon`,
        `XAUUSD live monitoring starts at ${new Date(apiStart).toISOString()}. Get ready for paper-trade alerts.`
      );
    }
    return state;
  }

  if (now >= apiStop) {
    state.phase = "AFTER_WINDOW";
    state.nextActionAt = null;
    state.reason = `${state.moduleName} monitoring window is complete. The shared feed continues on the 5-minute weekday cadence.`;
    state.running = false;
    if (tenant.module_code === "high_probability_strategy_2") {
      const closeout = await runModule2CloseoutAfterSession(session);
      state.lastActionAt = closeout?.completed_at ?? state.lastActionAt;
      state.reason = closeout?.status === "COMPLETED"
        ? `${state.moduleName} New York window is complete. Daily report, learning, and review queue closeout are done.`
        : state.reason;
    } else {
      await runLearningAfterSession(session);
    }
    return state;
  }

  state.phase = "MONITORING";
  state.nextActionAt = new Date(sessionEnd).toISOString();
  state.reason = settings.feed.rawCandleStorage
    ? `Auto-run is monitoring ${settings.symbol}, syncing ${state.timeframeMinutes}-minute candles, and evaluating ${state.moduleName} paper trades.`
    : `Auto-run is monitoring ${settings.symbol} in memory and will persist only valid ${state.moduleName} records.`;
  state.running = true;
  return state;
}

export function isNewYorkWeekend(sessionDate: string) {
  const day = new Date(`${sessionDate}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function sharedNewYorkFeedWindow(sessionDate: string) {
  const times = sessionTimesForDate(sessionDate, "09:30", 0, "16:00");
  return { startAt: times.sessionStartAt, endAt: times.signalWindowEndAt };
}

function currentOrNextOrbSessionWindow(settings: RuntimeSettings, now = new Date()) {
  const dates = [shiftIsoDate(newYorkDate(now), -1), newYorkDate(now), shiftIsoDate(newYorkDate(now), 1)];
  const candidates = dates.flatMap((sessionDate) =>
    ORB_SESSION_PRESETS.map((preset) => {
      const sessionStart = preset.preset === "NEW_YORK_ORB" ? settings.orb.sessionStart : preset.sessionStart;
      const tradeWindowEnd = preset.preset === "NEW_YORK_ORB" ? settings.orb.tradeWindowEnd : preset.tradeWindowEnd;
      const times = sessionTimesForDate(sessionDate, sessionStart, settings.orb.openingRangeMinutes, tradeWindowEnd);
      return {
        ...preset,
        sessionDate,
        sessionStart,
        tradeWindowEnd,
        sessionStartAt: times.sessionStartAt,
        openingRangeEndAt: times.openingRangeEndAt,
        signalWindowEndAt: times.signalWindowEndAt
      };
    })
  );
  const nowMs = now.getTime();
  const active = candidates
    .filter((candidate) => nowMs >= new Date(candidate.sessionStartAt).getTime() && nowMs <= new Date(candidate.signalWindowEndAt).getTime())
    .sort((left, right) => new Date(right.sessionStartAt).getTime() - new Date(left.sessionStartAt).getTime())[0];
  if (active) return active;
  return candidates
    .filter((candidate) => nowMs < new Date(candidate.sessionStartAt).getTime())
    .sort((left, right) => new Date(left.sessionStartAt).getTime() - new Date(right.sessionStartAt).getTime())[0] ?? candidates.at(-1);
}

function orbSessionLabel(sessionPreset?: string | null) {
  return ORB_SESSION_PRESETS.find((preset) => preset.preset === sessionPreset)?.label ?? "ORB";
}

function nextNewYorkTradingApiStart(settings: RuntimeSettings) {
  const next = new Date(`${newYorkDate()}T12:00:00.000Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6 || isConfiguredMarketClosedDate(next.toISOString().slice(0, 10)));
  const sessionDate = next.toISOString().slice(0, 10);
  return sharedNewYorkFeedWindow(sessionDate).startAt;
}

function isConfiguredMarketClosedDate(sessionDate: string) {
  return config.marketClosedDates.includes(sessionDate);
}

function marketClosedReason(sessionDate = newYorkDate()) {
  if (isNewYorkWeekend(sessionDate)) {
    return {
      closed: true,
      reason: "MARKET_CLOSED_WEEKEND",
      message: "New York market date is Saturday/Sunday. Twelve Data calls are paused."
    };
  }
  if (isConfiguredMarketClosedDate(sessionDate)) {
    return {
      closed: true,
      reason: "MARKET_CLOSED_CONFIGURED_DATE",
      message: `${sessionDate} is configured as a market-closed date. Twelve Data calls are paused.`
    };
  }
  return { closed: false, reason: "MARKET_OPEN_DAY", message: "Market date is eligible for shared XAUUSD session monitoring." };
}

export function isScheduledTwelveDataTrigger(triggerSource?: string) {
  return triggerSource === "MARKET_DATA_WORKER" || triggerSource === "MARKET_DATA_CATCH_UP";
}

async function twelveDataCallPolicy(options: {
  symbol: string;
  timeframeMinutes: number;
  triggerSource?: string;
  force?: boolean;
}) {
  const sessionDate = newYorkDate();
  const closed = marketClosedReason(sessionDate);
  if (closed.closed && options.force !== true) {
    return { allowed: false, ...closed, sessionDate, forced: false };
  }

  if (options.force === true) {
    return {
      allowed: true,
      reason: closed.closed ? `FORCED_${closed.reason}` : "FORCED_ADMIN_SYNC",
      message: closed.closed
        ? `Platform admin forced sync while ${closed.reason.toLowerCase()}. Guardrails still apply.`
        : "Platform admin forced sync. Guardrails still apply.",
      sessionDate,
      forced: true
    };
  }

  if (isScheduledTwelveDataTrigger(options.triggerSource)) {
    return {
      allowed: true,
      reason: options.triggerSource === "MARKET_DATA_CATCH_UP" ? "OFF_SESSION_CATCH_UP" : "NY_API_WINDOW_ACTIVE",
      message: options.triggerSource === "MARKET_DATA_CATCH_UP"
        ? "Shared Twelve Data call is the scheduled 5-minute off-session catch-up."
        : "Shared Twelve Data call is inside the active New York API window.",
      sessionDate,
      forced: false
    };
  }

  return {
    allowed: false,
    reason: "MANUAL_SYNC_REQUIRES_FORCE",
    message: "Manual Twelve Data calls are blocked unless platform admin force mode is used.",
    sessionDate,
    forced: false
  };
}

async function ensureTodayAutoSession(symbol: string, settings: RuntimeSettings, tenantId?: string | null, moduleCode = "orb_max_options") {
  const activeTenantId = tenantId ?? (await defaultTenantId());
  const strategyVersion = await activeStrategyVersionForModule(moduleCode);
  const moduleConfig = strategyVersion?.configuration_json ?? {};
  const moduleUsesStrategyWindow = moduleCode === "high_probability_strategy_2";
  const orbWindow = moduleCode === "orb_max_options" ? currentOrNextOrbSessionWindow(settings) : null;
  const sessionStart = moduleUsesStrategyWindow
    ? String(moduleConfig.newYorkStartTime ?? "09:30")
    : orbWindow?.sessionStart ?? settings.orb.sessionStart;
  const tradeWindowEnd = moduleUsesStrategyWindow
    ? String(moduleConfig.newYorkEndTime ?? "16:00")
    : orbWindow?.tradeWindowEnd ?? settings.orb.tradeWindowEnd;
  const openingRangeMinutes = moduleUsesStrategyWindow ? 0 : settings.orb.openingRangeMinutes;
  const sessionPreset = moduleCode === "high_probability_strategy_2" ? "NY_SWEEP_BOS" : orbWindow?.preset ?? "NEW_YORK_ORB";
  const versionResult = await query(
    `SELECT *
     FROM strategy_versions
     WHERE id = COALESCE($1::uuid, (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1))`,
    [strategyVersion?.id ?? null]
  );
  const version = versionResult.rows[0] as any;
  if (!version?.id) {
    const error = new Error(`No active strategy version is available for ${moduleCode}. Run database migrations/seed before live NY monitoring.`) as Error & { statusCode?: number };
    error.statusCode = 500;
    throw error;
  }
  const sessionDate = orbWindow?.sessionDate ?? newYorkDate();
  const times = sessionTimesForDate(sessionDate, sessionStart, openingRangeMinutes, tradeWindowEnd);
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = $1 AND ts.strategy_version_id = $2 AND ts.session_date = $3 AND ts.session_preset = $4 AND ts.tenant_id = $5 AND ts.module_code = $6
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [symbol, version.id, sessionDate, sessionPreset, activeTenantId, moduleCode]
  );
  if (existing.rows[0]) {
    const current = existing.rows[0] as any;
    if (!["TRADE_PLANNED", "TRADE_ACTIVE", "TRADE_CLOSED", "SESSION_COMPLETED", "NO_TRADE"].includes(current.state)) {
      const updated = await query(
        `UPDATE trading_sessions
         SET session_start_at = $2, opening_range_end_at = $3, signal_window_end_at = $4
         WHERE id = $1
         RETURNING *`,
        [current.id, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt]
      );
      return refreshAutoSessionState({ ...updated.rows[0], signal_timeframe_minutes: moduleTimeframeMinutes(moduleCode, settings) });
    }
    return refreshAutoSessionState({ ...current, signal_timeframe_minutes: moduleTimeframeMinutes(moduleCode, settings) });
  }
  const created = await query(
    `INSERT INTO trading_sessions (
      tenant_id, module_code, user_id, symbol, strategy_version_id, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $8, $7, (SELECT id FROM users WHERE tenant_id = $8 LIMIT 1), $1, $2, $3, $9, 'PRE_SESSION', $4, $5, $6
    ) RETURNING *`,
    [symbol, version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, moduleCode, activeTenantId, sessionPreset]
  );
  return refreshAutoSessionState({ ...created.rows[0], signal_timeframe_minutes: moduleTimeframeMinutes(moduleCode, settings) });
}

function isEligibleStrategyDate(sessionDate: string) {
  return !isNewYorkWeekend(sessionDate) && !isConfiguredMarketClosedDate(sessionDate);
}

function shiftIsoDate(sessionDate: string, days: number) {
  const date = new Date(`${sessionDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function refreshAutoSessionState(session: any) {
  if (["TRADE_PLANNED", "TRADE_ACTIVE", "TRADE_CLOSED", "SESSION_COMPLETED", "NO_TRADE"].includes(session.state)) return session;
  const now = new Date();
  let state = session.state;
  if (now < new Date(session.session_start_at)) state = "PRE_SESSION";
  else if (now >= new Date(session.session_start_at) && now < new Date(session.opening_range_end_at)) state = "OPENING_RANGE_FORMING";
  else if (now >= new Date(session.opening_range_end_at) && now <= new Date(session.signal_window_end_at)) state = "OPENING_RANGE_LOCKED";
  else if (now > new Date(session.signal_window_end_at)) state = "SESSION_EXPIRED";
  const updated = await query("UPDATE trading_sessions SET state = $2 WHERE id = $1 RETURNING *", [session.id, state]);
  return { ...updated.rows[0], signal_timeframe_minutes: session.signal_timeframe_minutes };
}

async function startTwelveDataLive(options: {
  symbol?: string;
  providerSymbol?: string;
  timeframeMinutes?: number;
  interval?: string;
  pollSeconds?: number;
  count?: number;
  notify?: boolean;
}) {
  const settings = await refreshRuntimeSettings();
  twelveDataState.configured = Boolean(config.twelveDataApiKey);
  if (!twelveDataState.configured) {
    twelveDataState.running = false;
    twelveDataState.lastError = "TWELVE_DATA_API_KEY is not configured.";
    return twelveDataState;
  }
  twelveDataState.running = true;
  twelveDataState.symbol = options.symbol ?? settings.symbol;
  twelveDataState.providerSymbol = options.providerSymbol ?? settings.feed.providerSymbol;
  twelveDataState.timeframeMinutes = options.timeframeMinutes ?? settings.timeframeMinutes;
  twelveDataState.interval = options.interval ?? timeframeToTwelveInterval(twelveDataState.timeframeMinutes);
  twelveDataState.pollSeconds = Math.max(options.pollSeconds ?? settings.feed.pollSeconds, 300);
  twelveDataState.count = Math.min(Math.max(options.count ?? settings.feed.startupBackfillCount, 1), 5000);
  twelveDataState.startedAt = new Date().toISOString();
  twelveDataState.stoppedAt = null;
  twelveDataState.lastError = null;
  twelveDataState.lastRequestedCount = 0;
  twelveDataState.cycles = 0;
  if (twelveDataTimer) clearInterval(twelveDataTimer);

  await runTwelveDataCycle();
  twelveDataTimer = setInterval(() => {
    runTwelveDataCycle().catch((error) => {
      twelveDataState.lastError = (error as Error).message;
    });
  }, twelveDataState.pollSeconds * 1000);

  if (options.notify) {
    await notifyOnce(
      `twelve-data-live-started-${twelveDataState.symbol}`,
      "TWELVE_DATA_LIVE_STARTED",
      "Twelve Data live ingestion started",
      settings.feed.rawCandleStorage
        ? `${twelveDataState.symbol} ${twelveDataState.timeframeMinutes}-minute candles will sync into PostgreSQL every ${twelveDataState.pollSeconds} seconds.`
        : `${twelveDataState.symbol} ${twelveDataState.timeframeMinutes}-minute candles will stay in memory every ${twelveDataState.pollSeconds} seconds. Only valid ORB records are saved.`
    );
  }

  return twelveDataState;
}

async function stopTwelveDataLive(options: { notify?: boolean }) {
  if (twelveDataTimer) clearInterval(twelveDataTimer);
  twelveDataTimer = null;
  const wasRunning = twelveDataState.running;
  twelveDataState.running = false;
  twelveDataState.stoppedAt = new Date().toISOString();
  if (options.notify && wasRunning) {
    await notifyOnce(
      `twelve-data-live-stopped-${twelveDataState.symbol}-${twelveDataState.stoppedAt}`,
      "TWELVE_DATA_LIVE_STOPPED",
      "Twelve Data live ingestion stopped",
      `${twelveDataState.symbol} ingestion is no longer running.`
    );
  }
  return twelveDataState;
}

async function runTwelveDataCycle() {
  if (!twelveDataState.running) return;
  const cycleStartedAt = Date.now();
  console.log(JSON.stringify({
    level: "info",
    service: "market-data-worker",
    event: "twelve_data_cycle_start",
    symbol: twelveDataState.symbol,
    interval: twelveDataState.interval,
    cycle: twelveDataState.cycles + 1
  }));
  await recordOperationalEvent({
    severity: "INFO",
    category: "WORKER",
    eventType: "TWELVE_DATA_CYCLE_START",
    source: "market-data-worker",
    message: `Twelve Data worker cycle ${twelveDataState.cycles + 1} started.`,
    metadata: { symbol: twelveDataState.symbol, interval: twelveDataState.interval, cycle: twelveDataState.cycles + 1 }
  });
  try {
    const tenants = await activeAutomationModules();
    const grouped = new Map<string, { settings: RuntimeSettings; tenants: any[]; timeframes: Set<number> }>();
    for (const tenant of tenants) {
      const settings = await getRuntimeSettings(tenant.id);
      const state = await evaluateTenantSchedule(tenant, settings);
      await persistTenantAutomationState(state);
      if (state.phase !== "MONITORING") continue;
      const moduleTimeframe = moduleTimeframeMinutes(tenant.module_code, settings);
      const key = `${settings.symbol}:${settings.feed.providerSymbol}`;
      const group = grouped.get(key) ?? { settings, tenants: [], timeframes: new Set<number>() };
      group.tenants.push(tenant);
      group.timeframes.add(moduleTimeframe);
      grouped.set(key, group);
    }
    if (grouped.size === 0) {
      console.log(JSON.stringify({
        level: "info",
        service: "market-data-worker",
        event: "twelve_data_cycle_pause",
        reason: "NO_MONITORING_TENANTS",
        durationMs: Date.now() - cycleStartedAt
      }));
      await recordOperationalEvent({
        severity: "INFO",
        category: "WORKER",
        eventType: "TWELVE_DATA_CYCLE_PAUSE",
        source: "market-data-worker",
        durationMs: Date.now() - cycleStartedAt,
        message: "Twelve Data worker paused because no subscribers are inside the monitoring window.",
        metadata: { reason: "NO_MONITORING_TENANTS" }
      });
      await stopTwelveDataLive({ notify: false });
      return;
    }

    let totalImported = 0;
    let lastResult: any = null;
    for (const group of grouped.values()) {
      const settings = group.settings;
      const sourceTimeframe = preferredTwelveDataSourceTimeframe(Math.min(...group.timeframes));
      twelveDataState.symbol = settings.symbol;
      twelveDataState.providerSymbol = settings.feed.providerSymbol;
      twelveDataState.timeframeMinutes = sourceTimeframe;
      twelveDataState.interval = timeframeToTwelveInterval(sourceTimeframe);
      twelveDataState.pollSeconds = settings.feed.pollSeconds;
      const latestPersisted = await query(
        `SELECT max(timestamp_utc) AS latest
         FROM candles
         WHERE symbol = $1 AND timeframe_minutes = $2 AND source LIKE 'TWELVE_DATA%'`,
        [settings.symbol, sourceTimeframe]
      );
      const latestPersistedAt = latestPersisted.rows[0]?.latest
        ? new Date(latestPersisted.rows[0].latest).getTime()
        : null;
      const requestedCount = calculateCatchupRequestCount({
        latestAt: latestPersistedAt,
        now: Date.now(),
        timeframeMinutes: sourceTimeframe,
        startupBackfillCount: Math.min(twelveDataState.count, settings.feed.startupBackfillCount),
        firstWorkerSync: latestPersistedAt == null
      });
      const result = await syncTwelveDataCandles({
        symbol: settings.symbol,
        providerSymbol: settings.feed.providerSymbol,
        timeframeMinutes: sourceTimeframe,
        interval: timeframeToTwelveInterval(sourceTimeframe),
        count: requestedCount,
        autoEvaluate: false,
        usageTenantIds: [...new Set(group.tenants.map((tenant) => tenant.id))],
        triggerSource: "MARKET_DATA_WORKER",
        usageReason: `Shared live XAUUSD feed for ${group.tenants.length} subscriber module(s)`
      });
      lastResult = result;
      totalImported += result.imported ?? 0;
      await refreshDerivedCandles(settings.symbol, sourceTimeframe, [...group.timeframes, 15]);
      for (const tenant of group.tenants) {
        const timeframe = moduleTimeframeMinutes(tenant.module_code, settings);
        const candles = getCachedCandles(settings.symbol, timeframe);
        const state = tenantAutomationStates.get(tenantStateKey(tenant.id, tenant.module_code)) ?? tenantStateFor(tenant, settings);
        state.latestCandleAt = candles.at(-1)?.timestampUtc ?? null;
        state.lastActionAt = new Date().toISOString();
        try {
          const evaluation = await processModuleLiveSession(tenant.module_code, settings.symbol, timeframe, [], tenant.id);
          state.latestSetupId = evaluation.setupId ?? state.latestSetupId ?? null;
          state.lastError = result.connected ? null : result.error ?? null;
          state.reason = evaluation.evaluation ?? evaluation.setupStatus ?? state.reason;
        } catch (error) {
          state.lastError = (error as Error).message;
          state.reason = `${moduleDisplayName(tenant.module_code)} evaluation failed after candle import.`;
        }
        await persistTenantAutomationState(state);
      }
    }
    twelveDataState.lastSyncAt = new Date().toISOString();
    twelveDataState.lastImported = totalImported;
    twelveDataState.lastRequestedCount = twelveDataState.cycles === 0 ? twelveDataState.count : twelveDataState.lastRequestedCount;
    twelveDataState.lastError = lastResult?.connected ? null : lastResult?.error ?? "Twelve Data did not return candles.";
    twelveDataState.lastEvaluationAt = new Date().toISOString();
    twelveDataState.cycles += 1;
    console.log(JSON.stringify({
      level: "info",
      service: "market-data-worker",
      event: "twelve_data_cycle_complete",
      imported: totalImported,
      groups: grouped.size,
      durationMs: Date.now() - cycleStartedAt,
      cycle: twelveDataState.cycles
    }));
    await recordOperationalEvent({
      severity: "INFO",
      category: "WORKER",
      eventType: "TWELVE_DATA_CYCLE_COMPLETE",
      source: "market-data-worker",
      durationMs: Date.now() - cycleStartedAt,
      message: `Twelve Data worker cycle imported ${totalImported} candle(s).`,
      metadata: { imported: totalImported, groups: grouped.size, cycle: twelveDataState.cycles }
    });
  } catch (error) {
    twelveDataState.lastError = (error as Error).message;
    twelveDataState.cycles += 1;
    console.error(JSON.stringify({
      level: "error",
      service: "market-data-worker",
      event: "twelve_data_cycle_error",
      error: (error as Error).message,
      durationMs: Date.now() - cycleStartedAt,
      cycle: twelveDataState.cycles
    }));
    await recordOperationalEvent({
      severity: "ERROR",
      category: "WORKER",
      eventType: "TWELVE_DATA_CYCLE_ERROR",
      source: "market-data-worker",
      durationMs: Date.now() - cycleStartedAt,
      message: `Twelve Data worker cycle failed: ${(error as Error).message}`,
      metadata: { error: (error as Error).message, cycle: twelveDataState.cycles }
    });
  }
}

async function syncTwelveDataChartCandles(options: {
  symbol: string;
  providerSymbol: string;
  timeframeMinutes: number;
  moduleCode: string;
  tenantId: string | null;
  startupBackfillCount: number;
  livePollCount: number;
}) {
  const tenantId = options.tenantId ?? (await defaultTenantId());
  const automationState = await loadTenantAutomationState(tenantId, options.moduleCode);
  const refreshedSchedule = tenantId
    ? await evaluateTenantSchedule(
        { id: tenantId, name: automationState.tenantName, module_code: options.moduleCode, module_name: automationState.moduleName },
        await getRuntimeSettings(tenantId)
      )
    : automationState;
  await persistTenantAutomationState(refreshedSchedule);
  const candles = await hydrateChartCacheFromPostgres(
    options.symbol,
    options.timeframeMinutes,
    options.startupBackfillCount
  );
  return {
    connected: candles.length > 0,
    provider: "TWELVE_DATA",
    symbol: options.symbol,
    timeframeMinutes: options.timeframeMinutes,
    sourceTimeframeMinutes: preferredTwelveDataSourceTimeframe(options.timeframeMinutes),
    imported: 0,
    skipped: true,
    reason: candles.length > 0 ? "SHARED_POSTGRES_FEED" : "WAITING_FOR_SHARED_FEED",
    apiStartAt: refreshedSchedule.apiStartAt,
    apiStopAt: refreshedSchedule.apiStopAt,
    cachedCandles: candles.length,
    latestCandle: candles.at(-1) ?? null
  };
}

async function syncTwelveDataCandles(options: {
  symbol: string;
  providerSymbol: string;
  timeframeMinutes: number;
  interval: string;
  count: number;
  autoEvaluate: boolean;
  usageTenantIds?: string[];
  triggerSource?: string;
  usageReason?: string;
  force?: boolean;
}) {
  const lockAcquired = await tryTwelveDataCallLock();
  if (!lockAcquired) {
    return {
      connected: false,
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: "TWELVE_DATA_CALL_LOCK_BUSY",
      error: "Another process is already responsible for the current Twelve Data call."
    };
  }
  try {
    return await syncTwelveDataCandlesLocked(options);
  } finally {
    await releaseTwelveDataCallLock();
  }
}

async function syncTwelveDataCandlesLocked(options: {
  symbol: string;
  providerSymbol: string;
  timeframeMinutes: number;
  interval: string;
  count: number;
  autoEvaluate: boolean;
  usageTenantIds?: string[];
  triggerSource?: string;
  usageReason?: string;
  force?: boolean;
}) {
  const settings = await refreshRuntimeSettings();
  if (!config.twelveDataApiKey) {
    return { connected: false, provider: "TWELVE_DATA", imported: 0, error: "TWELVE_DATA_API_KEY is not configured." };
  }
  const policy = await twelveDataCallPolicy(options);
  if (!policy.allowed) {
    return {
      connected: false,
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: policy.reason,
      policy,
      error: policy.message
    };
  }
  const guardrail = await twelveDataCreditGuardrail();
  if (!guardrail.allowed) {
    return {
      connected: false,
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: guardrail.reason,
      guardrail,
      error: guardrail.message
    };
  }

  const providerSymbol = options.providerSymbol || "XAU/USD";
  const interval = options.interval || timeframeToTwelveInterval(options.timeframeMinutes);
  const count = Math.min(Math.max(options.count, 1), 5000);
  const params = new URLSearchParams({
    symbol: providerSymbol,
    interval,
    outputsize: String(count),
    timezone: "UTC",
    apikey: config.twelveDataApiKey
  });
  const response = await fetchJson<TwelveDataTimeSeriesResponse>(`https://api.twelvedata.com/time_series?${params.toString()}`);
  if (response.status === "error" || response.code || !response.values?.length) {
    await recordTwelveDataUsage({
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      requestedCount: count,
      importedCount: 0,
      tenantIds: options.usageTenantIds ?? [],
      status: "ERROR",
      error: response.message ?? "Twelve Data did not return candles.",
      triggerSource: options.triggerSource ?? "SYSTEM",
      usageReason: options.usageReason ?? policy.message,
      forced: options.force === true
    });
    return {
      connected: false,
      provider: "TWELVE_DATA",
      imported: 0,
      error: response.message ?? "Twelve Data did not return candles."
    };
  }

  let imported = 0;
  const savedCandles = [];
  for (const candle of parseTwelveDataCandles(response)) {
    const savedCandle = await upsertCandle(options.symbol, options.timeframeMinutes, candle);
    cacheLiveCandle(options.symbol, options.timeframeMinutes, {
      timestamp: savedCandle.timestampUtc,
      open: savedCandle.open,
      high: savedCandle.high,
      low: savedCandle.low,
      close: savedCandle.close,
      volume: savedCandle.volume,
      spread: savedCandle.spread,
      source: savedCandle.source
    });
    savedCandles.push(savedCandle);
    imported += 1;
  }

  const automation = options.autoEvaluate ? await processLiveSession(options.symbol, options.timeframeMinutes, [], await defaultTenantId()) : null;
  await recordTwelveDataUsage({
    symbol: options.symbol,
    timeframeMinutes: options.timeframeMinutes,
    requestedCount: count,
    importedCount: imported,
    tenantIds: options.usageTenantIds ?? [],
    status: "OK",
    error: null,
    triggerSource: options.triggerSource ?? "SYSTEM",
    usageReason: options.usageReason ?? policy.message,
    forced: options.force === true
  });
  await pruneStoredCandles(options.symbol, options.timeframeMinutes, settings.feed.cacheDays);
  await redisClient()?.del(`chart:candles:v1:${options.symbol}:${options.timeframeMinutes}:300`).catch(() => undefined);
  const latestSavedCandle = savedCandles.at(-1);
  if (latestSavedCandle) {
    broadcastLiveEvent({
      type: "candle",
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      candle: latestSavedCandle,
      automation
    });
  }

  return {
    connected: true,
    provider: "TWELVE_DATA",
    symbol: options.symbol,
    providerSymbol,
    timeframeMinutes: options.timeframeMinutes,
    interval,
    imported,
    automation
  };
}

function parseTwelveDataCandles(response: TwelveDataTimeSeriesResponse) {
  return [...(response.values ?? [])]
    .map((value) => ({
      timestamp: parseTwelveDataTimestamp(value.datetime),
      open: Number(value.open),
      high: Number(value.high),
      low: Number(value.low),
      close: Number(value.close),
      volume: value.volume == null || value.volume === "" ? null : Number(value.volume),
      spread: null,
      source: "TWELVE_DATA"
    }))
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

function parseTwelveDataTimestamp(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized)) return new Date(normalized).toISOString();
  return new Date(`${normalized}Z`).toISOString();
}

function timeframeToTwelveInterval(timeframeMinutes: number) {
  const supported = new Set([1, 5, 15, 30, 45]);
  if (supported.has(timeframeMinutes)) return `${timeframeMinutes}min`;
  if (timeframeMinutes === 60) return "1h";
  return "5min";
}

function preferredTwelveDataSourceTimeframe(timeframeMinutes: number) {
  if (timeframeMinutes >= 5 && timeframeMinutes % 5 === 0) return 5;
  return timeframeMinutes;
}

function twelveIntervalToTimeframe(interval: string) {
  const match = interval.match(/^(\d+)(min|h)$/);
  if (!match) return 15;
  const amount = Number(match[1]);
  return match[2] === "h" ? amount * 60 : amount;
}

function cacheKey(symbol: string, timeframe: number) {
  return `${symbol}:${timeframe}`;
}

function cacheLiveCandle(
  symbol: string,
  timeframe: number,
  candle: { timestamp: string; open: number; high: number; low: number; close: number; volume?: number | null; spread?: number | null; source?: string }
): LiveCandle {
  const timestampUtc = normalizeToTimeframe(candle.timestamp, timeframe);
  const cached = {
    timestampUtc,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? null,
    spread: candle.spread ?? null,
    source: candle.source ?? "TWELVE_DATA",
    receivedAt: new Date().toISOString()
  };
  const key = cacheKey(symbol, timeframe);
  const existing = liveCandleCache.get(key) ?? [];
  const byTime = new Map(existing.map((item) => [item.timestampUtc, item]));
  byTime.set(timestampUtc, cached);
  liveCandleCache.set(
    key,
    [...byTime.values()]
      .sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime())
      .slice(-liveCandleCacheLimit(timeframe))
  );
  return cached;
}

function liveCandleCacheLimit(timeframe: number) {
  const candlesPerDay = Math.ceil((24 * 60) / Math.max(timeframe, 1));
  return candlesPerDay * (runtimeSettings?.feed.cacheDays ?? LIVE_CANDLE_CACHE_DAYS) + 10;
}

export function getCachedCandles(symbol: string, timeframe: number) {
  return liveCandleCache.get(cacheKey(symbol, timeframe)) ?? [];
}

async function hydrateChartCacheFromPostgres(symbol: string, timeframe: number, limit: number) {
  const sourceTimeframe = preferredTwelveDataSourceTimeframe(timeframe);
  const hydrate = async (targetTimeframe: number, rowLimit: number) => {
    const stored = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source LIKE 'TWELVE_DATA%'
       ORDER BY timestamp_utc DESC
       LIMIT $3`,
      [symbol, targetTimeframe, Math.min(Math.max(rowLimit, 1), 5000)]
    );
    for (const row of stored.rows.reverse()) {
      cacheLiveCandle(symbol, targetTimeframe, {
        timestamp: row.timestamp_utc,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume == null ? null : Number(row.volume),
        spread: row.spread == null ? null : Number(row.spread),
        source: row.source
      });
    }
    return getCachedCandles(symbol, targetTimeframe);
  };

  await hydrate(sourceTimeframe, limit);
  if (timeframe !== sourceTimeframe) {
    await refreshDerivedCandles(symbol, sourceTimeframe, [timeframe]);
    await hydrate(timeframe, limit);
  }
  return getCachedCandles(symbol, timeframe);
}

function normalizeLiveCandles(candles: LiveCandle[]) {
  const byTime = new Map<string, LiveCandle>();
  for (const candle of candles) {
    byTime.set(candle.timestampUtc, candle);
  }
  return [...byTime.values()].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
}

async function refreshDerivedCandles(symbol: string, sourceTimeframe: number, targetTimeframes: number[]) {
  const stored = await query(
    `SELECT timestamp_utc, open, high, low, close, volume, spread, source
     FROM candles
     WHERE symbol = $1
       AND timeframe_minutes = $2
       AND source LIKE 'TWELVE_DATA%'
     ORDER BY timestamp_utc DESC
     LIMIT 5000`,
    [symbol, sourceTimeframe]
  );
  const sourceCandles = stored.rows.length > 0
    ? stored.rows.reverse().map((row: any) => ({
        timestampUtc: new Date(row.timestamp_utc).toISOString(),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume == null ? null : Number(row.volume),
        spread: row.spread == null ? null : Number(row.spread),
        source: row.source,
        receivedAt: new Date().toISOString()
      }))
    : getCachedCandles(symbol, sourceTimeframe);
  if (sourceCandles.length === 0) return;
  for (const candle of sourceCandles) {
    cacheLiveCandle(symbol, sourceTimeframe, {
      timestamp: candle.timestampUtc,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      spread: candle.spread,
      source: candle.source
    });
  }
  const uniqueTargets = [...new Set(targetTimeframes)]
    .filter((timeframe) => timeframe > sourceTimeframe && timeframe % sourceTimeframe === 0);
  for (const timeframe of uniqueTargets) {
    const derived = aggregateCandles(sourceCandles, timeframe);
    for (const candle of derived) {
      await upsertCandle(symbol, timeframe, {
        timestamp: candle.timestampUtc,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        spread: candle.spread,
        source: "TWELVE_DATA_DERIVED"
      });
      cacheLiveCandle(symbol, timeframe, {
        timestamp: candle.timestampUtc,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        spread: candle.spread,
        source: "TWELVE_DATA_DERIVED"
      });
    }
  }
}

function aggregateCandles(candles: LiveCandle[], timeframe: number) {
  const buckets = new Map<string, LiveCandle[]>();
  for (const candle of candles) {
    const bucket = normalizeToTimeframe(candle.timestampUtc, timeframe);
    const rows = buckets.get(bucket) ?? [];
    rows.push(candle);
    buckets.set(bucket, rows);
  }
  return [...buckets.entries()]
    .sort((left, right) => new Date(left[0]).getTime() - new Date(right[0]).getTime())
    .map(([timestampUtc, rows]) => {
      const ordered = rows.sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
      const volumeValues = ordered.map((item) => item.volume).filter((value): value is number => value != null && Number.isFinite(value));
      const spreadValues = ordered.map((item) => item.spread).filter((value): value is number => value != null && Number.isFinite(value));
      return {
        timestampUtc,
        open: ordered[0].open,
        high: Math.max(...ordered.map((item) => item.high)),
        low: Math.min(...ordered.map((item) => item.low)),
        close: ordered.at(-1)?.close ?? ordered[0].close,
        volume: volumeValues.length > 0 ? volumeValues.reduce((sum, value) => sum + value, 0) : null,
        spread: spreadValues.length > 0 ? spreadValues.at(-1) ?? null : null
      };
    });
}

function liveCandleToRow(candle: LiveCandle) {
  return {
    timestamp_utc: candle.timestampUtc,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    spread: candle.spread,
    source: candle.source,
    created_at: candle.receivedAt
  };
}

function cachedCandlesBetween(candles: LiveCandle[], from: string, to: string, options?: { exclusiveEnd?: boolean }) {
  const fromTime = new Date(from).getTime();
  const toTime = new Date(to).getTime();
  return candles
    .filter((candle) => {
      const time = new Date(candle.timestampUtc).getTime();
      return time >= fromTime && (options?.exclusiveEnd ? time < toTime : time <= toTime);
    })
    .map(liveCandleToRow);
}

function latestCachedCandle(candles: LiveCandle[], from: string, to: string, completedAtOrBefore: string) {
  const completedTime = new Date(completedAtOrBefore).getTime();
  return (
    cachedCandlesBetween(candles, from, to)
      .filter((row) => new Date(row.timestamp_utc).getTime() <= completedTime)
      .sort((left, right) => new Date(right.timestamp_utc).getTime() - new Date(left.timestamp_utc).getTime())[0] ?? null
  );
}

async function upsertCandle(
  symbol: string,
  timeframe: number,
  candle: { timestamp: string; open: number; high: number; low: number; close: number; volume?: number | null; spread?: number | null; source?: string }
) {
  const timestamp = normalizeToTimeframe(candle.timestamp, timeframe);
  const { rows } = await query(
    `INSERT INTO candles (symbol, timeframe_minutes, timestamp_utc, open, high, low, close, volume, spread, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (symbol, timeframe_minutes, timestamp_utc) DO UPDATE SET
       open = EXCLUDED.open,
       high = EXCLUDED.high,
       low = EXCLUDED.low,
       close = EXCLUDED.close,
       volume = EXCLUDED.volume,
       spread = EXCLUDED.spread,
       source = EXCLUDED.source,
       created_at = now()
     RETURNING timestamp_utc, open, high, low, close, volume, spread, source, created_at`,
    [symbol, timeframe, timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume ?? null, candle.spread ?? null, candle.source ?? "TWELVE_DATA"]
  );
  const saved = rows[0] as any;
  return {
    timestampUtc: saved.timestamp_utc,
    open: Number(saved.open),
    high: Number(saved.high),
    low: Number(saved.low),
    close: Number(saved.close),
    volume: saved.volume == null ? null : Number(saved.volume),
    spread: saved.spread == null ? null : Number(saved.spread),
    source: saved.source,
    receivedAt: saved.created_at
  };
}

async function pruneStoredCandles(symbol: string, timeframe: number, cacheDays: number) {
  const retentionDays = Math.max(Math.min(Number(cacheDays) || LIVE_CANDLE_CACHE_DAYS, 30), 1);
  await query(
    `DELETE FROM candles
     WHERE symbol = $1
       AND timeframe_minutes = $2
       AND source LIKE 'TWELVE_DATA%'
       AND timestamp_utc < now() - ($3::text || ' days')::interval`,
    [symbol, timeframe, retentionDays]
  ).catch(() => undefined);
}

function normalizeToTimeframe(timestamp: string, timeframeMinutes: number) {
  const date = new Date(timestamp);
  const bucketMs = timeframeMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

async function processLiveSession(symbol: string, timeframe: number, liveCandles: LiveCandle[] = [], tenantId?: string | null) {
  const activeTenantId = tenantId ?? (await defaultTenantId());
  const settings = await getRuntimeSettings(activeTenantId);
  const sessionResult = await query(
    `SELECT ts.*, sv.configuration_json, sv.opening_range_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = $1
       AND ts.tenant_id = $2
       AND ts.module_code = 'orb_max_options'
       AND ts.state NOT IN ('SESSION_COMPLETED', 'TRADE_CLOSED')
     ORDER BY
       CASE
         WHEN $3::timestamptz >= ts.session_start_at AND $3::timestamptz <= ts.signal_window_end_at THEN 0
         WHEN $3::timestamptz < ts.session_start_at THEN 1
         ELSE 2
       END,
       ts.session_start_at DESC,
       ts.created_at DESC
     LIMIT 1`,
    [symbol, activeTenantId, new Date().toISOString()]
  );
  const session = sessionResult.rows[0] as any;
  if (!session) return { sessionFound: false };

  const now = new Date();
  const signalEnd = new Date(session.signal_window_end_at);
  if (now > signalEnd && !["SESSION_EXPIRED", "SESSION_COMPLETED", "NO_TRADE"].includes(session.state)) {
    await query("UPDATE trading_sessions SET state = 'SESSION_EXPIRED' WHERE id = $1", [session.id]);
    await notifyTenantOnce(session.tenant_id, `session-expired-${session.id}`, "SESSION_EXPIRED", `${orbSessionLabel(session.session_preset)} ORB window expired`, "No new setups will be accepted for this session.");
    return { sessionFound: true, state: "SESSION_EXPIRED" };
  }

  let range = await getOpeningRange(session.id);
  if (range?.status === "LOCKED" && now >= new Date(session.opening_range_end_at)) {
    range = await repairOpeningRangeIfNeeded(session, range);
  }
  if ((!range || range.status !== "LOCKED") && now >= new Date(session.opening_range_end_at)) {
    range = await lockOpeningRangeForSession(session);
    if (range.status === "LOCKED") {
      await notifyTenantOnce(
        session.tenant_id,
        `range-locked-${session.id}`,
        "RANGE_LOCKED",
        `XAUUSD ${orbSessionLabel(session.session_preset)} ORB locked`,
        `High: ${range.high} Midpoint: ${range.midpoint} Low: ${range.low} Width: ${range.width}`
      );
    } else {
      await notifyTenantOnce(session.tenant_id, `range-invalid-${session.id}`, "RANGE_INVALID", "Opening range invalid", range.invalid_reason ?? "Opening range could not be locked.");
      return { sessionFound: true, rangeStatus: range.status };
    }
  }

  if (!range || range.status !== "LOCKED") return { sessionFound: true, rangeStatus: range?.status ?? "FORMING" };
  if (now < new Date(session.opening_range_end_at) || now > signalEnd) return { sessionFound: true, rangeStatus: range.status, evaluation: "OUTSIDE_SIGNAL_WINDOW" };

  const completedAtOrBefore = new Date(now.getTime() - timeframe * 60_000).toISOString();
  const current =
    latestCachedCandle(liveCandles, session.opening_range_end_at, session.signal_window_end_at, completedAtOrBefore) ??
    ((await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND timestamp_utc >= $3
         AND timestamp_utc <= $4
         AND timestamp_utc <= $5
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe, session.opening_range_end_at, session.signal_window_end_at, completedAtOrBefore]
    )).rows[0] as any);
  if (!current) return { sessionFound: true, rangeStatus: range.status, evaluation: "WAITING_FOR_SIGNAL_CANDLE" };

  const duplicate = await query(
    "SELECT id FROM setup_candidates WHERE session_id = $1 AND module_code = 'orb_max_options' AND detected_at = $2 LIMIT 1",
    [session.id, current.timestamp_utc]
  );
  if (duplicate.rows[0]) {
    const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId);
    return { sessionFound: true, rangeStatus: range.status, evaluation: "ALREADY_EVALUATED", tradeLifecycle };
  }

  const previousRows = cachedCandlesBetween(liveCandles, session.opening_range_end_at, current.timestamp_utc, { exclusiveEnd: true });
  const previousResult =
    previousRows.length > 0
      ? { rows: previousRows }
      : await query(
          `SELECT timestamp_utc, open, high, low, close, volume, spread
           FROM candles
           WHERE symbol = $1
             AND timeframe_minutes = $2
             AND timestamp_utc >= $3
             AND timestamp_utc < $4
           ORDER BY timestamp_utc ASC
           LIMIT 100`,
          [symbol, timeframe, session.opening_range_end_at, current.timestamp_utc]
        );
  const saved = await evaluateAndSaveSetup(session, range, current, previousResult.rows);
  const brainDecision = await runProductionBrainSweep(session.tenant_id, "orb_max_options");
  let paperTrade = null;
  const productionReady = isProductionReadySetup(saved?.setup, saved?.decision, saved?.risk);
  const brainApproved = brainApprovesPaperEntry(brainDecision, saved?.setup);
  await auditBrainPaperEntryGate(session.tenant_id, "orb_max_options", saved?.setup, productionReady, brainDecision, brainApproved);
  if (productionReady && brainApproved) {
    await saveSetupCandleSnapshot(saved.setup, session, timeframe, liveCandles, current);
    const alert = entryAlertDetails("orb_max_options", saved.setup, null, Number(saved.risk?.rewardToRisk ?? 0));
    paperTrade = settings.paperTradingEnabled
      ? await createAutomaticPaperTrade(session, saved.setup, saved.risk, current)
      : { skipped: true, reason: "PAPER_TRADING_DISABLED_BY_SETTINGS" };
    if (paperTrade?.trade || !settings.paperTradingEnabled) {
      await notifyTenantOnce(
        session.tenant_id,
        `setup-ready-${saved.setup.id}`,
        "SETUP_READY",
        `${alert.title} signal ready`,
        `${alert.body} | ${settings.paperTradingEnabled ? "Paper trading will simulate this setup." : "Paper trading is disabled in Settings."}`,
        "HIGH",
        alert.data,
        "validEntries"
      );
    }
  } else if (saved?.setup?.status === "NO TRADE") {
    await notifyTenantOnce(session.tenant_id, `no-trade-${saved.setup.id}`, "NO_TRADE", "No trade classification", saved.setup.final_reason);
  }
  const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId);

  return { sessionFound: true, rangeStatus: range.status, setupId: saved?.setup?.id, setupStatus: saved?.setup?.status, paperTrade, tradeLifecycle, brainDecision };
}

async function processModuleLiveSession(moduleCode: string, symbol: string, timeframe: number, _liveCandles: LiveCandle[] = [], tenantId?: string | null) {
  // PostgreSQL is the strategy source of truth. Memory candles are chart/websocket acceleration only.
  const persistedOnly: LiveCandle[] = [];
  if (moduleCode === "high_probability_strategy_2") {
    return processLiquiditySweepSession(symbol, timeframe, persistedOnly, tenantId);
  }
  return processLiveSession(symbol, timeframe, persistedOnly, tenantId);
}

async function processLiquiditySweepSession(symbol: string, timeframe: number, liveCandles: LiveCandle[] = [], tenantId?: string | null) {
  const activeTenantId = tenantId ?? (await defaultTenantId());
  const moduleCode = "high_probability_strategy_2";
  const settings = await getRuntimeSettings(activeTenantId);
  const sessionResult = await query(
    `SELECT ts.*, sv.configuration_json
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = $1
       AND ts.tenant_id = $2
       AND ts.module_code = $3
       AND ts.state NOT IN ('SESSION_COMPLETED', 'TRADE_CLOSED')
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [symbol, activeTenantId, moduleCode]
  );
  const session = sessionResult.rows[0] as any;
  if (!session) return { sessionFound: false };

  const now = new Date();
  const signalEnd = new Date(session.signal_window_end_at);
  if (now > signalEnd && !["SESSION_EXPIRED", "SESSION_COMPLETED", "NO_TRADE"].includes(session.state)) {
    await query("UPDATE trading_sessions SET state = 'SESSION_EXPIRED' WHERE id = $1", [session.id]);
    await notifyTenantOnce(session.tenant_id, `module2-session-expired-${session.id}`, "MODULE2_SESSION_EXPIRED", "Module 2 window expired", "No new liquidity sweep + BOS setups will be accepted for this session.");
    await runModule2CloseoutAfterSession({ ...session, state: "SESSION_EXPIRED" });
    return { sessionFound: true, state: "SESSION_EXPIRED" };
  }
  if (now < new Date(session.session_start_at) || now > signalEnd) return { sessionFound: true, evaluation: "OUTSIDE_MODULE2_WINDOW" };

  const completedAtOrBefore = new Date(now.getTime() - timeframe * 60_000).toISOString();
  const current =
    latestCachedCandle(liveCandles, session.session_start_at, session.signal_window_end_at, completedAtOrBefore) ??
    ((await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND timestamp_utc >= $3
         AND timestamp_utc <= $4
         AND timestamp_utc <= $5
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe, session.session_start_at, session.signal_window_end_at, completedAtOrBefore]
    )).rows[0] as any);
  if (!current) return { sessionFound: true, evaluation: "WAITING_FOR_MODULE2_CANDLE" };

  const duplicate = await query("SELECT id FROM setup_candidates WHERE session_id = $1 AND module_code = $2 AND detected_at = $3 LIMIT 1", [session.id, moduleCode, current.timestamp_utc]);
  if (duplicate.rows[0]) {
    const existingSetup = await loadSetupForProductionGate(duplicate.rows[0].id);
    const paperTrade = await attemptProductionPaperTrade({
      session,
      moduleCode,
      setup: existingSetup,
      decision: existingSetup,
      risk: null,
      current,
      timeframe,
      liveCandles,
      settings
    });
    const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
    return { sessionFound: true, evaluation: "ALREADY_EVALUATED", paperTrade, tradeLifecycle };
  }

  const startLookback = new Date(new Date(session.session_start_at).getTime() - 48 * 60 * 60_000).toISOString();
  const setupRows = cachedCandlesBetween(liveCandles, startLookback, current.timestamp_utc);
  const storedSetupRows = await query(
    `SELECT timestamp_utc, open, high, low, close, volume, spread
     FROM candles
     WHERE symbol = $1
       AND timeframe_minutes = $2
       AND timestamp_utc >= $3
       AND timestamp_utc <= $4
     ORDER BY timestamp_utc ASC
     LIMIT 700`,
    [symbol, timeframe, startLookback, current.timestamp_utc]
  );
  const fallbackSetupRows = uniqueCandleRows([...storedSetupRows.rows, ...setupRows, current]);
  const biasRows =
    timeframe === 15
      ? fallbackSetupRows
      : (
          await query(
            `SELECT timestamp_utc, open, high, low, close, volume, spread
             FROM candles
             WHERE symbol = $1
               AND timeframe_minutes = 15
               AND timestamp_utc <= $2
             ORDER BY timestamp_utc DESC
             LIMIT 200`,
            [symbol, new Date(new Date(current.timestamp_utc).getTime() - 15 * 60_000).toISOString()]
          )
        ).rows.reverse();
  const tradesTaken = await tradesTakenForSession(session.id, moduleCode);
  const configuration = await getTenantModuleStrategyConfiguration(activeTenantId, moduleCode, "liquiditySweep.strategy", session.configuration_json);
  const configVersion = await module2ConfigSnapshot(activeTenantId);
  const decision = evaluateLiquiditySweepSetup({
    now: current.timestamp_utc,
    symbol,
    setupCandles: fallbackSetupRows.map(toCandle),
    biasCandles: biasRows.map(toCandle),
    spread: current.spread == null ? null : Number(current.spread),
    newsStatus: "CLEAR",
    tradesTakenThisSession: tradesTaken,
    configuration: configuration as any
  });
  decision.scenarioFlags = {
    ...(decision.scenarioFlags ?? {}),
    configSnapshot: configVersion
  };
  const saved = await saveModuleDecision(session, moduleCode, decision, current);
  const brainDecision = await runProductionBrainSweep(session.tenant_id, moduleCode);
  await notifyModule2Stage(session, decision);
  await applyModule2SetupLifecycle(saved?.setup, decision, current);
  const paperTrade = await attemptProductionPaperTrade({
    session,
    moduleCode,
    setup: saved?.setup,
    decision: saved?.decision,
    risk: saved?.risk,
    current,
    timeframe,
    liveCandles,
    settings,
    brainDecision
  });
  const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
  return { sessionFound: true, setupId: saved?.setup?.id, setupStatus: saved?.setup?.status, evaluation: decision.state, paperTrade, tradeLifecycle, brainDecision };
}

async function buildModule2Readiness(tenantId: string | null, dryRun: boolean) {
  const moduleCode = "high_probability_strategy_2";
  const settings = await getRuntimeSettings(tenantId);
  const symbol = settings.symbol;
  const timeframe = 5;
  const state = tenantId ? tenantAutomationStates.get(tenantStateKey(tenantId, moduleCode)) ?? (await loadTenantAutomationState(tenantId, moduleCode)) : null;
  const session = (
    await query(
      `SELECT ts.*, sv.configuration_json
       FROM trading_sessions ts
       JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
       WHERE ts.tenant_id = $1 AND ts.module_code = $2 AND ts.symbol = $3
       ORDER BY ts.created_at DESC
       LIMIT 1`,
      [tenantId, moduleCode, symbol]
    )
  ).rows[0] as any;
  const cache5 = getCachedCandles(symbol, 5);
  const cache15 = getCachedCandles(symbol, 15);
  const [db5, db15, latestSetup, activeTrade] = await Promise.all([
    query("SELECT count(*)::int AS count, max(timestamp_utc) AS latest FROM candles WHERE symbol = $1 AND timeframe_minutes = 5", [symbol]),
    query("SELECT count(*)::int AS count, max(timestamp_utc) AS latest FROM candles WHERE symbol = $1 AND timeframe_minutes = 15", [symbol]),
    query(
      `SELECT * FROM setup_candidates
       WHERE tenant_id = $1 AND module_code = $2 AND status <> 'TEST_CLEARED'
       ORDER BY detected_at DESC LIMIT 1`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT t.*, sc.direction, sc.scenario
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND t.outcome = 'ACTIVE'
       ORDER BY t.opened_at DESC LIMIT 1`,
      [tenantId, moduleCode]
    )
  ]);
  const now = Date.now();
  const sessionStart = session?.session_start_at ? new Date(session.session_start_at).getTime() : null;
  const sessionEnd = session?.signal_window_end_at ? new Date(session.signal_window_end_at).getTime() : null;
  const nyWindowStatus = sessionStart && sessionEnd
    ? now < sessionStart ? "PRE_SESSION" : now <= sessionEnd ? "OPEN" : "CLOSED"
    : "NO_SESSION";
  const dryRunResult = dryRun ? await runModule2DryRunFromSavedCandles(tenantId, session, symbol, timeframe, cache5, cache15) : null;
  const readinessChecks = [
    { code: "TWELVE_DATA_CONFIGURED", label: "Twelve Data configured", status: Boolean(config.twelveDataApiKey) ? "PASS" : "FAIL" },
    { code: "NY_WINDOW", label: "NY window status", status: nyWindowStatus === "OPEN" ? "PASS" : "WAIT", value: nyWindowStatus },
    { code: "FIVE_MIN_CANDLES", label: "5M candles available", status: cache5.length + Number(db5.rows[0]?.count ?? 0) >= 20 ? "PASS" : "WAIT", value: cache5.length + Number(db5.rows[0]?.count ?? 0) },
    { code: "FIFTEEN_MIN_BIAS", label: "15M bias candles available", status: cache15.length + Number(db15.rows[0]?.count ?? 0) >= 20 ? "PASS" : "WAIT", value: cache15.length + Number(db15.rows[0]?.count ?? 0) },
    { code: "AUTOMATION_ENABLED", label: "Automation enabled", status: state?.enabled === false ? "FAIL" : "PASS" },
    { code: "PAPER_TRADING_ENABLED", label: "Paper trading enabled", status: settings.paperTradingEnabled ? "PASS" : "FAIL" },
    { code: "LATEST_EVALUATED_CANDLE", label: "Latest evaluated candle", status: latestSetup.rows[0]?.detected_at ? "PASS" : "WAIT", value: latestSetup.rows[0]?.detected_at ?? null },
    { code: "ACTIVE_PAPER_TRADE", label: "Active paper trade", status: activeTrade.rows[0] ? "INFO" : "WAIT", value: activeTrade.rows[0]?.id ?? null }
  ];
  return {
    moduleCode,
    symbol,
    timeframeMinutes: timeframe,
    dryRun,
    checks: readinessChecks,
    session,
    automation: state,
    feed: {
      twelveDataConfigured: Boolean(config.twelveDataApiKey),
      fiveMinute: { cache: cache5.length, postgres: Number(db5.rows[0]?.count ?? 0), latest: cache5.at(-1)?.timestampUtc ?? db5.rows[0]?.latest ?? null },
      fifteenMinute: { cache: cache15.length, postgres: Number(db15.rows[0]?.count ?? 0), latest: cache15.at(-1)?.timestampUtc ?? db15.rows[0]?.latest ?? null }
    },
    latestSetup: latestSetup.rows[0] ?? null,
    activeTrade: activeTrade.rows[0] ?? null,
    dryRunResult
  };
}

async function runModule2DryRunFromSavedCandles(tenantId: string | null, session: any, symbol: string, timeframe: number, cache5: LiveCandle[], cache15: LiveCandle[]) {
  const setupRows = cache5.length >= 20
    ? cache5.slice(-300).map(liveCandleToRow)
    : (
        await query(
          `SELECT timestamp_utc, open, high, low, close, volume, spread
           FROM candles
           WHERE symbol = $1 AND timeframe_minutes = $2
           ORDER BY timestamp_utc DESC
           LIMIT 300`,
          [symbol, timeframe]
        )
      ).rows.reverse();
  const biasRows = cache15.length >= 20
    ? cache15.slice(-200).map(liveCandleToRow)
    : (
        await query(
          `SELECT timestamp_utc, open, high, low, close, volume, spread
           FROM candles
           WHERE symbol = $1 AND timeframe_minutes = 15
           ORDER BY timestamp_utc DESC
           LIMIT 200`,
          [symbol]
        )
      ).rows.reverse();
  if (setupRows.length < 20) {
    return { status: "WAITING_FOR_DATA", reason: "Need at least 20 saved/cache 5M candles for Module 2 dry-run.", setupCandles: setupRows.length, biasCandles: biasRows.length };
  }
  const current = setupRows.at(-1);
  if (!current) {
    return { status: "WAITING_FOR_DATA", reason: "No saved/cache 5M candle is available for Module 2 dry-run.", setupCandles: 0, biasCandles: biasRows.length };
  }
  const version = session ?? (await activeStrategyVersionForModule("high_probability_strategy_2"));
  const baseConfiguration = session?.configuration_json ?? version?.configuration_json ?? {};
  const configuration = await getTenantModuleStrategyConfiguration(tenantId, "high_probability_strategy_2", "liquiditySweep.strategy", baseConfiguration);
  const tradesTaken = session?.id ? await tradesTakenForSession(session.id, "high_probability_strategy_2") : 0;
  const decision = evaluateLiquiditySweepSetup({
    now: rowTimestamp(current),
    symbol,
    setupCandles: uniqueCandleRows(setupRows).map(toCandle),
    biasCandles: uniqueCandleRows(biasRows.length > 0 ? biasRows : setupRows).map(toCandle),
    spread: current.spread == null ? null : Number(current.spread),
    newsStatus: "CLEAR",
    tradesTakenThisSession: tradesTaken,
    configuration: configuration as any
  });
  return {
    status: decision.status,
    state: decision.state,
    scenario: decision.scenario,
    direction: decision.direction,
    finalReason: decision.finalReason,
    score: decision.favorabilityScore,
    grade: decision.favorabilityGrade,
    setupCandles: setupRows.length,
    biasCandles: biasRows.length,
    latestCandle: rowTimestamp(current),
    wouldOpenPaperTrade: isProductionReadySetup({ module_code: "high_probability_strategy_2", status: decision.status, scenario: decision.scenario, scenario_flags: decision.scenarioFlags }, decision, { status: "PERMITTED" }),
    evaluations: decision.evaluations
  };
}

async function buildModule2Health(tenantId: string | null, createAlerts: boolean) {
  const readiness = await buildModule2Readiness(tenantId, false);
  const moduleCode = "high_probability_strategy_2";
  const symbol = readiness.symbol ?? "XAUUSD";
  const timeframe = 5;
  const latestCandleAt = readiness.feed?.fiveMinute?.latest;
  const latestCandleAgeSeconds = latestCandleAt ? Math.max(0, Math.round((Date.now() - new Date(latestCandleAt).getTime()) / 1000)) : null;
  const session = readiness.session;
  const now = Date.now();
  const sessionStart = session?.session_start_at ? new Date(session.session_start_at).getTime() : null;
  const sessionEnd = session?.signal_window_end_at ? new Date(session.signal_window_end_at).getTime() : null;
  const windowOpen = Boolean(sessionStart && sessionEnd && now >= sessionStart && now <= sessionEnd);
  const todayStart = session?.session_start_at ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const [sessionCandles, activeTradeAge, recentSetups, recentFeedErrors, todayCounts, auditFailures, latestPromotion] = await Promise.all([
    query(
      `SELECT count(*)::int AS count, max(timestamp_utc) AS latest
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND ($4::timestamptz IS NULL OR timestamp_utc <= $4::timestamptz)`,
      [symbol, timeframe, todayStart, session?.signal_window_end_at ?? null]
    ),
    query(
      `SELECT t.id, t.opened_at, EXTRACT(EPOCH FROM (now() - t.opened_at))::int AS age_seconds
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND t.outcome = 'ACTIVE'
       ORDER BY t.opened_at DESC
       LIMIT 1`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT scenario, status, detected_at
       FROM setup_candidates
       WHERE tenant_id = $1 AND module_code = $2 AND status <> 'TEST_CLEARED'
       ORDER BY detected_at DESC
       LIMIT 5`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM api_usage_events
       WHERE provider = 'TWELVE_DATA'
         AND status = 'ERROR'
         AND created_at >= now() - interval '30 minutes'`
    ),
    query(
      `SELECT
         count(sc.id)::int AS setups,
         count(t.id)::int AS trades,
         count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active_trades
       FROM setup_candidates sc
       LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.detected_at >= date_trunc('day', now())`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM notifications
       WHERE tenant_id = $1
         AND event_type IN ('MODULE2_PRODUCTION_AUDIT_FAILED')
         AND acknowledged_at IS NULL`,
      [tenantId]
    ),
    query(
      `SELECT preset_code, action, qa_only, applied_at
       FROM module_tuning_promotions
       WHERE tenant_id = $1 AND module_code = $2
       ORDER BY applied_at DESC
       LIMIT 1`,
      [tenantId, moduleCode]
    )
  ]);
  const setupStates = recentSetups.rows.map((row: any) => `${row.scenario}:${row.status}`);
  const stuckState = setupStates.length >= 3 && setupStates.slice(0, 3).every((state) => state === setupStates[0]);
  const issues = [
    healthIssue("FEED_STALE", "Feed stale", latestCandleAgeSeconds != null && latestCandleAgeSeconds > timeframe * 60 * 2, "HIGH", `Latest 5M candle is ${latestCandleAgeSeconds ?? "--"} seconds old.`),
    healthIssue("AUTOMATION_DISABLED", "Automation disabled", readiness.automation?.enabled === false, "HIGH", "Module 2 automation is disabled."),
    healthIssue("PAPER_TRADING_DISABLED", "Paper trading disabled", checkReadinessStatus(readiness, "PAPER_TRADING_ENABLED") === "FAIL", "HIGH", "Module 2 paper trading is disabled."),
    healthIssue("MISSED_NY_START", "Missed NY start", windowOpen && Number(sessionCandles.rows[0]?.count ?? 0) === 0, "CRITICAL", "NY window is open but no 5M candles have been stored for Module 2."),
    healthIssue("NO_CANDLES_DURING_WINDOW", "No candles during open window", windowOpen && Number(sessionCandles.rows[0]?.count ?? 0) < 2, "HIGH", "Module 2 has too few candles during the active NY window."),
    healthIssue("DRY_RUN_STATE_STUCK", "Dry-run state stuck", stuckState, "NORMAL", `Recent setup state repeated: ${setupStates[0] ?? "--"}.`),
    healthIssue("ACTIVE_TRADE_OPEN_TOO_LONG", "Active trade open too long", Number(activeTradeAge.rows[0]?.age_seconds ?? 0) > 3 * 60 * 60, "HIGH", "A Module 2 paper trade has been active for more than 3 hours.", {
      tradeId: activeTradeAge.rows[0]?.id ?? null,
      ageSeconds: activeTradeAge.rows[0]?.age_seconds ?? null,
      status: "ACTIVE",
      recommendedAction: "Review the active Module 2 paper trade on the chart or journal. The system will still close it automatically at TP or SL."
    }),
    healthIssue("REPEATED_FEED_ERRORS", "Repeated feed errors", Number(recentFeedErrors.rows[0]?.count ?? 0) >= 3, "HIGH", `${recentFeedErrors.rows[0]?.count ?? 0} Twelve Data errors in the last 30 minutes.`),
    healthIssue("PRODUCTION_AUDIT_FAILED", "Production audit failed", Number(auditFailures.rows[0]?.count ?? 0) > 0, "CRITICAL", "A Module 2 production audit failure notification is still unacknowledged."),
    healthIssue("TUNING_PRESET_CHANGED", "Tuning preset changed", Boolean(latestPromotion.rows[0] && new Date(latestPromotion.rows[0].applied_at).getTime() > Date.now() - 24 * 60 * 60_000), "NORMAL", latestPromotion.rows[0] ? `${latestPromotion.rows[0].action} ${latestPromotion.rows[0].preset_code}.` : "")
  ].filter((issue) => issue.active);
  if (createAlerts) {
    for (const issue of issues) {
      await notifyTenantOnce(
        tenantId,
        `module2-health-${issue.code}-${new Date().toISOString().slice(0, 10)}`,
        `MODULE2_${issue.code}`,
        issue.title,
        issue.body,
        issue.severity,
        {
          category: "HEALTH",
          moduleCode,
          moduleName: moduleDisplayName(moduleCode),
          issueCode: issue.code,
          status: summaryStatusForHealthIssue(issue),
          ...issue.data
        },
        "systemDiagnostics"
      );
    }
  }
  const summary = {
    moduleCode,
    status: issues.some((issue) => issue.severity === "CRITICAL") ? "CRITICAL" : issues.some((issue) => issue.severity === "HIGH") ? "WARNING" : "OK",
    candleCount: Number(sessionCandles.rows[0]?.count ?? 0),
    latestCandleAt: sessionCandles.rows[0]?.latest ?? latestCandleAt ?? null,
    latestEvaluationAt: readiness.latestSetup?.detected_at ?? null,
    setupCountToday: Number(todayCounts.rows[0]?.setups ?? 0),
    tradeCountToday: Number(todayCounts.rows[0]?.trades ?? 0),
    activeTrades: Number(todayCounts.rows[0]?.active_trades ?? 0),
    warnings: issues.length,
    actionNeeded: issues.length > 0 ? issues.map((issue) => issue.title).join(", ") : "None"
  };
  return { generatedAt: new Date().toISOString(), summary, issues, readiness };
}

async function buildModule2DataReadiness(tenantId: string | null, symbol: string, cacheDays = LIVE_CANDLE_CACHE_DAYS) {
  const timeframe = 5;
  const cached = getCachedCandles(symbol, timeframe);
  const db = await query(
    `SELECT count(*)::int AS count, min(timestamp_utc) AS first, max(timestamp_utc) AS latest
     FROM candles
     WHERE symbol = $1 AND timeframe_minutes = $2`,
    [symbol, timeframe]
  );
  const dbRow = db.rows[0] ?? {};
  const sessionDays = recentNewYorkSessionDates(Math.max(cacheDays, 7));
  const coverage = [];
  for (const sessionDate of sessionDays) {
    const times = sessionTimesForDate(sessionDate, "09:30", 0, "16:00");
    const cacheCount = cached.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc <= times.signalWindowEndAt).length;
    const stored = await query(
      `SELECT count(*)::int AS count
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc <= $4`,
      [symbol, timeframe, times.sessionStartAt, times.signalWindowEndAt]
    );
    const postgresCount = Number(stored.rows[0]?.count ?? 0);
    const totalAvailable = Math.max(cacheCount, postgresCount);
    coverage.push({
      sessionDate,
      sessionStartAt: times.sessionStartAt,
      sessionEndAt: times.signalWindowEndAt,
      cacheCount,
      postgresCount,
      totalAvailable,
      status: totalAvailable >= 20 ? "READY" : totalAvailable > 0 ? "PARTIAL" : "MISSING"
    });
  }
  const availableCandles = Math.max(cached.length, Number(dbRow.count ?? 0));
  const availableSessions = coverage.filter((row) => row.status === "READY").length;
  const readiness = module2DataReadinessGrade(availableCandles, availableSessions);
  const latestBacktest = await query(
    `SELECT id, status, summary, completed_at
     FROM backtest_runs
     WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return {
    moduleCode: "high_probability_strategy_2",
    symbol,
    timeframeMinutes: timeframe,
    generatedAt: new Date().toISOString(),
    readiness,
    apiEstimate: {
      startupBackfillCandles: TWELVE_DATA_STARTUP_BACKFILL_COUNT,
      estimatedCreditsPerBackfill: 1,
      note: "One Twelve Data time_series call requests up to 100 recent 5-minute candles."
    },
    cache: {
      candleCount: cached.length,
      cacheDays,
      firstCandleAt: cached[0]?.timestampUtc ?? null,
      latestCandleAt: cached.at(-1)?.timestampUtc ?? null
    },
    postgres: {
      candleCount: Number(dbRow.count ?? 0),
      firstCandleAt: dbRow.first ?? null,
      latestCandleAt: dbRow.latest ?? null
    },
    nyCoverage: coverage,
    missingSessions: coverage.filter((row) => row.status !== "READY"),
    latestBacktest: latestBacktest.rows[0] ?? null
  };
}

async function buildOrbDataReadiness(tenantId: string | null, symbol: string, cacheDays: number, settings: RuntimeSettings) {
  const timeframe = settings.timeframeMinutes;
  const cached = getCachedCandles(symbol, timeframe);
  const db = await query(
    `SELECT count(*)::int AS count, min(timestamp_utc) AS first, max(timestamp_utc) AS latest
     FROM candles
     WHERE symbol = $1 AND timeframe_minutes = $2`,
    [symbol, timeframe]
  );
  const dbRow = db.rows[0] ?? {};
  const coverage = [];
  for (const sessionDate of recentNewYorkSessionDates(Math.max(cacheDays, 7))) {
    const times = sessionTimesForDate(sessionDate, settings.orb.sessionStart, settings.orb.openingRangeMinutes, settings.orb.tradeWindowEnd);
    const expectedOpeningCandles = Math.ceil(settings.orb.openingRangeMinutes / timeframe);
    const cacheOpening = cached.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc < times.openingRangeEndAt).length;
    const cacheSignal = cached.filter((candle) => candle.timestampUtc >= times.openingRangeEndAt && candle.timestampUtc <= times.signalWindowEndAt).length;
    const stored = await query(
      `SELECT
         count(*) FILTER (WHERE timestamp_utc >= $3 AND timestamp_utc < $4)::int AS opening,
         count(*) FILTER (WHERE timestamp_utc >= $4 AND timestamp_utc <= $5)::int AS signal
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc <= $5`,
      [symbol, timeframe, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt]
    );
    const postgresOpening = Number(stored.rows[0]?.opening ?? 0);
    const postgresSignal = Number(stored.rows[0]?.signal ?? 0);
    const openingAvailable = Math.max(cacheOpening, postgresOpening);
    const signalAvailable = Math.max(cacheSignal, postgresSignal);
    coverage.push({
      sessionDate,
      sessionStartAt: times.sessionStartAt,
      openingRangeEndAt: times.openingRangeEndAt,
      sessionEndAt: times.signalWindowEndAt,
      expectedOpeningCandles,
      cacheOpening,
      cacheSignal,
      postgresOpening,
      postgresSignal,
      totalAvailable: openingAvailable + signalAvailable,
      status: openingAvailable >= expectedOpeningCandles && signalAvailable > 0 ? "READY" : openingAvailable > 0 || signalAvailable > 0 ? "PARTIAL" : "MISSING"
    });
  }
  const availableCandles = Math.max(cached.length, Number(dbRow.count ?? 0));
  const availableSessions = coverage.filter((row) => row.status === "READY").length;
  const latestBacktest = await query(
    `SELECT id, status, summary, completed_at
     FROM backtest_runs
     WHERE tenant_id = $1 AND module_code = 'orb_max_options'
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return {
    moduleCode: "orb_max_options",
    symbol,
    timeframeMinutes: timeframe,
    executionTimeframeMinutes: timeframe,
    openingRangeMinutes: settings.orb.openingRangeMinutes,
    openingRangeCandleCount: Math.ceil(settings.orb.openingRangeMinutes / timeframe),
    generatedAt: new Date().toISOString(),
    readiness: orbDataReadinessGrade(availableCandles, availableSessions),
    apiEstimate: {
      startupBackfillCandles: TWELVE_DATA_STARTUP_BACKFILL_COUNT,
      estimatedCreditsPerBackfill: 1,
      note: "One Twelve Data time_series call requests up to 100 recent 5M execution candles. Module 1 builds its 15-minute ORB range from the first three 5M candles."
    },
    cache: {
      candleCount: cached.length,
      cacheDays,
      firstCandleAt: cached[0]?.timestampUtc ?? null,
      latestCandleAt: cached.at(-1)?.timestampUtc ?? null
    },
    postgres: {
      candleCount: Number(dbRow.count ?? 0),
      firstCandleAt: dbRow.first ?? null,
      latestCandleAt: dbRow.latest ?? null
    },
    nyCoverage: coverage,
    missingSessions: coverage.filter((row) => row.status !== "READY"),
    latestBacktest: latestBacktest.rows[0] ?? null
  };
}

function orbDataReadinessGrade(candles: number, sessions: number) {
  if (candles >= 700 && sessions >= 10) return { grade: "CONFIDENCE_READY", label: "Enough for confidence report", canBacktest: true, reason: "Enough 5-minute execution coverage for a stronger Module 1 confidence read." };
  if (candles >= 250 && sessions >= 4) return { grade: "RESEARCH_READY", label: "Enough for research", canBacktest: true, reason: "Enough ORB candles for early research backtesting." };
  if (candles >= 50 && sessions >= 1) return { grade: "QA_READY", label: "Enough for QA", canBacktest: true, reason: "Enough candles to test ORB backtest behavior." };
  return { grade: "NOT_ENOUGH_DATA", label: "Not enough data", canBacktest: false, reason: "Collect at least one NY ORB session before trusting Module 1 backtests." };
}

function module2DataReadinessGrade(candles: number, sessions: number) {
  if (candles >= 1500 && sessions >= 10) {
    return { grade: "CONFIDENCE_READY", label: "Enough for confidence report", canBacktest: true, reason: "Enough 5-minute candle coverage for a stronger Module 2 confidence read." };
  }
  if (candles >= 500 && sessions >= 4) {
    return { grade: "RESEARCH_READY", label: "Enough for research", canBacktest: true, reason: "Enough candles for early research backtesting, but not enough for strong statistical confidence." };
  }
  if (candles >= 100 && sessions >= 1) {
    return { grade: "QA_READY", label: "Enough for QA", canBacktest: true, reason: "Enough candles to test the backtest path and inspect setup behavior." };
  }
  return { grade: "NOT_ENOUGH_DATA", label: "Not enough data", canBacktest: false, reason: "Collect at least one NY session of 5-minute candles before trusting Module 2 backtests." };
}

async function moduleSessionForReport(tenantId: string | null, moduleCode: string, sessionDate?: string) {
  const date = sessionDate ?? newYorkDate();
  const result = await query(
    `SELECT *
     FROM trading_sessions
     WHERE tenant_id = $1
       AND module_code = $2
       AND session_date = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, moduleCode, date]
  );
  return result.rows[0] as any;
}

async function generateGenericModuleSessionReport(session: any, moduleCode: string, settingKey: string) {
  const [candles, setups, trades, failedRules, learning, configSnapshot] = await Promise.all([
    query(
      `SELECT count(*)::int AS count, min(timestamp_utc) AS first, max(timestamp_utc) AS latest
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = 5 AND timestamp_utc >= $2 AND timestamp_utc <= $3`,
      [session.symbol, session.session_start_at, session.signal_window_end_at]
    ),
    query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status IN ('LONG SETUP READY','SHORT SETUP READY','PAPER_TRADE_OPENED','TRADE_PLANNED'))::int AS valid_setups,
         count(*) FILTER (WHERE status IN ('NO TRADE','BLOCKED','WAIT'))::int AS blocked_setups,
         max(detected_at) AS latest_setup_at
       FROM setup_candidates
       WHERE tenant_id = $1 AND module_code = $2 AND session_id = $3 AND status <> 'TEST_CLEARED'`,
      [session.tenant_id, moduleCode, session.id]
    ),
    query(
      `SELECT
         count(t.id)::int AS total,
         count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
         count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
         count(t.id) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
         count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
         COALESCE(sum(t.result_r), 0)::float AS total_r
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.session_id = $3
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [session.tenant_id, moduleCode, session.id]
    ),
    query(
      `SELECT sre.rule_code, sre.name, sre.status, count(*)::int AS count
       FROM setup_rule_evaluations sre
       JOIN setup_candidates sc ON sc.id = sre.setup_candidate_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND sc.session_id = $3 AND sre.status <> 'PASS'
       GROUP BY sre.rule_code, sre.name, sre.status
       ORDER BY count(*) DESC
       LIMIT 12`,
      [session.tenant_id, moduleCode, session.id]
    ),
    latestModuleLearningSnapshot(session.tenant_id, moduleCode),
    moduleConfigSnapshot(session.tenant_id, moduleCode, settingKey)
  ]);
  const candleRow = candles.rows[0] ?? {};
  const setupRow = setups.rows[0] ?? {};
  const tradeRow = trades.rows[0] ?? {};
  const blockedReasons = [
    Number(candleRow.count ?? 0) < 25 ? "Too few 5M candles were stored for the session." : null,
    Number(setupRow.valid_setups ?? 0) === 0 ? "No valid setup reached paper-trade readiness." : null,
    ...failedRules.rows.slice(0, 5).map((row: any) => `${row.rule_code}: ${row.count}`)
  ].filter(Boolean);
  const finalStatus = blockedReasons.length === 0 ? "GO" : Number(setupRow.total ?? 0) > 0 || Number(candleRow.count ?? 0) > 0 ? "REVIEW" : "NO_GO";
  const summary = {
    sessionDate: session.session_date,
    symbol: session.symbol,
    sessionFound: true,
    validSetups: Number(setupRow.valid_setups ?? 0),
    blockedSetups: Number(setupRow.blocked_setups ?? 0),
    paperTrades: Number(tradeRow.total ?? 0),
    wins: Number(tradeRow.wins ?? 0),
    losses: Number(tradeRow.losses ?? 0),
    active: Number(tradeRow.active ?? 0),
    totalR: Number(tradeRow.total_r ?? 0)
  };
  const saved = await query(
    `INSERT INTO module_session_reports (
      tenant_id, module_code, session_id, session_date, final_status,
      summary, feed_snapshot, setup_snapshot, trade_snapshot, blocked_reasons,
      checklist_summary, learning_notes
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)
     ON CONFLICT (tenant_id, module_code, session_date)
     DO UPDATE SET
       session_id = EXCLUDED.session_id,
       final_status = EXCLUDED.final_status,
       summary = EXCLUDED.summary,
       feed_snapshot = EXCLUDED.feed_snapshot,
       setup_snapshot = EXCLUDED.setup_snapshot,
       trade_snapshot = EXCLUDED.trade_snapshot,
       blocked_reasons = EXCLUDED.blocked_reasons,
       checklist_summary = EXCLUDED.checklist_summary,
       learning_notes = EXCLUDED.learning_notes,
       generated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      session.tenant_id,
      moduleCode,
      session.id,
      session.session_date,
      finalStatus,
      JSON.stringify(summary),
      JSON.stringify({ candles5m: Number(candleRow.count ?? 0), firstCandleAt: candleRow.first ?? null, latestCandleAt: candleRow.latest ?? null }),
      JSON.stringify({ total: Number(setupRow.total ?? 0), valid: Number(setupRow.valid_setups ?? 0), blocked: Number(setupRow.blocked_setups ?? 0), latestSetupAt: setupRow.latest_setup_at ?? null }),
      JSON.stringify({ ...tradeRow }),
      JSON.stringify(blockedReasons),
      JSON.stringify({ failedRules: failedRules.rows, configSnapshot }),
      JSON.stringify({ latestLearningAt: learning?.completed_at ?? null, sampleSize: learning?.sample_size ?? 0, recommendations: learning?.recommendations ?? [] })
    ]
  );
  return saved.rows[0];
}

async function latestModuleLearningSnapshot(tenantId: string | null, moduleCode: string) {
  const run = await query(
    `SELECT *
     FROM module_learning_runs
     WHERE tenant_id = $1 AND module_code = $2
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId, moduleCode]
  );
  const row = run.rows[0] as any;
  if (!row) return null;
  const recommendations = await query(
    `SELECT *
     FROM module_learning_recommendations
     WHERE learning_run_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [row.id]
  );
  return { ...row, recommendations: recommendations.rows };
}

async function latestStrategyCoachSnapshots(tenantId: string | null) {
  const modules = await query(
    `SELECT m.code, m.name
     FROM tenant_modules tm
     JOIN platform_strategy_modules m ON m.id = tm.module_id
     WHERE tm.tenant_id = $1 AND tm.status = 'ENABLED'
     ORDER BY m.sort_order`,
    [tenantId]
  );
  const snapshots = [];
  for (const module of modules.rows as any[]) {
    snapshots.push((await latestModuleLearningSnapshot(tenantId, module.code)) ?? { moduleCode: module.code, moduleName: module.name, status: "NOT_RUN", recommendations: [] });
  }
  return {
    generatedAt: new Date().toISOString(),
    tenantId,
    modules: snapshots
  };
}

async function latestMainBrainDecisions(tenantId: string | null, moduleCode?: string) {
  const params: any[] = [tenantId];
  const moduleFilter = moduleCode ? `AND metadata->>'moduleCode' = $${params.push(moduleCode)}` : "";
  const rows = await query(
    `SELECT id, severity, message, metadata, created_at
     FROM operational_events
     WHERE tenant_id = $1
       AND event_type = 'MAIN_BRAIN_DECISION'
       ${moduleFilter}
     ORDER BY created_at DESC
     LIMIT 20`,
    params
  );
  const latestRun = await query(
    `SELECT id, severity, message, metadata, created_at
     FROM operational_events
     WHERE tenant_id = $1
       AND event_type = 'MAIN_BRAIN_RUN'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return {
    generatedAt: new Date().toISOString(),
    tenantId,
    latestRun: latestRun.rows[0] ?? null,
    decisions: rows.rows
  };
}

async function runProductionBrainSweep(tenantId: string | null, moduleCode: string) {
  if (!tenantId) return { skipped: true, reason: "TENANT_REQUIRED" };
  try {
    const result = await runMainBrainPython(tenantId, moduleCode);
    const decision = Array.isArray(result?.decisions) ? result.decisions[0] : null;
    return {
      status: "COMPLETED",
      moduleCode,
      decisionType: decision?.decisionType ?? null,
      action: decision?.action ?? null,
      shouldOpenPaperTrade: Boolean(decision?.shouldOpenPaperTrade),
      entry: decision?.entry ?? null,
      stop: decision?.stop ?? null,
      target: decision?.target ?? null
    };
  } catch (error) {
    await query(
      `INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
       VALUES ('ERROR', 'SYSTEM', 'MAIN_BRAIN_FAILED', 'market-data-worker', $1, $2, $3::jsonb)`,
      [
        tenantId,
        `Python main brain failed for ${moduleCode}.`,
        JSON.stringify({
          moduleCode,
          error: error instanceof Error ? error.message : String(error)
        })
      ]
    );
    return { status: "FAILED", moduleCode, error: error instanceof Error ? error.message : String(error) };
  }
}

function brainApprovesPaperEntry(brainDecision: any, setup: any) {
  if (!setup?.direction) return false;
  const expectedAction = setup.direction === "LONG" ? "BUY" : "SELL";
  return brainDecision?.status === "COMPLETED"
    && brainDecision?.shouldOpenPaperTrade === true
    && brainDecision?.action === expectedAction
    && [brainDecision.entry, brainDecision.stop, brainDecision.target].every((value) => Number.isFinite(Number(value)));
}

async function auditBrainPaperEntryGate(
  tenantId: string | null,
  moduleCode: string,
  setup: any,
  productionReady: boolean,
  brainDecision: any,
  approved: boolean
) {
  if (!tenantId || !setup?.id || !productionReady || approved) return;
  const existing = await query(
    `SELECT 1
     FROM operational_events
     WHERE tenant_id = $1
       AND event_type = 'PAPER_ENTRY_BRAIN_BLOCKED'
       AND metadata->>'setupId' = $2
     LIMIT 1`,
    [tenantId, String(setup.id)]
  );
  if (existing.rows[0]) return;
  await recordOperationalEvent({
    severity: brainDecision?.status === "FAILED" ? "ERROR" : "WARN",
    category: "WORKER",
    eventType: "PAPER_ENTRY_BRAIN_BLOCKED",
    source: "market-data-worker",
    tenantId,
    message: `A production-ready ${moduleCode} setup was not approved by its Python brain.`,
    metadata: {
      moduleCode,
      setupId: String(setup.id),
      setupDirection: setup.direction ?? null,
      brainStatus: brainDecision?.status ?? null,
      brainAction: brainDecision?.action ?? null,
      brainShouldOpenPaperTrade: Boolean(brainDecision?.shouldOpenPaperTrade),
      brainError: brainDecision?.error ?? null
    }
  });
}

async function moduleConfigSnapshot(tenantId: string | null, moduleCode: string, settingKey: string) {
  const setting = await query(
    `SELECT updated_at
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = $2 AND key = $3
     LIMIT 1`,
    [tenantId, moduleCode, settingKey]
  );
  return {
    moduleCode,
    settingKey,
    updatedAt: setting.rows[0]?.updated_at ?? null
  };
}

function recentNewYorkSessionDates(days: number) {
  const out: string[] = [];
  for (let index = 0; out.length < days && index < days + 10; index += 1) {
    const sessionDate = newYorkDate(new Date(Date.now() - index * 24 * 60 * 60_000));
    if (!out.includes(sessionDate)) out.push(sessionDate);
  }
  return out;
}

async function buildModule2Operator(tenantId: string | null, runRehearsal: boolean) {
  const moduleCode = "high_probability_strategy_2";
  const [readiness, health, audit, latestAlert, latestPromotion] = await Promise.all([
    buildModule2Readiness(tenantId, runRehearsal),
    buildModule2Health(tenantId, runRehearsal),
    buildModule2ProductionAudit(tenantId),
    query(
      `SELECT event_type, title, body, priority, created_at, acknowledged_at
       FROM notifications
       WHERE tenant_id = $1
         AND (event_type LIKE 'MODULE2_%' OR title ILIKE '%Module 2%' OR body ILIKE '%Module 2%')
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId]
    ),
    query(
      `SELECT preset_code, action, qa_only, applied_at
       FROM module_tuning_promotions
       WHERE tenant_id = $1 AND module_code = $2
       ORDER BY applied_at DESC
       LIMIT 1`,
      [tenantId, moduleCode]
    )
  ]);

  if (runRehearsal) {
    await notifyTenantOnce(
      tenantId,
      `module2-launch-rehearsal-test-${new Date().toISOString().slice(0, 10)}`,
      "MODULE2_REHEARSAL_TEST",
      "Module 2 rehearsal notification",
      "Launch rehearsal completed a server-side notification test.",
      "NORMAL"
    );
  }

  const operator = {
    moduleCode,
    generatedAt: new Date().toISOString(),
    timeline: {
      apiStartAt: readiness.automation?.apiStartAt ?? null,
      sessionStartAt: readiness.session?.session_start_at ?? readiness.automation?.sessionStartAt ?? null,
      openingRangeEndAt: readiness.session?.opening_range_end_at ?? readiness.automation?.openingRangeEndAt ?? null,
      signalWindowEndAt: readiness.session?.signal_window_end_at ?? readiness.automation?.signalWindowEndAt ?? null,
      apiStopAt: readiness.automation?.apiStopAt ?? null
    },
    currentPhase: readiness.automation?.phase ?? checkReadinessValue(readiness, "NY_WINDOW") ?? "UNKNOWN",
    nextAction: health.summary?.actionNeeded && health.summary.actionNeeded !== "None"
      ? health.summary.actionNeeded
      : readiness.automation?.reason ?? "Wait for a valid NY liquidity sweep + BOS setup.",
    latestCandle: readiness.feed?.fiveMinute?.latest ?? null,
    latestSetupState: {
      status: readiness.latestSetup?.status ?? "WAITING",
      scenario: readiness.latestSetup?.scenario ?? null,
      direction: readiness.latestSetup?.direction ?? null,
      detectedAt: readiness.latestSetup?.detected_at ?? null,
      state: readiness.latestSetup?.scenario_flags?.state ?? null
    },
    activeTradeStatus: readiness.activeTrade
      ? {
          id: readiness.activeTrade.id,
          outcome: readiness.activeTrade.outcome,
          direction: readiness.activeTrade.direction,
          openedAt: readiness.activeTrade.opened_at
        }
      : null,
    lastAlert: latestAlert.rows[0] ?? null,
    tuningPreset: latestPromotion.rows[0] ?? { preset_code: "CURRENT_CONFIGURATION", action: "CURRENT", qa_only: false, applied_at: null }
  };

  const dryRunStatus = readiness.dryRunResult?.status;
  const checklist = [
    launchCheck("FEED_READY", "Feed ready", ["TWELVE_DATA_CONFIGURED"].every((code) => checkReadinessStatus(readiness, code) === "PASS"), "Twelve Data API key is configured."),
    launchCheck("CANDLES_READY", "Candles ready", ["FIVE_MIN_CANDLES", "FIFTEEN_MIN_BIAS"].every((code) => checkReadinessStatus(readiness, code) === "PASS"), "5M setup candles and 15M bias candles are available."),
    launchCheck("AUTOMATION_READY", "Automation ready", checkReadinessStatus(readiness, "AUTOMATION_ENABLED") === "PASS", "Module 2 automation is enabled."),
    launchCheck("PAPER_TRADING_READY", "Paper trading ready", checkReadinessStatus(readiness, "PAPER_TRADING_ENABLED") === "PASS", "Paper trading is enabled for automatic simulated entries."),
    launchCheck("AUDIT_PASS", "Audit pass", audit.checks.filter((check: any) => check.status === "FAIL").length === 0, "Production audit has no failing Module 2 checks."),
    launchCheck("TUNING_PRESET_SELECTED", "Tuning preset selected", Boolean(latestPromotion.rows[0]), latestPromotion.rows[0] ? `${latestPromotion.rows[0].preset_code} is active.` : "No promoted preset has been applied yet; current configuration is running."),
    launchCheck("HEALTH_CHECK_PASS", "Health check pass", health.summary?.status === "OK", health.summary?.actionNeeded ?? "No action needed."),
    launchCheck("NOTIFICATIONS_ENABLED", "Notifications enabled", true, runRehearsal ? "Server notification test was sent." : "Server notification route is available."),
    launchCheck("DRY_RUN_READY", "Dry-run ready", !runRehearsal || Boolean(dryRunStatus && dryRunStatus !== "WAITING_FOR_DATA"), readiness.dryRunResult?.reason ?? readiness.dryRunResult?.finalReason ?? "Dry-run will execute during rehearsal.")
  ];
  const requiredChecks = checklist.filter((check) => check.code !== "TUNING_PRESET_SELECTED");
  const finalStatus = requiredChecks.every((check) => check.status === "PASS") && health.summary?.status === "OK" ? "GO" : "NO_GO";
  const warnings = health.issues?.map((issue: any) => `${issue.severity}: ${issue.title}`) ?? [];
  const result = {
    moduleCode,
    generatedAt: operator.generatedAt,
    rehearsal: runRehearsal,
    finalStatus,
    operator,
    checklist,
    readiness,
    health,
    audit,
    handoff: {
      watchDuringSession: [
        "Liquidity sweep must close back inside a valid level.",
        "Displacement and BOS/CHoCH must complete before any paper trade opens.",
        "Confirmation count must be at least 3 of 5, and quality filters at least 3.",
        "Manual execution should follow the paper signal only after checklist status is valid."
      ],
      currentPreset: operator.tuningPreset,
      activeWarnings: warnings.length > 0 ? warnings : ["No active Module 2 warnings."],
      expectedNextAction: operator.nextAction,
      manualTraderNotes: finalStatus === "GO"
        ? "Module 2 is ready for the next NY session. Watch alerts and chart markers; execution remains manual."
        : "Resolve NO GO checklist rows before relying on Module 2 paper signals."
    }
  };
  if (runRehearsal && tenantId) {
    await query(
      `INSERT INTO module_launch_rehearsals (
        tenant_id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        tenantId,
        moduleCode,
        finalStatus,
        JSON.stringify(checklist),
        JSON.stringify(health.summary ?? {}),
        JSON.stringify(audit),
        JSON.stringify(readiness.dryRunResult ?? {}),
        JSON.stringify(result.handoff)
      ]
    );
  }
  return result;
}

async function buildModule2ProductionAudit(tenantId: string | null) {
  const [invalidTrades, replayTrades, moduleMix, liveTrades] = await Promise.all([
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = 'high_probability_strategy_2'
         AND sc.status NOT IN ('PAPER_TRADE_OPENED','TRADE_PLANNED','LONG SETUP READY','SHORT SETUP READY')
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId]
    ),
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = 'high_probability_strategy_2'
         AND (sc.scenario = 'QA_TEST_SIGNAL' OR COALESCE(sc.scenario_flags->>'replay', 'false') = 'true')`,
      [tenantId]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN trading_sessions ts ON ts.id = sc.session_id
       WHERE sc.tenant_id = $1
         AND sc.module_code <> ts.module_code`,
      [tenantId]
    ),
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = 'high_probability_strategy_2'
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId]
    )
  ]);
  const invalidTradeCount = Number(invalidTrades.rows[0]?.count ?? 0);
  const moduleMixCount = Number(moduleMix.rows[0]?.count ?? 0);
  return {
    moduleCode: "high_probability_strategy_2",
    checks: [
      { code: "INVALID_SETUPS_NEVER_TRADE", status: invalidTradeCount === 0 ? "PASS" : "FAIL", count: invalidTradeCount },
      { code: "MODULE_BOUNDARY_CLEAN", status: moduleMixCount === 0 ? "PASS" : "FAIL", count: moduleMixCount },
      { code: "REPLAY_EXCLUDED_FROM_PRODUCTION", status: "PASS", count: Number(replayTrades.rows[0]?.count ?? 0) },
      { code: "LIVE_PRODUCTION_TRADES", status: "INFO", count: Number(liveTrades.rows[0]?.count ?? 0) }
    ]
  };
}

function launchCheck(code: string, label: string, pass: boolean, detail: string) {
  return { code, label, status: pass ? "PASS" : "WAIT", detail };
}

function healthIssue(code: string, title: string, active: boolean, severity: string, body: string, data: Record<string, unknown> = {}) {
  return { code, title, active, severity, body, data };
}

function summaryStatusForHealthIssue(issue: { severity?: string }) {
  if (issue.severity === "CRITICAL") return "CRITICAL";
  if (issue.severity === "HIGH") return "WARNING";
  return "INFO";
}

function checkReadinessStatus(readiness: any, code: string) {
  return readiness.checks?.find((check: any) => check.code === code)?.status ?? "--";
}

function checkReadinessValue(readiness: any, code: string) {
  return readiness.checks?.find((check: any) => check.code === code)?.value ?? null;
}

function isProductionReadySetup(setup: any, decision: any, risk?: any) {
  if (!setup || !["orb_max_options", "high_probability_strategy_2"].includes(setup.module_code)) return false;
  if (!["LONG SETUP READY", "SHORT SETUP READY"].includes(String(setup.status))) return false;
  if (setup.scenario === "QA_TEST_SIGNAL") return false;
  if (setup.scenario_flags?.replay === true) return false;
  if (risk?.status !== "PERMITTED") return false;
  const tier = String(setup.scenario_flags?.setupTier ?? decision?.scenarioFlags?.setupTier ?? "FULL");
  if (tier === "MANDATORY") {
    return moduleMandatoryEntryPassed(setup.module_code, decision?.evaluations ?? []);
  }
  const blockingRules = decision?.evaluations?.filter((evaluation: any) => evaluation.blocking) ?? [];
  return blockingRules.length > 0 && blockingRules.every((evaluation: any) => evaluation.status === "PASS");
}

async function loadSetupForProductionGate(setupId: string) {
  const setup = (await query("SELECT * FROM setup_candidates WHERE id = $1 LIMIT 1", [setupId])).rows[0] as any;
  if (!setup) return null;
  const evaluations = await query(
    `SELECT rule_code, name, status, blocking, source, actual_value, required_value, explanation
     FROM setup_rule_evaluations
     WHERE setup_candidate_id = $1
     ORDER BY evaluated_at ASC`,
    [setupId]
  );
  return {
    ...setup,
    evaluations: evaluations.rows.map((row: any) => ({
      ruleCode: row.rule_code,
      rule_code: row.rule_code,
      name: row.name,
      status: row.status,
      blocking: row.blocking,
      source: row.source,
      actualValue: row.actual_value,
      requiredValue: row.required_value,
      explanation: row.explanation
    }))
  };
}

async function attemptProductionPaperTrade({
  session,
  moduleCode,
  setup,
  decision,
  risk,
  current,
  timeframe,
  liveCandles,
  settings,
  brainDecision
}: {
  session: any;
  moduleCode: string;
  setup: any;
  decision: any;
  risk: any;
  current: any;
  timeframe: number;
  liveCandles: LiveCandle[];
  settings: RuntimeSettings;
  brainDecision?: any;
}) {
  if (!setup?.id) return null;
  const existing = await query(
    `SELECT t.id AS trade_id, tp.id AS plan_id, t.outcome
     FROM trade_plans tp
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     WHERE tp.setup_candidate_id = $1
     ORDER BY t.opened_at DESC NULLS LAST, tp.created_at DESC
     LIMIT 1`,
    [setup.id]
  );
  if (existing.rows[0]?.trade_id) return { skipped: true, reason: "PAPER_TRADE_ALREADY_EXISTS", trade: existing.rows[0] };

  const effectiveDecision = {
    ...(decision ?? {}),
    evaluations: decision?.evaluations ?? setup.evaluations ?? [],
    scenarioFlags: decision?.scenarioFlags ?? setup.scenario_flags ?? {},
    entryPrice: decision?.entryPrice ?? setup.entry_price,
    stopPrice: decision?.stopPrice ?? setup.stop_price,
    targetPrice: decision?.targetPrice ?? setup.target_price
  };
  const effectiveRisk = risk ?? await calculateDecisionRisk(session, effectiveDecision, current);
  const productionReady = isProductionReadySetup(setup, effectiveDecision, effectiveRisk);
  const effectiveBrainDecision = brainDecision ?? await runProductionBrainSweep(session.tenant_id, moduleCode);
  const brainApproved = brainApprovesPaperEntry(effectiveBrainDecision, setup);
  await auditBrainPaperEntryGate(session.tenant_id, moduleCode, setup, productionReady, effectiveBrainDecision, brainApproved);
  if (!productionReady) return { skipped: true, reason: "SETUP_NOT_PRODUCTION_READY", riskStatus: effectiveRisk?.status ?? "MISSING" };
  if (!brainApproved) return { skipped: true, reason: "PYTHON_BRAIN_NOT_APPROVED", brainDecision: effectiveBrainDecision };

  await saveSetupCandleSnapshot(setup, session, timeframe, liveCandles, current);
  const alert = entryAlertDetails(moduleCode, setup, null, Number(effectiveRisk?.rewardToRisk ?? 0));
  const paperTrade = settings.paperTradingEnabled
    ? await createAutomaticPaperTrade(session, setup, effectiveRisk, current, moduleCode)
    : { skipped: true, reason: "PAPER_TRADING_DISABLED_BY_SETTINGS" };
  if (paperTrade?.trade || !settings.paperTradingEnabled) {
    await notifyTenantOnce(
      session.tenant_id,
      `${moduleCode}-setup-ready-${setup.id}`,
      moduleCode === "high_probability_strategy_2" ? "MODULE2_SETUP_READY" : "SETUP_READY",
      `${alert.title} signal ready`,
      `${alert.body} | ${setup.final_reason ?? "Valid checklist matched."}`,
      "HIGH",
      alert.data,
      "validEntries"
    );
  }
  return paperTrade;
}

function moduleMandatoryEntryPassed(moduleCode: string, evaluations: any[]) {
  const required = requiredEntryRules(moduleCode);
  const byCode = new Map(evaluations.map((evaluation: any) => [evaluation.ruleCode ?? evaluation.rule_code, evaluation.status]));
  if (moduleCode === "orb_max_options") {
    const closePassed = byCode.get("CLOSE_ABOVE_ORB_HIGH") === "PASS" || byCode.get("CLOSE_BELOW_ORB_LOW") === "PASS";
    return closePassed && required.every((code) => byCode.get(code) === "PASS");
  }
  return required.every((code) => byCode.get(code) === "PASS");
}

function requiredEntryRules(moduleCode: string) {
  if (moduleCode === "orb_max_options") {
    return ["ORB_LOCKED", "INSIDE_SIGNAL_WINDOW", "ENTRY_NOT_OVEREXTENDED", "RISK_PERMISSION"];
  }
  return ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_ENTRY_CANDLE", "VARIANT_SELECTED"];
}

function moduleRuleLayer(moduleCode: string, ruleCode: string) {
  const module1Confirmation = new Set(["BREAKOUT_BODY_RATIO", "CLOSE_LOCATION_RATIO", "FAVORABILITY_SCORE"]);
  const module1Quality = new Set(["NEWS_FILTER"]);
  const module2Mandatory = new Set(requiredEntryRules("high_probability_strategy_2"));
  const module2Confirmations = new Set(["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRM_ENGULFING", "CONFIRM_PIN_BAR", "CONFIRM_INSIDE_BAR_BREAK", "CONFIRM_DOJI_REJECTION", "CONFIRM_VOLUME_EXPANSION", "CONFIRMATION_COUNT"]);
  const module2Quality = new Set(["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT", "EMA_FILTER_MODE", "VOLUME_FILTER_MODE"]);
  if (ruleCode.endsWith("_STATE") || ruleCode === "SCENARIO_SELECTED") return { ruleLayer: "STATE", requiredForEntry: false };
  if (ruleCode === "SIGNAL_SCORE" || ruleCode === "STRICT_CHECKLIST" || ruleCode === "REPLAY_MATCH") return { ruleLayer: "FINAL", requiredForEntry: false };
  if (moduleCode === "orb_max_options") {
    const mandatory = requiredEntryRules(moduleCode);
    const breakoutRule =
      ruleCode === "CLOSE_ABOVE_ORB_HIGH" || ruleCode === "CLOSE_BELOW_ORB_LOW"
        ? true
        : false;
    if (mandatory.includes(ruleCode) || breakoutRule) return { ruleLayer: "MANDATORY", requiredForEntry: true };
    if (module1Confirmation.has(ruleCode)) return { ruleLayer: "CONFIRMATION", requiredForEntry: false };
    if (module1Quality.has(ruleCode)) return { ruleLayer: "QUALITY", requiredForEntry: false };
  }
  if (module2Mandatory.has(ruleCode)) return { ruleLayer: "MANDATORY", requiredForEntry: true };
  if (module2Confirmations.has(ruleCode)) return { ruleLayer: "CONFIRMATION", requiredForEntry: ruleCode === "CONFIRMATION_COUNT" };
  if (module2Quality.has(ruleCode)) return { ruleLayer: "QUALITY", requiredForEntry: ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FILTER_COUNT"].includes(ruleCode) };
  if (ruleCode === "VARIANT_SELECTED") return { ruleLayer: "FINAL", requiredForEntry: true };
  return { ruleLayer: "EVIDENCE", requiredForEntry: false };
}

function withChecklistMetadata(moduleCode: string, decision: any) {
  const evaluations = (decision.evaluations ?? []).map((evaluation: any) => ({
    ...evaluation,
    ...moduleRuleLayer(moduleCode, evaluation.ruleCode ?? evaluation.rule_code)
  }));
  const mandatoryMatched = moduleMandatoryEntryPassed(moduleCode, evaluations);
  const blockingEvaluations = evaluations.filter((evaluation: any) => evaluation.blocking);
  const fullMatched = blockingEvaluations.length > 0 && blockingEvaluations.every((evaluation: any) => evaluation.status === "PASS");
  const currentFlags = decision.scenarioFlags ?? {};
  const fullChecklistMatched = blockingEvaluations.length > 0 ? (currentFlags.fullChecklistMatched ?? fullMatched) : false;
  const setupTier = blockingEvaluations.length > 0 ? (currentFlags.setupTier ?? (fullMatched ? "FULL" : mandatoryMatched ? "MANDATORY" : "WATCH")) : "WATCH";
  return {
    ...decision,
    evaluations,
    scenarioFlags: {
      ...currentFlags,
      mandatoryChecklistMatched: currentFlags.mandatoryChecklistMatched ?? mandatoryMatched,
      fullChecklistMatched,
      setupTier,
      paperTradeEligible: ["LONG SETUP READY", "SHORT SETUP READY"].includes(String(decision.status)) && mandatoryMatched,
      checklistSummary: checklistSummary(moduleCode, evaluations)
    }
  };
}

function checklistSummary(moduleCode: string, evaluations: any[]) {
  const normalized = evaluations.map((evaluation) => ({ ...evaluation, ...moduleRuleLayer(moduleCode, evaluation.ruleCode ?? evaluation.rule_code) }));
  const count = (layer: string) => {
    const rows = normalized.filter((evaluation) => evaluation.ruleLayer === layer);
    return { passed: rows.filter((evaluation) => evaluation.status === "PASS").length, total: rows.length };
  };
  return {
    moduleCode,
    mandatory: count("MANDATORY"),
    confirmations: count("CONFIRMATION"),
    quality: count("QUALITY"),
    final: count("FINAL"),
    requiredEntryRules: requiredEntryRules(moduleCode),
    blockingFailures: normalized.filter((evaluation) => evaluation.blocking && evaluation.status !== "PASS").map((evaluation) => evaluation.ruleCode ?? evaluation.rule_code)
  };
}

async function applyModule2SetupLifecycle(setup: any, decision: any, currentRow: any) {
  if (!setup || setup.module_code !== "high_probability_strategy_2") return null;
  if (setup.scenario_flags?.replay === true || setup.scenario === "QA_TEST_SIGNAL") return null;
  const state = String(decision?.state ?? "");
  const scenario = String(decision?.scenario ?? "");
  const flags = decision?.scenarioFlags ?? {};
  const zone = flags.entryZone as any;
  const direction = decision?.direction;
  let status: string | null = null;
  let eventType: string | null = null;
  let reason: string | null = null;

  if (state === "INVALIDATED" || scenario === "SETUP_INVALIDATED") {
    status = "INVALIDATED";
    eventType = "MODULE2_SETUP_INVALIDATED";
    reason = decision.finalReason ?? "Module 2 setup invalidated before paper entry.";
  } else if (scenario === "SETUP_TIMEOUT" || state === "SETUP_TIMEOUT") {
    status = "EXPIRED";
    eventType = "MODULE2_SETUP_EXPIRED";
    reason = decision.finalReason ?? "Module 2 setup expired before a valid paper entry.";
  } else if (state === "WAITING_FOR_RETRACE" && zone && direction) {
    const close = Number(currentRow.close);
    const high = Number(zone.high);
    const low = Number(zone.low);
    const tooFarFromZone = direction === "LONG" ? close > high + Math.abs(high - low) * 2 : close < low - Math.abs(high - low) * 2;
    if (tooFarFromZone) {
      status = "MISSED";
      eventType = "MODULE2_ENTRY_MISSED";
      reason = "Module 2 entry zone was prepared, but price moved too far away without a retrace.";
    }
  }

  if (!status || !eventType) return null;
  const { rows } = await query(
    "UPDATE setup_candidates SET status = $2, final_reason = $3 WHERE id = $1 AND status NOT IN ('PAPER_TRADE_OPENED','TRADE_PLANNED') RETURNING *",
    [setup.id, status, reason]
  );
  if (!rows[0]) return null;
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, session_id, decision, emotion_after, rule_violations, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,'AUTO','NONE',$5,'A',$6)`,
    [setup.tenant_id, setup.id, setup.session_id, eventType, reason, status]
  );
  await notifyTenantOnce(setup.tenant_id, `${eventType.toLowerCase()}-${setup.id}`, eventType, eventType.replaceAll("_", " "), reason ?? eventType);
  return rows[0];
}

async function notifyModule2Stage(session: any, decision: any) {
  const state = String(decision.state ?? "");
  const direction = decision.direction ? ` ${decision.direction}` : "";
  const stage: Record<string, { type: string; title: string; body: string }> = {
    SWEEP_DETECTED: {
      type: "MODULE2_SWEEP_DETECTED",
      title: "Module 2 liquidity sweep detected",
      body: `${direction.trim() || "Potential"} setup has swept liquidity and is waiting for displacement.`
    },
    DISPLACEMENT_CONFIRMED: {
      type: "MODULE2_DISPLACEMENT_CONFIRMED",
      title: "Module 2 displacement confirmed",
      body: `${direction.trim() || "Potential"} setup has displacement and is waiting for BOS/CHoCH.`
    },
    BOS_CONFIRMED: {
      type: "MODULE2_BOS_CONFIRMED",
      title: "Module 2 BOS/CHoCH confirmed",
      body: `${direction.trim() || "Potential"} setup has structure break and is waiting for a fresh entry zone.`
    },
    ENTRY_ZONE_READY: {
      type: "MODULE2_ENTRY_ZONE_READY",
      title: "Module 2 entry zone ready",
      body: `${direction.trim() || "Potential"} setup has a fresh FVG/order-block zone and is waiting for retrace.`
    },
    WAITING_FOR_RETRACE: {
      type: "MODULE2_WAITING_FOR_RETRACE",
      title: "Module 2 waiting for retrace",
      body: `${direction.trim() || "Potential"} setup is waiting for price to return into the entry zone.`
    },
    ENTRY_CONFIRMATION: {
      type: "MODULE2_ENTRY_CONFIRMATION",
      title: "Module 2 entry-zone touch",
      body: `${direction.trim() || "Potential"} setup is inside the zone and waiting for confirmation candle close.`
    },
    INVALIDATED: {
      type: "MODULE2_INVALIDATED",
      title: "Module 2 setup invalidated",
      body: decision.finalReason ?? "Module 2 setup failed one or more mandatory conditions."
    }
  };
  const payload = stage[state];
  if (!payload) return null;
  return notifyTenantOnce(session.tenant_id, `module2-${state.toLowerCase()}-${session.id}`, payload.type, payload.title, payload.body);
}

async function saveSetupCandleSnapshot(setup: any, session: any, timeframe: number, liveCandles: LiveCandle[], signalRow: any) {
  const cachedRows = cachedCandlesBetween(liveCandles, session.session_start_at, setup.detected_at);
  const fallbackRows =
    cachedRows.length > 0
      ? cachedRows
      : (
          await query(
            `SELECT timestamp_utc, open, high, low, close, volume, spread, source
             FROM candles
             WHERE symbol = $1
               AND timeframe_minutes = $2
               AND timestamp_utc >= $3
               AND timestamp_utc <= $4
             ORDER BY timestamp_utc ASC`,
            [session.symbol, timeframe, session.session_start_at, setup.detected_at]
          )
        ).rows;
  const rows = uniqueCandleRows([...fallbackRows, signalRow]);
  const openingRangeEnd = new Date(session.opening_range_end_at).getTime();
  const signalTime = new Date(setup.detected_at).getTime();
  for (const row of rows) {
    const timestamp = rowTimestamp(row);
    const time = new Date(timestamp).getTime();
    const candleRole = time === signalTime ? "SIGNAL" : time < openingRangeEnd ? "OPENING_RANGE" : "PRE_SIGNAL";
    await query(
      `INSERT INTO setup_candle_snapshots (
        setup_candidate_id, session_id, symbol, timeframe_minutes, timestamp_utc,
        open, high, low, close, volume, spread, source, candle_role
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (setup_candidate_id, timestamp_utc) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        spread = EXCLUDED.spread,
        source = EXCLUDED.source,
        candle_role = EXCLUDED.candle_role,
        captured_at = now()`,
      [
        setup.id,
        session.id,
        session.symbol,
        timeframe,
        timestamp,
        numericParam(row.open, 5),
        numericParam(row.high, 5),
        numericParam(row.low, 5),
        numericParam(row.close, 5),
        numericParam(row.volume, 4),
        numericParam(row.spread, 5),
        row.source ?? "SETUP_SNAPSHOT",
        candleRole
      ]
    );
  }
  return rows.length;
}

async function createAutomaticPaperTrade(session: any, setup: any, risk: any, currentRow: any, moduleCode = "orb_max_options") {
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return null;
  if (risk?.status !== "PERMITTED") {
    return { skipped: true, reason: "RISK_NOT_PERMITTED", riskStatus: risk?.status ?? "MISSING", riskReasons: risk?.reasons ?? [] };
  }
  if (setup.scenario === "QA_TEST_SIGNAL" || setup.scenario_flags?.replay === true) {
    return { skipped: true, reason: "TEST_SIGNAL_NOT_PRODUCTION" };
  }
  const setupTier = String(setup.scenario_flags?.setupTier ?? "FULL");

  const rewardToRisk = Number(risk?.rewardToRisk ?? 0);
  const plannedLot = risk?.suggestedLotSize ?? null;
  const plannedRiskAmount = risk?.plannedRiskAmount ?? null;
  const planResult = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target,
      planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET
      planned_entry = EXCLUDED.planned_entry,
      planned_stop = EXCLUDED.planned_stop,
      planned_target = EXCLUDED.planned_target,
      planned_lot = EXCLUDED.planned_lot,
      planned_risk_amount = EXCLUDED.planned_risk_amount,
      reward_to_risk = EXCLUDED.reward_to_risk,
      status = 'EXECUTED'
    RETURNING *`,
    [
      setup.id,
      numericParam(setup.entry_price, 5),
      numericParam(setup.stop_price, 5),
      numericParam(setup.target_price, 5),
      numericParam(plannedLot, 4),
      numericParam(plannedRiskAmount, 2),
      numericParam(rewardToRisk, 4)
    ]
  );
  const plan = planResult.rows[0] as any;
  const tradeResult = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
      commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,$5,0,$6,0,$7,'ACTIVE')
    RETURNING *`,
    [
      plan.id,
      numericParam(setup.entry_price, 5),
      numericParam(setup.stop_price, 5),
      numericParam(setup.target_price, 5),
      numericParam(plannedLot, 4),
      numericParam(currentRow.spread ?? 0, 5),
      currentRow.timestamp_utc ?? new Date().toISOString()
    ]
  );
  const trade = tradeResult.rows[0] as any;
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1", [setup.id]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'PAPER_ENTRY',$2)", [
    trade.id,
    {
      mode: "PAPER",
      moduleCode,
      setupTier,
      scenario: setup.scenario,
      direction: setup.direction,
      rewardToRisk,
      finalReason: setup.final_reason
    }
  ]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, emotion_before,
      rule_violations, lesson, process_grade, outcome
    ) VALUES ($5,$1,$2,$3,'PAPER_TRADE_OPENED','AUTO','NONE',$4,'A','PAPER_ACTIVE')`,
    [setup.id, trade.id, session.id, `Automatic paper ${setup.direction} opened from ${setup.scenario}. ${setup.final_reason ?? ""}`.trim(), session.tenant_id]
  );
  const alert = entryAlertDetails(moduleCode, setup, trade, rewardToRisk);
  await notifyTenantOnce(
    session.tenant_id,
    `paper-entry-${trade.id}`,
    "PAPER_TRADE_OPENED",
    alert.title,
    alert.body,
    "HIGH",
    alert.data,
    "paperTradeOpened"
  );
  return { trade, plan };
}

async function processOpenPaperTrades(symbol: string, timeframe: number, latestRow: any, tenantId?: string | null, moduleCode = "orb_max_options") {
  const latest = toCandle(latestRow);
  const activeTenantId = tenantId ?? (await defaultTenantId());
  const openTrades = await query(
    `SELECT t.*, tp.id AS trade_plan_id, tp.setup_candidate_id, sc.session_id, sc.tenant_id, sc.symbol, sc.direction, sc.scenario, sc.module_code
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.symbol = $1
       AND sc.tenant_id = $3
       AND sc.module_code = $4
       AND t.outcome = 'ACTIVE'
       AND t.opened_at IS NOT NULL
       AND t.opened_at <= $2
     ORDER BY t.opened_at ASC`,
    [symbol, latest.timestampUtc, activeTenantId, moduleCode]
  );
  const closed = [];
  for (const trade of openTrades.rows as any[]) {
    const exit = resolvePaperExit(trade, latest);
    if (!exit) continue;
    const entry = Number(trade.actual_entry);
    const stop = Number(trade.actual_stop);
    const stopDistance = Math.abs(entry - stop);
    const directionMultiplier = trade.direction === "SHORT" ? -1 : 1;
    const resultR = stopDistance > 0 ? ((exit.price - entry) * directionMultiplier) / stopDistance : 0;
    const outcome = exit.reason === "TARGET" ? "WIN" : exit.reason === "STOP" ? "LOSS" : resultR > 0 ? "WIN" : resultR < 0 ? "LOSS" : "BREAKEVEN";
    const updated = await query(
      `UPDATE trades SET
        actual_exit = $2,
        result_r = $3,
        outcome = $4,
        closed_at = $5
       WHERE id = $1
       RETURNING *`,
      [trade.id, exit.price, resultR, outcome, latest.timestampUtc]
    );
    await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.trade_plan_id]);
    await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'PAPER_EXIT',$2)", [
      trade.id,
      { mode: "PAPER", exitReason: exit.reason, ambiguous: exit.ambiguous, candle: latest, timeframeMinutes: timeframe }
    ]);
    await query(
      `INSERT INTO journal_entries (
        tenant_id, setup_candidate_id, trade_id, session_id, decision, emotion_after,
        rule_violations, lesson, process_grade, outcome
      ) VALUES ($6,$1,$2,$3,'PAPER_TRADE_CLOSED','AUTO','NONE',$4,'A',$5)`,
      [
        trade.setup_candidate_id,
        trade.id,
        trade.session_id,
        `Automatic paper trade closed by ${exit.reason}${exit.ambiguous ? " on ambiguous TP/SL candle, stop-first rule used" : ""}. Result ${resultR.toFixed(2)}R.`,
        outcome,
        trade.tenant_id
      ]
    );
    await notifyTenantOnce(
      trade.tenant_id,
      `paper-exit-${trade.id}`,
      "PAPER_TRADE_CLOSED",
      `Paper trade closed: ${outcome}`,
      `${exit.reason} at ${exit.price}. Result ${resultR.toFixed(2)}R.`
    );
    closed.push(updated.rows[0]);
  }
  return { checked: openTrades.rows.length, closed };
}

function resolvePaperExit(trade: any, candle: Candle) {
  const direction = trade.direction;
  const stop = Number(trade.actual_stop);
  const target = Number(trade.actual_target);
  if (direction === "LONG") {
    const stopHit = candle.low <= stop;
    const targetHit = candle.high >= target;
    if (stopHit && targetHit) return { reason: "STOP", price: stop, ambiguous: true };
    if (stopHit) return { reason: "STOP", price: stop, ambiguous: false };
    if (targetHit) return { reason: "TARGET", price: target, ambiguous: false };
  }
  if (direction === "SHORT") {
    const stopHit = candle.high >= stop;
    const targetHit = candle.low <= target;
    if (stopHit && targetHit) return { reason: "STOP", price: stop, ambiguous: true };
    if (stopHit) return { reason: "STOP", price: stop, ambiguous: false };
    if (targetHit) return { reason: "TARGET", price: target, ambiguous: false };
  }
  return null;
}

async function getOpeningRange(sessionId: string) {
  const result = await query("SELECT * FROM opening_ranges WHERE session_id = $1", [sessionId]);
  return result.rows[0] as any | undefined;
}

async function lockOpeningRangeForSession(session: any) {
  const timeframe = ORB_RANGE_TIMEFRAME_MINUTES;
  const candlesResult = await query(
    `SELECT timestamp_utc, open, high, low, close, volume, spread
     FROM candles
     WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc < $4
     ORDER BY timestamp_utc`,
    [session.symbol, timeframe, session.session_start_at, session.opening_range_end_at]
  );
  const candles: Candle[] = candlesResult.rows.map((row: any) => ({
    timestampUtc: row.timestamp_utc ?? row.timestampUtc,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume == null ? null : Number(row.volume),
    spread: row.spread == null ? null : Number(row.spread)
  }));
  const range = buildOpeningRange(candles.slice(0, ORB_RANGE_SOURCE_CANDLES), 0.01, ORB_RANGE_SOURCE_CANDLES);
  const { rows } = await query(
    `INSERT INTO opening_ranges (
      session_id, status, high, low, midpoint, width, width_ticks, width_atr_percent,
      source_candle_count, data_quality_status, invalid_reason, locked_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (session_id) DO UPDATE SET
      status = EXCLUDED.status,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      midpoint = EXCLUDED.midpoint,
      width = EXCLUDED.width,
      width_ticks = EXCLUDED.width_ticks,
      width_atr_percent = EXCLUDED.width_atr_percent,
      source_candle_count = EXCLUDED.source_candle_count,
      data_quality_status = EXCLUDED.data_quality_status,
      invalid_reason = EXCLUDED.invalid_reason,
      locked_at = EXCLUDED.locked_at
    RETURNING *`,
    [
      session.id,
      range.status,
      numericParam(range.high, 5),
      numericParam(range.low, 5),
      numericParam(range.midpoint, 5),
      numericParam(range.width, 5),
      numericParam(range.widthTicks, 4),
      numericParam(range.widthAtrPercent, 4),
      range.sourceCandleCount,
      range.dataQualityStatus,
      range.invalidReason ?? null,
      range.lockedAt ?? null
    ]
  );
  await query("UPDATE trading_sessions SET state = $2, data_status = $3 WHERE id = $1", [
    session.id,
    range.status === "LOCKED" ? "WAITING_FOR_SETUP" : "NO_TRADE",
    range.dataQualityStatus
  ]);
  return rows[0] as any;
}

async function repairOpeningRangeIfNeeded(session: any, savedRange: any) {
  const recalculated = await calculateCanonicalOrbRange(session);
  if (recalculated.status !== "LOCKED") return savedRange;
  const same =
    nearlyEqual(savedRange.high, recalculated.high) &&
    nearlyEqual(savedRange.low, recalculated.low) &&
    nearlyEqual(savedRange.midpoint, recalculated.midpoint) &&
    Number(savedRange.source_candle_count ?? 0) === ORB_RANGE_SOURCE_CANDLES;
  if (same) return savedRange;
  return lockOpeningRangeForSession(session);
}

async function calculateCanonicalOrbRange(session: any) {
  const timeframe = ORB_RANGE_TIMEFRAME_MINUTES;
  const rows = (
    await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc < $4
       ORDER BY timestamp_utc ASC`,
      [session.symbol, timeframe, session.session_start_at, session.opening_range_end_at]
    )
  ).rows;
  const candles: Candle[] = rows.slice(0, ORB_RANGE_SOURCE_CANDLES).map((row: any) => ({
    timestampUtc: row.timestamp_utc ?? row.timestampUtc,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume == null ? null : Number(row.volume),
    spread: row.spread == null ? null : Number(row.spread)
  }));
  return buildOpeningRange(candles, 0.01, ORB_RANGE_SOURCE_CANDLES);
}

function nearlyEqual(left: unknown, right: unknown, tolerance = 0.00001) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

async function evaluateAndSaveSetup(session: any, range: any, currentRow: any, previousRows: any[]) {
  const profile = await query(
    `SELECT rp.*
     FROM risk_profiles rp
     WHERE rp.is_active = true
       AND rp.tenant_id = $1
     ORDER BY rp.created_at DESC
     LIMIT 1`,
    [session.tenant_id]
  );
  const row = profile.rows[0] as any;
  const currentCandle = toCandle(currentRow);
  const openingRange = {
    status: range.status,
    high: Number(range.high),
    low: Number(range.low),
    midpoint: Number(range.midpoint),
    width: Number(range.width),
    widthTicks: Number(range.width_ticks),
    sourceCandleCount: Number(range.source_candle_count ?? 0),
    dataQualityStatus: range.data_quality_status
  };
  const stop = currentCandle.close > openingRange.high ? openingRange.low : openingRange.high;
  const entry = currentCandle.close;
  const target = entry > Number(stop) ? entry + Math.abs(entry - Number(stop)) * 2 : entry - Math.abs(entry - Number(stop)) * 2;
  const initialRisk = calculateRisk({
    accountBalance: Number(row.account_balance),
    accountEquity: Number(row.account_equity),
    riskPerTradePercent: Number(row.risk_per_trade_percent),
    entry,
    stop: Number(stop),
    target,
    contractSize: XAUUSD_PAPER_SPEC.contractSize,
    tickSize: XAUUSD_PAPER_SPEC.tickSize,
    tickValue: XAUUSD_PAPER_SPEC.tickValue,
    minimumLot: XAUUSD_PAPER_SPEC.minimumLot,
    lotStep: XAUUSD_PAPER_SPEC.lotStep,
    maximumLot: XAUUSD_PAPER_SPEC.maximumLot,
    spread: Number(currentCandle.spread ?? 0),
    commissionPerLot: XAUUSD_PAPER_SPEC.commissionPerLot,
    minimumRewardToRisk: Number(row.minimum_reward_to_risk),
    maximumDailyLossPercent: Number(row.maximum_daily_loss_percent),
    maximumWeeklyLossPercent: Number(row.maximum_weekly_loss_percent)
  });
  const configuration = await getTenantOrbStrategyConfiguration(session.tenant_id, session.configuration_json);
  const ruleContext: RuleContext = {
    now: currentCandle.timestampUtc,
    symbol: session.symbol,
    strategyVersionId: session.strategy_version_id,
    session: {
      id: session.id,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      sessionDate: session.session_date,
      sessionPreset: session.session_preset,
      state: session.state,
      sessionStartAt: session.session_start_at,
      openingRangeEndAt: session.opening_range_end_at,
      signalWindowEndAt: session.signal_window_end_at,
      dataStatus: session.data_status
    },
    openingRange,
    currentCandle,
    previousCandles: previousRows.map(toCandle),
    spread: currentCandle.spread ?? undefined,
    newsStatus: "CLEAR",
    riskStatus: initialRisk.status,
    configuration: configuration as any
  };
  let decision = withChecklistMetadata("orb_max_options", evaluateSetup(ruleContext));
  let risk = (await calculateDecisionRisk(session, decision, currentRow)) ?? initialRisk;
  if (risk.status !== initialRisk.status) {
    decision = withChecklistMetadata("orb_max_options", evaluateSetup({ ...ruleContext, riskStatus: risk.status }));
    risk = (await calculateDecisionRisk(session, decision, currentRow)) ?? risk;
  }
	  const saved = await query(
	    `INSERT INTO setup_candidates (
	      tenant_id, module_code, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
	      expires_at, entry_price, stop_price, target_price, final_reason,
	      favorability_score, favorability_grade, favorability_reasons, scenario_flags
	    ) VALUES ($17,'orb_max_options',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      session.id,
      session.strategy_version_id,
      session.symbol,
      decision.scenario,
      decision.direction,
      decision.status,
      currentCandle.timestampUtc,
      session.signal_window_end_at,
      numericParam(decision.entryPrice, 5),
      numericParam(decision.stopPrice, 5),
      numericParam(decision.targetPrice, 5),
      decision.finalReason,
      decision.favorabilityScore,
      decision.favorabilityGrade,
      JSON.stringify(decision.favorabilityReasons),
      JSON.stringify(decision.scenarioFlags),
      session.tenant_id
    ]
  );
  for (const evaluation of decision.evaluations) {
    await query(
      `INSERT INTO setup_rule_evaluations (
        setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        saved.rows[0].id,
        evaluation.ruleCode,
        evaluation.name,
        evaluation.status,
        evaluation.blocking,
        evaluation.source,
        evaluation.actualValue == null ? null : String(evaluation.actualValue),
        evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
        evaluation.explanation
      ]
    );
  }
  await query("INSERT INTO risk_events (setup_candidate_id, status, reasons, calculation) VALUES ($1,$2,$3,$4)", [
    saved.rows[0].id,
    risk.status,
    JSON.stringify(risk.reasons),
    JSON.stringify(risk)
  ]);
  await query("UPDATE strategy_versions SET generated_signal_count = generated_signal_count + 1 WHERE id = $1", [session.strategy_version_id]);
  return { setup: saved.rows[0], decision, risk };
}

async function saveModuleDecision(session: any, moduleCode: string, decision: any, currentRow: any) {
  decision = withChecklistMetadata(moduleCode, decision);
  const risk = await calculateDecisionRisk(session, decision, currentRow);
  const saved = await query(
    `INSERT INTO setup_candidates (
      tenant_id, module_code, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
      expires_at, entry_price, stop_price, target_price, final_reason,
      favorability_score, favorability_grade, favorability_reasons, scenario_flags
    ) VALUES ($18,$17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      session.id,
      session.strategy_version_id,
      session.symbol,
      decision.scenario,
      decision.direction,
      decision.status,
      currentRow.timestamp_utc,
      session.signal_window_end_at,
      numericParam(decision.entryPrice, 5),
      numericParam(decision.stopPrice, 5),
      numericParam(decision.targetPrice, 5),
      decision.finalReason,
      decision.favorabilityScore,
      decision.favorabilityGrade,
      JSON.stringify(decision.favorabilityReasons ?? []),
      JSON.stringify(decision.scenarioFlags ?? {}),
      moduleCode,
      session.tenant_id
    ]
  );
  for (const evaluation of decision.evaluations ?? []) {
    await query(
      `INSERT INTO setup_rule_evaluations (
        setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        saved.rows[0].id,
        evaluation.ruleCode,
        evaluation.name,
        evaluation.status,
        evaluation.blocking,
        evaluation.source,
        evaluation.actualValue == null ? null : String(evaluation.actualValue),
        evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
        evaluation.explanation
      ]
    );
  }
  if (risk) {
    await query("INSERT INTO risk_events (setup_candidate_id, status, reasons, calculation) VALUES ($1,$2,$3,$4)", [
      saved.rows[0].id,
      risk.status,
      JSON.stringify(risk.reasons),
      JSON.stringify(risk)
    ]);
  }
  if (moduleCode === "high_probability_strategy_2") {
    await persistModule2StateTransitions(saved.rows[0], decision);
  }
  await query("UPDATE strategy_versions SET generated_signal_count = generated_signal_count + 1 WHERE id = $1", [session.strategy_version_id]);
  return { setup: saved.rows[0], decision, risk };
}

async function persistModule2StateTransitions(setup: any, decision: any) {
  const transitions = Array.isArray(decision?.scenarioFlags?.stateMachine?.transitions)
    ? decision.scenarioFlags.stateMachine.transitions
    : [];
  if (!setup?.id || transitions.length === 0) return;
  const variantCode = decision?.scenarioFlags?.module2Variant?.code ?? decision?.scenarioFlags?.variantCode ?? null;
  for (const transition of transitions) {
    const toState = transition?.to;
    const occurredAt = transition?.at;
    if (!toState || !occurredAt) continue;
    await query(
      `INSERT INTO module2_state_transitions (
        tenant_id, setup_candidate_id, session_id, module_code, variant_code,
        from_state, to_state, reason, occurred_at
      ) VALUES ($1,$2,$3,'high_probability_strategy_2',$4,$5,$6,$7,$8)
      ON CONFLICT (setup_candidate_id, to_state, occurred_at) DO UPDATE SET
        variant_code = EXCLUDED.variant_code,
        reason = EXCLUDED.reason`,
      [
        setup.tenant_id,
        setup.id,
        setup.session_id,
        variantCode,
        transition.from ?? null,
        toState,
        transition.reason ?? null,
        occurredAt
      ]
    );
  }
}

async function calculateDecisionRisk(session: any, decision: any, currentRow: any) {
  if (decision.entryPrice == null || decision.stopPrice == null || decision.targetPrice == null) return null;
  const profile = await query(
    `SELECT rp.*
     FROM risk_profiles rp
     WHERE rp.is_active = true
       AND rp.tenant_id = $1
     ORDER BY rp.created_at DESC
     LIMIT 1`,
    [session.tenant_id]
  );
  const row = profile.rows[0] as any;
  if (!row) return null;
  return calculateRisk({
    accountBalance: Number(row.account_balance),
    accountEquity: Number(row.account_equity),
    riskPerTradePercent: Number(row.risk_per_trade_percent),
    entry: Number(decision.entryPrice),
    stop: Number(decision.stopPrice),
    target: Number(decision.targetPrice),
    contractSize: XAUUSD_PAPER_SPEC.contractSize,
    tickSize: XAUUSD_PAPER_SPEC.tickSize,
    tickValue: XAUUSD_PAPER_SPEC.tickValue,
    minimumLot: XAUUSD_PAPER_SPEC.minimumLot,
    lotStep: XAUUSD_PAPER_SPEC.lotStep,
    maximumLot: XAUUSD_PAPER_SPEC.maximumLot,
    spread: Number(currentRow.spread ?? 0),
    commissionPerLot: XAUUSD_PAPER_SPEC.commissionPerLot,
    minimumRewardToRisk: Number(row.minimum_reward_to_risk),
    maximumDailyLossPercent: Number(row.maximum_daily_loss_percent),
    maximumWeeklyLossPercent: Number(row.maximum_weekly_loss_percent)
  });
}

async function tradesTakenForSession(sessionId: string, moduleCode: string, setupTier?: string | null) {
  const params: any[] = [sessionId, moduleCode];
  const tierFilter = setupTier
    ? `AND COALESCE(sc.scenario_flags->>'setupTier', 'FULL') = $${params.push(setupTier)}`
    : "";
  const { rows } = await query(
    `SELECT count(*)::int AS count
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.session_id = $1
       AND sc.module_code = $2
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       ${tierFilter}`,
    params
  );
  return Number(rows[0]?.count ?? 0);
}

function toCandle(row: any): Candle {
  return {
    timestampUtc: rowTimestamp(row),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume == null ? null : Number(row.volume),
    spread: row.spread == null ? null : Number(row.spread)
  };
}

function rowTimestamp(row: any) {
  return row.timestamp_utc ?? row.timestampUtc ?? row.timestamp;
}

function uniqueCandleRows(rows: any[]) {
  const byTime = new Map<string, any>();
  for (const row of rows) {
    const timestamp = rowTimestamp(row);
    if (!timestamp) continue;
    byTime.set(new Date(timestamp).toISOString(), row);
  }
  return [...byTime.entries()]
    .sort((left, right) => new Date(left[0]).getTime() - new Date(right[0]).getTime())
    .map(([, row]) => row);
}

function numericParam(value: unknown, decimals: number) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(decimals));
}

async function notifyOnce(eventKey: string, eventType: string, title: string, body: string) {
  const tenantId = await defaultTenantId();
  return notifyTenantOnce(tenantId, eventKey, eventType, title, body);
}

async function notifyTenantOnce(
  tenantId: string | null,
  eventKey: string,
  eventType: string,
  title: string,
  body: string,
  priority = "NORMAL",
  data: Record<string, unknown> = {},
  preferenceKey?: "nyPreSession" | "validEntries" | "paperTradeOpened" | "takeProfitStopLoss" | "dailyReports" | "weeklyMonthlyReports" | "learningReviews" | "systemDiagnostics"
) {
  if (!(await canCreateTenantNotification(tenantId, priority))) return { skipped: true, reason: "NOTIFICATION_PLAN_LIMIT" };
  const notificationData = { ...data, eventKey, eventType };
  const inserted = await query(
    `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority, data)
     VALUES ($5,$1,$2,$3,$4,$6,$7::jsonb)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [eventKey, eventType, title, body, tenantId, priority, JSON.stringify(notificationData)]
  );
  if (inserted.rows[0]) {
    await sendTenantPush({ tenantId, title, body, eventKey, eventType, preferenceKey, data: { ...notificationData, notificationId: inserted.rows[0].id } });
  }
}

function entryAlertDetails(moduleCode: string, setup: any, trade: any, rewardToRisk: number) {
  const direction = setup.direction === "SHORT" ? "SHORT" : "LONG";
  const action = direction === "LONG" ? "BUY" : "SELL";
  const entry = formatPrice(trade?.actual_entry ?? setup.entry_price);
  const stopLoss = formatPrice(trade?.actual_stop ?? setup.stop_price);
  const takeProfit = formatPrice(trade?.actual_target ?? setup.target_price);
  const moduleName = moduleDisplayName(moduleCode);
  const scenario = String(setup.scenario ?? "VALID_SETUP");
  const setupTier = String(setup.scenario_flags?.setupTier ?? "FULL");
  const variant = setup.scenario_flags?.module2Variant ?? null;
  const variantLabel = variant?.name ?? setup.scenario_flags?.variantCode ?? null;
  const variantMiss = Array.isArray(setup.scenario_flags?.module2Variants)
    ? setup.scenario_flags.module2Variants.find((item: any) => Array.isArray(item.missingRules) && item.missingRules.length > 0)
    : null;
  const grade = setup.favorability_grade ?? setup.scenario_flags?.tradeGrade ?? setup.scenario_flags?.grade ?? null;
  const confidence = setup.favorability_score ?? setup.scenario_flags?.confidence ?? null;
  const rr = Number.isFinite(rewardToRisk) ? rewardToRisk.toFixed(2) : "--";
  const title = `${moduleName}: ${setupTier === "MANDATORY" ? "Core" : "Full"} ${action} ${direction}`;
  const bodyParts = [
    setupTier === "MANDATORY" ? "Mandatory setup" : "Full checklist setup",
    variantLabel ? `Variant ${variantLabel}` : null,
    `${scenario}`,
    `Entry ${entry}`,
    `SL ${stopLoss}`,
    `TP ${takeProfit}`,
    `RR ${rr}`,
    grade ? `Grade ${grade}` : null,
    confidence != null ? `Confidence ${confidence}%` : null
  ].filter(Boolean);
  return {
    title,
    body: bodyParts.join(" | "),
    data: {
      moduleCode,
      moduleName,
      setupTier,
      variantCode: variant?.code ?? setup.scenario_flags?.variantCode ?? null,
      variantName: variant?.name ?? null,
      variantVersion: variant?.version ?? setup.scenario_flags?.variantVersion ?? null,
      scenario,
      direction,
      action,
      entry,
      stopLoss,
      takeProfit,
      rewardToRisk: rr,
      grade,
      confidence,
      setupCandidateId: setup.id,
      tradeId: trade?.id ?? null,
      symbol: setup.symbol ?? "XAUUSD",
      finalReason: setup.final_reason ?? null,
      status: setup.status ?? null,
      mandatoryPassed: setup.scenario_flags?.mandatoryPassed ?? null,
      confirmationPassed: setup.scenario_flags?.confirmationPassed ?? null,
      qualityPassed: setup.scenario_flags?.qualityPassed ?? null,
      missingRules: variantMiss?.missingRules ?? [],
      liquidity: setup.scenario_flags?.sweep?.level ?? null,
      displacement: setup.scenario_flags?.displacement ? {
        rangeAtr: setup.scenario_flags.displacement.rangeAtr ?? null,
        bodyRatio: setup.scenario_flags.displacement.bodyRatio ?? null,
        at: setup.scenario_flags.displacement.candle?.timestampUtc ?? null
      } : null,
      bos: setup.scenario_flags?.bos ? {
        level: setup.scenario_flags.bos.level ?? null,
        at: setup.scenario_flags.bos.candle?.timestampUtc ?? null
      } : null,
      entryZone: setup.scenario_flags?.entryZone ?? null
    }
  };
}

function formatPrice(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "--";
}

async function activeAutomationModules() {
  const { rows } = await query(
    `SELECT DISTINCT
       t.id,
       t.name,
       t.slug,
       t.created_at,
       m.code AS module_code,
       m.name AS module_name,
       m.sort_order AS module_sort_order,
       COALESCE(tas.enabled, true) AS automation_enabled
     FROM platform_tenants t
     JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
     JOIN platform_strategy_modules m ON m.id = tm.module_id AND m.status = 'ACTIVE'
     LEFT JOIN LATERAL (
       SELECT s.status, p.automation_included
       FROM tenant_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.tenant_id = t.id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) s ON true
     LEFT JOIN tenant_automation_states tas ON tas.tenant_id = t.id AND tas.module_code = m.code
     WHERE t.status = 'ACTIVE'
       AND COALESCE(s.status, 'ACTIVE') IN ('TRIAL', 'ACTIVE')
       AND COALESCE(s.automation_included, true) = true
       AND COALESCE(tas.enabled, true) = true
       AND m.code IN ('orb_max_options', 'high_probability_strategy_2')
     ORDER BY t.created_at, m.sort_order`
  );
  return rows;
}

function tenantStateKey(tenantId: string, moduleCode: string) {
  return `${tenantId}:${moduleCode}`;
}

function moduleDisplayName(moduleCode: string) {
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Liquidity Sweep + BOS";
  return "Module 1 ORB MAX";
}

function moduleTimeframeMinutes(moduleCode: string, settings: RuntimeSettings) {
  return moduleCode === "high_probability_strategy_2" ? 5 : settings.timeframeMinutes;
}

async function activeStrategyVersionForModule(moduleCode: string) {
  const { rows } = await query(
    `WITH module_match AS (
       SELECT sv.*, 0 AS rank
       FROM strategy_versions sv
       JOIN strategies s ON s.id = sv.strategy_id
       JOIN strategy_sources src ON src.id = s.source_id
       WHERE sv.status = 'ACTIVE'
         AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = $1
     ),
     selected_match AS (
       SELECT sv.*, 1 AS rank
       FROM strategy_versions sv
       WHERE sv.status = 'ACTIVE'
         AND sv.id = (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1)
     ),
     latest_match AS (
       SELECT sv.*, 2 AS rank
       FROM strategy_versions sv
       WHERE sv.status = 'ACTIVE'
     )
     SELECT *
     FROM (
       SELECT * FROM module_match
       UNION ALL
       SELECT * FROM selected_match
       UNION ALL
       SELECT * FROM latest_match
     ) candidates
     ORDER BY rank, activated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [moduleCode]
  );
  return rows[0] as any | undefined;
}

function tenantStateFor(tenant: any, settings: RuntimeSettings): TenantAutoRunState {
  const moduleCode = tenant.module_code ?? tenant.moduleCode ?? "orb_max_options";
  const existing = tenantAutomationStates.get(tenantStateKey(tenant.id, moduleCode));
  if (existing) return existing;
  const state: TenantAutoRunState = {
    ...autoRunState,
    tenantId: tenant.id,
    tenantName: tenant.name,
    moduleCode,
    moduleName: tenant.module_name ?? moduleDisplayName(moduleCode),
    enabled: true,
    running: false,
    phase: "STARTING",
    symbol: settings.symbol,
    timeframeMinutes: moduleTimeframeMinutes(moduleCode, settings),
    provider: "TWELVE_DATA",
    latestCandleAt: null,
    latestSetupId: null,
    latestTradeId: null,
    reason: "Subscriber automation is ready."
  };
  tenantAutomationStates.set(tenantStateKey(tenant.id, moduleCode), state);
  return state;
}

async function loadTenantAutomationState(tenantId: string, moduleCode = "orb_max_options"): Promise<TenantAutoRunState> {
  const settings = await getRuntimeSettings(tenantId);
  const tenant = await query(
    `SELECT t.id, t.name, t.slug, m.code AS module_code, m.name AS module_name
     FROM platform_tenants t
     LEFT JOIN platform_strategy_modules m ON m.code = $2
     WHERE t.id = $1`,
    [tenantId, moduleCode]
  );
  const state = tenantStateFor(tenant.rows[0] ?? { id: tenantId, name: "Subscriber", slug: tenantId, module_code: moduleCode, module_name: moduleDisplayName(moduleCode) }, settings);
  const saved = await query("SELECT * FROM tenant_automation_states WHERE tenant_id = $1 AND module_code = $2", [tenantId, moduleCode]);
  const row = saved.rows[0] as any;
  if (row) {
    state.enabled = row.enabled;
    state.running = row.running;
    state.phase = row.phase;
    state.symbol = row.symbol;
    state.timeframeMinutes = Number(row.timeframe_minutes);
    state.latestCandleAt = row.latest_candle_at;
    state.latestSetupId = row.latest_setup_id;
    state.latestTradeId = row.latest_trade_id;
    state.lastError = row.latest_error;
    state.reason = row.latest_reason ?? state.reason;
    state.sessionId = row.session_id;
    state.sessionState = row.session_state;
    state.sessionStartAt = row.session_start_at;
    state.openingRangeEndAt = row.opening_range_end_at;
    state.signalWindowEndAt = row.signal_window_end_at;
    state.apiStartAt = row.api_start_at;
    state.apiStopAt = row.api_stop_at;
    state.nextActionAt = row.next_action_at;
    state.lastCheckedAt = row.last_checked_at;
    state.lastActionAt = row.last_action_at;
  }
  return state;
}

async function persistTenantAutomationState(state: TenantAutoRunState) {
  await query(
    `INSERT INTO tenant_automation_states (
      tenant_id, module_code, enabled, running, phase, symbol, timeframe_minutes, provider,
      latest_candle_at, latest_setup_id, latest_trade_id, latest_error, latest_reason,
      session_id, session_state, session_start_at, opening_range_end_at, signal_window_end_at,
      api_start_at, api_stop_at, next_action_at, last_checked_at, last_action_at, updated_at
    ) VALUES (
      $1,$23,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,now()
    )
    ON CONFLICT (tenant_id, module_code) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      running = EXCLUDED.running,
      phase = EXCLUDED.phase,
      symbol = EXCLUDED.symbol,
      timeframe_minutes = EXCLUDED.timeframe_minutes,
      provider = EXCLUDED.provider,
      latest_candle_at = EXCLUDED.latest_candle_at,
      latest_setup_id = EXCLUDED.latest_setup_id,
      latest_trade_id = EXCLUDED.latest_trade_id,
      latest_error = EXCLUDED.latest_error,
      latest_reason = EXCLUDED.latest_reason,
      session_id = EXCLUDED.session_id,
      session_state = EXCLUDED.session_state,
      session_start_at = EXCLUDED.session_start_at,
      opening_range_end_at = EXCLUDED.opening_range_end_at,
      signal_window_end_at = EXCLUDED.signal_window_end_at,
      api_start_at = EXCLUDED.api_start_at,
      api_stop_at = EXCLUDED.api_stop_at,
      next_action_at = EXCLUDED.next_action_at,
      last_checked_at = EXCLUDED.last_checked_at,
      last_action_at = EXCLUDED.last_action_at,
      updated_at = now()`,
    [
      state.tenantId,
      state.enabled,
      state.running,
      state.phase,
      state.symbol,
      state.timeframeMinutes,
      state.provider,
      state.latestCandleAt,
      state.latestSetupId,
      state.latestTradeId,
      state.lastError,
      state.reason,
      state.sessionId,
      state.sessionState,
      state.sessionStartAt,
      state.openingRangeEndAt,
      state.signalWindowEndAt,
      state.apiStartAt,
      state.apiStopAt,
      state.nextActionAt,
      state.lastCheckedAt,
      state.lastActionAt,
      state.moduleCode
    ]
  );
}

async function platformAutomationStatusRows() {
  const { rows } = await query(
    `SELECT
       t.id AS tenant_id,
       t.name AS tenant_name,
       t.slug,
       tas.module_code,
       m.name AS module_name,
       tas.enabled,
       tas.running,
       tas.phase,
       tas.symbol,
       tas.timeframe_minutes,
       tas.latest_candle_at,
       tas.latest_setup_id,
       tas.latest_trade_id,
       tas.latest_error,
       tas.latest_reason,
       tas.session_state,
       tas.session_start_at,
       tas.api_start_at,
       tas.api_stop_at,
       tas.updated_at
     FROM platform_tenants t
     LEFT JOIN tenant_automation_states tas ON tas.tenant_id = t.id
     LEFT JOIN platform_strategy_modules m ON m.code = tas.module_code
     ORDER BY t.created_at DESC, m.sort_order`
  );
  return rows;
}

async function recordTwelveDataUsage(input: {
  symbol: string;
  timeframeMinutes: number;
  requestedCount: number;
  importedCount: number;
  tenantIds: string[];
  status: "OK" | "ERROR";
  error: string | null;
  triggerSource: string;
  usageReason: string;
  forced: boolean;
}) {
  await query(
    `INSERT INTO api_usage_events (
      provider, endpoint, symbol, timeframe_minutes, requested_count, imported_count,
      credits_used, tenant_count, tenant_ids, status, error, trigger_source, usage_reason, forced
    ) VALUES ('TWELVE_DATA','time_series',$1,$2,$3,$4,1,$5,$6::uuid[],$7,$8,$9,$10,$11)`,
    [
      input.symbol,
      input.timeframeMinutes,
      input.requestedCount,
      input.importedCount,
      Math.max(input.tenantIds.length, 1),
      input.tenantIds,
      input.status,
      input.error,
      input.triggerSource,
      input.usageReason,
      input.forced
    ]
  );
  await recordOperationalEvent({
    severity: input.status === "ERROR" ? "ERROR" : input.forced ? "WARN" : "INFO",
    category: "TWELVE_DATA",
    eventType: input.status === "ERROR" ? "TWELVE_DATA_CALL_ERROR" : "TWELVE_DATA_CALL_OK",
    source: input.triggerSource,
    message: `${input.triggerSource} used 1 Twelve Data credit for ${input.symbol} ${input.timeframeMinutes}m.`,
    metadata: {
      symbol: input.symbol,
      timeframeMinutes: input.timeframeMinutes,
      requestedCount: input.requestedCount,
      importedCount: input.importedCount,
      tenantCount: input.tenantIds.length,
      usageReason: input.usageReason,
      forced: input.forced,
      error: input.error
    }
  });
}

async function tryTwelveDataCallLock() {
  const { rows } = await query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1)::boolean AS locked", [TWELVE_DATA_CALL_LOCK_ID]);
  return Boolean(rows[0]?.locked);
}

async function releaseTwelveDataCallLock() {
  await query("SELECT pg_advisory_unlock($1)", [TWELVE_DATA_CALL_LOCK_ID]).catch(() => undefined);
}

async function twelveDataCreditGuardrail() {
  const summary = await twelveDataUsageSummary();
  const dailyUsed = summary.creditsUsedToday;
  const minuteUsed = summary.creditsUsedLastMinute;
  const dailyLimit = config.twelveDataDailyCreditLimit;
  const minuteLimit = config.twelveDataMinuteCreditLimit;
  if (dailyUsed >= config.twelveDataStopCredits) {
    return {
      allowed: false,
      status: "STOP",
      reason: "TWELVE_DATA_DAILY_STOP",
      message: `Twelve Data stopped at ${dailyUsed}/${dailyLimit} credits to protect the daily limit.`,
      dailyUsed,
      dailyLimit,
      minuteUsed,
      minuteLimit
    };
  }
  if (minuteUsed >= minuteLimit) {
    return {
      allowed: false,
      status: "MINUTE_LIMIT",
      reason: "TWELVE_DATA_MINUTE_LIMIT",
      message: `Twelve Data minute limit reached: ${minuteUsed}/${minuteLimit} credits in the last minute.`,
      dailyUsed,
      dailyLimit,
      minuteUsed,
      minuteLimit
    };
  }
  return {
    allowed: true,
    status: dailyUsed >= config.twelveDataDangerCredits ? "DANGER" : dailyUsed >= config.twelveDataWarnCredits ? "WARN" : "OK",
    reason: "TWELVE_DATA_BUDGET_OK",
    message: `${dailyUsed}/${dailyLimit} Twelve Data credits used today.`,
    dailyUsed,
    dailyLimit,
    minuteUsed,
    minuteLimit
  };
}

async function twelveDataUsageSummary() {
  const dailyLimit = config.twelveDataDailyCreditLimit;
  const minuteLimit = config.twelveDataMinuteCreditLimit;
  const [today, recent, minute, heartbeat] = await Promise.all([
    query(
      `SELECT
         COALESCE(sum(credits_used), 0)::int AS credits_used,
         count(*)::int AS calls,
         COALESCE(sum(imported_count), 0)::int AS imported_candles,
         COALESCE(sum(tenant_count), 0)::int AS tenant_evaluations
       FROM api_usage_events
       WHERE provider = 'TWELVE_DATA'
         AND created_at >= date_trunc('day', now())`
    ),
    query(
      `SELECT provider, endpoint, symbol, timeframe_minutes, requested_count, imported_count,
              credits_used, tenant_count, status, error, trigger_source, usage_reason, forced, created_at
       FROM api_usage_events
       WHERE provider = 'TWELVE_DATA'
       ORDER BY created_at DESC
       LIMIT 12`
    ),
    query(
      `SELECT COALESCE(sum(credits_used), 0)::int AS credits_used
       FROM api_usage_events
       WHERE provider = 'TWELVE_DATA'
         AND created_at >= now() - interval '1 minute'`
    ),
    marketDataWorkerHeartbeat()
  ]);
  const used = Number(today.rows[0]?.credits_used ?? 0);
  const usedMinute = Number(minute.rows[0]?.credits_used ?? 0);
  const market = marketClosedReason();
  const workerHeartbeat = heartbeat.rows[0] ?? null;
  const heartbeatAt = workerHeartbeat?.heartbeat_at ? new Date(workerHeartbeat.heartbeat_at) : null;
  const heartbeatAgeSeconds = heartbeatAt ? Math.max(0, Math.round((Date.now() - heartbeatAt.getTime()) / 1000)) : null;
  const heartbeatStaleAfterSeconds = Math.max(config.autoRunSupervisorSeconds * 2, 45);
  const heartbeatStale = heartbeatAgeSeconds == null || heartbeatAgeSeconds > heartbeatStaleAfterSeconds;
  const guardrailStatus = used >= config.twelveDataStopCredits
    ? "STOP"
    : used >= config.twelveDataDangerCredits
      ? "DANGER"
      : used >= config.twelveDataWarnCredits
        ? "WARN"
        : usedMinute >= minuteLimit
          ? "MINUTE_LIMIT"
          : "OK";
  return {
    provider: "TWELVE_DATA",
    dailyLimit,
    minuteLimit,
    market: {
      sessionDate: newYorkDate(),
      closed: market.closed,
      reason: market.reason,
      message: market.message,
      configuredClosedDates: config.marketClosedDates
    },
    guardrail: {
      status: guardrailStatus,
      warnAt: config.twelveDataWarnCredits,
      dangerAt: config.twelveDataDangerCredits,
      stopAt: config.twelveDataStopCredits,
      allowed: guardrailStatus !== "STOP" && guardrailStatus !== "MINUTE_LIMIT",
      message: guardrailStatus === "STOP"
        ? `External Twelve Data calls are stopped at ${used}/${dailyLimit} credits.`
        : guardrailStatus === "MINUTE_LIMIT"
          ? `External Twelve Data calls are paused because ${usedMinute}/${minuteLimit} credits were used in the last minute.`
          : `${used}/${dailyLimit} credits used today.`
    },
    worker: {
      embeddedApiWorker: config.embeddedMarketDataWorker,
      supervisorSeconds: config.autoRunSupervisorSeconds,
      advisoryLockId: TWELVE_DATA_CALL_LOCK_ID,
      mode: config.embeddedMarketDataWorker ? "EMBEDDED_API_WORKER" : "DEDICATED_WORKER_READY",
      status: workerHeartbeat?.status ?? "UNKNOWN",
      pid: workerHeartbeat?.pid ?? null,
      startedAt: workerHeartbeat?.started_at ?? null,
      heartbeatAt: workerHeartbeat?.heartbeat_at ?? null,
      heartbeatAgeSeconds,
      heartbeatStaleAfterSeconds,
      stale: heartbeatStale,
      health: heartbeatStale ? "STALE" : "HEALTHY",
      lastError: workerHeartbeat?.last_error ?? null,
      metadata: workerHeartbeat?.metadata ?? null
    },
    creditsUsedToday: used,
    estimatedRemainingToday: Math.max(0, dailyLimit - used),
    callsToday: Number(today.rows[0]?.calls ?? 0),
    importedCandlesToday: Number(today.rows[0]?.imported_candles ?? 0),
    tenantEvaluationsToday: Number(today.rows[0]?.tenant_evaluations ?? 0),
    creditsUsedLastMinute: usedMinute,
    estimatedRemainingThisMinute: Math.max(0, minuteLimit - usedMinute),
    recent: recent.rows
  };
}

async function marketDataWorkerHeartbeat() {
  try {
    return await query(
      `SELECT worker_name, status, started_at, heartbeat_at, pid, metadata, last_error
       FROM worker_heartbeats
       WHERE worker_name = 'market-data-worker'
       LIMIT 1`
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
    return { rows: [] };
  }
}

async function defaultTenantId() {
  const { rows } = await query("SELECT id FROM platform_tenants WHERE slug = $1 LIMIT 1", [DEFAULT_TENANT_SLUG]);
  return rows[0]?.id ?? null;
}

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
