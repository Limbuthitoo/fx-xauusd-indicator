import type { Candle, RuleEvaluation } from "@orb-guide/shared-types";
import { buildOpeningRange } from "@orb-guide/strategy-engine";

export type RangeSource =
  | "MAX_OPTIONS_NY_ORB"
  | "MAX_OPTIONS_ORB"
  | "HORIZONTAL_CONSOLIDATION"
  | "ASIAN_SESSION_RANGE"
  | "LONDON_SESSION_RANGE"
  | "COMPOSITE_RANGE";

export type RangeFormationMethod = "TIME_BASED" | "PRICE_BASED";
export type RangeState =
  | "FORMING"
  | "CANDIDATE"
  | "VALIDATING"
  | "VALID"
  | "LOCKED"
  | "BREAKOUT_CANDIDATE"
  | "BREAKOUT_CONFIRMED"
  | "WAITING_FOR_RETEST"
  | "RETEST_CONFIRMED"
  | "ENTRY_READY"
  | "TRADE_ACTIVE"
  | "FALSE_BREAKOUT"
  | "INVALIDATED"
  | "EXPIRED"
  | "COMPLETED";

export interface RangeBoundaryZone {
  center: number;
  lowerBound: number;
  upperBound: number;
  toleranceMethod: "EXACT" | "ATR" | "FIXED_PRICE" | "PERCENT_OF_RANGE";
  toleranceValue: number;
}

export interface RangeEvidence {
  candleIds: string[];
  startCandleId: string | null;
  endCandleId: string | null;
  structureClassification?: string;
  upperTouchCount?: number;
  lowerTouchCount?: number;
  upperReactionCount?: number;
  lowerReactionCount?: number;
  midpointCrossCount?: number;
  containmentRatio?: number;
  efficiencyRatio?: number;
  balancedMidpointRatio?: number;
  acceptedBreakoutCount?: number;
  upperSlopeAtrPerBar?: number;
  lowerSlopeAtrPerBar?: number;
  sessionName?: string;
  sessionTimezone?: string;
  fixedStartTime?: string;
  fixedEndTime?: string;
  validationRules: RuleEvaluation[];
}

export interface TradingRange {
  id: string;
  symbol: string;
  source: RangeSource;
  formationMethod: RangeFormationMethod;
  detectorVersion: string;
  strategyVersion: string;
  timeframe: string;
  startedAt: string;
  detectedAt: string;
  lockedAt?: string;
  expiresAt?: string;
  completedAt?: string;
  high: number;
  low: number;
  midpoint: number;
  width: number;
  widthAtr?: number | null;
  upperZone: RangeBoundaryZone;
  lowerZone: RangeBoundaryZone;
  sourceEvidence: RangeEvidence;
  qualityScore?: number;
  confidenceScore?: number;
  parentRangeId?: string | null;
  childRangeIds: string[];
  supportingRangeIds: string[];
  breakoutDirection?: "LONG" | "SHORT";
  state: RangeState;
  createdAt: string;
  updatedAt: string;
}

export interface RangeDetectionContext {
  symbol: string;
  now: string;
  timezone: string;
  candles1m?: Candle[];
  candles5m: Candle[];
  candles15m?: Candle[];
  atr5m?: number | null;
  sessionContext?: {
    sessionName?: string;
    sessionTimezone?: string;
    rangeStart?: string;
    rangeEnd?: string;
    signalWindowEnd?: string;
  };
  activeRanges?: TradingRange[];
  strategyVersion: string;
}

export interface RangeDetectionResult {
  detectorCode: string;
  status: "NONE" | "FORMING" | "CANDIDATE" | "VALID" | "INVALID";
  range?: TradingRange;
  evidence: RangeEvidence;
  failures: RuleEvaluation[];
  warnings: RuleEvaluation[];
}

export interface RangeDetector {
  readonly code: string;
  readonly formationMethod: RangeFormationMethod;
  supports(context: RangeDetectionContext): boolean;
  detect(context: RangeDetectionContext): Promise<RangeDetectionResult> | RangeDetectionResult;
  recover(context: RangeDetectionContext): Promise<RangeDetectionResult> | RangeDetectionResult;
  validateConfiguration(): { valid: boolean; errors: string[] };
}

export type RangeSignalMode = "DISABLED" | "OBSERVATION_ONLY" | "BACKTEST_ONLY" | "DEMO_SIGNAL" | "ACTIVE_SIGNAL";
export type RangeDecision =
  | "WAITING_FOR_RANGE"
  | "RANGE_LOCKED"
  | "WAITING_FOR_BREAKOUT"
  | "POTENTIAL_BUY"
  | "POTENTIAL_SELL"
  | "WAITING_FOR_RETEST"
  | "BUY_READY"
  | "SELL_READY"
  | "FALSE_BREAKOUT"
  | "BLOCKED"
  | "INVALIDATED"
  | "EXPIRED"
  | "NO_TRADE";

export interface RangeBreakoutProfile {
  source: RangeSource;
  requireCompletedCandle: boolean;
  requireCloseOutside: boolean;
  minimumBodyRatio: number;
  minimumCloseLocationRatio: number;
  maximumOppositeWickRatio: number;
  minimumBreakDistanceAtr: number;
  maximumDirectEntryExtensionRatio: number;
  maximumRetestCandles?: number;
  entryModel: "BREAKOUT_CLOSE" | "RETEST" | "SOURCE_SPECIFIC";
  stopModel: "OPPOSITE_RANGE_BOUNDARY" | "BREAKOUT_CANDLE" | "RETEST_SWING" | "SOURCE_SPECIFIC";
  targetModel: "FIXED_R" | "RANGE_PROJECTION" | "OPPOSING_LIQUIDITY" | "SOURCE_SPECIFIC";
}

export interface BreakoutEvaluation {
  status: "NONE" | "WICK_ONLY" | "CONFIRMED";
  state: RangeState | "WAIT";
  direction: "LONG" | "SHORT" | null;
  confirmed: boolean;
  wickOnly: boolean;
  bodyRatio: number;
  closeLocationRatio: number;
  oppositeWickRatio: number;
  breakDistanceAtr: number;
  extensionRatio: number;
  directEntryBlocked: boolean;
  reason: string;
}

export interface FalseBreakoutEvaluation {
  status: "NONE" | "WICK_ONLY_FALSE_BREAK" | "CLOSE_THROUGH_RECLAIM" | "FAILED_RETEST" | "DOUBLE_SIDED_FALSE_BREAK";
  falseBreakout: boolean;
  direction: "LONG" | "SHORT" | null;
  failedBoundary: "HIGH" | "LOW" | null;
  reclaimedInside: boolean;
  reason: string;
}

export interface RetestEvaluation {
  status: "WAITING" | "CONFIRMED" | "INVALIDATED" | "EXPIRED";
  confirmed: boolean;
  invalidated: boolean;
  expired?: boolean;
  inZone: boolean;
  deepInside: boolean;
  reason: string;
}

export interface BreakoutRetestLifecycleEvaluation {
  rangeState: RangeState;
  breakout: BreakoutEvaluation | null;
  breakoutCandle: Candle | null;
  falseBreakout: FalseBreakoutEvaluation | null;
  retest: RetestEvaluation | null;
}

export interface RangeRelationship {
  parentRangeId: string;
  childRangeId: string;
  relationshipType: "NESTED" | "OVERLAPPING" | "SUPPORTING" | "COMPOSITE_SOURCE" | "CONFLICTING";
  reason: string;
}

