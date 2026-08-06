import { evaluateMandatoryBreakoutRules } from "@orb-guide/rule-engine";
import type { Candle, Direction, OpeningRange, RuleContext, SetupDecision } from "@orb-guide/shared-types";

type FavorabilityGrade = "A" | "B" | "C" | "D";
type SweepSide = "HIGH" | "LOW";

interface BreakoutProfile {
  direction: Direction | null;
  outsideClose: boolean;
  extension: number;
  bodyRatio: number;
  closeLocationRatio: number;
  displacement: "STRONG" | "NORMAL" | "WEAK";
}

interface ScenarioSelection {
  scenario: string;
  status?: SetupDecision["status"];
  finalReason?: string;
  autoEligible: boolean;
  priority: number;
  tags: string[];
}

export function buildOpeningRange(candles: Candle[], tickSize: number, expectedCount: number): OpeningRange {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const candle of candles) {
    if (seen.has(candle.timestampUtc)) errors.push("DUPLICATE_CANDLES");
    seen.add(candle.timestampUtc);
    if (candle.high < candle.low || candle.high < candle.open || candle.high < candle.close || candle.low > candle.open || candle.low > candle.close) {
      errors.push("INVALID_OHLC");
    }
  }

  if (candles.length < expectedCount) errors.push("MISSING_CANDLES");
  if (errors.length > 0) {
    return {
      status: "INVALID",
      high: null,
      low: null,
      midpoint: null,
      width: null,
      widthTicks: null,
      sourceCandleCount: candles.length,
      dataQualityStatus: "INVALID",
      invalidReason: [...new Set(errors)].join(",")
    };
  }

  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const width = high - low;
  return {
    status: "LOCKED",
    high,
    low,
    midpoint: (high + low) / 2,
    width,
    widthTicks: tickSize > 0 ? width / tickSize : null,
    sourceCandleCount: candles.length,
    dataQualityStatus: "VALID",
    lockedAt: new Date().toISOString()
  };
}

function hasSweptBothSides(candles: Candle[], openingRange: OpeningRange) {
  if (openingRange.high == null || openingRange.low == null) return { swept: false };
  const high = openingRange.high;
  const low = openingRange.low;
  const highSweep = candles.find((candle) => candle.high > high);
  const lowSweep = candles.find((candle) => candle.low < low);
  return {
    swept: Boolean(highSweep && lowSweep),
    firstSide:
      highSweep && lowSweep ? (new Date(highSweep.timestampUtc) < new Date(lowSweep.timestampUtc) ? "HIGH" : "LOW") : null,
    highSweepTime: highSweep?.timestampUtc,
    lowSweepTime: lowSweep?.timestampUtc
  };
}

function sweptSide(candle: Candle, openingRange: OpeningRange): SweepSide | null {
  if (openingRange.high == null || openingRange.low == null) return null;
  if (candle.high > openingRange.high) return "HIGH";
  if (candle.low < openingRange.low) return "LOW";
  return null;
}

function lastSweep(candles: Candle[], openingRange: OpeningRange) {
  for (const candle of [...candles].reverse()) {
    const side = sweptSide(candle, openingRange);
    if (side) return { side, candle };
  }
  return null;
}

function midpointCrosses(candles: Candle[], midpoint: number | null) {
  if (midpoint == null || candles.length < 2) return 0;
  let crosses = 0;
  let previousSide = candles[0].close >= midpoint ? "ABOVE" : "BELOW";
  for (const candle of candles.slice(1)) {
    const side = candle.close >= midpoint ? "ABOVE" : "BELOW";
    if (side !== previousSide) crosses += 1;
    previousSide = side;
  }
  return crosses;
}

