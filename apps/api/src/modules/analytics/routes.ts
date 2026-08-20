import type { FastifyInstance } from "fastify";
import { XAUUSD_PRODUCTION_SIGNAL_POLICY } from "@orb-guide/risk-engine";
import { query } from "../../infrastructure/db/client.js";
import { tenantReportHistoryMonths } from "../billing/limits.js";
import { requireAdmin, requireTenantModule } from "../auth/routes.js";
import { buildTargetPerformanceReport } from "./target-performance.js";

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/api/analytics/production-readiness", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) return { generatedAt: new Date().toISOString(), status: "BLOCKED", checks: [], modules: [] };
    const [dbNow, modules, usage, notificationStats, feedStats, cacheStats, staleTrades, moduleMix] = await Promise.all([
      query("SELECT now() AS now"),
      query(
        `SELECT m.code, m.name, m.target_win_rate
         FROM tenant_modules tm
         JOIN platform_strategy_modules m ON m.id = tm.module_id
         WHERE tm.tenant_id = $1 AND tm.status = 'ENABLED' AND m.status = 'ACTIVE'
         ORDER BY m.sort_order`,
        [session.tenantId]
      ),
      query(
        `SELECT
           COALESCE(sum(credits_used) FILTER (WHERE created_at::date = CURRENT_DATE), 0)::int AS today,
           COALESCE(sum(credits_used) FILTER (WHERE created_at >= now() - interval '1 minute'), 0)::int AS last_minute,
           max(created_at) AS latest_call
         FROM api_usage_events
         WHERE provider = 'TWELVE_DATA'`,
      ),
      query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unread,
           count(*) FILTER (WHERE priority IN ('HIGH','CRITICAL'))::int AS high_priority,
           max(created_at) AS latest
         FROM notifications
         WHERE tenant_id = $1`,
        [session.tenantId]
      ),
      query(
        `SELECT
           max(timestamp_utc) AS latest_candle,
           count(*) FILTER (WHERE timestamp_utc >= now() - interval '1 day')::int AS candles_24h
         FROM candles
         WHERE symbol = 'XAUUSD'`,
      ),
      query(
        `SELECT
           count(*)::int AS stored_candles,
           min(timestamp_utc) AS oldest_candle,
           max(timestamp_utc) AS newest_candle
         FROM candles
         WHERE symbol = 'XAUUSD'`,
      ),
      query(
        `SELECT count(t.id)::int AS count
         FROM trades t
         JOIN trade_plans tp ON tp.id = t.trade_plan_id
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         WHERE sc.tenant_id = $1
           AND t.outcome = 'ACTIVE'
           AND t.opened_at < now() - interval '6 hours'`,
        [session.tenantId]
      ),
      query(
        `SELECT count(*)::int AS count
         FROM trade_plans tp
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         JOIN trading_sessions ts ON ts.id = sc.session_id
         WHERE sc.tenant_id = $1
           AND sc.module_code <> ts.module_code`,
        [session.tenantId]
      )
    ]);

    const moduleRows = [];
    for (const module of modules.rows as any[]) {
      const [performance, audit, rehearsal, latestSetup, latestTrade] = await Promise.all([
        modulePerformanceSummary(session.tenantId, module.code),
        buildModuleProductionAudit(session.tenantId, module.code),
        query(
          `SELECT final_status, created_at
           FROM module_launch_rehearsals
           WHERE tenant_id = $1 AND module_code = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        ),
        query(
          `SELECT id, status, scenario, direction, detected_at
           FROM setup_candidates
           WHERE tenant_id = $1 AND module_code = $2
           ORDER BY detected_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        ),
        query(
          `SELECT t.id, sc.direction, t.outcome, t.opened_at, t.closed_at, t.result_r
           FROM trades t
           JOIN trade_plans tp ON tp.id = t.trade_plan_id
           JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
           WHERE sc.tenant_id = $1 AND sc.module_code = $2
           ORDER BY t.opened_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        )
      ]);
      const rehearsalStatus = rehearsal.rows[0]?.final_status ?? "WAIT";
      const auditStatus = audit.summary.status;
      const failed = audit.summary.failedChecks;
      moduleRows.push({
        moduleCode: module.code,
        moduleName: module.name,
        targetWinRate: module.target_win_rate,
        performance,
        audit: audit.summary,
        rehearsal: rehearsal.rows[0] ?? null,
        latestSetup: latestSetup.rows[0] ?? null,
        latestTrade: latestTrade.rows[0] ?? null,
        status: failed > 0 ? "BLOCKED" : rehearsalStatus === "GO" ? "READY" : "CAUTION",
        nextAction: failed > 0
          ? "Fix production audit failures before trusting paper signals."
          : rehearsalStatus === "GO"
            ? "Ready for the next valid NY paper-trade signal."
            : "Run launch rehearsal before relying on this module."
      });
    }

    const usageRow = usage.rows[0] ?? {};
    const notificationRow = notificationStats.rows[0] ?? {};
    const feedRow = feedStats.rows[0] ?? {};
    const cacheRow = cacheStats.rows[0] ?? {};
    const staleTradeCount = Number(staleTrades.rows[0]?.count ?? 0);
    const moduleMixCount = Number(moduleMix.rows[0]?.count ?? 0);
    const checks = [
      readinessCheck("POSTGRESQL", "PostgreSQL reachable", true, `Database time ${dbNow.rows[0]?.now ?? "--"}.`),
      readinessCheck("XAUUSD_CANDLES", "XAUUSD candle storage", Number(cacheRow.stored_candles ?? 0) > 0, `${cacheRow.stored_candles ?? 0} stored candle(s).`),
      readinessCheck("TWELVE_DATA_BUDGET", "Twelve Data budget", Number(usageRow.today ?? 0) <= 800 && Number(usageRow.last_minute ?? 0) <= 8, `${usageRow.today ?? 0}/800 today, ${usageRow.last_minute ?? 0}/8 last minute.`),
      readinessCheck("MODULE_ISOLATION", "Module isolation", moduleMixCount === 0, `${moduleMixCount} mixed module/session record(s).`),
      readinessCheck("PAPER_LIFECYCLE", "Paper lifecycle", staleTradeCount === 0, `${staleTradeCount} active paper trade(s) older than 6 hours.`),
      readinessCheck("NOTIFICATIONS", "Notifications table", true, `${notificationRow.total ?? 0} total, ${notificationRow.unread ?? 0} unread, ${notificationRow.high_priority ?? 0} high priority.`)
    ];
    const failedChecks = checks.filter((check) => check.status === "FAIL").length;
    const cautions = moduleRows.filter((row) => row.status !== "READY").length;
    return {
      generatedAt: new Date().toISOString(),
      status: failedChecks > 0 ? "BLOCKED" : cautions > 0 ? "CAUTION" : "READY",
      checks,
      data: {
        databaseTime: dbNow.rows[0]?.now ?? null,
        twelveData: {
          usedToday: Number(usageRow.today ?? 0),
          usedLastMinute: Number(usageRow.last_minute ?? 0),
          dailyLimit: 800,
          minuteLimit: 8,
          latestCallAt: usageRow.latest_call ?? null
        },
        candles: {
          latestCandleAt: feedRow.latest_candle ?? cacheRow.newest_candle ?? null,
          candles24h: Number(feedRow.candles_24h ?? 0),
          storedCandles: Number(cacheRow.stored_candles ?? 0),
          oldestCandleAt: cacheRow.oldest_candle ?? null,
          newestCandleAt: cacheRow.newest_candle ?? null
        },
        notifications: {
          total: Number(notificationRow.total ?? 0),
          unread: Number(notificationRow.unread ?? 0),
          highPriority: Number(notificationRow.high_priority ?? 0),
          latestAt: notificationRow.latest ?? null
        }
      },
      modules: moduleRows
    };
  });

  app.get("/api/analytics/overview", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    const tenantId = session.tenantId;
    const sessions = await query("SELECT count(*)::int AS total_sessions FROM trading_sessions WHERE tenant_id = $1 AND module_code = $2", [tenantId, moduleCode]);
    const setups = await query(
      `SELECT count(*)::int AS total_setups
       FROM setup_candidates
       WHERE tenant_id = $1
         AND module_code = $2
         AND scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId, moduleCode]
    );
    const trades = await query(
      `SELECT count(*)::int AS total_trades, COALESCE(sum(t.result_r),0)::float AS total_r
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId, moduleCode]
    );
    const compliance = await query(
      `SELECT je.process_grade, count(*)::int
       FROM journal_entries je
       JOIN trading_sessions ts ON ts.id = je.session_id
       WHERE je.tenant_id = $1
         AND ts.module_code = $2
       GROUP BY je.process_grade`,
      [tenantId, moduleCode]
    );
    return {
      moduleCode,
      totalSessions: sessions.rows[0]?.total_sessions ?? 0,
      totalSetups: setups.rows[0]?.total_setups ?? 0,
      totalTrades: trades.rows[0]?.total_trades ?? 0,
      totalR: trades.rows[0]?.total_r ?? 0,
      compliance: compliance.rows
    };
  });

  app.get("/api/analytics/scenarios", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    const { rows } = await query(
      `SELECT scenario, direction, status, count(*)::int
       FROM setup_candidates
       WHERE tenant_id = $1
         AND module_code = $2
         AND scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(scenario_flags->>'replay', 'false') <> 'true'
       GROUP BY scenario, direction, status
       ORDER BY scenario`,
      [session.tenantId, moduleCode]
    );
    return rows;
  });

  app.get("/api/admin/orb-performance", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    const tenantId = session.tenantId;
    const summary = await query(`
      SELECT
        count(sc.id)::int AS generated_signals,
        count(t.id)::int AS trades,
        count(*) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
        count(*) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
        count(*) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
        count(*) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
        COALESCE(sum(t.result_r),0)::float AS total_r,
        COALESCE(avg(t.result_r) FILTER (WHERE t.result_r IS NOT NULL),0)::float AS avg_r
      FROM setup_candidates sc
      LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
      LEFT JOIN trades t ON t.trade_plan_id = tp.id
      WHERE sc.symbol = 'XAUUSD'
        AND sc.tenant_id = $1
        AND sc.module_code = $2
        AND sc.direction IN ('LONG', 'SHORT')
        AND sc.scenario <> 'QA_TEST_SIGNAL'
        AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
    `, [tenantId, moduleCode]);
    const signals = await query(`
      SELECT
        sc.id,
        sc.symbol,
        sc.scenario,
        sc.direction,
        sc.status,
        sc.detected_at,
        sc.entry_price,
        sc.stop_price,
        sc.target_price,
        sc.favorability_score,
        sc.favorability_grade,
        sc.final_reason,
        ts.session_date,
        t.id AS trade_id,
        t.outcome,
        t.result_r,
        t.actual_entry,
        t.actual_stop,
        t.actual_target,
        t.actual_exit,
        t.opened_at,
        t.closed_at,
        count(scs.id)::int AS snapshot_candles,
        min(scs.timestamp_utc) AS snapshot_start_at,
        max(scs.timestamp_utc) AS snapshot_end_at
      FROM setup_candidates sc
      LEFT JOIN trading_sessions ts ON ts.id = sc.session_id
      LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
      LEFT JOIN trades t ON t.trade_plan_id = tp.id
      LEFT JOIN setup_candle_snapshots scs ON scs.setup_candidate_id = sc.id
      WHERE sc.symbol = 'XAUUSD'
        AND sc.tenant_id = $1
        AND sc.module_code = $2
        AND sc.direction IN ('LONG', 'SHORT')
        AND sc.scenario <> 'QA_TEST_SIGNAL'
        AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
      GROUP BY
        sc.id,
        ts.session_date,
        t.id
      ORDER BY sc.detected_at DESC
    `, [tenantId, moduleCode]);
    const byScenario = await query(`
      SELECT
        sc.scenario,
        sc.direction,
        count(*)::int AS signals,
        count(t.id)::int AS trades,
        count(*) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
        count(*) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
        count(*) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
        count(*) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
        COALESCE(sum(t.result_r),0)::float AS total_r,
        COALESCE(avg(t.result_r) FILTER (WHERE t.result_r IS NOT NULL),0)::float AS avg_r
      FROM setup_candidates sc
      LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
      LEFT JOIN trades t ON t.trade_plan_id = tp.id
      WHERE sc.symbol = 'XAUUSD'
        AND sc.tenant_id = $1
        AND sc.module_code = $2
        AND sc.direction IN ('LONG', 'SHORT')
        AND sc.scenario <> 'QA_TEST_SIGNAL'
        AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
      GROUP BY sc.scenario, sc.direction
      ORDER BY signals DESC, sc.scenario
    `, [tenantId, moduleCode]);
    const rows = signals.rows as any[];
    const totals = summary.rows[0] ?? {};
    const wins = Number(totals.wins ?? 0);
    const losses = Number(totals.losses ?? 0);
    const breakeven = Number(totals.breakeven ?? 0);
    const active = Number(totals.active ?? 0);
    const trades = Number(totals.trades ?? 0);
    const decided = wins + losses + breakeven;
    const totalR = Number(totals.total_r ?? 0);
    return {
      strategy: "ORB Max Options logic",
      moduleCode,
      symbol: "XAUUSD",
      generatedSignals: Number(totals.generated_signals ?? 0),
      trades,
      wins,
      losses,
      breakeven,
      active,
      winRate: decided > 0 ? wins / decided : 0,
      averageR: Number(totals.avg_r ?? 0),
      totalR,
      byScenario: byScenario.rows.map((row: any) => {
        const scenarioDecided = Number(row.wins ?? 0) + Number(row.losses ?? 0) + Number(row.breakeven ?? 0);
        return {
          ...row,
          winRate: scenarioDecided > 0 ? Number(row.wins ?? 0) / scenarioDecided : 0
        };
      }),
      signals: rows
    };
  });

  app.get("/api/reports/weekly", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    return buildPerformanceReport("week", session.tenantId, moduleCode);
  });

  app.get("/api/reports/monthly", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    return buildPerformanceReport("month", session.tenantId, moduleCode);
  });

  app.get("/api/reports/target-performance", async (request) => {
    const search = request.query as { moduleCode?: string; period?: "week" | "month" };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const period = search.period === "month" ? "month" : "week";
    const session = await requireTenantModule(request, moduleCode);
    return buildTargetPerformanceReport(session.tenantId!, moduleCode, period);
  });

  app.get("/api/platform/paper-lifecycle-health", async (request) => {
    const session = requireAdmin(request);
    if (!session.platformSuperAdmin) {
      const error = new Error("Platform super-admin access required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const result = await query(
      `SELECT count(*)::int AS trades,
         count(*) FILTER (WHERE outcome = 'ACTIVE')::int AS active,
         count(*) FILTER (WHERE outcome = 'ACTIVE' AND opened_at < now() - interval '12 hours')::int AS stale_active,
         count(*) FILTER (WHERE target_count <> 3)::int AS incomplete_target_ladders,
         count(*) FILTER (WHERE outcome = 'ACTIVE' AND (tp3_hit OR sl_hit))::int AS terminal_state_conflicts,
         max(opened_at) AS latest_trade_at
       FROM paper_trade_target_performance WHERE is_qa = false`
    );
    const row = result.rows[0] ?? {};
    const stale = Number(row.stale_active ?? 0);
    const incomplete = Number(row.incomplete_target_ladders ?? 0);
    const conflicts = Number(row.terminal_state_conflicts ?? 0);
    return {
      checkedAt: new Date().toISOString(), status: stale + incomplete + conflicts > 0 ? "CAUTION" : "HEALTHY",
      trades: Number(row.trades ?? 0), active: Number(row.active ?? 0), staleActive: stale,
      incompleteTargetLadders: incomplete, terminalStateConflicts: conflicts, latestTradeAt: row.latest_trade_at ?? null
    };
  });

  app.get("/api/module2/production-audit", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModuleProductionAudit(session.tenantId, "high_probability_strategy_2");
  });

  app.get("/api/module2/variant-metrics", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModule2VariantMetrics(session.tenantId);
  });

  app.get("/api/modules/:moduleCode/production-audit", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const session = await requireTenantModule(request, moduleCode);
    return buildModuleProductionAudit(session.tenantId, moduleCode);
  });

  app.get("/api/analytics/modules/confidence", async (request) => {
    const session = await requireTenantModule(request, "orb_max_options");
    if (!session.tenantId) return { modules: [] };
    const modules = await query(
      `SELECT m.code, m.name, m.target_win_rate
       FROM tenant_modules tm
       JOIN platform_strategy_modules m ON m.id = tm.module_id
       WHERE tm.tenant_id = $1 AND tm.status = 'ENABLED' AND m.status = 'ACTIVE'
       ORDER BY m.sort_order`,
      [session.tenantId]
    );
    const rows = [];
    for (const module of modules.rows as any[]) {
      const [performance, backtest, audit, learning] = await Promise.all([
        modulePerformanceSummary(session.tenantId, module.code),
        query(
          `SELECT summary, completed_at
           FROM backtest_runs
           WHERE tenant_id = $1 AND module_code = $2 AND status = 'COMPLETED'
           ORDER BY completed_at DESC NULLS LAST, started_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        ),
        buildModuleProductionAudit(session.tenantId, module.code),
        query(
          `SELECT sample_size, status, completed_at, summary
           FROM module_learning_runs
           WHERE tenant_id = $1 AND module_code = $2
           ORDER BY started_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        )
      ]);
      const bt = backtest.rows[0]?.summary ?? {};
      const sampleSize = Math.max(Number(performance.decidedTrades ?? 0), Number(bt.trades ?? 0), Number(learning.rows[0]?.sample_size ?? 0));
      const expectancy = Number(performance.averageR ?? bt.averageR ?? 0);
      const winRate = Number(performance.winRate ?? bt.winRate ?? 0);
      const auditFailCount = audit.checks.filter((check: any) => check.status === "FAIL").length;
      rows.push({
        moduleCode: module.code,
        moduleName: module.name,
        targetWinRate: module.target_win_rate,
        paper: performance,
        backtest: backtest.rows[0] ?? null,
        learning: learning.rows[0] ?? null,
        audit,
        confidence: strategyConfidenceGrade(sampleSize, winRate, expectancy, auditFailCount)
      });
    }
    return { generatedAt: new Date().toISOString(), modules: rows };
  });
}

