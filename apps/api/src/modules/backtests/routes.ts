import { buildOpeningRange, evaluateSetup } from "@orb-guide/strategy-engine";
import { evaluateLiquiditySweepSetup } from "@orb-guide/liquidity-sweep-engine";
import type { Candle, Direction } from "@orb-guide/shared-types";
import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { getTenantModuleStrategyConfiguration, updateTenantModuleSetting } from "../admin/settings.js";
import { runModule2LearningPython, runStrategyModuleLearningPython } from "../admin/learning.js";
import { requireTenantModule } from "../auth/routes.js";
import { evaluateVwapOpeningDrive, getCachedCandles } from "../market-data/routes.js";

type BacktestTrade = {
  sessionDate: string;
  scenario: string;
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  resultR: number;
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  ambiguous: boolean;
  details: Record<string, unknown>;
};

export async function backtestRoutes(app: FastifyInstance) {
  app.post("/api/backtests/memory-cache/run", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number; moduleCode?: string };
    const moduleCode = body.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const symbol = body.symbol ?? "XAUUSD";
    const timeframe = moduleCode === "orb_max_options" || moduleCode === "high_probability_strategy_2" || moduleCode === "strategy_lab_3" ? 5 : body.timeframeMinutes ?? 5;
    const version = await selectedStrategyVersion(moduleCode);
    const memoryCandles = getCachedCandles(symbol, timeframe).map((candle) => ({
      timestampUtc: candle.timestampUtc,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      spread: candle.spread
    }));
    const postgresCandles = memoryCandles.length > 0 ? [] : (await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc ASC
       LIMIT 5000`,
      [symbol, timeframe]
    )).rows.map((row: any) => ({
      timestampUtc: new Date(row.timestamp_utc).toISOString(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume == null ? null : Number(row.volume),
      spread: row.spread == null ? null : Number(row.spread)
    }));
    const candles = memoryCandles.length > 0 ? memoryCandles : postgresCandles;
    const candleSource = memoryCandles.length > 0 ? "LIVE_MEMORY_CACHE" : "POSTGRESQL_CANDLES";
    const runResult = await query(
      `INSERT INTO backtest_runs (strategy_version_id, symbol, status, parameters, tenant_id, module_code)
       VALUES ($1,$2,'RUNNING',$3,$4,$5)
       RETURNING *`,
      [
        version.id,
        symbol,
        {
          moduleCode,
          tenantId: auth.tenantId,
          source: candleSource,
          timeframeMinutes: timeframe,
          candleCount: candles.length,
          cacheOnly: memoryCandles.length > 0,
          persistRawCandles: false
        },
        auth.tenantId,
        moduleCode
      ]
    );
    const run = runResult.rows[0] as any;

    try {
      const configuration = moduleCode === "high_probability_strategy_2"
        ? await getTenantModuleStrategyConfiguration(auth.tenantId, moduleCode, "liquiditySweep.strategy", version.configuration_json)
        : moduleCode === "strategy_lab_3"
          ? await getTenantModuleStrategyConfiguration(auth.tenantId, moduleCode, "vwapOpeningDrive.strategy", version.configuration_json)
        : version.configuration_json;
      const result = moduleCode === "high_probability_strategy_2"
        ? runLiquiditySweepMemoryCacheBacktest({
          symbol,
          timeframe,
          candles,
          strategyVersionId: version.id,
          configuration,
          source: candleSource
        })
        : moduleCode === "strategy_lab_3"
          ? runVwapOpeningDriveMemoryCacheBacktest({
            symbol,
            timeframe,
            candles,
            strategyVersionId: version.id,
            configuration,
            source: candleSource
          })
          : runMemoryCacheBacktest({
            symbol,
            timeframe,
            candles,
            strategyVersionId: version.id,
            configuration,
            sessionStart: version.session_start,
            openingRangeMinutes: Number(version.opening_range_minutes),
            tradeWindowEnd: version.trade_window_end,
            source: candleSource
          });

      for (const trade of result.trades) {
        await query(
          `INSERT INTO backtest_trades (
            backtest_run_id, session_date, scenario, direction, entry_price,
            stop_price, target_price, result_r, outcome, ambiguous, details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            run.id,
            trade.sessionDate,
            trade.scenario,
            trade.direction,
            trade.entryPrice,
            trade.stopPrice,
            trade.targetPrice,
            trade.resultR,
            trade.outcome,
            trade.ambiguous,
            trade.details
          ]
        );
      }
      for (const [key, value] of Object.entries(result.metrics)) {
        await query(
          `INSERT INTO backtest_metrics (backtest_run_id, metric_key, metric_value, metric_json)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (backtest_run_id, metric_key) DO UPDATE SET
             metric_value = EXCLUDED.metric_value,
             metric_json = EXCLUDED.metric_json`,
          [run.id, key, typeof value === "number" ? value : null, typeof value === "number" ? null : value]
        );
      }
      const learning = moduleCode === "high_probability_strategy_2" && auth.tenantId
        ? await insertModule2BacktestLearningRun(auth.tenantId, result.summary, result.metrics)
        : null;
      const updated = await query(
        "UPDATE backtest_runs SET status = 'COMPLETED', completed_at = now(), summary = $2 WHERE id = $1 RETURNING *",
        [run.id, { ...result.summary, moduleCode, learningRunId: learning?.runId ?? null }]
      );
      return { run: updated.rows[0], trades: result.trades, metrics: result.metrics, learning };
    } catch (error) {
      const failed = await query(
        "UPDATE backtest_runs SET status = 'FAILED', completed_at = now(), summary = $2 WHERE id = $1 RETURNING *",
        [run.id, { error: (error as Error).message }]
      );
      return { run: failed.rows[0], trades: [], metrics: {} };
    }
  });

  app.post("/api/backtests/module2/tuning-lab", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { symbol?: string };
    return buildModule2TuningLab(auth.tenantId, body.symbol ?? "XAUUSD");
  });

  app.get("/api/backtests/module2/tuning-promotions", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { rows } = await query(
      `SELECT *
       FROM module_tuning_promotions
       WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
       ORDER BY applied_at DESC
       LIMIT 20`,
      [auth.tenantId]
    );
    return rows;
  });

  app.get("/api/module2/learning/latest", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    return latestModule2Learning(auth.tenantId);
  });

  app.post("/api/module2/learning/run", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    if (!auth.tenantId) return { error: "Tenant account is required for Module 2 learning." };
    await runModule2LearningPython(auth.tenantId);
    return latestModule2Learning(auth.tenantId);
  });

  app.get("/api/modules/:moduleCode/learning/latest", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const auth = await requireTenantModule(request, moduleCode);
    return latestModuleLearningSnapshot(auth.tenantId, moduleCode);
  });

  app.post("/api/modules/:moduleCode/learning/run", async (request) => {
    const { moduleCode } = request.params as { moduleCode: string };
    const auth = await requireTenantModule(request, moduleCode);
    if (!auth.tenantId) return { error: "Tenant account is required for module learning." };
    await runStrategyModuleLearningPython(auth.tenantId, moduleCode);
    return latestModuleLearningSnapshot(auth.tenantId, moduleCode);
  });

  app.get("/api/module2/learning/reviews", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { rows } = await query(
      `SELECT *
       FROM module_learning_reviews
       WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
       ORDER BY created_at DESC
       LIMIT 50`,
      [auth.tenantId]
    );
    return rows;
  });

  app.post("/api/module2/learning/reviews", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { recommendationId?: string };
    if (!auth.tenantId) return { error: "Tenant account is required." };
    const recommendation = await query(
      `SELECT mlr.*, mlrun.sample_size
       FROM module_learning_recommendations mlr
       JOIN module_learning_runs mlrun ON mlrun.id = mlr.learning_run_id
       WHERE mlr.id = $1
         AND mlrun.tenant_id = $2
         AND mlr.module_code = 'high_probability_strategy_2'`,
      [body.recommendationId, auth.tenantId]
    );
    const row = recommendation.rows[0] as any;
    if (!row) return { error: "Learning recommendation not found." };
    const proposed = module2LearningProposedChange(row);
    const guardrails = module2LearningGuardrails(row, proposed);
    const saved = await query(
      `INSERT INTO module_learning_reviews (
        tenant_id, module_code, recommendation_id, status, title, rationale, proposed_change, guardrails
       ) VALUES ($1,'high_probability_strategy_2',$2,'PENDING',$3,$4,$5::jsonb,$6::jsonb)
       RETURNING *`,
      [auth.tenantId, row.id, row.title, row.rationale, JSON.stringify(proposed), JSON.stringify(guardrails)]
    );
    return saved.rows[0];
  });

  app.post("/api/module2/learning/reviews/:id/status", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { id } = request.params as { id: string };
    const body = request.body as { status?: "APPROVED_QA" | "REJECTED" | "APPLIED" | "ROLLED_BACK"; note?: string };
    const nextStatus = body.status ?? "APPROVED_QA";
    const allowed = new Set(["APPROVED_QA", "REJECTED", "APPLIED", "ROLLED_BACK"]);
    if (!allowed.has(nextStatus)) return { error: "Unsupported review status." };
    const existing = await query(
      `SELECT *
       FROM module_learning_reviews
       WHERE id = $1 AND tenant_id = $2 AND module_code = 'high_probability_strategy_2'`,
      [id, auth.tenantId]
    );
    const row = existing.rows[0] as any;
    if (!row) return { error: "Learning review item not found." };
    const guardrails = row.guardrails ?? [];
    if (nextStatus === "APPROVED_QA" && guardrails.some((check: any) => check.status === "FAIL")) {
      return { error: "Review cannot be approved because guardrails failed.", guardrails };
    }
    const updated = await query(
      `UPDATE module_learning_reviews
       SET status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, auth.tenantId, nextStatus, body.note ?? null, auth.sub]
    );
    return updated.rows[0];
  });

  app.get("/api/module2/session-reports", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const search = request.query as { status?: string; outcome?: string };
    const params: any[] = [auth.tenantId];
    const filters = ["tenant_id = $1", "module_code = 'high_probability_strategy_2'"];
    if (search.status) {
      params.push(search.status);
      filters.push(`final_status = $${params.length}`);
    }
    if (search.outcome) {
      params.push(search.outcome);
      filters.push(`trade_snapshot->>'dominantOutcome' = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT *
       FROM module_session_reports
       WHERE ${filters.join(" AND ")}
       ORDER BY session_date DESC
       LIMIT 60`,
      params
    );
    return rows;
  });

  app.post("/api/module2/session-reports/generate", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { sessionDate?: string };
    return generateModule2SessionReport(auth.tenantId, body.sessionDate);
  });

  app.patch("/api/module2/session-reports/:id/notes", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { id } = request.params as { id: string };
    const body = request.body as { operatorNotes?: string; trustedManually?: boolean | null };
    const updated = await query(
      `UPDATE module_session_reports
       SET operator_notes = $3, trusted_manually = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND module_code = 'high_probability_strategy_2'
       RETURNING *`,
      [id, auth.tenantId, body.operatorNotes ?? null, body.trustedManually ?? null]
    );
    return updated.rows[0] ?? { error: "Report not found." };
  });

  app.post("/api/backtests/module2/tuning-promotions/apply", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const body = request.body as { presetCode?: string; qaOnly?: boolean; reason?: string };
    const presetCode = body.presetCode ?? "";
    if (presetCode === "custom_current") return { error: "Custom Current is read-only and cannot be applied as a preset." };
    const lab = await buildModule2TuningLab(auth.tenantId, "XAUUSD");
    const target = lab.presets.find((preset: any) => preset.preset === presetCode);
    const current = lab.presets.find((preset: any) => preset.preset === "custom_current");
    if (!target) return { error: "Preset not found." };
    const safetyChecks = await module2PromotionSafetyChecks(auth.tenantId, target, current, body.qaOnly === true);
    const blocked = safetyChecks.filter((check) => check.status === "FAIL");
    if (blocked.length > 0) return { error: "Preset promotion blocked by safety checks.", safetyChecks };
    const previous = await currentModule2Setting(auth.tenantId);
    const saved = await updateTenantModuleSetting(auth.tenantId!, "high_probability_strategy_2", "liquiditySweep.strategy", target.configuration, auth.sub);
    const history = await insertModule2Promotion({
      tenantId: auth.tenantId!,
      action: "APPLY_PRESET",
      presetCode,
      previousValue: previous.value,
      appliedValue: saved.value,
      tuningSummary: target.summary,
      safetyChecks,
      qaOnly: body.qaOnly === true,
      reason: body.reason ?? target.description,
      appliedBy: auth.sub
    });
    return { saved, history, safetyChecks };
  });

  app.post("/api/backtests/module2/tuning-promotions/:id/rollback", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const { id } = request.params as { id: string };
    const promotion = await query(
      `SELECT *
       FROM module_tuning_promotions
       WHERE id = $1 AND tenant_id = $2 AND module_code = 'high_probability_strategy_2'`,
      [id, auth.tenantId]
    );
    const row = promotion.rows[0] as any;
    if (!row) return { error: "Promotion not found." };
    const previous = await currentModule2Setting(auth.tenantId);
    const saved = await updateTenantModuleSetting(auth.tenantId!, "high_probability_strategy_2", "liquiditySweep.strategy", row.previous_value, auth.sub);
    const history = await insertModule2Promotion({
      tenantId: auth.tenantId!,
      action: "ROLLBACK",
      presetCode: row.preset_code,
      previousValue: previous.value,
      appliedValue: saved.value,
      tuningSummary: { rolledBackPromotionId: id },
      safetyChecks: [{ code: "ROLLBACK_RESTORE_PREVIOUS", status: "PASS" }],
      qaOnly: row.qa_only,
      reason: `Rollback to configuration before ${row.preset_code}.`,
      appliedBy: auth.sub
    });
    return { saved, history };
  });

  app.post("/api/backtests", async (request) => {
    const body = request.body as any;
    const { rows } = await query(
      "INSERT INTO backtest_runs (strategy_version_id, symbol, status, parameters) VALUES ($1,$2,'QUEUED',$3) RETURNING *",
      [body.strategyVersionId, body.symbol ?? "XAUUSD", body.parameters ?? {}]
    );
    return rows[0];
  });

  app.get("/api/backtests", async () => {
    const { rows } = await query("SELECT * FROM backtest_runs ORDER BY started_at DESC LIMIT 50");
    return rows;
  });

  app.get("/api/backtests/latest", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode;
    const run = moduleCode
      ? await query("SELECT * FROM backtest_runs WHERE parameters->>'moduleCode' = $1 ORDER BY started_at DESC LIMIT 1", [moduleCode])
      : await query("SELECT * FROM backtest_runs ORDER BY started_at DESC LIMIT 1");
    if (!run.rows[0]) return null;
    const trades = await query("SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY session_date", [run.rows[0].id]);
    const metrics = await query("SELECT * FROM backtest_metrics WHERE backtest_run_id = $1 ORDER BY metric_key", [run.rows[0].id]);
    return { ...run.rows[0], trades: trades.rows, metrics: metrics.rows };
  });

  app.get("/api/backtests/:id", async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("SELECT * FROM backtest_runs WHERE id = $1", [id]);
    return rows[0];
  });

  app.get("/api/backtests/:id/trades", async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("SELECT * FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY session_date", [id]);
    return rows;
  });

  app.get("/api/backtests/:id/metrics", async (request) => {
    const { id } = request.params as { id: string };
    const { rows } = await query("SELECT * FROM backtest_metrics WHERE backtest_run_id = $1 ORDER BY metric_key", [id]);
    return rows;
  });
}

function runLiquiditySweepMemoryCacheBacktest(input: {
  symbol: string;
  timeframe: number;
  candles: Candle[];
  strategyVersionId: string;
  configuration: any;
  source?: string;
}) {
  const candles = [...input.candles].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
  const config = input.configuration ?? {};
  const sessionStart = String(config.newYorkStartTime ?? "09:30");
  const tradeWindowEnd = String(config.newYorkEndTime ?? "16:00");
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = newYorkDate(new Date(candle.timestampUtc));
    byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  }

  const trades: BacktestTrade[] = [];
  let sessionsTested = 0;
  let skippedSessions = 0;

  for (const [sessionDate, group] of [...byDate.entries()].sort()) {
    sessionsTested += 1;
    const times = sessionTimesForDate(sessionDate, sessionStart, 0, tradeWindowEnd);
    const signalCandles = group.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc <= times.signalWindowEndAt);
    if (signalCandles.length < 20) {
      skippedSessions += 1;
      continue;
    }
    for (let index = 0; index < signalCandles.length; index += 1) {
      const current = signalCandles[index];
      const setupCandles = group.filter((candle) => candle.timestampUtc <= current.timestampUtc);
      const decision = evaluateLiquiditySweepSetup({
        now: current.timestampUtc,
        symbol: input.symbol,
        setupCandles,
        biasCandles: aggregateCandles(setupCandles, input.timeframe, 15),
        spread: current.spread ?? null,
        newsStatus: "CLEAR",
        tradesTakenThisSession: trades.filter((trade) => trade.sessionDate === sessionDate).length,
        configuration: config
      });
      if (decision.status !== "LONG SETUP READY" && decision.status !== "SHORT SETUP READY") continue;
      if (!decision.direction || decision.entryPrice == null || decision.stopPrice == null || decision.targetPrice == null) continue;
      const exit = simulateExit(signalCandles.slice(index + 1), decision.direction, decision.entryPrice, decision.stopPrice, decision.targetPrice);
      const flags = decision.scenarioFlags ?? {};
      trades.push({
        sessionDate,
        scenario: decision.scenario,
        direction: decision.direction,
        entryPrice: decision.entryPrice,
        stopPrice: decision.stopPrice,
        targetPrice: decision.targetPrice,
        resultR: exit.resultR,
        outcome: exit.outcome,
        ambiguous: exit.ambiguous,
        details: {
          moduleCode: "high_probability_strategy_2",
          entryTime: current.timestampUtc,
          exitTime: exit.exitTime,
          finalReason: decision.finalReason,
          favorabilityScore: decision.favorabilityScore,
          favorabilityGrade: decision.favorabilityGrade,
          liquidityType: (flags as any).sweep?.level?.type ?? null,
          sweepDistanceAtr: (flags as any).sweep?.distanceAtr ?? null,
          bosLevel: (flags as any).bos?.level ?? null,
          entryZone: (flags as any).entryZone ?? null,
          htfBias: (flags as any).htfBias ?? null,
          evaluations: decision.evaluations ?? [],
          checklist: (decision.evaluations ?? []).map((evaluation: any) => ({
            ruleCode: evaluation.ruleCode,
            name: evaluation.name,
            status: evaluation.status,
            blocking: evaluation.blocking,
            explanation: evaluation.explanation
          })),
          hourNewYork: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(current.timestampUtc)),
          weekday: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(current.timestampUtc)),
          scenarioFlags: flags
        }
      });
      break;
    }
  }

  const metrics = buildMetrics(trades, sessionsTested, sessionsTested - skippedSessions, skippedSessions, candles.length);
  const failureAnalytics = analyzeModule2RuleFailures(input.symbol, input.timeframe, candles, config);
  const directionBreakdown = breakdownByTrade(trades, (trade) => trade.direction ?? "UNKNOWN");
  const gradeBreakdown = breakdownByTrade(trades, (trade) => String((trade.details as any).favorabilityGrade ?? "UNKNOWN"));
  const liquidityBreakdown = breakdownByDetail(trades, "liquidityType");
  const advanced = {
    max_drawdown_r: maxDrawdownR(trades),
    max_loss_streak: maxLossStreak(trades),
    best_trade: bestTrade(trades),
    worst_trade: worstTrade(trades),
    confidence: module2BacktestConfidence(metrics, failureAnalytics, trades),
    failure_analytics: failureAnalytics,
    direction_breakdown: directionBreakdown,
    grade_breakdown: gradeBreakdown
  };
  return {
    trades,
    metrics: {
      ...metrics,
      ...advanced,
      liquidity_type_breakdown: liquidityBreakdown,
      hour_breakdown: breakdownByDetail(trades, "hourNewYork"),
      weekday_breakdown: breakdownByDetail(trades, "weekday"),
      score_breakdown: scoreBreakdown(trades)
    },
    summary: {
      source: input.source ?? "LIVE_MEMORY_CACHE",
      moduleCode: "high_probability_strategy_2",
      symbol: input.symbol,
      timeframeMinutes: input.timeframe,
      candleCount: candles.length,
      sessionsTested,
      sessionsWithRange: sessionsTested - skippedSessions,
      skippedSessions,
      trades: trades.length,
      winRate: metrics.win_rate,
      totalR: metrics.total_r,
      averageR: metrics.average_r,
      maxDrawdownR: advanced.max_drawdown_r,
      maxLossStreak: advanced.max_loss_streak,
      confidence: advanced.confidence,
      bestTrade: advanced.best_trade,
      worstTrade: advanced.worst_trade,
      failureAnalytics,
      directionBreakdown,
      gradeBreakdown,
      liquidityBreakdown,
      scenarioBreakdown: metrics.scenario_breakdown
    }
  };
}

function runVwapOpeningDriveMemoryCacheBacktest(input: {
  symbol: string;
  timeframe: number;
  candles: Candle[];
  strategyVersionId: string;
  configuration: any;
  source?: string;
}) {
  const candles = [...input.candles].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
  const config = input.configuration ?? {};
  const sessionStart = String(config.newYorkStartTime ?? "09:30");
  const tradeWindowEnd = String(config.newYorkEndTime ?? "16:00");
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = newYorkDate(new Date(candle.timestampUtc));
    byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  }

  const trades: BacktestTrade[] = [];
  let sessionsTested = 0;
  let skippedSessions = 0;

  for (const [sessionDate, group] of [...byDate.entries()].sort()) {
    sessionsTested += 1;
    const times = sessionTimesForDate(sessionDate, sessionStart, 0, tradeWindowEnd);
    const signalCandles = group.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc <= times.signalWindowEndAt);
    if (signalCandles.length < 25) {
      skippedSessions += 1;
      continue;
    }
    for (let index = 0; index < signalCandles.length; index += 1) {
      const current = signalCandles[index];
      const setupCandles = group.filter((candle) => candle.timestampUtc <= current.timestampUtc);
      const decision: any = evaluateVwapOpeningDrive({
        now: current.timestampUtc,
        symbol: input.symbol,
        candles: setupCandles,
        sessionStartAt: times.sessionStartAt,
        sessionEndAt: times.signalWindowEndAt,
        spread: current.spread ?? null,
        newsStatus: "CLEAR",
        tradesTakenThisSession: trades.filter((trade) => trade.sessionDate === sessionDate).length,
        configuration: config
      });
      if (decision.status !== "LONG SETUP READY" && decision.status !== "SHORT SETUP READY") continue;
      if (!decision.direction || decision.entryPrice == null || decision.stopPrice == null || decision.targetPrice == null) continue;
      const exit = simulateExit(signalCandles.slice(index + 1), decision.direction as Direction, decision.entryPrice, decision.stopPrice, decision.targetPrice);
      const flags = decision.scenarioFlags ?? {};
      trades.push({
        sessionDate,
        scenario: decision.scenario,
        direction: decision.direction as Direction,
        entryPrice: decision.entryPrice,
        stopPrice: decision.stopPrice,
        targetPrice: decision.targetPrice,
        resultR: exit.resultR,
        outcome: exit.outcome,
        ambiguous: exit.ambiguous,
        details: {
          moduleCode: "strategy_lab_3",
          entryTime: current.timestampUtc,
          exitTime: exit.exitTime,
          finalReason: decision.finalReason,
          favorabilityScore: decision.favorabilityScore,
          favorabilityGrade: decision.favorabilityGrade,
          drive: (flags as any).drive ?? null,
          vwap: (flags as any).vwap ?? null,
          ema: (flags as any).ema ?? null,
          entryZone: (flags as any).entryZone ?? null,
          riskReward: (flags as any).riskReward ?? null,
          evaluations: decision.evaluations ?? [],
          checklist: (decision.evaluations ?? []).map((evaluation: any) => ({
            ruleCode: evaluation.ruleCode,
            name: evaluation.name,
            status: evaluation.status,
            blocking: evaluation.blocking,
            explanation: evaluation.explanation
          })),
          hourNewYork: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(current.timestampUtc)),
          weekday: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(current.timestampUtc)),
          scenarioFlags: flags
        }
      });
      break;
    }
  }

  const metrics = buildMetrics(trades, sessionsTested, sessionsTested - skippedSessions, skippedSessions, candles.length);
  const directionBreakdown = breakdownByTrade(trades, (trade) => trade.direction ?? "UNKNOWN");
  const gradeBreakdown = breakdownByTrade(trades, (trade) => String((trade.details as any).favorabilityGrade ?? "UNKNOWN"));
  const advanced = {
    max_drawdown_r: maxDrawdownR(trades),
    max_loss_streak: maxLossStreak(trades),
    best_trade: bestTrade(trades),
    worst_trade: worstTrade(trades),
    confidence: {
      status: trades.length >= 30 ? "RESEARCH_READY" : "LOW_SAMPLE",
      reason: trades.length >= 30 ? "Module 3 has enough sample trades for early tuning review." : "Module 3 needs more NY sessions before trusting win-rate claims.",
      sampleSize: trades.length
    },
    direction_breakdown: directionBreakdown,
    grade_breakdown: gradeBreakdown
  };
  return {
    trades,
    metrics: {
      ...metrics,
      ...advanced,
      hour_breakdown: breakdownByDetail(trades, "hourNewYork"),
      weekday_breakdown: breakdownByDetail(trades, "weekday"),
      score_breakdown: scoreBreakdown(trades)
    },
    summary: {
      source: input.source ?? "LIVE_MEMORY_CACHE",
      moduleCode: "strategy_lab_3",
      symbol: input.symbol,
      timeframeMinutes: input.timeframe,
      candleCount: candles.length,
      sessionsTested,
      sessionsWithRange: sessionsTested - skippedSessions,
      skippedSessions,
      trades: trades.length,
      winRate: metrics.win_rate,
      totalR: metrics.total_r,
      averageR: metrics.average_r,
      maxDrawdownR: advanced.max_drawdown_r,
      maxLossStreak: advanced.max_loss_streak,
      confidence: advanced.confidence,
      bestTrade: advanced.best_trade,
      worstTrade: advanced.worst_trade,
      directionBreakdown,
      gradeBreakdown,
      scenarioBreakdown: metrics.scenario_breakdown
    }
  };
}

function runMemoryCacheBacktest(input: {
  symbol: string;
  timeframe: number;
  candles: Candle[];
  strategyVersionId: string;
  configuration: any;
  sessionStart: string;
  openingRangeMinutes: number;
  tradeWindowEnd: string;
  source?: string;
}) {
  const candles = [...input.candles].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = newYorkDate(new Date(candle.timestampUtc));
    byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  }

  const trades: BacktestTrade[] = [];
  let sessionsTested = 0;
  let sessionsWithRange = 0;
  let skippedSessions = 0;

  for (const [sessionDate, group] of [...byDate.entries()].sort()) {
    sessionsTested += 1;
    const times = sessionTimesForDate(sessionDate, input.sessionStart, input.openingRangeMinutes, input.tradeWindowEnd);
    const rangeCandles = group.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc < times.openingRangeEndAt);
    const expectedCount = Math.ceil(input.openingRangeMinutes / input.timeframe);
    const openingRange = buildOpeningRange(rangeCandles, 0.01, expectedCount);
    if (openingRange.status !== "LOCKED") {
      skippedSessions += 1;
      continue;
    }
    sessionsWithRange += 1;
    const signalCandles = group.filter((candle) => candle.timestampUtc >= times.openingRangeEndAt && candle.timestampUtc <= times.signalWindowEndAt);
    for (let index = 0; index < signalCandles.length; index += 1) {
      const currentCandle = signalCandles[index];
      const previousCandles = signalCandles.slice(0, index);
      const decision = evaluateSetup({
        now: currentCandle.timestampUtc,
        symbol: input.symbol,
        strategyVersionId: input.strategyVersionId,
        session: {
          id: `backtest-${sessionDate}`,
          symbol: input.symbol,
          strategyVersionId: input.strategyVersionId,
          sessionDate,
          sessionPreset: "NY_0915",
          state: "WAITING_FOR_SETUP",
          sessionStartAt: times.sessionStartAt,
          openingRangeEndAt: times.openingRangeEndAt,
          signalWindowEndAt: times.signalWindowEndAt,
          dataStatus: "VALID"
        },
        openingRange,
        currentCandle,
        previousCandles,
        spread: currentCandle.spread ?? undefined,
        newsStatus: "CLEAR",
        riskStatus: "PERMITTED",
        configuration: input.configuration
      });
      if (decision.status !== "LONG SETUP READY" && decision.status !== "SHORT SETUP READY") continue;
      if (!decision.direction || decision.entryPrice == null || decision.stopPrice == null || decision.targetPrice == null) continue;
      const exit = simulateExit(signalCandles.slice(index + 1), decision.direction, decision.entryPrice, decision.stopPrice, decision.targetPrice);
      trades.push({
        sessionDate,
        scenario: decision.scenario,
        direction: decision.direction,
        entryPrice: decision.entryPrice,
        stopPrice: decision.stopPrice,
        targetPrice: decision.targetPrice,
        resultR: exit.resultR,
        outcome: exit.outcome,
        ambiguous: exit.ambiguous,
        details: {
          entryTime: currentCandle.timestampUtc,
          exitTime: exit.exitTime,
          finalReason: decision.finalReason,
          favorabilityScore: decision.favorabilityScore,
          favorabilityGrade: decision.favorabilityGrade,
          scenarioFlags: decision.scenarioFlags
        }
      });
      break;
    }
  }

  const metrics = buildMetrics(trades, sessionsTested, sessionsWithRange, skippedSessions, candles.length);
  const advanced = {
    max_drawdown_r: maxDrawdownR(trades),
    max_loss_streak: maxLossStreak(trades),
    best_trade: bestTrade(trades),
    worst_trade: worstTrade(trades),
    confidence: orbBacktestConfidence(metrics, trades)
  };
  return {
    trades,
    metrics: { ...metrics, ...advanced, direction_breakdown: breakdownByTrade(trades, (trade) => trade.direction ?? "UNKNOWN") },
    summary: {
      source: input.source ?? "LIVE_MEMORY_CACHE",
      moduleCode: "orb_max_options",
      symbol: input.symbol,
      timeframeMinutes: input.timeframe,
      candleCount: candles.length,
      sessionsTested,
      sessionsWithRange,
      skippedSessions,
      trades: trades.length,
      winRate: metrics.win_rate,
      totalR: metrics.total_r,
      averageR: metrics.average_r,
      maxDrawdownR: advanced.max_drawdown_r,
      maxLossStreak: advanced.max_loss_streak,
      confidence: advanced.confidence,
      bestTrade: advanced.best_trade,
      worstTrade: advanced.worst_trade,
      scenarioBreakdown: metrics.scenario_breakdown
    }
  };
}

function simulateExit(future: Candle[], direction: Direction, entry: number, stop: number, target: number) {
  const stopDistance = Math.abs(entry - stop);
  const targetR = stopDistance > 0 ? Math.abs(target - entry) / stopDistance : 0;
  for (const candle of future) {
    const stopHit = direction === "LONG" ? candle.low <= stop : candle.high >= stop;
    const targetHit = direction === "LONG" ? candle.high >= target : candle.low <= target;
    if (stopHit && targetHit) return { outcome: "LOSS" as const, resultR: -1, ambiguous: true, exitTime: candle.timestampUtc };
    if (stopHit) return { outcome: "LOSS" as const, resultR: -1, ambiguous: false, exitTime: candle.timestampUtc };
    if (targetHit) return { outcome: "WIN" as const, resultR: Number(targetR.toFixed(4)), ambiguous: false, exitTime: candle.timestampUtc };
  }
  return { outcome: "BREAKEVEN" as const, resultR: 0, ambiguous: false, exitTime: null };
}

function buildMetrics(trades: BacktestTrade[], sessionsTested: number, sessionsWithRange: number, skippedSessions: number, candleCount: number) {
  const wins = trades.filter((trade) => trade.outcome === "WIN").length;
  const losses = trades.filter((trade) => trade.outcome === "LOSS").length;
  const breakeven = trades.filter((trade) => trade.outcome === "BREAKEVEN").length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const scenarioBreakdown = trades.reduce<Record<string, { trades: number; wins: number; losses: number; totalR: number }>>((accumulator, trade) => {
    const row = accumulator[trade.scenario] ?? { trades: 0, wins: 0, losses: 0, totalR: 0 };
    row.trades += 1;
    row.wins += trade.outcome === "WIN" ? 1 : 0;
    row.losses += trade.outcome === "LOSS" ? 1 : 0;
    row.totalR += trade.resultR;
    accumulator[trade.scenario] = row;
    return accumulator;
  }, {});
  return {
    candle_count: candleCount,
    sessions_tested: sessionsTested,
    sessions_with_range: sessionsWithRange,
    skipped_sessions: skippedSessions,
    total_trades: trades.length,
    wins,
    losses,
    breakeven,
    win_rate: trades.length > 0 ? wins / trades.length : 0,
    total_r: Number(totalR.toFixed(4)),
    average_r: trades.length > 0 ? Number((totalR / trades.length).toFixed(4)) : 0,
    scenario_breakdown: scenarioBreakdown
  };
}

function aggregateCandles(candles: Candle[], sourceTimeframe: number, targetTimeframe: number) {
  if (sourceTimeframe >= targetTimeframe) return candles;
  const bucketMs = targetTimeframe * 60_000;
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const bucket = Math.floor(new Date(candle.timestampUtc).getTime() / bucketMs) * bucketMs;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]);
  }
  return [...buckets.entries()].sort((left, right) => left[0] - right[0]).map(([time, rows]) => ({
    timestampUtc: new Date(time).toISOString(),
    open: rows[0].open,
    high: Math.max(...rows.map((row) => row.high)),
    low: Math.min(...rows.map((row) => row.low)),
    close: rows.at(-1)?.close ?? rows[0].close,
    volume: rows.reduce((sum, row) => sum + Number(row.volume ?? 0), 0),
    spread: rows.at(-1)?.spread ?? null
  }));
}

function breakdownByDetail(trades: BacktestTrade[], key: string) {
  return breakdownByTrade(trades, (trade) => String((trade.details as any)[key] ?? "UNKNOWN"));
}

function breakdownByTrade(trades: BacktestTrade[], keyFor: (trade: BacktestTrade) => string) {
  return trades.reduce<Record<string, { trades: number; wins: number; losses: number; breakeven: number; winRate: number; totalR: number; averageR: number }>>((accumulator, trade) => {
    const value = keyFor(trade);
    const row = accumulator[value] ?? { trades: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, totalR: 0, averageR: 0 };
    row.trades += 1;
    row.wins += trade.outcome === "WIN" ? 1 : 0;
    row.losses += trade.outcome === "LOSS" ? 1 : 0;
    row.breakeven += trade.outcome === "BREAKEVEN" ? 1 : 0;
    row.totalR = Number((row.totalR + trade.resultR).toFixed(4));
    row.winRate = row.trades > 0 ? Number((row.wins / row.trades).toFixed(4)) : 0;
    row.averageR = row.trades > 0 ? Number((row.totalR / row.trades).toFixed(4)) : 0;
    accumulator[value] = row;
    return accumulator;
  }, {});
}

function legacyBreakdownByDetail(trades: BacktestTrade[], key: string) {
  return trades.reduce<Record<string, { trades: number; wins: number; losses: number; totalR: number }>>((accumulator, trade) => {
    const value = String((trade.details as any)[key] ?? "UNKNOWN");
    const row = accumulator[value] ?? { trades: 0, wins: 0, losses: 0, totalR: 0 };
    row.trades += 1;
    row.wins += trade.outcome === "WIN" ? 1 : 0;
    row.losses += trade.outcome === "LOSS" ? 1 : 0;
    row.totalR += trade.resultR;
    accumulator[value] = row;
    return accumulator;
  }, {});
}

function maxDrawdownR(trades: BacktestTrade[]) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.resultR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return Number(maxDrawdown.toFixed(4));
}

function bestTrade(trades: BacktestTrade[]) {
  const trade = [...trades].sort((left, right) => right.resultR - left.resultR)[0];
  return trade ? backtestTradeSummary(trade) : null;
}

function worstTrade(trades: BacktestTrade[]) {
  const trade = [...trades].sort((left, right) => left.resultR - right.resultR)[0];
  return trade ? backtestTradeSummary(trade) : null;
}

function backtestTradeSummary(trade: BacktestTrade) {
  return {
    sessionDate: trade.sessionDate,
    direction: trade.direction,
    scenario: trade.scenario,
    outcome: trade.outcome,
    resultR: trade.resultR,
    liquidityType: (trade.details as any).liquidityType ?? null,
    score: (trade.details as any).favorabilityScore ?? null,
    entryTime: (trade.details as any).entryTime ?? null
  };
}

function module2BacktestConfidence(metrics: ReturnType<typeof buildMetrics>, failureAnalytics: ReturnType<typeof analyzeModule2RuleFailures>, trades: BacktestTrade[]) {
  const tradeCount = Number(metrics.total_trades ?? 0);
  const winRate = Number(metrics.win_rate ?? 0);
  const averageR = Number(metrics.average_r ?? 0);
  const totalR = Number(metrics.total_r ?? 0);
  const drawdown = maxDrawdownR(trades);
  if (tradeCount < 10) {
    return {
      grade: "NOT_ENOUGH_DATA",
      label: "Not enough data",
      recommendation: "Collect more NY-session candles before trusting this strategy statistically.",
      reasons: [`Only ${tradeCount} backtest trades found. Minimum 10 for a research read, 20+ preferred.`]
    };
  }
  if (tradeCount >= 20 && winRate >= 0.7 && averageR > 0.25 && totalR > 0 && drawdown <= 4) {
    return {
      grade: "STRONG_CANDIDATE",
      label: "Strong candidate",
      recommendation: "Eligible for extended live paper monitoring. Do not use for real external execution yet.",
      reasons: [`${tradeCount} trades`, `${(winRate * 100).toFixed(1)}% win rate`, `${averageR.toFixed(2)}R average`, `${drawdown.toFixed(2)}R max drawdown`]
    };
  }
  if (tradeCount >= 15 && winRate >= 0.55 && averageR > 0 && totalR > 0) {
    return {
      grade: "PAPER_TRADING_READY",
      label: "Paper-trading ready",
      recommendation: "Use live paper trading and journal review before any real trading decision.",
      reasons: [`Positive expectancy over ${tradeCount} trades`, `${(winRate * 100).toFixed(1)}% win rate`, `${averageR.toFixed(2)}R average`]
    };
  }
  return {
    grade: "RESEARCH_ONLY",
    label: "Research only",
    recommendation: "Keep Module 2 in research/paper observation and review failed-rule concentration before tuning.",
    reasons: [
      `${tradeCount} trades`,
      `${(winRate * 100).toFixed(1)}% win rate`,
      `${averageR.toFixed(2)}R average`,
      `Top failed rule: ${failureAnalytics.topFailedRules[0]?.ruleCode ?? "none"}`
    ]
  };
}

function orbBacktestConfidence(metrics: ReturnType<typeof buildMetrics>, trades: BacktestTrade[]) {
  const tradeCount = Number(metrics.total_trades ?? 0);
  const winRate = Number(metrics.win_rate ?? 0);
  const averageR = Number(metrics.average_r ?? 0);
  const totalR = Number(metrics.total_r ?? 0);
  const drawdown = maxDrawdownR(trades);
  if (tradeCount < 10) {
    return {
      grade: "NOT_ENOUGH_DATA",
      label: "Not enough data",
      recommendation: "Collect more NY ORB sessions before trusting Module 1 statistically.",
      reasons: [`Only ${tradeCount} backtest trades found. Minimum 10 for a research read, 20+ preferred.`]
    };
  }
  if (tradeCount >= 20 && winRate >= 0.6 && averageR > 0.2 && totalR > 0 && drawdown <= 5) {
    return {
      grade: "STRONG_CANDIDATE",
      label: "Strong candidate",
      recommendation: "Eligible for extended live paper monitoring. Real external execution remains manual only.",
      reasons: [`${tradeCount} trades`, `${(winRate * 100).toFixed(1)}% win rate`, `${averageR.toFixed(2)}R average`, `${drawdown.toFixed(2)}R max drawdown`]
    };
  }
  if (tradeCount >= 15 && winRate >= 0.5 && averageR > 0 && totalR > 0) {
    return {
      grade: "PAPER_TRADING_READY",
      label: "Paper-trading ready",
      recommendation: "Continue live paper tracking and journal review before trusting the module.",
      reasons: [`Positive expectancy over ${tradeCount} trades`, `${(winRate * 100).toFixed(1)}% win rate`, `${averageR.toFixed(2)}R average`]
    };
  }
  return {
    grade: "RESEARCH_ONLY",
    label: "Research only",
    recommendation: "Keep Module 1 in paper/research mode and review scenario performance before tuning.",
    reasons: [`${tradeCount} trades`, `${(winRate * 100).toFixed(1)}% win rate`, `${averageR.toFixed(2)}R average`]
  };
}

async function insertModule2BacktestLearningRun(tenantId: string, summary: any, metrics: Record<string, any>) {
  const confidence = metrics.confidence ?? summary.confidence ?? {};
  const recommendations = module2BacktestRecommendations(summary, metrics);
  const run = await query(
    `INSERT INTO module_learning_runs (tenant_id, module_code, source, status, sample_size, summary, completed_at)
     VALUES ($1,'high_probability_strategy_2','MODULE2_BACKTEST_CACHE','COMPLETED',$2,$3::jsonb,now())
     RETURNING *`,
    [tenantId, Number(summary.trades ?? 0), JSON.stringify({ ...summary, confidence, generatedFrom: "CACHE_BACKTEST" })]
  );
  for (const item of recommendations) {
    await query(
      `INSERT INTO module_learning_recommendations (
        learning_run_id, module_code, recommendation_type, confidence, title, rationale, metrics, suggested_action
      ) VALUES ($1,'high_probability_strategy_2',$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [
        run.rows[0].id,
        item.recommendationType,
        item.confidence,
        item.title,
        item.rationale,
        JSON.stringify(item.metrics),
        JSON.stringify(item.suggestedAction)
      ]
    );
  }
  return { runId: run.rows[0].id, recommendations: recommendations.length, confidence };
}

