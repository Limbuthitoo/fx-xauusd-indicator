import type { FastifyInstance } from "fastify";
import { evaluateLiquiditySweepSetup } from "@orb-guide/liquidity-sweep-engine";
import { calculateRisk } from "@orb-guide/risk-engine";
import type { Candle } from "@orb-guide/shared-types";
import { buildOpeningRange, evaluateSetup } from "@orb-guide/strategy-engine";
import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";
import { recordOperationalEvent } from "../../infrastructure/observability/operational-events.js";
import { newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { runModule2LearningPython, runModule3LearningPython, runOrbLearningPython } from "../admin/learning.js";
import { getRuntimeSettings, getTenantModuleStrategyConfiguration, getTenantOrbStrategyConfiguration, type RuntimeSettings } from "../admin/settings.js";
import { requireAdmin, requireTenantModule } from "../auth/routes.js";
import { canCreateTenantNotification } from "../billing/limits.js";
import { broadcastLiveEvent, liveClientCount } from "../live-stream/hub.js";
import { sendTenantPush } from "../notifications/push.js";

type Mt5CandlesResponse = {
  connected: boolean;
  error?: string;
  symbol: string;
  timeframeMinutes: number;
  candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number | null;
    spread?: number | null;
    source?: string;
  }>;
};

type Mt5SymbolInfo = {
  connected?: boolean;
  error?: string;
  symbol: string;
  digits?: number | null;
  tick_size?: number | null;
  tick_value?: number | null;
  contract_size?: number | null;
  minimum_lot?: number | null;
  maximum_lot?: number | null;
  lot_step?: number | null;
  source?: string;
};

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

