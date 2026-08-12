import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import pg from "pg";
import { buildOpeningRange, evaluateSetup } from "../packages/strategy-engine/src/index.ts";
import { evaluateLiquiditySweepSetup } from "../packages/liquidity-sweep-engine/src/index.ts";
import type { Candle, Direction, StrategyConfiguration } from "../packages/shared-types/src/index.ts";

type Partition = "TRAIN" | "VALIDATION";
type ModuleCode = "orb_max_options" | "high_probability_strategy_2";
const MODULE_PROFILES: Record<ModuleCode, string[]> = {
  orb_max_options: ["ORB_BREAKOUT", "BREAKOUT_RETEST", "LIQUIDITY_SWEEP_REVERSAL", "OPENING_DRIVE", "HORIZONTAL_RANGE_BREAKOUT"],
  high_probability_strategy_2: ["SWEEP_CLOSE_BACK_INSIDE", "SWEEP_BOS", "SWEEP_MSS", "SWEEP_ENGULFING", "SWEEP_BOS_RETEST", "SWEEP_MSS_RETEST", "SWEEP_EMA_ALIGNMENT", "SWEEP_VOLUME_EXPANSION", "SWEEP_MSS_DISPLACEMENT_RETEST", "SWEEP_NO_CONFIRMATION"]
};
type ReplaySignal = {
  moduleCode: ModuleCode;
  profileCode: string;
  thesisKey: string;
  sessionDate: string;
  detectedAt: string;
  closedAt: string | null;
  direction: Direction;
  scenario: string;
  entry: number;
  stop: number;
  target: number;
  outcome: "WIN" | "LOSS" | "OPEN" | "BREAKEVEN";
  resultR: number | null;
  ambiguous: boolean;
  evidence: Record<string, unknown>;
};

let client: pg.Client;