function module2BacktestRecommendations(summary: any, metrics: Record<string, any>) {
  const confidence = metrics.confidence ?? {};
  const failureAnalytics = metrics.failure_analytics ?? summary.failureAnalytics ?? {};
  const topFailure = failureAnalytics.topFailedRules?.[0];
  const out: Array<{
    recommendationType: string;
    confidence: string;
    title: string;
    rationale: string;
    metrics: unknown;
    suggestedAction: Record<string, unknown>;
  }> = [
    {
      recommendationType: "BACKTEST_CONFIDENCE",
      confidence: confidence.grade === "STRONG_CANDIDATE" ? "HIGH" : confidence.grade === "PAPER_TRADING_READY" ? "MEDIUM" : "LOW",
      title: `Module 2 backtest confidence: ${confidence.label ?? "Unknown"}`,
      rationale: confidence.recommendation ?? "Backtest confidence was generated from cached candles.",
      metrics: { summary, confidence },
      suggestedAction: { action: confidence.grade === "STRONG_CANDIDATE" || confidence.grade === "PAPER_TRADING_READY" ? "CONTINUE_LIVE_PAPER_MONITORING" : "COLLECT_MORE_DATA" }
    }
  ];
  if (topFailure) {
    out.push({
      recommendationType: "BACKTEST_RULE_FAILURE_FOCUS",
      confidence: Number(topFailure.count ?? 0) >= 5 ? "MEDIUM" : "LOW",
      title: `Review failed rule: ${topFailure.ruleCode}`,
      rationale: `${topFailure.ruleCode} was the most common Module 2 backtest blocker with ${topFailure.count} occurrences.`,
      metrics: failureAnalytics,
      suggestedAction: { action: "REVIEW_RULE", ruleCode: topFailure.ruleCode }
    });
  }
  return out;
}

