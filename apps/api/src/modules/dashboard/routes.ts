import type { FastifyInstance, FastifyRequest } from "fastify";
import type { InjectPayload } from "light-my-request";
import { redisClient } from "../../infrastructure/redis/client.js";
import { query } from "../../infrastructure/db/client.js";
import { requirePermission } from "../auth/routes.js";

const MODULE_CODES = ["orb_max_options", "high_probability_strategy_2"];

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/bundle", async (request) => {
    const search = request.query as { moduleCode?: string; section?: string; symbol?: string; timeframeMinutes?: string; notificationQuery?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const section = search.section ?? "live";
    const symbol = search.symbol ?? "XAUUSD";
    const timeframeMinutes = Number(search.timeframeMinutes ?? 5);
    const notificationQuery = search.notificationQuery ? decodeURIComponent(search.notificationQuery) : "";
    const needsCommand = section === "command" || section === "command_center" || section === "orb";
    const needsStrategy = section === "orb";
    const needsReports = section === "reports";
    const needsLearning = section === "learning";
    const needsNotifications = section === "notifications";
    const needsPaper = section === "paper";
    const needsSignals = ["signals", "orb", "health", "live", "reports", "learning"].includes(section);
    const needsPredictions = ["predictions", "orb", "health", "live", "reports", "learning"].includes(section);
    const needsSettings = section === "settings";
    const needsData = section === "data" || section === "health";
    const needsLive = section === "live";
    const needsModuleOps = needsCommand || needsStrategy || needsReports || needsLearning || needsData;
    const isModule1 = moduleCode === "orb_max_options";
    const isModule2 = moduleCode === "high_probability_strategy_2";
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
      targetPerformance,
      productionObservation,
      latestBacktest,
      orbDataReadiness,
      orbRangeAudit,
      orbRanges,
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
      module2VariantMetrics,
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
      tradeSignals,
      tradePredictions
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
      needsReports || needsLearning ? Promise.all([
        injectJson(app, request, "GET", `/api/reports/target-performance?moduleCode=${moduleCode}&period=week`, undefined, null),
        injectJson(app, request, "GET", `/api/reports/target-performance?moduleCode=${moduleCode}&period=month`, undefined, null)
      ]).then(([week, month]) => ({ week, month })) : null,
      needsReports || needsCommand || needsLearning || needsData ? injectJson(app, request, "GET", `/api/analytics/production-observation?moduleCode=${moduleCode}&days=7`, undefined, null) : null,
      needsReports || needsLearning ? injectJson(app, request, "GET", `/api/backtests/latest?moduleCode=${moduleCode}`, undefined) : null,
      isModule1 && needsData ? injectJson(app, request, "GET", "/api/orb/data-readiness", undefined) : null,
      isModule1 ? injectJson(app, request, "GET", "/api/sessions/current/orb-range-audit", undefined) : null,
      isModule1 ? injectJson(app, request, "GET", "/api/sessions/orb-ranges?limit=2", undefined, []) : [],
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
      isModule2 && (needsReports || needsModule2LiveOps || needsCommand) ? injectJson(app, request, "GET", "/api/module2/variant-metrics", undefined, null) : null,
      needsCommand || needsReports || needsLearning ? injectJson(app, request, "GET", "/api/analytics/modules/confidence", undefined) : null,
      needsCommand || needsData ? injectJson(app, request, "GET", "/api/analytics/production-readiness", undefined) : null,
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
      needsSignals ? injectJson(app, request, "GET", `/api/setups/signals?limit=100&moduleCode=${section === "signals" ? "ALL" : moduleCode}`, undefined, { summary: {}, signals: [] }) : null,
      needsPredictions ? injectJson(app, request, "GET", `/api/setups/predictions?limit=100&moduleCode=${section === "predictions" ? "ALL" : moduleCode}`, undefined, { summary: {}, predictions: [] }) : null
    ]);

    const sessionReview = session?.id ? await injectJson(app, request, "GET", `/api/sessions/${session.id}/review`, undefined) : undefined;
    const effectiveOrbRanges =
      isModule1 && (!Array.isArray(orbRanges) || orbRanges.length < 2)
        ? await injectJson(app, request, "GET", "/api/sessions/orb-ranges?limit=2", undefined, [])
        : orbRanges;
    return { clocks, session, strategies, analytics, orbAdmin, currentSetup, moduleCommand, automationStatus, feedStatus, twelveStatus, cacheStatus, newsStatus, tradePlan, currentTrade, sessionReview, weeklyReport, monthlyReport, targetPerformance, productionObservation, latestBacktest, orbDataReadiness, orbRangeAudit, orbRanges: effectiveOrbRanges, orbRehearsals, module2JournalTrades, module2Audit, module2Readiness, module2TuningHistory, module2Health, module2DataReadiness, module2Operator, module2Rehearsals, module2Learning, module2LearningReviews, module2SessionReports, module2Closeouts, module2VariantMetrics, strategyConfidence, productionReadiness, notifications, notificationSummary, settings, orbModuleSettings, activeModuleSettings, auditLogs, orbLearning, tenantContext, tenantPushStatus, paperTrading, tradeSignals, tradePredictions };
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
    const [platform, platformAutomation, platformUsage, platformSystemHealth, platformPaperLifecycle, platformProductionObservation, platformSecurityAudit, platformOperationalEvents, platformBackupStatus, platformBusinessSettings, platformPushOverview, platformTickets, platformAppReleases, platformStrategyValidation, requestLoad] = await Promise.all([
      injectJson(app, request, "GET", "/api/platform/overview", undefined),
      injectJson(app, request, "GET", "/api/platform/automation/status", undefined, []),
      injectJson(app, request, "GET", "/api/platform/usage/twelve-data", undefined),
      injectJson(app, request, "GET", "/api/platform/system-health", undefined),
      injectJson(app, request, "GET", "/api/platform/paper-lifecycle-health", undefined),
      injectJson(app, request, "GET", "/api/platform/production-observation?days=7", undefined),
      injectJson(app, request, "GET", "/api/platform/security-audit", undefined),
      injectJson(app, request, "GET", "/api/platform/operational-events", undefined),
      injectJson(app, request, "GET", "/api/platform/backups/status", undefined),
      injectJson(app, request, "GET", "/api/platform/business-settings", undefined),
      injectJson(app, request, "GET", "/api/platform/push/overview", undefined),
      injectJson(app, request, "GET", "/api/platform/support-tickets", undefined, []),
      injectJson(app, request, "GET", "/api/platform/mobile-app/releases", undefined, []),
      platformValidationOverview(),
      platformRequestLoad()
    ]);
    const payload = { platform, platformAutomation, platformUsage, platformSystemHealth, platformPaperLifecycle, platformProductionObservation, platformSecurityAudit, platformOperationalEvents, platformBackupStatus, platformBusinessSettings, platformPushOverview, platformTickets, platformAppReleases, platformStrategyValidation, requestLoad, cachedAt: new Date().toISOString() };
    if (client) await client.set(cacheKey, JSON.stringify(payload), "EX", 5).catch(() => undefined);
    return payload;
  });
}