export interface ConflictResolution {
  status: "CLEAR" | "ALIGNED" | "NESTED" | "DUPLICATE" | "CONFLICT";
  selectedRange: TradingRange | null;
  relationships: RangeRelationship[];
  reason: string;
}

export interface HorizontalRangeConfig {
  enabled: boolean;
  observationOnly: boolean;
  timeframe: "5min" | "15min";
  minimumRangeCandles: number;
  maximumRangeCandles: number;
  minimumUpperTouches: number;
  minimumLowerTouches: number;
  minimumBarsBetweenTouches: number;
  boundaryReactionCount: number;
  boundaryToleranceAtr: number;
  minimumContainmentRatio: number;
  maximumEfficiencyRatio: number;
  maximumBoundarySlopeAtrPerBar: number;
  minimumWidthAtr: number;
  maximumWidthAtr: number;
  minimumMidpointCrosses: number;
  minimumQualityScore: number;
  lockAfterValidation: boolean;
  expireAfterCandles: number;
}

export const DEFAULT_HORIZONTAL_RANGE_CONFIG: HorizontalRangeConfig = {
  enabled: false,
  observationOnly: true,
  timeframe: "5min",
  minimumRangeCandles: 12,
  maximumRangeCandles: 60,
  minimumUpperTouches: 2,
  minimumLowerTouches: 2,
  minimumBarsBetweenTouches: 2,
  boundaryReactionCount: 3,
  boundaryToleranceAtr: 0.08,
  minimumContainmentRatio: 0.75,
  maximumEfficiencyRatio: 0.35,
  maximumBoundarySlopeAtrPerBar: 0.02,
  minimumWidthAtr: 0.8,
  maximumWidthAtr: 4,
  minimumMidpointCrosses: 2,
  minimumQualityScore: 70,
  lockAfterValidation: true,
  expireAfterCandles: 60
};

export const RANGE_FEATURE_FLAGS = {
  genericRangeEngine: true,
  maxOptionsOrbDetector: true,
  horizontalRangeDetector: true,
  horizontalRangeSignalMode: "ACTIVE_SIGNAL" as RangeSignalMode,
  sharedBreakoutEngineForOrb: false,
  rangeConflictResolver: true,
  compositeRanges: true
};

export class MaxOptionsOrbRangeDetector implements RangeDetector {
  readonly code = "MAX_OPTIONS_NY_ORB";
  readonly formationMethod = "TIME_BASED" as const;

  supports(context: RangeDetectionContext) {
    return Boolean(context.sessionContext?.rangeStart && context.sessionContext?.rangeEnd);
  }

  detect(context: RangeDetectionContext): RangeDetectionResult {
    const session = context.sessionContext;
    if (!session?.rangeStart || !session.rangeEnd) return emptyResult(this.code, "INVALID", "ORB session context is missing.");
    const now = new Date(context.now).getTime();
    const start = new Date(session.rangeStart).getTime();
    const end = new Date(session.rangeEnd).getTime();
    if (now < start) return emptyResult(this.code, "NONE", "ORB range has not started.");

    const candles = context.candles5m.filter((candle) => {
      const at = new Date(candle.timestampUtc).getTime();
      return at >= start && at < end;
    });
    if (now < end) return formingResult(this.code, context, candles, session);

    const range = buildOpeningRange(candles.slice(0, 3), 0.01, 3);
    if (range.status !== "LOCKED" || range.high == null || range.low == null || range.midpoint == null || range.width == null) {
      return emptyResult(this.code, "INVALID", range.invalidReason ?? "Missing ORB candles.");
    }

    return {
      detectorCode: this.code,
      status: "VALID",
      range: tradingRangeFromBounds({
        context,
        source: "MAX_OPTIONS_NY_ORB",
        formationMethod: "TIME_BASED",
        state: "LOCKED",
        high: range.high,
        low: range.low,
        startedAt: session.rangeStart,
        detectedAt: context.now,
        lockedAt: session.rangeEnd,
        evidence: {
          candleIds: candles.map(candleId),
          startCandleId: candles[0] ? candleId(candles[0]) : null,
          endCandleId: candles.at(-1) ? candleId(candles.at(-1)!) : null,
          sessionName: session.sessionName,
          sessionTimezone: session.sessionTimezone,
          fixedStartTime: session.rangeStart,
          fixedEndTime: session.rangeEnd,
          validationRules: [rule("ORB_FIXED_WINDOW_LOCKED", "ORB fixed-time range locked", "PASS", true, candles.length, "3")]
        }
      }),
      evidence: {
        candleIds: candles.map(candleId),
        startCandleId: candles[0] ? candleId(candles[0]) : null,
        endCandleId: candles.at(-1) ? candleId(candles.at(-1)!) : null,
        sessionName: session.sessionName,
        sessionTimezone: session.sessionTimezone,
        fixedStartTime: session.rangeStart,
        fixedEndTime: session.rangeEnd,
        validationRules: []
      },
      failures: [],
      warnings: []
    };
  }

  recover(context: RangeDetectionContext) {
    return this.detect(context);
  }

  validateConfiguration() {
    return { valid: true, errors: [] };
  }
}

export class HorizontalRangeDetector implements RangeDetector {
  readonly code = "HORIZONTAL_CONSOLIDATION";
  readonly formationMethod = "PRICE_BASED" as const;

  constructor(private readonly config: HorizontalRangeConfig = DEFAULT_HORIZONTAL_RANGE_CONFIG) {}

  supports() {
    return this.config.enabled;
  }

  detect(context: RangeDetectionContext): RangeDetectionResult {
    if (!this.config.enabled) return emptyResult(this.code, "NONE", "Horizontal range detector is disabled.");
    const historyCandles = this.config.maximumRangeCandles + this.config.expireAfterCandles;
    const candles = context.candles5m.slice(-historyCandles);
    const best = this.bestCandidate(context, candles);
    if (!best) return rejectedHorizontalStructureResult(this.code, context, candles, this.config);
    return {
      detectorCode: this.code,
      status: "VALID",
      range: best,
      evidence: best.sourceEvidence,
      failures: [],
      warnings: this.config.observationOnly ? [rule("OBSERVATION_ONLY", "Horizontal range is observation-only", "PASS", false, true, true)] : []
    };
  }

  recover(context: RangeDetectionContext) {
    return this.detect(context);
  }

  validateConfiguration() {
    const errors = [];
    if (this.config.minimumRangeCandles < 3) errors.push("minimumRangeCandles must be at least 3.");
    if (this.config.maximumRangeCandles < this.config.minimumRangeCandles) errors.push("maximumRangeCandles must be >= minimumRangeCandles.");
    return { valid: errors.length === 0, errors };
  }

  private bestCandidate(context: RangeDetectionContext, candles: Candle[]) {
    const earliestEnd = Math.max(this.config.minimumRangeCandles, candles.length - this.config.expireAfterCandles);
    for (let end = candles.length; end >= earliestEnd; end -= 1) {
      let bestAtEnd: TradingRange | null = null;
      for (let size = this.config.minimumRangeCandles; size <= Math.min(this.config.maximumRangeCandles, end); size += 1) {
        const window = candles.slice(end - size, end);
        const candidate = this.candidate(context, window);
        if (!candidate) continue;
        if (!bestAtEnd || Number(candidate.qualityScore ?? 0) > Number(bestAtEnd.qualityScore ?? 0) || (candidate.qualityScore === bestAtEnd.qualityScore && size > bestAtEnd.sourceEvidence.candleIds.length)) {
          bestAtEnd = candidate;
        }
      }
      if (bestAtEnd) return bestAtEnd;
    }
    return null;
  }