function scoreBreakdown(trades: BacktestTrade[]) {
  return trades.reduce<Record<string, { trades: number; wins: number; losses: number; totalR: number }>>((accumulator, trade) => {
    const score = Number((trade.details as any).favorabilityScore ?? 0);
    const bucket = score >= 90 ? "90-110" : score >= 80 ? "80-89" : score >= 70 ? "70-79" : "below-70";
    const row = accumulator[bucket] ?? { trades: 0, wins: 0, losses: 0, totalR: 0 };
    row.trades += 1;
    row.wins += trade.outcome === "WIN" ? 1 : 0;
    row.losses += trade.outcome === "LOSS" ? 1 : 0;
    row.totalR += trade.resultR;
    accumulator[bucket] = row;
    return accumulator;
  }, {});
}

function module2TuningPresets(base: any) {
  return [
    {
      code: "custom_current",
      label: "Custom Current",
      description: "Tenant's current Module 2 settings.",
      configuration: { ...base }
    },
    {
      code: "balanced",
      label: "Balanced",
      description: "Default production-style balance between selectivity and opportunity.",
      configuration: {
        ...base,
        minimumSignalScore: 80,
        minimumRiskReward: 2,
        minimumDisplacementRangeATR: 1.2,
        minimumBodyPercentage: 0.6,
        maximumBarsAfterSweepForBos: 10,
        maximumBarsAfterBosForEntry: 15
      }
    },
    {
      code: "conservative",
      label: "Conservative",
      description: "Higher quality threshold, fewer trades, stronger displacement and RR required.",
      configuration: {
        ...base,
        minimumSignalScore: 90,
        minimumRiskReward: 2.5,
        minimumDisplacementRangeATR: 1.4,
        minimumBodyPercentage: 0.68,
        maximumSweepDistanceATR: 0.85,
        maximumBarsAfterSweepForBos: 8,
        maximumBarsAfterBosForEntry: 10
      }
    },
    {
      code: "aggressive",
      label: "Aggressive",
      description: "More opportunities with looser score, displacement, and RR filters.",
      configuration: {
        ...base,
        minimumSignalScore: 70,
        minimumRiskReward: 1.5,
        minimumDisplacementRangeATR: 1,
        minimumBodyPercentage: 0.52,
        maximumSweepDistanceATR: 1.3,
        maximumBarsAfterSweepForBos: 12,
        maximumBarsAfterBosForEntry: 20
      }
    }
  ];
}