async function platformValidationOverview() {
  try {
    const [datasets, runs, gates] = await Promise.all([
    query(
      `SELECT id, name, symbol, source, timeframe_minutes, status, candle_count, session_count,
              start_at, end_at, metadata, created_at, updated_at
       FROM strategy_validation_datasets
       ORDER BY updated_at DESC
       LIMIT 20`
    ),
    query(
      `SELECT r.id, r.dataset_id, d.name AS dataset_name, r.status, r.train_ratio,
              r.train_start_date, r.train_end_date, r.validation_start_date, r.validation_end_date,
              r.parameters, r.summary, r.started_at, r.completed_at,
              count(s.id)::int AS signal_count
       FROM strategy_validation_runs r
       JOIN strategy_validation_datasets d ON d.id = r.dataset_id
       LEFT JOIN strategy_validation_signals s ON s.run_id = r.id
       GROUP BY r.id, d.name
       ORDER BY r.started_at DESC
       LIMIT 12`
    ),
    query(
      `SELECT g.module_code, m.name AS module_name, g.profile_code, g.validation_run_id,
              g.status, g.enforced, g.resolved_count, g.win_rate, g.profit_factor,
              g.expectancy_r, g.total_r, g.max_drawdown_r, g.reasons, g.evaluated_at,
              d.name AS dataset_name
       FROM strategy_release_gates g
       JOIN platform_strategy_modules m ON m.code = g.module_code
       JOIN strategy_validation_runs r ON r.id = g.validation_run_id
       JOIN strategy_validation_datasets d ON d.id = r.dataset_id
       ORDER BY g.module_code, CASE WHEN g.profile_code = '__ALL__' THEN 0 ELSE 1 END, g.profile_code`
    )
  ]);
    const rows = gates.rows as any[];
    return {
      available: true,
      summary: {
        datasets: datasets.rows.length,
        completedRuns: (runs.rows as any[]).filter((row) => row.status === "COMPLETED").length,
        enforcedProfiles: rows.filter((row) => row.enforced && row.profile_code !== "__ALL__").length,
        eligibleProfiles: rows.filter((row) => row.enforced && row.status === "ELIGIBLE" && row.profile_code !== "__ALL__").length,
        blockedProfiles: rows.filter((row) => row.enforced && row.status === "BLOCKED" && row.profile_code !== "__ALL__").length,
        awaitingSamples: rows.filter((row) => !row.enforced && row.profile_code !== "__ALL__").length
      },
      datasets: datasets.rows,
      runs: runs.rows,
      gates: rows
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      summary: { datasets: 0, completedRuns: 0, enforcedProfiles: 0, eligibleProfiles: 0, blockedProfiles: 0, awaitingSamples: 0 },
      datasets: [],
      runs: [],
      gates: []
    };
  }
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