  private candidate(context: RangeDetectionContext, candles: Candle[]) {
    if (candles.length < this.config.minimumRangeCandles) return null;
    const atr = Math.max(Number(context.atr5m ?? medianTrueRange(candles) ?? 0), 0.00001);
    const highs = [...candles.map((candle) => candle.high)].sort((a, b) => b - a).slice(0, this.config.boundaryReactionCount);
    const lows = [...candles.map((candle) => candle.low)].sort((a, b) => a - b).slice(0, this.config.boundaryReactionCount);
    let high = median(highs);
    let low = median(lows);
    if (high == null || low == null || high <= low) return null;
    let midpoint = (high + low) / 2;
    let width = high - low;
    let widthAtr = width / atr;
    const tolerance = atr * this.config.boundaryToleranceAtr;
    let upperZone = boundary(high, tolerance, "ATR", this.config.boundaryToleranceAtr);
    let lowerZone = boundary(low, tolerance, "ATR", this.config.boundaryToleranceAtr);
    let upperReactions = boundaryReactionPoints(candles, "UPPER", upperZone, midpoint, this.config.minimumBarsBetweenTouches);
    let lowerReactions = boundaryReactionPoints(candles, "LOWER", lowerZone, midpoint, this.config.minimumBarsBetweenTouches);
    if (upperReactions.length >= this.config.boundaryReactionCount && lowerReactions.length >= this.config.boundaryReactionCount) {
      const reactionHigh = median(upperReactions.map((point) => point.price).sort((a, b) => b - a).slice(0, this.config.boundaryReactionCount));
      const reactionLow = median(lowerReactions.map((point) => point.price).sort((a, b) => a - b).slice(0, this.config.boundaryReactionCount));
      if (reactionHigh != null && reactionLow != null && reactionHigh > reactionLow) {
        high = reactionHigh;
        low = reactionLow;
        midpoint = (high + low) / 2;
        width = high - low;
        widthAtr = width / atr;
        upperZone = boundary(high, tolerance, "ATR", this.config.boundaryToleranceAtr);
        lowerZone = boundary(low, tolerance, "ATR", this.config.boundaryToleranceAtr);
        upperReactions = boundaryReactionPoints(candles, "UPPER", upperZone, midpoint, this.config.minimumBarsBetweenTouches);
        lowerReactions = boundaryReactionPoints(candles, "LOWER", lowerZone, midpoint, this.config.minimumBarsBetweenTouches);
      }
    }
    const upperTouchCount = upperReactions.length;
    const lowerTouchCount = lowerReactions.length;
    const containmentRatio = candles.filter((candle) => candle.close <= upperZone.upperBound && candle.close >= lowerZone.lowerBound).length / candles.length;
    const acceptedBreakoutCount = candles.filter((candle) => candle.close > upperZone.upperBound || candle.close < lowerZone.lowerBound).length;
    const efficiencyRatio = directionalEfficiency(candles);
    const midpointCrossCount = midpointCrosses(candles, midpoint);
    const balancedMidpointRatio = midpointBalanceRatio(candles, midpoint);
    const upperSlopeAtrPerBar = reactionSlopeAtrPerBar(upperReactions, atr);
    const lowerSlopeAtrPerBar = reactionSlopeAtrPerBar(lowerReactions, atr);
    const validationRules = [
      rule("HORIZONTAL_UPPER_TOUCHES", "Minimum upper touches", upperTouchCount >= this.config.minimumUpperTouches ? "PASS" : "FAIL", true, upperTouchCount, this.config.minimumUpperTouches),
      rule("HORIZONTAL_LOWER_TOUCHES", "Minimum lower touches", lowerTouchCount >= this.config.minimumLowerTouches ? "PASS" : "FAIL", true, lowerTouchCount, this.config.minimumLowerTouches),
      rule("HORIZONTAL_UPPER_REJECTIONS", "Upper boundary rejection count", upperReactions.length >= this.config.minimumUpperTouches ? "PASS" : "FAIL", true, upperReactions.length, this.config.minimumUpperTouches),
      rule("HORIZONTAL_LOWER_REJECTIONS", "Lower boundary rejection count", lowerReactions.length >= this.config.minimumLowerTouches ? "PASS" : "FAIL", true, lowerReactions.length, this.config.minimumLowerTouches),
      rule("HORIZONTAL_CONTAINMENT", "Containment ratio", containmentRatio >= this.config.minimumContainmentRatio ? "PASS" : "FAIL", true, Number(containmentRatio.toFixed(3)), this.config.minimumContainmentRatio),
      rule("HORIZONTAL_NO_ACCEPTED_BREAKOUT", "No accepted close outside range", acceptedBreakoutCount === 0 ? "PASS" : "FAIL", true, acceptedBreakoutCount, 0),
      rule("HORIZONTAL_EFFICIENCY", "Directional efficiency", efficiencyRatio <= this.config.maximumEfficiencyRatio ? "PASS" : "FAIL", true, Number(efficiencyRatio.toFixed(3)), this.config.maximumEfficiencyRatio),
      rule("HORIZONTAL_BOUNDARY_SLOPE", "Boundary horizontality", upperSlopeAtrPerBar <= this.config.maximumBoundarySlopeAtrPerBar && lowerSlopeAtrPerBar <= this.config.maximumBoundarySlopeAtrPerBar ? "PASS" : "FAIL", true, `${upperSlopeAtrPerBar.toFixed(3)}/${lowerSlopeAtrPerBar.toFixed(3)}`, this.config.maximumBoundarySlopeAtrPerBar),
      rule("HORIZONTAL_WIDTH_ATR", "ATR-normalized width", widthAtr >= this.config.minimumWidthAtr && widthAtr <= this.config.maximumWidthAtr ? "PASS" : "FAIL", true, Number(widthAtr.toFixed(3)), `${this.config.minimumWidthAtr}-${this.config.maximumWidthAtr}`),
      rule("HORIZONTAL_MIDPOINT_CROSSES", "Minimum midpoint crosses", midpointCrossCount >= this.config.minimumMidpointCrosses ? "PASS" : "FAIL", true, midpointCrossCount, this.config.minimumMidpointCrosses),
      rule("HORIZONTAL_MIDPOINT_BALANCE", "Balanced time above and below midpoint", balancedMidpointRatio >= 0.35 ? "PASS" : "FAIL", true, Number(balancedMidpointRatio.toFixed(3)), 0.35)
    ];
    const qualityScore = horizontalQualityScore({ upperTouchCount, lowerTouchCount, containmentRatio, efficiencyRatio, midpointCrossCount, balancedMidpointRatio, upperSlopeAtrPerBar, lowerSlopeAtrPerBar, widthAtr, candleCount: candles.length, config: this.config });
    validationRules.push(rule("HORIZONTAL_QUALITY_SCORE", "Horizontal range quality score", qualityScore >= this.config.minimumQualityScore ? "PASS" : "FAIL", true, qualityScore, this.config.minimumQualityScore));
    if (validationRules.some((item) => item.status !== "PASS")) return null;
    const formationEndedAt = candles.at(-1)!.timestampUtc;
    return tradingRangeFromBounds({
      context,
      source: "HORIZONTAL_CONSOLIDATION",
      formationMethod: "PRICE_BASED",
      state: this.config.lockAfterValidation ? "LOCKED" : "VALID",
      high,
      low,
      startedAt: candles[0].timestampUtc,
      detectedAt: formationEndedAt,
      lockedAt: this.config.lockAfterValidation ? formationEndedAt : undefined,
      widthAtr,
      qualityScore,
      evidence: {
        candleIds: candles.map(candleId),
        startCandleId: candleId(candles[0]),
        endCandleId: candleId(candles.at(-1)!),
        upperTouchCount,
        lowerTouchCount,
        upperReactionCount: upperReactions.length,
        lowerReactionCount: lowerReactions.length,
        midpointCrossCount,
        containmentRatio: Number(containmentRatio.toFixed(3)),
        efficiencyRatio: Number(efficiencyRatio.toFixed(3)),
        balancedMidpointRatio: Number(balancedMidpointRatio.toFixed(3)),
        acceptedBreakoutCount,
        upperSlopeAtrPerBar,
        lowerSlopeAtrPerBar,
        structureClassification: "HORIZONTAL_CONSOLIDATION",
        validationRules
      }
    });
  }
}