async function buildModule2TuningLab(tenantId: string | null, symbol: string) {
  const timeframe = 5;
  const version = await selectedStrategyVersion("high_probability_strategy_2");
  const baseConfiguration = await getTenantModuleStrategyConfiguration(tenantId, "high_probability_strategy_2", "liquiditySweep.strategy", version.configuration_json);
  const candles = getCachedCandles(symbol, timeframe).map((candle) => ({
    timestampUtc: candle.timestampUtc,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    spread: candle.spread
  }));
  const presets = module2TuningPresets(baseConfiguration);
  const results = presets.map((preset) => {
    const result = runLiquiditySweepMemoryCacheBacktest({
      symbol,
      timeframe,
      candles,
      strategyVersionId: version.id,
      configuration: preset.configuration
    });
    const failureAnalytics = analyzeModule2RuleFailures(symbol, timeframe, candles, preset.configuration);
    return {
      preset: preset.code,
      label: preset.label,
      description: preset.description,
      configuration: preset.configuration,
      summary: {
        ...result.summary,
        averageR: result.metrics.average_r,
        maxLossStreak: maxLossStreak(result.trades),
        lowScoreTradesAvoided: failureAnalytics.lowScoreTradesAvoided
      },
      metrics: result.metrics,
      failureAnalytics
    };
  });
  return {
    moduleCode: "high_probability_strategy_2",
    symbol,
    timeframeMinutes: timeframe,
    candleCount: candles.length,
    generatedAt: new Date().toISOString(),
    presets: results,
    recommendation: recommendModule2Preset(results)
  };
}

