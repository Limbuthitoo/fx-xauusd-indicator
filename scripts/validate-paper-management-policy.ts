import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import {
  PAPER_MANAGEMENT_POLICY_V1,
  PAPER_MANAGEMENT_POLICY_V2,
  PAPER_MANAGEMENT_POLICY_PRODUCTION,
  PAPER_TP1_PROTECTION_BUFFER_R
} from "../apps/api/src/modules/trades/paper-target-plan.js";

type Direction = "LONG" | "SHORT";
type Candle = { timestamp: string; high: number; low: number; close: number };
type ReplayTarget = { number: number; price: number; riskMultiple: number; fraction: number };
type ReplayTrade = {
  id: string;
  scenario: string;
  direction: Direction;
  openedAt: string;
  entry: number;
  structuralStop: number;
  signalWindowEndAt: string;
  targets: ReplayTarget[];
  candles: Candle[];
};
type PolicyResult = {
  policy: string;
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  closeReason: string;
  resultR: number;
  tp1: boolean;
  tp2: boolean;
  tp3: boolean;
  ambiguous: boolean;
  closedAt: string;
};
type ResearchPolicy = {
  code: string;
  label: string;
  mode: "TP1_BREAKEVEN" | "TP1_BUFFER" | "TP1_PROFIT_LOCK" | "TP2_BREAKEVEN" | "TP1_CLOSE_CONFIRMED" | "STRUCTURE_TRAIL";
  stopR?: number;
};

const RESEARCH_POLICIES: ResearchPolicy[] = [
  { code: PAPER_MANAGEMENT_POLICY_V1, label: "TP1 exact breakeven (production)", mode: "TP1_BREAKEVEN" },
  { code: PAPER_MANAGEMENT_POLICY_V2, label: "TP1 -0.25R buffer / TP2 breakeven", mode: "TP1_BUFFER", stopR: -PAPER_TP1_PROTECTION_BUFFER_R },
  { code: "TP1_PROFIT_LOCK_0_10R_RESEARCH", label: "TP1 +0.10R profit lock", mode: "TP1_PROFIT_LOCK", stopR: 0.1 },
  { code: "TP2_BREAKEVEN_RESEARCH", label: "Structural stop until TP2", mode: "TP2_BREAKEVEN" },
  { code: "TP1_CLOSE_CONFIRMED_BREAKEVEN_RESEARCH", label: "Breakeven after a close beyond TP1", mode: "TP1_CLOSE_CONFIRMED" },
  { code: "TWO_CANDLE_STRUCTURE_TRAIL_RESEARCH", label: "Two-candle structure trail", mode: "STRUCTURE_TRAIL" }
];

loadEnv(cliValue("--env") ?? ".env.production");
const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "compare";
if (!["compare", "diagnose", "self-test"].includes(command)) usage();
runSyntheticAssertions();
if (command === "self-test") {
  console.log(JSON.stringify({ status: "PASS", mode: "SYNTHETIC_POLICY_CHECKS" }, null, 2));
  process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? localDatabaseUrl() });
try {
  await client.connect();
  if (command === "diagnose") await diagnoseSetup();
  else await comparePolicies();
} finally {
  await client.end().catch(() => undefined);
}

