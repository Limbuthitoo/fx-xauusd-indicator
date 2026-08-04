import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InjectPayload } from "light-my-request";
import { redisClient } from "../../infrastructure/redis/client.js";
import { query } from "../../infrastructure/db/client.js";
import { requirePermission } from "../auth/routes.js";

const MODULE_CODES = ["orb_max_options", "high_probability_strategy_2", "strategy_lab_3"];

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/bundle", async (request) => {
    const search = request.query as { moduleCode?: string; section?: string; symbol?: string; timeframeMinutes?: string; notificationQuery?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const section = search.section ?? "live";
    const symbol = search.symbol ?? "XAUUSD";
    const timeframeMinutes = Number(search.timeframeMinutes ?? 5);
    const notificationQuery = search.notificationQuery ? decodeURIComponent(search.notificationQuery) : "";
    const needsCommand = section === "command";
    const needsStrategy = section === "orb";
    const needsReports = section === "reports";
    const needsLearning = section === "learning";
    const needsNotifications = section === "notifications";
    const needsPaper = section === "paper";
    const needsSignals = section === "signals";
    const needsSettings = section === "settings";
    const needsData = section === "data" || section === "health";
    const needsLive = section === "live";
    const needsModuleOps = needsCommand || needsStrategy || needsReports || needsLearning || needsData;
    const isModule1 = moduleCode === "orb_max_options";
    const isModule2 = moduleCode === "high_probability_strategy_2";
    const isModule3 = moduleCode === "strategy_lab_3";
    const needsModule2LiveOps = isModule2 && needsLive;

    const [
      clocks,
      session,
      strategies,
      analytics,
      orbAdmin,
      currentSetup,
      moduleCommand,
      automationStatus,
      feedStatus,
      twelveStatus,
      cacheStatus,
      newsStatus,
      tradePlan,
      currentTrade,
      weeklyReport,
      monthlyReport,
      latestBacktest,
      orbDataReadiness,
      orbRangeAudit,
      orbRehearsals,
      module2JournalTrades,
      module2Audit,
      module2Readiness,
      module2TuningHistory,
      module2Health,
      module2DataReadiness,
      module2Operator,
      module2Rehearsals,
      module2Learning,
      module2LearningReviews,
      module2SessionReports,
      module2Closeouts,
      module3JournalTrades,
      module3DataReadiness,
      module3Learning,
      module3SessionReports,
      module3SetupHistory,
      module3Rehearsals,
      strategyConfidence,
      productionReadiness,
      notifications,
      notificationSummary,
      settings,
      orbModuleSettings,
      auditLogs,
      orbLearning,
      tenantContext,
      activeModuleSettings,
      tenantPushStatus,
      paperTrading,
      tradeSignals
    ] = await Promise.all([
      injectJson(app, request, "GET", "/api/clocks", undefined),
      injectJson(app, request, "POST", "/api/sessions/current/refresh-state", { moduleCode }),
      injectJson(app, request, "GET", "/api/strategies", undefined, []),
      injectJson(app, request, "GET", `/api/analytics/overview?moduleCode=${moduleCode}`, undefined),
      needsReports || needsCommand ? injectJson(app, request, "GET", `/api/admin/orb-performance?moduleCode=${moduleCode}`, undefined) : null,
      injectJson(app, request, "GET", `/api/setups/current?moduleCode=${moduleCode}`, undefined),
      needsCommand ? commandSnapshots(app, request) : [],
      injectJson(app, request, "GET", `/api/tenant/automation/status?moduleCode=${moduleCode}`, undefined),
      injectJson(app, request, "GET", `/api/market-data/live/status?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}`, undefined),
      injectJson(app, request, "GET", "/api/market-data/twelve-data/live/status", undefined),
      injectJson(app, request, "GET", `/api/market-data/live/cache?symbol=${symbol}&timeframeMinutes=${timeframeMinutes}&limit=1`, undefined),
      injectJson(app, request, "GET", "/api/news/status", undefined),
      injectJson(app, request, "GET", `/api/trade-plans/current?moduleCode=${moduleCode}`, undefined),
      injectJson(app, request, "GET", `/api/trades/current?moduleCode=${moduleCode}`, undefined),
      needsReports ? injectJson(app, request, "GET", `/api/reports/weekly?moduleCode=${moduleCode}`, undefined, []) : [],
      needsReports ? injectJson(app, request, "GET", `/api/reports/monthly?moduleCode=${moduleCode}`, undefined, []) : [],
      needsReports || needsLearning ? injectJson(app, request, "GET", `/api/backtests/latest?moduleCode=${moduleCode}`, undefined) : null,
      isModule1 && needsData ? injectJson(app, request, "GET", "/api/orb/data-readiness", undefined) : null,
      isModule1 ? injectJson(app, request, "GET", "/api/sessions/current/orb-range-audit", undefined) : null,
      isModule1 && needsModuleOps ? injectJson(app, request, "GET", "/api/module1/launch-rehearsals", undefined, []) : [],
      isModule2 && needsModuleOps ? injectJson(app, request, "GET", "/api/module2/journal/trades?limit=25", undefined, []) : [],
      isModule2 && (needsModuleOps || needsModule2LiveOps) ? injectJson(app, request, "GET", "/api/module2/production-audit", undefined) : null,
      isModule2 && (needsModuleOps || needsModule2LiveOps) ? injectJson(app, request, "GET", "/api/module2/readiness", undefined) : null,
      isModule2 && needsLearning ? injectJson(app, request, "GET", "/api/backtests/module2/tuning-promotions", undefined, []) : [],
      isModule2 && (needsModuleOps || needsModule2LiveOps) ? injectJson(app, request, "GET", "/api/module2/health", undefined) : null,
      isModule2 && needsData ? injectJson(app, request, "GET", "/api/module2/data-readiness", undefined) : null,
      isModule2 && (needsModuleOps || needsModule2LiveOps) ? injectJson(app, request, "GET", "/api/module2/operator", undefined) : null,
      isModule2 && (needsModuleOps || needsModule2LiveOps) ? injectJson(app, request, "GET", "/api/module2/launch-rehearsals", undefined, []) : [],
      isModule2 && needsLearning ? injectJson(app, request, "GET", "/api/module2/learning/latest", undefined) : null,
      isModule2 && needsLearning ? injectJson(app, request, "GET", "/api/module2/learning/reviews", undefined, []) : [],
      isModule2 && needsReports ? injectJson(app, request, "GET", "/api/module2/session-reports", undefined, []) : [],
      isModule2 && needsReports ? injectJson(app, request, "GET", "/api/module2/closeouts", undefined, []) : [],
      isModule3 && needsModuleOps ? injectJson(app, request, "GET", "/api/modules/strategy_lab_3/journal/trades?limit=25", undefined, []) : [],
      isModule3 && needsData ? injectJson(app, request, "GET", "/api/module3/data-readiness", undefined) : null,
      isModule3 && needsLearning ? injectJson(app, request, "GET", "/api/module3/learning/latest", undefined) : null,
      isModule3 && needsReports ? injectJson(app, request, "GET", "/api/module3/session-reports", undefined, []) : [],
      isModule3 && needsStrategy ? injectJson(app, request, "GET", "/api/setups/history?moduleCode=strategy_lab_3&limit=50", undefined, []) : [],
      isModule3 && needsModuleOps ? injectJson(app, request, "GET", "/api/module3/launch-rehearsals", undefined, []) : [],
      needsCommand ? injectJson(app, request, "GET", "/api/analytics/modules/confidence", undefined) : null,
      needsCommand ? injectJson(app, request, "GET", "/api/analytics/production-readiness", undefined) : null,
      needsNotifications ? injectJson(app, request, "GET", `/api/notifications?limit=50${notificationQuery}`, undefined, []) : [],
      needsNotifications ? injectJson(app, request, "GET", "/api/notifications/summary", undefined, []) : [],
      needsSettings ? injectJson(app, request, "GET", "/api/tenant/settings", undefined, []) : [],
      needsSettings ? injectJson(app, request, "GET", "/api/tenant/modules/orb_max_options/settings", undefined, []) : [],
      needsSettings ? injectJson(app, request, "GET", "/api/admin/audit-logs", undefined, []) : [],
      needsLearning ? injectJson(app, request, "GET", "/api/admin/orb-learning/latest", undefined) : null,
      injectJson(app, request, "GET", "/api/tenant/context", undefined),
      needsSettings ? injectJson(app, request, "GET", `/api/tenant/modules/${moduleCode}/settings`, undefined, []) : [],
      section === "account" || needsSettings ? injectJson(app, request, "GET", "/api/mobile/push-status", undefined, null) : null,
      needsPaper ? injectJson(app, request, "GET", "/api/trades/paper?limit=500", undefined, { summary: {}, trades: [] }) : null,
      needsSignals ? injectJson(app, request, "GET", "/api/setups/signals?limit=100", undefined, { summary: {}, signals: [] }) : null
    ]);

    const sessionReview = session?.id ? await injectJson(app, request, "GET", `/api/sessions/${session.id}/review`, undefined) : undefined;
    return { clocks, session, strategies, analytics, orbAdmin, currentSetup, moduleCommand, automationStatus, feedStatus, twelveStatus, cacheStatus, newsStatus, tradePlan, currentTrade, sessionReview, weeklyReport, monthlyReport, latestBacktest, orbDataReadiness, orbRangeAudit, orbRehearsals, module2JournalTrades, module2Audit, module2Readiness, module2TuningHistory, module2Health, module2DataReadiness, module2Operator, module2Rehearsals, module2Learning, module2LearningReviews, module2SessionReports, module2Closeouts, module3JournalTrades, module3DataReadiness, module3Learning, module3SessionReports, module3SetupHistory, module3Rehearsals, strategyConfidence, productionReadiness, notifications, notificationSummary, settings, orbModuleSettings, activeModuleSettings, auditLogs, orbLearning, tenantContext, tenantPushStatus, paperTrading, tradeSignals };
  });

  app.get("/api/platform/bundle", async (request) => {
    const session = requirePermission(request, "platform.manage");
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const cacheKey = "platform:bundle:v1";
    const client = redisClient();
    const cached = client ? await client.get(cacheKey).catch(() => null) : null;
    if (cached) return JSON.parse(cached);
    const [platform, platformAutomation, platformUsage, platformSystemHealth, platformSecurityAudit, platformOperationalEvents, platformBackupStatus, platformBusinessSettings, platformPushOverview, platformTickets, platformAppReleases, requestLoad] = await Promise.all([
      injectJson(app, request, "GET", "/api/platform/overview", undefined),
      injectJson(app, request, "GET", "/api/platform/automation/status", undefined, []),
      injectJson(app, request, "GET", "/api/platform/usage/twelve-data", undefined),
      injectJson(app, request, "GET", "/api/platform/system-health", undefined),
      injectJson(app, request, "GET", "/api/platform/security-audit", undefined),
      injectJson(app, request, "GET", "/api/platform/operational-events", undefined),
      injectJson(app, request, "GET", "/api/platform/backups/status", undefined),
      injectJson(app, request, "GET", "/api/platform/business-settings", undefined),
      injectJson(app, request, "GET", "/api/platform/push/overview", undefined),
      injectJson(app, request, "GET", "/api/platform/support-tickets", undefined, []),
      injectJson(app, request, "GET", "/api/platform/mobile-app/releases", undefined, []),
      platformRequestLoad()
    ]);
    const payload = { platform, platformAutomation, platformUsage, platformSystemHealth, platformSecurityAudit, platformOperationalEvents, platformBackupStatus, platformBusinessSettings, platformPushOverview, platformTickets, platformAppReleases, requestLoad, cachedAt: new Date().toISOString() };
    if (client) await client.set(cacheKey, JSON.stringify(payload), "EX", 5).catch(() => undefined);
    return payload;
  });
}