async function module2PromotionSafetyChecks(tenantId: string | null, target: any, current: any, qaOnly: boolean) {
  const audit = await module2ProductionAuditCounts(tenantId);
  const sampleTrades = Number(target.summary?.trades ?? 0);
  const targetWinRate = Number(target.summary?.winRate ?? 0);
  const targetTotalR = Number(target.summary?.totalR ?? 0);
  const currentWinRate = Number(current?.summary?.winRate ?? 0);
  const currentTotalR = Number(current?.summary?.totalR ?? 0);
  return [
    {
      code: "PRODUCTION_AUDIT_PASS",
      status: audit.invalidTrades === 0 && audit.moduleMix === 0 ? "PASS" : "FAIL",
      detail: audit
    },
    {
      code: "SAMPLE_SIZE",
      status: sampleTrades >= 20 || qaOnly ? "PASS" : "FAIL",
      detail: { trades: sampleTrades, minimum: 20, qaOnly }
    },
    {
      code: "NOT_WORSE_THAN_CURRENT",
      status: targetWinRate < currentWinRate && targetTotalR < currentTotalR ? "FAIL" : "PASS",
      detail: { targetWinRate, currentWinRate, targetTotalR, currentTotalR }
    }
  ];
}

async function latestModule2Learning(tenantId: string | null) {
  const run = await query(
    `SELECT *
     FROM module_learning_runs
     WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2'
     ORDER BY started_at DESC
     LIMIT 1`,
    [tenantId]
  );
  const row = run.rows[0];
  if (!row) {
    return {
      moduleCode: "high_probability_strategy_2",
      status: "NOT_RUN",
      sample_size: 0,
      summary: {},
      recommendations: []
    };
  }
  const recommendations = await query(
    `SELECT *
     FROM module_learning_recommendations
     WHERE learning_run_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [row.id]
  );
  return { ...row, recommendations: recommendations.rows };
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
  const row = run.rows[0];
  if (!row) {
    return {
      moduleCode,
      status: "NOT_RUN",
      sample_size: 0,
      summary: {},
      recommendations: []
    };
  }
  const recommendations = await query(
    `SELECT *
     FROM module_learning_recommendations
     WHERE learning_run_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [row.id]
  );
  return { ...row, recommendations: recommendations.rows };
}

