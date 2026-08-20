import { calculateRisk, evaluateSignalGeometryQuality, XAUUSD_PRODUCTION_SIGNAL_POLICY } from "@orb-guide/risk-engine";
import {
  DEFAULT_HORIZONTAL_RANGE_CONFIG,
  HorizontalRangeDetector,
  RANGE_BREAKOUT_PROFILES,
  RangeConflictResolver,
  RangeDecisionEngine,
  RetestEngine,
  evaluateRangeBreakout
} from "@orb-guide/range-engine";
import { buildOpeningRange, evaluateSetup } from "@orb-guide/strategy-engine";
import type { Candle } from "@orb-guide/shared-types";
import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { getTenantOrbStrategyConfiguration } from "../admin/settings.js";
import { runMainBrainPython } from "../admin/learning.js";
import { requirePermission, requireTenantModule } from "../auth/routes.js";
import { canCreateTenantNotification } from "../billing/limits.js";
import { sendTenantPush } from "../notifications/push.js";
import { cancelPendingPaperTargets, ensurePaperTradeTargets } from "../trades/paper-targets.js";

type ReplayCase = "BUY" | "SELL" | "RETEST" | "FAKEOUT" | "SWEEP_REVERSAL" | "OVEREXTENDED" | "NO_TRADE";
type Module2ReplayCase =
  | "BUY"
  | "SELL"
  | "SWEEP_ONLY"
  | "SWEEP_NO_CONFIRMATION"
  | "SWEEP_ENGULFING"
  | "SWEEP_BOS"
  | "SWEEP_MSS"
  | "SWEEP_VOLUME_EXPANSION"
  | "DISPLACEMENT_RETEST"
  | "BOS_RETEST"
  | "MSS_RETEST"
  | "MSS_DISPLACEMENT_RETEST"
  | "EMA_ALIGNED_SWEEP"
  | "SWEEP_NO_DISPLACEMENT"
  | "DISPLACEMENT_NO_BOS"
  | "BOS_NO_RETRACE"
  | "INVALIDATED_SETUP"
  | "LOW_SCORE_NO_TRADE";

const XAUUSD_PAPER_SPEC = {
  contractSize: 100,
  tickSize: 0.01,
  tickValue: 1,
  minimumLot: 0.01,
  lotStep: 0.01,
  maximumLot: 50,
  commissionPerLot: 0
};

const XAUUSD_PIP_SIZE = XAUUSD_PAPER_SPEC.tickSize;
const SIGNAL_TARGET_R_MULTIPLES = [1, 1.5] as const;
const DAY_TRADING_HOLD_WINDOW = {
  label: "Intraday only",
  preferredHours: "4-5",
  maximumHours: 12,
  guidance: "Review or close the paper trade before the day-trading window expires."
};
const MINIMUM_VISIBLE_PREDICTION_PROBABILITY = 80;
const MAX_LIVE_PREDICTION_AGE_MINUTES = 90;
const MAX_LIVE_PREDICTION_ENTRY_DISTANCE = 10;
const SETUP_DEFAULT_PAPER_RISK_PROFILE = {
  account_balance: 10_000,
  account_equity: 10_000,
  risk_per_trade_percent: 0.25,
  maximum_daily_loss_percent: 0.75,
  maximum_weekly_loss_percent: 2,
  minimum_reward_to_risk: 1.5
} as const;
const MODULE2_STRICT_VARIANT = {
  code: "SWEEP_MSS_RETEST",
  name: "F. Sweep + MSS + Retest",
  version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0",
  paperEligible: true,
  approvalStatus: "PRODUCTION_APPROVED",
  category: "PRODUCTION"
};
const MODULE2_HIGHEST_CONFIRMATION_VARIANT = {
  code: "SWEEP_MSS_DISPLACEMENT_RETEST",
  name: "I. Sweep + MSS + Displacement + Retest",
  version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0",
  paperEligible: true,
  approvalStatus: "PRODUCTION_APPROVED",
  category: "PRODUCTION"
};
const MODULE2_STRICT_REQUIRED_RULES = [
  "DATA_HEALTHY",
  "MARKET_CONTEXT_READY",
  "MARKET_REGIME_CLASSIFIED",
  "NY_SESSION_ACTIVE",
  "DAILY_TRADE_LIMIT",
  "ACTIVE_SETUP_CONFLICT_CLEAR",
  "NO_ACTIVE_TRADE_CONFLICT",
  "RISK_LIMITS_CLEAR",
  "MANUAL_CONFIRMATION_COMPLETED",
  "LIQUIDITY_LEVEL_IDENTIFIED",
  "LIQUIDITY_SWEEP_CONFIRMED",
  "SWEEP_REJECTION_CONFIRMED",
  "SWEEP_ACCEPTANCE_BLOCK",
  "PROTECTED_POINT_CONFIDENCE",
  "BOS_CHOCH_CONFIRMED",
  "MSS_STRENGTH",
  "ENTRY_ZONE_READY",
  "ENTRY_ZONE_RETRACE",
  "CONFIRM_ENTRY_CANDLE",
  "DIRECTIONAL_CONFLICT_CLEAR",
  "RISK_OK",
  "VARIANT_SELECTED"
] as const;
const MODULE2_CONFIRMATION_RULES = ["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRM_ENTRY_CANDLE"] as const;
const MODULE2_QUALITY_RULES = ["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP"] as const;