async function buildModuleProductionAudit(tenantId: string | null, moduleCode: string) {
  const [invalidTrades, replayTrades, moduleMix, liveTrades, duplicateTrades] = await Promise.all([
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.status NOT IN ('PAPER_TRADE_OPENED','TRADE_PLANNED','LONG SETUP READY','SHORT SETUP READY')
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(t.id)::int AS count
       FROM trades t
       JOIN trade_plans tp ON tp.id = t.trade_plan_id
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND (sc.scenario = 'QA_TEST_SIGNAL' OR COALESCE(sc.scenario_flags->>'replay', 'false') = 'true')`,
      [tenantId, moduleCode]
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
         AND sc.module_code = $2
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
      [tenantId, moduleCode]
    ),
    query(
      `SELECT count(*)::int AS count
       FROM (
         SELECT sc.session_id,
                CASE
                  WHEN upper(sc.scenario) LIKE '%HORIZONTAL%' THEN 'HORIZONTAL_RANGE_BREAKOUT'
                  WHEN upper(sc.scenario) LIKE '%RETEST%' THEN 'BREAKOUT_RETEST'
                  ELSE 'ORB_BREAKOUT'
                END AS strategy_profile
         FROM trades t
         JOIN trade_plans tp ON tp.id = t.trade_plan_id
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         WHERE sc.tenant_id = $1
           AND sc.module_code = $2
           AND sc.scenario <> 'QA_TEST_SIGNAL'
           AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         GROUP BY sc.session_id, strategy_profile
         HAVING count(t.id) > $3
       ) duplicate_sessions`,
      [tenantId, moduleCode, XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerStrategyProfile]
    )
  ]);
  const invalidTradeCount = Number(invalidTrades.rows[0]?.count ?? 0);
  const moduleMixCount = Number(moduleMix.rows[0]?.count ?? 0);
  const duplicateTradeCount = Number(duplicateTrades.rows[0]?.count ?? 0);
  const replayTradeCount = Number(replayTrades.rows[0]?.count ?? 0);
  const liveTradeCount = Number(liveTrades.rows[0]?.count ?? 0);
  const checks = [
    { code: "INVALID_SETUPS_NEVER_TRADE", status: invalidTradeCount === 0 ? "PASS" : "FAIL", count: invalidTradeCount },
    { code: "MODULE_BOUNDARY_CLEAN", status: moduleMixCount === 0 ? "PASS" : "FAIL", count: moduleMixCount },
    {
      code: "STRATEGY_PROFILE_TRADE_LIMIT",
      status: duplicateTradeCount === 0 ? "PASS" : "FAIL",
      count: duplicateTradeCount,
      maximumPerProfile: XAUUSD_PRODUCTION_SIGNAL_POLICY.maximumSignalsPerStrategyProfile
    },
    { code: "REPLAY_EXCLUDED_FROM_PRODUCTION", status: "PASS", count: replayTradeCount },
    { code: "LIVE_PRODUCTION_TRADES", status: "INFO", count: liveTradeCount }
  ];
  const failedChecks = checks.filter((check) => check.status === "FAIL").length;
  return {
    moduleCode,
    summary: {
      status: failedChecks === 0 ? "PASS" : "FAIL",
      totalChecks: checks.length,
      passedChecks: checks.filter((check) => check.status === "PASS").length,
      failedChecks,
      infoChecks: checks.filter((check) => check.status === "INFO").length,
      replayTradeCount,
      liveTradeCount
    },
    checks
  };
}

async function buildModule2VariantMetrics(tenantId: string | null) {
  if (!tenantId) {
    return {
      generatedAt: new Date().toISOString(),
      summary: { totalVariants: 0, productionApproved: 0, paperEligible: 0, livePaperTrades: 0 },
      variants: [],
      transitions: []
    };
  }
  const variants = await query(
    `SELECT code, name, category, approval_status, paper_eligible, sort_order
     FROM module2_strategy_variants
     WHERE module_code = 'high_probability_strategy_2'
     ORDER BY sort_order`
  );
  const performance = await query(
    `SELECT
       COALESCE(sc.scenario_flags->'module2Variant'->>'code', sc.scenario_flags->>'variantCode', 'UNCLASSIFIED_VARIANT') AS variant_code,
       COALESCE(sc.scenario_flags->'module2Variant'->>'name', sc.scenario_flags->>'variantName') AS variant_name,
       count(t.id)::int AS trades,
       count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
       count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
       count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
       COALESCE(avg(t.result_r) FILTER (WHERE t.result_r IS NOT NULL), 0)::float AS average_r,
       COALESCE(sum(t.result_r), 0)::float AS total_r
     FROM setup_candidates sc
     LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     WHERE sc.tenant_id = $1
       AND sc.module_code = 'high_probability_strategy_2'
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
     GROUP BY variant_code, variant_name`,
    [tenantId]
  );
  const blockers = await query(
    `SELECT
       COALESCE(sc.scenario_flags->'module2Variant'->>'code', sc.scenario_flags->>'variantCode', 'UNCLASSIFIED_VARIANT') AS variant_code,
       sre.rule_code,
       count(*)::int AS count
     FROM setup_candidates sc
     JOIN setup_rule_evaluations sre ON sre.setup_candidate_id = sc.id
     WHERE sc.tenant_id = $1
       AND sc.module_code = 'high_probability_strategy_2'
       AND sre.status <> 'PASS'
       AND (
         sre.blocking = true
         OR sre.rule_code IN (
           'NY_SESSION_ACTIVE','DAILY_TRADE_LIMIT','LIQUIDITY_LEVEL_IDENTIFIED','LIQUIDITY_SWEEP_CONFIRMED',
           'SWEEP_REJECTION_CONFIRMED','SWEEP_ACCEPTANCE_BLOCK','DISPLACEMENT_CONFIRMED','PROTECTED_POINT_CONFIDENCE',
           'BOS_CHOCH_CONFIRMED','ENTRY_ZONE_READY','ENTRY_ZONE_RETRACE','CONFIRM_ENTRY_CANDLE','VARIANT_SELECTED',
           'QUALITY_SPREAD','QUALITY_NEWS','QUALITY_RR','QUALITY_STOP_SIZE','QUALITY_FILTER_COUNT','EMA_FILTER_MODE','VOLUME_FILTER_MODE'
         )
       )
     GROUP BY variant_code, sre.rule_code
     ORDER BY count DESC`,
    [tenantId]
  );
  const transitions = await query(
    `SELECT variant_code, to_state, count(*)::int AS count, max(occurred_at) AS latest_at
     FROM module2_state_transitions
     WHERE tenant_id = $1
     GROUP BY variant_code, to_state
     ORDER BY max(occurred_at) DESC`,
    [tenantId]
  );
  const byVariant = new Map(performance.rows.map((row: any) => [row.variant_code, row]));
  const resultsByVariant = await module2LiveResultsByVariant(tenantId);
  const blockerMap = new Map<string, any>();
  for (const row of blockers.rows as any[]) {
    if (!blockerMap.has(row.variant_code)) blockerMap.set(row.variant_code, row);
  }
  const rows = variants.rows.map((variant: any) => {
    const perf = byVariant.get(variant.code) as any;
    const trades = Number(perf?.trades ?? 0);
    const wins = Number(perf?.wins ?? 0);
    const losses = Number(perf?.losses ?? 0);
    const decided = wins + losses;
    const winRate = decided > 0 ? wins / decided : 0;
    const topBlocker = blockerMap.get(variant.code)?.rule_code ?? null;
    const results = resultsByVariant.get(variant.code) ?? [];
    const profitFactorValue = module2ProfitFactor(results);
    const maxDrawdownValue = module2MaxDrawdownR(results);
    return {
      ...variant,
      trades,
      wins,
      losses,
      active: Number(perf?.active ?? 0),
      winRate,
      averageR: Number(perf?.average_r ?? 0),
      totalR: Number(perf?.total_r ?? 0),
      profitFactor: profitFactorValue,
      maxDrawdownR: maxDrawdownValue,
      blockerCount: blockers.rows.filter((item: any) => item.variant_code === variant.code).reduce((sum: number, item: any) => sum + Number(item.count ?? 0), 0),
      topBlocker,
      recommendation: module2VariantMetricRecommendation(variant, trades, winRate, Number(perf?.average_r ?? 0), topBlocker, profitFactorValue, maxDrawdownValue)
    };
  });
  for (const row of rows) {
    await query(
      `INSERT INTO module2_variant_metric_snapshots (
        tenant_id, variant_code, variant_name, trades, wins, losses, active, win_rate,
        average_r, total_r, top_blocker, recommendation, source
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'LIVE_PAPER')
      ON CONFLICT (tenant_id, variant_code, source) DO UPDATE SET
        variant_name = EXCLUDED.variant_name,
        trades = EXCLUDED.trades,
        wins = EXCLUDED.wins,
        losses = EXCLUDED.losses,
        active = EXCLUDED.active,
        win_rate = EXCLUDED.win_rate,
        average_r = EXCLUDED.average_r,
        total_r = EXCLUDED.total_r,
        top_blocker = EXCLUDED.top_blocker,
        recommendation = EXCLUDED.recommendation,
        calculated_at = now()`,
      [tenantId, row.code, row.name, row.trades, row.wins, row.losses, row.active, row.winRate, row.averageR, row.totalR, row.topBlocker, row.recommendation]
    );
  }
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalVariants: rows.length,
      productionApproved: rows.filter((row: any) => row.approval_status === "PRODUCTION_APPROVED").length,
      paperEligible: rows.filter((row: any) => row.paper_eligible).length,
      livePaperTrades: rows.reduce((sum: number, row: any) => sum + Number(row.trades ?? 0), 0)
    },
    variants: rows,
    transitions: transitions.rows
  };
}

async function module2LiveResultsByVariant(tenantId: string) {
  const rows = await query(
    `SELECT
       COALESCE(sc.scenario_flags->'module2Variant'->>'code', sc.scenario_flags->>'variantCode', 'UNCLASSIFIED_VARIANT') AS variant_code,
       COALESCE(t.result_r, 0)::float AS result_r
     FROM setup_candidates sc
     JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     JOIN trades t ON t.trade_plan_id = tp.id
     WHERE sc.tenant_id = $1
       AND sc.module_code = 'high_probability_strategy_2'
       AND t.outcome IN ('WIN','LOSS','BREAKEVEN')
     ORDER BY t.closed_at ASC NULLS LAST, t.opened_at ASC`,
    [tenantId]
  );
  const byVariant = new Map<string, number[]>();
  for (const row of rows.rows as any[]) {
    const key = String(row.variant_code ?? "UNCLASSIFIED_VARIANT");
    byVariant.set(key, [...(byVariant.get(key) ?? []), Number(row.result_r ?? 0)]);
  }
  return byVariant;
}

function module2ProfitFactor(results: number[]) {
  const grossWin = results.filter((result) => result > 0).reduce((sum, result) => sum + result, 0);
  const grossLoss = Math.abs(results.filter((result) => result < 0).reduce((sum, result) => sum + result, 0));
  if (grossLoss === 0) return grossWin > 0 ? Number(grossWin.toFixed(4)) : 0;
  return Number((grossWin / grossLoss).toFixed(4));
}

function module2MaxDrawdownR(results: number[]) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const result of results) {
    equity += result;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return Number(maxDrawdown.toFixed(4));
}

function module2VariantMetricRecommendation(variant: any, trades: number, winRate: number, averageR: number, topBlocker: string | null, profitFactorValue = 0, maxDrawdownR = 0) {
  if (!variant.paper_eligible) return "Research-only. Track evidence, but do not allow automatic paper entry.";
  if (trades < 10) return topBlocker ? `Collect more paper data. Most common blocker: ${topBlocker}.` : "Collect at least 10 paper trades before judging this variant.";
  if (winRate >= 0.7 && averageR > 0 && profitFactorValue >= 1.4) return `Strong paper evidence. Keep active and monitor drawdown (${maxDrawdownR.toFixed(2)}R).`;
  if (averageR <= 0) return topBlocker ? `Needs tuning before trust. Focus blocker: ${topBlocker}.` : "Needs tuning before trust; average R is not positive.";
  return "Usable paper evidence. Keep active, but wait for a larger sample before increasing trust.";
}

async function modulePerformanceSummary(tenantId: string | null, moduleCode: string) {
  const result = await query(
    `SELECT
       count(t.id)::int AS trades,
       count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
       count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
       count(t.id) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
       count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
       COALESCE(sum(t.result_r), 0)::float AS total_r,
       COALESCE(avg(t.result_r) FILTER (WHERE t.result_r IS NOT NULL), 0)::float AS average_r
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.tenant_id = $1
       AND sc.module_code = $2
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'`,
    [tenantId, moduleCode]
  );
  const row = result.rows[0] ?? {};
  const decidedTrades = Number(row.wins ?? 0) + Number(row.losses ?? 0) + Number(row.breakeven ?? 0);
  return {
    trades: Number(row.trades ?? 0),
    decidedTrades,
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    breakeven: Number(row.breakeven ?? 0),
    active: Number(row.active ?? 0),
    winRate: decidedTrades > 0 ? Number(row.wins ?? 0) / decidedTrades : 0,
    totalR: Number(row.total_r ?? 0),
    averageR: Number(row.average_r ?? 0)
  };
}

function strategyConfidenceGrade(sampleSize: number, winRate: number, expectancy: number, auditFailCount: number) {
  if (auditFailCount > 0) return { grade: "BLOCKED", label: "Audit failed", sampleSize, trust: false, reason: "Production boundary audit has failing checks." };
  if (sampleSize < 20) return { grade: "LOW_SAMPLE", label: "Do not trust yet", sampleSize, trust: false, reason: "Needs at least 20 closed non-QA samples before strategy confidence can be trusted." };
  if (sampleSize < 50) return { grade: "RESEARCH", label: "Research only", sampleSize, trust: false, reason: "Enough for early research, not enough for production confidence." };
  if (winRate >= 0.55 && expectancy > 0.1) return { grade: "MONITORABLE", label: "Monitorable", sampleSize, trust: true, reason: "Sample, win rate, expectancy, and audit checks are acceptable for paper-monitoring confidence." };
  return { grade: "UNPROVEN", label: "Unproven", sampleSize, trust: false, reason: "Sample exists, but win rate or expectancy is not strong enough yet." };
}

function readinessCheck(code: string, label: string, pass: boolean, evidence: string) {
  return {
    code,
    label,
    status: pass ? "PASS" : "FAIL",
    evidence
  };
}

async function buildPerformanceReport(period: "week" | "month", tenantId: string | null, moduleCode: string) {
  const historyMonths = await tenantReportHistoryMonths(tenantId);
  const { rows } = await query(
    `SELECT
      date_trunc($1, COALESCE(t.closed_at, t.opened_at))::date AS period_start,
      count(*)::int AS total_trades,
      count(*) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
      count(*) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
      count(*) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
      count(*) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
      COALESCE(sum(t.result_r),0)::float AS total_r,
      COALESCE(avg(t.result_r) FILTER (WHERE t.result_r IS NOT NULL),0)::float AS avg_r
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE COALESCE(t.closed_at, t.opened_at) IS NOT NULL
       AND sc.tenant_id = $2
       AND sc.module_code = $3
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       AND ($4::int IS NULL OR COALESCE(t.closed_at, t.opened_at) >= now() - ($4::text || ' months')::interval)
     GROUP BY period_start
     ORDER BY period_start DESC
     LIMIT 12`,
    [period, tenantId, moduleCode, historyMonths]
  );
  return rows.map((row: any) => {
    const decided = Number(row.wins ?? 0) + Number(row.losses ?? 0) + Number(row.breakeven ?? 0);
    return {
      period,
      moduleCode,
      periodStart: row.period_start,
      totalTrades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      breakeven: row.breakeven,
      active: row.active,
      winRatio: decided > 0 ? Number(row.wins ?? 0) / decided : 0,
      totalR: row.total_r,
      avgR: row.avg_r
    };
  });
}