export function evaluateRangeBreakout(range: TradingRange, candle: Candle, profile = DEFAULT_RANGE_BREAKOUT_PROFILE) {
  const fullRange = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = fullRange > 0 ? body / fullRange : 0;
  const longCandidate = candle.high > range.upperZone.upperBound;
  const shortCandidate = candle.low < range.lowerZone.lowerBound;
  const longConfirmed = candle.close > range.upperZone.upperBound;
  const shortConfirmed = candle.close < range.lowerZone.lowerBound;
  const direction = longConfirmed ? "LONG" : shortConfirmed ? "SHORT" : longCandidate ? "LONG" : shortCandidate ? "SHORT" : null;
  const closeLocationRatio = direction === "LONG" && fullRange > 0
    ? (candle.close - candle.low) / fullRange
    : direction === "SHORT" && fullRange > 0
      ? (candle.high - candle.close) / fullRange
      : 0;
  const oppositeWickRatio = direction === "LONG" && fullRange > 0
    ? (Math.min(candle.open, candle.close) - candle.low) / fullRange
    : direction === "SHORT" && fullRange > 0
      ? (candle.high - Math.max(candle.open, candle.close)) / fullRange
      : 0;
  const atr = Math.max(Number((profile as any).atr ?? range.widthAtr ?? range.width), 0.00001);
  const breakDistance = direction === "LONG"
    ? Math.max(0, candle.close - range.upperZone.upperBound)
    : direction === "SHORT"
      ? Math.max(0, range.lowerZone.lowerBound - candle.close)
      : 0;
  const breakDistanceAtr = breakDistance / atr;
  const extension = direction === "LONG"
    ? Math.max(0, candle.close - range.high)
    : direction === "SHORT"
      ? Math.max(0, range.low - candle.close)
      : 0;
  const extensionRatio = range.width > 0 ? extension / range.width : 0;
  const confirmed = (longConfirmed || shortConfirmed) &&
    bodyRatio >= profile.minimumBodyRatio &&
    closeLocationRatio >= profile.minimumCloseLocationRatio &&
    oppositeWickRatio <= profile.maximumOppositeWickRatio &&
    breakDistanceAtr >= profile.minimumBreakDistanceAtr;
  const directEntryBlocked = confirmed && extensionRatio > profile.maximumDirectEntryExtensionRatio;
  return {
    status: confirmed ? "CONFIRMED" : longCandidate || shortCandidate ? "WICK_ONLY" : "NONE",
    state: confirmed ? "BREAKOUT_CONFIRMED" : longCandidate || shortCandidate ? "BREAKOUT_CANDIDATE" : "WAIT",
    direction,
    confirmed,
    wickOnly: (longCandidate && !longConfirmed) || (shortCandidate && !shortConfirmed),
    bodyRatio: Number(bodyRatio.toFixed(3)),
    closeLocationRatio: Number(closeLocationRatio.toFixed(3)),
    oppositeWickRatio: Number(oppositeWickRatio.toFixed(3)),
    breakDistanceAtr: Number(breakDistanceAtr.toFixed(3)),
    extensionRatio: Number(extensionRatio.toFixed(3)),
    directEntryBlocked,
    reason: confirmed
      ? directEntryBlocked ? "Breakout confirmed but direct entry is overextended." : "Breakout confirmed by completed candle close."
      : longCandidate || shortCandidate ? "Boundary traded but candle did not confirm breakout quality." : "No breakout candidate."
  } satisfies BreakoutEvaluation;
}

export const DEFAULT_RANGE_BREAKOUT_PROFILE: RangeBreakoutProfile = {
  source: "HORIZONTAL_CONSOLIDATION",
  requireCompletedCandle: true,
  requireCloseOutside: true,
  minimumBodyRatio: 0.55,
  minimumCloseLocationRatio: 0.65,
  maximumOppositeWickRatio: 0.3,
  minimumBreakDistanceAtr: 0.05,
  maximumDirectEntryExtensionRatio: 0.5,
  entryModel: "BREAKOUT_CLOSE",
  stopModel: "OPPOSITE_RANGE_BOUNDARY",
  targetModel: "FIXED_R"
};

export const RANGE_BREAKOUT_PROFILES: Record<RangeSource, RangeBreakoutProfile> = {
  MAX_OPTIONS_NY_ORB: {
    ...DEFAULT_RANGE_BREAKOUT_PROFILE,
    source: "MAX_OPTIONS_NY_ORB",
    minimumBodyRatio: 0.45,
    minimumCloseLocationRatio: 0.6,
    minimumBreakDistanceAtr: 0,
    maximumDirectEntryExtensionRatio: 0.25,
    entryModel: "SOURCE_SPECIFIC",
    stopModel: "SOURCE_SPECIFIC",
    targetModel: "SOURCE_SPECIFIC"
  },
  MAX_OPTIONS_ORB: {
    ...DEFAULT_RANGE_BREAKOUT_PROFILE,
    source: "MAX_OPTIONS_ORB",
    minimumBodyRatio: 0.45,
    minimumCloseLocationRatio: 0.6,
    minimumBreakDistanceAtr: 0,
    maximumDirectEntryExtensionRatio: 0.25,
    entryModel: "SOURCE_SPECIFIC",
    stopModel: "SOURCE_SPECIFIC",
    targetModel: "SOURCE_SPECIFIC"
  },
  HORIZONTAL_CONSOLIDATION: {
    ...DEFAULT_RANGE_BREAKOUT_PROFILE,
    source: "HORIZONTAL_CONSOLIDATION",
    maximumRetestCandles: 6,
    entryModel: "RETEST",
    stopModel: "RETEST_SWING",
    targetModel: "FIXED_R"
  },
  ASIAN_SESSION_RANGE: { ...DEFAULT_RANGE_BREAKOUT_PROFILE, source: "ASIAN_SESSION_RANGE" },
  LONDON_SESSION_RANGE: { ...DEFAULT_RANGE_BREAKOUT_PROFILE, source: "LONDON_SESSION_RANGE" },
  COMPOSITE_RANGE: { ...DEFAULT_RANGE_BREAKOUT_PROFILE, source: "COMPOSITE_RANGE" }
};

export class RangeLifecycleService {
  create(result: RangeDetectionResult): TradingRange | null {
    if (!result.range) return null;
    return { ...result.range, state: result.range.state === "VALID" ? "LOCKED" : result.range.state, updatedAt: new Date().toISOString() };
  }

