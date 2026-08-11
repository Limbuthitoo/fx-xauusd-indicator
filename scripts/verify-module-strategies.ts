import assert from "node:assert/strict";
import { buildOpeningRange, evaluateSetup } from "../packages/strategy-engine/src/index.js";
import { evaluateLiquiditySweepSetup } from "../packages/liquidity-sweep-engine/src/index.js";
import {
  FalseBreakoutEngine,
  HorizontalRangeDetector,
  MaxOptionsOrbRangeDetector,
  RangeConflictResolver,
  RangeDecisionEngine,
  RetestEngine,
  evaluateRangeBreakout
} from "../packages/range-engine/src/index.js";
import type { Candle } from "../packages/shared-types/src/index.js";
import { calculateCatchupRequestCount, isModule1ActiveOrbPreset, isNewYorkWeekend, isScheduledTwelveDataTrigger, sharedNewYorkFeedWindow } from "../apps/api/src/modules/market-data/routes.js";

const module1OpeningCandles: Candle[] = [
  candle("2026-08-10T13:30:00Z", 100.0, 100.8, 99.4, 100.5),
  candle("2026-08-10T13:35:00Z", 100.5, 101.0, 99.8, 100.1),
  candle("2026-08-10T13:40:00Z", 100.1, 100.7, 99.6, 100.2)
];
const module1Range = buildOpeningRange(module1OpeningCandles, 0.01, 3);
const module1Signal = candle("2026-08-10T13:45:00Z", 100.8, 101.9, 100.7, 101.55);
const module1 = evaluateSetup({
  now: module1Signal.timestampUtc,
  symbol: "XAUUSD",
  strategyVersionId: "module1-contract",
  session: {
    id: "module1-session",
    symbol: "XAUUSD",
    strategyVersionId: "module1-contract",
    sessionDate: "2026-08-10",
    sessionPreset: "NEW_YORK_ORB",
    state: "OPENING_RANGE_LOCKED",
    sessionStartAt: "2026-08-10T13:30:00Z",
    openingRangeEndAt: "2026-08-10T13:45:00Z",
    signalWindowEndAt: "2026-08-10T20:00:00Z",
    dataStatus: "READY"
  },
  openingRange: module1Range,
  currentCandle: module1Signal,
  previousCandles: [],
  spread: 0.01,
  newsStatus: "CLEAR",
  riskStatus: "PERMITTED",
  configuration: {
    name: "Module 1 ORB",
    version: "module1-contract",
    status: "ACTIVE",
    symbol: "XAUUSD",
    timezone: "America/New_York",
    sessionStart: "09:30",
    openingRangeMinutes: 15,
    signalTimeframeMinutes: 5,
    tradeWindowEnd: "16:00",
    enabledScenarios: { doubleSidedSweep: "BLOCK_CONTINUATION" },
    breakout: {
      requireCompletedCandle: true,
      requireCloseOutside: true,
      allowWickOnly: false,
      minimumBodyRatio: 0.45,
      minimumCloseLocationRatio: 0.65,
      maximumEntryExtensionPercentOfRange: 1
    },
    retest: {
      enabled: true,
      zonePercentOfRange: 0.1,
      maximumCandles: 6,
      confirmationRequired: false
    },
    rangeFilter: {
      mode: "OFF",
      minimumWidth: null,
      maximumWidth: null
    },
    newsFilter: {
      enabled: false,
      mode: "OFF",
      manualEvents: false
    },
    risk: {
      riskPerTradePercent: 1,
      maximumDailyLossPercent: 3,
      maximumWeeklyLossPercent: 6,
      maximumTradesPerSession: 1,
      maximumConsecutiveLosses: 2,
      mandatoryStopLoss: true,
      minimumRewardToRisk: 2,
      allowMartingale: false,
      allowAddingToLoss: false
    },
    favorability: {
      minimumScoreForPaperTrade: 0,
      preferredSpreadPercentOfRange: 0.12,
      minimumAtrPercentOfRange: 0.1
    },
    paperTrading: {
      enabled: true,
      maximumTradesPerSession: 1,
      conservativeSameCandleExit: true
    }
  }
});
assert.equal(module1Range.status, "LOCKED", "Module 1 opening range must lock from three 5m candles");
assert.equal(isModule1ActiveOrbPreset("NEW_YORK_ORB"), true, "Module 1 must actively evaluate New York ORB");
assert.equal(isModule1ActiveOrbPreset("LONDON_ORB"), false, "Module 1 must not actively evaluate London ORB");
assert.equal(module1.status, "LONG SETUP READY", `Module 1 should produce a long setup, got ${module1.scenario}: ${module1.finalReason}`);
assert.equal((module1.scenarioFlags.matrix as any)?.mandatoryChecklistMatched, true, "Module 1 mandatory checklist must be complete");
assertTradePlan(module1, "LONG", "Module 1");
const orbDetector = new MaxOptionsOrbRangeDetector();
const orbRangeResult = orbDetector.detect({
  symbol: "XAUUSD",
  now: module1Signal.timestampUtc,
  timezone: "America/New_York",
  candles5m: module1OpeningCandles,
  sessionContext: {
    sessionName: "New York",
    sessionTimezone: "America/New_York",
    rangeStart: "2026-08-10T13:30:00Z",
    rangeEnd: "2026-08-10T13:45:00Z",
    signalWindowEnd: "2026-08-10T20:00:00Z"
  },
  activeRanges: [],
  strategyVersion: "module1-contract"
});
assert.equal(orbRangeResult.status, "VALID", "ORB adapter must produce a valid normalized TradingRange");
assert.equal(orbRangeResult.range?.source, "MAX_OPTIONS_NY_ORB", "ORB adapter must preserve time-based ORB source");
assert.equal(orbRangeResult.range?.detectorVersion, "ORB_ADAPTER_V1", "ORB adapter must keep the ORB detector version");
assert.equal(orbRangeResult.range?.high, module1Range.high, "ORB adapter high must match old ORB");
assert.equal(orbRangeResult.range?.low, module1Range.low, "ORB adapter low must match old ORB");
assert.equal(orbRangeResult.range?.midpoint, module1Range.midpoint, "ORB adapter midpoint must match old ORB");
const orbBreakout = evaluateRangeBreakout(orbRangeResult.range!, module1Signal, { source: "MAX_OPTIONS_NY_ORB", requireCompletedCandle: true, requireCloseOutside: true, minimumBodyRatio: 0.45, minimumCloseLocationRatio: 0.6, maximumOppositeWickRatio: 1, minimumBreakDistanceAtr: 0, maximumDirectEntryExtensionRatio: 1, entryModel: "SOURCE_SPECIFIC", stopModel: "SOURCE_SPECIFIC", targetModel: "SOURCE_SPECIFIC" });
assert.equal(orbBreakout.confirmed, true, "Generic breakout engine must confirm the same ORB breakout candle");
const orbDecision = new RangeDecisionEngine().decide({ range: orbRangeResult.range!, breakout: orbBreakout, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(orbDecision.status, "BUY_READY", "Generic decision engine must produce BUY_READY for valid ORB long breakout");

const horizontalCandles = [
  candle("2026-08-10T09:00:00Z", 100.0, 101.0, 99.0, 100.2),
  candle("2026-08-10T09:05:00Z", 100.2, 100.8, 99.2, 99.8),
  candle("2026-08-10T09:10:00Z", 99.8, 100.9, 99.1, 100.3),
  candle("2026-08-10T09:15:00Z", 100.3, 100.7, 99.3, 99.9),
  candle("2026-08-10T09:20:00Z", 99.9, 101.1, 99.0, 100.4),
  candle("2026-08-10T09:25:00Z", 100.4, 100.9, 99.2, 99.7),
  candle("2026-08-10T09:30:00Z", 99.7, 100.8, 99.1, 100.1),
  candle("2026-08-10T09:35:00Z", 100.1, 100.7, 99.2, 99.8),
  candle("2026-08-10T09:40:00Z", 99.8, 101.0, 99.0, 100.2),
  candle("2026-08-10T09:45:00Z", 100.2, 100.8, 99.1, 99.9),
  candle("2026-08-10T09:50:00Z", 99.9, 100.9, 99.2, 100.3),
  candle("2026-08-10T09:55:00Z", 100.3, 100.7, 99.1, 99.8)
];
const horizontalConfig = { enabled: true, observationOnly: true, timeframe: "5min" as const, minimumRangeCandles: 12, maximumRangeCandles: 12, minimumUpperTouches: 2, minimumLowerTouches: 2, minimumBarsBetweenTouches: 2, boundaryReactionCount: 3, boundaryToleranceAtr: 0.12, minimumContainmentRatio: 0.7, maximumEfficiencyRatio: 0.4, maximumBoundarySlopeAtrPerBar: 0.2, minimumWidthAtr: 0.5, maximumWidthAtr: 4, minimumMidpointCrosses: 2, minimumQualityScore: 60, lockAfterValidation: true, expireAfterCandles: 60 };
const horizontal = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: horizontalCandles.at(-1)!.timestampUtc,
  timezone: "America/New_York",
  candles5m: horizontalCandles,
  activeRanges: [],
  strategyVersion: "horizontal-observation"
});
assert.equal(horizontal.status, "VALID", "Horizontal detector must identify valid rectangular consolidation in observation mode");
assert.equal(horizontal.range?.formationMethod, "PRICE_BASED", "Horizontal range must remain price-based");
assert.equal(horizontal.range?.detectorVersion, "HORIZONTAL_RANGE_DETECTOR_V1", "Horizontal range must use the active detector version");
const trendingCandidate = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: "2026-08-10T10:00:00Z",
  timezone: "America/New_York",
  candles5m: Array.from({ length: 12 }, (_, index) => candle(at("2026-08-10T09:00:00Z", index), 100 + index * 0.4, 100.5 + index * 0.4, 99.8 + index * 0.4, 100.4 + index * 0.4)),
  activeRanges: [],
  strategyVersion: "horizontal-trend-rejection"
});
assert.equal(trendingCandidate.status, "NONE", "Horizontal detector must reject directional trends as non-horizontal structure");
assert.equal(trendingCandidate.evidence.structureClassification, "ASCENDING_CHANNEL", "Rejected trend must be classified instead of silently ignored");
assert.equal(trendingCandidate.failures.some((item) => item.ruleCode === "HORIZONTAL_STRUCTURE_CLASSIFICATION"), true, "Rejected horizontal candidates must expose a structure-classification rule");
const acceptedBreakoutCandidate = new HorizontalRangeDetector(horizontalConfig).detect({
  symbol: "XAUUSD",
  now: "2026-08-10T10:00:00Z",
  timezone: "America/New_York",
  candles5m: [...horizontalCandles.slice(0, 11), candle("2026-08-10T09:55:00Z", 100.3, 102.0, 99.2, 101.8)],
  activeRanges: [],
  strategyVersion: "horizontal-accepted-breakout-rejection"
});
assert.equal(acceptedBreakoutCandidate.status, "NONE", "Horizontal detector must reject ranges that already accepted a breakout close");
const wickFalseBreak = new FalseBreakoutEngine().evaluate(horizontal.range!, candle("2026-08-10T10:00:00Z", 100.2, horizontal.range!.high + 0.5, 99.8, horizontal.range!.high - 0.1));
assert.equal(wickFalseBreak.falseBreakout, true, "False-breakout engine must reject wick-only boundary breaks");
const retest = new RetestEngine().evaluate(horizontal.range!, "LONG", candle("2026-08-10T10:05:00Z", horizontal.range!.high - 0.1, horizontal.range!.high + 0.8, horizontal.range!.high - 0.2, horizontal.range!.high + 0.5));
assert.equal(retest.confirmed, true, "Retest engine must confirm a clean post-breakout boundary retest");
const expiredRetest = new RetestEngine().evaluate(
  horizontal.range!,
  "LONG",
  candle("2026-08-10T10:40:00Z", horizontal.range!.high + 1.6, horizontal.range!.high + 1.9, horizontal.range!.high + 1.4, horizontal.range!.high + 1.7),
  undefined,
  Array.from({ length: 8 }, (_, index) => candle(at("2026-08-10T10:00:00Z", index), horizontal.range!.high + 1.0, horizontal.range!.high + 1.4, horizontal.range!.high + 0.8, horizontal.range!.high + 1.2))
);
assert.equal(expiredRetest.status, "EXPIRED", "Horizontal breakout retest must expire after the configured candle limit");
const horizontalBreakout = evaluateRangeBreakout(horizontal.range!, candle("2026-08-10T10:05:00Z", horizontal.range!.high - 0.1, horizontal.range!.high + 0.8, horizontal.range!.high - 0.2, horizontal.range!.high + 0.5));
const expiredDecision = new RangeDecisionEngine().decide({ range: horizontal.range!, breakout: { ...horizontalBreakout, directEntryBlocked: true }, retest: expiredRetest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(expiredDecision.status, "EXPIRED", "Expired horizontal retest must stop the MVP entry path");
const horizontalDecision = new RangeDecisionEngine().decide({ range: horizontal.range!, breakout: horizontalBreakout, retest, dataHealthy: true, riskPermitted: true, signalMode: "ACTIVE_SIGNAL" });
assert.equal(horizontalDecision.status, "BUY_READY", "Active horizontal range breakout/retest must be able to trigger the Module 1 MVP chain");
const conflict = new RangeConflictResolver().resolve([orbRangeResult.range!, horizontal.range!], "LONG");
assert.notEqual(conflict.status, "CONFLICT", "Aligned/same-direction range evidence must not block ORB");
const oppositeHorizontal = { ...horizontal.range!, id: `${horizontal.range!.id}:opposite`, breakoutDirection: "SHORT" as const };
const oppositeConflict = new RangeConflictResolver().resolve([{ ...horizontal.range!, breakoutDirection: "LONG" as const }, oppositeHorizontal], "LONG");
assert.equal(oppositeConflict.status, "CONFLICT", "Opposite-direction locked horizontal ranges must block duplicate MVP entries");

const module2Candles: Candle[] = Array.from({ length: 24 }, (_, index) => {
  const base = 103.6 + Math.sin(index / 2) * 0.35;
  return candle(at("2026-08-10T11:30:00Z", index), base, index === 10 ? 105 : base + 0.45, index === 18 ? 102.5 : base - 0.45, base + (index % 2 === 0 ? 0.12 : -0.12));
});
module2Candles.push(
  candle("2026-08-10T13:30:00Z", 104.6, 105.6, 103.8, 104.7),
  candle("2026-08-10T13:35:00Z", 104.6, 104.7, 102, 102.2),
  candle("2026-08-10T13:40:00Z", 102.1, 103.4, 101.8, 102.4),
  candle("2026-08-10T13:45:00Z", 103.3, 103.6, 102.7, 102.6)
);

const module2 = evaluateLiquiditySweepSetup({
  now: module2Candles.at(-1)!.timestampUtc,
  symbol: "XAUUSD",
  setupCandles: module2Candles,
  biasCandles: Array.from({ length: 30 }, (_, index) => candle(at("2026-08-10T06:00:00Z", index, 15), 110 - index * 0.2, 110.3 - index * 0.2, 109.5 - index * 0.2, 109.7 - index * 0.2)),
  spread: 0.01,
  newsStatus: "CLEAR",
  configuration: {
    minimumSweepDistanceATR: 0.05,
    maximumSweepDistanceATR: 2,
    minimumDisplacementRangeATR: 0.8,
    minimumBodyPercentage: 0.55,
    minimumBosCloseDistanceATR: 0,
    minimumFvgSizeATR: 0.05,
    minimumRiskReward: 0.01,
    maximumStopATR: 10,
    minimumSignalScore: 0,
    requireHtfBias: false
  }
});
assert.ok(["LONG SETUP READY", "SHORT SETUP READY"].includes(module2.status), `Module 2 should produce a selected-variant setup, got ${module2.scenario}: ${module2.finalReason}`);
assert.equal(module2.scenarioFlags.mandatoryChecklistMatched, true, "Module 2 mandatory sequence must be complete");
assert.equal(Boolean((module2.scenarioFlags.sweep as any)?.level), true, "Module 2 must retain swept liquidity evidence");
assert.equal(Boolean((module2.scenarioFlags.module2Variant as any)?.paperEligible), true, "Module 2 must select one paper-approved variant");
assert.ok(
  new Date((module2.scenarioFlags.sweep as any).sweptAt).getTime() >= new Date((module2.scenarioFlags.sweep as any).level.confirmedAt).getTime(),
  "Module 2 must never use a sweep that occurred before its liquidity level was confirmed"
);
assertTradePlan(module2, module2.direction as "LONG" | "SHORT", "Module 2");
const module2OutsideNy = evaluateLiquiditySweepSetup({
  now: "2026-08-10T13:25:00Z",
  symbol: "XAUUSD",
  setupCandles: module2Candles.filter((row) => row.timestampUtc <= "2026-08-10T13:25:00Z"),
  biasCandles: [],
  configuration: { requireHtfBias: false }
});
assert.equal(module2OutsideNy.scenario, "SESSION_INACTIVE", "Module 2 must not evaluate entry profiles before the New York window");

assert.equal(calculateCatchupRequestCount({ latestAt: null, now: Date.now(), timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: true }), 2016);
assert.equal(calculateCatchupRequestCount({ latestAt: 0, now: 5 * 60_000, timeframeMinutes: 5, startupBackfillCount: 2016, firstWorkerSync: false }), 8);
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
  module1: { scenario: module1.scenario, direction: module1.direction, score: module1.favorabilityScore },
  module2: { scenario: module2.scenario, direction: module2.direction, score: module2.favorabilityScore },
  catchup: "startup=2016, 5-minute gap=8, 10-hour gap=122"
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
