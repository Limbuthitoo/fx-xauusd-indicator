import assert from "node:assert/strict";
import { evaluateLiquiditySweepSetup } from "../packages/liquidity-sweep-engine/src/index.js";
import type { Candle } from "../packages/shared-types/src/index.js";
import { calculateCatchupRequestCount, isNewYorkWeekend, isScheduledTwelveDataTrigger, sharedNewYorkFeedWindow } from "../apps/api/src/modules/market-data/routes.js";

const module2Candles: Candle[] = Array.from({ length: 24 }, (_, index) => {
  const base = 103.6 + Math.sin(index / 2) * 0.35;
  return candle(at("2026-08-10T11:30:00Z", index), base, index === 10 ? 105 : base + 0.45, index === 18 ? 102.5 : base - 0.45, base + (index % 2 === 0 ? 0.12 : -0.12));
});
module2Candles.push(
  candle("2026-08-10T13:30:00Z", 104.6, 105.6, 103.8, 104.7),
  candle("2026-08-10T13:35:00Z", 104.6, 104.7, 102, 102.2),
  candle("2026-08-10T13:40:00Z", 102.1, 103.4, 101.8, 102.4),
  candle("2026-08-10T13:45:00Z", 103.3, 103.6, 102.8, 102.9)
);

const module2 = evaluateLiquiditySweepSetup({
  now: module2Candles.at(-1)!.timestampUtc,
  symbol: "XAUUSD",
  setupCandles: module2Candles,
  biasCandles: Array.from({ length: 30 }, (_, index) => candle(at("2026-08-10T06:00:00Z", index, 15), 110 - index * 0.2, 110.3 - index * 0.2, 109.5 - index * 0.2, 109.7 - index * 0.2)),
  spread: 0.2,
  newsStatus: "CLEAR",
  configuration: {
    minimumSweepDistanceATR: 0.05,
    maximumSweepDistanceATR: 2,
    minimumDisplacementRangeATR: 0.8,
    minimumBodyPercentage: 0.55,
    minimumBosCloseDistanceATR: 0,
    minimumFvgSizeATR: 0.05,
    minimumRiskReward: 0.1,
    maximumStopATR: 10,
    minimumSignalScore: 0,
    requireHtfBias: false
  }
});
assert.equal(module2.status, "SHORT SETUP READY", `Module 2 should produce a short setup, got ${module2.scenario}: ${module2.finalReason}`);
assert.equal(module2.scenarioFlags.mandatoryChecklistMatched, true, "Module 2 mandatory sequence must be complete");
assert.equal((module2.scenarioFlags.sweep as any)?.level?.type, "LONDON_HIGH", "Module 2 must sweep the London high");
assert.equal((module2.scenarioFlags.bos as any)?.level != null, true, "Module 2 must retain BOS evidence");
assert.equal((module2.scenarioFlags.entryZone as any)?.kind, "FVG", "Module 2 must use the fresh FVG entry zone");
assertTradePlan(module2, "SHORT", "Module 2");
const module2OutsideNy = evaluateLiquiditySweepSetup({
  now: "2026-08-10T13:25:00Z",
  symbol: "XAUUSD",
  setupCandles: module2Candles.filter((row) => row.timestampUtc <= "2026-08-10T13:25:00Z"),
  biasCandles: [],
  configuration: { requireHtfBias: false }
});
assert.notEqual(module2OutsideNy.status, "SHORT SETUP READY", "Module 2 must not promote a pre-NY sweep");

assert.equal(calculateCatchupRequestCount({ latestAt: null, now: Date.now(), timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: true }), 2016);
assert.equal(calculateCatchupRequestCount({ latestAt: 0, now: 30 * 60_000, timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: false }), 8);
assert.equal(calculateCatchupRequestCount({ latestAt: 0, now: 10 * 60 * 60_000, timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: false }), 122);
assert.equal(isNewYorkWeekend("2026-08-08"), true, "Saturday must block shared polling and live strategy evaluation");
assert.equal(isNewYorkWeekend("2026-08-09"), true, "Sunday must block shared polling and live strategy evaluation");
assert.equal(isNewYorkWeekend("2026-08-10"), false, "Monday must remain eligible");
assert.equal(isScheduledTwelveDataTrigger("MARKET_DATA_WORKER"), true);
assert.equal(isScheduledTwelveDataTrigger("MARKET_DATA_CATCH_UP"), true);
assert.equal(isScheduledTwelveDataTrigger("TENANT_CHART_SYNC"), false, "Chart refresh must never call Twelve Data");
assert.equal(isScheduledTwelveDataTrigger("TENANT_BACKFILL"), false, "Tenant readiness must never call Twelve Data");
const summerFeedWindow = sharedNewYorkFeedWindow("2026-08-10");
assert.equal(summerFeedWindow.startAt, "2026-08-10T13:30:00.000Z", "Shared live polling starts at 09:30 New York");
assert.equal(summerFeedWindow.endAt, "2026-08-10T20:00:00.000Z", "Shared live polling ends at 16:00 New York");
console.log(JSON.stringify({
  status: "PASS",
  module2: { scenario: module2.scenario, direction: module2.direction, score: module2.favorabilityScore },
  catchup: "startup=2016, 30-minute gap=8, 10-hour gap=122"
}, null, 2));

function candle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  return { timestampUtc, open, high, low, close, volume: 100, spread: 0.2 };
}

function at(start: string, index: number, timeframeMinutes = 5) {
  return new Date(new Date(start).getTime() + index * timeframeMinutes * 60_000).toISOString();
}

function assertTradePlan(decision: any, direction: "LONG" | "SHORT", moduleName: string) {
  assert.equal(decision.direction, direction, `${moduleName} direction`);
  assert.equal(Number.isFinite(decision.entryPrice), true, `${moduleName} entry`);
  assert.equal(Number.isFinite(decision.stopPrice), true, `${moduleName} stop`);
  assert.equal(Number.isFinite(decision.targetPrice), true, `${moduleName} target`);
  if (direction === "LONG") {
    assert.equal(decision.stopPrice < decision.entryPrice, true, `${moduleName} long stop below entry`);
    assert.equal(decision.targetPrice > decision.entryPrice, true, `${moduleName} long target above entry`);
  } else {
    assert.equal(decision.stopPrice > decision.entryPrice, true, `${moduleName} short stop above entry`);
    assert.equal(decision.targetPrice < decision.entryPrice, true, `${moduleName} short target below entry`);
  }
}