async function comparePolicies() {
  const days = positiveInteger(cliValue("--days") ?? "90", "--days");
  const limit = positiveInteger(cliValue("--limit") ?? "500", "--limit");
  const minimumSample = positiveInteger(cliValue("--minimum-sample") ?? "5", "--minimum-sample");
  const enforceGate = process.argv.includes("--gate");
  const migrations = (await client.query(
    `SELECT filename, applied_at FROM schema_migrations
     WHERE filename IN ('101_professional_paper_runner_management.sql','102_retain_tp1_breakeven_production.sql')`
  )).rows;
  const migration101 = migrations.find((row) => row.filename === "101_professional_paper_runner_management.sql") ?? null;
  const migration102 = migrations.find((row) => row.filename === "102_retain_tp1_breakeven_production.sql") ?? null;

  const rows = await client.query(
    `SELECT t.id, sc.scenario, sc.direction, sc.symbol, t.opened_at,
            t.actual_entry::float AS entry,
            COALESCE(t.structural_stop, tp.planned_stop, t.actual_stop)::float AS structural_stop,
            ts.signal_window_end_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'number', ptt.target_number,
                  'price', ptt.price::float,
                  'riskMultiple', ptt.risk_multiple::float,
                  'fraction', ptt.position_fraction::float
                ) ORDER BY ptt.target_number
              ) FILTER (WHERE ptt.id IS NOT NULL),
              '[]'::jsonb
            ) AS targets
     FROM trades t
     JOIN trade_plans tp ON tp.id=t.trade_plan_id
     JOIN setup_candidates sc ON sc.id=tp.setup_candidate_id
     JOIN trading_sessions ts ON ts.id=sc.session_id
     LEFT JOIN paper_trade_targets ptt ON ptt.trade_id=t.id
     WHERE sc.module_code='orb_max_options'
       AND COALESCE(sc.scenario_flags->>'replay','false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'rehearsal','false') <> 'true'
       AND t.opened_at >= now() - ($1::int * interval '1 day')
       AND ts.signal_window_end_at <= now()
       AND t.actual_entry IS NOT NULL
       AND COALESCE(t.structural_stop, tp.planned_stop, t.actual_stop) IS NOT NULL
     GROUP BY t.id, sc.scenario, sc.direction, sc.symbol, t.opened_at,
              t.actual_entry, t.structural_stop, tp.planned_stop, t.actual_stop,
              ts.signal_window_end_at
     ORDER BY t.opened_at DESC
     LIMIT $2`,
    [days, limit]
  );

  const independentRows: any[] = [];
  const independentKeys = new Set<string>();
  let invalidGeometryExcluded = 0;
  let duplicateSubscriberTradesExcluded = 0;
  for (const row of rows.rows) {
    const targets = normalizeTargets(row.targets, Number(row.entry), Number(row.structural_stop), String(row.direction));
    if (targets.length !== 3 || targets.some((target) => ![target.number, target.price, target.riskMultiple, target.fraction].every(Number.isFinite))) {
      invalidGeometryExcluded += 1;
      continue;
    }
    const independentKey = independentSignalKey(row, targets);
    if (independentKeys.has(independentKey)) {
      duplicateSubscriberTradesExcluded += 1;
      continue;
    }
    independentKeys.add(independentKey);
    independentRows.push({ ...row, normalizedTargets: targets });
  }

  const replays: Array<{ trade: ReplayTrade; results: Record<string, PolicyResult> }> = [];
  for (const row of independentRows) {
    const targets = row.normalizedTargets as ReplayTarget[];
    const candles = await client.query(
      `SELECT timestamp_utc, high::float, low::float, close::float
       FROM candles
       WHERE symbol=$1 AND timeframe_minutes=5
         AND timestamp_utc > $2 AND timestamp_utc <= $3
       ORDER BY timestamp_utc`,
      [row.symbol, row.opened_at, row.signal_window_end_at]
    );
    if (!candles.rowCount) continue;
    const trade: ReplayTrade = {
      id: row.id,
      scenario: row.scenario,
      direction: normalizeDirection(row.direction),
      openedAt: new Date(row.opened_at).toISOString(),
      entry: Number(row.entry),
      structuralStop: Number(row.structural_stop),
      signalWindowEndAt: new Date(row.signal_window_end_at).toISOString(),
      targets,
      candles: candles.rows.map((candle) => ({
        timestamp: new Date(candle.timestamp_utc).toISOString(),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      }))
    };
    replays.push({
      trade,
      results: Object.fromEntries(RESEARCH_POLICIES.map((policy) => [policy.code, replayResearchPolicy(trade, policy)]))
    });
  }
  replays.sort((left, right) => left.trade.openedAt.localeCompare(right.trade.openedAt));
  const comparisons = replays.map((row) => ({
    trade: row.trade,
    v1: row.results[PAPER_MANAGEMENT_POLICY_V1],
    v2: row.results[PAPER_MANAGEMENT_POLICY_V2]
  }));

  const v1 = summarize(comparisons.map((row) => row.v1));
  const v2 = summarize(comparisons.map((row) => row.v2));
  const changed = comparisons.filter((row) => row.v1.resultR !== row.v2.resultR || row.v1.closeReason !== row.v2.closeReason);
  const deltaTotalR = fixed(v2.totalR - v1.totalR);
  const deltaAverageR = fixed(v2.averageR - v1.averageR);
  const deltaDrawdownR = fixed(v2.maxDrawdownR - v1.maxDrawdownR);
  const promotionEligible = comparisons.length >= minimumSample;
  const promotionPassed = promotionEligible && deltaTotalR >= 0 && deltaAverageR >= 0 && deltaDrawdownR <= 0.5;
  const productionBaselineRetained = PAPER_MANAGEMENT_POLICY_PRODUCTION === PAPER_MANAGEMENT_POLICY_V1;
  const matrix = RESEARCH_POLICIES.map((policy) => {
    const metrics = summarize(replays.map((row) => row.results[policy.code]));
    return {
      code: policy.code,
      label: policy.label,
      production: policy.code === PAPER_MANAGEMENT_POLICY_PRODUCTION,
      observationOnly: policy.code !== PAPER_MANAGEMENT_POLICY_PRODUCTION,
      ...metrics,
      deltaVsProductionR: fixed(metrics.totalR - v1.totalR),
      deltaVsProductionDrawdownR: fixed(metrics.maxDrawdownR - v1.maxDrawdownR)
    };
  });
  const output = {
    status: enforceGate ? (productionBaselineRetained ? "PASS" : "FAIL") : comparisons.length ? "PASS" : "WARN",
    mode: "READ_ONLY_COUNTERFACTUAL",
    syntheticChecks: "PASS",
    productionPolicy: PAPER_MANAGEMENT_POLICY_PRODUCTION,
    migration101AppliedAt: migration101?.applied_at ?? null,
    migration102AppliedAt: migration102?.applied_at ?? null,
    promotionGate: {
      enforced: enforceGate,
      status: productionBaselineRetained ? "BASELINE_V1_RETAINED" : "FAIL",
      minimumSample,
      candidateV2Status: !promotionEligible ? "INSUFFICIENT_SAMPLE" : promotionPassed ? "PASS" : "REJECTED",
      requirements: "The selected production policy must remain V1. Every alternative stays observation-only until an independent-signal candidate gate passes."
    },
    assumptions: {
      execution: "5-minute OHLC; stop-first when a candle touches the active stop and a pending target",
      targetFractions: "persisted fractions, falling back to equal thirds",
      horizon: "New York signal window end; remaining size settles at the last candle close",
      v1: "TP1 moves the remaining runner to exact entry",
      v2: `TP1 moves the runner to -${PAPER_TP1_PROTECTION_BUFFER_R}R; TP2 moves it to exact entry`
    },
    sample: {
      requestedDays: days,
      queriedSubscriberTrades: rows.rowCount,
      independentTradeCandidates: independentRows.length,
      replayedIndependentTrades: comparisons.length,
      duplicateSubscriberTradesExcluded,
      invalidGeometryExcluded
    },
    v1,
    v2,
    policyMatrix: matrix,
    delta: {
      totalR: deltaTotalR,
      averageR: deltaAverageR,
      maxDrawdownR: deltaDrawdownR,
      tp3Conversions: v2.tp3 - v1.tp3,
      changedTrades: changed.length,
      improvedTrades: changed.filter((row) => row.v2.resultR > row.v1.resultR).length,
      worsenedTrades: changed.filter((row) => row.v2.resultR < row.v1.resultR).length
    },
    changedTrades: changed.slice(0, 50).map((row) => ({
      tradeId: row.trade.id,
      openedAt: row.trade.openedAt,
      scenario: row.trade.scenario,
      direction: row.trade.direction,
      v1: { resultR: row.v1.resultR, closeReason: row.v1.closeReason },
      v2: { resultR: row.v2.resultR, closeReason: row.v2.closeReason }
    }))
  };
  console.log(JSON.stringify(output, null, 2));
  if (enforceGate && !productionBaselineRetained) process.exitCode = 1;
}

