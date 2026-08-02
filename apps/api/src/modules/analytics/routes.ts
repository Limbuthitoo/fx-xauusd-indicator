import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { tenantReportHistoryMonths } from "../billing/limits.js";
import { requireAdmin, requireTenantModule } from "../auth/routes.js";

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

  app.get("/api/module2/production-audit", async (request) => {
    const session = await requireTenantModule(request, "high_probability_strategy_2");
    return buildModuleProductionAudit(session.tenantId, "high_probability_strategy_2");
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
         SELECT sc.session_id
         FROM trades t
         JOIN trade_plans tp ON tp.id = t.trade_plan_id
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         WHERE sc.tenant_id = $1
           AND sc.module_code = $2
           AND sc.scenario <> 'QA_TEST_SIGNAL'
           AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         GROUP BY sc.session_id
         HAVING count(t.id) > 1
       ) duplicate_sessions`,
      [tenantId, moduleCode]
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
    { code: "ONE_PRODUCTION_TRADE_PER_SESSION", status: duplicateTradeCount === 0 ? "PASS" : "FAIL", count: duplicateTradeCount },
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