  lock(range: TradingRange): TradingRange {
    return { ...range, state: "LOCKED", lockedAt: range.lockedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  }

  invalidate(range: TradingRange, reason: string): TradingRange {
    return withLifecycleReason({ ...range, state: "INVALIDATED", updatedAt: new Date().toISOString() }, reason);
  }

  expire(range: TradingRange, reason: string): TradingRange {
    return withLifecycleReason({ ...range, state: "EXPIRED", expiresAt: range.expiresAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() }, reason);
  }

  complete(range: TradingRange): TradingRange {
    return { ...range, state: "COMPLETED", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }

  merge(ranges: TradingRange[]): TradingRange | null {
    if (ranges.length === 0) return null;
    const high = Math.max(...ranges.map((range) => range.high));
    const low = Math.min(...ranges.map((range) => range.low));
    return tradingRangeFromBounds({
      context: {
        symbol: ranges[0].symbol,
        now: new Date().toISOString(),
        timezone: "America/New_York",
        candles5m: [],
        strategyVersion: ranges[0].strategyVersion
      },
      source: "COMPOSITE_RANGE",
      formationMethod: "PRICE_BASED",
      state: "LOCKED",
      high,
      low,
      startedAt: ranges.map((range) => range.startedAt).sort()[0],
      detectedAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(),
      qualityScore: Math.min(100, Math.round(ranges.reduce((sum, range) => sum + Number(range.qualityScore ?? 70), 0) / ranges.length + 5)),
      evidence: {
        candleIds: ranges.flatMap((range) => range.sourceEvidence.candleIds),
        startCandleId: ranges[0].sourceEvidence.startCandleId,
        endCandleId: ranges.at(-1)?.sourceEvidence.endCandleId ?? null,
        validationRules: [rule("COMPOSITE_RANGE_MERGED", "Aligned ranges merged as composite evidence", "PASS", false, ranges.length, 2)]
      }
    });
  }
}

export class FalseBreakoutEngine {
  evaluate(range: TradingRange, candle: Candle, previousCandles: Candle[] = []): FalseBreakoutEvaluation {
    const previousAbove = previousCandles.some((item) => item.high > range.upperZone.upperBound || item.close > range.upperZone.upperBound);
    const previousBelow = previousCandles.some((item) => item.low < range.lowerZone.lowerBound || item.close < range.lowerZone.lowerBound);
    const inside = candle.close <= range.upperZone.upperBound && candle.close >= range.lowerZone.lowerBound;
    const wickAbove = candle.high > range.upperZone.upperBound && candle.close <= range.upperZone.upperBound;
    const wickBelow = candle.low < range.lowerZone.lowerBound && candle.close >= range.lowerZone.lowerBound;
    if ((previousAbove || wickAbove) && (previousBelow || wickBelow)) {
      return { status: "DOUBLE_SIDED_FALSE_BREAK", falseBreakout: true, direction: null, failedBoundary: null, reclaimedInside: inside, reason: "Both range boundaries have been swept/reclaimed." };
    }
    if (wickAbove) return { status: "WICK_ONLY_FALSE_BREAK", falseBreakout: true, direction: "LONG", failedBoundary: "HIGH", reclaimedInside: true, reason: "High boundary swept but candle closed back inside." };
    if (wickBelow) return { status: "WICK_ONLY_FALSE_BREAK", falseBreakout: true, direction: "SHORT", failedBoundary: "LOW", reclaimedInside: true, reason: "Low boundary swept but candle closed back inside." };
    if (previousAbove && inside) return { status: "CLOSE_THROUGH_RECLAIM", falseBreakout: true, direction: "LONG", failedBoundary: "HIGH", reclaimedInside: true, reason: "Prior high break reclaimed back inside range." };
    if (previousBelow && inside) return { status: "CLOSE_THROUGH_RECLAIM", falseBreakout: true, direction: "SHORT", failedBoundary: "LOW", reclaimedInside: true, reason: "Prior low break reclaimed back inside range." };
    return { status: "NONE", falseBreakout: false, direction: null, failedBoundary: null, reclaimedInside: false, reason: "No false breakout detected." };
  }
}

export class RetestEngine {
  evaluate(range: TradingRange, direction: "LONG" | "SHORT", candle: Candle, profile: RangeBreakoutProfile = RANGE_BREAKOUT_PROFILES[range.source], previousCandles: Candle[] = []) {
    const estimatedAtr = Number(range.widthAtr) && Number(range.widthAtr) > 0 ? range.width / Number(range.widthAtr) : range.width;
    const tolerance = profile.source === "HORIZONTAL_CONSOLIDATION" ? Math.max(estimatedAtr * 0.08, range.width * 0.02) : range.width * 0.1;
    const zone = direction === "LONG" ? boundary(range.high, tolerance, "ATR", 0.08) : boundary(range.low, tolerance, "ATR", 0.08);
    const inZone = direction === "LONG" ? candle.low <= zone.upperBound && candle.high >= zone.lowerBound : candle.high >= zone.lowerBound && candle.low <= zone.upperBound;
    const fullRange = Math.max(candle.high - candle.low, 0.00001);
    const bodyRatio = Math.abs(candle.close - candle.open) / fullRange;
    const bullish = candle.close > candle.open;
    const bearish = candle.close < candle.open;
    const deepInside = direction === "LONG" ? candle.close < range.midpoint : candle.close > range.midpoint;
    const oppositeBroken = direction === "LONG" ? candle.close < range.low : candle.close > range.high;
    const breakoutIndex = firstBreakoutIndex(previousCandles, range, direction);
    const maximumRetestCandles = profile.maximumRetestCandles ?? 6;
    if (breakoutIndex >= 0 && previousCandles.length - breakoutIndex > maximumRetestCandles && !inZone) {
      return { status: "EXPIRED", confirmed: false, invalidated: false, expired: true, inZone, deepInside, reason: `Retest did not occur within ${maximumRetestCandles} candles.` } satisfies RetestEvaluation;
    }
    if (oppositeBroken) return { status: "INVALIDATED", confirmed: false, invalidated: true, inZone, deepInside, reason: "Opposite range boundary broke before retest confirmed." } satisfies RetestEvaluation;
    if (!inZone) return { status: "WAITING", confirmed: false, invalidated: false, inZone, deepInside, reason: "Waiting for retest into boundary zone." } satisfies RetestEvaluation;
    const confirmed = direction === "LONG"
      ? candle.close > range.high && bullish && bodyRatio >= 0.45 && !deepInside
      : candle.close < range.low && bearish && bodyRatio >= 0.45 && !deepInside;
    return {
      status: confirmed ? "CONFIRMED" : "WAITING",
      confirmed,
      invalidated: false,
      inZone,
      deepInside,
      reason: confirmed ? "Retest confirmed by rejection candle." : "Retest touched zone but confirmation candle is incomplete."
    } satisfies RetestEvaluation;
  }
}

export function evaluateBreakoutRetestLifecycle(
  range: TradingRange,
  candles: Candle[],
  profile: RangeBreakoutProfile = RANGE_BREAKOUT_PROFILES[range.source]
): BreakoutRetestLifecycleEvaluation {
  const formationEndedAt = range.sourceEvidence.endCandleId ?? range.lockedAt ?? range.detectedAt;
  const formationEnd = new Date(formationEndedAt).getTime();
  const postFormation = candles.filter((candle) => new Date(candle.timestampUtc).getTime() > formationEnd);
  const current = postFormation.at(-1) ?? null;
  if (!current) {
    return { rangeState: "LOCKED", breakout: null, breakoutCandle: null, falseBreakout: null, retest: null };
  }

  let confirmedBreakout: BreakoutEvaluation | null = null;
  let breakoutCandle: Candle | null = null;
  for (const candle of postFormation) {
    const evaluation = evaluateRangeBreakout(range, candle, profile);
    if (!evaluation.confirmed || !evaluation.direction) continue;
    confirmedBreakout = evaluation;
    breakoutCandle = candle;
    break;
  }

  const currentIndex = postFormation.length - 1;
  const historyBeforeCurrent = postFormation.slice(0, currentIndex);
  if (!confirmedBreakout || !breakoutCandle || !confirmedBreakout.direction) {
    const breakout = evaluateRangeBreakout(range, current, profile);
    const falseBreakout = new FalseBreakoutEngine().evaluate(range, current, historyBeforeCurrent);
    return {
      rangeState: falseBreakout.falseBreakout
        ? "FALSE_BREAKOUT"
        : breakout.status === "WICK_ONLY"
          ? "BREAKOUT_CANDIDATE"
          : "LOCKED",
      breakout,
      breakoutCandle: breakout.confirmed ? current : null,
      falseBreakout,
      retest: breakout.confirmed
        ? { status: "WAITING", confirmed: false, invalidated: false, inZone: false, deepInside: false, reason: "Breakout confirmed; retest must occur on a later completed candle." }
        : null
    };
  }

  const breakoutIndex = postFormation.findIndex((candle) => candle.timestampUtc === breakoutCandle!.timestampUtc);
  if (breakoutIndex === currentIndex) {
    return {
      rangeState: "BREAKOUT_CONFIRMED",
      breakout: confirmedBreakout,
      breakoutCandle,
      falseBreakout: new FalseBreakoutEngine().evaluate(range, current, []),
      retest: { status: "WAITING", confirmed: false, invalidated: false, inZone: false, deepInside: false, reason: "Breakout confirmed; retest must occur on a later completed candle." }
    };
  }

  const postBreakoutHistory = postFormation.slice(breakoutIndex, currentIndex);
  const falseBreakout = new FalseBreakoutEngine().evaluate(range, current, postBreakoutHistory);
  const retest = new RetestEngine().evaluate(range, confirmedBreakout.direction, current, profile, postBreakoutHistory);
  return {
    rangeState: falseBreakout.falseBreakout
      ? "FALSE_BREAKOUT"
      : retest.status === "CONFIRMED"
        ? "RETEST_CONFIRMED"
        : retest.status === "INVALIDATED"
          ? "INVALIDATED"
          : retest.status === "EXPIRED"
            ? "EXPIRED"
            : "WAITING_FOR_RETEST",
    breakout: confirmedBreakout,
    breakoutCandle,
    falseBreakout,
    retest
  };
}

export class RangeConflictResolver {
  constructor(private readonly mergeToleranceAtr = 0.08) {}

  resolve(ranges: TradingRange[], currentDirection?: "LONG" | "SHORT" | null): ConflictResolution {
    const locked = ranges.filter((range) => range.state === "LOCKED" || range.state === "BREAKOUT_CONFIRMED" || range.state === "WAITING_FOR_RETEST" || range.state === "ENTRY_READY");
    if (locked.length === 0) return { status: "CLEAR", selectedRange: null, relationships: [], reason: "No active locked ranges." };
    const relationships: RangeRelationship[] = [];
    for (let i = 0; i < locked.length; i += 1) {
      for (let j = i + 1; j < locked.length; j += 1) {
        const relation = relationshipBetween(locked[i], locked[j], this.mergeToleranceAtr);
        if (relation) relationships.push(relation);
      }
    }
    const opposite = currentDirection && locked.some((range) => range.breakoutDirection && range.breakoutDirection !== currentDirection);
    if (opposite) return { status: "CONFLICT", selectedRange: null, relationships, reason: "Opposite-direction range setups conflict." };
    const selectedRange = [...locked].sort((left, right) => rangePriority(right) - rangePriority(left))[0] ?? null;
    const nested = relationships.some((relationship) => relationship.relationshipType === "NESTED");
    const aligned = relationships.some((relationship) => ["OVERLAPPING", "SUPPORTING", "COMPOSITE_SOURCE"].includes(relationship.relationshipType));
    return {
      status: nested ? "NESTED" : aligned ? "ALIGNED" : "CLEAR",
      selectedRange,
      relationships,
      reason: nested ? "Nested range relationship detected." : aligned ? "Aligned range evidence can be attached without duplicate trades." : "No range conflict."
    };
  }
}

export class RangeDecisionEngine {
  decide(input: {
    range: TradingRange | null;
    breakout?: BreakoutEvaluation | null;
    falseBreakout?: FalseBreakoutEvaluation | null;
    retest?: RetestEvaluation | null;
    conflict?: ConflictResolution | null;
    dataHealthy?: boolean;
    riskPermitted?: boolean;
    signalMode?: RangeSignalMode;
  }) {
    if (input.dataHealthy === false) return decision("BLOCKED", "DATA_UNHEALTHY");
    if (!input.range) return decision("WAITING_FOR_RANGE", "No valid locked range selected.");
    if (input.conflict?.status === "CONFLICT") return decision("NO_TRADE", input.conflict.reason);
    if (input.range.state === "INVALIDATED") return decision("INVALIDATED", "Range was invalidated.");
    if (input.range.state === "EXPIRED") return decision("EXPIRED", "Range expired.");
    if (input.falseBreakout?.falseBreakout) return decision("FALSE_BREAKOUT", input.falseBreakout.reason);
    if (!input.breakout || input.breakout.status === "NONE") return decision("WAITING_FOR_BREAKOUT", "Range locked; waiting for breakout.");
    if (input.breakout.status === "WICK_ONLY") return decision(input.breakout.direction === "LONG" ? "POTENTIAL_BUY" : "POTENTIAL_SELL", input.breakout.reason);
    if (input.retest?.status === "EXPIRED") return decision("EXPIRED", input.retest.reason);
    if (input.retest && input.retest.status === "WAITING") return decision("WAITING_FOR_RETEST", input.retest.reason);
    if (input.retest?.invalidated) return decision("INVALIDATED", input.retest.reason);
    if (input.breakout.directEntryBlocked) return decision("WAITING_FOR_RETEST", input.breakout.reason);
    if (input.riskPermitted === false) return decision("BLOCKED", "Risk engine blocked the setup.");
    if (input.signalMode === "OBSERVATION_ONLY" || input.signalMode === "BACKTEST_ONLY" || input.signalMode === "DISABLED") return decision("RANGE_LOCKED", "Range signal mode is not active.");
    return decision(input.breakout.direction === "LONG" ? "BUY_READY" : "SELL_READY", "Range breakout setup is ready.");
  }
}

function tradingRangeFromBounds(input: {
  context: RangeDetectionContext;
  source: RangeSource;
  formationMethod: RangeFormationMethod;
  state: RangeState;
  high: number;
  low: number;
  startedAt: string;
  detectedAt: string;
  lockedAt?: string;
  widthAtr?: number | null;
  qualityScore?: number;
  evidence: RangeEvidence;
}) {
  const width = input.high - input.low;
  const midpoint = (input.high + input.low) / 2;
  const tolerance = input.formationMethod === "TIME_BASED" ? 0 : width * 0.02;
  const now = new Date().toISOString();
  return {
    id: `${input.source}:${input.startedAt}:${input.high.toFixed(2)}:${input.low.toFixed(2)}`,
    symbol: input.context.symbol,
    source: input.source,
    formationMethod: input.formationMethod,
    detectorVersion: input.source === "MAX_OPTIONS_ORB" || input.source === "MAX_OPTIONS_NY_ORB" ? "ORB_ADAPTER_V1" : input.source === "HORIZONTAL_CONSOLIDATION" ? "HORIZONTAL_RANGE_DETECTOR_V1" : "RANGE_DETECTOR_V1",
    strategyVersion: input.context.strategyVersion,
    timeframe: "5min",
    startedAt: input.startedAt,
    detectedAt: input.detectedAt,
    lockedAt: input.lockedAt,
    high: input.high,
    low: input.low,
    midpoint,
    width,
    widthAtr: input.widthAtr,
    upperZone: boundary(input.high, tolerance, input.formationMethod === "TIME_BASED" ? "EXACT" : "PERCENT_OF_RANGE", input.formationMethod === "TIME_BASED" ? 0 : 0.02),
    lowerZone: boundary(input.low, tolerance, input.formationMethod === "TIME_BASED" ? "EXACT" : "PERCENT_OF_RANGE", input.formationMethod === "TIME_BASED" ? 0 : 0.02),
    sourceEvidence: input.evidence,
    qualityScore: input.qualityScore,
    confidenceScore: input.qualityScore,
    parentRangeId: null,
    childRangeIds: [],
    supportingRangeIds: [],
    state: input.state,
    createdAt: now,
    updatedAt: now
  } satisfies TradingRange;
}

function formingResult(detectorCode: string, context: RangeDetectionContext, candles: Candle[], session: NonNullable<RangeDetectionContext["sessionContext"]>): RangeDetectionResult {
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const high = highs.length ? Math.max(...highs) : 0;
  const low = lows.length ? Math.min(...lows) : 0;
  const evidence = {
    candleIds: candles.map(candleId),
    startCandleId: candles[0] ? candleId(candles[0]) : null,
    endCandleId: candles.at(-1) ? candleId(candles.at(-1)!) : null,
    sessionName: session.sessionName,
    sessionTimezone: session.sessionTimezone,
    fixedStartTime: session.rangeStart,
    fixedEndTime: session.rangeEnd,
    validationRules: [rule("ORB_FORMING", "ORB range is forming", "WAITING", false, candles.length, 3)]
  };
  return {
    detectorCode,
    status: "FORMING",
    range: highs.length && lows.length
      ? tradingRangeFromBounds({ context, source: "MAX_OPTIONS_ORB", formationMethod: "TIME_BASED", state: "FORMING", high, low, startedAt: session.rangeStart!, detectedAt: context.now, evidence })
      : undefined,
    evidence,
    failures: [],
    warnings: []
  };
}

function emptyResult(detectorCode: string, status: RangeDetectionResult["status"], explanation: string): RangeDetectionResult {
  const evaluation = rule(`${detectorCode}_${status}`, explanation, status === "INVALID" ? "FAIL" : "WAITING", false, null, null);
  return {
    detectorCode,
    status,
    evidence: { candleIds: [], startCandleId: null, endCandleId: null, validationRules: [evaluation] },
    failures: status === "INVALID" ? [evaluation] : [],
    warnings: status === "INVALID" ? [] : [evaluation]
  };
}

function rejectedHorizontalStructureResult(detectorCode: string, context: RangeDetectionContext, candles: Candle[], config: HorizontalRangeConfig): RangeDetectionResult {
  if (candles.length < config.minimumRangeCandles) return emptyResult(detectorCode, "NONE", "No valid horizontal consolidation range detected.");
  const atr = Math.max(Number(context.atr5m ?? medianTrueRange(candles) ?? 0), 0.00001);
  const highSlope = signedBoundarySlopeAtrPerBar(candles.map((candle) => candle.high), atr);
  const lowSlope = signedBoundarySlopeAtrPerBar(candles.map((candle) => candle.low), atr);
  const flatThreshold = Math.max(config.maximumBoundarySlopeAtrPerBar, 0.02);
  const classification = classifyRejectedStructure(highSlope, lowSlope, flatThreshold);
  const evaluation = rule(
    "HORIZONTAL_STRUCTURE_CLASSIFICATION",
    `Rejected non-horizontal structure: ${classification}`,
    "FAIL",
    true,
    `${highSlope.toFixed(3)}/${lowSlope.toFixed(3)}`,
    `both slopes <= ${flatThreshold}`
  );
  return {
    detectorCode,
    status: "NONE",
    evidence: {
      candleIds: candles.map(candleId),
      startCandleId: candles[0] ? candleId(candles[0]) : null,
      endCandleId: candles.at(-1) ? candleId(candles.at(-1)!) : null,
      structureClassification: classification,
      upperSlopeAtrPerBar: Number(Math.abs(highSlope).toFixed(3)),
      lowerSlopeAtrPerBar: Number(Math.abs(lowSlope).toFixed(3)),
      validationRules: [evaluation]
    },
    failures: [evaluation],
    warnings: []
  };
}

function classifyRejectedStructure(highSlopeAtrPerBar: number, lowSlopeAtrPerBar: number, flatThreshold: number) {
  const highUp = highSlopeAtrPerBar > flatThreshold;
  const highDown = highSlopeAtrPerBar < -flatThreshold;
  const lowUp = lowSlopeAtrPerBar > flatThreshold;
  const lowDown = lowSlopeAtrPerBar < -flatThreshold;
  const highFlat = Math.abs(highSlopeAtrPerBar) <= flatThreshold;
  const lowFlat = Math.abs(lowSlopeAtrPerBar) <= flatThreshold;
  if (highUp && lowUp) return "ASCENDING_CHANNEL";
  if (highDown && lowDown) return "DESCENDING_CHANNEL";
  if (highFlat && lowUp) return "ASCENDING_TRIANGLE";
  if (lowFlat && highDown) return "DESCENDING_TRIANGLE";
  if (highDown && lowUp) return "SYMMETRICAL_TRIANGLE";
  return "UNKNOWN_NON_HORIZONTAL";
}

function boundary(center: number, tolerance: number, toleranceMethod: RangeBoundaryZone["toleranceMethod"], toleranceValue: number): RangeBoundaryZone {
  return { center, lowerBound: center - tolerance, upperBound: center + tolerance, toleranceMethod, toleranceValue };
}

function rule(ruleCode: string, name: string, status: RuleEvaluation["status"], blocking: boolean, actualValue: unknown, requiredValue: unknown): RuleEvaluation {
  return {
    ruleCode,
    name,
    status,
    blocking,
    source: "AUTOMATIC",
    ruleLayer: blocking ? "MANDATORY" : "EVIDENCE",
    requiredForEntry: false,
    actualValue: primitive(actualValue),
    requiredValue: primitive(requiredValue),
    explanation: name
  };
}

function primitive(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return value == null ? null : String(value);
}

function candleId(candle: Candle) {
  return candle.timestampUtc;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function medianTrueRange(candles: Candle[]) {
  return median(candles.map((candle) => candle.high - candle.low).filter((value) => value > 0));
}

function independentTouches(candles: Candle[], predicate: (candle: Candle) => boolean, minimumBarsBetweenTouches: number) {
  let touches = 0;
  let lastTouchIndex = -Infinity;
  for (let index = 0; index < candles.length; index += 1) {
    if (!predicate(candles[index])) continue;
    if (index - lastTouchIndex >= minimumBarsBetweenTouches) touches += 1;
    lastTouchIndex = index;
  }
  return touches;
}

function boundaryReactionPoints(candles: Candle[], side: "UPPER" | "LOWER", zone: RangeBoundaryZone, midpoint: number, minimumBarsBetweenTouches: number) {
  const points: Array<{ index: number; price: number }> = [];
  let lastTouchIndex = -Infinity;
  let visitedOppositeHalf = true;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const oppositeHalf = side === "UPPER" ? candle.close < midpoint : candle.close > midpoint;
    if (oppositeHalf) visitedOppositeHalf = true;
    const rejectedBoundary = side === "UPPER"
      ? candle.high >= zone.lowerBound && candle.close <= zone.upperBound
      : candle.low <= zone.upperBound && candle.close >= zone.lowerBound;
    if (!rejectedBoundary) continue;
    const independent = index - lastTouchIndex >= minimumBarsBetweenTouches || visitedOppositeHalf;
    if (independent) {
      points.push({ index, price: side === "UPPER" ? candle.high : candle.low });
      visitedOppositeHalf = false;
    }
    lastTouchIndex = index;
  }
  return points;
}

function directionalEfficiency(candles: Candle[]) {
  if (candles.length < 2) return 1;
  const netMove = Math.abs(candles.at(-1)!.close - candles[0].close);
  const totalPath = candles.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - candles[index].close), 0);
  return totalPath > 0 ? netMove / totalPath : 1;
}