async function diagnoseSetup() {
  const setupId = cliValue("--setup-id");
  const date = cliValue("--date");
  const direction = cliValue("--direction")?.toUpperCase();
  if (!setupId && !date) throw new Error("diagnose requires --setup-id UUID or --date YYYY-MM-DD.");
  if (direction && !["LONG", "SHORT"].includes(direction)) throw new Error("--direction must be LONG or SHORT.");

  const result = await client.query(
    `SELECT sc.id, sc.detected_at, sc.module_code, sc.symbol, sc.scenario, sc.direction,
            sc.status, sc.final_reason, sc.entry_price::float, sc.stop_price::float,
            sc.target_price::float, sc.favorability_score, sc.favorability_grade,
            sc.favorability_reasons, sc.scenario_flags,
            ts.session_date::text AS session_date, ts.session_start_at, ts.opening_range_end_at,
            ts.signal_window_end_at, ts.data_status,
            orng.status AS range_status, orng.high::float AS range_high,
            orng.low::float AS range_low, orng.midpoint::float AS range_midpoint,
            orng.width::float AS range_width, orng.source_candle_count,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'ruleCode', sre.rule_code,
                  'name', sre.name,
                  'status', sre.status,
                  'blocking', sre.blocking,
                  'actual', sre.actual_value,
                  'required', sre.required_value,
                  'explanation', sre.explanation
                ) ORDER BY sre.blocking DESC, sre.status, sre.rule_code
              ) FILTER (WHERE sre.id IS NOT NULL),
              '[]'::jsonb
            ) AS rules
     FROM setup_candidates sc
     JOIN trading_sessions ts ON ts.id=sc.session_id
     LEFT JOIN opening_ranges orng ON orng.session_id=ts.id
     LEFT JOIN setup_rule_evaluations sre ON sre.setup_candidate_id=sc.id
     WHERE sc.module_code='orb_max_options'
       AND ($1::uuid IS NULL OR sc.id=$1)
       AND ($2::date IS NULL OR ts.session_date=$2)
       AND ($3::text IS NULL OR sc.direction=$3)
       AND COALESCE(sc.scenario_flags->>'replay','false') <> 'true'
     GROUP BY sc.id, ts.id, orng.id
     ORDER BY sc.detected_at DESC
     LIMIT 10`,
    [setupId ?? null, date ?? null, direction ?? null]
  );
  console.log(JSON.stringify({
    status: result.rowCount ? "PASS" : "WARN",
    mode: "READ_ONLY_SETUP_DIAGNOSTIC",
    filters: { setupId: setupId ?? null, date: date ?? null, direction: direction ?? null },
    setups: result.rows.map((row) => ({
      ...row,
      detected_at: new Date(row.detected_at).toISOString(),
      failedBlockingRules: (row.rules as any[]).filter((rule) => rule.blocking && rule.status !== "PASS"),
      scoreGapTo80: row.favorability_score == null ? null : Math.max(0, 80 - Number(row.favorability_score)),
      entryExtensionPercentOfRange: entryExtensionPercent(row)
    }))
  }, null, 2));
}