if (!isMainThread) {
  const input = workerData as { date: string; candles: Candle[]; biasCandles: Candle[]; module1Config: any; module2Config: any };
  const signals = [
    ...replayModule1(input.date, input.candles, input.module1Config),
    ...replayModule2(input.date, input.candles, input.biasCandles, input.module2Config)
  ];
  parentPort?.postMessage(signals);
} else {
  loadEnv(cliValue("--env") ?? ".env.production");
  const command = process.argv[2];
  if (!["import", "run", "report", "list"].includes(command ?? "")) usage();
  client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? localDatabaseUrl() });
  try {
    await client.connect();
    if (command === "import") await importDataset();
    else if (command === "run") await runValidation();
    else if (command === "report") await reportValidation();
    else if (command === "list") await listDatasets();
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function importDataset() {
  const file = requiredCliValue("--file");
  const name = cliValue("--name") ?? basename(file, extname(file));
  const symbol = cliValue("--symbol") ?? "XAUUSD";
  const timeframe = positiveInteger(cliValue("--timeframe") ?? "5", "--timeframe");
  const source = cliValue("--source") ?? "HISTORICAL_FILE_IMPORT";
  const replace = process.argv.includes("--replace");
  const candles = parseCandleFile(resolve(file)).map((row, index) => normalizeImportedCandle(row, index + 2));
  if (candles.length === 0) throw new Error("The import file contains no candle rows.");
  const sorted = [...candles].sort((left, right) => left.timestampUtc.localeCompare(right.timestampUtc));
  const duplicate = sorted.find((row, index) => index > 0 && row.timestampUtc === sorted[index - 1].timestampUtc);
  if (duplicate) throw new Error(`Duplicate timestamp found: ${duplicate.timestampUtc}`);

  await client.query("BEGIN");
  try {
    const existing = await client.query(`SELECT id FROM strategy_validation_datasets WHERE name=$1`, [name]);
    if (existing.rowCount && !replace) throw new Error(`Dataset '${name}' exists. Use --replace to replace that research dataset.`);
    if (existing.rowCount) await client.query(`DELETE FROM strategy_validation_datasets WHERE id=$1`, [existing.rows[0].id]);
    const inserted = await client.query(
      `INSERT INTO strategy_validation_datasets(name,symbol,source,timeframe_minutes,status,metadata)
       VALUES($1,$2,$3,$4,'IMPORTING',$5::jsonb) RETURNING id`,
      [name, symbol, source, timeframe, JSON.stringify({ file: basename(file), isolatedFromLiveCache: true })]
    );
    const datasetId = inserted.rows[0].id;
    for (let offset = 0; offset < sorted.length; offset += 400) {
      const batch = sorted.slice(offset, offset + 400);
      const expanded: unknown[] = [];
      for (const candle of batch) expanded.push(datasetId, symbol, timeframe, candle.timestampUtc, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.spread, source);
      await client.query(
        `INSERT INTO strategy_validation_candles
         (dataset_id,symbol,timeframe_minutes,timestamp_utc,open,high,low,close,volume,spread,source)
         VALUES ${batch.map((_, index) => {
           const start = index * 11;
           return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6},$${start + 7},$${start + 8},$${start + 9},$${start + 10},$${start + 11})`;
         }).join(",")}`,
        expanded
      );
    }
    const sessions = new Set(sorted.map((candle) => nyDate(candle.timestampUtc)).filter(isWeekday));
    await client.query(
      `UPDATE strategy_validation_datasets SET status='READY',candle_count=$2,session_count=$3,start_at=$4,end_at=$5,updated_at=now() WHERE id=$1`,
      [datasetId, sorted.length, sessions.size, sorted[0].timestampUtc, sorted.at(-1)!.timestampUtc]
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ status: "IMPORTED", datasetId, name, candles: sorted.length, sessions: sessions.size, liveCacheTouched: false }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function runValidation() {
  const datasetName = requiredCliValue("--dataset");
  const trainRatio = boundedNumber(cliValue("--train-ratio") ?? "0.7", 0.5, 0.9, "--train-ratio");
  const datasetResult = await client.query(`SELECT * FROM strategy_validation_datasets WHERE name=$1 AND status='READY'`, [datasetName]);
  if (!datasetResult.rowCount) throw new Error(`Ready dataset '${datasetName}' was not found.`);
  const dataset = datasetResult.rows[0];
  if (Number(dataset.timeframe_minutes) !== 5) throw new Error("Strategy replay currently requires 5-minute source candles.");
  const candleResult = await client.query(
    `SELECT timestamp_utc,open,high,low,close,volume,spread FROM strategy_validation_candles WHERE dataset_id=$1 ORDER BY timestamp_utc`,
    [dataset.id]
  );
  const candles = candleResult.rows.map(toCandle);
  const biasCandles = aggregateCandles(candles, 15);
  const dates = [...new Set(candles.map((candle) => nyDate(candle.timestampUtc)))].filter(isWeekday).sort();
  if (dates.length < 2) throw new Error("At least two New York trading dates are required.");
  const split = Math.min(dates.length - 1, Math.max(1, Math.floor(dates.length * trainRatio)));
  const trainDates = dates.slice(0, split);
  const validationDates = dates.slice(split);
  const [module1ConfigValue, module2ConfigValue] = await Promise.all([
    strategyConfiguration("orb_max_options"), strategyConfiguration("high_probability_strategy_2")
  ]);
  const run = await client.query(
    `INSERT INTO strategy_validation_runs(dataset_id,train_ratio,train_start_date,train_end_date,validation_start_date,validation_end_date,parameters)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
    [dataset.id, trainRatio, trainDates[0], trainDates.at(-1), validationDates[0], validationDates.at(-1), JSON.stringify(validationParameters())]
  );
  const runId = run.rows[0].id;
  try {
    const replayed = await replaySessionsInParallel(dates, candles, biasCandles, module1ConfigValue, module2ConfigValue);
    const trainSet = new Set(trainDates);
    const signals: Array<ReplaySignal & { partition: Partition }> = replayed.map((item) => ({ ...item, partition: trainSet.has(item.sessionDate) ? "TRAIN" : "VALIDATION" }));
    await persistSignals(runId, signals);
    const metrics = buildAllMetrics(signals, { TRAIN: trainDates.length, VALIDATION: validationDates.length });
    await persistMetrics(runId, metrics);
    await persistReleaseGates(runId, Number(dataset.session_count), metrics.filter((row) => row.partition === "VALIDATION"));
    const summary = summarizeRun(dataset, trainDates, validationDates, signals, metrics);
    await client.query(`UPDATE strategy_validation_runs SET status='COMPLETED',summary=$2::jsonb,completed_at=now() WHERE id=$1`, [runId, JSON.stringify(summary)]);
    console.log(JSON.stringify({ status: "COMPLETED", runId, ...summary }, null, 2));
  } catch (error) {
    await client.query(`UPDATE strategy_validation_runs SET status='FAILED',summary=$2::jsonb,completed_at=now() WHERE id=$1`, [runId, JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]);
    throw error;
  }
}