async function commandSnapshots(app: FastifyInstance, request: FastifyRequest) {
  return Promise.all(MODULE_CODES.map(async (moduleCode) => {
    const [setup, trade] = await Promise.all([
      injectJson(app, request, "GET", `/api/setups/current?moduleCode=${moduleCode}`, undefined, null),
      injectJson(app, request, "GET", `/api/trades/current?moduleCode=${moduleCode}`, undefined, null)
    ]);
    return { moduleCode, setup, trade };
  }));
}

async function injectJson(app: FastifyInstance, request: FastifyRequest, method: "GET" | "POST", url: string, payload?: unknown, fallback: unknown = undefined) {
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: request.headers.authorization ?? "",
      cookie: request.headers.cookie ?? ""
    },
    payload: payload as InjectPayload | undefined
  } as any);
  if (response.statusCode >= 400) return fallback;
  return response.json();
}

async function platformRequestLoad() {
  const { rows } = await query(
    `SELECT
       count(*)::int AS events,
       count(*) FILTER (WHERE event_type = 'API_REQUEST_SLOW')::int AS slow_requests,
       count(*) FILTER (WHERE event_type = 'API_REQUEST_FAILED')::int AS failed_requests,
       round(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms,
       max(duration_ms) AS max_duration_ms
     FROM operational_events
     WHERE category = 'API'
       AND created_at >= now() - interval '15 minutes'`
  );
  const top = await query(
    `SELECT route, method, count(*)::int AS events, round(avg(duration_ms))::int AS avg_duration_ms, max(duration_ms)::int AS max_duration_ms
     FROM operational_events
     WHERE category = 'API'
       AND duration_ms IS NOT NULL
       AND created_at >= now() - interval '15 minutes'
     GROUP BY route, method
     ORDER BY max(duration_ms) DESC NULLS LAST
     LIMIT 8`
  );
  return { windowMinutes: 15, summary: rows[0] ?? {}, topRoutes: top.rows };
}