export function replayPolicy(trade: ReplayTrade, policy: string): PolicyResult {
  const definition = RESEARCH_POLICIES.find((candidate) => candidate.code === policy);
  if (!definition) throw new Error(`Unknown paper-management replay policy: ${policy}`);
  return replayResearchPolicy(trade, definition);
}

function replayResearchPolicy(trade: ReplayTrade, policy: ResearchPolicy): PolicyResult {
  const multiplier = trade.direction === "SHORT" ? -1 : 1;
  const risk = Math.abs(trade.entry - trade.structuralStop);
  if (!Number.isFinite(risk) || risk <= 0) throw new Error(`Trade ${trade.id} has invalid risk geometry.`);
  let stop = trade.structuralStop;
  let lockedR = 0;
  let hitFraction = 0;
  const hit = new Set<number>();
  let ambiguous = false;
  let closeConfirmed = false;
  const completedCandles: Candle[] = [];

  for (const candle of trade.candles) {
    const stopHit = trade.direction === "SHORT" ? candle.high >= stop : candle.low <= stop;
    const pendingHits = trade.targets.filter((target) => !hit.has(target.number) && (
      trade.direction === "SHORT" ? candle.low <= target.price : candle.high >= target.price
    ));
    if (stopHit && pendingHits.length) ambiguous = true;
    if (stopHit) {
      const runnerR = ((stop - trade.entry) * multiplier) / risk;
      const resultR = lockedR + Math.max(0, 1 - hitFraction) * runnerR;
      return settle(policy.code, resultR, stopReason(policy, hit), hit, ambiguous, candle.timestamp);
    }
    for (const target of pendingHits.sort((left, right) => left.number - right.number)) {
      hit.add(target.number);
      lockedR += target.riskMultiple * target.fraction;
      hitFraction += target.fraction;
    }
    if (hit.has(3)) return settle(policy.code, lockedR, "TP3", hit, ambiguous, candle.timestamp);
    completedCandles.push(candle);
    if (hit.has(1) && beyondTargetClose(trade.direction, candle.close, trade.targets[0].price)) closeConfirmed = true;
    stop = researchManagedStop({ trade, policy, hit, currentStop: stop, risk, multiplier, closeConfirmed, completedCandles });
  }

  const finalCandle = trade.candles.at(-1)!;
  const runnerR = ((finalCandle.close - trade.entry) * multiplier) / risk;
  const resultR = lockedR + Math.max(0, 1 - hitFraction) * runnerR;
  return settle(policy.code, resultR, "SESSION_CLOSE", hit, ambiguous, finalCandle.timestamp);
}

