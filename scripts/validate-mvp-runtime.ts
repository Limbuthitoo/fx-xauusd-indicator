import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { buildOpeningRange, evaluateSetup } from "../packages/strategy-engine/src/index.js";
import { evaluateLiquiditySweepSetup } from "../packages/liquidity-sweep-engine/src/index.js";
import type { Candle, StrategyConfiguration } from "../packages/shared-types/src/index.js";
import { redactSensitiveValue } from "../apps/api/src/infrastructure/security/redaction.js";

loadEnv(process.argv[2] ?? ".env.production");

const databaseUrl = process.env.DATABASE_URL ?? localDatabaseUrl();
const client = new pg.Client({ connectionString: databaseUrl });
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];
const NEW_YORK_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});
const NEW_YORK_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset"
});

try {
  reportProgress("Connecting to PostgreSQL");
  await client.connect();
  const tenants = await rows(
    `SELECT DISTINCT t.id, t.name
     FROM platform_tenants t
     JOIN tenant_modules tm ON tm.tenant_id = t.id AND tm.status = 'ENABLED'
     JOIN platform_strategy_modules m ON m.id = tm.module_id
     WHERE t.status = 'ACTIVE' AND m.code IN ('orb_max_options', 'high_probability_strategy_2')
     ORDER BY t.name`
  );
  checks.push({ name: "Active subscribers", status: tenants.length > 0 ? "PASS" : "FAIL", detail: `${tenants.length} active subscriber(s) have Module 1 or Module 2.` });

  const paperTargetTables = await rows(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'paper_trade_targets'`
  );
  checks.push({
    name: "Paper target lifecycle schema",
    status: paperTargetTables.length === 1 ? "PASS" : "FAIL",
    detail: paperTargetTables.length === 1
      ? "Paper trade TP1/TP2/TP3 milestone persistence is installed."
      : "paper_trade_targets is missing. Run migration 082 before deployment verification."
  });
  const lifecycleColumns = await rows(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'trades'
       AND column_name IN ('structural_stop', 'initial_risk_distance')`
  );
  checks.push({
    name: "Paper structural-risk snapshot",
    status: lifecycleColumns.length === 2 ? "PASS" : "FAIL",
    detail: lifecycleColumns.length === 2
      ? "Paper trades preserve immutable structural SL and initial R distance."
      : "Migration 082 structural_stop/initial_risk_distance columns are missing."
  });

  const missingRisk = await rows(
    `SELECT t.id, t.name
     FROM platform_tenants t
     WHERE t.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM tenant_modules tm WHERE tm.tenant_id = t.id AND tm.status = 'ENABLED')
       AND NOT EXISTS (SELECT 1 FROM risk_profiles rp WHERE rp.tenant_id = t.id AND rp.is_active = true)`
  );
  checks.push({
    name: "Tenant paper risk profiles",
    status: missingRisk.length === 0 ? "PASS" : "FAIL",
    detail: missingRisk.length === 0 ? "Every active subscriber has an active paper risk profile." : `${missingRisk.length} subscriber(s) are missing a paper risk profile. Run migration 076.`,
    evidence: missingRisk
  });

  const failureWindowMinutes = Math.min(1_440, Math.max(1, Number(process.env.MVP_FAILURE_WINDOW_MINUTES ?? 1_440)));
  const workerDeployment = (await rows(
    `SELECT started_at, heartbeat_at, status
     FROM worker_heartbeats
     WHERE worker_name = 'market-data-worker'
     LIMIT 1`
  ))[0] ?? null;
  const recentFailures = await rows(
    `SELECT event_type, tenant_id, created_at, metadata->>'moduleCode' AS module_code, metadata->>'error' AS error
     FROM operational_events
     WHERE created_at >= GREATEST(
             now() - ($1::int * interval '1 minute'),
             COALESCE($2::timestamptz, '-infinity'::timestamptz)
           )
       AND event_type IN ('STRATEGY_EVALUATION_FAILED', 'MAIN_BRAIN_FAILED')
     ORDER BY created_at DESC
     LIMIT 50`,
    [failureWindowMinutes, workerDeployment?.started_at ?? null]
  );
  checks.push({
    name: "Post-deployment strategy/brain failures",
    status: recentFailures.length === 0 ? "PASS" : "FAIL",
    detail: recentFailures.length === 0
      ? `No strategy or Python brain failures since the current worker started at ${workerDeployment?.started_at ?? "unknown"}.`
      : `${recentFailures.length} strategy/Python failure event(s) occurred after the current worker deployment.`,
    evidence: redactSensitiveValue({ workerDeployment, failures: recentFailures.slice(0, 10) }, [databaseUrl])
  });

  const historicalFailures = await rows(
    `SELECT event_type, tenant_id, created_at, metadata->>'moduleCode' AS module_code, metadata->>'error' AS error
     FROM operational_events
     WHERE created_at >= now() - ($1::int * interval '1 minute')
       AND created_at < COALESCE($2::timestamptz, now())
       AND event_type IN ('STRATEGY_EVALUATION_FAILED', 'MAIN_BRAIN_FAILED')
     ORDER BY created_at DESC
     LIMIT 10`,
    [failureWindowMinutes, workerDeployment?.started_at ?? null]
  );
  if (historicalFailures.length > 0) {
    checks.push({
      name: "Pre-deployment failure history",
      status: "WARN",
      detail: `${historicalFailures.length} sampled strategy/Python failure event(s) predate the current worker deployment and remain for audit history.`,
      evidence: redactSensitiveValue(historicalFailures, [databaseUrl])
    });
  }

  const candleRows = await rows(
    `SELECT timestamp_utc, open, high, low, close, volume, spread
     FROM candles
     WHERE symbol = 'XAUUSD' AND timeframe_minutes = 5 AND timestamp_utc >= now() - interval '8 days'
     ORDER BY timestamp_utc`
  );
  const biasRows = await rows(
    `SELECT timestamp_utc, open, high, low, close, volume, spread
     FROM candles
     WHERE symbol = 'XAUUSD' AND timeframe_minutes = 15 AND timestamp_utc >= now() - interval '8 days'
     ORDER BY timestamp_utc`
  );
  const candles = candleRows.map(toCandle);
  const biasCandles = biasRows.map(toCandle);
  reportProgress(`Loaded ${candles.length} completed 5M and ${biasCandles.length} completed 15M candles`);
  checks.push({
    name: "Saved XAUUSD candles",
    status: candles.length >= 100 && biasCandles.length >= 30 ? "PASS" : "FAIL",
    detail: `${candles.length} completed 5M and ${biasCandles.length} completed 15M candles are available.`
  });

  const replayDays = Math.min(5, Math.max(1, Number(process.env.MVP_REPLAY_DAYS ?? 2)));
  const dates = [...new Set(candles.map((candle) => nyDate(candle.timestampUtc)))]
    .filter((date) => isWeekday(date) && completedNySessionCandleCount(date, candles) >= 3)
    .slice(-replayDays);
  const [module1Config, module2Config] = await Promise.all([
    strategyConfiguration("orb_max_options"),
    strategyConfiguration("high_probability_strategy_2")
  ]);
  reportProgress(`Replaying ${dates.length} saved New York session(s): ${dates.join(", ") || "none"}`);
  const replay = dates.map((date, index) => {
    reportProgress(`Session ${index + 1}/${dates.length} (${date}): evaluating Module 1`);
    const module1 = replayModule1(date, candles, module1Config);
    reportProgress(`Session ${index + 1}/${dates.length} (${date}): Module 1 found ${module1.ready} setup(s); evaluating Module 2`);
    const module2 = replayModule2(date, candles, biasCandles, module2Config, (completed, total) => {
      reportProgress(`Session ${index + 1}/${dates.length} (${date}): Module 2 evaluated ${completed}/${total} candles`);
    });
    reportProgress(`Session ${index + 1}/${dates.length} (${date}): Module 2 found ${module2.ready} setup(s)`);
    return { date, module1, module2 };
  });
  const sessionsWithSignal = replay.filter((row) => row.module1.ready > 0 || row.module2.ready > 0).length;
  const targetSignalsPerSession = Math.max(1, Number(process.env.MVP_TARGET_SIGNALS_PER_NY_SESSION ?? 2));
  const sessionsMeetingCoverageTarget = replay.filter((row) => row.module1.ready + row.module2.ready >= targetSignalsPerSession).length;
  const totalReplaySignals = replay.reduce((total, row) => total + row.module1.ready + row.module2.ready, 0);
  const averageSignalsPerSession = replay.length > 0 ? totalReplaySignals / replay.length : 0;
  const invalidGeometry = replay.flatMap((row) => [
    ...row.module1.signals.map((signal: any) => ({ date: row.date, module: "Module 1", ...signal })),
    ...row.module2.signals.map((signal: any) => ({ date: row.date, module: "Module 2", ...signal }))
  ]).filter((signal: any) => !validTradeGeometry(signal.direction, signal.entry, signal.stop, signal.target));
  const replaySignals = replay.flatMap((row) => [
    ...row.module1.signals.map((signal: any) => ({ date: row.date, module: "Module 1", ...signal })),
    ...row.module2.signals.map((signal: any) => ({ date: row.date, module: "Module 2", ...signal }))
  ]);
  const resolvedReplaySignals = replaySignals.filter((signal: any) => signal.outcome === "WIN" || signal.outcome === "LOSS");
  const replayWins = resolvedReplaySignals.filter((signal: any) => signal.outcome === "WIN").length;
  const replayLosses = resolvedReplaySignals.filter((signal: any) => signal.outcome === "LOSS").length;
  const replayWinRate = resolvedReplaySignals.length > 0 ? replayWins / resolvedReplaySignals.length : 0;
  const replayResultR = resolvedReplaySignals.reduce((total: number, signal: any) => total + Number(signal.resultR ?? 0), 0);
  const minimumOutcomeSamples = Math.max(20, Number(process.env.MVP_MINIMUM_OUTCOME_SAMPLES ?? 60));
  checks.push({
    name: "Saved-candle NY opportunity replay",
    status: replay.length === 0 ? "FAIL" : sessionsWithSignal > 0 ? "PASS" : "WARN",
    detail: `${sessionsWithSignal}/${replay.length} saved NY session(s) contained at least one deterministic Module 1/2 setup. This is opportunity evidence, not a promised trade count.`,
    evidence: replay
  });
  checks.push({
    name: "NY signal coverage target",
    status: replay.length > 0 && sessionsMeetingCoverageTarget === replay.length ? "PASS" : "WARN",
    detail: `${sessionsMeetingCoverageTarget}/${replay.length} saved NY session(s) produced at least ${targetSignalsPerSession} distinct quality setup(s); average ${averageSignalsPerSession.toFixed(2)} per session. This is a coverage target, never permission to fabricate a trade.`,
    evidence: replay.map((row) => ({ date: row.date, module1: row.module1.ready, module2: row.module2.ready, total: row.module1.ready + row.module2.ready }))
  });
  checks.push({
    name: "Replay trade geometry",
    status: invalidGeometry.length === 0 ? "PASS" : "FAIL",
    detail: invalidGeometry.length === 0 ? "Every replayed BUY/SELL setup has its stop and target on the correct side of entry." : `${invalidGeometry.length} replayed setup(s) have invalid directional trade geometry.`,
    evidence: invalidGeometry
  });
  checks.push({
    name: "Replay outcome quality",
    status: resolvedReplaySignals.length < minimumOutcomeSamples
      ? "WARN"
      : replayResultR > 0 && replayWinRate >= 0.4
        ? "PASS"
        : "FAIL",
    detail: resolvedReplaySignals.length < minimumOutcomeSamples
      ? `${resolvedReplaySignals.length}/${minimumOutcomeSamples} resolved signals are available; ${replayWins} wins, ${replayLosses} losses, ${(replayWinRate * 100).toFixed(1)}% win rate, ${replayResultR.toFixed(2)}R. Collect more out-of-sample sessions before making a high-probability claim.`
      : `${resolvedReplaySignals.length} resolved signals produced ${replayWins} wins, ${replayLosses} losses, ${(replayWinRate * 100).toFixed(1)}% win rate, and ${replayResultR.toFixed(2)}R.`,
    evidence: replaySignals.map((signal: any) => ({
      date: signal.date,
      module: signal.module,
      at: signal.at,
      direction: signal.direction,
      scenario: signal.scenario,
      outcome: signal.outcome,
      resultR: signal.resultR
    }))
  });

  const latest = candles.at(-1)?.close ?? null;
  const staleReady = latest == null ? [] : await rows(
    `SELECT id, tenant_id, module_code, scenario, status, detected_at, entry_price,
            abs(entry_price - $1::numeric) / NULLIF($1::numeric, 0) AS distance_ratio
     FROM setup_candidates
     WHERE module_code IN ('orb_max_options', 'high_probability_strategy_2')
       AND status IN ('LONG SETUP READY', 'SHORT SETUP READY')
       AND detected_at >= now() - interval '12 hours'
       AND entry_price IS NOT NULL
       AND abs(entry_price - $1::numeric) / NULLIF($1::numeric, 0) > 0.02
     ORDER BY detected_at DESC`,
    [latest]
  );
  checks.push({
    name: "Fresh signal price guard",
    status: staleReady.length === 0 ? "PASS" : "FAIL",
    detail: staleReady.length === 0 ? "No recent setup-ready entry is more than 2% away from the latest stored price." : `${staleReady.length} recent ready setup(s) use stale market prices.`,
    evidence: staleReady
  });

  const invalidReadyGeometry = await rows(
    `SELECT id, tenant_id, module_code, scenario, status, direction, detected_at,
            entry_price, stop_price, target_price
     FROM setup_candidates
     WHERE module_code IN ('orb_max_options', 'high_probability_strategy_2')
       AND status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'TRADE_PLANNED', 'PAPER_TRADE_OPENED')
       AND detected_at >= now() - interval '7 days'
       AND NOT (
         (direction = 'LONG' AND stop_price < entry_price AND entry_price < target_price)
         OR (direction = 'SHORT' AND target_price < entry_price AND entry_price < stop_price)
       )
     ORDER BY detected_at DESC`
  );
  checks.push({
    name: "Persisted signal geometry",
    status: invalidReadyGeometry.length === 0 ? "PASS" : "FAIL",
    detail: invalidReadyGeometry.length === 0
      ? "Every recent persisted actionable setup has directionally valid entry, stop, and target prices."
      : `${invalidReadyGeometry.length} recent actionable setup(s) have impossible directional price geometry.`,
    evidence: invalidReadyGeometry
  });

  const artifactWindowHours = Math.min(168, Math.max(1, Number(process.env.MVP_ARTIFACT_WINDOW_HOURS ?? 24)));
  const chain = await rows(
    `SELECT sc.module_code,
            count(DISTINCT sc.id) FILTER (
              WHERE sc.status IN ('LONG SETUP READY','SHORT SETUP READY','TRADE_PLANNED','PAPER_TRADE_OPENED')
            )::int AS actionable_setups,
            count(DISTINCT sc.id) FILTER (WHERE sc.status IN ('LONG SETUP READY','SHORT SETUP READY'))::int AS ready_setups,
            count(DISTINCT tp.id)::int AS trade_plans,
            count(DISTINCT t.id)::int AS paper_trades,
            count(DISTINCT n.id)::int AS notifications
     FROM setup_candidates sc
     LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     LEFT JOIN notifications n ON n.tenant_id = sc.tenant_id
       AND (n.data->>'setupId' = sc.id::text OR n.data->>'setupCandidateId' = sc.id::text)
     WHERE sc.module_code IN ('orb_max_options','high_probability_strategy_2')
       AND sc.detected_at >= GREATEST(
             now() - ($1::int * interval '1 hour'),
             COALESCE($2::timestamptz, '-infinity'::timestamptz)
           )
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay','false') <> 'true'
     GROUP BY sc.module_code
     ORDER BY sc.module_code`,
    [artifactWindowHours, workerDeployment?.started_at ?? null]
  );
  const signalArtifactGaps = chain.filter((row: any) => Number(row.actionable_setups) > 0 && Number(row.notifications) === 0);
  const paperArtifactGaps = chain.filter((row: any) => Number(row.actionable_setups) > 0 && Number(row.paper_trades) === 0);
  const actionableArtifactCount = chain.reduce((total: number, row: any) => total + Number(row.actionable_setups ?? 0), 0);
  checks.push({
    name: "Recent BUY/SELL artifact chain",
    status: signalArtifactGaps.length > 0 ? "FAIL" : actionableArtifactCount > 0 ? "PASS" : "WARN",
    detail: signalArtifactGaps.length > 0
      ? `${signalArtifactGaps.length} module(s) produced actionable setups without the primary BUY/SELL notification artifact.`
      : actionableArtifactCount > 0
        ? `Recent actionable setups and primary BUY/SELL notifications are connected within the last ${artifactWindowHours} hours.`
        : `No production-ready setup was recorded in the last ${artifactWindowHours} hours; wait for a valid completed 5M setup before final artifact proof.`,
    evidence: chain
  });
  checks.push({
    name: "Recent paper-tracking chain",
    status: paperArtifactGaps.length > 0 ? "WARN" : actionableArtifactCount > 0 ? "PASS" : "WARN",
    detail: paperArtifactGaps.length > 0
      ? `${paperArtifactGaps.length} module(s) produced actionable signals without paper-tracking artifacts. BUY/SELL remains valid, but win-rate measurement is incomplete.`
      : actionableArtifactCount > 0
        ? "Recent actionable signals are also represented in the paper-trading measurement ledger."
        : "No recent actionable signal is available for paper-tracking proof.",
    evidence: chain
  });

  const validationTables = await rows(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'strategy_validation_datasets',
         'strategy_validation_candles',
         'strategy_validation_runs',
         'strategy_validation_signals',
         'strategy_validation_metrics',
         'strategy_release_gates'
       )`
  );
  checks.push({
    name: "Historical validation schema",
    status: validationTables.length === 6 ? "PASS" : "FAIL",
    detail: `${validationTables.length}/6 isolated validation and release-gate tables are present.`,
    evidence: validationTables
  });

  const releaseGates = validationTables.length === 6 ? await rows(
    `SELECT module_code, profile_code, status, enforced, resolved_count, win_rate,
            profit_factor, expectancy_r, max_drawdown_r, evaluated_at
     FROM strategy_release_gates
     ORDER BY module_code, profile_code`
  ) : [];
  const invalidEnforcedGates = releaseGates.filter((gate: any) =>
    gate.enforced === true && (gate.status === "INSUFFICIENT_DATA" || Number(gate.resolved_count ?? 0) < 30)
  );
  checks.push({
    name: "Mature release-gate enforcement",
    status: invalidEnforcedGates.length === 0 ? "PASS" : "FAIL",
    detail: invalidEnforcedGates.length === 0
      ? `${releaseGates.filter((gate: any) => gate.enforced).length} mature profile gate(s) are enforced; small samples remain non-enforcing.`
      : `${invalidEnforcedGates.length} release gate(s) are enforced without a mature validation sample.`,
    evidence: invalidEnforcedGates.length > 0 ? invalidEnforcedGates : releaseGates
  });

  const blockedProfileLeaks = validationTables.length === 6 ? await rows(
    `SELECT sc.id, sc.module_code, sc.scenario, sc.status, sc.detected_at,
            g.profile_code, g.evaluated_at, tp.id AS trade_plan_id, t.id AS trade_id, n.id AS notification_id
     FROM setup_candidates sc
     JOIN strategy_release_gates g
       ON g.module_code = sc.module_code
      AND g.enforced = true
      AND g.status = 'BLOCKED'
      AND g.profile_code = CASE
        WHEN sc.module_code = 'high_probability_strategy_2'
          THEN COALESCE(sc.scenario_flags->'module2Variant'->>'code', sc.scenario_flags->>'variantCode')
        WHEN upper(sc.scenario) LIKE '%HORIZONTAL%' THEN 'HORIZONTAL_RANGE_BREAKOUT'
        WHEN upper(sc.scenario) LIKE '%OPENING_DRIVE%' THEN 'OPENING_DRIVE'
        WHEN upper(sc.scenario) LIKE '%LIQUIDITY_SWEEP%' THEN 'LIQUIDITY_SWEEP_REVERSAL'
        WHEN upper(sc.scenario) LIKE '%RETEST%' THEN 'BREAKOUT_RETEST'
        ELSE 'ORB_BREAKOUT'
      END
     LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     LEFT JOIN notifications n ON n.tenant_id = sc.tenant_id
       AND (n.data->>'setupId' = sc.id::text OR n.data->>'setupCandidateId' = sc.id::text)
     WHERE sc.detected_at >= g.evaluated_at
       AND (tp.id IS NOT NULL OR t.id IS NOT NULL OR n.id IS NOT NULL)
     ORDER BY sc.detected_at DESC
     LIMIT 50`
  ) : [];
  checks.push({
    name: "Blocked profile artifact isolation",
    status: blockedProfileLeaks.length === 0 ? "PASS" : "FAIL",
    detail: blockedProfileLeaks.length === 0
      ? "No enforced blocked profile produced a post-gate BUY/SELL notification or simulated trade artifact."
      : `${blockedProfileLeaks.length} blocked profile setup(s) leaked into live MVP artifacts.`,
    evidence: blockedProfileLeaks
  });

  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    warn: checks.filter((item) => item.status === "WARN").length,
    fail: checks.filter((item) => item.status === "FAIL").length
  };
  console.log(JSON.stringify({ status: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", generatedAt: new Date().toISOString(), summary, checks }, null, 2));
  if (summary.fail > 0) process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

function replayModule1(date: string, candles: Candle[], rawConfiguration: any) {
  const session = candles.filter((candle) => nyDate(candle.timestampUtc) === date && nyMinutes(candle.timestampUtc) >= 9 * 60 + 15 && nyMinutes(candle.timestampUtc) <= 16 * 60);
  const opening = session.filter((candle) => nyMinutes(candle.timestampUtc) >= 9 * 60 + 15 && nyMinutes(candle.timestampUtc) < 9 * 60 + 30).slice(0, 3);
  if (opening.length < 3) return { ready: 0, status: "MISSING_OPENING_RANGE", candles: session.length, signals: [], bestObservation: null };
  const range = buildOpeningRange(opening, 0.01, 3);
  const configuration = module1Config(rawConfiguration);
  const previous: Candle[] = [];
  const ready: any[] = [];
  const seenTheses = new Set<string>();
  let bestObservation: any = null;
  for (const candle of session.filter((item) => nyMinutes(item.timestampUtc) >= 9 * 60 + 30)) {
    const decision = evaluateSetup({
      now: candle.timestampUtc,
      symbol: "XAUUSD",
      strategyVersionId: "saved-candle-audit",
      session: {
        symbol: "XAUUSD",
        strategyVersionId: "saved-candle-audit",
        sessionDate: date,
        sessionPreset: "NEW_YORK_ORB",
        state: "OPENING_RANGE_LOCKED",
        sessionStartAt: opening[0].timestampUtc,
        openingRangeEndAt: candleAtNy(date, "09:30"),
        signalWindowEndAt: candleAtNy(date, "16:00"),
        dataStatus: "READY"
      },
      openingRange: range,
      currentCandle: candle,
      previousCandles: previous,
      spread: candle.spread ?? 0,
      newsStatus: "CLEAR",
      riskStatus: "PERMITTED",
      configuration
    });
    if (!bestObservation || Number(decision.favorabilityScore ?? 0) > Number(bestObservation.score ?? 0)) {
      bestObservation = {
        at: candle.timestampUtc,
        status: decision.status,
        scenario: decision.scenario,
        score: decision.favorabilityScore,
        reason: decision.finalReason,
        blockers: decision.evaluations.filter((evaluation) => evaluation.blocking && evaluation.status !== "PASS").map((evaluation) => evaluation.ruleCode)
      };
    }
    const isReady = ["LONG SETUP READY", "SHORT SETUP READY"].includes(decision.status);
    const thesisKey = [
      decision.direction,
      module1ScenarioFamily(decision.scenario),
      range.high.toFixed(2),
      range.low.toFixed(2)
    ].join(":");
    if (isReady && !seenTheses.has(thesisKey)) {
      seenTheses.add(thesisKey);
      ready.push({ at: candle.timestampUtc, direction: decision.direction, scenario: decision.scenario, score: decision.favorabilityScore, entry: decision.entryPrice, stop: decision.stopPrice, target: decision.targetPrice });
    }
    previous.push(candle);
  }
  const signals = scoreReplaySignals(ready, session);
  return { ready: signals.length, range: { high: range.high, low: range.low }, signals, bestObservation };
}

function module1ScenarioFamily(scenario: string) {
  const value = String(scenario ?? "").toUpperCase();
  if (value.includes("HORIZONTAL")) return "HORIZONTAL_RANGE_BREAKOUT";
  if (value.includes("OPENING_DRIVE")) return "OPENING_DRIVE";
  if (value.includes("LIQUIDITY_SWEEP")) return "LIQUIDITY_SWEEP_REVERSAL";
  if (value.includes("RETEST")) return "BREAKOUT_RETEST";
  return "ORB_BREAKOUT";
}

function replayModule2(
  date: string,
  candles: Candle[],
  biasCandles: Candle[],
  rawConfiguration: any,
  onProgress?: (completed: number, total: number) => void
) {
  const candidates = candles.filter((candle) => nyDate(candle.timestampUtc) === date && nyMinutes(candle.timestampUtc) >= 9 * 60 + 30 && nyMinutes(candle.timestampUtc) <= 16 * 60);
  const ready: any[] = [];
  const seenSignals = new Set<string>();
  let bestObservation: any = null;
  for (const [index, current] of candidates.entries()) {
    const context = candles
      .filter((candle) => candle.timestampUtc <= current.timestampUtc && new Date(candle.timestampUtc).getTime() >= new Date(current.timestampUtc).getTime() - 72 * 60 * 60_000)
      .slice(-600);
    const bias = biasCandles.filter((candle) => candle.timestampUtc <= current.timestampUtc).slice(-200);
    const decision = evaluateLiquiditySweepSetup({
      now: current.timestampUtc,
      symbol: "XAUUSD",
      setupCandles: context,
      biasCandles: bias,
      spread: current.spread ?? null,
      newsStatus: "CLEAR",
      tradesTakenThisSession: ready.length,
      configuration: { ...(rawConfiguration ?? {}), newYorkStartTime: "09:30", newYorkEndTime: "16:00", maximumTradesPerSession: 4 }
    });
    if (!bestObservation || Number(decision.favorabilityScore ?? 0) > Number(bestObservation.score ?? 0)) {
      bestObservation = {
        at: current.timestampUtc,
        status: decision.status,
        scenario: decision.scenario,
        score: decision.favorabilityScore,
        reason: decision.finalReason,
        variant: (decision.scenarioFlags.module2Variant as any)?.code ?? null,
        blockers: decision.evaluations.filter((evaluation) => evaluation.blocking && evaluation.status !== "PASS").map((evaluation) => evaluation.ruleCode)
      };
    }
    if (["LONG SETUP READY", "SHORT SETUP READY"].includes(decision.status)) {
      const variant = (decision.scenarioFlags.module2Variant as any)?.code ?? null;
      const sweep = decision.scenarioFlags.sweep as any;
      const signalKey = [
        decision.direction,
        sweep?.sweptAt ?? sweep?.candle?.timestampUtc ?? "UNKNOWN_SWEEP",
        sweep?.level?.type ?? "UNKNOWN_LEVEL",
        Number(sweep?.level?.price ?? 0).toFixed(2)
      ].join(":");
      if (!seenSignals.has(signalKey)) {
        seenSignals.add(signalKey);
        ready.push({ at: current.timestampUtc, direction: decision.direction, scenario: decision.scenario, score: decision.favorabilityScore, entry: decision.entryPrice, stop: decision.stopPrice, target: decision.targetPrice, variant });
      }
    }
    if ((index + 1) % 10 === 0 || index + 1 === candidates.length) {
      onProgress?.(index + 1, candidates.length);
    }
  }
  const signals = scoreReplaySignals(ready, candidates);
  return { ready: signals.length, signals, bestObservation };
}

function reportProgress(message: string) {
  console.error(`[mvp-runtime] ${new Date().toISOString()} ${message}`);
}

function scoreReplaySignals(signals: any[], candles: Candle[]) {
  return signals.map((signal) => {
    const following = candles.filter((candle) => candle.timestampUtc > signal.at);
    for (const candle of following) {
      const stopHit = signal.direction === "LONG" ? candle.low <= signal.stop : candle.high >= signal.stop;
      const targetHit = signal.direction === "LONG" ? candle.high >= signal.target : candle.low <= signal.target;
      if (stopHit) return { ...signal, outcome: "LOSS", closedAt: candle.timestampUtc, resultR: -1 };
      if (targetHit) return { ...signal, outcome: "WIN", closedAt: candle.timestampUtc, resultR: 2 };
    }
    return { ...signal, outcome: "OPEN", closedAt: null, resultR: null };
  });
}

function validTradeGeometry(direction: unknown, entryValue: unknown, stopValue: unknown, targetValue: unknown) {
  const entry = Number(entryValue);
  const stop = Number(stopValue);
  const target = Number(targetValue);
  if (![entry, stop, target].every(Number.isFinite)) return false;
  return direction === "LONG"
    ? stop < entry && entry < target
    : direction === "SHORT" && target < entry && entry < stop;
}

async function strategyConfiguration(moduleCode: string) {
  const result = await rows(
    `SELECT sv.configuration_json
     FROM strategy_versions sv
     WHERE sv.configuration_json->>'moduleCode' = $1 AND sv.status = 'ACTIVE'
     ORDER BY sv.activated_at DESC NULLS LAST, sv.created_at DESC
     LIMIT 1`,
    [moduleCode]
  );
  return result[0]?.configuration_json ?? {};
}

function module1Config(raw: any): StrategyConfiguration {
  return {
    name: "Module 1 NY ORB MAX",
    version: String(raw?.version ?? "saved-candle-audit"),
    status: "ACTIVE",
    symbol: "XAUUSD",
    timezone: "America/New_York",
    sessionStart: "09:15",
    openingRangeMinutes: 15,
    signalTimeframeMinutes: 5,
    tradeWindowEnd: "16:00",
    enabledScenarios: raw?.enabledScenarios ?? { doubleSidedSweep: "BLOCK_CONTINUATION" },
    breakout: { requireCompletedCandle: true, requireCloseOutside: true, allowWickOnly: false, minimumBodyRatio: 0.45, minimumCloseLocationRatio: 0.65, maximumEntryExtensionPercentOfRange: 1, ...(raw?.breakout ?? {}) },
    retest: { enabled: true, zonePercentOfRange: 0.1, maximumCandles: 6, confirmationRequired: false, ...(raw?.retest ?? {}) },
    rangeFilter: { mode: "OFF", minimumWidth: null, maximumWidth: null, ...(raw?.rangeFilter ?? {}) },
    newsFilter: { enabled: false, mode: "OFF", manualEvents: false, ...(raw?.newsFilter ?? {}) },
    risk: { riskPerTradePercent: 0.25, maximumDailyLossPercent: 0.75, maximumWeeklyLossPercent: 2, maximumTradesPerSession: 2, maximumConsecutiveLosses: 3, mandatoryStopLoss: true, minimumRewardToRisk: 1.5, allowMartingale: false, allowAddingToLoss: false, ...(raw?.risk ?? {}) },
    favorability: { minimumScoreForPaperTrade: 80, preferredSpreadPercentOfRange: 0.12, minimumAtrPercentOfRange: 0.1, ...(raw?.favorability ?? {}) },
    paperTrading: { enabled: true, maximumTradesPerSession: 2, conservativeSameCandleExit: true, ...(raw?.paperTrading ?? {}) }
  };
}

function toCandle(row: any): Candle {
  return { timestampUtc: new Date(row.timestamp_utc).toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume == null ? null : Number(row.volume), spread: row.spread == null ? null : Number(row.spread) };
}

function nyParts(timestamp: string) {
  return NEW_YORK_PARTS_FORMATTER.formatToParts(new Date(timestamp));
}

function nyDate(timestamp: string) {
  const parts = nyParts(timestamp);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function nyMinutes(timestamp: string) {
  const parts = nyParts(timestamp);
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

function completedNySessionCandleCount(date: string, candles: Candle[]) {
  const sessionCandles = candles.filter((candle) => nyDate(candle.timestampUtc) === date && nyMinutes(candle.timestampUtc) >= 9 * 60 + 15 && nyMinutes(candle.timestampUtc) <= 16 * 60);
  if (sessionCandles.length < 3) return 0;
  const latestMinutes = Math.max(...sessionCandles.map((candle) => nyMinutes(candle.timestampUtc)));
  const today = nyDate(new Date().toISOString());
  return date < today || latestMinutes >= 16 * 60 ? sessionCandles.length : 0;
}

function isWeekday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function candleAtNy(date: string, time: string) {
  const sample = new Date(`${date}T12:00:00Z`);
  const offset = NEW_YORK_OFFSET_FORMATTER.formatToParts(sample).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "-04:00";
  return new Date(`${date}T${time}:00${offset}`).toISOString();
}

async function rows(text: string, params: unknown[] = []) {
  return (await client.query(text, params)).rows;
}

function localDatabaseUrl() {
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "orb_password");
  return `postgres://${process.env.POSTGRES_USER ?? "orb_user"}:${password}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "orb_guide"}`;
}

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