async function replaySessionsInParallel(dates: string[], candles: Candle[], biasCandles: Candle[], module1ConfigValue: any, module2ConfigValue: any) {
  const requested = positiveInteger(process.env.VALIDATION_REPLAY_WORKERS ?? String(Math.min(4, Math.max(1, availableParallelism() - 1))), "VALIDATION_REPLAY_WORKERS");
  const concurrency = Math.min(requested, dates.length);
  const results: ReplaySignal[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < dates.length) {
      const date = dates[cursor++];
      const sessionEnd = new Date(candleAtNy(date, "16:00")).getTime();
      const contextStart = new Date(candleAtNy(date, "00:00")).getTime() - 72 * 60 * 60_000;
      const dateCandles = candles.filter((candle) => {
        const timestamp = new Date(candle.timestampUtc).getTime();
        return timestamp >= contextStart && timestamp <= sessionEnd;
      });
      const dateBias = biasCandles.filter((candle) => {
        const timestamp = new Date(candle.timestampUtc).getTime();
        return timestamp >= contextStart && timestamp <= sessionEnd;
      });
      results.push(...await replaySessionWorker({ date, candles: dateCandles, biasCandles: dateBias, module1Config: module1ConfigValue, module2Config: module2ConfigValue }));
    }
  }));
  return results.sort((left, right) => left.detectedAt.localeCompare(right.detectedAt));
}

function replaySessionWorker(input: { date: string; candles: Candle[]; biasCandles: Candle[]; module1Config: any; module2Config: any }) {
  return new Promise<ReplaySignal[]>((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: input, execArgv: process.execArgv });
    worker.once("message", (message) => resolvePromise(message as ReplaySignal[]));
    worker.once("error", rejectPromise);
    worker.once("exit", (code) => { if (code !== 0) rejectPromise(new Error(`Replay worker exited with code ${code}.`)); });
  });
}

function replayModule1(date: string, candles: Candle[], rawConfiguration: any): ReplaySignal[] {
  const session = candles.filter((candle) => nyDate(candle.timestampUtc) === date && betweenNy(candle.timestampUtc, "09:15", "16:00"));
  const opening = session.filter((candle) => betweenNy(candle.timestampUtc, "09:15", "09:29")).slice(0, 3);
  if (opening.length < 3) return [];
  const range = buildOpeningRange(opening, 0.01, 3);
  if (range.status !== "LOCKED") return [];
  const configuration = module1Config(rawConfiguration);
  const ready: Omit<ReplaySignal, "closedAt" | "outcome" | "resultR" | "ambiguous">[] = [];
  const seen = new Set<string>();
  const previous: Candle[] = [];
  for (const current of session.filter((candle) => nyMinutes(candle.timestampUtc) >= 570)) {
    const decision = evaluateSetup({
      now: current.timestampUtc, symbol: "XAUUSD", strategyVersionId: "historical-validation",
      session: { symbol: "XAUUSD", strategyVersionId: "historical-validation", sessionDate: date, sessionPreset: "NEW_YORK_ORB", state: "OPENING_RANGE_LOCKED", sessionStartAt: opening[0].timestampUtc, openingRangeEndAt: candleAtNy(date, "09:30"), signalWindowEndAt: candleAtNy(date, "16:00"), dataStatus: "READY" },
      openingRange: range, currentCandle: current, previousCandles: previous, spread: current.spread ?? 0,
      newsStatus: "CLEAR", riskStatus: "PERMITTED", configuration
    });
    if (["LONG SETUP READY", "SHORT SETUP READY"].includes(decision.status) && decision.direction && decision.entryPrice != null && decision.stopPrice != null && decision.targetPrice != null) {
      const profileCode = module1ScenarioFamily(decision.scenario);
      const thesisKey = `${date}:${decision.direction}:${profileCode}:${Number(range.high).toFixed(2)}:${Number(range.low).toFixed(2)}`;
      if (!seen.has(thesisKey)) {
        seen.add(thesisKey);
        ready.push({ moduleCode: "orb_max_options", profileCode, thesisKey, sessionDate: date, detectedAt: current.timestampUtc, direction: decision.direction, scenario: decision.scenario, entry: decision.entryPrice, stop: decision.stopPrice, target: decision.targetPrice, evidence: { score: decision.favorabilityScore, grade: decision.favorabilityGrade, reason: decision.finalReason, openingRange: range, checklist: decision.evaluations, scenarioFlags: decision.scenarioFlags } });
      }
    }
    previous.push(current);
  }
  return scoreSignals(ready, session);
}