function researchManagedStop(input: {
  trade: ReplayTrade;
  policy: ResearchPolicy;
  hit: Set<number>;
  currentStop: number;
  risk: number;
  multiplier: number;
  closeConfirmed: boolean;
  completedCandles: Candle[];
}) {
  const { trade, policy, hit, risk, multiplier } = input;
  let desired = trade.structuralStop;
  if (policy.mode === "TP1_BREAKEVEN" && hit.has(1)) desired = trade.entry;
  if ((policy.mode === "TP1_BUFFER" || policy.mode === "TP1_PROFIT_LOCK") && hit.has(1)) {
    desired = trade.entry + multiplier * risk * Number(policy.stopR ?? 0);
  }
  if (policy.mode === "TP2_BREAKEVEN" && hit.has(2)) desired = trade.entry;
  if (policy.mode === "TP1_CLOSE_CONFIRMED" && input.closeConfirmed) desired = trade.entry;
  if (policy.mode === "STRUCTURE_TRAIL" && hit.has(1)) {
    const recent = input.completedCandles.slice(-2);
    const structure = trade.direction === "LONG"
      ? Math.min(...recent.map((candle) => candle.low), trade.entry)
      : Math.max(...recent.map((candle) => candle.high), trade.entry);
    desired = hit.has(2)
      ? structure
      : trade.direction === "LONG" ? Math.min(structure, trade.entry) : Math.max(structure, trade.entry);
  }
  if (policy.mode === "TP1_BUFFER" && hit.has(2)) desired = trade.entry;
  return trade.direction === "SHORT"
    ? Math.min(input.currentStop, desired)
    : Math.max(input.currentStop, desired);
}

function beyondTargetClose(direction: Direction, close: number, target: number) {
  return direction === "SHORT" ? close <= target : close >= target;
}