async function generateModule2SessionReport(tenantId: string | null, requestedDate?: string) {
  const moduleCode = "high_probability_strategy_2";
  const sessionDate = requestedDate ?? newYorkDate();
  const sessionResult = await query(
    `SELECT *
     FROM trading_sessions
     WHERE tenant_id = $1 AND module_code = $2 AND session_date = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, moduleCode, sessionDate]
  );
  const session = sessionResult.rows[0] as any;
  const sessionStart = session?.session_start_at ?? `${sessionDate}T00:00:00.000Z`;
  const sessionEnd = session?.signal_window_end_at ?? `${sessionDate}T23:59:59.999Z`;
  const [candles, setups, trades, failedRules, latestRehearsal, learningResult, configSetting] = await Promise.all([
    query(
      `SELECT count(*)::int AS count, min(timestamp_utc) AS first, max(timestamp_utc) AS latest
       FROM candles
       WHERE symbol = 'XAUUSD'
         AND timeframe_minutes = 5
         AND timestamp_utc >= $1
         AND timestamp_utc <= $2`,
      [sessionStart, sessionEnd]
    ),
    query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status IN ('LONG SETUP READY','SHORT SETUP READY','PAPER_TRADE_OPENED','TRADE_PLANNED'))::int AS valid_setups,
         count(*) FILTER (WHERE status IN ('NO TRADE','BLOCKED'))::int AS blocked_setups,
         max(detected_at) AS latest_setup_at
       FROM setup_candidates
       WHERE tenant_id = $1
         AND module_code = $2
         AND session_id = $3
         AND status <> 'TEST_CLEARED'`,
      [tenantId, moduleCode, session?.id ?? null]
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
      [tenantId, moduleCode, session?.id ?? null]
    ),
    query(
      `SELECT sre.rule_code, sre.name, sre.status, count(*)::int AS count
       FROM setup_rule_evaluations sre
       JOIN setup_candidates sc ON sc.id = sre.setup_candidate_id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.session_id = $3
         AND sre.status <> 'PASS'
       GROUP BY sre.rule_code, sre.name, sre.status
       ORDER BY count(*) DESC
       LIMIT 12`,
      [tenantId, moduleCode, session?.id ?? null]
    ),
    query(
      `SELECT final_status, checklist_json, health_json, dry_run_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1
         AND module_code = $2
         AND created_at >= $3::timestamptz - interval '12 hours'
         AND created_at <= $4::timestamptz + interval '12 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, moduleCode, sessionStart, sessionEnd]
    ),
    latestModule2Learning(tenantId),
    query(
      `SELECT updated_at
       FROM tenant_module_settings
       WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2' AND key = 'liquiditySweep.strategy'
       LIMIT 1`,
      [tenantId]
    )
  ]);
  const learning = learningResult as any;
  const configSnapshot = { moduleCode: "high_probability_strategy_2", settingKey: "liquiditySweep.strategy", updatedAt: configSetting.rows[0]?.updated_at ?? null };
  const candleRow = candles.rows[0] ?? {};
  const setupRow = setups.rows[0] ?? {};
  const tradeRow = trades.rows[0] ?? {};
  const rehearsal = latestRehearsal.rows[0] ?? null;
  const dominantOutcome = Number(tradeRow.wins ?? 0) > 0 ? "WIN" : Number(tradeRow.losses ?? 0) > 0 ? "LOSS" : Number(tradeRow.active ?? 0) > 0 ? "ACTIVE" : "NONE";
  const blockedReasons = [
    !session ? "No Module 2 trading session was found for this NY date." : null,
    Number(candleRow.count ?? 0) < 10 ? "Too few 5M candles were stored for the session." : null,
    rehearsal?.final_status !== "GO" ? "Latest launch rehearsal did not pass GO." : null,
    Number(setupRow.valid_setups ?? 0) === 0 ? "No valid Module 2 setup reached paper-trade readiness." : null,
    ...failedRules.rows.slice(0, 5).map((row: any) => `${row.rule_code}: ${row.count}`)
  ].filter(Boolean);
  const finalStatus = blockedReasons.length === 0 ? "GO" : Number(setupRow.total ?? 0) > 0 || Number(candleRow.count ?? 0) > 0 ? "REVIEW" : "NO_GO";
  const summary = {
    sessionDate,
    symbol: "XAUUSD",
    sessionFound: Boolean(session),
    validSetups: Number(setupRow.valid_setups ?? 0),
    blockedSetups: Number(setupRow.blocked_setups ?? 0),
    paperTrades: Number(tradeRow.total ?? 0),
    wins: Number(tradeRow.wins ?? 0),
    losses: Number(tradeRow.losses ?? 0),
    active: Number(tradeRow.active ?? 0),
    totalR: Number(tradeRow.total_r ?? 0)
  };
  const report = await query(
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
      tenantId,
      moduleCode,
      session?.id ?? null,
      sessionDate,
      finalStatus,
      JSON.stringify(summary),
      JSON.stringify({ candles5m: Number(candleRow.count ?? 0), firstCandleAt: candleRow.first ?? null, latestCandleAt: candleRow.latest ?? null }),
      JSON.stringify({ total: Number(setupRow.total ?? 0), valid: Number(setupRow.valid_setups ?? 0), blocked: Number(setupRow.blocked_setups ?? 0), latestSetupAt: setupRow.latest_setup_at ?? null }),
      JSON.stringify({ ...tradeRow, dominantOutcome }),
      JSON.stringify(blockedReasons),
      JSON.stringify({ latestRehearsal: rehearsal, failedRules: failedRules.rows, configSnapshot }),
      JSON.stringify({ latestLearningAt: learning.completed_at ?? null, sampleSize: learning.sample_size ?? 0, recommendations: (learning.recommendations ?? []).slice(0, 5) })
    ]
  );
  return report.rows[0];
}

function module2LearningProposedChange(recommendation: any) {
  const action = recommendation.suggested_action ?? {};
  const kind = recommendation.recommendation_type;
  if (kind === "RAISE_QUALITY_THRESHOLD" || action.action === "RESTRICT_GRADE") {
    return {
      mode: "QA_ONLY_TUNING_REVIEW",
      settingKey: "liquiditySweep.strategy",
      changes: {
        minimumSignalScore: 85,
        minimumRiskReward: 2
      },
      reason: "Weak lower-grade performance. Review stricter confirmation/quality thresholds in tuning lab."
    };
  }
  if (kind === "RULE_FAILURE_FOCUS" || action.action === "REVIEW_RULE") {
    const ruleCode = action.ruleCode ?? recommendation.metrics?.ruleCode;
    const layer = module2RuleLayer(ruleCode);
    return {
      mode: "QA_ONLY_TUNING_REVIEW",
      settingKey: "liquiditySweep.strategy",
      changes: layer === "quality"
        ? { minimumRiskReward: 2 }
        : layer === "confirmation"
          ? { minimumSignalScore: 80 }
          : {},
      focusRule: ruleCode,
      reason: "Review the most common failed rule without changing mandatory hard-rule sequence."
    };
  }
  if (kind === "PRODUCTION_READY" || action.action === "ALLOW_PROMOTION_REVIEW") {
    return {
      mode: "PROMOTION_REVIEW",
      settingKey: "liquiditySweep.strategy",
      changes: {},
      reason: "Learning result is eligible for tuning-lab promotion review."
    };
  }
  return {
    mode: "OBSERVE_ONLY",
    settingKey: "liquiditySweep.strategy",
    changes: {},
    reason: "Recommendation is informational until more closed paper-trade data exists."
  };
}

function module2LearningGuardrails(recommendation: any, proposed: any) {
  const action = recommendation.suggested_action ?? {};
  const sampleSize = Number(recommendation.sample_size ?? 0);
  const changes = proposed.changes ?? {};
  const focusRule = proposed.focusRule ?? action.ruleCode;
  const layer = module2RuleLayer(focusRule);
  return [
    {
      code: "MINIMUM_SAMPLE_SIZE",
      status: sampleSize >= 20 || proposed.mode === "OBSERVE_ONLY" ? "PASS" : "WARN",
      detail: { sampleSize, minimum: 20 }
    },
    {
      code: "NO_QA_REPLAY_DATA",
      status: "PASS",
      detail: "Module 2 learning excludes QA_TEST_SIGNAL and replay=true setup rows."
    },
    {
      code: "MINIMUM_RR_PROTECTED",
      status: changes.minimumRiskReward == null || Number(changes.minimumRiskReward) >= 2 ? "PASS" : "FAIL",
      detail: { proposedMinimumRiskReward: changes.minimumRiskReward ?? null, floor: 2 }
    },
    {
      code: "HARD_RULES_LOCKED",
      status: layer === "hard" && Object.keys(changes).length > 0 ? "FAIL" : "PASS",
      detail: { focusRule: focusRule ?? null, layer }
    },
    {
      code: "ONLY_CONFIRMATION_OR_QUALITY_TUNING",
      status: ["OBSERVE_ONLY", "PROMOTION_REVIEW"].includes(proposed.mode) || Object.keys(changes).every((key) => ["minimumSignalScore", "minimumRiskReward"].includes(key)) ? "PASS" : "FAIL",
      detail: { changes }
    }
  ];
}

function module2RuleLayer(code?: string) {
  if (!code) return "none";
  if (code.startsWith("CONFIRM_") || code === "CONFIRMATION_COUNT") return "confirmation";
  if (code.startsWith("QUALITY_") || code === "QUALITY_FILTER_COUNT") return "quality";
  if (["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED"].includes(code)) return "hard";
  return "other";
}

async function module2ProductionAuditCounts(tenantId: string | null) {
  const [invalidTrades, moduleMix] = await Promise.all([
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
      `SELECT count(*)::int AS count
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN trading_sessions ts ON ts.id = sc.session_id
       WHERE sc.tenant_id = $1
         AND sc.module_code <> ts.module_code`,
      [tenantId]
    )
  ]);
  return {
    invalidTrades: Number(invalidTrades.rows[0]?.count ?? 0),
    moduleMix: Number(moduleMix.rows[0]?.count ?? 0)
  };
}

async function currentModule2Setting(tenantId: string | null) {
  const existing = await query(
    `SELECT value
     FROM tenant_module_settings
     WHERE tenant_id = $1 AND module_code = 'high_probability_strategy_2' AND key = 'liquiditySweep.strategy'
     LIMIT 1`,
    [tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as { value: any };
  const version = await selectedStrategyVersion("high_probability_strategy_2");
  return { value: version.configuration_json };
}

async function insertModule2Promotion(input: {
  tenantId: string;
  action: "APPLY_PRESET" | "ROLLBACK";
  presetCode: string;
  previousValue: unknown;
  appliedValue: unknown;
  tuningSummary: unknown;
  safetyChecks: unknown;
  qaOnly: boolean;
  reason?: string;
  appliedBy: string | null;
}) {
  const { rows } = await query(
    `INSERT INTO module_tuning_promotions (
      tenant_id, module_code, setting_key, action, preset_code,
      previous_value, applied_value, tuning_summary, safety_checks,
      qa_only, reason, applied_by
    ) VALUES (
      $1,'high_probability_strategy_2','liquiditySweep.strategy',$2,$3,
      $4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10
    ) RETURNING *`,
    [
      input.tenantId,
      input.action,
      input.presetCode,
      JSON.stringify(input.previousValue),
      JSON.stringify(input.appliedValue),
      JSON.stringify(input.tuningSummary),
      JSON.stringify(input.safetyChecks),
      input.qaOnly,
      input.reason ?? null,
      input.appliedBy
    ]
  );
  return rows[0];
}

function analyzeModule2RuleFailures(symbol: string, timeframe: number, candles: Candle[], configuration: any) {
  const sorted = [...candles].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
  const byDate = new Map<string, Candle[]>();
  for (const candle of sorted) {
    const date = newYorkDate(new Date(candle.timestampUtc));
    byDate.set(date, [...(byDate.get(date) ?? []), candle]);
  }
  const stageCounts: Record<string, number> = {
    sweepPassedDisplacementFailed: 0,
    displacementPassedBosFailed: 0,
    bosPassedRetraceFailed: 0,
    scoreTooLow: 0,
    rrTooLow: 0
  };
  const ruleCounts: Record<string, number> = {};
  let evaluatedCandles = 0;
  let lowScoreTradesAvoided = 0;
  const sessionStart = String(configuration.newYorkStartTime ?? "09:30");
  const tradeWindowEnd = String(configuration.newYorkEndTime ?? "16:00");

  for (const [sessionDate, group] of [...byDate.entries()].sort()) {
    const times = sessionTimesForDate(sessionDate, sessionStart, 0, tradeWindowEnd);
    const signalCandles = group.filter((candle) => candle.timestampUtc >= times.sessionStartAt && candle.timestampUtc <= times.signalWindowEndAt);
    let tradesTaken = 0;
    for (const current of signalCandles) {
      if (signalCandles.length < 20) continue;
      const setupCandles = group.filter((candle) => candle.timestampUtc <= current.timestampUtc);
      const decision = evaluateLiquiditySweepSetup({
        now: current.timestampUtc,
        symbol,
        setupCandles,
        biasCandles: aggregateCandles(setupCandles, timeframe, 15),
        spread: current.spread ?? null,
        newsStatus: "CLEAR",
        tradesTakenThisSession: tradesTaken,
        configuration
      });
      evaluatedCandles += 1;
      const failed = (decision.evaluations ?? []).find((evaluation) => evaluation.blocking && evaluation.status !== "PASS");
      if (failed) ruleCounts[failed.ruleCode] = (ruleCounts[failed.ruleCode] ?? 0) + 1;
      const passed = new Set((decision.evaluations ?? []).filter((evaluation) => evaluation.status === "PASS").map((evaluation) => evaluation.ruleCode));
      const failedRule = failed?.ruleCode;
      if (passed.has("LIQUIDITY_SWEEP_CONFIRMED") && failedRule === "DISPLACEMENT_CONFIRMED") stageCounts.sweepPassedDisplacementFailed += 1;
      if (passed.has("DISPLACEMENT_CONFIRMED") && failedRule === "BOS_CHOCH_CONFIRMED") stageCounts.displacementPassedBosFailed += 1;
      if (passed.has("BOS_CHOCH_CONFIRMED") && failedRule === "CONFIRMATION_COUNT") stageCounts.bosPassedRetraceFailed += 1;
      if (failedRule === "CONFIRMATION_COUNT" || failedRule === "QUALITY_FILTER_COUNT") {
        stageCounts.scoreTooLow += 1;
        lowScoreTradesAvoided += 1;
      }
      if ((decision.evaluations ?? []).some((evaluation) => evaluation.ruleCode === "QUALITY_RR" && evaluation.status !== "PASS")) stageCounts.rrTooLow += 1;
      if (decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY") {
        tradesTaken += 1;
        break;
      }
    }
  }

  return {
    evaluatedCandles,
    lowScoreTradesAvoided,
    stageCounts,
    topFailedRules: Object.entries(ruleCounts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([ruleCode, count]) => ({ ruleCode, count }))
  };
}

function maxLossStreak(trades: BacktestTrade[]) {
  let current = 0;
  let max = 0;
  for (const trade of trades) {
    if (trade.outcome === "LOSS") {
      current += 1;
      max = Math.max(max, current);
    } else if (trade.outcome === "WIN") {
      current = 0;
    }
  }
  return max;
}

function recommendModule2Preset(results: any[]) {
  const scored = results.map((result) => {
    const trades = Number(result.summary.trades ?? 0);
    const winRate = Number(result.summary.winRate ?? 0);
    const totalR = Number(result.summary.totalR ?? 0);
    const averageR = Number(result.summary.averageR ?? 0);
    const lossPenalty = Number(result.summary.maxLossStreak ?? 0) * 0.1;
    const samplePenalty = trades < 10 ? 0.35 : trades < 20 ? 0.15 : 0;
    return { ...result, recommendationScore: winRate * 2 + averageR + totalR / Math.max(10, trades) - lossPenalty - samplePenalty };
  });
  const best = [...scored].sort((left, right) => right.recommendationScore - left.recommendationScore)[0];
  const safest = [...scored].sort((left, right) => Number(right.summary.winRate ?? 0) - Number(left.summary.winRate ?? 0) || Number(left.summary.maxLossStreak ?? 0) - Number(right.summary.maxLossStreak ?? 0))[0];
  const mostTrades = [...scored].sort((left, right) => Number(right.summary.trades ?? 0) - Number(left.summary.trades ?? 0))[0];
  const sampleTrades = Math.max(...scored.map((result) => Number(result.summary.trades ?? 0)), 0);
  return {
    bestPreset: best?.preset ?? null,
    safestPreset: safest?.preset ?? null,
    mostTradesPreset: mostTrades?.preset ?? null,
    sampleSizeWarning: sampleTrades < 20 ? "Sample size is small. Treat tuning output as QA guidance, not a production conclusion." : null
  };
}

async function selectedStrategyVersion(moduleCode = "orb_max_options") {
  if (moduleCode === "high_probability_strategy_2") {
    const result = await query(
      `SELECT sv.*
       FROM strategy_versions sv
       JOIN strategies s ON s.id = sv.strategy_id
       WHERE s.id = '00000000-0000-0000-0000-000000000302'
       ORDER BY sv.activated_at DESC NULLS LAST, sv.created_at DESC
       LIMIT 1`
    );
    return result.rows[0] as any;
  }
  if (moduleCode === "strategy_lab_3") {
    const result = await query(
      `SELECT sv.*
       FROM strategy_versions sv
       JOIN strategies s ON s.id = sv.strategy_id
       WHERE s.id = '00000000-0000-0000-0000-000000000303'
       ORDER BY sv.activated_at DESC NULLS LAST, sv.created_at DESC
       LIMIT 1`
    );
    return result.rows[0] as any;
  }
  const result = await query("SELECT * FROM strategy_versions WHERE id = (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1)");
  return result.rows[0] as any;
}