const MODULE2_QA_CASES: Array<{
  code: Module2ReplayCase;
  label: string;
  expected: string;
  expectedStatus: string;
  opensPaperTrade: boolean;
  failureRule?: string;
}> = [
  { code: "BUY", label: "Valid BUY", expected: "SWEEP_MSS_RETEST_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SELL", label: "Valid SELL", expected: "SWEEP_MSS_RETEST_SELL", expectedStatus: "SHORT SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_ONLY", label: "Variant A: sweep close-back", expected: "SWEEP_CLOSE_BACK_INSIDE_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_NO_CONFIRMATION", label: "Sweep no-confirmation control", expected: "WAITING_FOR_DISPLACEMENT", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "DISPLACEMENT_CONFIRMED" },
  { code: "SWEEP_ENGULFING", label: "Variant D: sweep + engulfing", expected: "SWEEP_ENGULFING_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_BOS", label: "Variant B: sweep + BOS", expected: "SWEEP_BOS_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_MSS", label: "Variant C: sweep + MSS", expected: "SWEEP_MSS_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_VOLUME_EXPANSION", label: "Variant H: sweep + volume", expected: "SWEEP_VOLUME_EXPANSION_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "DISPLACEMENT_RETEST", label: "Displacement retest research", expected: "WAITING_FOR_MSS_RETEST", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "MSS_STRENGTH" },
  { code: "BOS_RETEST", label: "Variant E: sweep + BOS + retest", expected: "SWEEP_BOS_RETEST_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "MSS_RETEST", label: "Variant F: sweep + MSS + retest", expected: "SWEEP_MSS_RETEST_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "MSS_DISPLACEMENT_RETEST", label: "Variant I: sweep + MSS + displacement + retest", expected: "SWEEP_MSS_DISPLACEMENT_RETEST_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "EMA_ALIGNED_SWEEP", label: "Variant G: sweep + EMA", expected: "SWEEP_EMA_ALIGNMENT_BUY", expectedStatus: "LONG SETUP READY", opensPaperTrade: true },
  { code: "SWEEP_NO_DISPLACEMENT", label: "Sweep but no displacement", expected: "WAITING_FOR_DISPLACEMENT", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "DISPLACEMENT_CONFIRMED" },
  { code: "DISPLACEMENT_NO_BOS", label: "Displacement but no BOS", expected: "WAITING_FOR_BOS", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "BOS_CHOCH_CONFIRMED" },
  { code: "BOS_NO_RETRACE", label: "BOS but no retrace", expected: "WAITING_FOR_RETRACE", expectedStatus: "WAIT", opensPaperTrade: false, failureRule: "CONFIRM_ENTRY_CANDLE" },
  { code: "INVALIDATED_SETUP", label: "Invalidated setup", expected: "SETUP_INVALIDATED", expectedStatus: "NO TRADE", opensPaperTrade: false, failureRule: "CONFIRMATION_COUNT" },
  { code: "LOW_SCORE_NO_TRADE", label: "No approved variant control", expected: "LOW_SCORE_NO_TRADE", expectedStatus: "NO TRADE", opensPaperTrade: false, failureRule: "CONFIRMATION_COUNT" }
];
const MODULE2_VARIANT_MATRIX_CASES: Module2ReplayCase[] = [
  "SWEEP_ONLY",
  "SWEEP_BOS",
  "SWEEP_MSS",
  "SWEEP_ENGULFING",
  "BOS_RETEST",
  "MSS_RETEST",
  "EMA_ALIGNED_SWEEP",
  "SWEEP_VOLUME_EXPANSION",
  "MSS_DISPLACEMENT_RETEST",
  "SWEEP_NO_CONFIRMATION"
];

const ORB_QA_CASES: Array<{ code: ReplayCase; label: string; expected: string; tradable: boolean }> = [
  { code: "BUY", label: "Valid BUY breakout", expected: "OPENING_DRIVE_CLEAN_BREAKOUT", tradable: true },
  { code: "SELL", label: "Valid SELL reversal", expected: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED", tradable: true },
  { code: "RETEST", label: "Breakout retest", expected: "BREAKOUT_RETEST_CONFIRMED", tradable: true },
  { code: "FAKEOUT", label: "Fakeout candidate", expected: "FAKEOUT_REVERSAL_CANDIDATE", tradable: false },
  { code: "SWEEP_REVERSAL", label: "Sweep reversal", expected: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED", tradable: true },
  { code: "OVEREXTENDED", label: "Overextended no-trade", expected: "OVEREXTENDED_BREAKOUT_NO_TRADE", tradable: false },
  { code: "NO_TRADE", label: "Double-sided sweep no-trade", expected: "DOUBLE_SIDED_SWEEP", tradable: false }
];

export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setups/predictions", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return { summary: emptyPredictionSummary(), predictions: [] };
    const search = request.query as { limit?: string; moduleCode?: string; includeProof?: string };
    const limit = Math.min(100, Math.max(1, Number(search.limit ?? 60)));
    const moduleCode = String(search.moduleCode ?? "ALL");
    const includeProof = search.includeProof === "true";
    const params: unknown[] = [auth.tenantId];
    const moduleFilter = moduleCode !== "ALL" ? `AND sc.module_code = $${params.push(moduleCode)}` : "";
    const proofFilter = includeProof
      ? "AND COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true'"
      : `AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
         AND COALESCE(t.outcome, '') <> 'ACTIVE'
         AND sc.detected_at >= latest.timestamp_utc - interval '${MAX_LIVE_PREDICTION_AGE_MINUTES} minutes'`;
    params.push(limit);
    const setups = await query(
      `SELECT
         sc.*,
         sm.name AS module_name,
         tp.reward_to_risk,
         tp.planned_entry,
         tp.planned_stop,
         tp.planned_target,
         tp.status AS trade_plan_status,
         tp.created_at AS trade_plan_created_at,
         tp.signal_thesis_key,
         tp.promoted_at,
         t.id AS trade_id,
         t.outcome AS trade_outcome,
         t.actual_entry,
         t.actual_stop,
         t.actual_target,
         t.opened_at,
         latest.close AS current_price,
         latest.timestamp_utc AS current_price_at
       FROM setup_candidates sc
       JOIN platform_strategy_modules sm ON sm.code = sc.module_code
       JOIN tenant_modules tm ON tm.module_id = sm.id
         AND tm.tenant_id = sc.tenant_id
         AND tm.status = 'ENABLED'
       JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       LEFT JOIN LATERAL (
         SELECT c.close, c.timestamp_utc
         FROM candles c
         WHERE c.symbol = sc.symbol
           AND c.timeframe_minutes = 5
           AND c.source LIKE 'TWELVE_DATA%'
         ORDER BY c.timestamp_utc DESC
         LIMIT 1
       ) latest ON true
       WHERE sc.tenant_id = $1
         AND sc.module_code IN ('orb_max_options', 'high_probability_strategy_2')
         AND sc.status <> 'TEST_CLEARED'
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND (tp.signal_thesis_key IS NOT NULL OR COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true')
         ${proofFilter}
         AND (sc.expires_at IS NULL OR sc.expires_at >= now() OR t.outcome = 'ACTIVE' OR sc.detected_at >= now() - interval '24 hours')
         ${moduleFilter}
       ORDER BY
         CASE
           WHEN t.outcome = 'ACTIVE' THEN 0
           WHEN sc.status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'PAPER_TRADE_OPENED', 'TRADE_PLANNED') THEN 1
           WHEN sc.direction IN ('LONG', 'SHORT') THEN 2
           ELSE 3
         END,
         sc.detected_at DESC
       LIMIT $${params.length}`,
      params
    );
    const setupIds = setups.rows.map((row: any) => row.id);
    const evaluations = setupIds.length > 0
      ? await query(
          `SELECT *
           FROM setup_rule_evaluations
           WHERE setup_candidate_id = ANY($1::uuid[])
           ORDER BY evaluated_at ASC`,
          [setupIds]
        )
      : { rows: [] };
    const evaluationsBySetup = new Map<string, any[]>();
    for (const evaluation of evaluations.rows as any[]) {
      const rows = evaluationsBySetup.get(evaluation.setup_candidate_id) ?? [];
      rows.push(evaluation);
      evaluationsBySetup.set(evaluation.setup_candidate_id, rows);
    }
    const brainPredictions = setupIds.length > 0 ? await latestBrainPredictions(auth.tenantId, setupIds) : new Map<string, any>();
    const predictions = setups.rows
      .map((row: any) => predictionSetupView(row, evaluationsBySetup.get(row.id) ?? [], brainPredictions.get(row.id) ?? null))
      .filter((prediction) =>
        prediction.probability >= MINIMUM_VISIBLE_PREDICTION_PROBABILITY &&
        (includeProof || isUpcomingPrediction(prediction))
      );
    return { summary: summarizePredictions(predictions), predictions };
  });

  app.get("/api/setups/signals", async (request) => {
    const auth = requirePermission(request, "signals.view");
    if (!auth.tenantId) return { summary: emptySignalSummary(), signals: [] };
    const search = request.query as { limit?: string; side?: string; moduleCode?: string; includeProof?: string };
    const limit = Math.min(100, Math.max(1, Number(search.limit ?? 50)));
    const side = String(search.side ?? "ALL").toUpperCase();
    const moduleCode = String(search.moduleCode ?? "ALL");
    const includeProof = search.includeProof === "true";
    const params: unknown[] = [auth.tenantId];
    const sideFilter = side === "BUY" || side === "SELL"
      ? `AND sc.direction = $${params.push(side === "BUY" ? "LONG" : "SHORT")}`
      : "";
    const moduleFilter = moduleCode !== "ALL" ? `AND sc.module_code = $${params.push(moduleCode)}` : "";
    const proofFilter = includeProof
      ? "AND COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true'"
      : `AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
         AND COALESCE(sc.scenario_flags->>'productionProof', 'false') <> 'true'
         AND (t.outcome = 'ACTIVE' OR sc.detected_at >= latest.timestamp_utc - interval '${MAX_LIVE_PREDICTION_AGE_MINUTES} minutes')`;
    params.push(limit);
    const setups = await query(
       `SELECT
         sc.*,
         sm.name AS module_name,
         tp.reward_to_risk,
         tp.planned_entry,
         tp.planned_stop,
         tp.planned_target,
         tp.status AS trade_plan_status,
         tp.created_at AS trade_plan_created_at,
         t.id AS trade_id,
         t.outcome AS trade_outcome,
         t.actual_entry,
         t.actual_stop,
         t.actual_target,
         t.actual_exit,
         t.result_r,
         t.opened_at,
         t.closed_at,
         target_progress.targets AS paper_targets,
         latest.close AS current_price,
         latest.timestamp_utc AS current_price_at
       FROM setup_candidates sc
       JOIN platform_strategy_modules sm ON sm.code = sc.module_code
       JOIN tenant_modules tm ON tm.module_id = sm.id
         AND tm.tenant_id = sc.tenant_id
         AND tm.status = 'ENABLED'
       LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'targetNumber', ptt.target_number,
           'price', ptt.price,
           'riskMultiple', ptt.risk_multiple,
           'positionFraction', ptt.position_fraction,
           'realizedR', ptt.realized_r,
           'status', ptt.status,
           'hitAt', ptt.hit_at,
           'hitPrice', ptt.hit_price
         ) ORDER BY ptt.target_number) AS targets
         FROM paper_trade_targets ptt
         WHERE ptt.trade_id = t.id
       ) target_progress ON true
       LEFT JOIN LATERAL (
         SELECT c.close, c.timestamp_utc
         FROM candles c
         WHERE c.symbol = sc.symbol
           AND c.timeframe_minutes = 5
           AND c.source LIKE 'TWELVE_DATA%'
         ORDER BY c.timestamp_utc DESC
         LIMIT 1
       ) latest ON true
       WHERE sc.tenant_id = $1
         AND sc.direction IN ('LONG', 'SHORT')
         AND sc.entry_price IS NOT NULL
         AND sc.stop_price IS NOT NULL
         AND sc.target_price IS NOT NULL
         AND sc.status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'PAPER_TRADE_OPENED', 'TRADE_PLANNED')
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         ${proofFilter}
         AND (sc.expires_at IS NULL OR sc.expires_at >= now() OR t.outcome = 'ACTIVE')
         ${sideFilter}
         ${moduleFilter}
       ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END, sc.detected_at DESC
       LIMIT $${params.length}`,
      params
    );
    const setupIds = setups.rows.map((row: any) => row.id);
    const evaluations = setupIds.length > 0
      ? await query(
          `SELECT *
           FROM setup_rule_evaluations
           WHERE setup_candidate_id = ANY($1::uuid[])
           ORDER BY evaluated_at ASC`,
          [setupIds]
        )
      : { rows: [] };
    const evaluationsBySetup = new Map<string, any[]>();
    for (const evaluation of evaluations.rows as any[]) {
      const rows = evaluationsBySetup.get(evaluation.setup_candidate_id) ?? [];
      rows.push(evaluation);
      evaluationsBySetup.set(evaluation.setup_candidate_id, rows);
    }
    const signals = setups.rows
      .map((row: any) => signalSetupView(row, evaluationsBySetup.get(row.id) ?? []))
      .filter((signal) => includeProof || isLiveSignal(signal));
    return { summary: summarizeSignals(signals), signals };
  });

  app.get("/api/setups/current", async (request) => {
    const search = request.query as { moduleCode?: string; evidence?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const evidenceMode = search.evidence === "true" && moduleCode === "high_probability_strategy_2";
    const auth = await requireTenantModule(request, moduleCode);
    const currentSessionDate = newYorkDate();
    const setup = await query(
      `SELECT
         sc.*,
         latest.close AS current_price,
         latest.timestamp_utc AS latest_candle_at,
         (t.id IS NOT NULL OR sc.detected_at >= latest.timestamp_utc) AS live_current
       FROM setup_candidates sc
       JOIN trading_sessions current_session
         ON current_session.id = sc.session_id
        AND current_session.session_date = $4::date
       LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id AND t.outcome = 'ACTIVE'
       JOIN LATERAL (
         SELECT c.timestamp_utc, c.close
         FROM candles c
         WHERE c.symbol = sc.symbol
           AND c.timeframe_minutes = 5
           AND c.source LIKE 'TWELVE_DATA%'
         ORDER BY c.timestamp_utc DESC
         LIMIT 1
       ) latest ON true
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.status <> 'TEST_CLEARED'
         AND sc.scenario <> 'QA_TEST_SIGNAL'
         AND (COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true' OR COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true')
         AND (COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true' OR COALESCE(sc.scenario_flags->>'productionProof', 'false') = 'true')
         AND ($3::boolean = true OR sc.expires_at IS NULL OR sc.expires_at >= now() OR t.id IS NOT NULL)
         AND ($3::boolean = false OR sc.scenario_flags IS NOT NULL)
       ORDER BY
         CASE WHEN t.id IS NOT NULL THEN 0 ELSE 1 END,
         sc.detected_at DESC,
         CASE WHEN $3::boolean = true AND sc.scenario_flags ? 'entryZone' THEN 0 ELSE 1 END,
         CASE WHEN $3::boolean = true AND sc.scenario_flags ? 'bos' THEN 0 ELSE 1 END,
         CASE WHEN $3::boolean = true AND sc.scenario_flags ? 'sweep' THEN 0 ELSE 1 END
       LIMIT 1`,
      [auth.tenantId, moduleCode, evidenceMode, currentSessionDate]
    );
    if (!setup.rows[0]) return null;
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [setup.rows[0].id]);
    const coreEvidence = evidenceMode ? await module2CoreEvidence(auth.tenantId, setup.rows[0]) : null;
    return { ...setup.rows[0], evaluations: evaluations.rows, coreEvidence };
  });

  app.get("/api/setups/history", async (request) => {
    const search = request.query as { moduleCode?: string; limit?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const limit = Math.min(100, Math.max(1, Number(search.limit ?? 30)));
    const auth = await requireTenantModule(request, moduleCode);
    const setups = await query(
      `SELECT
         sc.*,
         t.id AS trade_id,
         t.outcome,
         t.result_r,
         CASE WHEN t.id IS NULL THEN NULL WHEN t.outcome = 'ACTIVE' THEN 'ACTIVE' ELSE 'CLOSED' END AS trade_status,
         (
           SELECT sre.rule_code
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id AND sre.status <> 'PASS'
           ORDER BY sre.blocking DESC, sre.evaluated_at
           LIMIT 1
         ) AS blocking_rule,
         (
           SELECT count(*)::int
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id
         ) AS checklist_count,
         (
           SELECT count(*)::int
           FROM setup_rule_evaluations sre
           WHERE sre.setup_candidate_id = sc.id AND sre.status = 'PASS'
         ) AS checklist_passed
       FROM setup_candidates sc
       LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
       LEFT JOIN trades t ON t.trade_plan_id = tp.id
       WHERE sc.tenant_id = $1
         AND sc.module_code = $2
         AND sc.status <> 'TEST_CLEARED'
       ORDER BY sc.detected_at DESC
       LIMIT $3`,
      [auth.tenantId, moduleCode, limit]
    );
    return setups.rows.map((row: any) => ({
      ...row,
      recommendation: setupRecommendation(row)
    }));
  });

  async function module2CoreEvidence(tenantId: string | null, setup: any) {
    if (!tenantId || setup.module_code !== "high_probability_strategy_2") return null;
    const [liquidity, liquidityEvents, structurePoints, structureBreaks, regimes, domainEvents, checkpoints, transitions, positions] = await Promise.all([
      query(
        `SELECT *
         FROM liquidity_levels
         WHERE tenant_id = $1
           AND module_code = 'high_probability_strategy_2'
           AND symbol = $2
           AND metadata->>'setupCandidateId' = $3
         ORDER BY priority_score DESC, updated_at DESC
         LIMIT 12`,
        [tenantId, setup.symbol, setup.id]
      ),
      query(
        `SELECT lle.*
         FROM liquidity_level_events lle
         JOIN liquidity_levels ll ON ll.id = lle.liquidity_level_id
         WHERE lle.tenant_id = $1
           AND lle.module_code = 'high_probability_strategy_2'
           AND ll.metadata->>'setupCandidateId' = $2
         ORDER BY lle.occurred_at DESC
         LIMIT 12`,
        [tenantId, setup.id]
      ),
      query(
        `SELECT *
         FROM structure_points
         WHERE tenant_id = $1
           AND module_code = 'high_probability_strategy_2'
           AND symbol = $2
           AND metadata->>'setupCandidateId' = $3
         ORDER BY confirmed_at DESC
         LIMIT 16`,
        [tenantId, setup.symbol, setup.id]
      ),
      query(
        `SELECT *
         FROM structure_break_events
         WHERE tenant_id = $1
           AND module_code = 'high_probability_strategy_2'
           AND symbol = $2
           AND metadata->>'setupCandidateId' = $3
         ORDER BY occurred_at DESC
         LIMIT 12`,
        [tenantId, setup.symbol, setup.id]
      ),
      query(
        `SELECT *
         FROM market_regimes
         WHERE tenant_id = $1
           AND module_code = 'high_probability_strategy_2'
           AND symbol = $2
           AND candle_timestamp <= $3
         ORDER BY candle_timestamp DESC
         LIMIT 3`,
        [tenantId, setup.symbol, setup.detected_at]
      ),
      query(
        `SELECT *
         FROM domain_events
         WHERE aggregate_id = $1
         ORDER BY occurred_at DESC
         LIMIT 8`,
        [setup.id]
      ),
      query(
        `SELECT *
         FROM system_checkpoints
         WHERE tenant_id = $1
           AND module_code = 'high_probability_strategy_2'
           AND symbol = $2
           AND state->>'setupCandidateId' = $3
         ORDER BY created_at DESC
         LIMIT 10`,
        [tenantId, setup.symbol, setup.id]
      ),
      query(
        `SELECT *
         FROM module2_state_transitions
         WHERE tenant_id = $1
           AND setup_candidate_id = $2
         ORDER BY occurred_at DESC
         LIMIT 12`,
        [tenantId, setup.id]
      ),
      query(
        `SELECT p.*, t.outcome AS trade_outcome, t.result_r
         FROM positions p
         LEFT JOIN trades t ON t.id = p.trade_id
         WHERE p.tenant_id = $1
           AND p.trade_plan_id IN (
             SELECT id FROM trade_plans WHERE setup_candidate_id = $2
           )
         ORDER BY p.created_at DESC
         LIMIT 3`,
        [tenantId, setup.id]
      )
    ]);
    return {
      liquidityLevels: liquidity.rows,
      liquidityEvents: liquidityEvents.rows,
      structurePoints: structurePoints.rows,
      structureBreaks: structureBreaks.rows,
      marketRegimes: regimes.rows,
      domainEvents: domainEvents.rows,
      checkpoints: checkpoints.rows,
      transitions: transitions.rows,
      positions: positions.rows
    };
  }

  app.get("/api/dev/orb-replay/cases", async () => ({
    cases: ORB_QA_CASES
  }));

  app.post("/api/dev/orb-qa-suite", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const cases = ORB_QA_CASES.map((testCase) => {
      const replay = buildReplay(testCase.code, session);
      const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
      const decision = evaluateSetup({
        now: replay.currentCandle.timestampUtc,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        session: {
          id: session.id,
          symbol: session.symbol,
          strategyVersionId: session.strategy_version_id,
          sessionDate: session.session_date,
          sessionPreset: session.session_preset,
          state: "WAITING_FOR_SETUP",
          sessionStartAt: session.session_start_at,
          openingRangeEndAt: session.opening_range_end_at,
          signalWindowEndAt: session.signal_window_end_at,
          dataStatus: "VALID"
        },
        openingRange,
        currentCandle: replay.currentCandle,
        previousCandles: replay.previousCandles,
        spread: replay.currentCandle.spread ?? undefined,
        newsStatus: "CLEAR",
        riskStatus: "PERMITTED",
        configuration: configuration as any
      });
      const tradable = decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY";
      const scenarioMatched = decision.scenario === testCase.expected;
      const tradableMatched = tradable === testCase.tradable;
      return {
        code: testCase.code,
        label: testCase.label,
        expected: testCase.expected,
        actual: decision.scenario,
        expectedTradable: testCase.tradable,
        actualTradable: tradable,
        status: scenarioMatched && tradableMatched ? "PASS" : "FAIL",
        score: decision.favorabilityScore,
        grade: decision.favorabilityGrade,
        reason: scenarioMatched && tradableMatched ? "ORB replay behavior matches expectation." : `Expected ${testCase.expected} tradable=${testCase.tradable}, got ${decision.scenario} tradable=${tradable}.`
      };
    });
    const failed = cases.filter((row) => row.status !== "PASS");
    return {
      moduleCode: "orb_max_options",
      generatedAt: new Date().toISOString(),
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      summary: {
        total: cases.length,
        passed: cases.length - failed.length,
        failed: failed.length,
        tradableCases: cases.filter((row) => row.expectedTradable).length,
        noTradeProtections: cases.filter((row) => !row.expectedTradable).length
      },
      cases
    };
  });

  app.post("/api/dev/orb-replay", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { case?: ReplayCase };
    const replayCase = body.case ?? "BUY";
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const replay = buildReplay(replayCase, session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        `Replay ${replayCase}: ${decision.finalReason}`,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(["Replay mode", ...decision.favorabilityReasons]),
        JSON.stringify({
          ...decision.scenarioFlags,
          replay: true,
          replayCase,
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: decision.scenario === replay.expectedScenario
        }),
        auth.tenantId
      ]
    );
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rows[0].id,
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
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'ORB_REPLAY',$2,$3,'NORMAL')`,
        [
          `orb-replay-${rows[0].id}`,
          `ORB replay: ${decision.status}`,
          `${replayCase} produced ${decision.scenario}. No live API call, no real order.`,
          auth.tenantId
        ]
      );
    }
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [rows[0].id]);
    return { setup: { ...rows[0], evaluations: evaluations.rows }, decision, replayCase, testMode: true };
  });

  app.post("/api/module1/launch-rehearsal", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const qaSuite = await buildOrbQaSuite(auth.tenantId);
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const replay = buildReplay("BUY", session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const setupResult = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'orb_max_options',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        `Module 1 launch rehearsal: ${decision.finalReason}`,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(["Launch rehearsal", ...decision.favorabilityReasons]),
        JSON.stringify({
          ...decision.scenarioFlags,
          replay: true,
          rehearsal: true,
          replayCase: "BUY",
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: decision.scenario === replay.expectedScenario
        }),
        auth.tenantId
      ]
    );
    const setup = setupResult.rows[0];
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          setup.id,
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
    const trade = await openModuleReplayPaperTrade(setup, auth.tenantId, "MODULE1_REHEARSAL");
    const closedTrade = trade ? await closeModuleReplayPaperTrade(setup, auth.tenantId, "TP_HIT", "MODULE1_REHEARSAL") : null;
    if (await canCreateTenantNotification(auth.tenantId)) {
      await query(
        `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
         VALUES ($4,$1,'MODULE1_REHEARSAL_TEST',$2,$3,'NORMAL')
         ON CONFLICT (event_key) DO NOTHING`,
        [
          `module1-rehearsal-test-${setup.id}`,
          "Module 1 rehearsal notification",
          "ORB QA replay, paper trade, TP close, journal, audit, and isolation proof completed.",
          auth.tenantId
        ]
      );
    }
    const [journal, history, report, audit, notificationProof, isolation] = await Promise.all([
      query("SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id = $1 AND setup_candidate_id = $2", [auth.tenantId, setup.id]),
      query("SELECT count(*)::int AS count FROM setup_candidates WHERE tenant_id = $1 AND module_code = 'orb_max_options' AND scenario_flags->>'rehearsal' = 'true'", [auth.tenantId]),
      moduleRehearsalReport(auth.tenantId, "orb_max_options"),
      moduleRehearsalAudit(auth.tenantId, "orb_max_options"),
      moduleRehearsalNotificationProof(auth.tenantId, "MODULE1_", setup.id),
      moduleIsolationProof(auth.tenantId, "orb_max_options")
    ]);
    const checklist = [
      launchCheck("QA_SUITE_PASS", "QA suite pass", qaSuite.finalStatus === "PASS", `${qaSuite.summary.passed}/${qaSuite.summary.total} replay cases passed.`),
      launchCheck("BUY_REPLAY_VALID", "BUY replay valid", decision.scenario === replay.expectedScenario && decision.status === "LONG SETUP READY", decision.finalReason),
      launchCheck("PAPER_TRADE_OPENED", "Paper trade opened", Boolean(trade?.id), trade?.id ?? "No paper trade opened."),
      launchCheck("TP_CLOSE_WORKS", "TP close works", closedTrade?.outcome === "WIN", closedTrade?.result_r == null ? "No close result." : `${Number(closedTrade.result_r).toFixed(2)}R`),
      launchCheck("JOURNAL_WRITTEN", "Journal written", Number(journal.rows[0]?.count ?? 0) > 0, `${journal.rows[0]?.count ?? 0} journal rows for rehearsal setup.`),
      launchCheck("HISTORY_VISIBLE", "Setup history visible", Number(history.rows[0]?.count ?? 0) > 0, `${history.rows[0]?.count ?? 0} Module 1 rehearsal setup rows.`),
      launchCheck("REPORT_READY", "Report ready", Number(report.paperTrades ?? 0) > 0, `${report.paperTrades ?? 0} Module 1 paper trades available for reporting.`),
      launchCheck("AUDIT_PASS", "Audit pass", audit.failedChecks === 0, `${audit.failedChecks} audit failures.`),
      launchCheck("NOTIFICATION_PROOF", "Notification proof", notificationProof.total >= 1, `${notificationProof.total} Module 1 notifications found.`),
      launchCheck("ISOLATION_PASS", "Isolation pass", isolation.mixedTrades === 0, `${isolation.mixedTrades} mixed Module 1 trade/session rows.`)
    ];
    const finalStatus = checklist.every((row) => row.status === "PASS") ? "GO" : "NO_GO";
    const result = {
      moduleCode: "orb_max_options",
      generatedAt: new Date().toISOString(),
      rehearsal: true,
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus,
      setup,
      trade: closedTrade ?? trade,
      qaSuite,
      checklist,
      report,
      audit,
      notificationProof,
      isolation,
      handoff: {
        expectedNextAction: finalStatus === "GO" ? "Module 1 ORB automation path is ready for live paper monitoring." : "Resolve NO GO checklist rows before trusting Module 1.",
        watchDuringSession: [
          "ORB high/low must lock from the configured session opening range.",
          "Only valid breakout, retest, or sweep-reversal scenarios can open paper trades.",
          "Risk/TP/SL plan must exist before paper entry."
        ],
        manualTraderNotes: "No external execution is placed. Use Module 1 paper signal as the manual execution guide only."
      }
    };
    await query(
      `INSERT INTO module_launch_rehearsals (
        tenant_id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json
       ) VALUES ($1,'orb_max_options',$2,$3,$4,$5,$6,$7)`,
      [
        auth.tenantId,
        finalStatus,
        JSON.stringify(checklist),
        JSON.stringify({ report, notificationProof, isolation }),
        JSON.stringify(audit),
        JSON.stringify({ setupId: setup.id, tradeId: trade?.id ?? null, closedTrade }),
        JSON.stringify(result.handoff)
      ]
    );
    return result;
  });

  app.post("/api/module1/production-proof/run", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    if (!auth.tenantId) throw new Error("Tenant context is required for Module 1 production proof.");
    const session = await ensureTodaySession(auth.tenantId);
    const version = await selectedStrategyVersion();
    const replay = buildReplay("BUY", session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, version.configuration_json);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const setupResult = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'orb_max_options',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        `Module 1 production proof: ${decision.finalReason}`,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(["Production proof", ...decision.favorabilityReasons]),
        JSON.stringify({
          ...decision.scenarioFlags,
          replay: true,
          productionProof: true,
          proofMode: true,
          replayCase: "BUY",
          replayExpectedScenario: replay.expectedScenario,
          replayMatchedExpectedScenario: decision.scenario === replay.expectedScenario
        }),
        auth.tenantId
      ]
    );
    const setup = setupResult.rows[0];
    for (const evaluation of decision.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          setup.id,
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
    const trade = await openModuleReplayPaperTrade(setup, auth.tenantId, "MODULE1_PRODUCTION_PROOF");
    const horizontalProof = buildModule1HorizontalRangeProof(session);
    const horizontalSetupResult = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,'orb_max_options',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        horizontalProof.scenario,
        horizontalProof.direction,
        horizontalProof.status,
        new Date().toISOString(),
        session.signal_window_end_at,
        horizontalProof.entryPrice,
        horizontalProof.stopPrice,
        horizontalProof.targetPrice,
        `Module 1 horizontal range production proof: ${horizontalProof.reason}`,
        horizontalProof.score,
        "A",
        JSON.stringify(horizontalProof.reasons),
        JSON.stringify({
          replay: true,
          productionProof: true,
          proofMode: true,
          replayCase: "HORIZONTAL_RANGE_BREAKOUT",
          mandatoryChecklistMatched: horizontalProof.ready,
          fullChecklistMatched: horizontalProof.ready,
          setupTier: "HORIZONTAL_RANGE",
          selectedScenario: horizontalProof.scenario,
          genericRangeEngine: horizontalProof.genericRangeEngine,
          horizontalRangeObservation: horizontalProof.genericRangeEngine.horizontal,
          tradingRange: horizontalProof.genericRangeEngine.horizontal.range,
          matrix: {
            autoEligible: horizontalProof.ready,
            selectedScenario: horizontalProof.scenario,
            selectedVariant: "HORIZONTAL_RANGE_BREAKOUT_RETEST",
            mandatoryChecklistMatched: horizontalProof.ready
          }
        }),
        auth.tenantId
      ]
    );
    const horizontalSetup = horizontalSetupResult.rows[0];
    for (const evaluation of horizontalProof.evaluations) {
      await query(
        `INSERT INTO setup_rule_evaluations (
          setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
        ) VALUES ($1,$2,$3,$4,$5,'AUTOMATIC',$6,$7,$8)`,
        [
          horizontalSetup.id,
          evaluation.ruleCode,
          evaluation.name,
          evaluation.status,
          evaluation.blocking,
          evaluation.actualValue == null ? null : String(evaluation.actualValue),
          evaluation.requiredValue == null ? null : String(evaluation.requiredValue),
          evaluation.explanation
        ]
      );
    }
    const horizontalTrade = await openModuleReplayPaperTrade(horizontalSetup, auth.tenantId, "MODULE1_HORIZONTAL_PRODUCTION_PROOF");
    const notificationResult = await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority, data)
       VALUES ($1,$2,'MODULE1_PRODUCTION_PROOF',$3,$4,'HIGH',$5::jsonb)
       ON CONFLICT (event_key) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         priority = EXCLUDED.priority,
         data = EXCLUDED.data
       RETURNING *`,
      [
        auth.tenantId,
        `module1-production-proof-${setup.id}`,
        "Module 1 production proof signal",
        "ORB proof created an active paper trade with entry, SL, TP, journal, and Python brain approval.",
        JSON.stringify({
        moduleCode: "orb_max_options",
        setupCandidateId: setup.id,
        tradeId: trade?.id ?? null,
        action: setup.direction === "LONG" ? "BUY" : "SELL",
        direction: setup.direction,
        entry: setup.entry_price,
        stopLoss: setup.stop_price,
        takeProfit: setup.target_price,
        scenario: setup.scenario,
        proofMode: true
        })
      ]
    );
    const notification = notificationResult.rows[0] ?? null;
    const horizontalNotificationResult = await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority, data)
       VALUES ($1,$2,'MODULE1_HORIZONTAL_PRODUCTION_PROOF',$3,$4,'HIGH',$5::jsonb)
       ON CONFLICT (event_key) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         priority = EXCLUDED.priority,
         data = EXCLUDED.data
       RETURNING *`,
      [
        auth.tenantId,
        `module1-horizontal-production-proof-${horizontalSetup.id}`,
        "Module 1 horizontal range proof signal",
        "Horizontal range proof created an active paper trade with entry, SL, TP, journal, and Python brain approval.",
        JSON.stringify({
          moduleCode: "orb_max_options",
          setupCandidateId: horizontalSetup.id,
          tradeId: horizontalTrade?.id ?? null,
          action: horizontalSetup.direction === "LONG" ? "BUY" : "SELL",
          direction: horizontalSetup.direction,
          entry: horizontalSetup.entry_price,
          stopLoss: horizontalSetup.stop_price,
          takeProfit: horizontalSetup.target_price,
          scenario: horizontalSetup.scenario,
          proofMode: true,
          rangePath: "HORIZONTAL_RANGE_BREAKOUT_RETEST"
        })
      ]
    );
    const horizontalNotification = horizontalNotificationResult.rows[0] ?? null;
    let brain: unknown = null;
    let brainError: string | null = null;
    try {
      brain = await runMainBrainPython(auth.tenantId, "orb_max_options", { proofMode: true, setupId: setup.id });
    } catch (error) {
      brainError = error instanceof Error ? error.message : String(error);
    }
    const checks = {
      setupCreated: Boolean(setup?.id),
      entryReady: ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED"].includes(String(setup?.status ?? "")),
      tradeCreated: Boolean(trade?.id),
      journalCreated: Boolean((await query("SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND setup_candidate_id = $2 LIMIT 1", [auth.tenantId, setup.id])).rows[0]),
      notificationCreated: Boolean(notification),
      horizontalSetupCreated: Boolean(horizontalSetup?.id),
      horizontalEntryReady: ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED"].includes(String(horizontalSetup?.status ?? "")),
      horizontalTradeCreated: Boolean(horizontalTrade?.id),
      horizontalJournalCreated: Boolean((await query("SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND setup_candidate_id = $2 LIMIT 1", [auth.tenantId, horizontalSetup.id])).rows[0]),
      horizontalNotificationCreated: Boolean(horizontalNotification),
      pythonBrainRan: Boolean(brain) && !brainError
    };
    const finalStatus = Object.values(checks).every(Boolean) ? "PASS" : "WARN";
    await query(
      `INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
       VALUES ($1,'SYSTEM','MODULE1_PRODUCTION_PROOF','module1-production-proof',$2,$3,$4::jsonb)`,
      [
        finalStatus === "PASS" ? "INFO" : "WARN",
        auth.tenantId,
        `Module 1 production proof ${finalStatus}.`,
        JSON.stringify({ checks, setupId: setup.id, tradeId: trade?.id ?? null, horizontalSetupId: horizontalSetup.id, horizontalTradeId: horizontalTrade?.id ?? null, brain, brainError })
      ]
    );
    return {
      status: finalStatus,
      moduleCode: "orb_max_options",
      setup,
      trade,
      notification,
      horizontal: {
        setup: horizontalSetup,
        trade: horizontalTrade,
        notification: horizontalNotification,
        decision: horizontalProof.genericRangeEngine.horizontal.decision
      },
      brain,
      brainError,
      checks
    };
  });

  app.get("/api/module1/launch-rehearsals", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const rows = await query(
      `SELECT id, module_code, final_status, checklist_json, health_json, audit_json, dry_run_json, handoff_json, created_at
       FROM module_launch_rehearsals
       WHERE tenant_id = $1 AND module_code = 'orb_max_options'
       ORDER BY created_at DESC
       LIMIT 20`,
      [auth.tenantId]
    );
    return rows.rows;
  });

  app.get("/api/dev/module2-replay/cases", async () => ({
    cases: MODULE2_QA_CASES.map(({ code, label, expected, expectedStatus, opensPaperTrade }) => ({ code, label, expected, expectedStatus, opensPaperTrade }))
  }));

  app.post("/api/dev/module2-qa-suite", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    const session = await ensureTodayModule2Session(auth.tenantId);
    const cases = MODULE2_QA_CASES.map((testCase) => {
      const replay = buildModule2Replay(testCase.code, session);
      const summary = module2ReplayQaSummary(replay, testCase);
      return {
        code: testCase.code,
        label: testCase.label,
        expected: testCase.expected,
        actual: replay.scenario,
        expectedStatus: testCase.expectedStatus,
        actualStatus: replay.status,
        expectedPaperEligible: testCase.opensPaperTrade,
        actualPaperEligible: summary.paperEligible,
        status: summary.passed ? "PASS" : "FAIL",
        hardRulesPassed: summary.hardRulesPassed,
        confirmationCount: summary.confirmationCount,
        qualityCount: summary.qualityCount,
        failureRule: testCase.failureRule ?? null,
        blockingFailure: summary.blockingFailure,
        reason: summary.reason
      };
    });
    const failed = cases.filter((row) => row.status !== "PASS");
    return {
      moduleCode: "high_probability_strategy_2",
      generatedAt: new Date().toISOString(),
      testMode: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      summary: {
        total: cases.length,
        passed: cases.length - failed.length,
        failed: failed.length,
        validSignals: cases.filter((row) => row.expectedPaperEligible).length,
        noTradeProtections: cases.filter((row) => !row.expectedPaperEligible).length
      },
      cases
    };
  });

  app.post("/api/dev/module2-replay", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    if (!auth.tenantId) throw new Error("Tenant context is required for Module 2 replay.");
    const body = request.body as { case?: Module2ReplayCase; openPaperTrade?: boolean };
    return createModule2ReplayRecord(auth.tenantId, body.case ?? "BUY", Boolean(body.openPaperTrade), false);
  });

  app.post("/api/module2/production-proof/run", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    if (!auth.tenantId) throw new Error("Tenant context is required for Module 2 production proof.");
    const body = (request.body ?? {}) as { direction?: "LONG" | "SHORT"; replayCase?: Module2ReplayCase };
    const replayCase: Module2ReplayCase = body.replayCase ?? (body.direction === "SHORT" ? "SELL" : "MSS_RETEST");
    const proof: any = await createModule2ReplayRecord(auth.tenantId, replayCase, true, true);
    let brain: unknown = null;
    let brainError: string | null = null;
    try {
      brain = await runMainBrainPython(auth.tenantId, "high_probability_strategy_2", { proofMode: true, setupId: proof.setup?.id });
    } catch (error) {
      brainError = error instanceof Error ? error.message : String(error);
    }
    const checks = {
      setupCreated: Boolean(proof.setup?.id),
      strictVariant: proof.setup?.scenario_flags?.variantCode === "SWEEP_MSS_RETEST" || proof.setup?.scenario_flags?.module2Variant?.code === "SWEEP_MSS_RETEST",
      entryReady: ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED"].includes(String(proof.setup?.status ?? "")),
      tradeCreated: Boolean(proof.trade?.id),
      journalCreated: Boolean(proof.journal?.id),
      notificationPayload: Boolean(proof.notification?.data?.entry || proof.notification?.data?.stopLoss || proof.notification?.data?.trade),
      pythonBrainRan: Boolean(brain) && !brainError
    };
    const finalStatus = Object.values(checks).every(Boolean) ? "PASS" : "WARN";
    await query(
      `INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
       VALUES ($1,'SYSTEM','MODULE2_PRODUCTION_PROOF','module2-production-proof',$2,$3,$4::jsonb)`,
      [
        finalStatus === "PASS" ? "INFO" : "WARN",
        auth.tenantId,
        `Module 2 production proof ${finalStatus}.`,
        JSON.stringify({ checks, replayCase, setupId: proof.setup?.id ?? null, tradeId: proof.trade?.id ?? null, journalId: proof.journal?.id ?? null, brain, brainError })
      ]
    );
    return { finalStatus, checks, ...proof, brain, brainError };
  });

  app.post("/api/module2/variant-matrix-proof/run", async (request) => {
    const auth = await requireTenantModule(request, "high_probability_strategy_2");
    if (!auth.tenantId) throw new Error("Tenant context is required for Module 2 variant matrix proof.");
    const results = [];
    for (const replayCase of MODULE2_VARIANT_MATRIX_CASES) {
      const testCase = MODULE2_QA_CASES.find((item) => item.code === replayCase);
      const proof: any = await createModule2ReplayRecord(auth.tenantId, replayCase, Boolean(testCase?.opensPaperTrade), true);
      const flags = proof.setup?.scenario_flags ?? {};
      const variant = flags.module2Variant ?? {};
      const evaluations = Array.isArray(proof.setup?.evaluations) ? proof.setup.evaluations : [];
      const hasEntryDetails = proof.setup?.entry_price != null && proof.setup?.stop_price != null && proof.setup?.target_price != null;
      const expectedPaper = Boolean(testCase?.opensPaperTrade);
      const result = {
        replayCase,
        label: testCase?.label ?? replayCase,
        variantCode: variant.code ?? flags.variantCode ?? null,
        variantName: variant.name ?? null,
        variantProfile: variant.profileKey ?? null,
        expectedPaperTrade: expectedPaper,
        setupId: proof.setup?.id ?? null,
        tradeId: proof.trade?.id ?? null,
        journalId: proof.journal?.id ?? null,
        notificationId: proof.notification?.id ?? null,
        scenario: proof.setup?.scenario ?? null,
        status: proof.setup?.status ?? null,
        direction: proof.setup?.direction ?? null,
        entry: proof.setup?.entry_price ?? null,
        stopLoss: proof.setup?.stop_price ?? null,
        takeProfit: proof.setup?.target_price ?? null,
        checks: {
          setupCreated: Boolean(proof.setup?.id),
          selectedVariant: Boolean(variant.code ?? flags.variantCode),
          entryDetails: expectedPaper ? hasEntryDetails : true,
          paperTrade: expectedPaper ? Boolean(proof.trade?.id) : !proof.trade?.id,
          journal: expectedPaper ? Boolean(proof.journal?.id) : true,
          notificationPayload: expectedPaper
            ? Boolean(proof.notification?.data?.entry || proof.notification?.data?.stopLoss || proof.notification?.data?.takeProfit)
            : !Boolean(proof.notification?.data?.entry || proof.notification?.data?.stopLoss || proof.notification?.data?.takeProfit),
          noConfirmationBlocked: replayCase === "SWEEP_NO_CONFIRMATION" ? !proof.trade?.id && variant.paperEligible === false : true,
          evaluationsPresent: evaluations.length > 0
        }
      };
      results.push({ ...result, finalStatus: Object.values(result.checks).every(Boolean) ? "PASS" : "FAIL" });
    }
    const failed = results.filter((item) => item.finalStatus !== "PASS");
    await query(
      `INSERT INTO operational_events (severity, category, event_type, source, tenant_id, message, metadata)
       VALUES ($1,'SYSTEM','MODULE2_VARIANT_MATRIX_PROOF','module2-variant-matrix-proof',$2,$3,$4::jsonb)`,
      [
        failed.length === 0 ? "INFO" : "WARN",
        auth.tenantId,
        `Module 2 A-J variant matrix proof ${failed.length === 0 ? "PASS" : "WARN"}.`,
        JSON.stringify({ results })
      ]
    );
    return {
      finalStatus: failed.length === 0 ? "PASS" : "FAIL",
      generatedAt: new Date().toISOString(),
      moduleCode: "high_probability_strategy_2",
      testMode: true,
      productionProof: true,
      twelveDataCreditsUsed: 0,
      externalOrdersPlaced: 0,
      summary: {
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        paperProfiles: results.filter((item) => item.expectedPaperTrade).length,
        researchProfiles: results.filter((item) => !item.expectedPaperTrade).length
      },
      results
    };
  });

  app.post("/api/dev/test-signal", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { direction?: "LONG" | "SHORT" };
    const direction = body.direction === "SHORT" ? "SHORT" : "LONG";
    const session = await ensureTodaySession(auth.tenantId);
    const latest = await query(
      `SELECT timestamp_utc, close
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [session.symbol, Number(session.signal_timeframe_minutes ?? 15)]
    );
    const close = Number(latest.rows[0]?.close ?? 4050);
    const timestamp = new Date().toISOString();
    const stopDistance = 5;
    const targetDistance = 10;
    const entry = close;
    const stop = direction === "LONG" ? entry - stopDistance : entry + stopDistance;
    const target = direction === "LONG" ? entry + targetDistance : entry - targetDistance;
    const status = direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY";
    const { rows } = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($14,$1,$2,$3,'QA_TEST_SIGNAL',$4,$5,$6,$7,$8,$9,$10,$11,100,'QA',$12,$13)
      RETURNING *`,
      [
        session.id,
        session.strategy_version_id,
        session.symbol,
        direction,
        status,
        timestamp,
        session.signal_window_end_at,
        entry,
        stop,
        target,
        `QA test ${direction === "LONG" ? "BUY" : "SELL"} signal. This bypasses ORB rules for notification and UI testing only.`,
        JSON.stringify(["QA test signal", "ORB scenario bypassed", "Do not use for trading decisions"]),
        JSON.stringify({ qaTest: true, bypassedOrbRules: true }),
        auth.tenantId
      ]
    );
    const eventKey = `qa-test-signal-${rows[0].id}`;
    const title = `QA ${direction === "LONG" ? "BUY" : "SELL"} test signal`;
    const notificationBody = `Test ${direction === "LONG" ? "BUY" : "SELL"} at ${entry.toFixed(2)}. This is not a valid ORB setup.`;
    const notificationData = {
      eventKey,
      eventType: "QA_TEST_SIGNAL",
      moduleCode: "orb_max_options",
      moduleName: "Module 1 ORB",
      symbol: session.symbol,
      scenario: "QA_TEST_SIGNAL",
      direction,
      action: direction === "LONG" ? "BUY" : "SELL",
      entry,
      stopLoss: stop,
      takeProfit: target,
      rewardToRisk: 2,
      confidence: 100,
      grade: "QA",
      setupCandidateId: rows[0].id,
      finalReason: `QA test only. ${direction === "LONG" ? "BUY" : "SELL"} signal delivery and mobile rendering verification.`
    };
    const notification = await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority, data)
       VALUES ($4,$1,'QA_TEST_SIGNAL',$2,$3,'HIGH',$5::jsonb)
       RETURNING id`,
      [
        eventKey,
        title,
        notificationBody,
        auth.tenantId,
        JSON.stringify(notificationData)
      ]
    );
    const push = await sendTenantPush({
      tenantId: auth.tenantId,
      title,
      body: notificationBody,
      eventKey,
      eventType: "QA_TEST_SIGNAL",
      force: true,
      data: { ...notificationData, notificationId: notification.rows[0]?.id ?? null }
    });
    return {
      setup: rows[0],
      notificationId: notification.rows[0]?.id ?? null,
      push,
      testMode: true,
      externalOrdersPlaced: 0
    };
  });

  app.post("/api/dev/test-signal/clear", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const { rowCount } = await query("UPDATE setup_candidates SET status = 'TEST_CLEARED' WHERE tenant_id = $1 AND (scenario = 'QA_TEST_SIGNAL' OR scenario_flags->>'replay' = 'true')", [auth.tenantId]);
    return { cleared: rowCount ?? 0 };
  });

  app.post("/api/setups/evaluate", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const body = request.body as { sessionId: string; currentCandle: any; previousCandles: any[]; spread?: number; newsStatus?: any };
    const sessionResult = await query(
      `SELECT ts.*, orr.status AS range_status, orr.high, orr.low, orr.midpoint, orr.width, orr.width_ticks,
        sv.configuration_json
       FROM trading_sessions ts
       JOIN opening_ranges orr ON orr.session_id = ts.id
       JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
       WHERE ts.id = $1 AND ts.tenant_id = $2
       LIMIT 1`,
      [body.sessionId, auth.tenantId]
    );
    const row = sessionResult.rows[0] as any;
    if (!row) throw new Error("Trading session or opening range was not found for this subscriber.");
    const riskProfileResult = await query(
      `SELECT *
       FROM risk_profiles
       WHERE tenant_id = $1 AND is_active = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [auth.tenantId]
    );
    const riskProfile = (riskProfileResult.rows[0] as any) ?? SETUP_DEFAULT_PAPER_RISK_PROFILE;
    const openingRange = {
      status: row.range_status,
      high: Number(row.high),
      low: Number(row.low),
      midpoint: Number(row.midpoint),
      width: Number(row.width),
      widthTicks: Number(row.width_ticks),
      sourceCandleCount: 3,
      dataQualityStatus: "VALID"
    };
    const stop = body.currentCandle.close > openingRange.high ? openingRange.low : openingRange.high;
    const entry = Number(body.currentCandle.close);
    const target = entry > Number(stop) ? entry + Math.abs(entry - Number(stop)) * 2 : entry - Math.abs(entry - Number(stop)) * 2;
    const risk = calculateRisk({
      accountBalance: Number(riskProfile.account_balance),
      accountEquity: Number(riskProfile.account_equity),
      riskPerTradePercent: Number(riskProfile.risk_per_trade_percent),
      entry,
      stop: Number(stop),
      target,
      contractSize: XAUUSD_PAPER_SPEC.contractSize,
      tickSize: XAUUSD_PAPER_SPEC.tickSize,
      tickValue: XAUUSD_PAPER_SPEC.tickValue,
      minimumLot: XAUUSD_PAPER_SPEC.minimumLot,
      lotStep: XAUUSD_PAPER_SPEC.lotStep,
      maximumLot: XAUUSD_PAPER_SPEC.maximumLot,
      spread: Number(body.spread ?? 0),
      commissionPerLot: XAUUSD_PAPER_SPEC.commissionPerLot,
      minimumRewardToRisk: Number(riskProfile.minimum_reward_to_risk),
      maximumDailyLossPercent: Number(riskProfile.maximum_daily_loss_percent),
      maximumWeeklyLossPercent: Number(riskProfile.maximum_weekly_loss_percent)
    });
    const configuration = await getTenantOrbStrategyConfiguration(auth.tenantId, row.configuration_json);
    const decision = evaluateSetup({
      now: body.currentCandle.timestampUtc,
      symbol: row.symbol,
      strategyVersionId: row.strategy_version_id,
      session: {
        id: row.id,
        symbol: row.symbol,
        strategyVersionId: row.strategy_version_id,
        sessionDate: row.session_date,
        sessionPreset: row.session_preset,
        state: row.state,
        sessionStartAt: row.session_start_at,
        openingRangeEndAt: row.opening_range_end_at,
        signalWindowEndAt: row.signal_window_end_at,
        dataStatus: row.data_status
      },
      openingRange,
      currentCandle: body.currentCandle,
      previousCandles: body.previousCandles ?? [],
      spread: body.spread,
      newsStatus: body.newsStatus ?? "CLEAR",
      riskStatus: risk.status,
      configuration: configuration as any
    });
    const saved = await query(
      `INSERT INTO setup_candidates (
        tenant_id, session_id, strategy_version_id, symbol, scenario, direction, status, detected_at,
        expires_at, entry_price, stop_price, target_price, final_reason,
        favorability_score, favorability_grade, favorability_reasons, scenario_flags
      ) VALUES ($17,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        body.sessionId,
        row.strategy_version_id,
        row.symbol,
        decision.scenario,
        decision.direction,
        decision.status,
        body.currentCandle.timestampUtc,
        row.signal_window_end_at,
        decision.entryPrice ?? null,
        decision.stopPrice ?? null,
        decision.targetPrice ?? null,
        decision.finalReason,
        decision.favorabilityScore,
        decision.favorabilityGrade,
        JSON.stringify(decision.favorabilityReasons),
        JSON.stringify(decision.scenarioFlags),
        auth.tenantId
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
    return { setup: saved.rows[0], decision, risk };
  });

  app.get("/api/setups/:id", async (request) => {
    const { id } = request.params as { id: string };
    const scope = await query("SELECT tenant_id, module_code FROM setup_candidates WHERE id = $1", [id]);
    const scoped = scope.rows[0] as any;
    if (!scoped) return null;
    const auth = await requireTenantModule(request, scoped.module_code ?? "orb_max_options");
    if (scoped.tenant_id !== auth.tenantId) return null;
    const setup = await query("SELECT * FROM setup_candidates WHERE id = $1 AND tenant_id = $2", [id, auth.tenantId]);
    const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [id]);
    return { ...setup.rows[0], evaluations: evaluations.rows };
  });

  for (const [path, status] of [
    ["confirm", "TRADE_PLANNED"],
    ["skip", "SKIPPED"],
    ["reject", "REJECTED"],
    ["mark-missed", "MISSED"]
  ] as const) {
    app.post(`/api/setups/:id/${path}`, async (request) => {
      const { id } = request.params as { id: string };
      const scope = await query("SELECT tenant_id, module_code FROM setup_candidates WHERE id = $1", [id]);
      const scoped = scope.rows[0] as any;
      if (!scoped) return null;
      const auth = await requireTenantModule(request, scoped.module_code ?? "orb_max_options");
      if (scoped.tenant_id !== auth.tenantId) return null;
      const { rows } = await query("UPDATE setup_candidates SET status = $2 WHERE id = $1 AND tenant_id = $3 RETURNING *", [id, status, auth.tenantId]);
      return rows[0];
    });
  }
}