function midpointCrosses(candles: Candle[], midpoint: number) {
  if (candles.length < 2) return 0;
  let crosses = 0;
  let previous = candles[0].close >= midpoint;
  for (const candle of candles.slice(1)) {
    const current = candle.close >= midpoint;
    if (current !== previous) crosses += 1;
    previous = current;
  }
  return crosses;
}

function midpointBalanceRatio(candles: Candle[], midpoint: number) {
  if (candles.length === 0) return 0;
  const above = candles.filter((candle) => candle.close >= midpoint).length;
  const below = candles.length - above;
  return 1 - Math.abs(above - below) / candles.length;
}

function boundarySlopeAtrPerBar(values: number[], atr: number) {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values.at(-1)!;
  return Number((Math.abs((last - first) / (values.length - 1)) / Math.max(atr, 0.00001)).toFixed(3));
}

function signedBoundarySlopeAtrPerBar(values: number[], atr: number) {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values.at(-1)!;
  return Number((((last - first) / (values.length - 1)) / Math.max(atr, 0.00001)).toFixed(3));
}

function reactionSlopeAtrPerBar(points: Array<{ index: number; price: number }>, atr: number) {
  if (points.length < 2) return 0;
  const count = points.length;
  const meanX = points.reduce((sum, point) => sum + point.index, 0) / count;
  const meanY = points.reduce((sum, point) => sum + point.price, 0) / count;
  const varianceX = points.reduce((sum, point) => sum + (point.index - meanX) ** 2, 0);
  if (varianceX <= 0) return 0;
  const covariance = points.reduce((sum, point) => sum + (point.index - meanX) * (point.price - meanY), 0);
  const slope = covariance / varianceX;
  return Number((Math.abs(slope) / Math.max(atr, 0.00001)).toFixed(3));
}

