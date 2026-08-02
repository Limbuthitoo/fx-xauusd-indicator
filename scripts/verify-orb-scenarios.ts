import assert from "node:assert/strict";
import { buildOpeningRange, evaluateSetup } from "../packages/strategy-engine/src/index.js";
import type { Candle, StrategyConfiguration, TradingSession } from "../packages/shared-types/src/index.js";

const configuration: StrategyConfiguration = {
  name: "Scenario verifier",
  version: "0",
  status: "RESEARCH",
  symbol: "XAUUSD",
  timezone: "America/New_York",
  sessionStart: "09:30",
  openingRangeMinutes: 15,
  signalTimeframeMinutes: 15,
  tradeWindowEnd: "16:00",
  enabledScenarios: {
    cleanBreakout: true,
    breakoutRetest: true,
    failedBreakoutReversal: true,
    midpointReaction: "RECORD_ONLY",
    doubleSidedSweep: "BLOCK_CONTINUATION",
    chopDetection: true
  },
  breakout: {
    requireCompletedCandle: true,
    requireCloseOutside: true,
    allowWickOnly: false,
    minimumBodyRatio: 0.55,
    minimumCloseLocationRatio: 0.65,
    maximumEntryExtensionPercentOfRange: 0.25
  },
  retest: { enabled: true, zonePercentOfRange: 0.1, maximumCandles: 6, confirmationRequired: true },
  rangeFilter: { mode: "WARN_ONLY", minimumWidth: null, maximumWidth: null },
  newsFilter: { enabled: true, mode: "BLOCK", manualEvents: true },
  risk: {
    riskPerTradePercent: 0.25,
    maximumDailyLossPercent: 0.75,
    maximumWeeklyLossPercent: 2,
    maximumTradesPerSession: 1,
    maximumConsecutiveLosses: 3,
    mandatoryStopLoss: true,
    minimumRewardToRisk: 1.5,
    allowMartingale: false,
    allowAddingToLoss: false
  },
  favorability: {
    minimumScoreForPaperTrade: 70,
    minimumTrendLookbackCandles: 50,
    preferredSpreadPercentOfRange: 0.12,
    minimumAtrPercentOfRange: 0.4
  },
  paperTrading: { enabled: true, maximumTradesPerSession: 1, conservativeSameCandleExit: true }
};

const session: TradingSession = {
  id: "scenario-session",
  symbol: "XAUUSD",
  strategyVersionId: "scenario-version",
  sessionDate: "2026-07-31",
  sessionPreset: "NY_0930",
  state: "WAITING_FOR_SETUP",
  sessionStartAt: "2026-07-31T13:30:00Z",
  openingRangeEndAt: "2026-07-31T13:45:00Z",
  signalWindowEndAt: "2026-07-31T20:00:00Z",
  dataStatus: "VALID"
};

const openingRange = buildOpeningRange(
  [{ timestampUtc: "2026-07-31T13:30:00Z", open: 100, high: 110, low: 90, close: 104, spread: 0.2 }],
  0.01,
  1
);

const trendUp = Array.from({ length: 50 }, (_, index) =>
  candle(`2026-07-31T12:${String(index).padStart(2, "0")}:00Z`, 96 + index * 0.2, 98 + index * 0.2, 95 + index * 0.2, 97 + index * 0.2)
);

const trendDown = Array.from({ length: 50 }, (_, index) =>
  candle(`2026-07-31T12:${String(index).padStart(2, "0")}:00Z`, 114 - index * 0.2, 115 - index * 0.2, 112 - index * 0.2, 113 - index * 0.2)
);

const cases = [
  {
    name: "inside range waits",
    previous: [],
    current: candle("2026-07-31T14:00:00Z", 101, 108, 96, 106),
    scenario: "INSIDE_RANGE_WAIT",
    status: "WAIT"
  },
  {
    name: "opening drive clean breakout buys",
    previous: trendUp,
    current: candle("2026-07-31T14:00:00Z", 107, 114, 106, 113),
    scenario: "OPENING_DRIVE_CLEAN_BREAKOUT",
    status: "LONG SETUP READY"
  },
  {
    name: "trend aligned clean breakout buys later",
    previous: trendUp,
    current: candle("2026-07-31T14:45:00Z", 108, 114, 107, 113),
    scenario: "DISPLACEMENT_CLEAN_BREAKOUT",
    status: "LONG SETUP READY"
  },
  {
    name: "overextended breakout is not chased",
    previous: trendUp,
    current: candle("2026-07-31T14:00:00Z", 111, 125, 110, 124),
    scenario: "OVEREXTENDED_BREAKOUT_NO_TRADE",
    status: "WAIT FOR RETEST"
  },
  {
    name: "fakeout records reversal candidate",
    previous: [],
    current: candle("2026-07-31T14:00:00Z", 108, 112, 100, 105),
    scenario: "FAKEOUT_REVERSAL_CANDIDATE",
    status: "REVERSAL CANDIDATE"
  },
  {
    name: "liquidity sweep reversal sells",
    previous: [...trendDown, candle("2026-07-31T14:00:00Z", 108, 112, 100, 104)],
    current: candle("2026-07-31T14:15:00Z", 94, 95, 86, 87),
    scenario: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED",
    status: "SHORT SETUP READY"
  },
  {
    name: "breakout retest confirmation buys",
    previous: [...trendUp, candle("2026-07-31T14:00:00Z", 107, 114, 106, 113)],
    current: candle("2026-07-31T14:15:00Z", 111, 113, 110.5, 112.8),
    scenario: "BREAKOUT_RETEST_CONFIRMED",
    status: "LONG SETUP READY"
  },
  {
    name: "double-sided sweep without outside close blocks",
    previous: [candle("2026-07-31T14:00:00Z", 100, 112, 99, 105)],
    current: candle("2026-07-31T14:15:00Z", 105, 106, 88, 95),
    scenario: "DOUBLE_SIDED_SWEEP",
    status: "NO TRADE"
  }
] as const;

for (const testCase of cases) {
  const decision = evaluateSetup({
    now: testCase.current.timestampUtc,
    symbol: "XAUUSD",
    strategyVersionId: "scenario-version",
    session,
    openingRange,
    currentCandle: testCase.current,
    previousCandles: testCase.previous,
    spread: testCase.current.spread ?? undefined,
    newsStatus: "CLEAR",
    riskStatus: "PERMITTED",
    configuration
  });
  assert.equal(decision.scenario, testCase.scenario, `${testCase.name}: scenario`);
  assert.equal(decision.status, testCase.status, `${testCase.name}: status`);
  if (decision.status === "LONG SETUP READY" || decision.status === "SHORT SETUP READY") {
    assert.equal(
      decision.evaluations.every((evaluation) => evaluation.status === "PASS" || evaluation.status === "NOT_APPLICABLE"),
      true,
      `${testCase.name}: ready setup must have a fully matched checklist`
    );
  }
  console.log(`${testCase.name}: ${decision.scenario} / ${decision.status} / score ${decision.favorabilityScore}`);
}

function candle(timestampUtc: string, open: number, high: number, low: number, close: number): Candle {
  return { timestampUtc, open, high, low, close, spread: 0.2 };
}