function failedBreakout(candles: Candle[], openingRange: OpeningRange) {
  if (openingRange.high == null || openingRange.low == null) return null;
  for (const candle of candles) {
    if (candle.high > openingRange.high && candle.close < openingRange.high && candle.close > openingRange.low) return "FAILED_BULLISH_BREAKOUT";
    if (candle.low < openingRange.low && candle.close > openingRange.low && candle.close < openingRange.high) return "FAILED_BEARISH_BREAKOUT";
  }
  return null;
}

function failedBreakoutDetails(candles: Candle[], openingRange: OpeningRange) {
  if (openingRange.high == null || openingRange.low == null) return null;
  for (const candle of [...candles].reverse()) {
    if (candle.high > openingRange.high && candle.close < openingRange.high && candle.close > openingRange.low) {
      return { type: "FAILED_BULLISH_BREAKOUT" as const, candle };
    }
    if (candle.low < openingRange.low && candle.close > openingRange.low && candle.close < openingRange.high) {
      return { type: "FAILED_BEARISH_BREAKOUT" as const, candle };
    }
  }
  return null;
}

function candleStats(candle: Candle, direction?: Direction | null) {
  const fullRange = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = fullRange > 0 ? body / fullRange : 0;
  const closeLocationRatio =
    fullRange > 0 && direction
      ? direction === "LONG"
        ? (candle.close - candle.low) / fullRange
        : (candle.high - candle.close) / fullRange
      : 0;
  return { fullRange, body, bodyRatio, closeLocationRatio };
}

function breakoutProfile(context: RuleContext, direction: Direction | null): BreakoutProfile {
  const { currentCandle, openingRange, configuration } = context;
  const stats = candleStats(currentCandle, direction);
  const boundary = direction === "LONG" ? openingRange.high : direction === "SHORT" ? openingRange.low : null;
  const extension = boundary == null ? 0 : Math.abs(currentCandle.close - boundary);
  const outsideClose = boundary == null ? false : direction === "LONG" ? currentCandle.close > boundary : currentCandle.close < boundary;
  const strong =
    stats.bodyRatio >= Math.max(0.7, configuration.breakout.minimumBodyRatio) &&
    stats.closeLocationRatio >= Math.max(0.8, configuration.breakout.minimumCloseLocationRatio);
  const weak =
    stats.bodyRatio < configuration.breakout.minimumBodyRatio ||
    stats.closeLocationRatio < configuration.breakout.minimumCloseLocationRatio;
  return {
    direction,
    outsideClose,
    extension,
    bodyRatio: Number(stats.bodyRatio.toFixed(3)),
    closeLocationRatio: Number(stats.closeLocationRatio.toFixed(3)),
    displacement: strong ? "STRONG" : weak ? "WEAK" : "NORMAL"
  };
}