function firstBreakoutIndex(candles: Candle[], range: TradingRange, direction: "LONG" | "SHORT") {
  return candles.findIndex((candle) => direction === "LONG" ? candle.close > range.upperZone.upperBound : candle.close < range.lowerZone.lowerBound);
}

function horizontalQualityScore(input: {
  upperTouchCount: number;
  lowerTouchCount: number;
  containmentRatio: number;
  efficiencyRatio: number;
  midpointCrossCount: number;
  balancedMidpointRatio: number;
  upperSlopeAtrPerBar: number;
  lowerSlopeAtrPerBar: number;
  widthAtr: number;
  candleCount: number;
  config: HorizontalRangeConfig;
}) {
  const touchScore = Math.min(input.upperTouchCount / input.config.minimumUpperTouches, 1) * 15 + Math.min(input.lowerTouchCount / input.config.minimumLowerTouches, 1) * 15;
  const containment = Math.min(input.containmentRatio / input.config.minimumContainmentRatio, 1) * 15;
  const horizontality = Math.max(0, 1 - (input.upperSlopeAtrPerBar + input.lowerSlopeAtrPerBar) / Math.max(input.config.maximumBoundarySlopeAtrPerBar * 2, 0.00001)) * 15;
  const duration = Math.min(input.candleCount / input.config.maximumRangeCandles, 1) * 10;
  const midpoint = Math.min(input.midpointCrossCount / input.config.minimumMidpointCrosses, 1) * 10;
  const balance = Math.min(input.balancedMidpointRatio / 0.6, 1) * 10;
  const widthOk = input.widthAtr >= input.config.minimumWidthAtr && input.widthAtr <= input.config.maximumWidthAtr ? 10 : 0;
  return Math.round(touchScore + containment + horizontality + duration + midpoint + balance + widthOk);
}