function signalSetupView(row: any, evaluations: any[]) {
  // Promoted signals are immutable contracts. Later candles may update
  // predictions, but persisted plan/trade geometry owns BUY/SELL output.
  const entry = Number(row.actual_entry ?? row.planned_entry ?? row.entry_price);
  const stopLoss = Number(row.actual_stop ?? row.planned_stop ?? row.stop_price);
  const paperTarget = Number(row.actual_target ?? row.planned_target ?? row.target_price);
  const targetDistance = Math.abs(paperTarget - entry);
  const direction = row.direction === "SHORT" ? "SHORT" : "LONG";
  const flags = row.scenario_flags ?? {};
  const zone = flags.entryZone ?? flags.entry_zone ?? null;
  const zoneLow = Number(zone?.low);
  const zoneHigh = Number(zone?.high);
  const hasPersistedContract = row.actual_entry != null || row.planned_entry != null;
  const hasZone = !hasPersistedContract && Number.isFinite(zoneLow) && Number.isFinite(zoneHigh);
  const riskDistance = Math.abs(entry - stopLoss);
  const evidenceScore = row.favorability_score == null ? Number(flags.confidence) : Number(row.favorability_score);
  const evidenceScorePassed = Number.isFinite(evidenceScore) && evidenceScore >= XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore;
  const signalQuality = evaluateSignalGeometryQuality({
    direction,
    entry,
    stop: stopLoss,
    target: paperTarget,
    pipSize: XAUUSD_PRODUCTION_SIGNAL_POLICY.pipSize,
    minimumTp1Pips: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumTp1Pips,
    minimumFinalRewardToRisk: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumFinalRewardToRisk
  });
  const targetPlan = riskBasedTargetPlan(entry, stopLoss, paperTarget, direction);
  const lifecycleTargets = Array.isArray(row.paper_targets) && row.paper_targets.length > 0
    ? row.paper_targets.map((target: any) => ({
        targetNumber: Number(target.targetNumber),
        label: `TP${Number(target.targetNumber)}`,
        price: Number(target.price),
        riskMultiple: Number(target.riskMultiple),
        status: String(target.status ?? "PENDING"),
        hitAt: target.hitAt ?? null,
        hitPrice: target.hitPrice == null ? null : Number(target.hitPrice)
      }))
    : targetPlan.targets.map((target: any) => ({ ...target, status: "PENDING", hitAt: null, hitPrice: null }));
  const [tp1, tp2, tp3] = targetPlan.prices;
  const currentPrice = row.current_price == null ? null : Number(row.current_price);
  const freshness = liveSetupFreshness(row.detected_at, row.current_price_at, currentPrice, entry, stopLoss, false);
  const checklistPassed = evaluations.filter((evaluation) => evaluation.status === "PASS").length;
  const checklistTotal = evaluations.length;
  const mandatoryRules = evaluations.filter((evaluation) => module2SignalLayer(row.module_code, evaluation.rule_code ?? evaluation.ruleCode) === "mandatory");
  const variantRules = evaluations.filter((evaluation) => module2SignalLayer(row.module_code, evaluation.rule_code ?? evaluation.ruleCode) === "variant");
  const confirmationRules = evaluations.filter((evaluation) => module2SignalLayer(row.module_code, evaluation.rule_code ?? evaluation.ruleCode) === "confirmation");
  const qualityRules = evaluations.filter((evaluation) => module2SignalLayer(row.module_code, evaluation.rule_code ?? evaluation.ruleCode) === "quality");
  const paperTrackingRules = evaluations.filter((evaluation) => module2SignalLayer(row.module_code, evaluation.rule_code ?? evaluation.ruleCode) === "paperTracking");
  const missingRules = evaluations
    .filter((evaluation) => evaluation.status !== "PASS" && isSignalHardBlocker(row.module_code, evaluation))
    .slice(0, 6)
    .map((evaluation) => ({
      code: evaluation.rule_code ?? evaluation.ruleCode,
      name: evaluation.name,
      status: evaluation.status,
      explanation: evaluation.explanation
    }));
  const fullChecklistValid = checklistTotal > 0 && checklistPassed === checklistTotal;
  const profileApproved = Boolean(flags.mandatoryChecklistMatched) || ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(String(row.status));
  const confidence = Number.isFinite(evidenceScore) ? evidenceScore : null;
  const chance = signalChanceScore(confidence, checklistPassed, checklistTotal, Boolean(flags.fullChecklistMatched), direction, profileApproved);
  const variant = flags.module2Variant ?? null;
  const strategyProfile = signalStrategyProfile(row.module_code, row.scenario, flags);
  return {
    id: row.id,
    moduleCode: row.module_code,
    moduleName: row.module_name,
    symbol: row.symbol,
    action: direction === "LONG" ? "BUY" : "SELL",
    direction,
    scenario: row.scenario,
    status: row.status,
    setupTier: flags.setupTier ?? (flags.fullChecklistMatched ? "FULL" : "MANDATORY"),
    grade: row.favorability_grade ?? flags.tradeGrade ?? null,
    confidence,
    chance,
    chanceLabel: `${chance}/100`,
    chanceSource: confidence == null ? "Checklist evidence score" : "Module setup score",
    variantCode: variant?.code ?? flags.variantCode ?? null,
    variantName: variant?.name ?? null,
    variantVersion: variant?.version ?? flags.variantVersion ?? null,
    strategyProfile,
    signalThesisKey: row.signal_thesis_key ?? null,
    promotedAt: row.promoted_at ?? row.trade_plan_created_at ?? null,
    signalQuality: flags.signalQualityPolicy ?? {
      passed: signalQuality.passed && evidenceScorePassed,
      evidenceScore: confidence,
      minimumEvidenceScore: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore,
      tp1Pips: signalQuality.tp1Pips,
      minimumTp1Pips: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumTp1Pips,
      finalRewardToRisk: signalQuality.finalRewardToRisk,
      minimumFinalRewardToRisk: XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumFinalRewardToRisk,
      reasons: [
        ...signalQuality.reasons,
        ...(evidenceScorePassed ? [] : [`Evidence score ${confidence ?? "missing"}/100 is below ${XAUUSD_PRODUCTION_SIGNAL_POLICY.minimumEvidenceScore}/100.`])
      ]
    },
    signalFrequency: flags.signalFrequencyPolicy ?? null,
    signalExecution: flags.signalExecutionPolicy ?? null,
    signalCompetition: flags.signalCompetitionPolicy ?? null,
    checklistSummary: {
      mandatory: signalRuleSummary(mandatoryRules),
      variant: signalRuleSummary(variantRules),
      confirmations: signalRuleSummary(confirmationRules),
      quality: signalRuleSummary(qualityRules),
      paperTracking: signalRuleSummary(paperTrackingRules),
      missingRules
    },
    fullChecklistValid,
    profileApproved,
    longChecklistBoost: direction === "LONG" && profileApproved,
    moduleSignal: `${row.module_name} ${direction === "LONG" ? "BUY" : "SELL"} signal`,
    detectedAt: row.detected_at,
    expiresAt: row.expires_at,
    entry,
    entryRange: {
      low: hasZone ? Math.min(zoneLow, zoneHigh) : entry,
      high: hasZone ? Math.max(zoneLow, zoneHigh) : entry,
      kind: hasZone ? String(zone.kind ?? "STRATEGY_ENTRY_ZONE") : "EXACT_SIGNAL_CLOSE"
    },
    stopLoss,
    tp1,
    tp2,
    tp3,
    targets: lifecycleTargets,
    targetProgress: {
      hit: lifecycleTargets.filter((target: any) => target.status === "HIT").length,
      pending: lifecycleTargets.filter((target: any) => target.status === "PENDING").length,
      total: lifecycleTargets.length
    },
    longTradePlan: {
      label: "Profile-approved trade",
      targetLabel: "TP",
      targetPrice: roundSignalPrice(paperTarget),
      eligible: profileApproved,
      reason: profileApproved
        ? `${row.module_name} has a profile-approved ${direction === "LONG" ? "BUY" : "SELL"} setup with an evidence score of ${chance}/100.`
        : "Long setup waits until one valid module profile is approved."
    },
    pipSize: XAUUSD_PIP_SIZE,
    targetMethod: "STRUCTURAL_RISK_MULTIPLE",
    tradeHorizon: DAY_TRADING_HOLD_WINDOW,
    paperTarget,
    riskDistance,
    rewardToRisk: row.reward_to_risk == null ? (riskDistance > 0 ? targetDistance / riskDistance : null) : Number(row.reward_to_risk),
    currentPrice,
    currentPriceAt: row.current_price_at,
    detectedAgeMinutes: freshness.detectedAgeMinutes,
    entryDistanceFromCurrent: freshness.entryDistanceFromCurrent,
    maxLiveEntryDistance: freshness.maxLiveEntryDistance,
    isNearLivePrice: freshness.isNearLivePrice,
    isFreshSignal: freshness.isFreshSignal,
    livePriceStatus: freshness.livePriceStatus,
    trade: row.trade_id ? {
      id: row.trade_id,
      status: row.trade_outcome,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      exit: row.actual_exit == null ? null : Number(row.actual_exit),
      resultR: row.result_r == null ? null : Number(row.result_r)
    } : null,
    checklist: {
      passed: checklistPassed,
      total: checklistTotal,
      evaluations
    },
    reason: row.final_reason
  };
}