function averageTrueRange(candles: Candle[], period: number) {
  if (candles.length < 2) return null;
  const sample = candles.slice(-period - 1);
  const ranges = sample.slice(1).map((candle, index) => {
    const previousClose = sample[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  if (ranges.length === 0) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function simpleAverage(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trendBias(candles: Candle[]) {
  const closes = candles.map((candle) => candle.close);
  const fast = simpleAverage(closes.slice(-20));
  const slow = simpleAverage(closes.slice(-50));
  if (fast == null || slow == null) return "NEUTRAL";
  if (fast > slow) return "BULLISH";
  if (fast < slow) return "BEARISH";
  return "NEUTRAL";
}

function retestState(candles: Candle[], openingRange: OpeningRange, direction: Direction) {
  if (openingRange.high == null || openingRange.low == null || openingRange.width == null) return null;
  const zone = openingRange.width * 0.1;
  const boundary = direction === "LONG" ? openingRange.high : openingRange.low;
  const prior = candles.slice(0, -1);
  const previousBreakout = prior.find((candle) => (direction === "LONG" ? candle.close > boundary : candle.close < boundary));
  const latest = candles.at(-1);
  if (!previousBreakout || !latest) return null;
  const lowerEdge = boundary - zone;
  const upperEdge = boundary + zone;
  const touchedZone = latest.low <= upperEdge && latest.high >= lowerEdge;
  const reclaimed = direction === "LONG" ? latest.close > boundary : latest.close < boundary;
  return touchedZone && reclaimed ? "RETEST_CONFIRMED" : touchedZone ? "RETEST_IN_PROGRESS" : null;
}

function retestDetails(candles: Candle[], openingRange: OpeningRange, direction: Direction) {
  if (openingRange.high == null || openingRange.low == null || openingRange.width == null) return null;
  const boundary = direction === "LONG" ? openingRange.high : openingRange.low;
  const zone = openingRange.width * 0.1;
  const prior = candles.slice(0, -1);
  const latest = candles.at(-1);
  if (!latest) return null;
  const breakoutIndex = prior.findIndex((candle) => (direction === "LONG" ? candle.close > boundary : candle.close < boundary));
  if (breakoutIndex < 0) return null;
  const touchedZone = latest.low <= boundary + zone && latest.high >= boundary - zone;
  const reclaimed = direction === "LONG" ? latest.close > boundary : latest.close < boundary;
  if (!touchedZone) return null;
  return {
    status: reclaimed ? ("RETEST_CONFIRMED" as const) : ("RETEST_IN_PROGRESS" as const),
    boundary,
    zone,
    candle: latest
  };
}

function roundPrice(value: number) {
  return Number(value.toFixed(5));
}

function buildTradePlan(
  context: RuleContext,
  direction: Direction,
  selection: ScenarioSelection,
  retest: ReturnType<typeof retestDetails>,
  priorFailedBreakout: ReturnType<typeof failedBreakoutDetails>
) {
  const { currentCandle, openingRange } = context;
  const entry = currentCandle.close;
  const width = openingRange.width ?? Math.abs((openingRange.high ?? entry) - (openingRange.low ?? entry));
  const buffer = Math.max(width * 0.05, 0.1);
  let stop = direction === "LONG" ? (openingRange.low ?? currentCandle.low) : (openingRange.high ?? currentCandle.high);
  let stopLogic = direction === "LONG" ? "Default stop below the ORB low." : "Default stop above the ORB high.";

  if (selection.scenario === "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED" && priorFailedBreakout?.candle) {
    if (direction === "LONG") {
      stop = Math.min(priorFailedBreakout.candle.low, openingRange.low ?? priorFailedBreakout.candle.low) - buffer;
      stopLogic = "Fakeout reversal stop is placed beyond the failed low-side sweep.";
    } else {
      stop = Math.max(priorFailedBreakout.candle.high, openingRange.high ?? priorFailedBreakout.candle.high) + buffer;
      stopLogic = "Fakeout reversal stop is placed beyond the failed high-side sweep.";
    }
  } else if (retest?.status === "RETEST_CONFIRMED") {
    if (direction === "LONG") {
      stop = Math.min(retest.candle.low, retest.boundary - buffer);
      stopLogic = "Retest setup stop is placed beyond the reclaimed ORB high retest candle.";
    } else {
      stop = Math.max(retest.candle.high, retest.boundary + buffer);
      stopLogic = "Retest setup stop is placed beyond the reclaimed ORB low retest candle.";
    }
  }

  if (direction === "LONG" && stop >= entry) {
    stop = Math.min(openingRange.low ?? currentCandle.low, currentCandle.low) - buffer;
    stopLogic = "Fallback stop forced below entry because the scenario stop was invalid.";
  }
  if (direction === "SHORT" && stop <= entry) {
    stop = Math.max(openingRange.high ?? currentCandle.high, currentCandle.high) + buffer;
    stopLogic = "Fallback stop forced above entry because the scenario stop was invalid.";
  }

  const riskDistance = Math.abs(entry - stop);
  const rewardToRisk = 2;
  const target = direction === "LONG" ? entry + riskDistance * rewardToRisk : entry - riskDistance * rewardToRisk;
  return {
    entry: roundPrice(entry),
    stop: roundPrice(stop),
    target: roundPrice(target),
    rewardToRisk,
    entryLogic:
      selection.scenario === "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED"
        ? "Entry uses the completed opposite breakout confirmation after the ORB sweep failed."
        : retest?.status === "RETEST_CONFIRMED"
          ? "Entry uses the completed candle that retested and reclaimed the ORB boundary."
          : "Entry uses the completed breakout candle close beyond the ORB boundary.",
    stopLogic,
    targetLogic: "Target is fixed at 2R from the scenario stop."
  };
}

function candlesSinceOpeningRangeEnd(context: RuleContext) {
  const elapsed = new Date(context.currentCandle.timestampUtc).getTime() - new Date(context.session.openingRangeEndAt).getTime();
  const timeframe = context.configuration.signalTimeframeMinutes || 15;
  return Math.max(0, Math.round(elapsed / (timeframe * 60_000)));
}

function selectBreakoutScenario(context: RuleContext, direction: Direction, retest: ReturnType<typeof retestState>): ScenarioSelection {
  const { previousCandles, openingRange } = context;
  const profile = breakoutProfile(context, direction);
  const priorFailedBreakout = failedBreakoutDetails(previousCandles, openingRange);
  const priorSweep = lastSweep(previousCandles, openingRange);
  const candlesAfterOrb = candlesSinceOpeningRangeEnd(context);
  const oppositeFailedBreakout =
    direction === "LONG"
      ? priorFailedBreakout?.type === "FAILED_BEARISH_BREAKOUT"
      : priorFailedBreakout?.type === "FAILED_BULLISH_BREAKOUT";
  const oppositeSweep = direction === "LONG" ? priorSweep?.side === "LOW" : priorSweep?.side === "HIGH";

  if (oppositeFailedBreakout) {
    return {
      scenario: "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED",
      autoEligible: true,
      priority: 95,
      tags: ["opposite-side-sweep", "failed-breakout", "reversal-close"],
      finalReason: `Price swept the opposite ORB boundary, failed back inside, then closed ${direction === "LONG" ? "above the ORB high" : "below the ORB low"}.`
    };
  }

  if (oppositeSweep && retest === "RETEST_CONFIRMED") {
    return {
      scenario: "SWEEP_RETEST_CONTINUATION_CONFIRMED",
      autoEligible: true,
      priority: 90,
      tags: ["liquidity-sweep", "retest-confirmed", "continuation"],
      finalReason: `A prior liquidity sweep was followed by a confirmed ${direction === "LONG" ? "high" : "low"} retest and continuation close.`
    };
  }

  if (retest === "RETEST_CONFIRMED") {
    return {
      scenario: "BREAKOUT_RETEST_CONFIRMED",
      autoEligible: true,
      priority: 85,
      tags: ["breakout", "retest-confirmed"],
      finalReason: `Breakout retested the ORB ${direction === "LONG" ? "high" : "low"} and reclaimed it with a completed candle.`
    };
  }

  if (retest === "RETEST_IN_PROGRESS") {
    return {
      scenario: "BREAKOUT_RETEST_WAIT",
      status: "WAIT FOR RETEST",
      autoEligible: false,
      priority: 70,
      tags: ["breakout", "retest-in-progress"],
      finalReason: "Breakout exists, but price is still testing the ORB boundary and has not confirmed continuation yet."
    };
  }

  if (profile.displacement === "STRONG" && candlesAfterOrb <= 2) {
    return {
      scenario: "OPENING_DRIVE_CLEAN_BREAKOUT",
      autoEligible: true,
      priority: 80,
      tags: ["opening-drive", "strong-displacement", "early-breakout"],
      finalReason: `Early completed candle closed ${direction === "LONG" ? "above the ORB high" : "below the ORB low"} with strong displacement.`
    };
  }

  if (profile.displacement === "STRONG") {
    return {
      scenario: "DISPLACEMENT_CLEAN_BREAKOUT",
      autoEligible: true,
      priority: 75,
      tags: ["clean-breakout", "strong-displacement"],
      finalReason: `Completed candle closed ${direction === "LONG" ? "above the ORB high" : "below the ORB low"} with strong body and close location.`
    };
  }

  return {
    scenario: "CLEAN_BREAKOUT_CONTINUATION",
    autoEligible: true,
    priority: 60,
    tags: ["clean-breakout"],
    finalReason: `Completed candle closed ${direction === "LONG" ? "above the ORB high" : "below the ORB low"} and passed the automatic breakout checks.`
  };
}

function relaxSweepReversalExtensionRule(
  evaluations: ReturnType<typeof evaluateMandatoryBreakoutRules>,
  selection: ScenarioSelection,
  context: RuleContext,
  direction: Direction
) {
  if (selection.scenario !== "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED") return evaluations;
  const width = context.openingRange.width ?? 0;
  const boundary = direction === "LONG" ? context.openingRange.high : context.openingRange.low;
  if (boundary == null || width <= 0) return evaluations;
  const extension = Math.abs(context.currentCandle.close - boundary);
  const reversalExtensionLimit = width * 2;
  return evaluations.map((evaluation) => {
    if (evaluation.ruleCode !== "ENTRY_NOT_OVEREXTENDED") return evaluation;
    return {
      ...evaluation,
      status: extension <= reversalExtensionLimit ? ("PASS" as const) : ("FAIL" as const),
      actualValue: Number(extension.toFixed(3)),
      requiredValue: Number(reversalExtensionLimit.toFixed(3)),
      explanation:
        extension <= reversalExtensionLimit
          ? "The sweep-reversal entry is within the wider reversal extension limit and uses the failed sweep for stop placement."
          : "The sweep-reversal travelled too far beyond the ORB boundary for a controlled paper entry."
    };
  });
}

function favorability(context: RuleContext, direction: Direction | null, evaluations: ReturnType<typeof evaluateMandatoryBreakoutRules>) {
  const { openingRange, currentCandle, previousCandles, configuration } = context;
  const allCandles = [...previousCandles, currentCandle];
  const stats = candleStats(currentCandle, direction);
  const width = openingRange.width ?? 0;
  const boundary = direction === "LONG" ? openingRange.high : direction === "SHORT" ? openingRange.low : null;
  const extension = boundary == null ? 0 : Math.abs(currentCandle.close - boundary);
  const extensionLimit = width * configuration.breakout.maximumEntryExtensionPercentOfRange;
  const spread = context.spread ?? currentCandle.spread ?? 0;
  const spreadPercentOfRange = width > 0 ? spread / width : 1;
  const atr = averageTrueRange(allCandles, 14);
  const atrPercentOfRange = atr != null && width > 0 ? atr / width : null;
  const trend = trendBias(allCandles);
  const trendAligned = direction == null || trend === "NEUTRAL" ? false : direction === "LONG" ? trend === "BULLISH" : trend === "BEARISH";
  const minutesAfterRange =
    (new Date(currentCandle.timestampUtc).getTime() - new Date(context.session.openingRangeEndAt).getTime()) / 60_000;
  const tradeWindowMinutes =
    (new Date(context.session.signalWindowEndAt).getTime() - new Date(context.session.openingRangeEndAt).getTime()) / 60_000;
  const timeScore = tradeWindowMinutes > 0 ? Math.max(0, 1 - minutesAfterRange / tradeWindowMinutes) : 0;
  const preferredSpread = configuration.favorability?.preferredSpreadPercentOfRange ?? 0.12;
  const minimumAtr = configuration.favorability?.minimumAtrPercentOfRange ?? 0.4;
  const blockingFailureCount = evaluations.filter((evaluation) => evaluation.blocking && evaluation.status === "FAIL").length;
  const waitingCount = evaluations.filter((evaluation) => evaluation.status === "WAITING").length;

  const components = {
    body: Math.min(stats.bodyRatio / configuration.breakout.minimumBodyRatio, 1) * 20,
    closeLocation: Math.min(stats.closeLocationRatio / configuration.breakout.minimumCloseLocationRatio, 1) * 15,
    extension: (extensionLimit === 0 || extension <= extensionLimit ? 1 : Math.max(0, 1 - (extension - extensionLimit) / Math.max(width, 1))) * 15,
    rangeQuality: width > 0 ? 10 : 0,
    trend: trendAligned ? 15 : trend === "NEUTRAL" ? 8 : 0,
    volatility: atrPercentOfRange == null ? 5 : Math.min(atrPercentOfRange / minimumAtr, 1) * 10,
    spread: Math.max(0, 1 - spreadPercentOfRange / preferredSpread) * 10,
    time: timeScore * 5
  };
  const rawScore = Object.values(components).reduce((sum, value) => sum + value, 0) - blockingFailureCount * 12 - waitingCount * 6;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const reasons = [
    `Body ${Math.round(stats.bodyRatio * 100)}%`,
    `Close location ${Math.round(stats.closeLocationRatio * 100)}%`,
    `Trend ${trend}${trendAligned ? " aligned" : ""}`,
    `Spread ${Math.round(spreadPercentOfRange * 100)}% of ORB`,
    atrPercentOfRange == null ? "ATR unavailable" : `ATR ${Math.round(atrPercentOfRange * 100)}% of ORB`,
    blockingFailureCount > 0 ? `${blockingFailureCount} blocking failure(s)` : "No blocking failures"
  ];
  const grade: FavorabilityGrade = score >= 80 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";
  return {
    score,
    grade,
    reasons,
    flags: {
      bodyRatio: Number(stats.bodyRatio.toFixed(3)),
      closeLocationRatio: Number(stats.closeLocationRatio.toFixed(3)),
      spreadPercentOfRange: Number(spreadPercentOfRange.toFixed(3)),
      atrPercentOfRange: atrPercentOfRange == null ? null : Number(atrPercentOfRange.toFixed(3)),
      trend,
      trendAligned,
      components
    }
  };
}

export function evaluateSetup(context: RuleContext): SetupDecision {
  const { openingRange, currentCandle, previousCandles, configuration } = context;
  const allCandles = [...previousCandles, currentCandle];
  const sweep = hasSweptBothSides(allCandles, openingRange);
  const midpointCrossCount = midpointCrosses(allCandles, openingRange.midpoint);
  const failedBreakoutState = failedBreakout(allCandles, openingRange);
  const priorFailedBreakout = failedBreakoutDetails(previousCandles, openingRange);
  const currentProfile = breakoutProfile(context, null);

  const longBreak = openingRange.high != null && currentCandle.close > openingRange.high;
  const shortBreak = openingRange.low != null && currentCandle.close < openingRange.low;
  const direction: Direction | null = longBreak ? "LONG" : shortBreak ? "SHORT" : null;

  if (!direction && sweep.swept && configuration.enabledScenarios.doubleSidedSweep === "BLOCK_CONTINUATION") {
    const score = favorability(context, null, []);
    return {
      scenario: "DOUBLE_SIDED_SWEEP",
      direction: null,
      status: "NO TRADE",
      finalReason: "Both ORB boundaries were swept. Continuation trades are blocked and reversal trades require manual review.",
      evaluations: [],
      scenarioFlags: {
        sweep,
        midpointCrossCount,
        failedBreakoutState,
        priorFailedBreakout,
        breakoutProfile: currentProfile,
        matrix: { priority: 100, autoEligible: false, tags: ["double-sided-sweep", "manual-review"] },
        favorability: score.flags
      },
      favorabilityScore: score.score,
      favorabilityGrade: score.grade,
      favorabilityReasons: score.reasons
    };
  }

  if (!direction && failedBreakoutState) {
    const reversalDirection = failedBreakoutState === "FAILED_BULLISH_BREAKOUT" ? "SHORT" : "LONG";
    const score = favorability(context, reversalDirection, []);
    return {
      scenario: "FAKEOUT_REVERSAL_CANDIDATE",
      direction: reversalDirection,
      status: "REVERSAL CANDIDATE",
      finalReason: "A breakout failed back inside the range. The setup is tracked as a fakeout reversal candidate, not an automatic paper entry yet.",
      evaluations: [],
      scenarioFlags: {
        sweep,
        midpointCrossCount,
        failedBreakoutState,
        priorFailedBreakout,
        breakoutProfile: currentProfile,
        matrix: { priority: 65, autoEligible: false, tags: ["fakeout", "inside-range-close", "watch-reversal"] },
        favorability: score.flags
      },
      favorabilityScore: score.score,
      favorabilityGrade: score.grade,
      favorabilityReasons: score.reasons
    };
  }

  if (!direction) {
    const choppy = midpointCrossCount >= 5;
    const score = favorability(context, null, []);
    return {
      scenario: choppy ? "INSIDE_RANGE_CHOP_NO_TRADE" : "INSIDE_RANGE_WAIT",
      direction: null,
      status: choppy ? "NO TRADE" : "WAIT",
      finalReason: choppy
        ? "Price repeatedly crossed the ORB midpoint and failed to maintain acceptance outside either boundary."
        : "No completed breakout candle is available yet.",
      evaluations: [],
      scenarioFlags: {
        sweep,
        midpointCrossCount,
        failedBreakoutState,
        priorFailedBreakout,
        breakoutProfile: currentProfile,
        matrix: { priority: choppy ? 55 : 20, autoEligible: false, tags: choppy ? ["midpoint-chop", "inside-range"] : ["inside-range", "waiting"] },
        favorability: score.flags
      },
      favorabilityScore: score.score,
      favorabilityGrade: score.grade,
      favorabilityReasons: score.reasons
    };
  }

  const initialEvaluations = evaluateMandatoryBreakoutRules(context, direction);
  const initialOverextended = initialEvaluations.some((evaluation) => evaluation.ruleCode === "ENTRY_NOT_OVEREXTENDED" && evaluation.status === "FAIL");
  const retest = retestState(allCandles, openingRange, direction);
  const baseSelection = selectBreakoutScenario(context, direction, retest);
  const evaluations = relaxSweepReversalExtensionRule(initialEvaluations, baseSelection, context, direction);
  const unmatchedChecklistRules = evaluations.filter((evaluation) => !["PASS", "NOT_APPLICABLE"].includes(evaluation.status));
  const ready = unmatchedChecklistRules.length === 0;
  const mandatoryReady = orbMandatoryEntryReady(evaluations, direction);
  const score = favorability(context, direction, evaluations);
  const minimumScore = configuration.favorability?.minimumScoreForPaperTrade ?? 70;
  const retestInfo = retestDetails(allCandles, openingRange, direction);
  const overextended = evaluations.some((evaluation) => evaluation.ruleCode === "ENTRY_NOT_OVEREXTENDED" && evaluation.status === "FAIL");
  const lowFavorability = ready && score.score < minimumScore;
  const selection = overextended && baseSelection.scenario !== "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED"
    ? {
        scenario: "OVEREXTENDED_BREAKOUT_NO_TRADE",
        status: "WAIT FOR RETEST" as const,
        autoEligible: false,
        priority: 50,
        tags: ["overextended", "breakout", "no-chase"],
        finalReason: "Breakout candle closed too far beyond the ORB boundary. The system will not chase this entry."
      }
    : baseSelection;
  const trendAlignedScenario =
    selection.scenario === "CLEAN_BREAKOUT_CONTINUATION" && score.flags.trendAligned ? "TREND_ALIGNED_CLEAN_BREAKOUT" : selection.scenario;
  const tradePlan = buildTradePlan(context, direction, { ...selection, scenario: trendAlignedScenario }, retestInfo, priorFailedBreakout);
  const entryPrice = tradePlan.entry;
  const stopPrice = tradePlan.stop;
  const targetPrice = tradePlan.target;
  const autoReady = ready && selection.autoEligible && !lowFavorability;
  const mandatoryOnlyReady = !autoReady && mandatoryReady;
  const blockedStatus = lowFavorability ? "BLOCKED" : selection.status ?? "WAIT FOR RETEST";

  return {
    scenario: mandatoryOnlyReady
      ? `MANDATORY_ORB_BREAKOUT_${direction === "LONG" ? "BUY" : "SELL"}`
      : lowFavorability ? `${trendAlignedScenario}_LOW_FAVORABILITY` : trendAlignedScenario,
    direction,
    status: autoReady || mandatoryOnlyReady ? (direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY") : blockedStatus,
    entryPrice,
    stopPrice,
    targetPrice,
    finalReason:
      autoReady
        ? `${selection.finalReason} Full checklist matched. Favorability ${score.score}/100 (${score.grade}) permits automatic paper entry.`
        : mandatoryOnlyReady
          ? `Mandatory ORB entry checklist passed. Small paper setup created while confirmation/quality checks continue. Full checklist waiting on: ${unmatchedChecklistRules.map((rule) => rule.name).join(", ") || "higher-quality scenario and favorability alignment"}.`
          : lowFavorability
            ? `Breakout passed mandatory rules, but favorability ${score.score}/100 is below the ${minimumScore}/100 paper-trade threshold.`
          : unmatchedChecklistRules.length > 0
            ? `Breakout exists, but automatic entry is blocked until every checklist rule passes. Waiting on: ${unmatchedChecklistRules.map((rule) => rule.name).join(", ")}.`
            : selection.finalReason ?? "Breakout exists, but one or more rules prevent automatic setup readiness.",
    evaluations,
    scenarioFlags: {
      sweep,
      midpointCrossCount,
      failedBreakoutState,
      priorFailedBreakout,
      orbWidth: openingRange.width ?? 0,
      retest,
      retestInfo,
      tradePlan,
      breakoutProfile: breakoutProfile(context, direction),
      matrix: {
        priority: selection.priority,
        autoEligible: selection.autoEligible,
        checklistMatched: ready,
        mandatoryChecklistMatched: mandatoryReady,
        setupTier: autoReady ? "FULL" : mandatoryOnlyReady ? "MANDATORY" : "WATCH",
        fullChecklistMatched: autoReady,
        reversalExtensionRelaxed:
          initialOverextended &&
          baseSelection.scenario === "LIQUIDITY_SWEEP_REVERSAL_CONFIRMED" &&
          !overextended,
        unmatchedChecklistRules: unmatchedChecklistRules.map((rule) => rule.ruleCode),
        selectedScenario: trendAlignedScenario,
        tags: selection.tags,
        candlesAfterOrb: candlesSinceOpeningRangeEnd(context)
      },
      favorability: score.flags
    },
    favorabilityScore: score.score,
    favorabilityGrade: score.grade,
    favorabilityReasons: score.reasons
  };
}

function orbMandatoryEntryReady(evaluations: ReturnType<typeof evaluateMandatoryBreakoutRules>, direction: Direction) {
  const required = new Set([
    "ORB_LOCKED",
    "INSIDE_SIGNAL_WINDOW",
    direction === "LONG" ? "CLOSE_ABOVE_ORB_HIGH" : "CLOSE_BELOW_ORB_LOW",
    "ENTRY_NOT_OVEREXTENDED",
    "RISK_PERMISSION"
  ]);
  return [...required].every((ruleCode) =>
    evaluations.some((evaluation) => evaluation.ruleCode === ruleCode && evaluation.status === "PASS")
  );
}