function replayModule2(date: string, candles: Candle[], biasCandles: Candle[], rawConfiguration: any): ReplaySignal[] {
  const session = candles.filter((candle) => nyDate(candle.timestampUtc) === date && betweenNy(candle.timestampUtc, "09:30", "16:00"));
  const ready: Omit<ReplaySignal, "closedAt" | "outcome" | "resultR" | "ambiguous">[] = [];
  const seen = new Set<string>();
  const candleIndex = new Map(candles.map((candle, index) => [candle.timestampUtc, index]));
  for (const current of session) {
    const currentMs = new Date(current.timestampUtc).getTime();
    const currentIndex = candleIndex.get(current.timestampUtc) ?? 0;
    let contextStart = Math.max(0, currentIndex - 599);
    const earliestContextMs = currentMs - 72 * 60 * 60_000;
    while (contextStart < currentIndex && new Date(candles[contextStart].timestampUtc).getTime() < earliestContextMs) contextStart += 1;
    const context = candles.slice(contextStart, currentIndex + 1);
    const biasEnd = upperBoundTimestamp(biasCandles, current.timestampUtc);
    const bias = biasCandles.slice(Math.max(0, biasEnd - 200), biasEnd);
    const decision = evaluateLiquiditySweepSetup({ now: current.timestampUtc, symbol: "XAUUSD", setupCandles: context, biasCandles: bias, spread: current.spread ?? null, newsStatus: "CLEAR", tradesTakenThisSession: 0, configuration: { ...(rawConfiguration ?? {}), newYorkStartTime: "09:30", newYorkEndTime: "16:00", maximumTradesPerSession: 99 } });
    const flags = decision.scenarioFlags as any;
    const variants = Array.isArray(flags.module2Variants) ? flags.module2Variants : [];
    const sweep = flags.sweep;
    const plan = flags.tradePlan;
    const entryReady = ["BUY_READY", "SELL_READY"].includes(String(flags.profileEngine?.finalDecision ?? ""));
    if (!entryReady || !sweep || !plan || !decision.direction || !validGeometry(decision.direction, plan.entry, plan.stop, plan.target)) continue;
    for (const variant of variants.filter((row: any) => row.paperEligible && row.status === "PASS")) {
      const eventKey = `${sweep.sweptAt ?? sweep.candle?.timestampUtc ?? current.timestampUtc}:${sweep.level?.type ?? "LEVEL"}:${Number(sweep.level?.price ?? 0).toFixed(2)}`;
      const thesisKey = `${date}:${decision.direction}:${variant.code}:${eventKey}`;
      if (seen.has(thesisKey)) continue;
      seen.add(thesisKey);
      ready.push({ moduleCode: "high_probability_strategy_2", profileCode: String(variant.code), thesisKey, sessionDate: date, detectedAt: current.timestampUtc, direction: decision.direction, scenario: decision.scenario, entry: Number(plan.entry), stop: Number(plan.stop), target: Number(plan.target), evidence: { score: decision.favorabilityScore, grade: decision.favorabilityGrade, reason: decision.finalReason, selectedVariant: flags.module2Variant, evaluatedVariant: variant, sweep, displacement: flags.displacement, structure: flags.bos, entryZone: flags.entryZone, tradePlan: plan, checklist: decision.evaluations } });
    }
  }
  return scoreSignals(ready, session);
}

function scoreSignals(signals: Omit<ReplaySignal, "closedAt" | "outcome" | "resultR" | "ambiguous">[], session: Candle[]): ReplaySignal[] {
  return signals.map((signal) => {
    const risk = Math.abs(signal.entry - signal.stop);
    const rewardR = risk > 0 ? Math.abs(signal.target - signal.entry) / risk : 0;
    for (const candle of session.filter((row) => row.timestampUtc > signal.detectedAt)) {
      const stopHit = signal.direction === "LONG" ? candle.low <= signal.stop : candle.high >= signal.stop;
      const targetHit = signal.direction === "LONG" ? candle.high >= signal.target : candle.low <= signal.target;
      if (stopHit && targetHit) return { ...signal, closedAt: candle.timestampUtc, outcome: "LOSS", resultR: -1, ambiguous: true };
      if (stopHit) return { ...signal, closedAt: candle.timestampUtc, outcome: "LOSS", resultR: -1, ambiguous: false };
      if (targetHit) return { ...signal, closedAt: candle.timestampUtc, outcome: "WIN", resultR: Number(rewardR.toFixed(4)), ambiguous: false };
    }
    return { ...signal, closedAt: null, outcome: "OPEN", resultR: null, ambiguous: false };
  });
}

function buildAllMetrics(signals: Array<ReplaySignal & { partition: Partition }>, sessions: Record<Partition, number>) {
  const rows: MetricRow[] = [];
  for (const partition of ["TRAIN", "VALIDATION"] as Partition[]) {
    const partitionSignals = signals.filter((signal) => signal.partition === partition);
    for (const moduleCode of ["orb_max_options", "high_probability_strategy_2"] as ModuleCode[]) {
      const moduleSignals = partitionSignals.filter((signal) => signal.moduleCode === moduleCode);
      for (const profile of MODULE_PROFILES[moduleCode]) rows.push(metricRow(partition, moduleCode, profile, moduleSignals.filter((signal) => signal.profileCode === profile), sessions[partition]));
      rows.push(metricRow(partition, moduleCode, "__ALL__", dedupeModuleSignals(moduleSignals), sessions[partition]));
    }
  }
  return rows;
}

