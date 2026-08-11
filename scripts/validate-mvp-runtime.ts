import { existsSync, readFileSync } from "node:fs";
import pg from "pg";
import { buildOpeningRange, evaluateSetup } from "../packages/strategy-engine/src/index.js";
import { evaluateLiquiditySweepSetup } from "../packages/liquidity-sweep-engine/src/index.js";
import type { Candle, StrategyConfiguration } from "../packages/shared-types/src/index.js";

loadEnv(process.argv[2] ?? ".env.production");

const databaseUrl = process.env.DATABASE_URL ?? localDatabaseUrl();
const client = new pg.Client({ connectionString: databaseUrl });
const checks: Array<{ name: string; status: "PASS" | "WARN" | "FAIL"; detail: string; evidence?: unknown }> = [];

try {
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

  const failureWindowMinutes = Math.min(1_440, Math.max(1, Number(process.env.MVP_FAILURE_WINDOW_MINUTES ?? 5)));
  const recentFailures = await rows(
    `SELECT event_type, tenant_id, created_at, metadata->>'moduleCode' AS module_code, metadata->>'error' AS error
     FROM operational_events
     WHERE created_at >= now() - ($1::int * interval '1 minute')
       AND event_type IN ('STRATEGY_EVALUATION_FAILED', 'MAIN_BRAIN_FAILED')
     ORDER BY created_at DESC
     LIMIT 50`,
    [failureWindowMinutes]
  );
  checks.push({
    name: "Recent strategy/brain failures",
    status: recentFailures.length === 0 ? "PASS" : "FAIL",
    detail: recentFailures.length === 0 ? `No strategy or Python brain failures in the last ${failureWindowMinutes} minutes.` : `${recentFailures.length} strategy/Python failure event(s) occurred in the last ${failureWindowMinutes} minutes.`,
    evidence: recentFailures.slice(0, 10)
  });

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
  checks.push({
    name: "Saved XAUUSD candles",
    status: candles.length >= 100 && biasCandles.length >= 30 ? "PASS" : "FAIL",
    detail: `${candles.length} completed 5M and ${biasCandles.length} completed 15M candles are available.`
  });

  const replayDays = Math.min(5, Math.max(1, Number(process.env.MVP_REPLAY_DAYS ?? 2)));
  const dates = [...new Set(candles.map((candle) => nyDate(candle.timestampUtc)))].filter(isWeekday).slice(-replayDays);
  const [module1Config, module2Config] = await Promise.all([
    strategyConfiguration("orb_max_options"),
    strategyConfiguration("high_probability_strategy_2")
  ]);
  const replay = dates.map((date) => ({
    date,
    module1: replayModule1(date, candles, module1Config),
    module2: replayModule2(date, candles, biasCandles, module2Config)
  }));
  const sessionsWithSignal = replay.filter((row) => row.module1.ready > 0 || row.module2.ready > 0).length;
  checks.push({
    name: "Saved-candle NY opportunity replay",
    status: replay.length === 0 ? "FAIL" : sessionsWithSignal > 0 ? "PASS" : "WARN",
    detail: `${sessionsWithSignal}/${replay.length} saved NY session(s) contained at least one deterministic Module 1/2 setup. This is opportunity evidence, not a promised trade count.`,
    evidence: replay
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

  const artifactWindowHours = Math.min(168, Math.max(1, Number(process.env.MVP_ARTIFACT_WINDOW_HOURS ?? 24)));
  const chain = await rows(
    `SELECT sc.module_code,
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
       AND sc.detected_at >= now() - ($1::int * interval '1 hour')
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay','false') <> 'true'
     GROUP BY sc.module_code
     ORDER BY sc.module_code`,
    [artifactWindowHours]
  );
  const artifactGaps = chain.filter((row: any) => Number(row.ready_setups) > 0 && (Number(row.notifications) === 0 || Number(row.paper_trades) === 0));
  const readyArtifactCount = chain.reduce((total: number, row: any) => total + Number(row.ready_setups ?? 0), 0);
  checks.push({
    name: "Recent MVP artifact chain",
    status: artifactGaps.length > 0 ? "FAIL" : readyArtifactCount > 0 ? "PASS" : "WARN",
    detail: artifactGaps.length > 0
      ? `${artifactGaps.length} module(s) produced ready setups without the required notification/paper-tracking artifacts.`
      : readyArtifactCount > 0
        ? `Recent setup, notification, and paper-tracking artifacts are connected within the last ${artifactWindowHours} hours.`
        : `No production-ready setup was recorded in the last ${artifactWindowHours} hours; wait for a valid completed 5M setup before final artifact proof.`,
    evidence: chain
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
  if (opening.length < 3) return { ready: 0, status: "MISSING_OPENING_RANGE", candles: session.length };
  const range = buildOpeningRange(opening, 0.01, 3);
  const configuration = module1Config(rawConfiguration);
  const previous: Candle[] = [];
  const ready: any[] = [];
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
    if (["LONG SETUP READY", "SHORT SETUP READY"].includes(decision.status)) {
      ready.push({ at: candle.timestampUtc, direction: decision.direction, scenario: decision.scenario, score: decision.favorabilityScore, entry: decision.entryPrice, stop: decision.stopPrice, target: decision.targetPrice });
      break;
    }
    previous.push(candle);
  }
  return { ready: ready.length, range: { high: range.high, low: range.low }, signals: ready };
}

function replayModule2(date: string, candles: Candle[], biasCandles: Candle[], rawConfiguration: any) {
  const candidates = candles.filter((candle) => nyDate(candle.timestampUtc) === date && nyMinutes(candle.timestampUtc) >= 9 * 60 + 30 && nyMinutes(candle.timestampUtc) <= 16 * 60);
  const ready: any[] = [];
  for (const current of candidates) {
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
      configuration: { ...(rawConfiguration ?? {}), newYorkStartTime: "09:30", newYorkEndTime: "16:00", maximumTradesPerSession: 1 }
    });
    if (["LONG SETUP READY", "SHORT SETUP READY"].includes(decision.status)) {
      ready.push({ at: current.timestampUtc, direction: decision.direction, scenario: decision.scenario, score: decision.favorabilityScore, entry: decision.entryPrice, stop: decision.stopPrice, target: decision.targetPrice, variant: (decision.scenarioFlags.module2Variant as any)?.code ?? null });
      break;
    }
  }
  return { ready: ready.length, signals: ready };
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
    risk: { riskPerTradePercent: 0.25, maximumDailyLossPercent: 0.75, maximumWeeklyLossPercent: 2, maximumTradesPerSession: 1, maximumConsecutiveLosses: 3, mandatoryStopLoss: true, minimumRewardToRisk: 1.5, allowMartingale: false, allowAddingToLoss: false, ...(raw?.risk ?? {}) },
    favorability: { minimumScoreForPaperTrade: 70, preferredSpreadPercentOfRange: 0.12, minimumAtrPercentOfRange: 0.1, ...(raw?.favorability ?? {}) },
    paperTrading: { enabled: true, maximumTradesPerSession: 1, conservativeSameCandleExit: true, ...(raw?.paperTrading ?? {}) }
  };
}

function toCandle(row: any): Candle {
  return { timestampUtc: new Date(row.timestamp_utc).toISOString(), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume == null ? null : Number(row.volume), spread: row.spread == null ? null : Number(row.spread) };
}

function nyParts(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp));
}

function nyDate(timestamp: string) {
  const parts = nyParts(timestamp);
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function nyMinutes(timestamp: string) {
  const parts = nyParts(timestamp);
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

function isWeekday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function candleAtNy(date: string, time: string) {
  const sample = new Date(`${date}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" }).formatToParts(sample).find((part) => part.type === "timeZoneName")?.value.replace("GMT", "") || "-04:00";
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