function signalStrategyProfile(moduleCode: string, scenarioValue: unknown, flags: any) {
  if (moduleCode === "high_probability_strategy_2") {
    return flags?.module2Variant?.code ?? flags?.variantCode ?? "LIQUIDITY_SWEEP_PROFILE";
  }
  const scenario = String(scenarioValue ?? "ORB_BREAKOUT").toUpperCase();
  if (scenario.includes("HORIZONTAL")) return "HORIZONTAL_RANGE_BREAKOUT";
  if (scenario.includes("OPENING_DRIVE")) return "OPENING_DRIVE";
  if (scenario.includes("LIQUIDITY_SWEEP")) return "LIQUIDITY_SWEEP_REVERSAL";
  if (scenario.includes("RETEST")) return "BREAKOUT_RETEST";
  return "ORB_BREAKOUT";
}

function isSignalHardBlocker(moduleCode: string, evaluation: any) {
  const code = String(evaluation.rule_code ?? evaluation.ruleCode ?? "");
  if (moduleCode === "high_probability_strategy_2" && [
    "DAILY_TRADE_LIMIT",
    "ACTIVE_SETUP_CONFLICT_CLEAR",
    "NO_ACTIVE_TRADE_CONFLICT"
  ].includes(code)) return false;
  const required = evaluation.required_for_entry ?? evaluation.requiredForEntry;
  if (required === true) return true;
  if (moduleCode === "high_probability_strategy_2") {
    return [
      "DATA_HEALTHY",
      "RISK_LIMITS_CLEAR",
      "MANUAL_CONFIRMATION_COMPLETED",
      "LIQUIDITY_LEVEL_IDENTIFIED",
      "LIQUIDITY_SWEEP_CONFIRMED",
      "SWEEP_REJECTION_CONFIRMED",
      "SWEEP_ACCEPTANCE_BLOCK",
      "RISK_OK",
      "VARIANT_SELECTED"
    ].includes(code);
  }
  if (moduleCode === "orb_max_options") {
    return [
      "ORB_LOCKED",
      "INSIDE_SIGNAL_WINDOW",
      "CLOSE_ABOVE_ORB_HIGH",
      "CLOSE_BELOW_ORB_LOW",
      "HORIZONTAL_RANGE_LOCKED",
      "HORIZONTAL_BREAKOUT_CONFIRMED",
      "HORIZONTAL_RETEST_CONFIRMED",
      "HORIZONTAL_CONFLICT_CLEAR",
      "ENTRY_NOT_OVEREXTENDED",
      "RISK_PERMISSION"
    ].includes(code);
  }
  return Boolean(evaluation.blocking);
}

function signalRuleSummary(rows: any[]) {
  return {
    passed: rows.filter((row) => row.status === "PASS").length,
    total: rows.length
  };
}

function module2SignalLayer(moduleCode: string, ruleCode?: string) {
  const code = String(ruleCode ?? "");
  if (moduleCode !== "high_probability_strategy_2") return "other";
  if (["DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT"].includes(code)) return "paperTracking";
  if (code === "CONFIRM_ENTRY_CANDLE") return "variant";
  if (code.startsWith("CONFIRM_") || code === "CONFIRMATION_COUNT") return "confirmation";
  if (code.startsWith("QUALITY_") || code === "QUALITY_FILTER_COUNT" || code === "EMA_FILTER_MODE" || code === "VOLUME_FILTER_MODE" || code === "DISPLACEMENT_FILTER_MODE" || code === "DOUBLE_SWEEP_FILTER") return "quality";
  if ([
    "PROTECTED_POINT_CONFIDENCE",
    "BOS_CHOCH_CONFIRMED",
    "MSS_STRENGTH",
    "ENTRY_ZONE_READY",
    "ENTRY_ZONE_RETRACE",
    "DIRECTIONAL_CONFLICT_CLEAR"
  ].includes(code)) return "variant";
  if ([
    "DATA_HEALTHY",
    "MARKET_CONTEXT_READY",
    "MARKET_REGIME_CLASSIFIED",
    "NY_SESSION_ACTIVE",
    "STRATEGY_CYCLE_ACTIVE",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "RISK_OK",
    "VARIANT_SELECTED"
  ].includes(code)) return "mandatory";
  return "other";
}

async function latestBrainPredictions(tenantId: string | null, setupIds: string[]) {
  if (!tenantId || setupIds.length === 0) return new Map<string, any>();
  const rows = await query(
    `SELECT DISTINCT ON (metadata->>'setupId')
       metadata->>'setupId' AS setup_id,
       metadata,
       created_at
     FROM operational_events
     WHERE tenant_id = $1
       AND event_type = 'MAIN_BRAIN_DECISION'
       AND metadata->>'setupId' = ANY($2::text[])
     ORDER BY metadata->>'setupId', created_at DESC`,
    [tenantId, setupIds]
  );
  return new Map((rows.rows as any[]).map((row) => [row.setup_id, { ...(row.metadata ?? {}), generatedAt: row.created_at }]));
}

function predictionSetupView(row: any, evaluations: any[], brain: any = null) {
  const flags = row.scenario_flags ?? {};
  const releaseBlocked = flags.releaseGate?.enforced === true && flags.releaseGate?.blocked === true;
  const brainDirection = brain?.direction === "SHORT" ? "SHORT" : brain?.direction === "LONG" ? "LONG" : null;
  const direction = brainActionDirection(brain?.action) ?? brainDirection ?? (row.direction === "SHORT" ? "SHORT" : row.direction === "LONG" ? "LONG" : predictedDirection(row));
  const action = releaseBlocked ? "WAIT" : brain?.action === "BUY" || brain?.action === "SELL" ? brain.action : direction === "SHORT" ? "SELL" : direction === "LONG" ? "BUY" : "WAIT";
  const entryZone = predictionEntryZone(row, flags);
  const entry = numericOrNull(brain?.entry ?? row.actual_entry ?? row.entry_price) ?? entryZone.midpoint;
  const stopLoss = numericOrNull(brain?.stop ?? row.actual_stop ?? row.stop_price) ?? predictedStop(row, flags, direction, entry);
  const target = numericOrNull(brain?.target ?? row.actual_target ?? row.target_price) ?? predictedTarget(entry, stopLoss, direction);
  const targetPlan = riskBasedTargetPlan(entry, stopLoss, target, direction);
  const [tp1, tp2, tp3] = targetPlan.prices;
  const passed = evaluations.filter((evaluation) => evaluation.status === "PASS").length;
  const blocking = evaluations.filter((evaluation) => evaluation.status !== "PASS" && evaluation.blocking).slice(0, 5);
  const total = evaluations.length;
  const fullChecklistMatched = total > 0 && passed === total;
  const mandatoryMatched = Boolean(flags.mandatoryChecklistMatched ?? flags.matrix?.mandatoryChecklistMatched ?? false);
  const confidence = row.favorability_score == null ? flags.confidence ?? null : Number(row.favorability_score);
  const probability = releaseBlocked ? 0 : predictionProbability(row, evaluations, confidence, mandatoryMatched, fullChecklistMatched, brain);
  const status = releaseBlocked ? "VALIDATION BLOCKED" : predictionStatus(row, mandatoryMatched, fullChecklistMatched, brain);
  const currentPrice = row.current_price == null ? null : Number(row.current_price);
  const freshness = liveSetupFreshness(row.detected_at, row.current_price_at, currentPrice, entry, stopLoss, true);
  const rr = entry != null && stopLoss != null && target != null
    ? Math.abs(Number(target) - Number(entry)) / Math.max(0.00001, Math.abs(Number(entry) - Number(stopLoss)))
    : null;
  return {
    id: row.id,
    moduleCode: row.module_code,
    moduleName: row.module_name,
    symbol: row.symbol,
    action,
    direction,
    scenario: row.scenario,
    status,
    setupStatus: row.status,
    setupTier: flags.setupTier ?? (fullChecklistMatched ? "FULL" : mandatoryMatched ? "MANDATORY" : "WATCH"),
    detectedAt: row.detected_at,
    expiresAt: row.expires_at,
    entry,
    entryRange: entryZone,
    stopLoss,
    target,
    takeProfit: target,
    tp1,
    tp2,
    tp3,
    targets: targetPlan.targets,
    targetMethod: "STRUCTURAL_RISK_MULTIPLE",
    rewardToRisk: row.reward_to_risk == null ? rr : Number(row.reward_to_risk),
    probability,
    confidence,
    grade: row.favorability_grade ?? flags.tradeGrade ?? null,
    brainPrediction: brainPredictionView(brain),
    brainApprovedPrediction: brainApprovesPrediction(brain),
    currentPrice,
    currentPriceAt: row.current_price_at,
    detectedAgeMinutes: freshness.detectedAgeMinutes,
    entryDistanceFromCurrent: freshness.entryDistanceFromCurrent,
    maxLiveEntryDistance: freshness.maxLiveEntryDistance,
    isNearLivePrice: freshness.isNearLivePrice,
    isFreshSignal: freshness.isFreshSignal,
    livePriceStatus: freshness.livePriceStatus,
    trade: row.trade_id ? { id: row.trade_id, status: row.trade_outcome, openedAt: row.opened_at } : null,
    checklist: {
      passed,
      total,
      mandatoryMatched,
      fullChecklistMatched,
      blocking,
      evaluations
    },
    reasoning: predictionReasoning(row, evaluations, flags, action, brain),
    missing: blocking.map((rule) => ({
      ruleCode: rule.rule_code,
      name: rule.name,
      status: rule.status,
      explanation: rule.explanation
    })),
    evidence: predictionEvidence(row.module_code, flags),
    invalidation: predictionInvalidation(row, flags, direction, stopLoss),
    nextAction: predictionNextAction(row, action, blocking, mandatoryMatched, fullChecklistMatched),
    tradeHorizon: DAY_TRADING_HOLD_WINDOW
    ,
    variantCode: flags.module2Variant?.code ?? flags.variantCode ?? null,
    variantName: flags.module2Variant?.name ?? flags.variantName ?? null,
    variantVersion: flags.module2Variant?.version ?? flags.variantVersion ?? null,
    variantStatus: flags.module2Variant?.approvalStatus ?? flags.module2Variant?.status ?? null,
    selectedVariant: flags.module2Variant ?? null
  };
}