type MetricRow = ReturnType<typeof metricRow>;
function metricRow(partition: Partition, moduleCode: ModuleCode, profileCode: string, signals: ReplaySignal[], sessions: number) {
  const resolved = signals.filter((signal) => ["WIN", "LOSS", "BREAKEVEN"].includes(signal.outcome));
  const wins = resolved.filter((signal) => signal.outcome === "WIN").length;
  const losses = resolved.filter((signal) => signal.outcome === "LOSS").length;
  const breakeven = resolved.filter((signal) => signal.outcome === "BREAKEVEN").length;
  const values = resolved.map((signal) => Number(signal.resultR ?? 0));
  const grossProfitR = values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLossR = Math.abs(values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const totalR = values.reduce((sum, value) => sum + value, 0);
  const profitFactor = grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? null : 0;
  const parameters = validationParameters();
  const maxDrawdownR = drawdown(values);
  const reasons: string[] = [];
  if (resolved.length < parameters.minimumResolvedProfile) reasons.push(`Needs ${parameters.minimumResolvedProfile - resolved.length} more resolved validation signals.`);
  if (resolved.length >= parameters.minimumResolvedProfile && totalR <= 0) reasons.push("Total R is not positive.");
  if (resolved.length >= parameters.minimumResolvedProfile && totalR / resolved.length <= 0) reasons.push("Expectancy is not positive.");
  if (resolved.length >= parameters.minimumResolvedProfile && profitFactor !== null && profitFactor < parameters.minimumProfitFactor) reasons.push(`Profit factor is below ${parameters.minimumProfitFactor}.`);
  if (resolved.length >= parameters.minimumResolvedProfile && wins / resolved.length < parameters.minimumWinRate) reasons.push(`Win rate is below ${(parameters.minimumWinRate * 100).toFixed(0)}%.`);
  if (resolved.length >= parameters.minimumResolvedProfile && maxDrawdownR > parameters.maximumDrawdownR) reasons.push(`Maximum drawdown exceeds ${parameters.maximumDrawdownR}R.`);
  return { partition, moduleCode, profileCode, sessions, signalCount: signals.length, resolvedCount: resolved.length, wins, losses, breakeven, signalsPerSession: sessions ? signals.length / sessions : 0, winRate: resolved.length ? wins / resolved.length : 0, grossProfitR, grossLossR, profitFactor, expectancyR: resolved.length ? totalR / resolved.length : 0, totalR, maxDrawdownR, eligible: resolved.length >= parameters.minimumResolvedProfile && reasons.length === 0, reasons };
}

async function persistSignals(runId: string, signals: Array<ReplaySignal & { partition: Partition }>) {
  for (const signal of signals) await client.query(
    `INSERT INTO strategy_validation_signals(run_id,partition,module_code,profile_code,thesis_key,session_date,detected_at,closed_at,direction,scenario,entry_price,stop_price,target_price,outcome,result_r,ambiguous,evidence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb) ON CONFLICT DO NOTHING`,
    [runId, signal.partition, signal.moduleCode, signal.profileCode, signal.thesisKey, signal.sessionDate, signal.detectedAt, signal.closedAt, signal.direction, signal.scenario, signal.entry, signal.stop, signal.target, signal.outcome, signal.resultR, signal.ambiguous, JSON.stringify(signal.evidence)]
  );
}

async function persistMetrics(runId: string, rows: MetricRow[]) {
  for (const row of rows) await client.query(
    `INSERT INTO strategy_validation_metrics(run_id,partition,module_code,profile_code,sessions,signal_count,resolved_count,wins,losses,breakeven,signals_per_session,win_rate,gross_profit_r,gross_loss_r,profit_factor,expectancy_r,total_r,max_drawdown_r,eligible,reasons)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
    [runId, row.partition, row.moduleCode, row.profileCode, row.sessions, row.signalCount, row.resolvedCount, row.wins, row.losses, row.breakeven, fixed(row.signalsPerSession), fixed(row.winRate, 6), fixed(row.grossProfitR), fixed(row.grossLossR), row.profitFactor == null ? null : fixed(row.profitFactor), fixed(row.expectancyR), fixed(row.totalR), fixed(row.maxDrawdownR), row.eligible, JSON.stringify(row.reasons)]
  );
}

async function persistReleaseGates(runId: string, datasetSessions: number, rows: MetricRow[]) {
  const parameters = validationParameters();
  for (const row of rows) {
    const sufficient = datasetSessions >= parameters.minimumDatasetSessions && row.resolvedCount >= parameters.minimumResolvedProfile;
    const status = !sufficient ? "INSUFFICIENT_DATA" : row.eligible ? "ELIGIBLE" : "BLOCKED";
    await client.query(
      `INSERT INTO strategy_release_gates(module_code,profile_code,validation_run_id,status,enforced,resolved_count,win_rate,profit_factor,expectancy_r,total_r,max_drawdown_r,reasons)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT(module_code,profile_code) DO UPDATE SET validation_run_id=EXCLUDED.validation_run_id,status=EXCLUDED.status,enforced=EXCLUDED.enforced,resolved_count=EXCLUDED.resolved_count,win_rate=EXCLUDED.win_rate,profit_factor=EXCLUDED.profit_factor,expectancy_r=EXCLUDED.expectancy_r,total_r=EXCLUDED.total_r,max_drawdown_r=EXCLUDED.max_drawdown_r,reasons=EXCLUDED.reasons,evaluated_at=now()`,
      [row.moduleCode, row.profileCode, runId, status, sufficient, row.resolvedCount, fixed(row.winRate, 6), row.profitFactor == null ? null : fixed(row.profitFactor), fixed(row.expectancyR), fixed(row.totalR), fixed(row.maxDrawdownR), JSON.stringify(row.reasons)]
    );
  }
}

async function reportValidation() {
  const latest = await client.query(`SELECT id FROM strategy_validation_runs WHERE status='COMPLETED' ORDER BY completed_at DESC LIMIT 1`);
  const runId = cliValue("--run") ?? latest.rows[0]?.id;
  if (!runId) throw new Error("No completed validation run exists.");
  const run = await client.query(`SELECT r.*,d.name AS dataset_name,d.session_count FROM strategy_validation_runs r JOIN strategy_validation_datasets d ON d.id=r.dataset_id WHERE r.id=$1`, [runId]);
  if (!run.rowCount) throw new Error(`Validation run '${runId}' was not found.`);
  const metrics = await client.query(`SELECT partition,module_code,profile_code,sessions,signal_count,resolved_count,wins,losses,win_rate,profit_factor,expectancy_r,total_r,max_drawdown_r,eligible,reasons FROM strategy_validation_metrics WHERE run_id=$1 ORDER BY partition,module_code,profile_code`, [runId]);
  const gates = await client.query(`SELECT module_code,profile_code,status,enforced,resolved_count,win_rate,profit_factor,expectancy_r,total_r,max_drawdown_r,reasons FROM strategy_release_gates WHERE validation_run_id=$1 ORDER BY module_code,profile_code`, [runId]);
  console.log(JSON.stringify({ run: run.rows[0], metrics: metrics.rows, releaseGates: gates.rows }, null, 2));
}

async function listDatasets() {
  const result = await client.query(`SELECT id,name,symbol,source,timeframe_minutes,status,candle_count,session_count,start_at,end_at,created_at FROM strategy_validation_datasets ORDER BY created_at DESC`);
  console.log(JSON.stringify(result.rows, null, 2));
}

function summarizeRun(dataset: any, trainDates: string[], validationDates: string[], signals: Array<ReplaySignal & { partition: Partition }>, metrics: MetricRow[]) {
  const minimum = validationParameters().minimumDatasetSessions;
  return { dataset: dataset.name, datasetSessions: Number(dataset.session_count), candles: Number(dataset.candle_count), split: { trainSessions: trainDates.length, trainStart: trainDates[0], trainEnd: trainDates.at(-1), validationSessions: validationDates.length, validationStart: validationDates[0], validationEnd: validationDates.at(-1) }, signals: { train: signals.filter((row) => row.partition === "TRAIN").length, validation: signals.filter((row) => row.partition === "VALIDATION").length }, validationMetrics: metrics.filter((row) => row.partition === "VALIDATION"), warning: Number(dataset.session_count) < minimum ? `Dataset has ${dataset.session_count} sessions; collect at least ${minimum} before enforcing release decisions.` : null, liveCacheTouched: false };
}

function validationParameters() {
  return { minimumDatasetSessions: Number(process.env.VALIDATION_MINIMUM_DATASET_SESSIONS ?? 60), minimumResolvedProfile: Number(process.env.VALIDATION_MINIMUM_RESOLVED_PROFILE ?? 30), minimumProfitFactor: Number(process.env.VALIDATION_MINIMUM_PROFIT_FACTOR ?? 1.2), minimumWinRate: Number(process.env.VALIDATION_MINIMUM_WIN_RATE ?? 0.4), maximumDrawdownR: Number(process.env.VALIDATION_MAXIMUM_DRAWDOWN_R ?? 10), outcomePolicy: "STOP_FIRST_IF_SAME_CANDLE" };
}

function dedupeModuleSignals(signals: ReplaySignal[]) {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = signal.moduleCode === "high_probability_strategy_2" ? signal.thesisKey.replace(`:${signal.profileCode}:`, ":") : signal.thesisKey;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCandleFile(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) throw new Error(`Import file not found: ${path}`);
  const content = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (extname(path).toLowerCase() === ".json") {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new Error("JSON import must be an array of candle objects.");
    return parsed;
  }
  const rows = parseCsv(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).filter((row) => row.some((value) => value.trim())).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function parseCsv(input: string) {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') { if (quoted && input[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted; }
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && input[index + 1] === "\n") index += 1; row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  return rows;
}

function normalizeImportedCandle(row: Record<string, unknown>, line: number): Candle {
  const timestamp = parseTimestamp(String(pick(row, ["timestamp_utc", "timestamp", "datetime", "date", "time"]) ?? ""));
  const open = numeric(pick(row, ["open", "o"]), `open at line ${line}`); const high = numeric(pick(row, ["high", "h"]), `high at line ${line}`);
  const low = numeric(pick(row, ["low", "l"]), `low at line ${line}`); const close = numeric(pick(row, ["close", "c"]), `close at line ${line}`);
  if (!timestamp) throw new Error(`Invalid timestamp at line ${line}; use ISO-8601 UTC.`);
  if (Math.max(open, close, low) > high || Math.min(open, close, high) < low || low <= 0) throw new Error(`Invalid OHLC geometry at line ${line}.`);
  const volume = pick(row, ["volume", "v"]); const spread = pick(row, ["spread"]);
  return { timestampUtc: timestamp, open, high, low, close, volume: blank(volume) ? null : numeric(volume, `volume at line ${line}`), spread: blank(spread) ? null : numeric(spread, `spread at line ${line}`) };
}

function aggregateCandles(candles: Candle[], targetMinutes: number): Candle[] {
  const buckets = new Map<number, Candle[]>(); const bucketMs = targetMinutes * 60_000;
  for (const candle of candles) { const bucket = Math.floor(new Date(candle.timestampUtc).getTime() / bucketMs) * bucketMs; buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]); }
  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([time, rows]) => ({ timestampUtc: new Date(time).toISOString(), open: rows[0].open, high: Math.max(...rows.map((item) => item.high)), low: Math.min(...rows.map((item) => item.low)), close: rows.at(-1)!.close, volume: rows.some((item) => item.volume != null) ? rows.reduce((sum, item) => sum + Number(item.volume ?? 0), 0) : null, spread: rows.at(-1)?.spread ?? null }));
}

function module1Config(raw: any): StrategyConfiguration {
  return { name: "Module 1 NY ORB MAX", version: String(raw?.version ?? "historical-validation"), status: "ACTIVE", symbol: "XAUUSD", timezone: "America/New_York", sessionStart: "09:15", openingRangeMinutes: 15, signalTimeframeMinutes: 5, tradeWindowEnd: "16:00", enabledScenarios: raw?.enabledScenarios ?? { doubleSidedSweep: "BLOCK_CONTINUATION" }, breakout: { requireCompletedCandle: true, requireCloseOutside: true, allowWickOnly: false, minimumBodyRatio: 0.45, minimumCloseLocationRatio: 0.65, maximumEntryExtensionPercentOfRange: 1, ...(raw?.breakout ?? {}) }, retest: { enabled: true, zonePercentOfRange: 0.1, maximumCandles: 6, confirmationRequired: false, ...(raw?.retest ?? {}) }, rangeFilter: { mode: "OFF", minimumWidth: null, maximumWidth: null, ...(raw?.rangeFilter ?? {}) }, newsFilter: { enabled: false, mode: "OFF", manualEvents: false, ...(raw?.newsFilter ?? {}) }, risk: { riskPerTradePercent: 0.25, maximumDailyLossPercent: 0.75, maximumWeeklyLossPercent: 2, maximumConsecutiveLosses: 99, mandatoryStopLoss: true, minimumRewardToRisk: 1.5, allowMartingale: false, allowAddingToLoss: false, ...(raw?.risk ?? {}), maximumTradesPerSession: 99 }, favorability: { minimumScoreForPaperTrade: 80, preferredSpreadPercentOfRange: 0.12, minimumAtrPercentOfRange: 0.1, ...(raw?.favorability ?? {}) }, paperTrading: { enabled: true, conservativeSameCandleExit: true, ...(raw?.paperTrading ?? {}), maximumTradesPerSession: 99 } };
}

async function strategyConfiguration(moduleCode: ModuleCode) { const result = await client.query(`SELECT configuration_json FROM strategy_versions WHERE configuration_json->>'moduleCode'=$1 AND status='ACTIVE' ORDER BY activated_at DESC NULLS LAST,created_at DESC LIMIT 1`, [moduleCode]); return result.rows[0]?.configuration_json ?? {}; }
function module1ScenarioFamily(scenario: string) { const value = scenario.toUpperCase(); if (value.includes("HORIZONTAL")) return "HORIZONTAL_RANGE_BREAKOUT"; if (value.includes("OPENING_DRIVE")) return "OPENING_DRIVE"; if (value.includes("LIQUIDITY_SWEEP")) return "LIQUIDITY_SWEEP_REVERSAL"; if (value.includes("RETEST")) return "BREAKOUT_RETEST"; return "ORB_BREAKOUT"; }
function validGeometry(direction: Direction, entryValue: unknown, stopValue: unknown, targetValue: unknown) { const entry = Number(entryValue); const stop = Number(stopValue); const target = Number(targetValue); return [entry, stop, target].every(Number.isFinite) && (direction === "LONG" ? stop < entry && entry < target : target < entry && entry < stop); }
function drawdown(values: number[]) { let equity = 0; let peak = 0; let maximum = 0; for (const value of values) { equity += value; peak = Math.max(peak, equity); maximum = Math.max(maximum, peak - equity); } return maximum; }
function upperBoundTimestamp(candles: Candle[], timestamp: string) { let low = 0; let high = candles.length; while (low < high) { const middle = Math.floor((low + high) / 2); if (candles[middle].timestampUtc <= timestamp) low = middle + 1; else high = middle; } return low; }
function toCandle(row: any): Candle { return { timestampUtc: new Date(row.timestamp_utc).toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume == null ? null : Number(row.volume), spread: row.spread == null ? null : Number(row.spread) }; }
function nyParts(timestamp: string) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp)); }
function nyDate(timestamp: string) { const parts = nyParts(timestamp); return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`; }
function nyMinutes(timestamp: string) { const parts = nyParts(timestamp); return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0); }
function betweenNy(timestamp: string, start: string, end: string) { const value = nyMinutes(timestamp); return value >= timeMinutes(start) && value <= timeMinutes(end); }
function timeMinutes(value: string) { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; }
function isWeekday(date: string) { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return day !== 0 && day !== 6; }
function candleAtNy(date: string, time: string) { const sample = new Date(`${date}T12:00:00Z`); const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(sample).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "-04:00"; return new Date(`${date}T${time}:00${offset}`).toISOString(); }
function normalizeHeader(value: string) { return value.trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function pick(row: Record<string, unknown>, keys: string[]) { return keys.find((key) => key in row) ? row[keys.find((key) => key in row)!] : undefined; }
function blank(value: unknown) { return value == null || String(value).trim() === ""; }
function numeric(value: unknown, label: string) { const number = Number(value); if (!Number.isFinite(number)) throw new Error(`Invalid ${label}.`); return number; }
function parseTimestamp(value: string) { const trimmed = value.trim(); if (!trimmed) return null; const postgresOffset = trimmed.replace(/([+-]\d{2})$/, "$1:00"); const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(postgresOffset) ? postgresOffset.replace(" ", "T") : `${postgresOffset.replace(" ", "T")}Z`; const date = new Date(normalized); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function fixed(value: number, decimals = 4) { return Number(value.toFixed(decimals)); }
function positiveInteger(value: string, label: string) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`); return number; }
function boundedNumber(value: string, minimum: number, maximum: number, label: string) { const number = Number(value); if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`); return number; }
function cliValue(flag: string) { const inline = process.argv.find((value) => value.startsWith(`${flag}=`)); if (inline) return inline.slice(flag.length + 1); const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : undefined; }
function requiredCliValue(flag: string) { const value = cliValue(flag); if (!value) throw new Error(`${flag} is required.`); return value; }
function localDatabaseUrl() { const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "orb_password"); return `postgres://${process.env.POSTGRES_USER ?? "orb_user"}:${password}@${process.env.POSTGRES_HOST ?? "localhost"}:${process.env.POSTGRES_PORT ?? "5433"}/${process.env.POSTGRES_DB ?? "orb_guide"}`; }
function loadEnv(path: string) { if (!existsSync(path)) return; for (const line of readFileSync(path, "utf8").split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue; const separator = trimmed.indexOf("="); if (separator <= 0) continue; const key = trimmed.slice(0, separator).trim(); const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""); if (!(key in process.env)) process.env[key] = value; } }
function usage(): never { console.error("Usage: validation:history -- import --file candles.csv --name xauusd-history | run --dataset xauusd-history | report [--run UUID] | list"); process.exit(2); }