function withLifecycleReason(range: TradingRange, reason: string): TradingRange {
  return {
    ...range,
    sourceEvidence: {
      ...range.sourceEvidence,
      validationRules: [
        ...range.sourceEvidence.validationRules,
        rule(`RANGE_${range.state}`, reason, range.state === "INVALIDATED" ? "FAIL" : "PASS", false, reason, null)
      ]
    }
  };
}

function decision(status: RangeDecision, reason: string) {
  return { status, reason };
}

function relationshipBetween(left: TradingRange, right: TradingRange, mergeToleranceAtr: number): RangeRelationship | null {
  const atr = Math.max(Number(left.widthAtr ?? right.widthAtr ?? Math.max(left.width, right.width)), 0.00001);
  const tolerance = atr * mergeToleranceAtr;
  const highDiff = Math.abs(left.high - right.high);
  const lowDiff = Math.abs(left.low - right.low);
  if (highDiff <= tolerance && lowDiff <= tolerance) {
    return {
      parentRangeId: left.id,
      childRangeId: right.id,
      relationshipType: "SUPPORTING",
      reason: "Range boundaries are aligned within merge tolerance."
    };
  }
  const leftContainsRight = right.high <= left.high && right.low >= left.low;
  const rightContainsLeft = left.high <= right.high && left.low >= right.low;
  if (leftContainsRight || rightContainsLeft) {
    const parent = leftContainsRight ? left : right;
    const child = leftContainsRight ? right : left;
    return {
      parentRangeId: parent.id,
      childRangeId: child.id,
      relationshipType: "NESTED",
      reason: "One range is nested inside another."
    };
  }
  const overlaps = left.low <= right.high && right.low <= left.high;
  if (overlaps) {
    return {
      parentRangeId: left.id,
      childRangeId: right.id,
      relationshipType: "OVERLAPPING",
      reason: "Ranges overlap but are not nested."
    };
  }
  return null;
}

function rangePriority(range: TradingRange) {
  if (range.source === "MAX_OPTIONS_NY_ORB" || range.source === "MAX_OPTIONS_ORB") return 100;
  if (range.source === "COMPOSITE_RANGE") return Number(range.qualityScore ?? 70) + 5;
  return Number(range.qualityScore ?? 0);
}