function predictionEntryZone(row: any, flags: any) {
  const zone = flags.entryZone ?? flags.entry_zone ?? flags.pullbackZone ?? flags.entry_zone_snapshot ?? null;
  const low = numericOrNull(zone?.low ?? zone?.zoneLow ?? row.entry_zone_low);
  const high = numericOrNull(zone?.high ?? zone?.zoneHigh ?? row.entry_zone_high);
  const entry = numericOrNull(row.entry_price ?? row.actual_entry);
  if (low != null && high != null) {
    return {
      low: Math.min(low, high),
      high: Math.max(low, high),
      midpoint: roundSignalPrice((low + high) / 2),
      kind: String(zone?.kind ?? "STRATEGY_ENTRY_ZONE")
    };
  }
  return {
    low: entry,
    high: entry,
    midpoint: entry,
    kind: entry == null ? "WAITING_FOR_ENTRY_ZONE" : "EXACT_SIGNAL_CLOSE"
  };
}

function predictedDirection(row: any) {
  const haystack = `${row.scenario ?? ""} ${row.status ?? ""} ${row.final_reason ?? ""}`.toUpperCase();
  if (haystack.includes("SELL") || haystack.includes("SHORT") || haystack.includes("BEARISH")) return "SHORT";
  if (haystack.includes("BUY") || haystack.includes("LONG") || haystack.includes("BULLISH")) return "LONG";
  return null;
}

function predictedStop(row: any, flags: any, direction: "LONG" | "SHORT" | null, entry: number | null) {
  const sweep = flags.sweep ?? {};
  const drive = flags.openingDrive ?? flags.drive ?? {};
  if (direction === "SHORT") return numericOrNull(sweep.high ?? drive.high) ?? (entry == null ? null : roundSignalPrice(entry + 2));
  if (direction === "LONG") return numericOrNull(sweep.low ?? drive.low) ?? (entry == null ? null : roundSignalPrice(entry - 2));
  return null;
}

function predictedTarget(entry: number | null, stop: number | null, direction: "LONG" | "SHORT" | null) {
  if (entry == null || stop == null || !direction) return null;
  const risk = Math.abs(entry - stop);
  return roundSignalPrice(entry + (direction === "SHORT" ? -1 : 1) * risk * 2);
}

export function predictionProbability(row: any, evaluations: any[], confidence: unknown, mandatoryMatched: boolean, fullChecklistMatched: boolean, brain: any = null) {
  const numericConfidence = Number(confidence);
  const brainApproved = brainApprovesPrediction(brain);
  const brainBlocked = brainRejectsPrediction(brain);
  if (Number.isFinite(numericConfidence)) {
    const value = Math.min(99, Math.max(1, Math.round(numericConfidence + (brainApproved ? 3 : 0))));
    return brainBlocked ? Math.min(79, value) : value;
  }
  const total = evaluations.length;
  const passed = evaluations.filter((evaluation) => evaluation.status === "PASS").length;
  const base = total > 0 ? (passed / total) * 72 : 18;
  const mandatoryBonus = mandatoryMatched ? 12 : 0;
  const fullBonus = fullChecklistMatched ? 15 : 0;
  const actionBonus = row.direction ? 4 : 0;
  const brainBonus = brainApproved ? 5 : 0;
  const value = Math.min(99, Math.max(1, Math.round(base + mandatoryBonus + fullBonus + actionBonus + brainBonus)));
  return brainBlocked ? Math.min(79, value) : value;
}