function runSyntheticAssertions() {
  const base = syntheticTrade([
    candle("2026-09-02T14:35:00.000Z", 111, 101, 108),
    candle("2026-09-02T14:40:00.000Z", 121, 100, 120)
  ]);
  const baseV1 = replayPolicy(base, PAPER_MANAGEMENT_POLICY_V1);
  const baseV2 = replayPolicy(base, PAPER_MANAGEMENT_POLICY_V2);
  assert(baseV1.closeReason.endsWith(":POST_TP1_STOP") && baseV1.resultR === 0.3333, "V1 TP1 breakeven path");
  assert(baseV2.closeReason === "TP3" && baseV2.resultR === 1.5, "V2 recovered runner path");

  const buffered = replayPolicy(syntheticTrade([
    candle("2026-09-02T14:35:00.000Z", 111, 101, 108),
    candle("2026-09-02T14:40:00.000Z", 108, 96, 98)
  ]), PAPER_MANAGEMENT_POLICY_V2);
  assert(buffered.closeReason.endsWith(":POST_TP1_STOP") && buffered.resultR === 0.1667, "V2 TP1 buffered-stop floor");

  const tp2Breakeven = replayPolicy(syntheticTrade([
    candle("2026-09-02T14:35:00.000Z", 116, 101, 114),
    candle("2026-09-02T14:40:00.000Z", 114, 99, 101)
  ]), PAPER_MANAGEMENT_POLICY_V2);
  assert(tp2Breakeven.closeReason.endsWith(":POST_TP2_STOP") && tp2Breakeven.resultR === 0.8333, "V2 TP2 breakeven floor");

  const ambiguous = replayPolicy(syntheticTrade([
    candle("2026-09-02T14:35:00.000Z", 111, 89, 100)
  ]), PAPER_MANAGEMENT_POLICY_V2);
  assert(ambiguous.closeReason === "STRUCTURAL_STOP" && ambiguous.resultR === -1 && ambiguous.ambiguous, "stop-first same-candle ambiguity");

  const shortRunner = replayPolicy({
    ...syntheticTrade([
      candle("2026-09-02T14:35:00.000Z", 99, 89, 92),
      candle("2026-09-02T14:40:00.000Z", 100, 79, 80)
    ]),
    direction: "SHORT",
    structuralStop: 110,
    targets: [
      { number: 1, price: 90, riskMultiple: 1, fraction: 0.333333 },
      { number: 2, price: 85, riskMultiple: 1.5, fraction: 0.333333 },
      { number: 3, price: 80, riskMultiple: 2, fraction: 0.333334 }
    ]
  }, PAPER_MANAGEMENT_POLICY_V2);
  assert(shortRunner.closeReason === "TP3" && shortRunner.resultR === 1.5, "V2 short runner path");

  const profitLock = replayPolicy(syntheticTrade([
    candle("2026-09-02T14:35:00.000Z", 111, 101, 108),
    candle("2026-09-02T14:40:00.000Z", 108, 96, 98)
  ]), "TP1_PROFIT_LOCK_0_10R_RESEARCH");
  assert(profitLock.resultR === 0.4, "TP1 profit-lock research path");

  const delayedBreakeven = replayPolicy(base, "TP2_BREAKEVEN_RESEARCH");
  assert(delayedBreakeven.closeReason === "TP3" && delayedBreakeven.resultR === 1.5, "TP2-delayed breakeven research path");

  const closeConfirmed = replayPolicy(base, "TP1_CLOSE_CONFIRMED_BREAKEVEN_RESEARCH");
  assert(closeConfirmed.closeReason === "TP3" && closeConfirmed.resultR === 1.5, "close-confirmed breakeven research path");

  const duplicateShape = {
    symbol: "XAUUSD",
    scenario: "CLEAN_BREAKOUT_CONTINUATION",
    direction: "LONG",
    opened_at: "2026-09-02T14:31:03.000Z",
    entry: 100,
    structural_stop: 90
  };
  const duplicateTargets = syntheticTrade([]).targets;
  const firstKey = independentSignalKey(duplicateShape, duplicateTargets);
  const subscriberCopyKey = independentSignalKey({ ...duplicateShape, opened_at: "2026-09-02T14:34:58.000Z" }, duplicateTargets);
  const nextCandleKey = independentSignalKey({ ...duplicateShape, opened_at: "2026-09-02T14:35:00.000Z" }, duplicateTargets);
  assert(firstKey === subscriberCopyKey, "subscriber copies inside one signal candle deduplicate");
  assert(firstKey !== nextCandleKey, "signals from different five-minute candles remain independent");
}

function syntheticTrade(candles: Candle[]): ReplayTrade {
  return {
    id: "synthetic",
    scenario: "ORB_BREAKOUT",
    direction: "LONG",
    openedAt: "2026-09-02T14:30:00.000Z",
    entry: 100,
    structuralStop: 90,
    signalWindowEndAt: "2026-09-02T20:00:00.000Z",
    targets: [
      { number: 1, price: 110, riskMultiple: 1, fraction: 0.333333 },
      { number: 2, price: 115, riskMultiple: 1.5, fraction: 0.333333 },
      { number: 3, price: 120, riskMultiple: 2, fraction: 0.333334 }
    ],
    candles
  };
}

function candle(timestamp: string, high: number, low: number, close: number): Candle { return { timestamp, high, low, close }; }
function assert(condition: boolean, label: string) { if (!condition) throw new Error(`Synthetic paper-management check failed: ${label}.`); }

function settle(policy: string, resultR: number, closeReason: PolicyResult["closeReason"], hit: Set<number>, ambiguous: boolean, closedAt: string): PolicyResult {
  return {
    policy,
    outcome: resultR > 0.00005 ? "WIN" : resultR < -0.00005 ? "LOSS" : "BREAKEVEN",
    closeReason,
    resultR: fixed(resultR),
    tp1: hit.has(1),
    tp2: hit.has(2),
    tp3: hit.has(3),
    ambiguous,
    closedAt
  };
}

function stopReason(policy: ResearchPolicy, hit: Set<number>): PolicyResult["closeReason"] {
  if (hit.has(2)) return `${policy.code}:POST_TP2_STOP`;
  if (hit.has(1)) return `${policy.code}:POST_TP1_STOP`;
  return "STRUCTURAL_STOP";
}