type LiveWorkerState = {
  running: boolean;
  provider: "MT5" | null;
  symbol: string;
  timeframeMinutes: number;
  intervalSeconds: number;
  count: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastSyncAt: string | null;
  lastImported: number;
  lastError: string | null;
  lastEvaluationAt: string | null;
  cycles: number;
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
  phase: "STARTING" | "API_KEY_MISSING" | "PRE_SESSION" | "MONITORING" | "AFTER_WINDOW" | "PAUSED" | "ERROR";
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
const PERSIST_TWELVE_DATA_CANDLES = true;
const LIVE_CANDLE_CACHE_DAYS = 7;
const TWELVE_DATA_STARTUP_BACKFILL_COUNT = 300;
const TWELVE_DATA_LIVE_POLL_COUNT = 2;
const TWELVE_DATA_CALL_LOCK_ID = 2026080201;
const SHARED_TWELVE_DATA_SOURCE_TIMEFRAME = 5;
const DEFAULT_TWELVE_DATA_TIMEFRAME = twelveIntervalToTimeframe(config.twelveDataInterval) || SHARED_TWELVE_DATA_SOURCE_TIMEFRAME;
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
const chartSyncThrottle = new Map<string, { requestedAt: number; promise?: Promise<any> }>();

let liveTimer: NodeJS.Timeout | null = null;
const liveState: LiveWorkerState = {
  running: false,
  provider: null,
  symbol: "XAUUSD",
  timeframeMinutes: 15,
  intervalSeconds: 10,
  count: 300,
  startedAt: null,
  stoppedAt: null,
  lastSyncAt: null,
  lastImported: 0,
  lastError: null,
  lastEvaluationAt: null,
  cycles: 0
};

let twelveDataTimer: NodeJS.Timeout | null = null;
const twelveDataState: TwelveDataWorkerState = {
  running: false,
  provider: "TWELVE_DATA",
  configured: Boolean(config.twelveDataApiKey),
  symbol: "XAUUSD",
  providerSymbol: config.twelveDataSymbol,
  timeframeMinutes: DEFAULT_TWELVE_DATA_TIMEFRAME,
  interval: timeframeToTwelveInterval(DEFAULT_TWELVE_DATA_TIMEFRAME),
  pollSeconds: Math.max(config.twelveDataPollSeconds, 60),
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
          ? "Poll during the New York ORB window and persist raw candles."
          : "Poll during the New York ORB window. Raw candles stay in memory; only ORB events are persisted."
      },
      {
      code: "MT5_BRIDGE",
      name: "MT5 broker bridge EA",
      cost: "Free with local MT5 script/EA",
      writesToPostgres: true,
      statusEndpoint: "/api/market-data/live/status",
      recommended: true
    },
    {
      code: "MT5",
      name: "Optional Python MT5 adapter",
      cost: "Free with broker/demo account",
      writesToPostgres: true,
      statusEndpoint: "/api/market-data/mt5/status",
      recommended: false,
      note: "Usually Windows-only. On macOS use MT5_BRIDGE."
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
      startupBackfillCount: settings.feed.startupBackfillCount,
      livePollCount: settings.feed.livePollCount,
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
    return syncTwelveDataChartCandles({
      symbol,
      providerSymbol,
      timeframeMinutes: timeframe,
      moduleCode,
      tenantId: auth.tenantId,
      startupBackfillCount: settings.feed.startupBackfillCount,
      livePollCount: settings.feed.livePollCount
    });
  });

  app.post("/api/market-data/twelve-data/live/start", async (request) => {
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

  app.post("/api/market-data/twelve-data/live/stop", async () => {
    return stopTwelveDataLive({ notify: true });
  });

  app.get("/api/market-data/twelve-data/live/status", async () => {
    const settings = await refreshRuntimeSettings();
    return {
      ...twelveDataState,
      configured: Boolean(config.twelveDataApiKey),
      startupBackfillCount: settings.feed.startupBackfillCount,
      livePollCount: settings.feed.livePollCount,
      persistRawCandles: settings.feed.rawCandleStorage,
      liveCacheDays: settings.feed.cacheDays,
      cachedCandles: getCachedCandles(twelveDataState.symbol, twelveDataState.timeframeMinutes).length
    };
  });

  app.get("/api/market-data/live/cache", async (request) => {
    const settings = await refreshRuntimeSettings();
    const search = request.query as { symbol?: string; timeframeMinutes?: string; limit?: string };
    const symbol = search.symbol ?? settings.symbol;
    const timeframe = Number(search.timeframeMinutes ?? settings.timeframeMinutes);
    const limit = Math.min(Number(search.limit ?? liveCandleCacheLimit(timeframe)), liveCandleCacheLimit(timeframe));
    const cached = getCachedCandles(symbol, timeframe);
    return {
      symbol,
      timeframeMinutes: timeframe,
      cacheDays: settings.feed.cacheDays,
      cacheLimit: liveCandleCacheLimit(timeframe),
      cachedCandles: cached.length,
      persistRawCandles: settings.feed.rawCandleStorage,
      latestCandle: cached.at(-1) ?? null,
      candles: cached.slice(-limit)
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
    const body = request.body as { count?: number };
    const count = Math.min(Math.max(Number(body.count ?? settings.feed.startupBackfillCount ?? TWELVE_DATA_STARTUP_BACKFILL_COUNT), 20), 5000);
    const before = await buildOrbDataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays, settings);
    const result = await syncTwelveDataCandles({
      symbol: settings.symbol,
      providerSymbol: settings.feed.providerSymbol,
      timeframeMinutes: settings.timeframeMinutes,
      interval: timeframeToTwelveInterval(settings.timeframeMinutes),
      count,
      autoEvaluate: false,
      usageTenantIds: session.tenantId ? [session.tenantId] : [],
      triggerSource: "TENANT_BACKFILL",
      usageReason: "ORB data-readiness backfill"
    });
    const after = await buildOrbDataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays, settings);
    return {
      provider: "TWELVE_DATA",
      symbol: settings.symbol,
      timeframeMinutes: settings.timeframeMinutes,
      requestedCount: count,
      estimatedApiCreditsUsed: 1,
      persistRawCandles: settings.feed.rawCandleStorage,
      result,
      before,
      after
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
    const body = request.body as { count?: number; persist?: boolean };
    const count = Math.min(Math.max(Number(body.count ?? settings.feed.startupBackfillCount ?? TWELVE_DATA_STARTUP_BACKFILL_COUNT), 20), 5000);
    const before = await buildModule2DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
    const result = await syncTwelveDataCandles({
      symbol: settings.symbol,
      providerSymbol: settings.feed.providerSymbol,
      timeframeMinutes: 5,
      interval: "5min",
      count,
      autoEvaluate: false,
      usageTenantIds: session.tenantId ? [session.tenantId] : [],
      triggerSource: "TENANT_BACKFILL",
      usageReason: "Module 2 data-readiness backfill"
    });
    const after = await buildModule2DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
    return {
      provider: "TWELVE_DATA",
      symbol: settings.symbol,
      timeframeMinutes: 5,
      requestedCount: count,
      estimatedApiCreditsUsed: 1,
      persistRawCandles: settings.feed.rawCandleStorage,
      result,
      before,
      after
    };
  });

  app.get("/api/module3/data-readiness", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    const settings = await getRuntimeSettings(session.tenantId);
    return buildModule3DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
  });

  app.post("/api/module3/data-readiness/backfill", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    const settings = await getRuntimeSettings(session.tenantId);
    const body = request.body as { count?: number };
    const count = Math.min(Math.max(Number(body.count ?? settings.feed.startupBackfillCount ?? TWELVE_DATA_STARTUP_BACKFILL_COUNT), 25), 5000);
    const before = await buildModule3DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
    const result = await syncTwelveDataCandles({
      symbol: settings.symbol,
      providerSymbol: settings.feed.providerSymbol,
      timeframeMinutes: 5,
      interval: "5min",
      count,
      autoEvaluate: false,
      usageTenantIds: session.tenantId ? [session.tenantId] : [],
      triggerSource: "TENANT_BACKFILL",
      usageReason: "Module 3 data-readiness backfill"
    });
    const after = await buildModule3DataReadiness(session.tenantId, settings.symbol, settings.feed.cacheDays);
    return {
      provider: "TWELVE_DATA",
      symbol: settings.symbol,
      timeframeMinutes: 5,
      requestedCount: count,
      estimatedApiCreditsUsed: 1,
      result,
      before,
      after
    };
  });

  app.get("/api/module3/learning/latest", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    return latestModuleLearningSnapshot(session.tenantId, "strategy_lab_3");
  });

  app.post("/api/module3/learning/run", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    if (!session.tenantId) return { error: "Tenant account is required for Module 3 learning." };
    await runModule3LearningPython(session.tenantId);
    return latestModuleLearningSnapshot(session.tenantId, "strategy_lab_3");
  });

  app.get("/api/module3/session-reports", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    const rows = await query(
      `SELECT *
       FROM module_session_reports
       WHERE tenant_id = $1 AND module_code = 'strategy_lab_3'
       ORDER BY session_date DESC
       LIMIT 30`,
      [session.tenantId]
    );
    return rows.rows;
  });

  app.post("/api/module3/session-reports/generate", async (request) => {
    const session = await requireTenantModule(request, "strategy_lab_3");
    const body = request.body as { sessionDate?: string };
    const tradingSession = await moduleSessionForReport(session.tenantId, "strategy_lab_3", body.sessionDate);
    if (!tradingSession) return { error: "No Module 3 session found for that NY date." };
    return generateGenericModuleSessionReport(tradingSession, "strategy_lab_3", "vwapOpeningDrive.strategy");
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

  app.get("/api/market-data/mt5/status", async () => {
    return fetchJson(`${config.quantBaseUrl}/market-data/mt5/status`);
  });

  app.post("/api/market-data/mt5/sync", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number; count?: number; syncBrokerSpecs?: boolean };
    return syncMt5Candles({
      symbol: body.symbol ?? "XAUUSD",
      timeframeMinutes: body.timeframeMinutes ?? 15,
      count: body.count ?? 300,
      syncBrokerSpecs: body.syncBrokerSpecs ?? true,
      autoEvaluate: true
    });
  });

  app.post("/api/market-data/mt5/live/start", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number; intervalSeconds?: number; count?: number };
    liveState.running = true;
    liveState.provider = "MT5";
    liveState.symbol = body.symbol ?? "XAUUSD";
    liveState.timeframeMinutes = body.timeframeMinutes ?? 15;
    liveState.intervalSeconds = Math.max(body.intervalSeconds ?? 10, 5);
    liveState.count = Math.min(body.count ?? 300, 2000);
    liveState.startedAt = new Date().toISOString();
    liveState.stoppedAt = null;
    liveState.lastError = null;
    if (liveTimer) clearInterval(liveTimer);

    await runLiveCycle();
    liveTimer = setInterval(() => {
      runLiveCycle().catch((error) => {
        liveState.lastError = (error as Error).message;
      });
    }, liveState.intervalSeconds * 1000);

    await notifyOnce(
      `mt5-live-started-${liveState.symbol}`,
      "MT5_LIVE_STARTED",
      "MT5 live ingestion started",
      `${liveState.symbol} ${liveState.timeframeMinutes}-minute candles will sync into PostgreSQL every ${liveState.intervalSeconds} seconds.`
    );

    return liveState;
  });

  app.post("/api/market-data/mt5/live/stop", async () => {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    liveState.running = false;
    liveState.stoppedAt = new Date().toISOString();
    await notifyOnce(`mt5-live-stopped-${liveState.symbol}-${liveState.stoppedAt}`, "MT5_LIVE_STOPPED", "MT5 live ingestion stopped", `${liveState.symbol} ingestion is no longer running.`);
    return liveState;
  });

  app.get("/api/market-data/mt5/live/status", async () => liveState);

  app.post("/api/market-data/bridge/candles", async (request) => {
    const body = request.body as {
      symbol?: string;
      timeframeMinutes?: number;
      source?: string;
      candles: Array<{
        timestamp?: string;
        timestampUtc?: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number | null;
        spread?: number | null;
      }>;
      autoEvaluate?: boolean;
    };
    const symbol = body.symbol ?? "XAUUSD";
    const timeframe = body.timeframeMinutes ?? 15;
    let imported = 0;
    const savedCandles = [];
    for (const candle of body.candles ?? []) {
      const savedCandle = await upsertCandle(symbol, timeframe, {
        timestamp: candle.timestamp ?? candle.timestampUtc ?? new Date().toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        spread: candle.spread,
        source: body.source ?? "MT5_BRIDGE"
      });
      savedCandles.push(savedCandle);
      imported += 1;
    }
    const automation = body.autoEvaluate ?? true ? await processLiveSession(symbol, timeframe) : null;
    for (const candle of savedCandles) {
      broadcastLiveEvent({
        type: "candle",
        provider: "MT5_BRIDGE",
        symbol,
        timeframeMinutes: timeframe,
        candle,
        automation
      });
    }
    return {
      connected: true,
      provider: "MT5_BRIDGE",
      symbol,
      timeframeMinutes: timeframe,
      imported,
      automation
    };
  });

  app.get("/api/market-data/bridge/status", async (request) => {
    const search = request.query as { symbol?: string; timeframeMinutes?: string };
    const symbol = search.symbol ?? "XAUUSD";
    const timeframe = Number(search.timeframeMinutes ?? 15);
    const { rows } = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source LIKE 'MT5_BRIDGE%'
       ORDER BY created_at DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const latest = rows[0];
    return {
      connected: Boolean(latest),
      provider: "MT5_BRIDGE",
      symbol,
      timeframeMinutes: timeframe,
      latestCandle: latest
        ? {
            timestampUtc: latest.timestamp_utc,
            open: Number(latest.open),
            high: Number(latest.high),
            low: Number(latest.low),
            close: Number(latest.close),
            volume: latest.volume == null ? null : Number(latest.volume),
            spread: latest.spread == null ? null : Number(latest.spread),
            source: latest.source,
            receivedAt: latest.created_at
          }
        : null
    };
  });

  app.get("/api/market-data/live/status", async (request) => {
    const settings = await refreshRuntimeSettings();
    const search = request.query as { symbol?: string; timeframeMinutes?: string; staleAfterSeconds?: string };
    const symbol = search.symbol ?? settings.symbol;
    const timeframe = Number(search.timeframeMinutes ?? settings.timeframeMinutes);
    const staleAfterSeconds = Number(search.staleAfterSeconds ?? timeframe * 60 * 2);
    const latestAnyResult = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const latestBrokerResult = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND ((source LIKE 'MT5_BRIDGE%' AND source NOT LIKE '%TEST%') OR source = 'MT5' OR source = 'TWELVE_DATA')
       ORDER BY created_at DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const latestBridgeTestResult = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread, source, created_at
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND source LIKE 'MT5_BRIDGE%TEST%'
       ORDER BY created_at DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const latestBroker = latestBrokerResult.rows[0] as any | undefined;
    const latestBridgeTest = latestBridgeTestResult.rows[0] as any | undefined;
    const latestAny = latestAnyResult.rows[0] as any | undefined;
    const cachedLatest = getCachedCandles(symbol, timeframe).at(-1);
    const latestTwelve = cachedLatest ? liveCandleToRow(cachedLatest) : undefined;
    const brokerReceivedAt = latestBroker?.created_at ? new Date(latestBroker.created_at) : null;
    const cachedReceivedAt = latestTwelve?.created_at ? new Date(latestTwelve.created_at) : null;
    const brokerAgeSeconds = cachedReceivedAt
      ? Math.max(0, Math.round((Date.now() - cachedReceivedAt.getTime()) / 1000))
      : brokerReceivedAt
        ? Math.max(0, Math.round((Date.now() - brokerReceivedAt.getTime()) / 1000))
        : null;
    const live = brokerAgeSeconds != null && brokerAgeSeconds <= staleAfterSeconds;
    const testReceivedAt = latestBridgeTest?.created_at ? new Date(latestBridgeTest.created_at) : null;
    const testAgeSeconds = testReceivedAt ? Math.max(0, Math.round((Date.now() - testReceivedAt.getTime()) / 1000)) : null;
    const testMode = !live && testAgeSeconds != null && testAgeSeconds <= staleAfterSeconds;
    const latest = live ? latestTwelve ?? latestBroker : latestTwelve ?? latestBroker ?? latestBridgeTest ?? latestAny;
    const receivedAt = latest?.created_at ? new Date(latest.created_at) : null;
    const ageSeconds = receivedAt ? Math.max(0, Math.round((Date.now() - receivedAt.getTime()) / 1000)) : null;
    return {
      symbol,
      timeframeMinutes: timeframe,
      provider: testMode ? "MT5_BRIDGE_TEST" : latest?.source?.startsWith("MT5_BRIDGE") ? "MT5_BRIDGE" : latest?.source === "MT5" ? "MT5_PYTHON" : latest?.source === "TWELVE_DATA" ? "TWELVE_DATA" : latest?.source ?? "NONE",
      live,
      stale: !live,
      testMode,
      staleAfterSeconds,
      ageSeconds,
      brokerAgeSeconds,
      testAgeSeconds,
      persistRawCandles: latest?.source === "TWELVE_DATA" ? settings.feed.rawCandleStorage : true,
      liveCacheDays: latest?.source === "TWELVE_DATA" ? settings.feed.cacheDays : null,
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

async function runLearningAfterSession(sessionId: string) {
  if (autoRunState.lastLearningSessionId === sessionId) return;
  try {
    const result = await runOrbLearningPython();
    autoRunState.lastLearningSessionId = sessionId;
    autoRunState.lastLearningRunAt = new Date().toISOString();
    autoRunState.lastLearningResult = result;
    await notifyOnce(
      `orb-learning-${sessionId}`,
      "ORB_LEARNING_COMPLETED",
      "ORB learning updated",
      `Python learning reviewed ${result.sampleSize ?? 0} results and produced ${result.recommendations ?? 0} recommendations.`
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
        JSON.stringify({ reportStatus: report.final_status, trades: report.summary?.paperTrades ?? 0, totalR: report.summary?.totalR ?? 0, learning: learning?.status ?? "SKIPPED" })
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

async function runModule3CloseoutAfterSession(session: any) {
  const moduleCode = "strategy_lab_3";
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
    const report = await generateGenericModuleSessionReport(session, moduleCode, "vwapOpeningDrive.strategy");
    const closedTrades = Number(report.summary?.paperTrades ?? 0) - Number(report.summary?.active ?? 0);
    const learning = closedTrades > 0 && session.tenant_id ? await runModule3LearningPython(session.tenant_id) : null;
    const updated = await query(
      `UPDATE module_session_closeouts
       SET status = 'COMPLETED',
           report_id = $2,
           learning_run_id = $3,
           summary = $4::jsonb,
           completed_at = now(),
           error = NULL
       WHERE id = $1
       RETURNING *`,
      [
        closeout.id,
        report.id,
        learning?.runId ?? null,
        JSON.stringify({ reportStatus: report.final_status, trades: report.summary?.paperTrades ?? 0, totalR: report.summary?.totalR ?? 0, learning: learning?.status ?? "SKIPPED" })
      ]
    );
    await notifyTenantOnce(
      session.tenant_id,
      `module3-closeout-${session.id}`,
      "MODULE3_DAILY_REPORT_READY",
      "Module 3 daily report ready",
      `Status ${report.final_status}. Trades ${report.summary?.paperTrades ?? 0}, total R ${Number(report.summary?.totalR ?? 0).toFixed(2)}.`,
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
    await notifyTenantOnce(session.tenant_id, `module3-closeout-failed-${session.id}`, "MODULE3_CLOSEOUT_FAILED", "Module 3 closeout failed", (error as Error).message, "HIGH");
    return failed.rows[0];
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
  if (["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED"].includes(code)) return "hard";
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
    return autoRunState;
  }

  const first = monitoring[0];
  const timeframe = first.settings.timeframeMinutes;
  autoRunState.phase = "MONITORING";
  autoRunState.running = true;
  autoRunState.reason = `Monitoring ${monitoring.length} active tenant(s). Twelve Data calls are grouped by symbol/timeframe.`;
  if (!twelveDataState.running) {
    await startTwelveDataLive({
      symbol: first.settings.symbol,
      providerSymbol: first.settings.feed.providerSymbol,
      timeframeMinutes: timeframe,
      interval: timeframeToTwelveInterval(timeframe),
      pollSeconds: first.settings.feed.pollSeconds,
      count: first.settings.feed.startupBackfillCount,
      notify: true
    });
    autoRunState.lastActionAt = new Date().toISOString();
  }
  return autoRunState;
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
  const apiStart = sessionStart - settings.orb.apiStartLeadMinutes * 60_000;
  state.apiStartAt = new Date(apiStart).toISOString();
  state.apiStopAt = new Date(sessionEnd).toISOString();

  if (now < apiStart) {
    state.phase = "PRE_SESSION";
    state.nextActionAt = new Date(apiStart).toISOString();
    state.reason = `Scheduled. Twelve Data starts ${settings.orb.apiStartLeadMinutes} minutes before the ${state.moduleName} New York window.`;
    state.running = false;
    const minutesUntilApiStart = Math.round((apiStart - now) / 60_000);
    if (minutesUntilApiStart <= settings.orb.apiStartLeadMinutes && minutesUntilApiStart >= 0) {
      const modulePrefix = tenant.module_code === "orb_max_options"
        ? "MODULE1"
        : tenant.module_code === "high_probability_strategy_2"
          ? "MODULE2"
          : "MODULE3";
      await notifyTenantOnce(
        tenant.id,
        `mobile-ny-pre-session-${tenant.module_code}-${session.id}`,
        `${modulePrefix}_NY_PRE_SESSION`,
        `${state.moduleName} starts soon`,
        `XAUUSD New York monitoring starts at ${new Date(session.session_start_at).toISOString()}. Get ready for paper-trade alerts.`
      );
    }
    return state;
  }

  if (now >= sessionEnd) {
    state.phase = "AFTER_WINDOW";
    state.nextActionAt = null;
    state.reason = `${state.moduleName} New York monitoring window is complete. Twelve Data polling is stopped to preserve API calls.`;
    state.running = false;
    if (tenant.module_code === "high_probability_strategy_2") {
      const closeout = await runModule2CloseoutAfterSession(session);
      state.lastActionAt = closeout?.completed_at ?? state.lastActionAt;
      state.reason = closeout?.status === "COMPLETED"
        ? `${state.moduleName} New York window is complete. Daily report, learning, and review queue closeout are done.`
        : state.reason;
    } else if (tenant.module_code === "strategy_lab_3") {
      const closeout = await runModule3CloseoutAfterSession(session);
      state.lastActionAt = closeout?.completed_at ?? state.lastActionAt;
      state.reason = closeout?.status === "COMPLETED"
        ? `${state.moduleName} New York window is complete. Daily report and learning closeout are done.`
        : state.reason;
    } else {
      await runLearningAfterSession(session.id);
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

function isNewYorkWeekend(sessionDate: string) {
  const day = new Date(`${sessionDate}T12:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function nextNewYorkTradingApiStart(settings: RuntimeSettings) {
  const next = new Date(`${newYorkDate()}T12:00:00.000Z`);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6 || isConfiguredMarketClosedDate(next.toISOString().slice(0, 10)));
  const sessionDate = next.toISOString().slice(0, 10);
  const times = sessionTimesForDate(sessionDate, settings.orb.sessionStart, settings.orb.openingRangeMinutes, settings.orb.tradeWindowEnd);
  return new Date(new Date(times.sessionStartAt).getTime() - settings.orb.apiStartLeadMinutes * 60_000).toISOString();
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
  return { closed: false, reason: "MARKET_OPEN_DAY", message: "Market date is eligible for NY session monitoring." };
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

  if (options.triggerSource === "MARKET_DATA_WORKER" || options.triggerSource === "TENANT_CHART_SYNC") {
    return {
      allowed: true,
      reason: "NY_API_WINDOW_ACTIVE",
      message: "Shared Twelve Data call is inside the active New York API window.",
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
  const moduleUsesStrategyWindow = moduleCode === "high_probability_strategy_2" || moduleCode === "strategy_lab_3";
  const sessionStart = moduleUsesStrategyWindow
    ? String(moduleConfig.newYorkStartTime ?? "09:30")
    : settings.orb.sessionStart;
  const tradeWindowEnd = moduleUsesStrategyWindow
    ? String(moduleConfig.newYorkEndTime ?? "16:00")
    : settings.orb.tradeWindowEnd;
  const openingRangeMinutes = moduleUsesStrategyWindow ? 0 : settings.orb.openingRangeMinutes;
  const sessionPreset = moduleCode === "high_probability_strategy_2" ? "NY_SWEEP_BOS" : moduleCode === "strategy_lab_3" ? "NY_VWAP_DRIVE" : "NY_0930";
  const versionResult = await query(
    `SELECT *
     FROM strategy_versions
     WHERE id = COALESCE($1::uuid, (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1))`,
    [strategyVersion?.id ?? null]
  );
  const version = versionResult.rows[0] as any;
  const sessionDate = newYorkDate();
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
  twelveDataState.pollSeconds = Math.max(options.pollSeconds ?? settings.feed.pollSeconds, 60);
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
      const cachedBeforeSync = getCachedCandles(settings.symbol, sourceTimeframe).length;
      const requestedCount = cachedBeforeSync === 0
        ? Math.min(twelveDataState.count, settings.feed.startupBackfillCount)
        : settings.feed.livePollCount;
      const result = await syncTwelveDataCandles({
        symbol: settings.symbol,
        providerSymbol: settings.feed.providerSymbol,
        timeframeMinutes: sourceTimeframe,
        interval: timeframeToTwelveInterval(sourceTimeframe),
        count: requestedCount,
        autoEvaluate: false,
        usageTenantIds: [...new Set(group.tenants.map((tenant) => tenant.id))],
        triggerSource: "MARKET_DATA_WORKER",
        usageReason: `Shared NY session feed for ${group.tenants.length} subscriber module(s)`
      });
      lastResult = result;
      totalImported += result.imported ?? 0;
      await refreshDerivedCandles(settings.symbol, sourceTimeframe, [...group.timeframes]);
      for (const tenant of group.tenants) {
        const timeframe = moduleTimeframeMinutes(tenant.module_code, settings);
        const candles = getCachedCandles(settings.symbol, timeframe);
        const state = tenantAutomationStates.get(tenantStateKey(tenant.id, tenant.module_code)) ?? tenantStateFor(tenant, settings);
        state.latestCandleAt = candles.at(-1)?.timestampUtc ?? null;
        state.lastActionAt = new Date().toISOString();
        try {
          const evaluation = await processModuleLiveSession(tenant.module_code, settings.symbol, timeframe, candles, tenant.id);
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
  const now = Date.now();
  const apiStart = refreshedSchedule.apiStartAt ? new Date(refreshedSchedule.apiStartAt).getTime() : null;
  const apiStop = refreshedSchedule.apiStopAt ? new Date(refreshedSchedule.apiStopAt).getTime() : null;
  const insideApiWindow = apiStart != null && apiStop != null && now >= apiStart && now <= apiStop;
  const sourceTimeframe = preferredTwelveDataSourceTimeframe(options.timeframeMinutes);
  const key = cacheKey(options.symbol, sourceTimeframe);
  const cached = getCachedCandles(options.symbol, options.timeframeMinutes);
  const latest = cached.at(-1);
  if (!insideApiWindow) {
    return {
      connected: Boolean(latest),
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: refreshedSchedule.sessionState === "MARKET_CLOSED" ? "MARKET_CLOSED_WEEKEND" : "OUTSIDE_NY_API_WINDOW",
      apiStartAt: refreshedSchedule.apiStartAt,
      apiStopAt: refreshedSchedule.apiStopAt,
      cachedCandles: cached.length,
      latestCandle: latest ?? null
    };
  }
  const latestAgeMs = latest ? Date.now() - new Date(latest.timestampUtc).getTime() : Number.POSITIVE_INFINITY;
  const timeframeMs = options.timeframeMinutes * 60_000;
  const throttle = chartSyncThrottle.get(key);
  if (throttle?.promise) return throttle.promise;
  if (latest && latestAgeMs < timeframeMs) {
    return {
      connected: true,
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: "CHART_CACHE_FRESH",
      cachedCandles: cached.length,
      latestCandle: latest
    };
  }
  if (throttle && Date.now() - throttle.requestedAt < 60_000) {
    return {
      connected: true,
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      imported: 0,
      skipped: true,
      reason: "CHART_SYNC_THROTTLED",
      cachedCandles: cached.length,
      latestCandle: latest ?? null
    };
  }
  const promise = syncTwelveDataCandles({
    symbol: options.symbol,
    providerSymbol: options.providerSymbol,
    timeframeMinutes: sourceTimeframe,
    interval: timeframeToTwelveInterval(sourceTimeframe),
    count: getCachedCandles(options.symbol, sourceTimeframe).length === 0 ? options.startupBackfillCount : options.livePollCount,
    autoEvaluate: false,
    usageTenantIds: options.tenantId ? [options.tenantId] : [],
    triggerSource: "TENANT_CHART_SYNC",
    usageReason: `${options.moduleCode} chart refresh inside NY API window`
  }).then(async (result) => {
    await refreshDerivedCandles(options.symbol, sourceTimeframe, [options.timeframeMinutes]);
    const nextCached = getCachedCandles(options.symbol, options.timeframeMinutes);
    return {
      ...result,
      timeframeMinutes: options.timeframeMinutes,
      sourceTimeframeMinutes: sourceTimeframe,
      cachedCandles: nextCached.length,
      latestCandle: nextCached.at(-1) ?? null
    };
  }).finally(() => {
    const current = chartSyncThrottle.get(key);
    if (current?.promise === promise) chartSyncThrottle.set(key, { requestedAt: Date.now() });
  });
  chartSyncThrottle.set(key, { requestedAt: Date.now(), promise });
  return promise;
}

async function runLiveCycle() {
  if (!liveState.running) return;
  try {
    const result = await syncMt5Candles({
      symbol: liveState.symbol,
      timeframeMinutes: liveState.timeframeMinutes,
      count: liveState.count,
      syncBrokerSpecs: liveState.cycles === 0,
      autoEvaluate: true
    });
    liveState.lastSyncAt = new Date().toISOString();
    liveState.lastImported = result.imported;
    liveState.lastError = result.connected ? null : result.error ?? "MT5 is not connected.";
    liveState.lastEvaluationAt = new Date().toISOString();
    liveState.cycles += 1;
  } catch (error) {
    liveState.lastError = (error as Error).message;
    liveState.cycles += 1;
  }
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
    const savedCandle = settings.feed.rawCandleStorage
      ? await upsertCandle(options.symbol, options.timeframeMinutes, candle)
      : cacheLiveCandle(options.symbol, options.timeframeMinutes, candle);
    if (settings.feed.rawCandleStorage) {
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
    }
    savedCandles.push(savedCandle);
    imported += 1;
  }

  const automation = options.autoEvaluate ? await processLiveSession(options.symbol, options.timeframeMinutes, savedCandles, await defaultTenantId()) : null;
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
  if (settings.feed.rawCandleStorage) {
    await pruneStoredCandles(options.symbol, options.timeframeMinutes, settings.feed.cacheDays);
  }
  for (const candle of savedCandles) {
    broadcastLiveEvent({
      type: "candle",
      provider: "TWELVE_DATA",
      symbol: options.symbol,
      timeframeMinutes: options.timeframeMinutes,
      candle,
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

async function syncMt5Candles(options: { symbol: string; timeframeMinutes: number; count: number; syncBrokerSpecs: boolean; autoEvaluate: boolean }) {
  const symbol = options.symbol;
  const timeframe = options.timeframeMinutes;
  const count = Math.min(options.count, 2000);
  const mt5 = await fetchJson<Mt5CandlesResponse>(
    `${config.quantBaseUrl}/market-data/mt5/candles/${encodeURIComponent(symbol)}?timeframe_minutes=${timeframe}&count=${count}`
  );
  if (!mt5.connected) {
    return { connected: false, imported: 0, error: mt5.error ?? "MT5 is not connected." };
  }

  let imported = 0;
  for (const candle of mt5.candles) {
      const savedCandle = await upsertCandle(symbol, timeframe, candle);
      broadcastLiveEvent({
        type: "candle",
        provider: "MT5_PYTHON",
        symbol,
        timeframeMinutes: timeframe,
        candle: savedCandle
      });
      imported += 1;
    }

  let brokerSpecs = null;
  if (options.syncBrokerSpecs) {
    brokerSpecs = await syncBrokerSpecs(symbol);
  }

  let automation = null;
  if (options.autoEvaluate) {
    automation = await processLiveSession(symbol, timeframe);
  }

  return {
    connected: true,
    provider: "MT5",
    symbol,
    timeframeMinutes: timeframe,
    imported,
    brokerSpecs,
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

async function refreshDerivedCandles(symbol: string, sourceTimeframe: number, targetTimeframes: number[]) {
  const sourceCandles = getCachedCandles(symbol, sourceTimeframe);
  if (sourceCandles.length === 0) return;
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
    [symbol, timeframe, timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume ?? null, candle.spread ?? null, candle.source ?? "MT5"]
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

async function processLiveSession(symbol: string, timeframe: number, liveCandles = getCachedCandles(symbol, timeframe), tenantId?: string | null) {
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
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [symbol, activeTenantId]
  );
  const session = sessionResult.rows[0] as any;
  if (!session) return { sessionFound: false };

  const now = new Date();
  const signalEnd = new Date(session.signal_window_end_at);
  if (now > signalEnd && !["SESSION_EXPIRED", "SESSION_COMPLETED", "NO_TRADE"].includes(session.state)) {
    await query("UPDATE trading_sessions SET state = 'SESSION_EXPIRED' WHERE id = $1", [session.id]);
    await notifyTenantOnce(session.tenant_id, `session-expired-${session.id}`, "SESSION_EXPIRED", "ORB trade window expired", "No new setups will be accepted for this session.");
    return { sessionFound: true, state: "SESSION_EXPIRED" };
  }

  let range = await getOpeningRange(session.id);
  if ((!range || range.status !== "LOCKED") && now >= new Date(session.opening_range_end_at)) {
    range = await lockOpeningRangeForSession(session, timeframe, liveCandles);
    if (range.status === "LOCKED") {
      await notifyTenantOnce(
        session.tenant_id,
        `range-locked-${session.id}`,
        "RANGE_LOCKED",
        "XAUUSD ORB locked",
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
  let paperTrade = null;
  if (saved?.setup?.status === "LONG SETUP READY" || saved?.setup?.status === "SHORT SETUP READY") {
    await saveSetupCandleSnapshot(saved.setup, session, timeframe, liveCandles, current);
    const alert = entryAlertDetails("orb_max_options", saved.setup, null, Number(saved.risk?.rewardToRisk ?? 0));
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
    paperTrade = settings.paperTradingEnabled
      ? await createAutomaticPaperTrade(session, saved.setup, saved.risk, current)
      : { skipped: true, reason: "PAPER_TRADING_DISABLED_BY_SETTINGS" };
  } else if (saved?.setup?.status === "NO TRADE") {
    await notifyTenantOnce(session.tenant_id, `no-trade-${saved.setup.id}`, "NO_TRADE", "No trade classification", saved.setup.final_reason);
  }
  const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId);

  return { sessionFound: true, rangeStatus: range.status, setupId: saved?.setup?.id, setupStatus: saved?.setup?.status, paperTrade, tradeLifecycle };
}

async function processModuleLiveSession(moduleCode: string, symbol: string, timeframe: number, liveCandles = getCachedCandles(symbol, timeframe), tenantId?: string | null) {
  if (moduleCode === "high_probability_strategy_2") {
    return processLiquiditySweepSession(symbol, timeframe, liveCandles, tenantId);
  }
  if (moduleCode === "strategy_lab_3") {
    return processVwapOpeningDriveSession(symbol, timeframe, liveCandles, tenantId);
  }
  return processLiveSession(symbol, timeframe, liveCandles, tenantId);
}

async function processVwapOpeningDriveSession(symbol: string, timeframe: number, liveCandles = getCachedCandles(symbol, timeframe), tenantId?: string | null) {
  const activeTenantId = tenantId ?? (await defaultTenantId());
  const moduleCode = "strategy_lab_3";
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
    await notifyTenantOnce(session.tenant_id, `module3-session-expired-${session.id}`, "MODULE3_SESSION_EXPIRED", "Module 3 window expired", "No new VWAP opening-drive setups will be accepted for this session.");
    await runModule3CloseoutAfterSession({ ...session, state: "SESSION_EXPIRED" });
    return { sessionFound: true, state: "SESSION_EXPIRED" };
  }
  if (now < new Date(session.session_start_at) || now > signalEnd) return { sessionFound: true, evaluation: "OUTSIDE_MODULE3_WINDOW" };

  const completedAtOrBefore = new Date(now.getTime() - timeframe * 60_000).toISOString();
  const current =
    latestCachedCandle(liveCandles, session.session_start_at, session.signal_window_end_at, completedAtOrBefore) ??
    ((await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
         AND timestamp_utc >= $3 AND timestamp_utc <= $4 AND timestamp_utc <= $5
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe, session.session_start_at, session.signal_window_end_at, completedAtOrBefore]
    )).rows[0] as any);
  if (!current) return { sessionFound: true, evaluation: "WAITING_FOR_MODULE3_CANDLE" };
  const duplicate = await query("SELECT id FROM setup_candidates WHERE session_id = $1 AND module_code = $2 AND detected_at = $3 LIMIT 1", [session.id, moduleCode, current.timestamp_utc]);
  if (duplicate.rows[0]) {
    const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
    return { sessionFound: true, evaluation: "ALREADY_EVALUATED", tradeLifecycle };
  }
  const startLookback = new Date(new Date(session.session_start_at).getTime() - 60 * 60_000).toISOString();
  const setupRows = cachedCandlesBetween(liveCandles, startLookback, current.timestamp_utc);
  const fallbackRows = setupRows.length > 0
    ? setupRows
    : (await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc <= $4
       ORDER BY timestamp_utc ASC
       LIMIT 300`,
      [symbol, timeframe, startLookback, current.timestamp_utc]
    )).rows;
  const configuration = await getTenantModuleStrategyConfiguration(activeTenantId, moduleCode, "vwapOpeningDrive.strategy", session.configuration_json);
  const tradesTaken = await tradesTakenForSession(session.id, moduleCode);
  const decision = evaluateVwapOpeningDrive({
    now: current.timestamp_utc,
    symbol,
    candles: uniqueCandleRows([...fallbackRows, current]).map(toCandle),
    sessionStartAt: session.session_start_at,
    sessionEndAt: session.signal_window_end_at,
    spread: current.spread == null ? null : Number(current.spread),
    newsStatus: "CLEAR",
    tradesTakenThisSession: tradesTaken,
    configuration
  });
  const saved = await saveModuleDecision(session, moduleCode, decision, current);
  let paperTrade = null;
  if (isProductionReadySetup(saved?.setup, decision)) {
    await saveSetupCandleSnapshot(saved.setup, session, timeframe, liveCandles, current);
    const alert = entryAlertDetails(moduleCode, saved.setup, null, Number(saved.risk?.rewardToRisk ?? 0));
    await notifyTenantOnce(
      session.tenant_id,
      `module3-setup-ready-${saved.setup.id}`,
      "MODULE3_SETUP_READY",
      `${alert.title} signal ready`,
      `${alert.body} | ${saved.setup.final_reason ?? "Valid Module 3 checklist matched."}`,
      "HIGH",
      alert.data,
      "validEntries"
    );
    paperTrade = settings.paperTradingEnabled
      ? await createAutomaticPaperTrade(session, saved.setup, saved.risk, current, moduleCode)
      : { skipped: true, reason: "PAPER_TRADING_DISABLED_BY_SETTINGS" };
  }
  const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
  return { sessionFound: true, setupId: saved?.setup?.id, setupStatus: saved?.setup?.status, evaluation: decision.scenario, paperTrade, tradeLifecycle };
}

export function evaluateVwapOpeningDrive(input: {
  now: string;
  symbol: string;
  candles: Candle[];
  sessionStartAt: string;
  sessionEndAt: string;
  spread?: number | null;
  newsStatus?: string;
  tradesTakenThisSession?: number;
  configuration?: any;
}) {
  const config = {
    openingDriveMinutes: 30,
    minimumDriveRangeATR: 1,
    minimumDriveBodyPercent: 0.55,
    minimumVwapDistanceATR: 0.05,
    pullbackMaxBars: 12,
    pullbackZoneAtr: 0.35,
    confirmationBodyPercent: 0.45,
    emaPeriod: 20,
    minimumRiskReward: 2,
    maximumStopATR: 1.35,
    stopBufferATR: 0.12,
    maximumSpread: 0.8,
    enableNewsFilter: true,
    minimumSignalScore: 80,
    maximumTradesPerSession: 1,
    ...(input.configuration ?? {})
  };
  const candles = [...input.candles].filter((candle) => Number.isFinite(candle.close)).sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
  const current = candles.at(-1);
  const evaluations: any[] = [];
  const flags: Record<string, unknown> = {};
  const push = (ruleCode: string, name: string, passed: boolean, blocking: boolean, actual: unknown, required: unknown, explanation: string) => evaluations.push({
    ruleCode,
    name,
    status: passed ? "PASS" : "FAIL",
    blocking,
    source: "AUTOMATIC",
    actualValue: actual == null ? null : String(actual),
    requiredValue: required == null ? null : String(required),
    explanation
  });
  if (!current || candles.length < 25) {
    return module3Decision("WAITING_FOR_DATA", null, "WAIT", "Waiting for enough 5M candles to evaluate VWAP opening-drive pullback.", evaluations, flags);
  }
  const nowTime = new Date(current.timestampUtc).getTime();
  const sessionStart = new Date(input.sessionStartAt).getTime();
  const sessionEnd = new Date(input.sessionEndAt).getTime();
  const sessionActive = nowTime >= sessionStart && nowTime <= sessionEnd;
  const tradeLimitOk = Number(input.tradesTakenThisSession ?? 0) < Number(config.maximumTradesPerSession ?? 1);
  const spreadOk = input.spread == null || input.spread <= config.maximumSpread;
  const newsOk = !config.enableNewsFilter || !String(input.newsStatus ?? "CLEAR").includes("BLOCKED");
  push("NY_SESSION_ACTIVE", "New York session active", sessionActive, true, newYorkClock(current.timestampUtc), `${config.newYorkStartTime ?? "09:30"}-${config.newYorkEndTime ?? "16:00"}`, "Module 3 only trades during its New York VWAP window.");
  push("DAILY_TRADE_LIMIT", "Daily trade limit not reached", tradeLimitOk, true, input.tradesTakenThisSession ?? 0, `< ${config.maximumTradesPerSession}`, "Only one automatic Module 3 paper trade is allowed per session by default.");
  if (!sessionActive || !tradeLimitOk) return module3Decision("HARD_RULE_BLOCK", null, "BLOCKED", "Module 3 hard rules failed before opening-drive evaluation.", evaluations, flags);

  const atr = averageRange(candles.slice(-20));
  const driveEnd = new Date(sessionStart + Number(config.openingDriveMinutes) * 60_000).toISOString();
  const driveCandles = candles.filter((candle) => candle.timestampUtc >= input.sessionStartAt && candle.timestampUtc <= driveEnd);
  const drive = driveCandles.length > 0 ? {
    start: driveCandles[0],
    end: driveCandles.at(-1)!,
    high: Math.max(...driveCandles.map((candle) => candle.high)),
    low: Math.min(...driveCandles.map((candle) => candle.low)),
    open: driveCandles[0].open,
    close: driveCandles.at(-1)!.close
  } : null;
  const driveRange = drive ? drive.high - drive.low : 0;
  const driveBody = drive ? Math.abs(drive.close - drive.open) : 0;
  const driveDirection = drive && drive.close > drive.open ? "LONG" : drive && drive.close < drive.open ? "SHORT" : null;
  const driveStrong = Boolean(drive && atr > 0 && driveRange / atr >= config.minimumDriveRangeATR && driveBody / Math.max(driveRange, 0.00001) >= config.minimumDriveBodyPercent);
  push("OPENING_DRIVE_COMPLETE", "Opening drive complete", Boolean(drive && nowTime > new Date(driveEnd).getTime()), true, driveCandles.length, `after ${config.openingDriveMinutes} minutes`, "The initial NY impulse window must complete before pullback entries.");
  push("OPENING_DRIVE_STRONG", "Opening drive strength", driveStrong, true, atr > 0 ? Number((driveRange / atr).toFixed(2)) : null, `>= ${config.minimumDriveRangeATR} ATR`, "The opening drive must show real range expansion and body commitment.");
  if (!drive || nowTime <= new Date(driveEnd).getTime()) return module3Decision("WAITING_FOR_OPENING_DRIVE", null, "WAIT", "Waiting for the NY opening drive to complete.", evaluations, { ...flags, drive });
  if (!driveStrong || !driveDirection) return module3Decision("NO_STRONG_OPENING_DRIVE", null, "NO TRADE", "No strong opening drive is available for Module 3.", evaluations, { ...flags, drive });

  const vwap = volumeWeightedAverage(candles.filter((candle) => candle.timestampUtc >= input.sessionStartAt && candle.timestampUtc <= current.timestampUtc));
  const ema = simpleEma(candles.map((candle) => candle.close), Number(config.emaPeriod));
  const direction = driveDirection;
  const vwapAligned = direction === "LONG" ? current.close > vwap + atr * config.minimumVwapDistanceATR : current.close < vwap - atr * config.minimumVwapDistanceATR;
  const trendAligned = direction === "LONG" ? current.close >= ema : current.close <= ema;
  const pullbackRows = candles.filter((candle) => candle.timestampUtc > driveEnd).slice(-Number(config.pullbackMaxBars));
  const zoneLow = direction === "LONG" ? Math.min(vwap, ema) - atr * config.pullbackZoneAtr : Math.min(vwap, ema);
  const zoneHigh = direction === "LONG" ? Math.max(vwap, ema) : Math.max(vwap, ema) + atr * config.pullbackZoneAtr;
  const pullbackTouched = pullbackRows.some((candle) => candle.low <= zoneHigh && candle.high >= zoneLow);
  const confirmation = confirmsModule3(current, direction, Number(config.confirmationBodyPercent));
  push("VWAP_ALIGNMENT", "VWAP alignment", vwapAligned, true, Number(current.close.toFixed(2)), direction === "LONG" ? `> ${vwap.toFixed(2)}` : `< ${vwap.toFixed(2)}`, "Price must be on the correct side of VWAP after the drive.");
  push("EMA_ALIGNMENT", "20 EMA alignment", trendAligned, false, Number(current.close.toFixed(2)), direction === "LONG" ? `>= ${ema.toFixed(2)}` : `<= ${ema.toFixed(2)}`, "EMA alignment confirms continuation context.");
  push("PULLBACK_ZONE_TOUCHED", "Pullback zone touched", pullbackTouched, true, `${zoneLow.toFixed(2)}-${zoneHigh.toFixed(2)}`, "VWAP/EMA zone", "Price must pull back into the VWAP/EMA value zone.");
  push("CONFIRMATION_CANDLE", "Confirmation candle", confirmation, true, current.close > current.open ? "BULLISH" : current.close < current.open ? "BEARISH" : "DOJI", direction, "A completed candle must confirm continuation away from the pullback zone.");
  const entry = current.close;
  const stop = direction === "LONG" ? Math.min(zoneLow, current.low) - atr * config.stopBufferATR : Math.max(zoneHigh, current.high) + atr * config.stopBufferATR;
  const target = direction === "LONG" ? entry + Math.abs(entry - stop) * config.minimumRiskReward : entry - Math.abs(entry - stop) * config.minimumRiskReward;
  const rr = Math.abs(target - entry) / Math.max(0.00001, Math.abs(entry - stop));
  const stopAtr = Math.abs(entry - stop) / Math.max(atr, 0.00001);
  const rrOk = rr >= config.minimumRiskReward;
  const stopOk = stopAtr <= config.maximumStopATR;
  push("QUALITY_SPREAD", "Spread filter", spreadOk, false, input.spread ?? "unknown", `<= ${config.maximumSpread}`, "Spread must be acceptable for XAUUSD paper entry.");
  push("QUALITY_NEWS", "No high-impact news", newsOk, false, input.newsStatus ?? "CLEAR", "CLEAR", "High-impact news blocks automatic Module 3 entries.");
  push("QUALITY_RR", "Minimum RR 2:1", rrOk, true, Number(rr.toFixed(2)), `>= ${config.minimumRiskReward}`, "Reward-to-risk must meet the configured minimum.");
  push("QUALITY_STOP_SIZE", "Maximum stop size", stopOk, false, Number(stopAtr.toFixed(2)), `<= ${config.maximumStopATR} ATR`, "Stop distance must not be too large after the pullback.");
  const confirmationCount = [vwapAligned, trendAligned, pullbackTouched, confirmation, spreadOk, newsOk, rrOk, stopOk].filter(Boolean).length;
  const score = Math.min(100, Math.round(35 + (driveStrong ? 15 : 0) + confirmationCount * 7));
  const blockingPassed = evaluations.filter((row) => row.blocking).every((row) => row.status === "PASS");
  const scoreOk = score >= config.minimumSignalScore;
  push("SIGNAL_SCORE", "Minimum signal score", scoreOk, true, score, `>= ${config.minimumSignalScore}`, "Module 3 requires a high-quality opening-drive pullback score.");
  flags.drive = drive;
  flags.vwap = vwap;
  flags.ema = ema;
  flags.entryZone = { low: zoneLow, high: zoneHigh, midpoint: (zoneLow + zoneHigh) / 2, kind: "VWAP_PULLBACK_ZONE" };
  flags.riskReward = rr;
  flags.state = blockingPassed && scoreOk ? "SIGNAL_ACTIVE" : "WAITING_FOR_PULLBACK_CONFIRMATION";
  if (!blockingPassed || !scoreOk) {
    return module3Decision("VWAP_PULLBACK_NOT_READY", direction, "WAIT", "Waiting for VWAP pullback checklist to fully match.", evaluations, flags, score);
  }
  return {
    scenario: direction === "LONG" ? "NY_VWAP_OPENING_DRIVE_PULLBACK_BUY" : "NY_VWAP_OPENING_DRIVE_PULLBACK_SELL",
    direction,
    status: direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY",
    state: "SIGNAL_ACTIVE",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    finalReason: `Module 3 ${direction === "LONG" ? "BUY" : "SELL"} passed opening drive, VWAP alignment, pullback, confirmation candle, and ${rr.toFixed(2)}R plan.`,
    evaluations,
    scenarioFlags: flags,
    favorabilityScore: score,
    favorabilityGrade: score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : "C",
    favorabilityReasons: ["NY opening drive confirmed", "VWAP continuation aligned", "Pullback zone respected", `Risk-reward ${rr.toFixed(2)}R`]
  };
}

function module3Decision(scenario: string, direction: string | null, status: string, reason: string, evaluations: any[], flags: Record<string, unknown>, score = 0) {
  return {
    scenario,
    direction,
    status,
    state: status === "BLOCKED" || status === "NO TRADE" ? "INVALIDATED" : "WAITING_FOR_PULLBACK_CONFIRMATION",
    finalReason: reason,
    evaluations,
    scenarioFlags: { ...flags, state: status },
    favorabilityScore: score,
    favorabilityGrade: score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : "C",
    favorabilityReasons: [reason]
  };
}

function averageRange(candles: Candle[]) {
  if (candles.length === 0) return 0.01;
  return candles.reduce((sum, candle) => sum + Math.max(0.01, candle.high - candle.low), 0) / candles.length;
}

function volumeWeightedAverage(candles: Candle[]) {
  const totals = candles.reduce((acc, candle) => {
    const volume = Number(candle.volume ?? 1) || 1;
    const typical = (candle.high + candle.low + candle.close) / 3;
    return { pv: acc.pv + typical * volume, volume: acc.volume + volume };
  }, { pv: 0, volume: 0 });
  return totals.volume > 0 ? totals.pv / totals.volume : candles.at(-1)?.close ?? 0;
}

function simpleEma(values: number[], period: number) {
  const rows = values.slice(-Math.max(2, period));
  const multiplier = 2 / (rows.length + 1);
  return rows.reduce((ema, value, index) => index === 0 ? value : value * multiplier + ema * (1 - multiplier), rows[0] ?? 0);
}

function confirmsModule3(candle: Candle, direction: string, minimumBodyPercent: number) {
  const range = Math.max(0.00001, candle.high - candle.low);
  const body = Math.abs(candle.close - candle.open);
  const bodyOk = body / range >= minimumBodyPercent;
  return direction === "LONG" ? candle.close > candle.open && bodyOk : candle.close < candle.open && bodyOk;
}

function newYorkClock(timestampUtc: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestampUtc));
}

async function processLiquiditySweepSession(symbol: string, timeframe: number, liveCandles = getCachedCandles(symbol, timeframe), tenantId?: string | null) {
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
    const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
    return { sessionFound: true, evaluation: "ALREADY_EVALUATED", tradeLifecycle };
  }

  const startLookback = new Date(new Date(session.session_start_at).getTime() - 30 * 60_000).toISOString();
  const setupRows = cachedCandlesBetween(liveCandles, startLookback, current.timestamp_utc);
  const fallbackSetupRows =
    setupRows.length > 0
      ? setupRows
      : (
          await query(
            `SELECT timestamp_utc, open, high, low, close, volume, spread
             FROM candles
             WHERE symbol = $1
               AND timeframe_minutes = $2
               AND timestamp_utc >= $3
               AND timestamp_utc <= $4
             ORDER BY timestamp_utc ASC
             LIMIT 300`,
            [symbol, timeframe, startLookback, current.timestamp_utc]
          )
        ).rows;
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
            [symbol, current.timestamp_utc]
          )
        ).rows.reverse();
  const tradesTaken = await tradesTakenForSession(session.id, moduleCode);
  const configuration = await getTenantModuleStrategyConfiguration(activeTenantId, moduleCode, "liquiditySweep.strategy", session.configuration_json);
  const configVersion = await module2ConfigSnapshot(activeTenantId);
  const decision = evaluateLiquiditySweepSetup({
    now: current.timestamp_utc,
    symbol,
    setupCandles: uniqueCandleRows([...fallbackSetupRows, current]).map(toCandle),
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
  await notifyModule2Stage(session, decision);
  await applyModule2SetupLifecycle(saved?.setup, decision, current);
  let paperTrade = null;
  if (isProductionReadySetup(saved?.setup, decision)) {
    await saveSetupCandleSnapshot(saved.setup, session, timeframe, liveCandles, current);
    const alert = entryAlertDetails(moduleCode, saved.setup, null, Number(saved.risk?.rewardToRisk ?? 0));
    await notifyTenantOnce(
      session.tenant_id,
      `module2-setup-ready-${saved.setup.id}`,
      "MODULE2_SETUP_READY",
      `${alert.title} signal ready`,
      `${alert.body} | ${saved.setup.final_reason ?? "Valid Module 2 checklist matched."}`,
      "HIGH",
      alert.data,
      "validEntries"
    );
    paperTrade = settings.paperTradingEnabled
      ? await createAutomaticPaperTrade(session, saved.setup, saved.risk, current, moduleCode)
      : { skipped: true, reason: "PAPER_TRADING_DISABLED_BY_SETTINGS" };
  }
  const tradeLifecycle = await processOpenPaperTrades(symbol, timeframe, current, activeTenantId, moduleCode);
  return { sessionFound: true, setupId: saved?.setup?.id, setupStatus: saved?.setup?.status, evaluation: decision.state, paperTrade, tradeLifecycle };
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
    wouldOpenPaperTrade: isProductionReadySetup({ module_code: "high_probability_strategy_2", status: decision.status, scenario: decision.scenario, scenario_flags: decision.scenarioFlags }, decision),
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
    healthIssue("ACTIVE_TRADE_OPEN_TOO_LONG", "Active trade open too long", Number(activeTradeAge.rows[0]?.age_seconds ?? 0) > 3 * 60 * 60, "HIGH", "A Module 2 paper trade has been active for more than 3 hours."),
    healthIssue("REPEATED_FEED_ERRORS", "Repeated feed errors", Number(recentFeedErrors.rows[0]?.count ?? 0) >= 3, "HIGH", `${recentFeedErrors.rows[0]?.count ?? 0} Twelve Data errors in the last 30 minutes.`),
    healthIssue("PRODUCTION_AUDIT_FAILED", "Production audit failed", Number(auditFailures.rows[0]?.count ?? 0) > 0, "CRITICAL", "A Module 2 production audit failure notification is still unacknowledged."),
    healthIssue("TUNING_PRESET_CHANGED", "Tuning preset changed", Boolean(latestPromotion.rows[0] && new Date(latestPromotion.rows[0].applied_at).getTime() > Date.now() - 24 * 60 * 60_000), "NORMAL", latestPromotion.rows[0] ? `${latestPromotion.rows[0].action} ${latestPromotion.rows[0].preset_code}.` : "")
  ].filter((issue) => issue.active);
  if (createAlerts) {
    for (const issue of issues) {
      await notifyTenantOnce(tenantId, `module2-health-${issue.code}-${new Date().toISOString().slice(0, 10)}`, `MODULE2_${issue.code}`, issue.title, issue.body, issue.severity);
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

async function buildModule3DataReadiness(tenantId: string | null, symbol: string, cacheDays = LIVE_CANDLE_CACHE_DAYS) {
  const moduleCode = "strategy_lab_3";
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
      status: totalAvailable >= 25 ? "READY" : totalAvailable > 0 ? "PARTIAL" : "MISSING"
    });
  }
  const availableCandles = Math.max(cached.length, Number(dbRow.count ?? 0));
  const availableSessions = coverage.filter((row) => row.status === "READY").length;
  const latestBacktest = await query(
    `SELECT id, status, summary, completed_at
     FROM backtest_runs
     WHERE tenant_id = $1 AND module_code = $2
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId, moduleCode]
  );
  return {
    moduleCode,
    symbol,
    timeframeMinutes: timeframe,
    generatedAt: new Date().toISOString(),
    readiness: module3DataReadinessGrade(availableCandles, availableSessions),
    apiEstimate: {
      startupBackfillCandles: TWELVE_DATA_STARTUP_BACKFILL_COUNT,
      estimatedCreditsPerBackfill: 1,
      note: "One Twelve Data time_series call requests up to 100 recent 5-minute candles shared by all active XAUUSD modules."
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

function module3DataReadinessGrade(candles: number, sessions: number) {
  if (candles >= 1500 && sessions >= 10) {
    return { grade: "CONFIDENCE_READY", label: "Enough for confidence report", canBacktest: true, reason: "Enough 5-minute candle coverage for a stronger Module 3 confidence read." };
  }
  if (candles >= 500 && sessions >= 4) {
    return { grade: "RESEARCH_READY", label: "Enough for research", canBacktest: true, reason: "Enough candles for early VWAP opening-drive backtesting, but not enough for strong statistical confidence." };
  }
  if (candles >= 100 && sessions >= 1) {
    return { grade: "QA_READY", label: "Enough for QA", canBacktest: true, reason: "Enough candles to test Module 3 backtest and setup behavior." };
  }
  return { grade: "NOT_ENOUGH_DATA", label: "Not enough data", canBacktest: false, reason: "Collect at least one NY session of 5-minute candles before trusting Module 3 backtests." };
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

function healthIssue(code: string, title: string, active: boolean, severity: string, body: string) {
  return { code, title, active, severity, body };
}

function checkReadinessStatus(readiness: any, code: string) {
  return readiness.checks?.find((check: any) => check.code === code)?.status ?? "--";
}

function checkReadinessValue(readiness: any, code: string) {
  return readiness.checks?.find((check: any) => check.code === code)?.value ?? null;
}

function isProductionReadySetup(setup: any, decision: any) {
  if (!setup || !["high_probability_strategy_2", "strategy_lab_3"].includes(setup.module_code)) return false;
  if (!["LONG SETUP READY", "SHORT SETUP READY"].includes(String(setup.status))) return false;
  if (setup.scenario === "QA_TEST_SIGNAL") return false;
  if (setup.scenario_flags?.replay === true) return false;
  const blockingRules = decision?.evaluations?.filter((evaluation: any) => evaluation.blocking) ?? [];
  return blockingRules.length > 0 && blockingRules.every((evaluation: any) => evaluation.status === "PASS");
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
  if (setup.scenario === "QA_TEST_SIGNAL" || setup.scenario_flags?.replay === true) {
    return { skipped: true, reason: "TEST_SIGNAL_NOT_PRODUCTION" };
  }

  const existing = await query(
    `SELECT t.id, t.outcome, tp.status
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.session_id = $1
       AND sc.module_code = $2
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
     LIMIT 1`,
    [session.id, moduleCode]
  );
  if (existing.rows[0]) {
    return { skipped: true, reason: "ONE_TRADE_PER_SESSION", tradeId: existing.rows[0].id };
  }

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

async function lockOpeningRangeForSession(session: any, timeframe: number, liveCandles = getCachedCandles(session.symbol, timeframe)) {
  const cachedRows = cachedCandlesBetween(liveCandles, session.session_start_at, session.opening_range_end_at, { exclusiveEnd: true });
  const candlesResult =
    cachedRows.length > 0
      ? { rows: cachedRows }
      : await query(
          `SELECT timestamp_utc, open, high, low, close, volume, spread
           FROM candles
           WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc < $4
           ORDER BY timestamp_utc`,
          [session.symbol, timeframe, session.session_start_at, session.opening_range_end_at]
        );
  const candles: Candle[] = candlesResult.rows.map((row: any) => ({
    timestampUtc: row.timestamp_utc,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume == null ? null : Number(row.volume),
    spread: row.spread == null ? null : Number(row.spread)
  }));
  const expectedCount = Math.ceil(Number(session.opening_range_minutes ?? 15) / timeframe);
  const range = buildOpeningRange(candles, 0.01, expectedCount);
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

async function evaluateAndSaveSetup(session: any, range: any, currentRow: any, previousRows: any[]) {
  const profile = await query(
    `SELECT rp.*, bs.contract_size, bs.tick_size, bs.tick_value, bs.minimum_lot, bs.lot_step, bs.maximum_lot, bs.commission_per_lot
     FROM risk_profiles rp
     JOIN broker_specs bs ON bs.symbol = $1
     WHERE rp.is_active = true
       AND rp.tenant_id = $2
     ORDER BY rp.created_at DESC
     LIMIT 1`,
    [session.symbol, session.tenant_id]
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
  const risk = calculateRisk({
    accountBalance: Number(row.account_balance),
    accountEquity: Number(row.account_equity),
    riskPerTradePercent: Number(row.risk_per_trade_percent),
    entry,
    stop: Number(stop),
    target,
    contractSize: Number(row.contract_size ?? 100),
    tickSize: Number(row.tick_size ?? 0.01),
    tickValue: Number(row.tick_value ?? 1),
    minimumLot: Number(row.minimum_lot ?? 0.01),
    lotStep: Number(row.lot_step ?? 0.01),
    maximumLot: Number(row.maximum_lot ?? 50),
    spread: Number(currentCandle.spread ?? 0),
    commissionPerLot: Number(row.commission_per_lot ?? 0),
    minimumRewardToRisk: Number(row.minimum_reward_to_risk),
    maximumDailyLossPercent: Number(row.maximum_daily_loss_percent),
    maximumWeeklyLossPercent: Number(row.maximum_weekly_loss_percent)
  });
  const configuration = await getTenantOrbStrategyConfiguration(session.tenant_id, session.configuration_json);
  const decision = evaluateSetup({
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
    riskStatus: risk.status,
    configuration: configuration as any
  });
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
  await query("UPDATE strategy_versions SET generated_signal_count = generated_signal_count + 1 WHERE id = $1", [session.strategy_version_id]);
  return { setup: saved.rows[0], decision, risk };
}

async function calculateDecisionRisk(session: any, decision: any, currentRow: any) {
  if (decision.entryPrice == null || decision.stopPrice == null || decision.targetPrice == null) return null;
  const profile = await query(
    `SELECT rp.*, bs.contract_size, bs.tick_size, bs.tick_value, bs.minimum_lot, bs.lot_step, bs.maximum_lot, bs.commission_per_lot
     FROM risk_profiles rp
     JOIN broker_specs bs ON bs.symbol = $1
     WHERE rp.is_active = true
       AND rp.tenant_id = $2
     ORDER BY rp.created_at DESC
     LIMIT 1`,
    [session.symbol, session.tenant_id]
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
    contractSize: Number(row.contract_size ?? 100),
    tickSize: Number(row.tick_size ?? 0.01),
    tickValue: Number(row.tick_value ?? 1),
    minimumLot: Number(row.minimum_lot ?? 0.01),
    lotStep: Number(row.lot_step ?? 0.01),
    maximumLot: Number(row.maximum_lot ?? 50),
    spread: Number(currentRow.spread ?? 0),
    commissionPerLot: Number(row.commission_per_lot ?? 0),
    minimumRewardToRisk: Number(row.minimum_reward_to_risk),
    maximumDailyLossPercent: Number(row.maximum_daily_loss_percent),
    maximumWeeklyLossPercent: Number(row.maximum_weekly_loss_percent)
  });
}

async function tradesTakenForSession(sessionId: string, moduleCode: string) {
  const { rows } = await query(
    `SELECT count(*)::int AS count
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.session_id = $1
       AND sc.module_code = $2
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
    [sessionId, moduleCode]
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

async function syncBrokerSpecs(symbol: string) {
  const info = await fetchJson<Mt5SymbolInfo>(`${config.quantBaseUrl}/market-data/mt5/symbol-info/${encodeURIComponent(symbol)}`);
  if (info.connected === false || info.error) return { synced: false, error: info.error };
  const { rows } = await query(
    `UPDATE broker_specs SET
      contract_size = COALESCE($2, contract_size),
      minimum_lot = COALESCE($3, minimum_lot),
      lot_step = COALESCE($4, lot_step),
      maximum_lot = COALESCE($5, maximum_lot),
      tick_size = COALESCE($6, tick_size),
      tick_value = COALESCE($7, tick_value),
      updated_at = now()
     WHERE symbol = $1
     RETURNING *`,
    [symbol, info.contract_size ?? null, info.minimum_lot ?? null, info.lot_step ?? null, info.maximum_lot ?? null, info.tick_size ?? null, info.tick_value ?? null]
  );
  return { synced: rows.length > 0, specs: rows[0] ?? null };
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
  const inserted = await query(
    `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
     VALUES ($5,$1,$2,$3,$4,$6)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [eventKey, eventType, title, body, tenantId, priority]
  );
  if (inserted.rows[0]) {
    await sendTenantPush({ tenantId, title, body, eventKey, eventType, preferenceKey, data: { ...data, eventKey, eventType, notificationId: inserted.rows[0].id } });
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
  const grade = setup.favorability_grade ?? setup.scenario_flags?.tradeGrade ?? setup.scenario_flags?.grade ?? null;
  const confidence = setup.favorability_score ?? setup.scenario_flags?.confidence ?? null;
  const rr = Number.isFinite(rewardToRisk) ? rewardToRisk.toFixed(2) : "--";
  const title = `${moduleName}: ${action} ${direction}`;
  const bodyParts = [
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
      symbol: setup.symbol ?? "XAUUSD"
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
       AND m.code IN ('orb_max_options', 'high_probability_strategy_2', 'strategy_lab_3')
     ORDER BY t.created_at, m.sort_order`
  );
  return rows;
}

function tenantStateKey(tenantId: string, moduleCode: string) {
  return `${tenantId}:${moduleCode}`;
}

function moduleDisplayName(moduleCode: string) {
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Liquidity Sweep + BOS";
  if (moduleCode === "strategy_lab_3") return "Module 3 VWAP Opening Drive";
  return "Module 1 ORB MAX";
}

function moduleTimeframeMinutes(moduleCode: string, settings: RuntimeSettings) {
  return moduleCode === "high_probability_strategy_2" || moduleCode === "strategy_lab_3" ? 5 : settings.timeframeMinutes;
}

async function activeStrategyVersionForModule(moduleCode: string) {
  const { rows } = await query(
    `SELECT sv.*
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE sv.status = 'ACTIVE'
       AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = $1
     ORDER BY sv.activated_at DESC NULLS LAST, sv.created_at DESC
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