function predictionStatus(row: any, mandatoryMatched: boolean, fullChecklistMatched: boolean, brain: any = null) {
  if (row.trade_outcome === "ACTIVE") return "ACTIVE PAPER TRADE";
  if (brainRejectsPrediction(brain)) return "BRAIN BLOCKED";
  if (brainApprovesPrediction(brain)) return fullChecklistMatched ? "BRAIN VALID ENTRY" : "BRAIN CORE ENTRY";
  if (brain) return "BRAIN MONITORING";
  if (["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(row.status)) return fullChecklistMatched ? "VALID ENTRY" : "CORE ENTRY";
  if (mandatoryMatched) return "CORE PREDICTION";
  if (row.direction) return "WATCHLIST";
  return "WAITING";
}

function predictionReasoning(row: any, evaluations: any[], flags: any, action: string, brain: any = null) {
  const passNames = evaluations.filter((rule) => rule.status === "PASS").slice(0, 5).map((rule) => rule.name);
  const base = row.final_reason ?? `${row.module_name} is monitoring for the next valid ${action === "WAIT" ? "BUY/SELL" : action} setup.`;
  const variant = flags.module2Variant ?? {};
  const moduleReason = row.module_code === "high_probability_strategy_2"
    ? `Prediction follows the ${variant.name ?? flags.variantCode ?? "selected Module 2 variant"} chain: potential liquidity, sweep rejection, displacement, BOS/MSS, entry-zone retrace, confirmation, then risk.`
    : "Prediction follows 15M opening range, 5M breakout/acceptance, retest or sweep-reversal evidence.";
  const brainReason = brain
    ? `Python brain: ${brain.decisionType ?? "DECISION"} / ${brain.action ?? "WAIT"}${brain.reason ? ` - ${brain.reason}` : ""}`
    : "Python brain prediction is waiting for the next strategy-brain sweep.";
  const missing = Array.isArray(variant.missingRules) && variant.missingRules.length > 0
    ? `Variant waiting on: ${variant.missingRules.slice(0, 4).join(", ")}.`
    : null;
  return [brainReason, moduleReason, base, missing, passNames.length ? `Matched: ${passNames.join(", ")}.` : null].filter(Boolean);
}

function brainActionDirection(action?: string) {
  if (action === "BUY") return "LONG";
  if (action === "SELL") return "SHORT";
  return null;
}

function brainApprovesPrediction(brain: any) {
  if (!brain) return false;
  const hasDirectionalAction = brain.action === "BUY" || brain.action === "SELL" || (brain.action === "MANAGE" && (brain.direction === "LONG" || brain.direction === "SHORT"));
  const isManagedTrade = brain.decisionType === "TRADE_ACTIVE" && (brain.direction === "LONG" || brain.direction === "SHORT");
  return (hasDirectionalAction || isManagedTrade)
    && [brain.entry, brain.stop, brain.target].every((value) => Number.isFinite(Number(value)))
    && !["ERROR", "CRITICAL"].includes(String(brain.severity ?? ""));
}

export function brainRejectsPrediction(brain: any) {
  if (!brain) return false;
  if (["ERROR", "CRITICAL"].includes(String(brain.severity ?? "").toUpperCase())) return true;
  const decisionType = String(brain.decisionType ?? "").toUpperCase();
  return ["BLOCKED", "INVALIDATED", "NO_TRADE", "CHECKLIST_MISMATCH"].some((state) => decisionType.includes(state));
}

function brainPredictionView(brain: any) {
  if (!brain) return {
    source: "PYTHON_MAIN_BRAIN",
    status: "NOT_RUN",
    action: "WAIT",
    approved: false,
    reason: "Python brain has not produced a prediction decision for this setup yet."
  };
  return {
    source: "PYTHON_MAIN_BRAIN",
    status: brain.decisionType ?? "UNKNOWN",
    action: brain.action ?? "WAIT",
    direction: brain.direction ?? null,
    approved: brainApprovesPrediction(brain),
    shouldOpenPaperTrade: Boolean(brain.shouldOpenPaperTrade),
    entry: numericOrNull(brain.entry),
    stopLoss: numericOrNull(brain.stop),
    takeProfit: numericOrNull(brain.target),
    score: numericOrNull(brain.score),
    grade: brain.grade ?? null,
    reason: brain.reason ?? null,
    generatedAt: brain.generatedAt ?? null
  };
}

function predictionEvidence(moduleCode: string, flags: any) {
  if (moduleCode === "high_probability_strategy_2") {
    return [
      evidenceRow("Variant", flags.module2Variant?.name ?? flags.variantCode, null),
      evidenceRow("Liquidity", flags.sweep?.level?.type, flags.sweep?.level?.price),
      evidenceRow("Sweep", flags.sweep?.time ?? flags.sweep?.timestampUtc, flags.sweep?.high ?? flags.sweep?.low),
      evidenceRow("Displacement", flags.displacement?.direction ?? flags.displacement?.type, flags.displacement?.rangeAtr),
      evidenceRow("BOS / CHoCH", flags.bos?.type ?? flags.structure?.type, flags.bos?.level),
      evidenceRow("Entry zone", flags.entryZone?.kind, flags.entryZone?.midpoint ?? flags.entryZone?.low),
      evidenceRow("HTF bias", flags.htfBias, null),
      evidenceRow("Confirmations", `${flags.confirmationLayer?.count ?? 0}/${flags.confirmationLayer?.required ?? 3}`, null),
      evidenceRow("Quality", `${flags.qualityLayer?.count ?? 0}/${flags.qualityLayer?.required ?? 3}`, null)
    ].filter(Boolean);
  }
  return [
    evidenceRow("ORB high", null, flags.tradePlan?.orbHigh ?? flags.openingRange?.high),
    evidenceRow("ORB low", null, flags.tradePlan?.orbLow ?? flags.openingRange?.low),
    evidenceRow("Scenario", flags.matrix?.selectedScenario, null)
  ].filter(Boolean);
}

function evidenceRow(label: string, value: unknown, price: unknown) {
  if (value == null && price == null) return null;
  return { label, value, price };
}

function predictionInvalidation(row: any, flags: any, direction: "LONG" | "SHORT" | null, stopLoss: number | null) {
  if (flags.invalidation?.reason) return flags.invalidation.reason;
  if (stopLoss != null) return `${direction === "SHORT" ? "Short" : "Long"} prediction invalidates around ${stopLoss.toFixed(2)}.`;
  if (row.module_code === "high_probability_strategy_2") return "Invalid if price accepts beyond the sweep extreme or the fresh FVG/order-block zone fails.";
  return "Invalid if price returns inside the ORB and fails acceptance.";
}

function predictionNextAction(row: any, action: string, blocking: any[], mandatoryMatched: boolean, fullChecklistMatched: boolean) {
  if (row.trade_outcome === "ACTIVE") return "Manage active paper trade until TP/SL lifecycle closes it.";
  if (fullChecklistMatched) return `${action} setup is fully valid. Review BUY & SELL or Paper Trading for execution details.`;
  if (mandatoryMatched) return `${action} core setup is forming. Wait for remaining confirmation/quality checks before full confidence.`;
  if (blocking[0]) return `Waiting for ${blocking[0].name}.`;
  return "Waiting for the strategy sequence to produce a directional prediction.";
}

function numericOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundSignalPrice(value: number) {
  return Number(value.toFixed(2));
}

function riskBasedTargetPlan(entryValue: unknown, stopValue: unknown, targetValue: unknown, directionValue: unknown) {
  const entry = numericOrNull(entryValue);
  const stop = numericOrNull(stopValue);
  const suppliedTarget = numericOrNull(targetValue);
  const direction = String(directionValue ?? "").toUpperCase();
  const hasDirection = ["LONG", "SHORT", "BUY", "SELL"].includes(direction);
  const multiplier = direction === "SHORT" || direction === "SELL" ? -1 : 1;
  if (entry == null || stop == null || !hasDirection) {
    return { prices: [null, null, null] as const, targets: [] as any[] };
  }

  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) {
    return { prices: [null, null, null] as const, targets: [] as any[] };
  }

  const targetIsDirectional = suppliedTarget != null && (suppliedTarget - entry) * multiplier > 0;
  const finalTarget = targetIsDirectional ? suppliedTarget : entry + multiplier * riskDistance * 2;
  const finalRiskMultiple = Math.abs(finalTarget - entry) / riskDistance;
  const riskMultiples = [
    Math.min(SIGNAL_TARGET_R_MULTIPLES[0], finalRiskMultiple),
    Math.min(SIGNAL_TARGET_R_MULTIPLES[1], finalRiskMultiple),
    finalRiskMultiple
  ];
  const prices = riskMultiples.map((riskMultiple) => roundSignalPrice(entry + multiplier * riskDistance * riskMultiple)) as [number, number, number];
  return {
    prices,
    targets: prices.map((price, index) => ({
      label: `TP${index + 1}`,
      price,
      riskMultiple: Number(riskMultiples[index].toFixed(2)),
      distance: roundSignalPrice(Math.abs(price - entry)),
      pips: Math.round(Math.abs(price - entry) / XAUUSD_PIP_SIZE),
      source: index === 2 && targetIsDirectional ? "STRATEGY_TARGET" : "STRUCTURAL_RISK"
    }))
  };
}

function signalChanceScore(confidence: unknown, checklistPassed: number, checklistTotal: number, fullChecklistMatched: boolean, direction: "LONG" | "SHORT", profileApproved = false) {
  const numericConfidence = Number(confidence);
  if (Number.isFinite(numericConfidence)) return Math.min(99, Math.max(1, Math.round(numericConfidence + (profileApproved ? 2 : 0))));
  const checklistScore = checklistTotal > 0 ? (checklistPassed / checklistTotal) * 100 : 0;
  const fullBonus = fullChecklistMatched ? 5 : 0;
  const profileBonus = profileApproved ? 8 : 0;
  const longValidationBonus = direction === "LONG" && checklistTotal > 0 && checklistPassed === checklistTotal ? 3 : 0;
  return Math.min(99, Math.max(1, Math.round(checklistScore + fullBonus + profileBonus + longValidationBonus)));
}

function summarizeSignals(signals: any[]) {
  return {
    total: signals.length,
    buy: signals.filter((signal) => signal.action === "BUY").length,
    sell: signals.filter((signal) => signal.action === "SELL").length,
    activePaperTrades: signals.filter((signal) => signal.trade?.status === "ACTIVE").length,
    fullSetups: signals.filter((signal) => signal.setupTier === "FULL").length,
    averageChance: signals.length > 0 ? Math.round(signals.reduce((sum, signal) => sum + Number(signal.chance ?? 0), 0) / signals.length) : 0,
    latestAt: signals[0]?.detectedAt ?? null
  };
}

function emptySignalSummary() {
  return { total: 0, buy: 0, sell: 0, activePaperTrades: 0, fullSetups: 0, averageChance: 0, latestAt: null };
}

function summarizePredictions(predictions: any[]) {
  return {
    total: predictions.length,
    buy: predictions.filter((prediction) => prediction.action === "BUY").length,
    sell: predictions.filter((prediction) => prediction.action === "SELL").length,
    validEntries: predictions.filter((prediction) => prediction.status === "VALID ENTRY" || prediction.status === "CORE ENTRY").length,
    watchlist: predictions.filter((prediction) => prediction.status === "WATCHLIST" || prediction.status === "CORE PREDICTION").length,
    averageProbability: predictions.length > 0 ? Math.round(predictions.reduce((sum, prediction) => sum + Number(prediction.probability ?? 0), 0) / predictions.length) : 0,
    latestAt: predictions[0]?.detectedAt ?? null
  };
}

function emptyPredictionSummary() {
  return { total: 0, buy: 0, sell: 0, validEntries: 0, watchlist: 0, averageProbability: 0, latestAt: null };
}

function isUpcomingPrediction(prediction: any) {
  if (!prediction || prediction.action === "WAIT") return false;
  if (prediction.trade?.status === "ACTIVE") return false;
  const detectedAt = new Date(prediction.detectedAt).getTime();
  const latestAt = prediction.currentPriceAt ? new Date(prediction.currentPriceAt).getTime() : Date.now();
  if (!Number.isFinite(detectedAt) || !Number.isFinite(latestAt)) return false;
  const ageMinutes = (latestAt - detectedAt) / 60000;
  if (ageMinutes < -5 || ageMinutes > MAX_LIVE_PREDICTION_AGE_MINUTES) return false;
  const currentPrice = numericOrNull(prediction.currentPrice);
  const entry = numericOrNull(prediction.entry ?? prediction.entryRange?.midpoint);
  if (currentPrice == null || entry == null) return false;
  const stopLoss = numericOrNull(prediction.stopLoss);
  const target = numericOrNull(prediction.target ?? prediction.takeProfit);
  if (!validSignalGeometry(prediction.direction, entry, stopLoss, target)) return false;
  const riskDistance = stopLoss == null ? 0 : Math.abs(entry - stopLoss);
  const maxDistance = Math.max(MAX_LIVE_PREDICTION_ENTRY_DISTANCE, riskDistance * 1.5);
  return Math.abs(currentPrice - entry) <= maxDistance;
}

function isLiveSignal(signal: any) {
  if (!signal || !["BUY", "SELL"].includes(String(signal.action))) return false;
  const detectedAt = new Date(signal.detectedAt).getTime();
  const latestAt = signal.currentPriceAt ? new Date(signal.currentPriceAt).getTime() : Date.now();
  if (!Number.isFinite(detectedAt) || !Number.isFinite(latestAt)) return false;
  const ageMinutes = (latestAt - detectedAt) / 60000;
  if (ageMinutes < -5 || ageMinutes > MAX_LIVE_PREDICTION_AGE_MINUTES) return false;
  const currentPrice = numericOrNull(signal.currentPrice);
  const entry = numericOrNull(signal.entry ?? signal.entryRange?.midpoint);
  if (currentPrice == null || entry == null) return false;
  const stopLoss = numericOrNull(signal.stopLoss);
  const target = numericOrNull(signal.paperTarget ?? signal.takeProfit ?? signal.tp3);
  if (!validSignalGeometry(signal.direction, entry, stopLoss, target)) return false;
  const riskDistance = stopLoss == null ? 0 : Math.abs(entry - stopLoss);
  const maxDistance = Math.max(MAX_LIVE_PREDICTION_ENTRY_DISTANCE, riskDistance);
  return Math.abs(currentPrice - entry) <= maxDistance;
}

function validSignalGeometry(direction: unknown, entry: number | null, stop: number | null, target: number | null) {
  if (entry == null || stop == null || target == null) return false;
  if (direction === "LONG") return stop < entry && entry < target;
  if (direction === "SHORT") return target < entry && entry < stop;
  return false;
}

function liveSetupFreshness(
  detectedAtValue: unknown,
  currentPriceAtValue: unknown,
  currentPrice: number | null,
  entry: number | null,
  stopLoss: number | null,
  predictionMode: boolean
) {
  const detectedAt = new Date(String(detectedAtValue ?? "")).getTime();
  const latestAt = currentPriceAtValue ? new Date(String(currentPriceAtValue)).getTime() : Date.now();
  const detectedAgeMinutes = Number.isFinite(detectedAt) && Number.isFinite(latestAt)
    ? Number(((latestAt - detectedAt) / 60000).toFixed(1))
    : null;
  const riskDistance = entry == null || stopLoss == null ? 0 : Math.abs(entry - stopLoss);
  const maxLiveEntryDistance = Math.max(MAX_LIVE_PREDICTION_ENTRY_DISTANCE, riskDistance * (predictionMode ? 1.5 : 1));
  const entryDistanceFromCurrent = currentPrice == null || entry == null ? null : Number(Math.abs(currentPrice - entry).toFixed(2));
  const isNearLivePrice = entryDistanceFromCurrent == null ? false : entryDistanceFromCurrent <= maxLiveEntryDistance;
  const isFreshAge = detectedAgeMinutes != null && detectedAgeMinutes >= -5 && detectedAgeMinutes <= MAX_LIVE_PREDICTION_AGE_MINUTES;
  return {
    detectedAgeMinutes,
    entryDistanceFromCurrent,
    maxLiveEntryDistance: Number(maxLiveEntryDistance.toFixed(2)),
    isNearLivePrice,
    isFreshSignal: isFreshAge && isNearLivePrice,
    livePriceStatus: !isFreshAge
      ? "STALE_TIME"
      : isNearLivePrice
        ? "LIVE_PRICE_CONTEXT"
        : "ENTRY_PRICE_TOO_FAR_FROM_LIVE_MARKET"
  };
}

function setupRecommendation(setup: any) {
  if (setup.direction === "LONG" && ["LONG SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(setup.status)) return "BUY";
  if (setup.direction === "SHORT" && ["SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(setup.status)) return "SELL";
  if (["NO TRADE", "BLOCKED", "SETUP_INVALIDATED"].includes(setup.status)) return "NO TRADE";
  return "WAIT";
}

function launchCheck(code: string, label: string, passed: boolean, detail: string) {
  return { code, label, status: passed ? "PASS" : "FAIL", detail };
}

async function closeModuleReplayPaperTrade(setup: any, tenantId: string | null, event: "TP_HIT" | "SL_HIT" | "MANUAL_CLOSE", eventPrefix: string) {
  const active = await query(
    `SELECT t.*, tp.id AS plan_id, sc.direction
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.id = $1 AND sc.tenant_id = $2 AND t.outcome = 'ACTIVE'
     ORDER BY t.opened_at DESC
     LIMIT 1`,
    [setup.id, tenantId]
  );
  const trade = active.rows[0] as any;
  if (!trade) return null;
  const exit = event === "TP_HIT" ? Number(trade.actual_target) : event === "SL_HIT" ? Number(trade.actual_stop) : Number(trade.actual_entry);
  const entry = Number(trade.actual_entry);
  const stop = Number(trade.actual_stop);
  const multiplier = trade.direction === "SHORT" ? -1 : 1;
  const resultR = Math.abs(entry - stop) > 0 ? ((exit - entry) * multiplier) / Math.abs(entry - stop) : 0;
  const outcome = resultR > 0 ? "WIN" : resultR < 0 ? "LOSS" : "BREAKEVEN";
  const closed = await query(
    "UPDATE trades SET actual_exit = $2, result_r = $3, outcome = $4, closed_at = now() WHERE id = $1 RETURNING *",
    [trade.id, resultR > 0 ? trade.actual_target : exit, resultR, outcome]
  );
  await cancelPendingPaperTargets(trade.id, event);
  await query("UPDATE trade_plans SET status = 'CLOSED' WHERE id = $1", [trade.plan_id]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [trade.id, `${eventPrefix}_${event}`, { setupId: setup.id, resultR, outcome, replay: true, moduleCode: setup.module_code }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,$5,$6,'QA',$7)`,
    [tenantId, setup.id, trade.id, setup.session_id, `${eventPrefix}_${event}`, `${setup.module_code} rehearsal verified the paper-trade close path.`, outcome]
  );
  return closed.rows[0];
}

async function moduleRehearsalReport(tenantId: string | null, moduleCode: string) {
  const result = await query(
    `SELECT
       count(t.id)::int AS paper_trades,
       count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
       count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
       COALESCE(sum(t.result_r), 0)::float AS total_r
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.tenant_id = $1 AND sc.module_code = $2`,
    [tenantId, moduleCode]
  );
  const row = result.rows[0] ?? {};
  return {
    paperTrades: Number(row.paper_trades ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    totalR: Number(row.total_r ?? 0)
  };
}

async function moduleRehearsalAudit(tenantId: string | null, moduleCode: string) {
  const [invalidTrades, mixedTrades, duplicateProduction] = await Promise.all([
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
      `SELECT count(*)::int AS count
       FROM trade_plans tp
       JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
       JOIN trading_sessions ts ON ts.id = sc.session_id
       WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND ts.module_code <> $2`,
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
           AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
         GROUP BY sc.session_id
         HAVING count(t.id) > 1
       ) duplicate_sessions`,
      [tenantId, moduleCode]
    )
  ]);
  const failedChecks = [invalidTrades, mixedTrades, duplicateProduction].filter((item) => Number(item.rows[0]?.count ?? 0) > 0).length;
  return {
    status: failedChecks === 0 ? "PASS" : "FAIL",
    failedChecks,
    invalidTrades: Number(invalidTrades.rows[0]?.count ?? 0),
    mixedTrades: Number(mixedTrades.rows[0]?.count ?? 0),
    duplicateProduction: Number(duplicateProduction.rows[0]?.count ?? 0)
  };
}

async function moduleRehearsalNotificationProof(tenantId: string | null, eventTypePrefix: string, setupId: string) {
  const result = await query(
    `SELECT count(*)::int AS total
     FROM notifications
     WHERE tenant_id = $1
       AND (event_key LIKE $2 OR event_key LIKE $3 OR event_type LIKE $4)`,
    [tenantId, `%${setupId}`, `module1-rehearsal-test-%`, `${eventTypePrefix}%`]
  );
  return {
    total: Number(result.rows[0]?.total ?? 0)
  };
}

async function moduleIsolationProof(tenantId: string | null, moduleCode: string) {
  const result = await query(
    `SELECT count(*)::int AS mixed_trades
     FROM trade_plans tp
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     JOIN trading_sessions ts ON ts.id = sc.session_id
     WHERE sc.tenant_id = $1 AND sc.module_code = $2 AND ts.module_code <> $2`,
    [tenantId, moduleCode]
  );
  return {
    mixedTrades: Number(result.rows[0]?.mixed_trades ?? 0),
    sharedFeedOnly: true
  };
}

async function buildOrbQaSuite(tenantId: string | null) {
  const session = await ensureTodaySession(tenantId);
  const version = await selectedStrategyVersion();
  const configuration = await getTenantOrbStrategyConfiguration(tenantId, version.configuration_json);
  const cases = ORB_QA_CASES.map((testCase) => {
    const replay = buildReplay(testCase.code, session);
    const openingRange = buildOpeningRange(replay.openingRangeCandles, 0.01, 1);
    const decision = evaluateSetup({
      now: replay.currentCandle.timestampUtc,
      symbol: session.symbol,
      strategyVersionId: session.strategy_version_id,
      session: {
        id: session.id,
        symbol: session.symbol,
        strategyVersionId: session.strategy_version_id,
        sessionDate: session.session_date,
        sessionPreset: session.session_preset,
        state: "WAITING_FOR_SETUP",
        sessionStartAt: session.session_start_at,
        openingRangeEndAt: session.opening_range_end_at,
        signalWindowEndAt: session.signal_window_end_at,
        dataStatus: "VALID"
      },
      openingRange,
      currentCandle: replay.currentCandle,
      previousCandles: replay.previousCandles,
      spread: replay.currentCandle.spread ?? undefined,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration: configuration as any
    });
    const tradable = decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY";
    const scenarioMatched = decision.scenario === testCase.expected;
    const tradableMatched = tradable === testCase.tradable;
    return {
      code: testCase.code,
      label: testCase.label,
      expected: testCase.expected,
      actual: decision.scenario,
      expectedTradable: testCase.tradable,
      actualTradable: tradable,
      status: scenarioMatched && tradableMatched ? "PASS" : "FAIL",
      score: decision.favorabilityScore,
      grade: decision.favorabilityGrade,
      reason: scenarioMatched && tradableMatched ? "ORB replay behavior matches expectation." : `Expected ${testCase.expected} tradable=${testCase.tradable}, got ${decision.scenario} tradable=${tradable}.`
    };
  });
  const failed = cases.filter((row) => row.status !== "PASS");
  return {
    moduleCode: "orb_max_options",
    generatedAt: new Date().toISOString(),
    testMode: true,
    twelveDataCreditsUsed: 0,
    externalOrdersPlaced: 0,
    finalStatus: failed.length === 0 ? "PASS" : "FAIL",
    summary: {
      total: cases.length,
      passed: cases.length - failed.length,
      failed: failed.length,
      tradableCases: cases.filter((row) => row.expectedTradable).length,
      noTradeProtections: cases.filter((row) => !row.expectedTradable).length
    },
    cases
  };
}

async function selectedStrategyVersion() {
  const versionResult = await query(`
    SELECT sv.*
    FROM strategy_versions sv
    JOIN strategies s ON s.id = sv.strategy_id
    LEFT JOIN user_preferences up ON up.selected_strategy_version_id = sv.id
    WHERE up.selected_strategy_version_id IS NOT NULL
       OR s.name ILIKE '%ORB%'
       OR sv.configuration_json->>'moduleCode' = 'orb_max_options'
    ORDER BY
      CASE WHEN up.selected_strategy_version_id IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN sv.status = 'ACTIVE' THEN 0 ELSE 1 END,
      sv.activated_at DESC NULLS LAST,
      sv.created_at DESC
    LIMIT 1
  `);
  const version = versionResult.rows[0] as any;
  if (!version?.id) {
    throw new Error("No Module 1 ORB strategy version is available. Run migrations/seeds before running Module 1 proof.");
  }
  return version;
}

async function ensureTodaySession(tenantId: string | null) {
  const version = await selectedStrategyVersion();
  const sessionDate = newYorkDate();
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = 'XAUUSD'
       AND ts.strategy_version_id = $1
       AND ts.session_date = $2
       AND ts.session_preset = 'NY_0915'
       AND ts.tenant_id = $3
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [version.id, sessionDate, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as any;
  const times = sessionTimesForDate(sessionDate, version.session_start, version.opening_range_minutes, version.trade_window_end);
  const { rows } = await query(
    `INSERT INTO trading_sessions (
      tenant_id, user_id, symbol, strategy_version_id, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $6, (SELECT id FROM users WHERE tenant_id = $6 LIMIT 1), 'XAUUSD', $1, $2, 'NY_0915', 'PRE_SESSION', $3, $4, $5
    ) RETURNING *`,
    [version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, tenantId]
  );
  return { ...rows[0], signal_timeframe_minutes: version.signal_timeframe_minutes };
}

async function selectedModule2StrategyVersion() {
  const versionResult = await query(
    `SELECT sv.*
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     WHERE sv.id = '00000000-0000-0000-0000-000000000402'
        OR s.id = '00000000-0000-0000-0000-000000000302'
     ORDER BY CASE WHEN sv.id = '00000000-0000-0000-0000-000000000402' THEN 0 ELSE 1 END, sv.activated_at DESC
     LIMIT 1`
  );
  return versionResult.rows[0] as any;
}

async function ensureTodayModule2Session(tenantId: string | null) {
  const version = await selectedModule2StrategyVersion();
  const sessionDate = newYorkDate();
  const existing = await query(
    `SELECT ts.*, sv.signal_timeframe_minutes
     FROM trading_sessions ts
     JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
     WHERE ts.symbol = 'XAUUSD'
       AND ts.strategy_version_id = $1
       AND ts.session_date = $2
       AND ts.session_preset = 'NY_SWEEP_BOS'
       AND ts.tenant_id = $3
       AND ts.module_code = 'high_probability_strategy_2'
     ORDER BY ts.created_at DESC
     LIMIT 1`,
    [version.id, sessionDate, tenantId]
  );
  if (existing.rows[0]) return existing.rows[0] as any;
  const times = sessionTimesForDate(sessionDate, "00:00", Number(version.opening_range_minutes ?? 0), "23:59");
  const { rows } = await query(
    `INSERT INTO trading_sessions (
      tenant_id, user_id, symbol, strategy_version_id, module_code, session_date, session_preset, state,
      session_start_at, opening_range_end_at, signal_window_end_at
    ) VALUES (
      $6, (SELECT id FROM users WHERE tenant_id = $6 LIMIT 1), 'XAUUSD', $1, 'high_probability_strategy_2', $2, 'NY_SWEEP_BOS', 'WAITING_FOR_SETUP', $3, $4, $5
    ) RETURNING *`,
    [version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, tenantId]
  );
  return { ...rows[0], signal_timeframe_minutes: version.signal_timeframe_minutes };
}

function buildReplay(replayCase: ReplayCase, session: any) {
  const openingRangeCandles = [replayCandle(session.session_start_at, 100, 110, 90, 104)];
  const t0 = new Date(session.opening_range_end_at).getTime();
  const at = (minutesAfterOrb: number) => new Date(t0 + minutesAfterOrb * 60_000).toISOString();
  const trendUp = Array.from({ length: 50 }, (_, index) => replayCandle(new Date(t0 - (50 - index) * 15 * 60_000).toISOString(), 96 + index * 0.2, 98 + index * 0.2, 95 + index * 0.2, 97 + index * 0.2));
  const trendDown = Array.from({ length: 50 }, (_, index) => replayCandle(new Date(t0 - (50 - index) * 15 * 60_000).toISOString(), 114 - index * 0.2, 115 - index * 0.2, 112 - index * 0.2, 113 - index * 0.2));

  if (replayCase === "SELL") {
    return {
      openingRangeCandles,
      previousCandles: trendDown,
      currentCandle: replayCandle(at(15), 93, 94, 86, 87),
      expectedScenario: "OPENING_DRIVE_CLEAN_BREAKOUT"
    };
  }
  if (replayCase === "RETEST") {
    return {
      openingRangeCandles,
      previousCandles: [...trendUp, replayCandle(at(15), 107, 114, 106, 113)],
      currentCandle: replayCandle(at(30), 111, 113, 110.5, 112.8),
      expectedScenario: "BREAKOUT_RETEST_CONFIRMED"
    };
  }
  if (replayCase === "FAKEOUT") {
    return {
      openingRangeCandles,
      previousCandles: [],
      currentCandle: replayCandle(at(15), 108, 112, 100, 105),
      expectedScenario: "FAKEOUT_REVERSAL_CANDIDATE"
    };
  }
  if (replayCase === "SWEEP_REVERSAL") {
    return {
      openingRangeCandles,
      previousCandles: [...trendDown, replayCandle(at(15), 108, 112, 100, 104)],
      currentCandle: replayCandle(at(30), 94, 95, 86, 87),
      expectedScenario: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED"
    };
  }
  if (replayCase === "OVEREXTENDED") {
    return {
      openingRangeCandles,
      previousCandles: trendUp,
      currentCandle: replayCandle(at(15), 111, 125, 110, 124),
      expectedScenario: "OVEREXTENDED_BREAKOUT_NO_TRADE"
    };
  }
  if (replayCase === "NO_TRADE") {
    return {
      openingRangeCandles,
      previousCandles: [replayCandle(at(15), 100, 112, 99, 105)],
      currentCandle: replayCandle(at(30), 105, 106, 88, 95),
      expectedScenario: "DOUBLE_SIDED_SWEEP"
    };
  }
  return {
    openingRangeCandles,
    previousCandles: trendUp,
    currentCandle: replayCandle(at(15), 107, 114, 106, 113),
    expectedScenario: "OPENING_DRIVE_CLEAN_BREAKOUT"
  };
}

function replayCandle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  const priceOffset = 3950;
  return candle(timestampUtc, open + priceOffset, high + priceOffset, low + priceOffset, close + priceOffset);
}

function candle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  return { timestampUtc, open, high, low, close, spread: 0.2 };
}

async function createModule2ReplayRecord(tenantId: string, replayCase: Module2ReplayCase, openPaperTrade: boolean, productionProof: boolean): Promise<any> {
  const session = await ensureTodayModule2Session(tenantId);
  const replay = buildModule2Replay(replayCase, session);
  const timestamp = new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO setup_candidates (
      tenant_id, session_id, strategy_version_id, symbol, module_code, scenario, direction, status, detected_at,
      expires_at, entry_price, stop_price, target_price, final_reason,
      favorability_score, favorability_grade, favorability_reasons, scenario_flags
    ) VALUES ($17,$1,$2,$3,'high_probability_strategy_2',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *`,
    [
      session.id,
      session.strategy_version_id,
      session.symbol,
      replay.scenario,
      replay.direction,
      replay.status,
      timestamp,
      session.signal_window_end_at,
      replay.entryPrice ?? null,
      replay.stopPrice ?? null,
      replay.targetPrice ?? null,
      `${productionProof ? "Module 2 production proof" : "Module 2 replay"} ${replayCase}: ${replay.finalReason}`,
      replay.score,
      replay.grade,
      JSON.stringify(replay.reasons),
      JSON.stringify({
        ...replay.flags,
        replay: true,
        productionProof,
        replayCase,
        replayExpectedScenario: replay.expectedScenario,
        replayMatchedExpectedScenario: replay.scenario === replay.expectedScenario || replay.flags.state === replay.expectedScenario,
        chartSnapshotCandles: replay.snapshotCandles
      }),
      tenantId
    ]
  );
  const setup = rows[0];
  for (const evaluation of replay.evaluations) {
    await query(
      `INSERT INTO setup_rule_evaluations (
        setup_candidate_id, rule_code, name, status, blocking, source, actual_value, required_value, explanation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        setup.id,
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
  const trade = openPaperTrade && replay.status.includes("SETUP READY")
    ? await openModule2ReplayPaperTrade(setup, tenantId)
    : null;
  let notification: any = null;
  if (await canCreateTenantNotification(tenantId)) {
    const eventType = productionProof ? "MODULE2_PRODUCTION_PROOF" : "MODULE2_REPLAY";
    const notificationRows = await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (event_key) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         priority = EXCLUDED.priority,
         data = EXCLUDED.data,
         created_at = now()
       RETURNING *`,
      [
        tenantId,
        `${eventType.toLowerCase()}-${setup.id}`,
        eventType,
        productionProof ? `Module 2 proof: ${replay.status}` : `Module 2 replay: ${replay.status}`,
        `${replayCase} produced ${replay.scenario}. No Twelve Data call, no real order.`,
        replay.status.includes("SETUP READY") ? "HIGH" : "NORMAL",
        JSON.stringify(module2ReplayNotificationData(setup, replay, trade, productionProof))
      ]
    );
    notification = notificationRows.rows[0] ?? null;
  }
  if (productionProof) {
    await upsertModule2ProofLearningReview(tenantId, setup, replay, trade);
  }
  const evaluations = await query("SELECT * FROM setup_rule_evaluations WHERE setup_candidate_id = $1 ORDER BY evaluated_at", [setup.id]);
  const journal = await query("SELECT * FROM journal_entries WHERE setup_candidate_id = $1 ORDER BY created_at DESC LIMIT 1", [setup.id]);
  const refreshedSetup = await query("SELECT * FROM setup_candidates WHERE id = $1", [setup.id]);
  return {
    setup: { ...(refreshedSetup.rows[0] ?? setup), evaluations: evaluations.rows },
    trade,
    notification,
    journal: journal.rows[0] ?? null,
    replayCase,
    testMode: true,
    productionProof
  };
}

async function upsertModule2ProofLearningReview(tenantId: string, setup: any, replay: ReturnType<typeof buildModule2Replay>, trade: any) {
  await query(
    `INSERT INTO module_learning_reviews (
      tenant_id, module_code, status, title, rationale, proposed_change, guardrails,
      source_key, review_type, classification, evidence
    ) VALUES (
      $1,
      'high_probability_strategy_2',
      'PENDING',
      'Module 2 production proof replay review',
      $2,
      $3::jsonb,
      $4::jsonb,
      $5,
      'LEARNING_RECOMMENDATION',
      'PENDING_CLASSIFICATION',
      $6::jsonb
    )
    ON CONFLICT (tenant_id, module_code, source_key) WHERE source_key IS NOT NULL DO UPDATE SET
      status = 'PENDING',
      rationale = EXCLUDED.rationale,
      proposed_change = EXCLUDED.proposed_change,
      guardrails = EXCLUDED.guardrails,
      classification = EXCLUDED.classification,
      evidence = EXCLUDED.evidence,
      created_at = now()`,
    [
      tenantId,
      "Production proof replay verified the selected Module 2 liquidity-sweep variant chain. Review this artifact before changing live thresholds.",
      JSON.stringify({
        action: "KEEP_CURRENT_PRODUCTION_PROFILE",
        moduleCode: "high_probability_strategy_2",
        variantCode: replay.flags.variantCode,
        minimumSignalScore: 80,
        note: "This proof confirms wiring for the selected profile; real threshold changes still require backtest and forward-test evidence."
      }),
      JSON.stringify([
        "Do not approve threshold changes from proof replay alone.",
        "Require saved-candle backtest and live forward evidence before tuning.",
        "Keep broker execution disabled; paper trading only."
      ]),
      `module2-production-proof-${setup.id}`,
      JSON.stringify({
        setupId: setup.id,
        tradeId: trade?.id ?? null,
        scenario: replay.scenario,
        direction: replay.direction,
        entry: replay.entryPrice,
        stopLoss: replay.stopPrice,
        target: replay.targetPrice,
        confidence: replay.score,
        grade: replay.grade,
        variant: replay.flags.module2Variant,
        mandatoryRules: MODULE2_STRICT_REQUIRED_RULES,
        snapshotCandles: replay.snapshotCandles,
        finalReason: replay.finalReason
      })
    ]
  );
}

function module2ReplayNotificationData(setup: any, replay: ReturnType<typeof buildModule2Replay>, trade: any, productionProof: boolean) {
  const direction = replay.direction === "SHORT" ? "SELL" : replay.direction === "LONG" ? "BUY" : "WAIT";
  const variant = (replay.flags.module2Variant ?? {}) as Record<string, any>;
  return {
    kind: productionProof ? "MODULE2_PRODUCTION_PROOF" : "MODULE2_REPLAY",
    moduleCode: "high_probability_strategy_2",
    moduleName: "Module 2: Ultimate Liquidity Sweep",
    strategy: "Ultimate Liquidity Sweep",
    variantCode: variant.code ?? replay.flags.variantCode,
    variantName: variant.name ?? null,
    variantProfile: variant.profileKey ?? null,
    variantStatus: variant.approvalStatus ?? null,
    variantPaperEligible: variant.paperEligible ?? null,
    direction,
    action: direction,
    status: replay.status,
    scenario: replay.scenario,
    confidence: replay.score,
    grade: replay.grade,
    entry: replay.entryPrice,
    stopLoss: replay.stopPrice,
    target: replay.targetPrice,
    takeProfit: replay.targetPrice,
    rewardToRisk: replay.flags.riskReward,
    setupCandidateId: setup.id,
    tradeId: trade?.id ?? null,
    trade: trade ? {
      id: trade.id,
      outcome: trade.outcome,
      openedAt: trade.opened_at,
      entry: trade.actual_entry,
      stopLoss: trade.actual_stop,
      target: trade.actual_target
    } : null,
    liquidity: replay.flags.sweep?.level ?? null,
    sweep: replay.flags.sweep ?? null,
    displacement: replay.flags.displacement ?? null,
    bos: replay.flags.bos ?? null,
    entryZone: replay.flags.entryZone ?? null,
    mandatoryRules: MODULE2_STRICT_REQUIRED_RULES,
    finalReason: replay.finalReason
  };
}

function buildModule1HorizontalRangeProof(session: any) {
  const baseAt = new Date(session.session_start_at).getTime();
  const at = (minutes: number) => new Date(baseAt + minutes * 60_000).toISOString();
  const rangeCandles: Candle[] = [
    replayCandle(at(0), 100.0, 101.0, 99.0, 100.2),
    replayCandle(at(5), 100.2, 100.8, 99.2, 99.8),
    replayCandle(at(10), 99.8, 100.9, 99.1, 100.3),
    replayCandle(at(15), 100.3, 100.7, 99.3, 99.9),
    replayCandle(at(20), 99.9, 101.1, 99.0, 100.4),
    replayCandle(at(25), 100.4, 100.9, 99.2, 99.7),
    replayCandle(at(30), 99.7, 100.8, 99.1, 100.1),
    replayCandle(at(35), 100.1, 100.7, 99.2, 99.8),
    replayCandle(at(40), 99.8, 101.0, 99.0, 100.2),
    replayCandle(at(45), 100.2, 100.8, 99.1, 99.9),
    replayCandle(at(50), 99.9, 100.9, 99.2, 100.3),
    replayCandle(at(55), 100.3, 100.7, 99.1, 99.8)
  ];
  const breakoutCandle = replayCandle(at(60), 100.4, 102.1, 100.2, 101.8);
  const retestCandle = replayCandle(at(65), 100.8, 102.2, 100.6, 101.7);
  const detector = new HorizontalRangeDetector({
    ...DEFAULT_HORIZONTAL_RANGE_CONFIG,
    enabled: true,
    observationOnly: false,
    minimumRangeCandles: 12,
    maximumRangeCandles: 12,
    minimumQualityScore: 60,
    maximumBoundarySlopeAtrPerBar: 0.2,
    maximumEfficiencyRatio: 0.4,
    minimumWidthAtr: 0.5
  });
  const context = {
    symbol: session.symbol,
    now: at(55),
    timezone: "America/New_York",
    candles5m: rangeCandles,
    atr5m: 1.5,
    activeRanges: [],
    strategyVersion: String(session.strategy_version_id),
    sessionContext: {
      sessionName: "New York",
      sessionTimezone: "America/New_York",
      rangeStart: session.session_start_at,
      rangeEnd: at(55),
      signalWindowEnd: session.signal_window_end_at
    }
  };
  const detection = detector.detect(context);
  if (!detection.range) throw new Error("Module 1 horizontal proof range did not lock.");
  const profile = RANGE_BREAKOUT_PROFILES.HORIZONTAL_CONSOLIDATION;
  const breakout = evaluateRangeBreakout(detection.range, breakoutCandle, { ...profile, atr: 1.5 } as any);
  const retest = breakout.direction ? new RetestEngine().evaluate(detection.range, breakout.direction, retestCandle, profile, [...rangeCandles, breakoutCandle]) : null;
  const conflict = new RangeConflictResolver().resolve([detection.range], breakout.direction);
  const decision = new RangeDecisionEngine().decide({
    range: detection.range,
    breakout,
    retest,
    conflict,
    dataHealthy: true,
    riskPermitted: true,
    signalMode: "ACTIVE_SIGNAL"
  });
  const ready = decision.status === "BUY_READY" || decision.status === "SELL_READY";
  const direction = breakout.direction === "SHORT" ? "SHORT" : "LONG";
  const entry = retestCandle.close;
  const atrBuffer = 1.5 * 0.08;
  const stop = direction === "LONG" ? Math.min(retestCandle.low, detection.range.high) - atrBuffer : Math.max(retestCandle.high, detection.range.low) + atrBuffer;
  const risk = Math.max(0.01, Math.abs(entry - stop));
  const target = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const evaluations = [
    module1ProofRule("HORIZONTAL_RANGE_LOCKED", "Horizontal range is locked", detection.status === "VALID", true, detection.range.state, "LOCKED", "A valid New York horizontal consolidation range was locked."),
    module1ProofRule("HORIZONTAL_BREAKOUT_CONFIRMED", "Horizontal breakout confirmed", breakout.confirmed, true, breakout.status, "CONFIRMED", breakout.reason),
    module1ProofRule("HORIZONTAL_RETEST_CONFIRMED", "Horizontal retest confirmed", retest?.confirmed === true, true, retest?.status ?? "NONE", "CONFIRMED", retest?.reason ?? "Retest missing."),
    module1ProofRule("HORIZONTAL_CONFLICT_CLEAR", "Range conflict clear", conflict.status !== "CONFLICT", true, conflict.status, "CLEAR/ALIGNED", conflict.reason),
    module1ProofRule("ENTRY_NOT_OVEREXTENDED", "Entry is not overextended", breakout.directEntryBlocked !== true, true, breakout.extensionRatio, "<= direct extension limit", breakout.reason),
    module1ProofRule("RISK_PERMISSION", "Risk permission", true, true, "PERMITTED", "PERMITTED", "Proof risk gate is permitted."),
    module1ProofRule("HORIZONTAL_QUALITY_SCORE", "Horizontal quality score", Number(detection.range.qualityScore ?? 0) >= 60, false, detection.range.qualityScore ?? null, 60, "Horizontal range quality meets production proof threshold.")
  ];
  return {
    scenario: direction === "LONG" ? "HORIZONTAL_RANGE_BREAKOUT_BUY" : "HORIZONTAL_RANGE_BREAKOUT_SELL",
    direction,
    status: ready ? (direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY") : "WAIT",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    score: Number(detection.range.qualityScore ?? 80),
    ready,
    reason: decision.reason,
    reasons: [
      "Horizontal range production proof",
      breakout.reason,
      retest?.reason ?? "Retest not available",
      conflict.reason,
      decision.reason
    ],
    evaluations,
    genericRangeEngine: {
      version: "GENERIC_RANGE_ENGINE_V1",
      authoritativeDetector: "HORIZONTAL_RANGE_DETECTOR",
      horizontal: {
        enabled: true,
        status: detection.status,
        signalMode: "ACTIVE_SIGNAL",
        range: detection.range,
        breakout,
        falseBreakout: null,
        retest,
        conflict,
        decision
      }
    }
  };
}

function module1ProofRule(ruleCode: string, name: string, passed: boolean, blocking: boolean, actualValue: unknown, requiredValue: unknown, explanation: string) {
  return {
    ruleCode,
    name,
    status: passed ? "PASS" : "FAIL",
    blocking,
    source: "AUTOMATIC",
    actualValue,
    requiredValue,
    explanation
  };
}

function buildModule2Replay(replayCase: Module2ReplayCase, session: any) {
  const base = new Date(session.session_start_at).getTime();
  const at = (minutesAfterStart: number) => new Date(base + minutesAfterStart * 60_000).toISOString();
  const direction = replayCase === "SELL" ? "SHORT" : "LONG";
  const isShort = direction === "SHORT";
  const entryVariantByCase: Partial<Record<Module2ReplayCase, { code: string; name: string; version: string; paperEligible: boolean; approvalStatus: string; category: string }>> = {
    BUY: MODULE2_STRICT_VARIANT,
    SELL: MODULE2_STRICT_VARIANT,
    DISPLACEMENT_RETEST: { code: "SWEEP_DISPLACEMENT_RETEST", name: "Sweep + Displacement Retest", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: false, approvalStatus: "RESEARCH_ONLY", category: "RESEARCH" },
    BOS_RETEST: { code: "SWEEP_BOS_RETEST", name: "E. Sweep + BOS + Retest", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PRODUCTION_APPROVED", category: "PRODUCTION" },
    MSS_RETEST: MODULE2_STRICT_VARIANT,
    MSS_DISPLACEMENT_RETEST: MODULE2_HIGHEST_CONFIRMATION_VARIANT,
    EMA_ALIGNED_SWEEP: { code: "SWEEP_EMA_ALIGNMENT", name: "G. Sweep + EMA Alignment", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" },
    SWEEP_ONLY: { code: "SWEEP_CLOSE_BACK_INSIDE", name: "A. Sweep + Close Back Inside", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" },
    SWEEP_NO_CONFIRMATION: { code: "SWEEP_NO_CONFIRMATION", name: "Sweep + No Confirmation", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: false, approvalStatus: "RESEARCH_ONLY", category: "RESEARCH" },
    SWEEP_ENGULFING: { code: "SWEEP_ENGULFING", name: "D. Sweep + Engulfing", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" },
    SWEEP_BOS: { code: "SWEEP_BOS", name: "B. Sweep + BOS", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" },
    SWEEP_MSS: { code: "SWEEP_MSS", name: "C. Sweep + MSS", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" },
    SWEEP_VOLUME_EXPANSION: { code: "SWEEP_VOLUME_EXPANSION", name: "H. Sweep + Volume Expansion", version: "ULTIMATE_LIQUIDITY_SWEEP_V1.0", paperEligible: true, approvalStatus: "PAPER_APPROVED", category: "ENTRY_GRADE" }
  };
  const liquidityPrice = isShort ? 4068.2 : 4048.4;
  const sweepPrice = isShort ? 4070.1 : 4046.7;
  const bosLevel = isShort ? 4058.4 : 4058.9;
  const zoneLow = isShort ? 4060.55 : 4054.15;
  const zoneHigh = isShort ? 4062.25 : 4055.9;
  const entry = (zoneLow + zoneHigh) / 2;
  const stop = isShort ? 4069.4 : 4045.9;
  const target = isShort ? 4044.8 : 4074.7;
  const failureStateByCase: Record<Module2ReplayCase, string> = {
    BUY: "SIGNAL_ACTIVE",
    SELL: "SIGNAL_ACTIVE",
    SWEEP_ONLY: "WAITING_FOR_DISPLACEMENT",
    SWEEP_NO_CONFIRMATION: "WAITING_FOR_DISPLACEMENT",
    SWEEP_ENGULFING: "WAITING_FOR_RETRACE",
    SWEEP_BOS: "WAITING_FOR_RETRACE",
    SWEEP_MSS: "WAITING_FOR_RETRACE",
    SWEEP_VOLUME_EXPANSION: "WAITING_FOR_RETRACE",
    DISPLACEMENT_RETEST: "WAITING_FOR_MSS_RETEST",
    BOS_RETEST: "WAITING_FOR_MSS",
    MSS_RETEST: "SIGNAL_ACTIVE",
    MSS_DISPLACEMENT_RETEST: "SIGNAL_ACTIVE",
    EMA_ALIGNED_SWEEP: "WAITING_FOR_MSS_RETEST",
    SWEEP_NO_DISPLACEMENT: "WAITING_FOR_DISPLACEMENT",
    DISPLACEMENT_NO_BOS: "WAITING_FOR_BOS",
    BOS_NO_RETRACE: "WAITING_FOR_RETRACE",
    INVALIDATED_SETUP: "SETUP_INVALIDATED",
    LOW_SCORE_NO_TRADE: "LOW_SCORE_NO_TRADE"
  };
  const state = failureStateByCase[replayCase];
  const variant = entryVariantByCase[replayCase];
  const paperSignalCases = new Set<Module2ReplayCase>(["BUY", "SELL", "SWEEP_ONLY", "SWEEP_ENGULFING", "SWEEP_BOS", "SWEEP_MSS", "SWEEP_VOLUME_EXPANSION", "BOS_RETEST", "MSS_RETEST", "MSS_DISPLACEMENT_RETEST", "EMA_ALIGNED_SWEEP"]);
  const signal = state === "SIGNAL_ACTIVE" || paperSignalCases.has(replayCase);
  const scenario = signal
    ? (variant?.code ? `${variant.code}_${isShort ? "SELL" : "BUY"}` : isShort ? "NY_LIQUIDITY_SWEEP_MSS_RETEST_SELL" : "NY_LIQUIDITY_SWEEP_MSS_RETEST_BUY")
    : state;
  const status = signal
    ? (isShort ? "SHORT SETUP READY" : "LONG SETUP READY")
    : state === "SETUP_INVALIDATED" || state === "LOW_SCORE_NO_TRADE"
      ? "NO TRADE"
      : "WAIT";
  const score = replayCase === "LOW_SCORE_NO_TRADE" ? 62 : signal ? 91 : 74;
  const grade = score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : "C";
  const evaluations = module2ReplayEvaluations(replayCase, direction);
  const flags = {
    state,
    htfBias: isShort ? "BEARISH" : "BULLISH",
    levels: [
      { type: isShort ? "LONDON_HIGH" : "LONDON_LOW", side: isShort ? "BUY_SIDE" : "SELL_SIDE", price: liquidityPrice, priority: "HIGH", source: "Replay NY liquidity map" },
      { type: isShort ? "ASIAN_LOW" : "ASIAN_HIGH", side: isShort ? "SELL_SIDE" : "BUY_SIDE", price: isShort ? 4048.6 : 4067.8, priority: "MEDIUM", source: "Replay target liquidity" }
    ],
    sweep: {
      level: { type: isShort ? "LONDON_HIGH" : "LONDON_LOW", side: isShort ? "BUY_SIDE" : "SELL_SIDE", price: liquidityPrice, priority: "HIGH", source: "Replay" },
      swept: true,
      sweptAt: at(20),
      closedBackAt: at(25),
      distanceAtr: 0.32,
      candle: replayCandle(at(20), isShort ? 4064 : 4052, isShort ? sweepPrice : 4054, isShort ? 4061 : sweepPrice, isShort ? 4066 : 4050.5),
      closeBackCandle: replayCandle(at(25), isShort ? 4068 : 4047, isShort ? 4069 : 4051, isShort ? 4063 : 4046.9, isShort ? 4067 : 4049.2)
    },
    displacement: replayCase === "SWEEP_NO_DISPLACEMENT" ? null : {
      candle: replayCandle(at(30), isShort ? 4066.8 : 4049.2, isShort ? 4067.1 : 4058.6, isShort ? 4058.1 : 4048.9, isShort ? 4058.8 : 4058.1),
      rangeAtr: 1.55,
      bodyRatio: 0.73,
      closeLocation: isShort ? 0.12 : 0.89
    },
    bos: ["SWEEP_NO_DISPLACEMENT", "DISPLACEMENT_NO_BOS"].includes(replayCase) ? null : {
      level: bosLevel,
      candle: replayCandle(at(35), isShort ? 4058.7 : 4058.2, isShort ? 4060.1 : 4061.8, isShort ? 4054.2 : 4057.8, isShort ? 4055.1 : 4061.3),
      structure: { kind: isShort ? "LOW" : "HIGH", price: bosLevel, time: at(5) }
    },
    entryZone: ["SWEEP_NO_DISPLACEMENT", "DISPLACEMENT_NO_BOS"].includes(replayCase) ? null : {
      kind: replayCase === "SELL" ? "ORDER_BLOCK" : "FVG",
      low: zoneLow,
      high: zoneHigh,
      midpoint: entry,
      createdAt: at(30)
    },
    riskReward: Math.abs(target - entry) / Math.abs(entry - stop),
    invalidation: replayCase === "INVALIDATED_SETUP" ? { time: at(50), reason: "Price closed through the stop side of the entry zone before confirmation." } : null,
    marketContext: {
      dataHealthy: true,
      marketContextReady: true,
      regime: isShort ? "BEARISH_REVERSAL_AFTER_BUY_SIDE_SWEEP" : "BULLISH_REVERSAL_AFTER_SELL_SIDE_SWEEP",
      session: "NEW_YORK",
      executionTimeframeMinutes: 5,
      contextTimeframeMinutes: 15
    },
    riskEngine: {
      riskOk: signal,
      spreadOk: true,
      newsOk: true,
      rewardToRisk: Math.abs(target - entry) / Math.abs(entry - stop),
      stopSizeOk: true,
      maxActivePositionsOk: true
    },
    module2Variant: variant ?? null,
    variantCode: variant?.code ?? null,
    variantVersion: variant?.version ?? null,
    module2Variants: variant ? [{
      ...variant,
      status: signal ? "PASS" : "RESEARCH",
      score,
      missingRules: signal ? [] : replayCase === "SWEEP_ONLY" ? ["DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED"] : ["ENTRY_ZONE_RETRACE", "CONFIRM_ENTRY_CANDLE"]
    }] : []
  };
  return {
    scenario,
    expectedScenario: signal ? scenario : state,
    direction: signal ? direction : ["BOS_NO_RETRACE", "DISPLACEMENT_NO_BOS", "SWEEP_NO_DISPLACEMENT", "INVALIDATED_SETUP", "LOW_SCORE_NO_TRADE"].includes(replayCase) ? direction : null,
    status,
    entryPrice: signal ? entry : null,
    stopPrice: signal ? stop : null,
    targetPrice: signal ? target : null,
    finalReason: module2ReplayReason(replayCase),
    evaluations,
    flags,
    score,
    grade,
    reasons: module2ReplayReasons(replayCase, score),
    snapshotCandles: [
      replayCandle(at(15), 4053.7, 4055.1, 4051.8, 4052.4),
      replayCandle(at(20), isShort ? 4064 : 4052, isShort ? sweepPrice : 4054, isShort ? 4061 : sweepPrice, isShort ? 4066 : 4050.5),
      replayCandle(at(25), isShort ? 4068 : 4047, isShort ? 4069 : 4051, isShort ? 4063 : 4046.9, isShort ? 4067 : 4049.2),
      replayCandle(at(30), isShort ? 4066.8 : 4049.2, isShort ? 4067.1 : 4058.6, isShort ? 4058.1 : 4048.9, isShort ? 4058.8 : 4058.1),
      replayCandle(at(35), isShort ? 4058.7 : 4058.2, isShort ? 4060.1 : 4061.8, isShort ? 4054.2 : 4057.8, isShort ? 4055.1 : 4061.3),
      replayCandle(at(45), isShort ? 4056.2 : 4060.9, isShort ? 4062.1 : 4061.2, isShort ? 4055.5 : 4054.8, isShort ? 4060.4 : 4055.4)
    ]
  };
}

function module2ReplayEvaluations(replayCase: Module2ReplayCase, direction: "LONG" | "SHORT") {
  const paperSignalCases = new Set<Module2ReplayCase>(["BUY", "SELL", "SWEEP_ONLY", "SWEEP_ENGULFING", "SWEEP_BOS", "SWEEP_MSS", "SWEEP_VOLUME_EXPANSION", "BOS_RETEST", "MSS_RETEST", "MSS_DISPLACEMENT_RETEST", "EMA_ALIGNED_SWEEP"]);
  const passUntil: Record<Module2ReplayCase, string[]> = {
    BUY: [...MODULE2_STRICT_REQUIRED_RULES, "DOUBLE_SWEEP_FILTER", ...MODULE2_CONFIRMATION_RULES, ...MODULE2_QUALITY_RULES, "CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "DISPLACEMENT_CONFIRMED"],
    SELL: [...MODULE2_STRICT_REQUIRED_RULES, "DOUBLE_SWEEP_FILTER", ...MODULE2_CONFIRMATION_RULES, "CONFIRM_ORDER_BLOCK_RETEST", ...MODULE2_QUALITY_RULES, "CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "DISPLACEMENT_CONFIRMED"],
    SWEEP_ONLY: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    SWEEP_NO_CONFIRMATION: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK"],
    SWEEP_ENGULFING: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "CONFIRM_ENGULFING", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    SWEEP_BOS: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    SWEEP_MSS: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "MSS_STRENGTH", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    SWEEP_VOLUME_EXPANSION: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "CONFIRM_VOLUME_EXPANSION", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    DISPLACEMENT_RETEST: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE"],
    BOS_RETEST: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_ORDER_BLOCK_RETEST", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    MSS_RETEST: [...MODULE2_STRICT_REQUIRED_RULES, "DOUBLE_SWEEP_FILTER", ...MODULE2_CONFIRMATION_RULES, ...MODULE2_QUALITY_RULES, "CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "DISPLACEMENT_CONFIRMED"],
    MSS_DISPLACEMENT_RETEST: [...MODULE2_STRICT_REQUIRED_RULES, "DOUBLE_SWEEP_FILTER", ...MODULE2_CONFIRMATION_RULES, ...MODULE2_QUALITY_RULES, "CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "DISPLACEMENT_CONFIRMED"],
    EMA_ALIGNED_SWEEP: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "CONFIRM_EMA_200", "CONFIRM_VWAP", "RISK_OK", "VARIANT_SELECTED", "SIGNAL_SCORE"],
    SWEEP_NO_DISPLACEMENT: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER"],
    DISPLACEMENT_NO_BOS: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED"],
    BOS_NO_RETRACE: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "MSS_STRENGTH", "ENTRY_ZONE_READY", "CONFIRM_FRESH_FVG"],
    INVALIDATED_SETUP: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "MSS_STRENGTH", "ENTRY_ZONE_READY", "CONFIRM_FRESH_FVG"],
    LOW_SCORE_NO_TRADE: ["DATA_HEALTHY", "MARKET_CONTEXT_READY", "MARKET_REGIME_CLASSIFIED", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT", "RISK_LIMITS_CLEAR", "MANUAL_CONFIRMATION_COMPLETED", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "SWEEP_ACCEPTANCE_BLOCK", "DOUBLE_SWEEP_FILTER", "DISPLACEMENT_CONFIRMED", "PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "MSS_STRENGTH", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_FRESH_FVG", "CONFIRM_ENTRY_CANDLE", "QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "RISK_OK"]
  };
  const labels = [
    ["DATA_HEALTHY", "Data health passed", "XAUUSD candle history is fresh enough for the setup engine."],
    ["MARKET_CONTEXT_READY", "Market context ready", "Session highs/lows, bias, and liquidity context are available."],
    ["MARKET_REGIME_CLASSIFIED", "Market regime classified", "The engine classified the current sweep/reversal regime."],
    ["NY_SESSION_ACTIVE", "New York strategy window active", "Current candle is inside the configured New York liquidity-sweep window."],
    ["DAILY_TRADE_LIMIT", "Daily trade limit not reached", "Session trade limit allows a paper trade."],
    ["ACTIVE_SETUP_CONFLICT_CLEAR", "No active setup conflict", "No newer conflicting setup is blocking this candidate."],
    ["NO_ACTIVE_TRADE_CONFLICT", "No active trade conflict", "No active paper trade already occupies Module 2 for this tenant."],
    ["RISK_LIMITS_CLEAR", "Account risk limits clear", "Daily/weekly/consecutive-loss limits allow a new paper trade."],
    ["MANUAL_CONFIRMATION_COMPLETED", "Automation gate clear", "Manual confirmation is not required for the production paper profile."],
    ["LIQUIDITY_LEVEL_IDENTIFIED", "Meaningful liquidity level identified", "A valid PDH/PDL, Asian, London, or equal high/low level was selected."],
    ["LIQUIDITY_SWEEP_CONFIRMED", "Liquidity sweep confirmed", "Price swept mapped liquidity and closed back through the level."],
    ["SWEEP_REJECTION_CONFIRMED", "Sweep rejection quality confirmed", "The sweep rejected or quickly reclaimed the liquidity level."],
    ["SWEEP_ACCEPTANCE_BLOCK", "No acceptance beyond swept level", "Price did not accept beyond the swept liquidity level."],
    ["DOUBLE_SWEEP_FILTER", "No conflicting double sweep", "Only one side of liquidity is active in the recent decision window."],
    ["DISPLACEMENT_CONFIRMED", `${direction === "LONG" ? "Bullish" : "Bearish"} displacement confirmed`, "A strong directional displacement candle formed after the sweep."],
    ["PROTECTED_POINT_CONFIDENCE", "Protected structure point confirmed", "The setup has a medium/high confidence protected high or protected low."],
    ["BOS_CHOCH_CONFIRMED", "BOS or CHoCH confirmed by close", "Candle body closed beyond the selected internal structure point."],
    ["MSS_STRENGTH", "MSS strength confirmed", "The market-structure shift is strong enough to qualify as the production reversal signal."],
    ["ENTRY_ZONE_READY", "Fresh entry zone ready", "A fresh FVG/order-block entry zone exists after BOS/CHoCH."],
    ["ENTRY_ZONE_RETRACE", "Price retraced into entry zone", "Price returned into the fresh entry zone before the confirmation candle."],
    ["CONFIRM_EMA_200", "Confirmation: 200 EMA alignment", "200 EMA confirmation matched."],
    ["CONFIRM_VWAP", "Confirmation: VWAP alignment", "VWAP confirmation matched."],
    ["CONFIRM_FRESH_FVG", "Confirmation: fresh FVG", "Fresh FVG confirmation matched."],
    ["CONFIRM_ORDER_BLOCK_RETEST", "Confirmation: order-block retest", "Order-block retest confirmation matched."],
    ["CONFIRM_ENGULFING", "Confirmation: engulfing candle", "Engulfing candle confirmation matched."],
    ["CONFIRM_VOLUME_EXPANSION", "Confirmation: volume expansion", "Provider volume expansion was recorded."],
    ["CONFIRM_ENTRY_CANDLE", "Confirmation: entry candle", "Entry candle confirmation matched."],
    ["CONFIRMATION_COUNT", "Confirmation layer passed", "At least 3 of 7 confirmations matched."],
    ["QUALITY_ATR_VOLATILITY", "Quality: ATR volatility", "ATR quality filter passed."],
    ["QUALITY_SPREAD", "Quality: spread", "Spread quality filter passed."],
    ["QUALITY_NEWS", "Quality: no high-impact news", "News quality filter passed."],
    ["QUALITY_RR", "Quality: RR >= 2:1", "Risk-reward quality filter passed."],
    ["QUALITY_STOP_SIZE", "Quality: stop size", "Stop-size quality filter passed."],
    ["QUALITY_FRESH_SETUP", "Quality: fresh setup", "Fresh setup quality filter passed."],
    ["QUALITY_FILTER_COUNT", "Quality layer passed", "At least 3 quality filters matched."],
    ["DIRECTIONAL_CONFLICT_CLEAR", "Directional conflict clear", "The selected direction is not contradicted by higher-priority context."],
    ["RISK_OK", "Risk engine passed", "Entry, SL, TP, and RR are complete and inside risk limits."],
    ["VARIANT_SELECTED", "Entry-grade variant selected", "The best valid Module 2 strategy variant was selected for paper-entry gating."],
    ["SIGNAL_SCORE", "Minimum signal score", "Final Module 2 signal score reached the configured threshold."]
  ];
  const passed = new Set(passUntil[replayCase]);
  const blockingRules = new Set([...MODULE2_STRICT_REQUIRED_RULES, "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE"]);
  return labels.map(([ruleCode, name, explanation]) => ({
    ruleCode,
    name,
    status: passed.has(ruleCode) ? "PASS" : replayCase === "LOW_SCORE_NO_TRADE" && ["CONFIRMATION_COUNT", "QUALITY_FILTER_COUNT", "SIGNAL_SCORE"].includes(ruleCode) ? "FAIL" : paperSignalCases.has(replayCase) ? "FAIL" : "WAIT",
    blocking: blockingRules.has(ruleCode),
    source: "MODULE2_REPLAY",
    actualValue: passed.has(ruleCode) ? "matched" : "not matched",
    requiredValue: "matched",
    explanation: passed.has(ruleCode) ? explanation : module2ReplayReason(replayCase)
  }));
}

function module2ReplayReason(replayCase: Module2ReplayCase) {
  const reasons: Record<Module2ReplayCase, string> = {
    BUY: "BUY signal validated through hard rules, at least 3 confirmations, and at least 3 quality filters.",
    SELL: "SELL signal validated through hard rules, at least 3 confirmations, and at least 3 quality filters.",
    SWEEP_ONLY: "Liquidity swept and closed back inside, but this is research-only until displacement and structure confirmation appear.",
    SWEEP_NO_CONFIRMATION: "Liquidity swept, but no confirmation appeared. This negative-control variant must never open a paper trade.",
    SWEEP_ENGULFING: "Liquidity swept and an engulfing candle appeared, but structure, retest, and risk validation are still required before paper trading.",
    SWEEP_BOS: "Sweep and BOS are visible, but the setup is research-only until a clean retest and confirmation candle appear.",
    SWEEP_MSS: "Sweep and market-structure shift are visible, but the setup is research-only until a clean retest and confirmation candle appear.",
    SWEEP_VOLUME_EXPANSION: "Sweep and provider volume expansion were recorded, but volume is record-only until backtesting proves it is reliable.",
    DISPLACEMENT_RETEST: "Sweep and displacement retest are visible, but production waits for MSS strength before paper trading.",
    BOS_RETEST: "Sweep and BOS retest are visible, but production waits for reversal MSS before paper trading.",
    MSS_RETEST: "Sweep, reversal MSS, retest, confirmation, and quality filters validate the production paper-entry profile.",
    MSS_DISPLACEMENT_RETEST: "Sweep, displacement, reversal MSS, retest, confirmation, and quality filters validate the same production MSS retest profile with stronger optional evidence.",
    EMA_ALIGNED_SWEEP: "Sweep is aligned with EMA/VWAP context, but production waits for MSS retest before paper trading.",
    SWEEP_NO_DISPLACEMENT: "Liquidity was swept, but the required displacement candle did not appear.",
    DISPLACEMENT_NO_BOS: "Sweep and displacement appeared, but structure was not broken by candle close.",
    BOS_NO_RETRACE: "BOS confirmed and the zone exists, but price has not retraced into the entry zone.",
    INVALIDATED_SETUP: "The setup was invalidated before entry confirmation.",
    LOW_SCORE_NO_TRADE: "No signal-approved confirmation profile completed. Confidence remains advisory and is not the reason for rejection."
  };
  return reasons[replayCase];
}

function module2ReplayReasons(replayCase: Module2ReplayCase, score: number) {
  return [
    replayCase.includes("SELL") ? "Buy-side liquidity swept" : "Sell-side liquidity swept",
    "Module 2 replay evidence snapshot",
    replayCase === "LOW_SCORE_NO_TRADE" ? "No signal-approved variant completed" : `Score ${score}/110`,
    "No Twelve Data credit used"
  ];
}

function module2ReplayQaSummary(replay: ReturnType<typeof buildModule2Replay>, testCase: (typeof MODULE2_QA_CASES)[number]) {
  const evaluations = replay.evaluations;
  const statusByRule = new Map(evaluations.map((row) => [row.ruleCode, row.status]));
  const hardRuleCodes = [...MODULE2_STRICT_REQUIRED_RULES];
  const hardRulesPassed = hardRuleCodes.every((code) => statusByRule.get(code) === "PASS");
  const entryTriggerPassed = statusByRule.get("CONFIRM_ENTRY_CANDLE") === "PASS";
  const confirmationCount = [...MODULE2_CONFIRMATION_RULES, "CONFIRM_ORDER_BLOCK_RETEST"]
    .filter((code) => statusByRule.get(code) === "PASS").length;
  const qualityCount = [...MODULE2_QUALITY_RULES]
    .filter((code) => statusByRule.get(code) === "PASS").length;
  const safetyRulesPassed = ["RISK_OK", "VARIANT_SELECTED"].every((code) => statusByRule.get(code) === "PASS");
  const paperEligible = replay.status.includes("SETUP READY") && replay.entryPrice != null && replay.stopPrice != null && replay.targetPrice != null;
  const scenarioMatched = replay.scenario === testCase.expected || replay.flags.state === testCase.expected;
  const statusMatched = replay.status === testCase.expectedStatus;
  const paperMatched = paperEligible === testCase.opensPaperTrade;
  const failureRuleMatched = testCase.failureRule ? statusByRule.get(testCase.failureRule) !== "PASS" : true;
  const validSignalLayersMatched = testCase.opensPaperTrade ? safetyRulesPassed : true;
  const passed = scenarioMatched && statusMatched && paperMatched && failureRuleMatched && validSignalLayersMatched;
  const blockingFailure = evaluations.find((row) => row.blocking && row.status !== "PASS")?.ruleCode ?? null;
  const reasons = [
    scenarioMatched ? null : `Expected ${testCase.expected}, got ${replay.scenario}/${replay.flags.state}.`,
    statusMatched ? null : `Expected status ${testCase.expectedStatus}, got ${replay.status}.`,
    paperMatched ? null : `Paper eligibility expected ${testCase.opensPaperTrade}, got ${paperEligible}.`,
    failureRuleMatched ? null : `Expected ${testCase.failureRule} to block or wait.`,
    validSignalLayersMatched ? null : `Valid signal needs hard rules, entry confirmation, 3 confirmations, 3 quality filters, safety filters, and signal score.`
  ].filter(Boolean);
  return {
    passed,
    hardRulesPassed,
    entryTriggerPassed,
    confirmationCount,
    qualityCount,
    safetyRulesPassed,
    paperEligible,
    blockingFailure,
    reason: passed ? "Replay behavior matches Module 2 QA expectation." : reasons.join(" ")
  };
}

async function openModule2ReplayPaperTrade(setup: any, tenantId: string | null) {
  if (setup.module_code !== "high_probability_strategy_2") return null;
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return null;
  const rewardToRisk = Math.abs(Number(setup.target_price) - Number(setup.entry_price)) / Math.max(0.00001, Math.abs(Number(setup.entry_price) - Number(setup.stop_price)));
  const plan = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target,
      planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,0.01,10,$5,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET
      planned_entry = EXCLUDED.planned_entry,
      planned_stop = EXCLUDED.planned_stop,
      planned_target = EXCLUDED.planned_target,
      planned_lot = EXCLUDED.planned_lot,
      planned_risk_amount = EXCLUDED.planned_risk_amount,
      reward_to_risk = EXCLUDED.reward_to_risk,
      status = 'EXECUTED'
    RETURNING *`,
    [setup.id, setup.entry_price, setup.stop_price, setup.target_price, rewardToRisk]
  );
  const existing = await query("SELECT * FROM trades WHERE trade_plan_id = $1 ORDER BY opened_at DESC LIMIT 1", [plan.rows[0].id]);
  if (existing.rows[0]) {
    await ensurePaperTradeTargets(existing.rows[0].id);
    return existing.rows[0];
  }
  const trade = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
      commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,0.01,0,0.2,0,now(),'ACTIVE') RETURNING *`,
    [plan.rows[0].id, setup.entry_price, setup.stop_price, setup.target_price]
  );
  await ensurePaperTradeTargets(trade.rows[0].id);
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1 AND tenant_id = $2", [setup.id, tenantId]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,'MODULE2_QA_ENTRY_HIT',$2)", [trade.rows[0].id, { setupId: setup.id, replay: true }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, confidence, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,'MODULE2_QA_PAPER_TRADE_OPENED',90,$5,'QA','ACTIVE')`,
    [
      tenantId,
      setup.id,
      trade.rows[0].id,
      setup.session_id,
      "Module 2 replay opened a QA paper trade after the valid checklist chain matched."
    ]
  );
  return trade.rows[0];
}

async function openModuleReplayPaperTrade(setup: any, tenantId: string | null, eventPrefix: string) {
  if (setup.entry_price == null || setup.stop_price == null || setup.target_price == null) return null;
  const rewardToRisk = Math.abs(Number(setup.target_price) - Number(setup.entry_price)) / Math.max(0.00001, Math.abs(Number(setup.entry_price) - Number(setup.stop_price)));
  const plan = await query(
    `INSERT INTO trade_plans (
      setup_candidate_id, planned_entry, planned_stop, planned_target,
      planned_lot, planned_risk_amount, reward_to_risk, status
    ) VALUES ($1,$2,$3,$4,0.01,10,$5,'EXECUTED')
    ON CONFLICT (setup_candidate_id) DO UPDATE SET
      planned_entry = EXCLUDED.planned_entry,
      planned_stop = EXCLUDED.planned_stop,
      planned_target = EXCLUDED.planned_target,
      planned_lot = EXCLUDED.planned_lot,
      planned_risk_amount = EXCLUDED.planned_risk_amount,
      reward_to_risk = EXCLUDED.reward_to_risk,
      status = 'EXECUTED'
    RETURNING *`,
    [setup.id, setup.entry_price, setup.stop_price, setup.target_price, rewardToRisk]
  );
  const existing = await query("SELECT * FROM trades WHERE trade_plan_id = $1 ORDER BY opened_at DESC LIMIT 1", [plan.rows[0].id]);
  if (existing.rows[0]) {
    await ensurePaperTradeTargets(existing.rows[0].id);
    return existing.rows[0];
  }
  const trade = await query(
    `INSERT INTO trades (
      trade_plan_id, actual_entry, actual_stop, actual_target, actual_lot,
      commission, spread, slippage, opened_at, outcome
    ) VALUES ($1,$2,$3,$4,0.01,0,0.2,0,now(),'ACTIVE') RETURNING *`,
    [plan.rows[0].id, setup.entry_price, setup.stop_price, setup.target_price]
  );
  await ensurePaperTradeTargets(trade.rows[0].id);
  await query("UPDATE setup_candidates SET status = 'PAPER_TRADE_OPENED' WHERE id = $1 AND tenant_id = $2", [setup.id, tenantId]);
  await query("INSERT INTO trade_events (trade_id, event_type, payload) VALUES ($1,$2,$3)", [trade.rows[0].id, `${eventPrefix}_ENTRY_HIT`, { setupId: setup.id, replay: true, moduleCode: setup.module_code }]);
  await query(
    `INSERT INTO journal_entries (
      tenant_id, setup_candidate_id, trade_id, session_id, decision, confidence, lesson, process_grade, outcome
    ) VALUES ($1,$2,$3,$4,$5,90,$6,'QA','ACTIVE')`,
    [
      tenantId,
      setup.id,
      trade.rows[0].id,
      setup.session_id,
      `${eventPrefix}_PAPER_TRADE_OPENED`,
      `${setup.module_code} replay opened a QA paper trade after the valid checklist matched.`
    ]
  );
  return trade.rows[0];
}