function summarize(rows: PolicyResult[]) {
  const results = rows.map((row) => row.resultR);
  return {
    trades: rows.length,
    wins: rows.filter((row) => row.outcome === "WIN").length,
    losses: rows.filter((row) => row.outcome === "LOSS").length,
    breakeven: rows.filter((row) => row.outcome === "BREAKEVEN").length,
    totalR: fixed(results.reduce((sum, value) => sum + value, 0)),
    averageR: fixed(results.length ? results.reduce((sum, value) => sum + value, 0) / results.length : 0),
    maxDrawdownR: fixed(maxDrawdown(results)),
    tp1: rows.filter((row) => row.tp1).length,
    tp2: rows.filter((row) => row.tp2).length,
    tp3: rows.filter((row) => row.tp3).length,
    protectedStops: rows.filter((row) => row.closeReason.includes(":POST_TP")).length,
    ambiguousCandles: rows.filter((row) => row.ambiguous).length
  };
}

function normalizeTargets(value: unknown, entry: number, stop: number, direction: string): ReplayTarget[] {
  const parsed = Array.isArray(value) ? value : typeof value === "string" ? JSON.parse(value) : [];
  if (parsed.length === 3) return parsed.map((target: any) => ({
    number: Number(target.number),
    price: Number(target.price),
    riskMultiple: Number(target.riskMultiple),
    fraction: Number(target.fraction)
  }));
  const risk = Math.abs(entry - stop);
  const multiplier = normalizeDirection(direction) === "SHORT" ? -1 : 1;
  return [1, 1.5, 2].map((riskMultiple, index) => ({
    number: index + 1,
    price: entry + multiplier * risk * riskMultiple,
    riskMultiple,
    fraction: index === 2 ? 0.333334 : 0.333333
  }));
}

function independentSignalKey(row: any, targets: ReplayTarget[]) {
  const openedAt = new Date(row.opened_at).getTime();
  if (!Number.isFinite(openedAt)) throw new Error(`Trade ${String(row.id ?? "unknown")} has an invalid opened_at timestamp.`);
  const signalCandleAt = new Date(Math.floor(openedAt / 300_000) * 300_000).toISOString();
  return [
    row.symbol,
    row.scenario,
    normalizeDirection(row.direction),
    signalCandleAt,
    Number(row.entry).toFixed(5),
    Number(row.structural_stop).toFixed(5),
    ...targets.map((target) => target.price.toFixed(5))
  ].join(":");
}

function entryExtensionPercent(row: any) {
  const entry = Number(row.entry_price);
  const width = Number(row.range_width);
  if (!Number.isFinite(entry) || !Number.isFinite(width) || width <= 0) return null;
  if (row.direction === "LONG" && Number.isFinite(Number(row.range_high))) return fixed(Math.max(0, entry - Number(row.range_high)) / width * 100, 2);
  if (row.direction === "SHORT" && Number.isFinite(Number(row.range_low))) return fixed(Math.max(0, Number(row.range_low) - entry) / width * 100, 2);
  return null;
}

function normalizeDirection(value: unknown): Direction {
  const normalized = String(value).toUpperCase();
  if (normalized === "LONG" || normalized === "BUY") return "LONG";
  if (normalized === "SHORT" || normalized === "SELL") return "SHORT";
  throw new Error(`Unsupported direction: ${String(value)}`);
}

function maxDrawdown(values: number[]) {
  let equity = 0;
  let peak = 0;
  let maximum = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maximum = Math.max(maximum, peak - equity);
  }
  return maximum;
}

function fixed(value: number, decimals = 4) { return Number(value.toFixed(decimals)); }
function positiveInteger(value: string, label: string) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`); return number; }
function cliValue(flag: string) { const inline = process.argv.find((value) => value.startsWith(`${flag}=`)); if (inline) return inline.slice(flag.length + 1); const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function localDatabaseUrl() { const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "orb_password"); return `postgres://${process.env.POSTGRES_USER ?? "orb_user"}:${password}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "orb_guide"}`; }
function loadEnv(path: string) { if (!existsSync(path)) return; for (const line of readFileSync(path, "utf8").split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue; const separator = trimmed.indexOf("="); if (separator <= 0) continue; const key = trimmed.slice(0, separator).trim(); const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""); if (!(key in process.env)) process.env[key] = value; } }
function usage(): never { console.error("Usage: npm run validate:paper-management -- [self-test | compare [--gate] [--minimum-sample 5] [--days 90] [--limit 500] | diagnose --date YYYY-MM-DD [--direction LONG] | diagnose --setup-id UUID]"); process.exit(2); }
