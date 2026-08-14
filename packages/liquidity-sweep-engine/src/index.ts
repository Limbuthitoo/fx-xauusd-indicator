import type { Candle, Direction, RuleEvaluation } from "@orb-guide/shared-types";

export type LiquiditySweepState =
  | "IDLE"
  | "LEVEL_SELECTED"
  | "SWEEP_CANDIDATE"
  | "SWEEP_CONFIRMED"
  | "WAITING_FOR_CONFIRMATION"
  | "STRUCTURE_BREAK_CANDIDATE"
  | "STRUCTURE_BREAK_CONFIRMED"
  | "WAITING_FOR_RETEST"
  | "RETEST_REACHED"
  | "ENTRY_READY"
  | "TRADE_ACTIVE"
  | "TRADE_CLOSED"
  | "EXPIRED"
  | "LEVEL_APPROACH"
  | "SWEEP_DETECTED"
  | "DISPLACEMENT_CONFIRMED"
  | "BOS_CONFIRMED"
  | "ENTRY_ZONE_READY"
  | "WAITING_FOR_RETRACE"
  | "ENTRY_CONFIRMATION"
  | "SIGNAL_ACTIVE"
  | "BLOCKED"
  | "NO_TRADE"
  | "INVALIDATED";

export type LiquidityLevelType =
  | "PREVIOUS_WEEK_HIGH"
  | "PREVIOUS_WEEK_LOW"
  | "PREVIOUS_DAY_HIGH"
  | "PREVIOUS_DAY_LOW"
  | "ORB_HIGH"
  | "ORB_LOW"
  | "ASIAN_HIGH"
  | "ASIAN_LOW"
  | "LONDON_HIGH"
  | "LONDON_LOW"
  | "EQUAL_HIGH"
  | "EQUAL_LOW"
  | "ROUND_NUMBER"
  | "MANUAL_LEVEL"
  | "COMPOSITE"
  | "SWING_HIGH"
  | "SWING_LOW";

export type LiquidityLevelState =
  | "DETECTED"
  | "ACTIVE"
  | "APPROACHING"
  | "TOUCHED"
  | "PARTIALLY_SWEPT"
  | "SWEPT"
  | "RECLAIMED"
  | "ACCEPTED_BEYOND"
  | "CONSUMED"
  | "BROKEN"
  | "EXPIRED"
  | "MERGED"
  | "RETIRED";

export type LiquidityLevel = {
  id?: string;
  symbol?: string;
  type: LiquidityLevelType;
  side: "BUY_SIDE" | "SELL_SIDE";
  timeframe?: string;
  price: number;
  lowerBound?: number;
  upperBound?: number;
  formedAt?: string;
  confirmedAt?: string;
  lastTouchedAt?: string;
  expiresAt?: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  priorityScore?: number;
  freshnessScore?: number;
  reactionScore?: number;
  overlapScore?: number;
  qualityScore?: number;
  source: string;
  sourceIds?: string[];
  zoneHalfWidth?: number;
  touchCount?: number;
  sweepCount?: number;
  closeCountBeyond?: number;
  clusterSize?: number;
  status?: "ACTIVE" | "TOUCHED" | "SWEPT" | "BROKEN" | "EXPIRED";
  state?: LiquidityLevelState;
};

export type SwingPoint = {
  id: string;
  type: "HIGH" | "LOW";
  hierarchy?: "MICRO" | "INTERNAL" | "EXTERNAL";
  price: number;
  lowerBound?: number;
  upperBound?: number;
  candleIndex: number;
  formedAt: string;
  confirmedAt: string;
  timeframe: string;
  prominence: number;
  prominenceAtr: number;
  strengthScore: number;
  confidence?: number;
  classification?: "HH" | "HL" | "LH" | "LL" | "EQH" | "EQL";
  status: "ACTIVE" | "BROKEN" | "SWEPT" | "EXPIRED";
  state?: "CANDIDATE" | "CONFIRMED" | "PROTECTED" | "TESTED" | "BROKEN_BY_WICK" | "BROKEN_BY_CLOSE" | "INVALIDATED" | "EXPIRED";
  parentId?: string;
  previousSameTypeId?: string;
  previousOppositeTypeId?: string;
};

export type StructureState = "BULLISH" | "BEARISH" | "RANGING" | "TRANSITIONAL" | "UNKNOWN";
export type DataHealthState = "HEALTHY" | "DELAYED" | "STALE" | "DISCONNECTED" | "INCONSISTENT" | "RATE_LIMITED";
export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "COMPRESSED" | "EXPANDING" | "HIGH_VOLATILITY" | "LOW_VOLATILITY" | "TRANSITIONAL" | "NEWS_DRIVEN" | "UNKNOWN";
export type StructureAlignmentState = "ALIGNED" | "COUNTERTREND" | "NEUTRAL" | "CONFLICTING" | "UNKNOWN";
export type LiquidityReusePolicy = "NEVER_REUSE" | "REUSE_AFTER_RECLAIM" | "REUSE_ON_NEW_SESSION" | "MANUAL_REACTIVATION";
type ContextMode = "OFF" | "RECORD_ONLY" | "WARN_ONLY" | "REQUIRED";

export type StructureSummary = {
  timeframe: string;
  state: StructureState;
  latestHigh?: SwingPoint;
  latestLow?: SwingPoint;
  highClassification?: SwingPoint["classification"];
  lowClassification?: SwingPoint["classification"];
  toleranceAtr: number;
};

export type LiquiditySweepConfig = {
  timezone: string;
  newYorkStartTime: string;
  newYorkEndTime: string;
  nyPremarketStartTime: string;
  orbStartTime: string;
  orbEndTime: string;
  asianStartTime: string;
  asianEndTime: string;
  londonStartTime: string;
  londonEndTime: string;
  roundNumberStep: number;
  roundNumberWindowSteps: number;
  manualLevels?: Array<{ price: number; side?: "BUY_SIDE" | "SELL_SIDE"; label?: string; priority?: "HIGH" | "MEDIUM" | "LOW" }>;
  liquidityReusePolicy: LiquidityReusePolicy;
  liquidityMergeToleranceATR: number;
  maximumSwingLevelAgeDays: number;
  countertrendResolutionMode: "RECORD_ONLY" | "WARN" | "BLOCK";
  positionManagementMode: "FIXED_STOP_FIXED_TARGET";
  minimumTradesForInsight: number;
  emaFilterMode: "OFF" | "RECORD_ONLY" | "WARN_ONLY" | "REQUIRE_ALIGNMENT" | "REQUIRE_COUNTERTREND";
  volumeFilterMode: "OFF" | "RECORD_ONLY" | "WARN_ONLY" | "REQUIRE_EXPANSION";
  displacementFilterMode: ContextMode;
  marketContextMode: ContextMode;
  manualConfirmationRequired: boolean;
  maximumTradesPerSession: number;
  maximumActiveSetupsPerSymbol: number;
  maximumActivePositions: number;
  riskPerTradePercent: number;
  maximumDailyLossPercent: number;
  maximumWeeklyLossPercent: number;
  maximumConsecutiveLosses: number;
  zoneToleranceATR: number;
  equalityToleranceATR: number;
  minimumSwingProminenceATR: number;
  minimumBarsBetweenSwings: number;
  structureToleranceATR: number;
  protectedPointMinimumConfidence: "LOW" | "MEDIUM" | "HIGH";
  minimumSweepDistanceATR: number;
  maximumSweepDistanceATR: number;
  minimumSweepRejectionWickRatio: number;
  acceptanceCloseCount: number;
  acceptanceCloseDistanceATR: number;
  doubleSweepLookbackBars: number;
  closeBackMaximumBars: number;
  maximumSweepLookbackBars: number;
  minimumDisplacementRangeATR: number;
  minimumBodyPercentage: number;
  maximumBarsAfterSweep: number;
  pivotLeftBars: number;
  pivotRightBars: number;
  minimumBosCloseDistanceATR: number;
  maximumBarsAfterSweepForBos: number;
  maximumBarsAfterBosForEntry: number;
  minimumFvgSizeATR: number;
  entryAtFvgPercentage: number;
  minimumRiskReward: number;
  maximumStopATR: number;
  stopBufferATR: number;
  minimumSignalScore: number;
  maximumSpread: number;
  enableNewsFilter: boolean;
  requireHtfBias: boolean;
};

export type LiquiditySweepContext = {
  now: string;
  symbol: string;
  setupCandles: Candle[];
  biasCandles: Candle[];
  precisionCandles?: Candle[];
  spread?: number | null;
  newsStatus?: string;
  dataHealthStatus?: DataHealthState;
  rateLimited?: boolean;
  tradesTakenThisSession?: number;
  activeSetupsForSymbol?: number;
  currentOpenPositions?: number;
  dailyLossPercent?: number;
  weeklyLossPercent?: number;
  consecutiveLosses?: number;
  manualConfirmationCompleted?: boolean;
  configuration?: Partial<LiquiditySweepConfig>;
};

export type LiquiditySweepDecision = {
  scenario: string;
  direction: Direction | null;
  status: "WAIT" | "LONG SETUP READY" | "SHORT SETUP READY" | "NO TRADE" | "BLOCKED" | "INVALIDATED" | "EXPIRED";
  state: LiquiditySweepState;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  finalReason: string;
  evaluations: RuleEvaluation[];
  scenarioFlags: Record<string, unknown>;
  favorabilityScore: number;
  favorabilityGrade: "A+" | "A" | "B" | "C" | "D";
  favorabilityReasons: string[];
};

type Module2VariantCode =
  | "SWEEP_CLOSE_BACK_INSIDE"
  | "SWEEP_BOS"
  | "SWEEP_MSS"
  | "SWEEP_ENGULFING"
  | "SWEEP_BOS_RETEST"
  | "SWEEP_MSS_RETEST"
  | "SWEEP_EMA_ALIGNMENT"
  | "SWEEP_VOLUME_EXPANSION"
  | "SWEEP_MSS_DISPLACEMENT_RETEST"
  | "SWEEP_NO_CONFIRMATION";

type Module2Variant = {
  code: Module2VariantCode;
  profileKey: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";
  sortOrder: number;
  version: string;
  name: string;
  category: "RESEARCH" | "ENTRY_GRADE" | "PRODUCTION";
  approvalStatus: "RESEARCH_ONLY" | "PAPER_APPROVED" | "PRODUCTION_APPROVED";
  status: "PASS" | "WAIT" | "RESEARCH_ONLY";
  decision: "BUY_READY" | "SELL_READY" | "WAIT" | "RESEARCH_ONLY";
  paperEligible: boolean;
  score: number;
  requiredRules: string[];
  missingRules: string[];
  reason: string;
};

type SweepCandidate = {
  index: number;
  sweepIndex: number;
  level: LiquidityLevel;
  candle: Candle;
  closeBackCandle: Candle;
  distanceAtr: number;
  penetration: number;
  sweepType: "WICK_SWEEP" | "DELAYED_REJECTION_SWEEP" | "CLOSE_THROUGH_THEN_RECLAIM" | "DEEP_SWEEP";
  rejectionType: "CLOSE_BACK_INSIDE" | "WICK_REJECTION" | "DELAYED_CLOSE_BACK";
  wickRatio: number;
  resolutionBars: number;
  sweptAt: string;
  closedBackAt: string;
};

const MODULE2_VARIANT_VERSION = "ULTIMATE_LIQUIDITY_SWEEP_V1.0";

type SweepInvalidation = {
  index: number;
  level: LiquidityLevel;
  candle: Candle;
  reason: "SWEEP_TOO_SMALL" | "SWEEP_TOO_DEEP" | "NO_REJECTION" | "ACCEPTED_BEYOND_LEVEL" | "POSSIBLE_BREAKOUT";
  distanceAtr: number;
  occurredAt: string;
  detail: string;
};

const DEFAULT_CONFIG: LiquiditySweepConfig = {
  timezone: "America/New_York",
  newYorkStartTime: "09:30",
  newYorkEndTime: "16:00",
  nyPremarketStartTime: "08:00",
  orbStartTime: "09:30",
  orbEndTime: "09:45",
  asianStartTime: "19:00",
  asianEndTime: "04:00",
  londonStartTime: "03:00",
  londonEndTime: "09:30",
  roundNumberStep: 10,
  roundNumberWindowSteps: 4,
  manualLevels: [],
  liquidityReusePolicy: "NEVER_REUSE",
  liquidityMergeToleranceATR: 0.05,
  maximumSwingLevelAgeDays: 5,
  countertrendResolutionMode: "WARN",
  positionManagementMode: "FIXED_STOP_FIXED_TARGET",
  minimumTradesForInsight: 30,
  emaFilterMode: "RECORD_ONLY",
  volumeFilterMode: "RECORD_ONLY",
  displacementFilterMode: "WARN_ONLY",
  marketContextMode: "RECORD_ONLY",
  manualConfirmationRequired: false,
  maximumTradesPerSession: 2,
  maximumActiveSetupsPerSymbol: 2,
  maximumActivePositions: 2,
  riskPerTradePercent: 0.25,
  maximumDailyLossPercent: 0.75,
  maximumWeeklyLossPercent: 2.0,
  maximumConsecutiveLosses: 3,
  zoneToleranceATR: 0.02,
  equalityToleranceATR: 0.05,
  minimumSwingProminenceATR: 0.2,
  minimumBarsBetweenSwings: 3,
  structureToleranceATR: 0.03,
  protectedPointMinimumConfidence: "MEDIUM",
  minimumSweepDistanceATR: 0.02,
  maximumSweepDistanceATR: 0.5,
  minimumSweepRejectionWickRatio: 0.25,
  acceptanceCloseCount: 2,
  acceptanceCloseDistanceATR: 0.15,
  doubleSweepLookbackBars: 6,
  closeBackMaximumBars: 3,
  maximumSweepLookbackBars: 96,
  minimumDisplacementRangeATR: 1.2,
  minimumBodyPercentage: 0.6,
  maximumBarsAfterSweep: 5,
  pivotLeftBars: 2,
  pivotRightBars: 2,
  minimumBosCloseDistanceATR: 0.03,
  maximumBarsAfterSweepForBos: 10,
  maximumBarsAfterBosForEntry: 15,
  minimumFvgSizeATR: 0.1,
  entryAtFvgPercentage: 50,
  minimumRiskReward: 1.5,
  maximumStopATR: 1.25,
  stopBufferATR: 0.03,
  minimumSignalScore: 80,
  maximumSpread: 0.8,
  enableNewsFilter: true,
  requireHtfBias: true
};

export function defaultLiquiditySweepConfiguration() {
  return { ...DEFAULT_CONFIG };
}

export function evaluateLiquiditySweepSetup(context: LiquiditySweepContext): LiquiditySweepDecision {
  const config = { ...DEFAULT_CONFIG, ...(context.configuration ?? {}) };
  const setupCandles = normalizeCandles(context.setupCandles);
  const biasCandles = normalizeCandles(context.biasCandles.length > 0 ? context.biasCandles : setupCandles);
  const current = setupCandles.at(-1);
  const evaluations: RuleEvaluation[] = [];
  const flags: Record<string, unknown> = {};

  if (!current || setupCandles.length < 20) {
    return waitDecision("WAITING_FOR_DATA", "Waiting for enough 5M candles to evaluate Ultimate Liquidity Sweep structure.", evaluations, flags);
  }

  const precisionCandles = normalizeCandles(context.precisionCandles ?? []);
  const dataHealth = inferDataHealth(context, setupCandles, biasCandles, precisionCandles);
  flags.dataHealth = dataHealth;
  push(evaluations, "DATA_HEALTHY", "Data health engine is healthy", dataHealth.status === "HEALTHY", true, "AUTOMATIC", dataHealth.status, "HEALTHY", dataHealth.reason);
  if (dataHealth.status !== "HEALTHY") {
    return blockedDecision("DATA_UNHEALTHY", `Data health engine blocked Module 2: ${dataHealth.reason}`, evaluations, flags);
  }

  const atr = averageTrueRange(setupCandles, 14);
  const rollingAtrMedian = medianTrueRange(setupCandles, 50);
  const internalSwings = detectSwingPoints(setupCandles, config.pivotLeftBars, config.pivotRightBars, atr, "5min", config);
  const externalSwings = detectSwingPoints(biasCandles, config.pivotLeftBars, config.pivotRightBars, averageTrueRange(biasCandles, 14), "15min", config);
  const internalStructure = classifyStructure(internalSwings, atr, config, "5min");
  const externalStructure = classifyStructure(externalSwings, averageTrueRange(biasCandles, 14), config, "15min");
  const htfBias = detectBias(biasCandles);
  const levels = detectLiquidityLevels(setupCandles, current.timestampUtc, atr, config);
  const structureGraph = buildStructureGraph(internalSwings, externalSwings, internalStructure, externalStructure, atr, config);
  const sessionContext = buildSessionContext(setupCandles, current, atr, config);
  const marketContext = buildMarketContext(setupCandles, biasCandles, levels, current, atr, htfBias, internalStructure, externalStructure, context);
  const marketRegime = detectMarketRegime(setupCandles, biasCandles, internalStructure, externalStructure, atr, rollingAtrMedian, context.newsStatus);
  const pivots = detectPivots(setupCandles, config.pivotLeftBars, config.pivotRightBars);
  const strategyCycleActive = isInsideNewYorkWindow(current.timestampUtc, config.newYorkStartTime, config.newYorkEndTime);
  const activeSessionName = sessionContext.current?.name ?? "All-session";
  const spreadOk = context.spread == null || context.spread <= config.maximumSpread;
  const newsOk = !config.enableNewsFilter || !String(context.newsStatus ?? "CLEAR").includes("BLOCKED");
  const tradeLimitOk = (context.tradesTakenThisSession ?? 0) < config.maximumTradesPerSession;
  const activeSetupOk = (context.activeSetupsForSymbol ?? 0) < config.maximumActiveSetupsPerSymbol;
  const activePositionOk = (context.currentOpenPositions ?? 0) < Math.max(1, config.maximumActivePositions);
  const dailyLossOk = (context.dailyLossPercent ?? 0) < config.maximumDailyLossPercent;
  const weeklyLossOk = (context.weeklyLossPercent ?? 0) < config.maximumWeeklyLossPercent;
  const consecutiveLossOk = (context.consecutiveLosses ?? 0) < config.maximumConsecutiveLosses;
  const manualConfirmationOk = !config.manualConfirmationRequired || context.manualConfirmationCompleted === true;
  const riskLimitsOk = dailyLossOk && weeklyLossOk && consecutiveLossOk;
  const paperTrackingEligible = tradeLimitOk && activeSetupOk && activePositionOk && riskLimitsOk;
  flags.terminologyVersion = "ULTIMATE_LIQUIDITY_SWEEP_STRUCTURE_CONFIRMATION_V1";
  flags.atr14 = Number(atr.toFixed(5));
  flags.precisionCandlesAvailable = precisionCandles.length;
  flags.marketContext = marketContext;
  flags.marketRegime = marketRegime;
  flags.sessionContext = sessionContext;
  flags.internalStructure = internalStructure;
  flags.externalStructure = externalStructure;
  flags.structureGraph = structureGraph;
  flags.recentSwings = internalSwings.slice(-12);
  flags.platformEngines = platformEngineContract(current, config);
  flags.stateMachine = {
    current: "IDLE",
    transitions: [{ from: null, to: "IDLE", at: current.timestampUtc, reason: "Processing latest closed 5M candle." }]
  };

  push(evaluations, "MARKET_CONTEXT_READY", "Market context engine ready", config.marketContextMode !== "REQUIRED" || marketContext.ready, config.marketContextMode === "REQUIRED", "AUTOMATIC", marketContext.summary, config.marketContextMode, marketContext.ready ? "15M/5M context, daily/session position, EMA, spread, news, and opposing liquidity context were prepared." : "Market context is incomplete.");
  push(evaluations, "MARKET_REGIME_CLASSIFIED", "Market regime classified", marketRegime.primary !== "UNKNOWN" || config.marketContextMode !== "REQUIRED", config.marketContextMode === "REQUIRED", "AUTOMATIC", marketRegime.primary, "known regime or non-required mode", marketRegime.explanation.join(" "));
  push(evaluations, "STRUCTURE_ALIGNMENT_CONTEXT", "Internal/external structure alignment resolved", config.countertrendResolutionMode !== "BLOCK" || structureGraph.alignmentState !== "COUNTERTREND", config.countertrendResolutionMode === "BLOCK", "AUTOMATIC", structureGraph.alignmentState, config.countertrendResolutionMode, structureGraph.conflictReason);
  push(evaluations, "SESSION_CONTEXT_READY", "Session context engine ready", Boolean(sessionContext.current), false, "AUTOMATIC", sessionContext.current?.name ?? "UNKNOWN", "active or completed context", sessionContext.current ? `${sessionContext.current.name} session context is ${sessionContext.current.state}.` : "No current session context could be classified.");
  push(evaluations, "NY_SESSION_ACTIVE", "Strategy cycle active", strategyCycleActive, true, "AUTOMATIC", `${activeSessionName} ${timeOnly(current.timestampUtc)}`, `${config.newYorkStartTime}-${config.newYorkEndTime}`, strategyCycleActive ? `Module 2 is evaluating the active ${activeSessionName} cycle.` : "Module 2 strategy cycle is outside the configured runtime window.");
  push(evaluations, "DAILY_TRADE_LIMIT", "Paper-trade session limit not reached", tradeLimitOk, false, "AUTOMATIC", context.tradesTakenThisSession ?? 0, `< ${config.maximumTradesPerSession}`, tradeLimitOk ? "Paper tracking can record another setup." : "The market signal remains visible, but another paper trade will not be opened in this session.");
  push(evaluations, "ACTIVE_SETUP_CONFLICT_CLEAR", "No duplicate paper setup", activeSetupOk, false, "AUTOMATIC", context.activeSetupsForSymbol ?? 0, `< ${config.maximumActiveSetupsPerSymbol}`, activeSetupOk ? "No duplicate same-symbol paper setup is present." : "The market signal remains visible, but duplicate paper tracking is suppressed.");
  push(evaluations, "NO_ACTIVE_TRADE_CONFLICT", "Paper-trade capacity available", activePositionOk, false, "AUTOMATIC", context.currentOpenPositions ?? 0, `< ${Math.max(1, config.maximumActivePositions)}`, activePositionOk ? "Paper-trade capacity is available for another distinct setup." : "The market signal remains visible while existing paper positions are managed.");
  push(evaluations, "RISK_LIMITS_CLEAR", "Daily, weekly, and consecutive-loss risk limits clear", riskLimitsOk, true, "AUTOMATIC", `D ${context.dailyLossPercent ?? 0}% / W ${context.weeklyLossPercent ?? 0}% / L ${context.consecutiveLosses ?? 0}`, `D < ${config.maximumDailyLossPercent}%, W < ${config.maximumWeeklyLossPercent}%, losses < ${config.maximumConsecutiveLosses}`, riskLimitsOk ? "Account/session risk limits allow a new BUY/SELL setup." : "Risk limits block a new BUY/SELL setup.");
  push(evaluations, "MANUAL_CONFIRMATION_COMPLETED", "Manual confirmation completed when required", manualConfirmationOk, config.manualConfirmationRequired, "AUTOMATIC", config.manualConfirmationRequired ? context.manualConfirmationCompleted === true : "AUTO_PAPER_MODE", config.manualConfirmationRequired ? "true" : "not required", manualConfirmationOk ? "Manual confirmation gate is satisfied for the configured mode." : "Manual confirmation is required before Module 2 can emit BUY_READY/SELL_READY.");

  if (!strategyCycleActive) {
    const nowMinutes = newYorkMinutes(current.timestampUtc);
    const startMinutes = parseTime(config.newYorkStartTime);
    const endMinutes = parseTime(config.newYorkEndTime);
    if (nowMinutes < startMinutes) {
      return waitDecision("SESSION_INACTIVE", "Waiting for the configured Module 2 strategy cycle before evaluating live sweep entries.", evaluations, flags);
    }
    if (nowMinutes > endMinutes) {
      return expiredDecision("SESSION_EXPIRED", "Module 2 strategy cycle has expired.", evaluations, flags);
    }
    return blockedDecision("HARD_RULE_BLOCK", "Module 2 hard rules failed before liquidity evaluation.", evaluations, flags);
  }
  if (!riskLimitsOk) {
    return blockedDecision("RISK_LIMIT_BLOCK", "Module 2 account loss limits blocked the setup before liquidity evaluation.", evaluations, flags);
  }
  if (!manualConfirmationOk) {
    return blockedDecision("MANUAL_CONFIRMATION_REQUIRED", "Manual confirmation is required before Module 2 can produce a live paper-entry signal.", evaluations, flags);
  }

  const sweepAnalysis = analyzeSweepCandidates(setupCandles, levels, atr, config);
  const sequence = detectBestLiquiditySequence(setupCandles, sweepAnalysis.candidates, pivots, internalSwings, atr, config);
  const sweep = sequence?.sweep ?? null;
  const latestSweepInvalidation = sweep
    ? sweepAnalysis.invalidations
      .filter((item) => sameLiquidityLevel(item.level, sweep.level) && item.index >= sweep.sweepIndex && item.index <= sweep.index)
      .at(-1) ?? null
    : sweepAnalysis.invalidations.at(-1) ?? null;
  const sweepAcceptanceOk = !latestSweepInvalidation || !["ACCEPTED_BEYOND_LEVEL", "POSSIBLE_BREAKOUT", "SWEEP_TOO_DEEP"].includes(latestSweepInvalidation.reason);
  const doubleSweepOk = !sweepAnalysis.doubleSweepWarning;
  push(evaluations, "LIQUIDITY_LEVEL_IDENTIFIED", "Meaningful liquidity level identified", Boolean(sweep?.level), true, "AUTOMATIC", sweep?.level?.type ?? null, "PDH/PDL, Asian, London, equal high/low", sweep?.level ? `${sweep.level.type} at ${sweep.level.price.toFixed(2)} was selected.` : "No valid liquidity level has been swept.");
  push(evaluations, "LIQUIDITY_SWEEP_CONFIRMED", "Liquidity sweep confirmed", Boolean(sweep), true, "AUTOMATIC", sweep?.distanceAtr == null ? null : Number(sweep.distanceAtr.toFixed(2)), `${config.minimumSweepDistanceATR}-${config.maximumSweepDistanceATR} ATR`, sweep ? "Price traded beyond liquidity and closed back through the level within the allowed candles." : "No valid close-back sweep has been confirmed.");
  push(evaluations, "SWEEP_REJECTION_CONFIRMED", "Sweep rejection quality confirmed", Boolean(sweep), true, "AUTOMATIC", sweep ? sweep.sweepType : latestSweepInvalidation?.reason ?? null, "wick or delayed close-back rejection", sweep ? `${sweep.rejectionType} confirmed after ${sweep.resolutionBars} candle(s); wick rejection ratio ${Math.round(sweep.wickRatio * 100)}%.` : latestSweepInvalidation?.detail ?? "No valid rejection candle has confirmed yet.");
  push(evaluations, "SWEEP_ACCEPTANCE_BLOCK", "No acceptance beyond swept level", sweepAcceptanceOk, true, "AUTOMATIC", latestSweepInvalidation?.reason ?? "CLEAR", `fewer than ${config.acceptanceCloseCount} accepted closes`, sweepAcceptanceOk ? "No active acceptance/breakout invalidation is present." : latestSweepInvalidation?.detail ?? "Price accepted beyond the swept level.");
  push(evaluations, "DOUBLE_SWEEP_FILTER", "No conflicting double sweep", doubleSweepOk, false, "AUTOMATIC", sweepAnalysis.doubleSweepWarning ? "BUY_SIDE + SELL_SIDE" : "CLEAR", `not within ${config.doubleSweepLookbackBars} candles`, doubleSweepOk ? "No conflicting buy-side and sell-side sweep appeared in the recent decision window." : "Both sides were swept recently, so reduce confidence and require the rest of the sequence to confirm cleanly.");
  flags.sweepAnalysis = {
    candidates: sweepAnalysis.candidates.slice(0, 8),
    invalidations: sweepAnalysis.invalidations.slice(-8),
    doubleSweepWarning: sweepAnalysis.doubleSweepWarning,
    latestInvalidation: latestSweepInvalidation
  };
  flags.liquidityLifecycle = summarizeLiquidityLifecycle(levels);
  if (!sweep) return waitDecision("WAITING_FOR_SWEEP", "Waiting for a valid liquidity sweep and close-back.", evaluations, flags, levels, htfBias);
  if (!sweepAcceptanceOk) return blockedDecision("SWEEP_ACCEPTANCE_INVALIDATION", "Price accepted beyond the liquidity level instead of rejecting it.", evaluations, flags);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "LEVEL_SELECTED", sweep.closedBackAt, `${sweep.level.type} ${sweep.level.side} zone selected at ${sweep.level.price.toFixed(2)}.`);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "SWEEP_CANDIDATE", sweep.sweptAt, `Price penetrated ${sweep.level.type} by ${sweep.distanceAtr.toFixed(2)} ATR.`);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "SWEEP_CONFIRMED", sweep.closedBackAt, "Sweep rejection confirmed by close-back-inside rule.");

  const direction: Direction = sequence?.direction ?? (sweep.level.side === "SELL_SIDE" ? "LONG" : "SHORT");
  const displacement = sequence?.displacement ?? null;
  const displacementModeOk = config.displacementFilterMode !== "REQUIRED" || Boolean(displacement);
  push(evaluations, "DISPLACEMENT_CONFIRMED", `${direction === "LONG" ? "Bullish" : "Bearish"} displacement confirmed`, Boolean(displacement), config.displacementFilterMode === "REQUIRED", "AUTOMATIC", displacement?.rangeAtr == null ? null : Number(displacement.rangeAtr.toFixed(2)), `${config.displacementFilterMode}; >= ${config.minimumDisplacementRangeATR} ATR when required`, displacement ? "A strong directional candle appeared after the sweep." : "No strong displacement candle appeared after the sweep; default mode records this as context, not a live-entry blocker.");
  push(evaluations, "DISPLACEMENT_FILTER_MODE", "Displacement filter mode respected", displacementModeOk, config.displacementFilterMode === "REQUIRED", "AUTOMATIC", config.displacementFilterMode, "OFF / RECORD_ONLY / WARN_ONLY / REQUIRED", displacementModeOk ? "Displacement mode does not block this setup." : "Displacement is required by configuration and has not confirmed.");
  if (displacement) {
    flags.stateMachine = appendStateTransition(flags.stateMachine, "WAITING_FOR_CONFIRMATION", displacement.candle.timestampUtc, "Displacement confirmed; waiting for protected-structure break.");
  }

  const bos = sequence?.bos ?? null;
  const structureType = bos?.subtype ?? (htfBias === "NEUTRAL"
    ? "REVERSAL_MSS"
    : htfBias === (direction === "LONG" ? "BULLISH" : "BEARISH") ? "CONTINUATION_BOS" : "REVERSAL_MSS");
  push(evaluations, "PROTECTED_POINT_CONFIDENCE", "Protected structure point has usable confidence", Boolean(bos?.protectedPoint && protectedConfidenceRank(bos.protectedPoint.confidence) >= protectedConfidenceRank(config.protectedPointMinimumConfidence)), false, "AUTOMATIC", bos?.protectedPoint?.confidence ?? null, `>= ${config.protectedPointMinimumConfidence}`, bos?.protectedPoint ? `${bos.protectedPoint.type} at ${bos.protectedPoint.price.toFixed(2)} selected with ${bos.protectedPoint.confidence} confidence.` : "No protected structure point is available yet. This blocks only variants that require MSS/BOS.");
  push(evaluations, "BOS_CHOCH_CONFIRMED", `${structureType} confirmed by candle close`, Boolean(bos), false, "AUTOMATIC", bos?.level ?? null, `close beyond structure by ${config.minimumBosCloseDistanceATR} ATR`, bos ? `Candle body closed beyond the protected ${bos.protectedPoint?.type?.toLowerCase() ?? "structure point"}; classified ${structureType}.` : "No candle-close reversal MSS has confirmed yet. This blocks only variants that require MSS/BOS.");
  push(evaluations, "MSS_STRENGTH", "MSS strength confirmed", Boolean(bos?.breakDistanceAtr != null && bos.breakDistanceAtr >= config.minimumBosCloseDistanceATR && bos.bodyRatio >= 0.5), false, "AUTOMATIC", bos ? `${bos.breakDistanceAtr.toFixed(2)} ATR / ${Math.round(bos.bodyRatio * 100)}% body` : null, `>= ${config.minimumBosCloseDistanceATR} ATR and >= 50% body`, bos ? "The MSS close has enough break distance and body strength." : "Waiting for a strong closed-candle MSS. This blocks only variants that require MSS.");
  if (bos) {
    flags.stateMachine = appendStateTransition(flags.stateMachine, "STRUCTURE_BREAK_CONFIRMED", bos.candle.timestampUtc, `${structureType} confirmed by candle close beyond protected structure.`);
  }

  const currentIndex = setupCandles.length - 1;
  const fvg = sequence?.fvg ?? null;
  const orderBlock = sequence?.orderBlock ?? null;
  const zone = sequence?.zone ?? null;

  const setupFresh = bos ? currentIndex - bos.index <= config.maximumBarsAfterBosForEntry : currentIndex - sweep.index <= config.maximumBarsAfterSweep;
  if (!setupFresh) {
    flags.stateMachine = appendStateTransition(flags.stateMachine, "EXPIRED", current.timestampUtc, "Retest-based confirmation profiles expired; non-retest profiles may still be evaluated independently.");
  }

  push(evaluations, "ENTRY_ZONE_READY", "MSS retest zone ready", Boolean(zone), false, "AUTOMATIC", zone?.kind ?? null, "protected structure +/- 0.05 ATR", zone ? "The broken protected structure created a strict MSS retest zone." : "No protected-structure retest zone is available after MSS. This blocks only retest-based variants.");
  if (zone) {
    flags.stateMachine = appendStateTransition(flags.stateMachine, "ENTRY_ZONE_READY", zone.createdAt, `${zone.kind} entry zone prepared after structure break.`);
    flags.stateMachine = appendStateTransition(flags.stateMachine, "WAITING_FOR_RETEST", zone.createdAt, "Entry zone is ready; waiting for price to revisit the zone without invalidation.");
  }

  const retrace = zone && setupFresh ? current.low <= zone.high && current.high >= zone.low : false;
  push(evaluations, "ENTRY_ZONE_RETRACE", "Price retested MSS zone", retrace, false, "AUTOMATIC", retrace && zone ? `${zone.low.toFixed(2)}-${zone.high.toFixed(2)}` : candleShape(current), "current candle overlaps MSS retest zone", retrace ? "Price has returned into the protected-structure MSS retest zone." : "Price has not returned into the MSS retest zone yet. This blocks only retest-based variants.");
  if (retrace) {
    flags.stateMachine = appendStateTransition(flags.stateMachine, "RETEST_REACHED", current.timestampUtc, "Price overlapped the selected entry zone.");
  }

  const entryConfirmation = setupFresh && zone && bos ? confirmsMssRetest(current, direction, zone, bos.level, sweep) : false;
  const engulfingOk = confirmsEngulfingReversal(setupCandles, currentIndex, direction);
  const pinBarOk = confirmsPinBarRejection(current, direction);
  const insideBarBreakOk = confirmsInsideBarBreak(setupCandles, currentIndex, direction);
  const dojiRejectionOk = confirmsDojiRejection(current, direction);
  const volumeExpansionOk = confirmsVolumeExpansion(setupCandles, currentIndex);
  const emaAlignmentOk = ema200Aligned(biasCandles.length > 0 ? biasCandles : setupCandles, direction)
    && (!config.requireHtfBias || htfBias === (direction === "LONG" ? "BULLISH" : "BEARISH"));
  const emaCountertrendOk = !emaAlignmentOk && htfBias === (direction === "LONG" ? "BEARISH" : "BULLISH");
  const ema200Ok = config.emaFilterMode === "OFF" ? false : emaAlignmentOk;
  const sessionCandles = setupCandles.filter((candle) =>
    newYorkDateKey(candle.timestampUtc) === newYorkDateKey(current.timestampUtc)
      && newYorkMinutes(candle.timestampUtc) >= parseTime(config.newYorkStartTime)
  );
  const vwap = volumeWeightedAveragePrice(sessionCandles.length > 0 ? sessionCandles : setupCandles);
  const vwapRows = sessionCandles.length > 0 ? sessionCandles : setupCandles;
  const vwapVolumeCoverage = vwapRows.length > 0 ? vwapRows.filter((candle) => Number(candle.volume) > 0).length / vwapRows.length : 0;
  const vwapOk = vwapVolumeCoverage >= 0.8 && (direction === "LONG" ? current.close >= vwap : current.close <= vwap);
  const emaModeOk = config.emaFilterMode === "REQUIRE_ALIGNMENT"
    ? emaAlignmentOk
    : config.emaFilterMode === "REQUIRE_COUNTERTREND"
      ? emaCountertrendOk
      : true;
  const volumeModeOk = config.volumeFilterMode !== "REQUIRE_EXPANSION" || volumeExpansionOk;
  const fvgOk = Boolean(fvg);
  const orderBlockRetestOk = Boolean(orderBlock && current.low <= orderBlock.high && current.high >= orderBlock.low);
  const confirmations = [
    { code: "CONFIRM_EMA_200", name: "15M structure and 200 EMA alignment", passed: ema200Ok, points: 15, actual: `${config.emaFilterMode} / ${htfBias} / ${emaAlignmentOk ? "aligned" : emaCountertrendOk ? "countertrend" : "not aligned"}`, required: `${direction === "LONG" ? "BULLISH" : "BEARISH"} 15M context`, explanation: config.emaFilterMode === "OFF" ? "EMA mode is OFF; alignment is not counted as a confirmation." : ema200Ok ? "The completed 15M structure and EMA context align with the setup." : "The 15M structure/EMA context is neutral or opposes the setup." },
    { code: "CONFIRM_VWAP", name: "Session VWAP alignment", passed: vwapOk, points: 10, actual: `${current.close.toFixed(2)} / ${Math.round(vwapVolumeCoverage * 100)}% volume`, required: direction === "LONG" ? `>= ${vwap.toFixed(2)} with >=80% volume` : `<= ${vwap.toFixed(2)} with >=80% volume`, explanation: vwapOk ? "Price is aligned with a volume-backed session VWAP." : "Price is misaligned or provider volume is insufficient for true VWAP confirmation." },
    { code: "CONFIRM_FRESH_FVG", name: "Fresh Fair Value Gap", passed: fvgOk, points: 15, actual: fvg?.kind ?? null, required: "fresh FVG", explanation: fvgOk ? "A fresh FVG is available after displacement." : "No fresh FVG is available." },
    { code: "CONFIRM_ORDER_BLOCK_RETEST", name: "Order block retest", passed: orderBlockRetestOk, points: 10, actual: orderBlock ? `${orderBlock.low.toFixed(2)}-${orderBlock.high.toFixed(2)}` : null, required: "retest", explanation: orderBlockRetestOk ? "Price retested the detected order block." : "No order-block retest is confirmed." },
    { code: "CONFIRM_ENGULFING", name: "Engulfing rejection candle", passed: engulfingOk, points: 10, actual: candleShape(current), required: `${direction.toLowerCase()} engulfing after sweep`, explanation: engulfingOk ? "The latest completed candle engulfed the prior candle in the setup direction." : "No directional engulfing confirmation is present." },
    { code: "CONFIRM_PIN_BAR", name: "Pin bar rejection", passed: pinBarOk, points: 8, actual: candleShape(current), required: `${direction.toLowerCase()} rejection pin bar`, explanation: pinBarOk ? "The latest candle shows a rejection wick in the trade direction." : "No directional pin-bar rejection is present." },
    { code: "CONFIRM_INSIDE_BAR_BREAK", name: "Inside bar break", passed: insideBarBreakOk, points: 8, actual: candleShape(current), required: "inside-bar break in setup direction", explanation: insideBarBreakOk ? "The latest candle broke the prior inside-bar range in the setup direction." : "No inside-bar break confirmation is present." },
    { code: "CONFIRM_DOJI_REJECTION", name: "Doji rejection", passed: dojiRejectionOk, points: 6, actual: candleShape(current), required: "doji rejection with directional close", explanation: dojiRejectionOk ? "A small-body rejection candle closed in the setup direction." : "No doji-style rejection confirmation is present." },
    { code: "CONFIRM_VOLUME_EXPANSION", name: "Volume expansion record", passed: config.volumeFilterMode === "OFF" ? false : volumeExpansionOk, points: 5, actual: `${config.volumeFilterMode} / ${current.volume ?? "unavailable"}`, required: ">= 1.25x recent average volume", explanation: config.volumeFilterMode === "OFF" ? "Volume mode is OFF; provider volume is not counted." : volumeExpansionOk ? "Provider volume expanded versus the recent average." : "Provider volume is unavailable or has not expanded enough; this remains record-only unless required by mode." },
    { code: "CONFIRM_ENTRY_CANDLE", name: "Entry confirmation candle", passed: entryConfirmation, points: 10, actual: candleShape(current), required: "directional confirmation", explanation: entryConfirmation ? "The latest completed candle confirms the intended direction." : "The latest completed candle does not confirm retest entry. This blocks only variants that require an entry-zone confirmation candle." }
  ];
  for (const item of confirmations) {
    push(evaluations, item.code, item.name, item.passed, false, "AUTOMATIC", item.actual, item.required, `${item.explanation} (+${item.points})`);
  }
  const confirmationCount = confirmations.filter((item) => item.passed).length;
  const confirmationScore = confirmations.reduce((sum, item) => sum + (item.passed ? item.points : 0), 0);
  push(evaluations, "CONFIRMATION_COUNT", "Confirmation evidence count", confirmationCount >= 3, false, "AUTOMATIC", confirmationCount, `>= 3 of ${confirmations.length} for full-grade evidence`, confirmationCount >= 3 ? "Full-grade confirmation evidence passed." : "Fewer than 3 confirmation rules matched; this does not veto a selected independent variant whose own mandatory rules passed.");

  const plan = buildLayeredTradePlan(
    levels,
    direction,
    sweep,
    [zone, fvg, orderBlock].filter(Boolean) as TradePlanZone[],
    current,
    atr,
    config
  );
  const directionalConflictClear = resolveDirectionalConflict(direction, sequence, sweepAnalysis.candidates, config);
  push(evaluations, "DIRECTIONAL_CONFLICT_CLEAR", "Directional conflict resolution clear", directionalConflictClear.clear, true, "AUTOMATIC", directionalConflictClear.actual, "one confirmed direction per symbol", directionalConflictClear.reason);
  const atrVolatilityOk = current.close > 0 && atr / current.close >= 0.00015;
  const rrOk = plan.geometryValid && plan.rr >= 2 && plan.availableRewardRisk >= config.minimumRiskReward;
  const spreadRatio = context.spread == null ? 0 : context.spread / Math.max(0.01, Math.abs(plan.entry - plan.stop));
  const spreadDistanceOk = context.spread == null || spreadRatio <= 0.1;
  push(
    evaluations,
    "TRADE_GEOMETRY_VALID",
    "Directional entry, stop, and target geometry",
    plan.geometryValid,
    true,
    "AUTOMATIC",
    `${direction} ${plan.stop.toFixed(2)} / ${plan.entry.toFixed(2)} / ${plan.target.toFixed(2)}`,
    direction === "LONG" ? "stop < entry < target" : "target < entry < stop",
    plan.geometryValid ? "Stop and target are correctly positioned around entry." : "The setup has moved beyond its invalidation extreme; its stop/entry/target geometry is no longer tradable."
  );
  const quality = [
    { code: "QUALITY_ATR_VOLATILITY", name: "ATR volatility filter", passed: atrVolatilityOk, actual: `${((atr / current.close) * 100).toFixed(3)}%`, required: ">= 0.015%", explanation: atrVolatilityOk ? "ATR shows enough volatility for the setup." : "ATR volatility is too low." },
    { code: "QUALITY_SPREAD", name: "Spread filter", passed: spreadDistanceOk, blocking: true, actual: context.spread == null ? "unknown" : `${Math.round(spreadRatio * 100)}% of stop`, required: "<= 10% of stop distance", explanation: spreadDistanceOk ? "Spread is acceptable relative to the stop distance." : "Spread is too large relative to the stop distance." },
    { code: "QUALITY_NEWS", name: "No high-impact news", passed: newsOk, blocking: true, actual: context.newsStatus ?? "CLEAR", required: "CLEAR", explanation: newsOk ? "No high-impact news block is active." : "High-impact news filter is blocking the setup." },
    { code: "QUALITY_RR", name: "Minimum RR and opposing liquidity", passed: rrOk, blocking: true, actual: `${plan.rr.toFixed(2)}R target / ${plan.availableRewardRisk.toFixed(2)}R available`, required: "2R target and >= 1.5R before opposing liquidity", explanation: rrOk ? "Fixed 2R target is valid and opposing liquidity leaves enough room." : "Nearest opposing liquidity does not leave enough reward distance." },
    { code: "QUALITY_STOP_SIZE", name: "Maximum stop-loss size", passed: plan.stopValid, blocking: true, actual: Number(plan.stopDistanceAtr.toFixed(2)), required: `<= ${config.maximumStopATR} ATR with valid directional geometry`, explanation: plan.stopValid ? "Stop size and direction are acceptable." : plan.geometryValid ? "Stop size is too large." : "Stop placement is on the wrong side of entry." },
    { code: "QUALITY_FRESH_SETUP", name: "Fresh setup", passed: setupFresh, actual: bos ? currentIndex - bos.index : currentIndex - sweep.index, required: bos ? `<= ${config.maximumBarsAfterBosForEntry} candles after BOS` : `<= ${config.maximumBarsAfterSweep} candles after sweep`, explanation: setupFresh ? "Setup is still fresh." : "Setup is stale." }
  ];
  for (const item of quality) {
    push(evaluations, item.code, item.name, item.passed, "blocking" in item ? Boolean(item.blocking) : false, "AUTOMATIC", item.actual, item.required, item.explanation);
  }
  const qualityCount = quality.filter((item) => item.passed).length;
  push(evaluations, "QUALITY_FILTER_COUNT", "Quality evidence count", qualityCount >= 3, false, "AUTOMATIC", qualityCount, ">= 3 for full-grade evidence", qualityCount >= 3 ? "Full-grade quality evidence passed." : "Fewer than 3 quality filters passed; hard spread, news, RR, stop, geometry, and selected-profile risk gates still apply independently.");
  push(evaluations, "EMA_FILTER_MODE", "EMA filter mode respected", emaModeOk, ["REQUIRE_ALIGNMENT", "REQUIRE_COUNTERTREND"].includes(config.emaFilterMode), "AUTOMATIC", config.emaFilterMode, "OFF / RECORD_ONLY / WARN_ONLY / REQUIRE_ALIGNMENT / REQUIRE_COUNTERTREND", emaModeOk ? "EMA mode does not block this setup." : "EMA mode blocks this setup because the selected 15M EMA/context requirement is not satisfied.");
  push(evaluations, "VOLUME_FILTER_MODE", "Volume filter mode respected", volumeModeOk, config.volumeFilterMode === "REQUIRE_EXPANSION", "AUTOMATIC", config.volumeFilterMode, "OFF / RECORD_ONLY / WARN_ONLY / REQUIRE_EXPANSION", volumeModeOk ? "Volume mode does not block this setup." : "Volume mode requires expansion, but provider volume did not expand enough.");
  const riskOk = spreadDistanceOk && newsOk && rrOk && plan.stopValid && plan.geometryValid && emaModeOk && volumeModeOk && displacementModeOk && directionalConflictClear.clear;
  push(evaluations, "RISK_OK", "Risk engine approved trade plan", riskOk, true, "AUTOMATIC", `RR ${plan.rr.toFixed(2)} / stop ${plan.stopDistanceAtr.toFixed(2)} ATR`, `RR >= ${config.minimumRiskReward}, stop <= ${config.maximumStopATR} ATR, spread/news/filter gates clear`, riskOk ? "Risk engine approved the profile trade plan." : "Risk engine blocked the profile trade plan.");

  const gradeValue = tradeGrade(confirmationCount, qualityCount);
  const score = Math.min(100, Math.round(40 + confirmationScore + (qualityCount / quality.length) * 20));
  const scoreOk = score >= config.minimumSignalScore;
  const variants = module2VariantCandidates({
    direction,
    sweep,
    displacement,
    bos,
    structureType,
    zone,
    retrace,
    entryConfirmation,
    ema200Ok,
    vwapOk,
    fvgOk,
    engulfingOk,
    volumeExpansionOk,
    orderBlockRetestOk,
    spreadOk,
    newsOk,
    rrOk,
    stopValid: plan.stopValid,
    score,
    scoreOk,
    dataHealthOk: dataHealth.status === "HEALTHY",
    sessionActive: strategyCycleActive,
    tradeLimitOk,
    activeSetupOk,
    activePositionOk,
    riskLimitsOk,
    manualConfirmationOk,
    directionalConflictClear: directionalConflictClear.clear,
    geometryValid: plan.geometryValid,
    riskOk
  });
  const selectedVariant = selectModule2Variant(variants);
  push(evaluations, "VARIANT_SELECTED", "Production confirmation profile selected", Boolean(selectedVariant?.paperEligible), true, "AUTOMATIC", selectedVariant?.code ?? "NONE", "one signal-approved variant mandatory profile passes", selectedVariant ? selectedVariant.reason : "No signal-approved confirmation profile has completed. Variants are independent profiles; only one valid signal-approved profile is needed.");
  push(evaluations, "SIGNAL_SCORE", "Prediction confidence threshold", scoreOk, false, "AUTOMATIC", score, `>= ${config.minimumSignalScore} for prediction publication`, scoreOk ? "Module 2 confidence is high enough to publish an upcoming prediction." : "Confidence is below the prediction threshold; an independently valid BUY/SELL profile may still proceed through the risk engine.");
  const mandatoryEntryPassed = Boolean(selectedVariant?.paperEligible);
  const fullChecklistPassed = mandatoryEntryPassed && riskOk && evaluations.filter((item) => item.blocking).every((item) => item.status === "PASS") && confirmationCount >= 3 && qualityCount >= 3;
  flags.levels = levels;
  flags.htfBias = htfBias;
  flags.vwap = vwap;
  flags.vwapVolumeCoverage = vwapVolumeCoverage;
  flags.filterModes = {
    ema: config.emaFilterMode,
    volume: config.volumeFilterMode,
    emaAlignmentOk,
    emaCountertrendOk,
    volumeExpansionOk,
    emaModeOk,
    volumeModeOk
  };
  flags.sweep = sweep;
  flags.displacement = displacement;
  flags.bos = bos ? { ...bos, structureType } : null;
  flags.protectedPoint = bos?.protectedPoint ?? null;
  flags.entryZone = zone;
  flags.tradePlan = {
    source: plan.source,
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    riskReward: plan.rr,
    availableRewardRisk: plan.availableRewardRisk
  };
  flags.tradePlanCandidates = plan.candidates;
  flags.confirmationLayer = { count: confirmationCount, required: 3, score: confirmationScore, rules: confirmations };
  flags.qualityLayer = { count: qualityCount, required: 3, rules: quality };
  flags.module2Variant = selectedVariant;
  flags.module2Variants = variants;
  flags.variantCode = selectedVariant?.code ?? null;
  flags.variantVersion = selectedVariant?.version ?? MODULE2_VARIANT_VERSION;
  flags.tradeGrade = gradeValue;
  flags.confidence = score;
  flags.paperTrackingEligible = paperTrackingEligible;
  flags.paperTrackingBlockers = [
    !tradeLimitOk ? "DAILY_TRADE_LIMIT" : null,
    !activeSetupOk ? "ACTIVE_SETUP_CONFLICT_CLEAR" : null,
    !activePositionOk ? "NO_ACTIVE_TRADE_CONFLICT" : null,
    !riskLimitsOk ? "RISK_LIMITS_CLEAR" : null
  ].filter(Boolean);
  flags.profileEngine = {
    baseConditions: {
      sessionActive: strategyCycleActive,
      healthyData: setupCandles.length >= 20,
      validLiquidityLevel: Boolean(sweep?.level),
      sweepDetected: Boolean(sweep),
      conflictClear: directionalConflictClear.clear,
      riskLimitsOk,
      manualConfirmationOk
    },
    finalDecision: !mandatoryEntryPassed ? "WAIT" : riskOk ? direction === "LONG" ? "BUY_READY" : "SELL_READY" : "BLOCK",
    selectedProfile: selectedVariant?.code ?? null,
    riskOk
  };
  flags.mandatoryChecklistMatched = mandatoryEntryPassed && riskOk;
  flags.fullChecklistMatched = fullChecklistPassed;
  flags.setupTier = fullChecklistPassed && gradeValue !== "B" && gradeValue !== "C" ? "FULL" : mandatoryEntryPassed ? "MANDATORY" : "WATCH";
  const setupReady = mandatoryEntryPassed && riskOk;
  flags.state = setupReady ? "SIGNAL_ACTIVE" : "ENTRY_CONFIRMATION";
  flags.riskReward = plan.rr;
  flags.stateMachine = appendStateTransition(
    flags.stateMachine,
    setupReady ? "ENTRY_READY" : "ENTRY_CONFIRMATION",
    current.timestampUtc,
    setupReady
      ? "Selected profile and risk engine produced a setup-ready decision; confidence remains prediction evidence."
      : mandatoryEntryPassed
        ? "A strategy profile completed; downstream risk or confidence approval is still required."
        : "Strategy evidence is still waiting for an approved profile."
  );

  if (!mandatoryEntryPassed) {
    if (!selectedVariant && variants.some((item) => item.status === "WAIT")) {
      return {
        scenario: "WAITING_FOR_PROFILE_CONFIRMATION",
        direction,
        status: "WAIT",
        state: "ENTRY_CONFIRMATION",
        finalReason: `Sweep is confirmed. Waiting for one signal-approved confirmation profile to complete. Best waiting profile: ${variants.find((item) => item.status === "WAIT")?.name ?? "none"}.`,
        evaluations,
        scenarioFlags: flags,
        favorabilityScore: score,
        favorabilityGrade: gradeValue,
        favorabilityReasons: [
          "Base sweep conditions passed.",
          "No signal-approved confirmation profile has completed yet."
        ]
      };
    }
    return blockedDecision("NO_PAPER_PROFILE_SELECTED", "NO TRADE: no signal-approved confirmation profile is complete. Variants are independent; one approved variant must pass before BUY/SELL output.", evaluations, flags, direction, score);
  }

  if (!riskOk) {
    return blockedDecision("RISK_ENGINE_BLOCK", `BLOCK: ${selectedVariant?.name ?? "selected profile"} mandatory rules passed, but risk engine blocked entry.`, evaluations, flags, direction, score);
  }
  if (!fullChecklistPassed || gradeValue === "B" || gradeValue === "C") {
    return {
      scenario: direction === "LONG" ? `MANDATORY_${selectedVariant?.code ?? "LIQUIDITY_SWEEP"}_BUY` : `MANDATORY_${selectedVariant?.code ?? "LIQUIDITY_SWEEP"}_SELL`,
      direction,
      status: direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY",
      state: "SIGNAL_ACTIVE",
      entryPrice: plan.entry,
      stopPrice: plan.stop,
      targetPrice: plan.target,
      finalReason: `Mandatory Module 2 ${selectedVariant?.name ?? "selected profile"} checklist passed. Paper setup created from the completed confirmation profile and risk approval. Confirmations ${confirmationCount}/${confirmations.length}, quality ${qualityCount}/6, confidence ${score}%.`,
      evaluations,
      scenarioFlags: flags,
      favorabilityScore: score,
      favorabilityGrade: gradeValue,
      favorabilityReasons: reasonList(score, sweep.level, htfBias, fvg, orderBlock, plan.rr, confirmationCount, qualityCount)
    };
  }

  return {
    scenario: direction === "LONG" ? `${selectedVariant?.code ?? "LIQUIDITY_SWEEP"}_BUY` : `${selectedVariant?.code ?? "LIQUIDITY_SWEEP"}_SELL`,
    direction,
    status: direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY",
    state: "SIGNAL_ACTIVE",
    entryPrice: plan.entry,
    stopPrice: plan.stop,
    targetPrice: plan.target,
    finalReason: `Trade Grade ${gradeValue}: ${direction === "LONG" ? "BUY" : "SELL"} ${selectedVariant?.name ?? "Liquidity Sweep profile"} passed closed-candle mandatory rules, ${confirmationCount}/${confirmations.length} confirmations, and ${qualityCount}/6 quality filters. Confidence ${score}%.`,
    evaluations,
    scenarioFlags: flags,
    favorabilityScore: score,
    favorabilityGrade: gradeValue,
    favorabilityReasons: reasonList(score, sweep.level, htfBias, fvg, orderBlock, plan.rr, confirmationCount, qualityCount)
  };
}

function module2MandatoryEntryPassed(evaluations: RuleEvaluation[]) {
  const required = new Set([
    "DATA_HEALTHY",
    "NY_SESSION_ACTIVE",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "DIRECTIONAL_CONFLICT_CLEAR",
    "TRADE_GEOMETRY_VALID",
    "RISK_OK",
    "VARIANT_SELECTED"
  ]);
  return [...required].every((ruleCode) =>
    evaluations.some((evaluation) => evaluation.ruleCode === ruleCode && evaluation.status === "PASS")
  );
}

function module2RuleLayer(ruleCode: string): Pick<RuleEvaluation, "ruleLayer" | "requiredForEntry"> {
  const mandatory = new Set([
    "DATA_HEALTHY",
    "NY_SESSION_ACTIVE",
    "RISK_LIMITS_CLEAR",
    "MANUAL_CONFIRMATION_COMPLETED",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "DIRECTIONAL_CONFLICT_CLEAR",
    "TRADE_GEOMETRY_VALID",
    "RISK_OK",
    "VARIANT_SELECTED"
  ]);
  const confirmations = new Set(["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRM_ENGULFING", "CONFIRM_PIN_BAR", "CONFIRM_INSIDE_BAR_BREAK", "CONFIRM_DOJI_REJECTION", "CONFIRM_VOLUME_EXPANSION", "CONFIRMATION_COUNT"]);
  const quality = new Set(["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT", "EMA_FILTER_MODE", "VOLUME_FILTER_MODE", "DISPLACEMENT_FILTER_MODE", "DOUBLE_SWEEP_FILTER"]);
  const paperTracking = new Set(["DAILY_TRADE_LIMIT", "ACTIVE_SETUP_CONFLICT_CLEAR", "NO_ACTIVE_TRADE_CONFLICT"]);
  if (ruleCode === "SIGNAL_SCORE") return { ruleLayer: "FINAL", requiredForEntry: false };
  if (mandatory.has(ruleCode)) return { ruleLayer: "MANDATORY", requiredForEntry: true };
  if (paperTracking.has(ruleCode)) return { ruleLayer: "PAPER_TRACKING", requiredForEntry: false };
  if (["PROTECTED_POINT_CONFIDENCE", "BOS_CHOCH_CONFIRMED", "MSS_STRENGTH", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE"].includes(ruleCode)) return { ruleLayer: "EVIDENCE", requiredForEntry: false };
  if (confirmations.has(ruleCode)) return { ruleLayer: "CONFIRMATION", requiredForEntry: false };
  if (quality.has(ruleCode)) return { ruleLayer: "QUALITY", requiredForEntry: ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE"].includes(ruleCode) };
  if (ruleCode === "VARIANT_SELECTED") return { ruleLayer: "FINAL", requiredForEntry: true };
  return { ruleLayer: "EVIDENCE", requiredForEntry: false };
}

function normalizeCandles(candles: Candle[]) {
  return candles
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
}

function inferDataHealth(context: LiquiditySweepContext, setupCandles: Candle[], biasCandles: Candle[], precisionCandles: Candle[]) {
  const explicit = context.dataHealthStatus;
  if (explicit) return { status: explicit, reason: `External feed health reported ${explicit}.` };
  if (context.rateLimited) return { status: "RATE_LIMITED" as DataHealthState, reason: "Twelve Data/feed guardrail reports rate limiting." };
  if (setupCandles.length < 20) return { status: "DISCONNECTED" as DataHealthState, reason: "Not enough closed 5M candles are available." };
  if (biasCandles.length > 0 && biasCandles.length < 5) return { status: "INCONSISTENT" as DataHealthState, reason: "15M context candles are incomplete." };
  const duplicated = new Set(setupCandles.map((candle) => candle.timestampUtc)).size !== setupCandles.length;
  if (duplicated) return { status: "INCONSISTENT" as DataHealthState, reason: "Duplicate 5M candle timestamps detected." };
  const ordered = setupCandles.every((candle, index) => index === 0 || new Date(candle.timestampUtc).getTime() > new Date(setupCandles[index - 1].timestampUtc).getTime());
  if (!ordered) return { status: "INCONSISTENT" as DataHealthState, reason: "5M candles are not strictly ascending." };
  const nowMs = new Date(context.now).getTime();
  const latestMs = new Date(setupCandles.at(-1)?.timestampUtc ?? context.now).getTime();
  const ageSeconds = Number.isFinite(nowMs) && Number.isFinite(latestMs) ? Math.max(0, Math.round((nowMs - latestMs) / 1000)) : 0;
  if (precisionCandles.length > 0 && precisionCandles.length < 3) return { status: "DELAYED" as DataHealthState, reason: "1M precision context is present but shallow; 5M engine remains authoritative." };
  return { status: "HEALTHY" as DataHealthState, reason: `Closed 5M candle stream is usable. Latest setup candle age ${ageSeconds}s relative to evaluation clock.`, ageSeconds };
}

function buildMarketContext(
  setupCandles: Candle[],
  biasCandles: Candle[],
  levels: LiquidityLevel[],
  current: Candle,
  atr: number,
  htfBias: string,
  internalStructure: StructureSummary,
  externalStructure: StructureSummary,
  context: LiquiditySweepContext
) {
  const currentDate = newYorkDateKey(current.timestampUtc);
  const dayCandles = setupCandles.filter((candle) => newYorkDateKey(candle.timestampUtc) === currentDate);
  const sessionCandles = dayCandles.filter((candle) => newYorkMinutes(candle.timestampUtc) >= parseTime(DEFAULT_CONFIG.newYorkStartTime));
  const dailyOpen = dayCandles[0]?.open ?? current.open;
  const ema20 = exponentialMovingAverage(setupCandles.map((candle) => candle.close), Math.min(20, setupCandles.length));
  const ema50 = exponentialMovingAverage(setupCandles.map((candle) => candle.close), Math.min(50, setupCandles.length));
  const ema200 = exponentialMovingAverage((biasCandles.length > 0 ? biasCandles : setupCandles).map((candle) => candle.close), Math.min(200, Math.max(20, biasCandles.length || setupCandles.length)));
  const previousDayRows = previousTradingDayCandles(setupCandles, current.timestampUtc);
  const previousHigh = previousDayRows.length ? Math.max(...previousDayRows.map((candle) => candle.high)) : null;
  const previousLow = previousDayRows.length ? Math.min(...previousDayRows.map((candle) => candle.low)) : null;
  const previousRangePosition = previousHigh != null && previousLow != null && previousHigh > previousLow ? (current.close - previousLow) / (previousHigh - previousLow) : null;
  const sessionHigh = sessionCandles.length ? Math.max(...sessionCandles.map((candle) => candle.high)) : current.high;
  const sessionLow = sessionCandles.length ? Math.min(...sessionCandles.map((candle) => candle.low)) : current.low;
  const sessionRangePosition = sessionHigh > sessionLow ? (current.close - sessionLow) / (sessionHigh - sessionLow) : 0.5;
  const opposing = nearestOpposingLevel(levels, current.close, current.close >= dailyOpen ? "LONG" : "SHORT");
  return {
    ready: Number.isFinite(ema20) && Number.isFinite(ema50) && Number.isFinite(ema200),
    summary: `${htfBias} / ${internalStructure.state} 5M / ${externalStructure.state} 15M`,
    htfBias,
    localTrend: internalStructure.state,
    externalTrend: externalStructure.state,
    dailyOpen,
    priceRelativeToDailyOpen: current.close >= dailyOpen ? "ABOVE" : "BELOW",
    ema20,
    ema50,
    ema200,
    priceRelativeToEma200: current.close >= ema200 ? "ABOVE" : "BELOW",
    previousDayRangePosition: previousRangePosition,
    sessionRangePosition,
    opposingLiquidityDistanceAtr: opposing && atr > 0 ? Math.abs(opposing.price - current.close) / atr : null,
    spreadState: context.spread == null ? "UNKNOWN" : context.spread <= DEFAULT_CONFIG.maximumSpread ? "OK" : "WIDE",
    newsState: context.newsStatus ?? "CLEAR"
  };
}

function buildStructureGraph(
  internalSwings: SwingPoint[],
  externalSwings: SwingPoint[],
  internalStructure: StructureSummary,
  externalStructure: StructureSummary,
  atr: number,
  config: LiquiditySweepConfig
) {
  const internalDirection = structureDirection(internalStructure.state);
  const externalDirection = structureDirection(externalStructure.state);
  const alignmentState: StructureAlignmentState = !internalDirection || !externalDirection
    ? "UNKNOWN"
    : internalDirection === "NEUTRAL" || externalDirection === "NEUTRAL"
      ? "NEUTRAL"
      : internalDirection === externalDirection ? "ALIGNED" : "COUNTERTREND";
  const points = internalSwings.slice(-20).map((point, index, rows) => {
    const previousSame = [...rows.slice(0, index)].reverse().find((item) => item.type === point.type);
    const previousOpposite = [...rows.slice(0, index)].reverse().find((item) => item.type !== point.type);
    const parent = nearestExternalParent(point, externalSwings, atr);
    return {
      ...point,
      hierarchy: "INTERNAL" as const,
      lowerBound: point.price - Math.max(0.01, atr * config.structureToleranceATR),
      upperBound: point.price + Math.max(0.01, atr * config.structureToleranceATR),
      confidence: point.confidence ?? point.strengthScore,
      state: point.state ?? "CONFIRMED",
      parentId: parent?.id,
      previousSameTypeId: previousSame?.id,
      previousOppositeTypeId: previousOpposite?.id
    };
  });
  const breakEvents = points
    .filter((point) => ["HH", "LL", "LH", "HL"].includes(point.classification ?? ""))
    .slice(-6)
    .map((point) => ({
      id: `structure-break-${point.id}`,
      direction: point.classification === "HH" || point.classification === "HL" ? "BULLISH" : "BEARISH",
      type: point.classification === "HH" || point.classification === "LL" ? "CONTINUATION_BOS" : "REVERSAL_MSS",
      structurePointId: point.id,
      breakCandleId: point.id,
      wickBreak: false,
      closeConfirmed: true,
      breakDistanceAtr: Number(point.prominenceAtr.toFixed(4)),
      bodyRatio: null,
      displacementPassed: point.prominenceAtr >= config.minimumDisplacementRangeATR,
      occurredAt: point.confirmedAt
    }));
  return {
    internalDirection,
    externalDirection,
    alignmentState,
    conflictMode: config.countertrendResolutionMode,
    conflictReason: alignmentState === "COUNTERTREND"
      ? `5M ${internalStructure.state} structure is counter to 15M ${externalStructure.state}; confidence is reduced unless policy blocks.`
      : `5M ${internalStructure.state} and 15M ${externalStructure.state} structure are ${alignmentState.toLowerCase()}.`,
    points,
    breakEvents
  };
}

function buildSessionContext(setupCandles: Candle[], current: Candle, atr: number, config: LiquiditySweepConfig) {
  const currentDate = newYorkDateKey(current.timestampUtc);
  const sessions = [
    { name: "ASIAN", start: config.asianStartTime, end: config.asianEndTime },
    { name: "LONDON", start: config.londonStartTime, end: config.londonEndTime },
    { name: "NEW_YORK_PREMARKET", start: config.nyPremarketStartTime, end: config.newYorkStartTime },
    { name: "NEW_YORK_CASH_OPEN", start: config.newYorkStartTime, end: "12:00" },
    { name: "NEW_YORK_LATE", start: "12:00", end: config.newYorkEndTime }
  ];
  const minute = newYorkMinutes(current.timestampUtc);
  const rows = sessions.map((session) => {
    const start = parseTime(session.start);
    const end = parseTime(session.end);
    const candles = setupCandles.filter((candle) => {
      const candleDate = newYorkDateKey(candle.timestampUtc);
      const candleMinute = newYorkMinutes(candle.timestampUtc);
      if (start <= end) return candleDate === currentDate && candleMinute >= start && candleMinute < end;
      return (candleDate < currentDate && candleMinute >= start) || (candleDate === currentDate && candleMinute < end);
    });
    const high = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
    const low = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
    const state = minute >= start && minute < end ? "ACTIVE" : minute >= end || start > end ? "COMPLETED" : "UPCOMING";
    return {
      id: `${currentDate}-${session.name}`,
      name: session.name,
      symbol: "XAUUSD",
      tradingDate: currentDate,
      timezone: config.timezone,
      startAt: session.start,
      endAt: session.end,
      state,
      high,
      low,
      midpoint: high != null && low != null ? (high + low) / 2 : null,
      range: high != null && low != null ? high - low : null,
      atrProfile: atr,
      candleCount: candles.length
    };
  });
  return {
    current: rows.find((session) => session.state === "ACTIVE") ?? rows.find((session) => session.name === "NEW_YORK_LATE" && minute > parseTime(config.newYorkEndTime)) ?? null,
    completed: rows.filter((session) => session.state === "COMPLETED"),
    upcoming: rows.filter((session) => session.state === "UPCOMING"),
    rules: {
      entryWindow: `${config.newYorkStartTime}-${config.newYorkEndTime}`,
      allowedPriorLevels: ["ASIAN", "LONDON", "PREVIOUS_DAY", "NEW_YORK_PREMARKET"],
      blockLateSessionEntries: true
    }
  };
}

function platformEngineContract(current: Candle, config: LiquiditySweepConfig) {
  const candleCloseKey = `XAUUSD:5M:${current.timestampUtc}`;
  return {
    architectureVersion: "LIQUIDITY_SWEEP_PLATFORM_CORE_V1.0",
    eventMode: "CLOSED_CANDLE_DETERMINISTIC",
    eventOrder: [
      "VALIDATE_CANDLE",
      "PERSIST_CANDLE",
      "UPDATE_ATR_INDICATORS",
      "UPDATE_SESSION",
      "CONFIRM_SWINGS",
      "UPDATE_STRUCTURE",
      "UPDATE_LIQUIDITY",
      "UPDATE_ACTIVE_SETUP",
      "EVALUATE_SWEEP",
      "EVALUATE_CONFIRMATIONS",
      "EVALUATE_RISK",
      "PRODUCE_DECISION",
      "EMIT_NOTIFICATIONS",
      "PERSIST_AUDIT_TRACE"
    ],
    idempotencyKey: candleCloseKey,
    transactionBoundary: "CANDLE_CLOSE_ATOMIC",
    strategyPlugin: {
      id: "liquidity-sweep-mss-retest",
      name: "Liquidity Sweep MSS Retest Plugin",
      version: MODULE2_VARIANT_VERSION,
      sharedEngines: ["session", "swing", "structure", "liquidity", "risk", "notifications", "journal", "backtesting"]
    },
    ruleDsl: {
      operator: "AND",
      children: [
        "DATA_HEALTHY",
        "SESSION_ACTIVE",
        "SWEEP_CONFIRMED",
        "CLOSE_BACK_INSIDE",
        "MSS_CONFIRMED",
        "RETEST_CONFIRMED",
        "RISK_PERMITTED"
      ]
    },
    parameterVersioning: {
      activeVersion: MODULE2_VARIANT_VERSION,
      neverEditActiveVersion: true,
      groups: ["Swing", "Liquidity", "Sweep", "Structure", "MSS", "Retest", "Risk", "Session", "News", "Spread", "Confidence", "Position Management"]
    },
    positionManagement: {
      mode: config.positionManagementMode,
      automaticBreakEven: false,
      automaticPartials: false,
      automaticTrailing: false,
      futureModels: ["BREAK_EVEN_AT_R", "PARTIAL_AT_R", "TRAIL_BY_SWING", "TRAIL_BY_ATR", "TIME_EXIT", "OPPOSING_LIQUIDITY_EXIT"]
    },
    replay: {
      deterministic: true,
      noFutureData: true,
      pivotConfirmationUsesRightBars: true,
      strategyVersionFrozen: true,
      fillModel: "LOWER_TIMEFRAME_OR_CONSERVATIVE"
    },
    journalIntelligence: {
      storeSetupStates: ["TAKEN", "SKIPPED", "MISSED", "BLOCKED", "INVALIDATED", "EXPIRED", "NO_TRADE"],
      processGrades: ["A", "B", "C", "D"],
      minimumTradesForInsight: config.minimumTradesForInsight
    },
    notificationOrchestration: {
      priorities: ["INFO", "NOTICE", "ACTION_REQUIRED", "WARNING", "CRITICAL"],
      dedupeKeyTemplate: "eventType + setupId + candleCloseTime",
      readySignalRequiresAcknowledgement: true
    },
    recovery: {
      restartSteps: ["LOAD_CANDLES", "LOAD_SESSION", "LOAD_STRATEGY_VERSION", "LOAD_ACTIVE_SETUP", "REPLAY_FROM_CHECKPOINT", "COMPARE_STATE", "RESUME_IF_CONSISTENT"],
      blockOnStateMismatch: true,
      checkpoints: ["RANGE_LOCK", "SWEEP_CONFIRMED", "MSS_CONFIRMED", "RETEST_CONFIRMED", "TRADE_READY", "TRADE_OPENED", "TRADE_CLOSED"]
    }
  };
}

function structureDirection(state: StructureState) {
  if (state === "BULLISH") return "BULLISH";
  if (state === "BEARISH") return "BEARISH";
  if (state === "RANGING" || state === "TRANSITIONAL") return "NEUTRAL";
  return null;
}

function nearestExternalParent(point: SwingPoint, externalSwings: SwingPoint[], atr: number) {
  const tolerance = Math.max(0.05, atr * 2);
  return externalSwings
    .filter((external) => external.type === point.type && Math.abs(external.price - point.price) <= tolerance)
    .sort((left, right) => Math.abs(left.price - point.price) - Math.abs(right.price - point.price))[0] ?? null;
}

function directionalEfficiency(candles: Candle[]) {
  if (candles.length < 2) return 0;
  const netMove = Math.abs((candles.at(-1)?.close ?? 0) - candles[0].close);
  const path = candles.slice(1).reduce((sum, candle, index) => sum + Math.abs(candle.close - candles[index].close), 0);
  return path > 0 ? netMove / path : 0;
}

function detectMarketRegime(setupCandles: Candle[], biasCandles: Candle[], internalStructure: StructureSummary, externalStructure: StructureSummary, atr: number, rollingAtrMedian: number, newsStatus?: string) {
  const rows = biasCandles.length > 0 ? biasCandles : setupCandles;
  const closes = rows.map((candle) => candle.close);
  const ema20 = exponentialMovingAverage(closes, Math.min(20, closes.length));
  const ema50 = exponentialMovingAverage(closes, Math.min(50, closes.length));
  const ema200 = exponentialMovingAverage(closes, Math.min(200, Math.max(20, closes.length)));
  const latest = closes.at(-1) ?? 0;
  const efficiency = directionalEfficiency(rows.slice(-24));
  const atrRatio = rollingAtrMedian > 0 ? atr / rollingAtrMedian : 1;
  const secondary: MarketRegime[] = [];
  const explanation: string[] = [];
  if (String(newsStatus ?? "CLEAR").includes("BLOCKED")) secondary.push("NEWS_DRIVEN");
  if (atrRatio <= 0.7) secondary.push("COMPRESSED", "LOW_VOLATILITY");
  if (atrRatio >= 1.3) secondary.push("EXPANDING");
  if (atrRatio >= 1.5) secondary.push("HIGH_VOLATILITY");
  let primary: MarketRegime = "UNKNOWN";
  if (secondary.includes("NEWS_DRIVEN")) {
    primary = "NEWS_DRIVEN";
    explanation.push("News context is blocking or dominating the current setup.");
  } else if (externalStructure.state === "BULLISH" && ema20 > ema50 && latest > ema200 && efficiency >= 0.45) {
    primary = "TRENDING_UP";
    explanation.push("15M structure, EMA stack, price location, and directional efficiency support an upward regime.");
  } else if (externalStructure.state === "BEARISH" && ema20 < ema50 && latest < ema200 && efficiency >= 0.45) {
    primary = "TRENDING_DOWN";
    explanation.push("15M structure, EMA stack, price location, and directional efficiency support a downward regime.");
  } else if (efficiency <= 0.3 || internalStructure.state === "RANGING" || externalStructure.state === "RANGING") {
    primary = "RANGING";
    explanation.push("Directional efficiency or equal/overlapping structure points to range/chop.");
  } else if (atrRatio <= 0.7) {
    primary = "COMPRESSED";
    explanation.push("Current ATR is compressed versus the rolling median.");
  } else if (atrRatio >= 1.3) {
    primary = "EXPANDING";
    explanation.push("Current ATR is expanding versus the rolling median.");
  } else if (internalStructure.state === "TRANSITIONAL" || externalStructure.state === "TRANSITIONAL") {
    primary = "TRANSITIONAL";
    explanation.push("Internal/external structure is changing but not cleanly trending.");
  } else {
    explanation.push("Not enough aligned structure to classify a clean regime.");
  }
  const confidence = primary === "UNKNOWN" ? 20 : Math.min(95, Math.round(40 + Math.abs(efficiency - 0.5) * 60 + Math.abs(atrRatio - 1) * 20));
  return {
    primary,
    secondary: [...new Set(secondary.filter((item) => item !== primary))],
    confidence,
    actualValues: {
      directionalEfficiency: Number(efficiency.toFixed(4)),
      atrRatio: Number(atrRatio.toFixed(4)),
      ema20: Number(ema20.toFixed(4)),
      ema50: Number(ema50.toFixed(4)),
      ema200: Number(ema200.toFixed(4)),
      latest: Number(latest.toFixed(4))
    },
    explanation
  };
}

function detectLiquidityLevels(candles: Candle[], now: string, atr: number, config: LiquiditySweepConfig): LiquidityLevel[] {
  const currentDate = newYorkDateKey(now);
  const priorDates = [...new Set(candles.map((candle) => newYorkDateKey(candle.timestampUtc)).filter((date) => date < currentDate))].sort();
  const previousCalendarDate = priorDates.at(-1);
  const previousWeekDates = priorDates.slice(-7);
  const previousTradingDate = [...priorDates].reverse().find((date) => !isWeekendDateKey(date));
  const previousWeek = previousWeekDates.length > 0 ? candles.filter((candle) => previousWeekDates.includes(newYorkDateKey(candle.timestampUtc))) : [];
  const previousDay = previousTradingDate ? candles.filter((candle) => newYorkDateKey(candle.timestampUtc) === previousTradingDate) : [];
  const preSession = candles.filter((candle) => {
    const date = newYorkDateKey(candle.timestampUtc);
    const minute = newYorkMinutes(candle.timestampUtc);
    return date < currentDate || (date === currentDate && minute < parseTime(config.newYorkStartTime));
  });
  const openingRange = candles.filter((candle) => {
    const date = newYorkDateKey(candle.timestampUtc);
    const minute = newYorkMinutes(candle.timestampUtc);
    return date === currentDate && minute >= parseTime(config.orbStartTime) && minute < parseTime(config.orbEndTime);
  });
  const asian = preSession.filter((candle) => {
    const date = newYorkDateKey(candle.timestampUtc);
    const minute = newYorkMinutes(candle.timestampUtc);
    return (date === previousCalendarDate && minute >= parseTime(config.asianStartTime))
      || (date === currentDate && minute < parseTime(config.asianEndTime));
  });
  const london = preSession.filter((candle) => {
    const date = newYorkDateKey(candle.timestampUtc);
    const minute = newYorkMinutes(candle.timestampUtc);
    return date === currentDate && minute >= parseTime(config.londonStartTime) && minute < parseTime(config.londonEndTime);
  });
  const levels: LiquidityLevel[] = [];
  addRangeLevels(levels, previousWeek, "PREVIOUS_WEEK_HIGH", "PREVIOUS_WEEK_LOW", "HIGH");
  addRangeLevels(levels, previousDay, "PREVIOUS_DAY_HIGH", "PREVIOUS_DAY_LOW", "HIGH");
  addRangeLevels(levels, asian, "ASIAN_HIGH", "ASIAN_LOW", "MEDIUM");
  addRangeLevels(levels, london, "LONDON_HIGH", "LONDON_LOW", "HIGH");
  addRangeLevels(levels, openingRange, "ORB_HIGH", "ORB_LOW", "HIGH");
  const pivots = detectPivots(preSession, 2, 2).slice(-18);
  addExternalSwingLevels(levels, pivots);
  addEqualHighLowLevels(levels, pivots, atr);
  const internalPivots = detectPivots(candles.slice(-96), 2, 2).slice(-12);
  addInternalSwingLevels(levels, internalPivots);
  addManualLevels(levels, config);
  addRoundNumberLevels(levels, candles, config);
  return rankLiquidityLevels(dedupeLevels(levels.map((level) => liquidityZone(level, atr, config, now))), candles, now, atr, config);
}

function addRangeLevels(levels: LiquidityLevel[], candles: Candle[], highType: LiquidityLevelType, lowType: LiquidityLevelType, priority: LiquidityLevel["priority"]) {
  if (candles.length === 0) return;
  const formedAt = candles[0].timestampUtc;
  const confirmedAt = candles.at(-1)?.timestampUtc ?? formedAt;
  levels.push({ type: highType, side: "BUY_SIDE", price: Math.max(...candles.map((candle) => candle.high)), timeframe: "SESSION", formedAt, confirmedAt, priority, priorityScore: levelPriorityScore(highType, priority), source: highType, sourceIds: [highType], touchCount: 0, clusterSize: 1, status: "ACTIVE", state: "ACTIVE" });
  levels.push({ type: lowType, side: "SELL_SIDE", price: Math.min(...candles.map((candle) => candle.low)), timeframe: "SESSION", formedAt, confirmedAt, priority, priorityScore: levelPriorityScore(lowType, priority), source: lowType, sourceIds: [lowType], touchCount: 0, clusterSize: 1, status: "ACTIVE", state: "ACTIVE" });
}

function liquidityZone(level: LiquidityLevel, atr: number, config: LiquiditySweepConfig, now: string): LiquidityLevel {
  const zoneHalfWidth = Math.max(0.01, atr * config.zoneToleranceATR);
  return {
    ...level,
    id: level.id ?? `${level.type}:${level.side}:${level.price.toFixed(2)}:${newYorkDateKey(level.confirmedAt ?? level.formedAt ?? now)}`,
    symbol: level.symbol ?? "XAUUSD",
    timeframe: level.timeframe ?? (["SWING_HIGH", "SWING_LOW", "EQUAL_HIGH", "EQUAL_LOW"].includes(level.type) ? "5min" : "SESSION"),
    lowerBound: level.price - zoneHalfWidth,
    upperBound: level.price + zoneHalfWidth,
    formedAt: level.formedAt ?? now,
    confirmedAt: level.confirmedAt ?? level.formedAt ?? now,
    expiresAt: level.expiresAt ?? liquidityExpiry(level, now, config),
    sourceIds: level.sourceIds ?? [level.source],
    zoneHalfWidth,
    priorityScore: level.priorityScore ?? levelPriorityScore(level.type, level.priority),
    freshnessScore: level.freshnessScore ?? 100,
    reactionScore: level.reactionScore ?? 0,
    overlapScore: level.overlapScore ?? 0,
    qualityScore: level.qualityScore ?? level.priorityScore ?? levelPriorityScore(level.type, level.priority),
    sweepCount: level.sweepCount ?? 0,
    closeCountBeyond: level.closeCountBeyond ?? 0,
    state: level.state ?? "ACTIVE",
    status: level.status ?? "ACTIVE"
  };
}

function levelPriorityScore(type: LiquidityLevelType, priority: LiquidityLevel["priority"]) {
  const typeScores: Record<LiquidityLevelType, number> = {
    PREVIOUS_WEEK_HIGH: 100,
    PREVIOUS_WEEK_LOW: 100,
    PREVIOUS_DAY_HIGH: 95,
    PREVIOUS_DAY_LOW: 95,
    LONDON_HIGH: 90,
    LONDON_LOW: 90,
    ASIAN_HIGH: 85,
    ASIAN_LOW: 85,
    ORB_HIGH: 80,
    ORB_LOW: 80,
    EQUAL_HIGH: 70,
    EQUAL_LOW: 70,
    SWING_HIGH: 75,
    SWING_LOW: 75,
    COMPOSITE: 105,
    MANUAL_LEVEL: priorityScore(priority) * 20,
    ROUND_NUMBER: 35
  };
  return typeScores[type] ?? priorityScore(priority) * 10;
}

function liquidityExpiry(level: LiquidityLevel, now: string, config: LiquiditySweepConfig) {
  const dateKey = newYorkDateKey(level.confirmedAt ?? level.formedAt ?? now);
  if (["ASIAN_HIGH", "ASIAN_LOW", "LONDON_HIGH", "LONDON_LOW", "PREVIOUS_DAY_HIGH", "PREVIOUS_DAY_LOW", "PREVIOUS_WEEK_HIGH", "PREVIOUS_WEEK_LOW"].includes(level.type)) {
    return new Date(`${dateKey}T23:59:59.000Z`).toISOString();
  }
  if (["ORB_HIGH", "ORB_LOW"].includes(level.type)) {
    return new Date(`${dateKey}T${config.newYorkEndTime}:00.000Z`).toISOString();
  }
  if (["SWING_HIGH", "SWING_LOW", "EQUAL_HIGH", "EQUAL_LOW"].includes(level.type)) {
    const formed = new Date(level.confirmedAt ?? level.formedAt ?? now).getTime();
    return new Date(formed + config.maximumSwingLevelAgeDays * 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString();
}

function detectBestLiquiditySequence(candles: Candle[], sweeps: SweepCandidate[], pivots: ReturnType<typeof detectPivots>, swings: SwingPoint[], atr: number, config: LiquiditySweepConfig) {
  const currentIndex = candles.length - 1;
  const sequences = sweeps.map((sweep) => {
    const direction: Direction = sweep.level.side === "SELL_SIDE" ? "LONG" : "SHORT";
    const displacement = detectDisplacement(candles, sweep.index, direction, atr, config);
    const bos = detectBos(candles, sweep.index, displacement?.index ?? sweep.index, direction, pivots, swings, atr, config);
    const fvg = displacement ? detectFreshFvg(candles, sweep.index, displacement.index, direction, atr, config) : null;
    const orderBlock = displacement ? detectOrderBlock(candles, displacement.index, direction, atr) : null;
    const zone = bos ? mssRetestZone(bos, atr) : null;
    const retrace = zone ? candles[currentIndex].low <= zone.high && candles[currentIndex].high >= zone.low : false;
    const confirmation = zone ? confirmsEntry(candles[currentIndex], direction, zone) : false;
    const agePenalty = Math.max(0, currentIndex - (bos?.index ?? displacement?.index ?? sweep.index)) * 0.01;
    const levelQuality = (sweep.level.priorityScore ?? levelPriorityScore(sweep.level.type, sweep.level.priority)) / 20;
    const rejectionQuality = sweep.sweepType === "WICK_SWEEP" ? 2 : sweep.sweepType === "DELAYED_REJECTION_SWEEP" ? 1 : 0.5;
    const score =
      1 +
      levelQuality +
      rejectionQuality +
      (displacement ? 4 : 0) +
      (bos ? 8 : 0) +
      (zone ? 16 : 0) +
      (retrace ? 32 : 0) +
      (confirmation ? 64 : 0) -
      agePenalty;
    return { sweep, direction, displacement, bos, fvg, orderBlock, zone, retrace, confirmation, score };
  });
  return sequences.sort((left, right) => right.score - left.score || right.sweep.index - left.sweep.index)[0] ?? null;
}

function mssRetestZone(bos: NonNullable<ReturnType<typeof detectBos>>, atr: number) {
  const zoneHalfWidth = Math.max(0.01, atr * 0.05);
  return {
    kind: "MSS_RETEST",
    low: bos.level - zoneHalfWidth,
    high: bos.level + zoneHalfWidth,
    midpoint: bos.level,
    createdAt: bos.candle.timestampUtc,
    index: bos.index
  };
}

function analyzeSweepCandidates(candles: Candle[], levels: LiquidityLevel[], atr: number, config: LiquiditySweepConfig) {
  const candidates: SweepCandidate[] = [];
  const invalidations: SweepInvalidation[] = [];
  for (let index = candles.length - 1; index >= Math.max(0, candles.length - config.maximumSweepLookbackBars - config.closeBackMaximumBars); index -= 1) {
    const candle = candles[index];
    if (!isInsideNewYorkWindow(candle.timestampUtc, config.newYorkStartTime, config.newYorkEndTime)) continue;
    for (const level of levels) {
      const levelAvailableAt = new Date(level.confirmedAt ?? level.formedAt ?? candle.timestampUtc).getTime();
      if (Number.isFinite(levelAvailableAt) && new Date(candle.timestampUtc).getTime() < levelAvailableAt) continue;
      const lowerBound = level.lowerBound ?? level.price;
      const upperBound = level.upperBound ?? level.price;
      const penetration = level.side === "SELL_SIDE" ? lowerBound - candle.low : candle.high - upperBound;
      const distanceAtr = atr > 0 ? penetration / atr : 0;
      if (penetration <= 0) continue;
      if (distanceAtr < config.minimumSweepDistanceATR) {
        invalidations.push(sweepInvalidation(index, level, candle, "SWEEP_TOO_SMALL", distanceAtr, `Sweep penetration was ${distanceAtr.toFixed(2)} ATR, below the minimum ${config.minimumSweepDistanceATR}.`));
        continue;
      }
      if (distanceAtr > config.maximumSweepDistanceATR) {
        invalidations.push(sweepInvalidation(index, level, candle, "SWEEP_TOO_DEEP", distanceAtr, `Sweep penetration was ${distanceAtr.toFixed(2)} ATR, above the maximum ${config.maximumSweepDistanceATR}.`));
        invalidations.push(sweepInvalidation(index, level, candle, "POSSIBLE_BREAKOUT", distanceAtr, "Move extended too far beyond liquidity and is treated as possible acceptance/breakout, not a clean sweep."));
        continue;
      }
      const closeBackEnd = Math.min(candles.length - 1, index + config.closeBackMaximumBars);
      let closed = false;
      for (let closeIndex = index; closeIndex <= closeBackEnd; closeIndex += 1) {
        const closeBackCandle = candles[closeIndex];
        const closedBack = level.side === "SELL_SIDE" ? closeBackCandle.close > level.price : closeBackCandle.close < level.price;
        if (closedBack) {
          const range = candle.high - candle.low;
          const rejectionWick = level.side === "SELL_SIDE" ? Math.min(candle.open, candle.close) - candle.low : candle.high - Math.max(candle.open, candle.close);
          const wickRatio = range > 0 ? Math.max(0, rejectionWick) / range : 0;
          const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
          const oppositeBody = level.side === "SELL_SIDE" ? closeBackCandle.close > closeBackCandle.open : closeBackCandle.close < closeBackCandle.open;
          if (wickRatio < config.minimumSweepRejectionWickRatio && !(oppositeBody && bodyRatio >= 0.55)) {
            invalidations.push(sweepInvalidation(index, level, candle, "NO_REJECTION", distanceAtr, `Price closed back inside ${level.type}, but rejection quality failed: wick ${Math.round(wickRatio * 100)}%, body ${Math.round(bodyRatio * 100)}%.`));
            continue;
          }
          const resolutionBars = closeIndex - index;
          const sweepType = classifySweepType(candle, closeIndex, index, distanceAtr, wickRatio, level, config);
          const rejectionType = resolutionBars === 0 && wickRatio >= config.minimumSweepRejectionWickRatio
            ? "WICK_REJECTION"
            : resolutionBars > 0 ? "DELAYED_CLOSE_BACK" : "CLOSE_BACK_INSIDE";
          candidates.push({ index: closeIndex, sweepIndex: index, level, candle, closeBackCandle, distanceAtr, penetration, sweepType, rejectionType, wickRatio, resolutionBars, sweptAt: candle.timestampUtc, closedBackAt: closeBackCandle.timestampUtc });
          closed = true;
          break;
        }
      }
      if (!closed) {
        const accepted = acceptedBeyondLevel(candles, index, closeBackEnd, level, atr, config);
        if (accepted) {
          invalidations.push(sweepInvalidation(index, level, candle, "ACCEPTED_BEYOND_LEVEL", distanceAtr, accepted));
          continue;
        }
        invalidations.push(sweepInvalidation(index, level, candle, "NO_REJECTION", distanceAtr, `Price swept ${level.type} but did not close back inside within ${config.closeBackMaximumBars} candle(s).`));
      }
    }
  }
  const recentWindowStart = Math.max(0, candles.length - 1 - config.doubleSweepLookbackBars);
  const recentSides = new Set(candidates.filter((candidate) => candidate.index >= recentWindowStart).map((candidate) => candidate.level.side));
  const doubleSweepWarning = recentSides.has("BUY_SIDE") && recentSides.has("SELL_SIDE");
  return { candidates, invalidations, doubleSweepWarning };
}

function sweepInvalidation(index: number, level: LiquidityLevel, candle: Candle, reason: SweepInvalidation["reason"], distanceAtr: number, detail: string): SweepInvalidation {
  return { index, level, candle, reason, distanceAtr, occurredAt: candle.timestampUtc, detail };
}

function sameLiquidityLevel(left: LiquidityLevel, right: LiquidityLevel) {
  return left.type === right.type && left.side === right.side && Math.abs(left.price - right.price) < 0.05;
}

function acceptedBeyondLevel(candles: Candle[], sweepIndex: number, endIndex: number, level: LiquidityLevel, atr: number, config: LiquiditySweepConfig) {
  let acceptedCloses = 0;
  for (let index = sweepIndex; index <= endIndex; index += 1) {
    const candle = candles[index];
    const distance = level.side === "SELL_SIDE" ? level.price - candle.close : candle.close - level.price;
    const closeBeyond = distance > 0;
    const closeDistanceAtr = atr > 0 ? distance / atr : 0;
    if (closeBeyond) acceptedCloses += 1;
    if (closeBeyond && closeDistanceAtr >= config.acceptanceCloseDistanceATR) {
      return `Candle closed ${closeDistanceAtr.toFixed(2)} ATR beyond ${level.type}, which signals acceptance instead of rejection.`;
    }
    if (acceptedCloses >= config.acceptanceCloseCount) {
      return `${acceptedCloses} consecutive closes accepted beyond ${level.type}; treat as breakout/continuation risk.`;
    }
  }
  return null;
}

function classifySweepType(candle: Candle, closeIndex: number, sweepIndex: number, distanceAtr: number, wickRatio: number, level: LiquidityLevel, config: LiquiditySweepConfig): SweepCandidate["sweepType"] {
  if (distanceAtr > config.maximumSweepDistanceATR * 0.75) return "DEEP_SWEEP";
  if (closeIndex > sweepIndex) return candleCloseBeyondLevel(candle, level) ? "CLOSE_THROUGH_THEN_RECLAIM" : "DELAYED_REJECTION_SWEEP";
  if (wickRatio >= config.minimumSweepRejectionWickRatio) return "WICK_SWEEP";
  return "DELAYED_REJECTION_SWEEP";
}

function candleCloseBeyondLevel(candle: Candle, level: LiquidityLevel) {
  return level.side === "SELL_SIDE" ? candle.close < level.price : candle.close > level.price;
}

function detectDisplacement(candles: Candle[], sweepIndex: number, direction: Direction, atr: number, config: LiquiditySweepConfig) {
  const end = Math.min(candles.length - 1, sweepIndex + config.maximumBarsAfterSweep);
  for (let index = sweepIndex; index <= end; index += 1) {
    const candle = candles[index];
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const bodyRatio = range > 0 ? body / range : 0;
    const rangeAtr = atr > 0 ? range / atr : 0;
    const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0.5;
    const directionOk = direction === "LONG" ? candle.close > candle.open && closeLocation >= 0.75 : candle.close < candle.open && closeLocation <= 0.25;
    if (directionOk && rangeAtr >= config.minimumDisplacementRangeATR && bodyRatio >= config.minimumBodyPercentage) {
      return { index, candle, rangeAtr, bodyRatio, closeLocation };
    }
  }
  return null;
}

function detectBos(candles: Candle[], sweepIndex: number, displacementIndex: number, direction: Direction, pivots: ReturnType<typeof detectPivots>, swings: SwingPoint[], atr: number, config: LiquiditySweepConfig) {
  const protectedPoint = findProtectedPoint(swings, sweepIndex, direction, config);
  const structure = protectedPoint ? { index: protectedPoint.candleIndex, kind: protectedPoint.type, price: protectedPoint.price, time: protectedPoint.formedAt } : null;
  if (!structure) return null;
  const end = Math.min(candles.length - 1, sweepIndex + config.maximumBarsAfterSweepForBos);
  for (let index = displacementIndex; index <= end; index += 1) {
    const candle = candles[index];
    const threshold = config.minimumBosCloseDistanceATR * atr;
    const broken = direction === "LONG" ? candle.close > structure.price + threshold : candle.close < structure.price - threshold;
    if (broken) {
      const range = candle.high - candle.low;
      const bodyRatio = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
      const breakDistanceAtr = atr > 0 ? Math.abs(candle.close - structure.price) / atr : 0;
      if (breakDistanceAtr < config.minimumBosCloseDistanceATR || bodyRatio < 0.5) continue;
      const subtype = "REVERSAL_MSS";
      return {
        index,
        level: structure.price,
        candle,
        structure,
        protectedPoint,
        subtype,
        breakDistanceAtr,
        bodyRatio
      };
    }
  }
  return null;
}

function findProtectedPoint(swings: SwingPoint[], sweepIndex: number, direction: Direction, config: LiquiditySweepConfig) {
  const desired = direction === "LONG" ? "HIGH" : "LOW";
  const candidates = swings
    .filter((swing) => swing.type === desired && swing.candleIndex < sweepIndex && swing.status === "ACTIVE")
    .sort((left, right) => right.candleIndex - left.candleIndex);
  for (const swing of candidates) {
    const confidence = protectedPointConfidence(swing);
    if (protectedConfidenceRank(confidence) >= protectedConfidenceRank(config.protectedPointMinimumConfidence)) {
      return { ...swing, confidence };
    }
  }
  return null;
}

function protectedPointConfidence(swing: SwingPoint): "LOW" | "MEDIUM" | "HIGH" {
  if (swing.prominenceAtr >= 0.75 || swing.strengthScore >= 80) return "HIGH";
  if (swing.prominenceAtr >= 0.2 || swing.strengthScore >= 50) return "MEDIUM";
  return "LOW";
}

function protectedConfidenceRank(value: "LOW" | "MEDIUM" | "HIGH") {
  if (value === "HIGH") return 3;
  if (value === "MEDIUM") return 2;
  return 1;
}

function detectFreshFvg(candles: Candle[], sweepIndex: number, displacementIndex: number, direction: Direction, atr: number, config: LiquiditySweepConfig) {
  const start = Math.max(sweepIndex, displacementIndex - 1);
  const end = Math.min(candles.length - 1, displacementIndex + 2);
  for (let index = start + 2; index <= end; index += 1) {
    const first = candles[index - 2];
    const third = candles[index];
    const bullish = first.high < third.low;
    const bearish = first.low > third.high;
    if (direction === "LONG" && bullish && (third.low - first.high) >= atr * config.minimumFvgSizeATR) {
      return { kind: "FVG", low: first.high, high: third.low, midpoint: first.high + ((third.low - first.high) * config.entryAtFvgPercentage) / 100, createdAt: third.timestampUtc, index };
    }
    if (direction === "SHORT" && bearish && (first.low - third.high) >= atr * config.minimumFvgSizeATR) {
      return { kind: "FVG", low: third.high, high: first.low, midpoint: third.high + ((first.low - third.high) * config.entryAtFvgPercentage) / 100, createdAt: third.timestampUtc, index };
    }
  }
  return null;
}

function detectOrderBlock(candles: Candle[], displacementIndex: number, direction: Direction, atr: number) {
  for (let index = displacementIndex - 1; index >= Math.max(0, displacementIndex - 6); index -= 1) {
    const candle = candles[index];
    const opposing = direction === "LONG" ? candle.close < candle.open : candle.close > candle.open;
    if (!opposing) continue;
    const size = candle.high - candle.low;
    if (atr > 0 && size > atr) continue;
    return { kind: "ORDER_BLOCK", low: candle.low, high: candle.high, midpoint: (candle.low + candle.high) / 2, createdAt: candle.timestampUtc, index };
  }
  return null;
}

function selectFreshEntryZone(
  candles: Candle[],
  currentIndex: number,
  direction: Direction,
  fvg: ReturnType<typeof detectFreshFvg>,
  orderBlock: ReturnType<typeof detectOrderBlock>
) {
  if (fvg && isZoneFresh(candles, fvg, currentIndex, direction)) return fvg;
  if (orderBlock && isZoneFresh(candles, orderBlock, currentIndex, direction)) return orderBlock;
  return null;
}

function isZoneFresh(candles: Candle[], zone: NonNullable<ReturnType<typeof detectFreshFvg> | ReturnType<typeof detectOrderBlock>>, currentIndex: number, direction: Direction) {
  const rows = candles.slice(zone.index + 1, currentIndex);
  if (rows.length === 0) return true;
  if (zone.kind === "FVG") {
    return direction === "LONG" ? !rows.some((candle) => candle.low <= zone.low) : !rows.some((candle) => candle.high >= zone.high);
  }
  return direction === "LONG" ? !rows.some((candle) => candle.close < zone.low) : !rows.some((candle) => candle.close > zone.high);
}

type TradePlanZone = {
  kind?: string;
  low: number;
  high: number;
  midpoint: number;
};

type TradePlanCandidate = {
  source: string;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  availableRewardRisk: number;
  geometryValid: boolean;
  stopValid: boolean;
  stopDistanceAtr: number;
  zoneTouched: boolean;
  riskApproved: boolean;
};

function buildLayeredTradePlan(
  levels: LiquidityLevel[],
  direction: Direction,
  sweep: SweepCandidate,
  zones: TradePlanZone[],
  current: Candle,
  atr: number,
  config: LiquiditySweepConfig
) {
  const entry = current.close;
  const buffer = atr * config.stopBufferATR;
  const candidates: TradePlanCandidate[] = [];

  for (const zone of zones) {
    const zoneTouched = current.low <= zone.high && current.high >= zone.low;
    if (!zoneTouched) continue;
    const invalidation = direction === "LONG"
      ? Math.min(zone.low, current.low) - buffer
      : Math.max(zone.high, current.high) + buffer;
    candidates.push(buildTradePlanCandidate(
      `TOUCHED_${String(zone.kind ?? "STRUCTURE_ZONE")}`,
      levels,
      direction,
      entry,
      invalidation,
      atr,
      config,
      true
    ));
  }

  const sweepStop = direction === "LONG"
    ? sweep.candle.low - buffer
    : sweep.candle.high + buffer;
  candidates.push(buildTradePlanCandidate(
    "SWEEP_INVALIDATION",
    levels,
    direction,
    entry,
    sweepStop,
    atr,
    config,
    true
  ));

  const ranked = candidates.sort((left, right) =>
    Number(right.riskApproved) - Number(left.riskApproved)
      || Number(right.geometryValid) - Number(left.geometryValid)
      || Number(right.stopValid) - Number(left.stopValid)
      || right.availableRewardRisk - left.availableRewardRisk
      || left.stopDistanceAtr - right.stopDistanceAtr
  );
  const selected = ranked[0];
  return { ...selected, candidates: ranked };
}

function buildTradePlanCandidate(
  source: string,
  levels: LiquidityLevel[],
  direction: Direction,
  entry: number,
  stop: number,
  atr: number,
  config: LiquiditySweepConfig,
  zoneTouched: boolean
): TradePlanCandidate {
  const risk = Math.abs(entry - stop);
  const target = direction === "LONG" ? entry + risk * 2 : entry - risk * 2;
  const geometryValid = validTradeGeometry(direction, entry, stop, target);
  const availableRewardRisk = opposingLiquidityRewardRisk(levels, direction, entry, risk);
  const rr = geometryValid && risk > 0 ? Math.abs(target - entry) / risk : 0;
  const stopDistanceAtr = atr > 0 ? risk / atr : 999;
  const stopValid = geometryValid && stopDistanceAtr <= config.maximumStopATR;
  const riskApproved = geometryValid
    && stopValid
    && rr >= 2
    && availableRewardRisk >= config.minimumRiskReward;
  return {
    source,
    entry,
    stop,
    target,
    rr,
    availableRewardRisk,
    geometryValid,
    stopValid,
    stopDistanceAtr,
    zoneTouched,
    riskApproved
  };
}

export function validTradeGeometry(direction: Direction, entry: number, stop: number, target: number) {
  if (![entry, stop, target].every(Number.isFinite)) return false;
  return direction === "LONG"
    ? stop < entry && entry < target
    : target < entry && entry < stop;
}

function opposingLiquidityRewardRisk(levels: LiquidityLevel[], direction: Direction, entry: number, risk: number) {
  if (risk <= 0) return 0;
  const opposing = levels
    .filter((level) => direction === "LONG" ? level.side === "BUY_SIDE" && level.price > entry : level.side === "SELL_SIDE" && level.price < entry)
    .sort((left, right) => direction === "LONG" ? left.price - right.price : right.price - left.price)[0];
  if (!opposing) return 2;
  return Math.abs(opposing.price - entry) / risk;
}

function nearestOpposingLevel(levels: LiquidityLevel[], entry: number, direction: Direction) {
  return levels
    .filter((level) => direction === "LONG" ? level.side === "BUY_SIDE" && level.price > entry : level.side === "SELL_SIDE" && level.price < entry)
    .sort((left, right) => direction === "LONG" ? left.price - right.price : right.price - left.price)[0] ?? null;
}

function resolveDirectionalConflict(
  direction: Direction,
  sequence: ReturnType<typeof detectBestLiquiditySequence>,
  candidates: SweepCandidate[],
  config: LiquiditySweepConfig
) {
  if (!sequence) {
    return { clear: true, actual: "NO_SEQUENCE", reason: "No confirmed sequence exists, so no directional trade conflict can be active." };
  }
  const currentIndex = sequence.bos?.index ?? sequence.sweep.index;
  const recent = candidates.filter((candidate) => currentIndex - candidate.index >= 0 && currentIndex - candidate.index <= config.doubleSweepLookbackBars);
  const oppositeSide = direction === "LONG" ? "BUY_SIDE" : "SELL_SIDE";
  const opposite = recent.filter((candidate) => candidate.level.side === oppositeSide);
  if (opposite.length === 0) {
    return { clear: true, actual: direction, reason: "Only one actionable direction is present inside the recent sweep window." };
  }
  if (sequence.bos && sequence.zone && sequence.confirmation) {
    return { clear: true, actual: `${direction}_MSS_RETEST_CONFIRMED`, reason: "The selected direction has MSS, retest, and entry confirmation, so it overrides weaker opposite sweep evidence." };
  }
  return {
    clear: false,
    actual: `${direction}_WITH_${opposite.length}_OPPOSITE_SWEEP`,
    reason: "Both buy-side and sell-side liquidity were swept recently without a completed MSS retest confirmation, so Module 2 blocks the trade."
  };
}

function confirmsEntry(candle: Candle, direction: Direction, zone: { low: number; high: number; midpoint: number }) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (direction === "LONG") return candle.close > zone.midpoint && (candle.close > candle.open || lowerWick / range >= 0.35);
  return candle.close < zone.midpoint && (candle.close < candle.open || upperWick / range >= 0.35);
}

function confirmsMssRetest(candle: Candle, direction: Direction, zone: { low: number; high: number; midpoint: number }, protectedLevel: number, sweep: SweepCandidate) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const enteredZone = candle.low <= zone.high && candle.high >= zone.low;
  if (!enteredZone || bodyRatio < 0.45) return false;
  if (direction === "LONG") {
    return candle.close > protectedLevel
      && candle.close > candle.open
      && candle.close > sweep.candle.low;
  }
  return candle.close < protectedLevel
    && candle.close < candle.open
    && candle.close < sweep.candle.high;
}

function confirmsDirectionalEntry(candle: Candle, direction: Direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  const closeLocation = (candle.close - candle.low) / range;
  return direction === "LONG"
    ? candle.close > candle.open && bodyRatio >= 0.45 && closeLocation >= 0.65
    : candle.close < candle.open && bodyRatio >= 0.45 && closeLocation <= 0.35;
}

function confirmsEngulfingReversal(candles: Candle[], index: number, direction: Direction) {
  const current = candles[index];
  const previous = candles[index - 1];
  if (!current || !previous) return false;
  const currentBody = Math.abs(current.close - current.open);
  const previousBody = Math.abs(previous.close - previous.open);
  if (currentBody <= 0 || previousBody <= 0) return false;
  const currentBodyLow = Math.min(current.open, current.close);
  const currentBodyHigh = Math.max(current.open, current.close);
  const previousBodyLow = Math.min(previous.open, previous.close);
  const previousBodyHigh = Math.max(previous.open, previous.close);
  if (direction === "LONG") {
    return current.close > current.open
      && previous.close < previous.open
      && currentBodyLow <= previousBodyLow
      && currentBodyHigh >= previousBodyHigh;
  }
  return current.close < current.open
    && previous.close > previous.open
    && currentBodyLow <= previousBodyLow
    && currentBodyHigh >= previousBodyHigh;
}

function confirmsPinBarRejection(candle: Candle, direction: Direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (bodyRatio > 0.38) return false;
  if (direction === "LONG") return lowerWick / range >= 0.55 && candle.close > candle.open;
  return upperWick / range >= 0.55 && candle.close < candle.open;
}

function confirmsInsideBarBreak(candles: Candle[], index: number, direction: Direction) {
  const current = candles[index];
  const inside = candles[index - 1];
  const mother = candles[index - 2];
  if (!current || !inside || !mother) return false;
  const isInside = inside.high <= mother.high && inside.low >= mother.low;
  if (!isInside) return false;
  return direction === "LONG" ? current.close > inside.high : current.close < inside.low;
}

function confirmsDojiRejection(candle: Candle, direction: Direction) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  const closeLocation = (candle.close - candle.low) / range;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (bodyRatio > 0.18) return false;
  return direction === "LONG"
    ? lowerWick / range >= 0.4 && closeLocation >= 0.55
    : upperWick / range >= 0.4 && closeLocation <= 0.45;
}

function confirmsVolumeExpansion(candles: Candle[], index: number) {
  const currentVolume = Number(candles[index]?.volume ?? 0);
  if (!Number.isFinite(currentVolume) || currentVolume <= 0) return false;
  const lookback = candles.slice(Math.max(0, index - 20), index).map((candle) => Number(candle.volume ?? 0)).filter((volume) => Number.isFinite(volume) && volume > 0);
  if (lookback.length < 10) return false;
  const average = lookback.reduce((sum, volume) => sum + volume, 0) / lookback.length;
  return average > 0 && currentVolume >= average * 1.25;
}

function ema200Aligned(candles: Candle[], direction: Direction) {
  if (candles.length < 20) return false;
  const period = Math.min(200, candles.length);
  const ema = exponentialMovingAverage(candles.map((candle) => candle.close), period);
  const latest = candles.at(-1)?.close ?? 0;
  return direction === "LONG" ? latest >= ema : latest <= ema;
}

function volumeWeightedAveragePrice(candles: Candle[]) {
  const totals = candles.reduce(
    (accumulator, candle) => {
      const typical = (candle.high + candle.low + candle.close) / 3;
      const volume = Number(candle.volume ?? 1) || 1;
      return { priceVolume: accumulator.priceVolume + typical * volume, volume: accumulator.volume + volume };
    },
    { priceVolume: 0, volume: 0 }
  );
  return totals.volume > 0 ? totals.priceVolume / totals.volume : candles.at(-1)?.close ?? 0;
}

function detectSwingPoints(candles: Candle[], left: number, right: number, atr: number, timeframe: string, config: LiquiditySweepConfig): SwingPoint[] {
  const raw = detectPivots(candles, left, right);
  const swings: SwingPoint[] = [];
  for (const pivot of raw) {
    const nearestLeftOpposite = [...raw]
      .reverse()
      .find((other) => other.index < pivot.index && other.kind !== pivot.kind);
    const nearestRightOpposite = raw.find((other) => other.index > pivot.index && other.kind !== pivot.kind);
    const reference = pivot.kind === "HIGH"
      ? Math.max(nearestLeftOpposite?.price ?? pivot.price, nearestRightOpposite?.price ?? pivot.price)
      : Math.min(nearestLeftOpposite?.price ?? pivot.price, nearestRightOpposite?.price ?? pivot.price);
    const prominence = Math.abs(pivot.price - reference);
    const prominenceAtr = atr > 0 ? prominence / atr : 0;
    if (prominenceAtr < config.minimumSwingProminenceATR) continue;
    if (swings.some((swing) => Math.abs(swing.candleIndex - pivot.index) < config.minimumBarsBetweenSwings)) continue;
    const confirmedAt = candles[pivot.index + right]?.timestampUtc ?? pivot.time;
    const zone = Math.max(0.01, atr * config.structureToleranceATR);
    const hierarchy = timeframe === "1min" ? "MICRO" : timeframe === "5min" ? "INTERNAL" : "EXTERNAL";
    swings.push({
      id: `${timeframe}-${pivot.kind}-${pivot.index}-${pivot.time}`,
      type: pivot.kind,
      hierarchy,
      price: pivot.price,
      lowerBound: pivot.price - zone,
      upperBound: pivot.price + zone,
      candleIndex: pivot.index,
      formedAt: pivot.time,
      confirmedAt,
      timeframe,
      prominence,
      prominenceAtr,
      strengthScore: Math.min(100, Math.round(40 + prominenceAtr * 60)),
      confidence: Math.min(100, Math.round(40 + prominenceAtr * 60)),
      state: "CONFIRMED",
      status: "ACTIVE"
    });
  }
  return classifySwings(swings, atr, config);
}

function classifySwings(swings: SwingPoint[], atr: number, config: LiquiditySweepConfig) {
  const tolerance = Math.max(0.01, atr * config.structureToleranceATR);
  const latestByType: Partial<Record<SwingPoint["type"], SwingPoint>> = {};
  return swings.map((swing) => {
    const previous = latestByType[swing.type];
    latestByType[swing.type] = swing;
    if (!previous) return swing;
    if (swing.type === "HIGH") {
      const classification: SwingPoint["classification"] = swing.price > previous.price + tolerance
        ? "HH"
        : swing.price < previous.price - tolerance
          ? "LH"
          : "EQH";
      return { ...swing, classification };
    }
    const classification: SwingPoint["classification"] = swing.price > previous.price + tolerance
      ? "HL"
      : swing.price < previous.price - tolerance
        ? "LL"
        : "EQL";
    return { ...swing, classification };
  });
}

function classifyStructure(swings: SwingPoint[], atr: number, config: LiquiditySweepConfig, timeframe: string): StructureSummary {
  const highs = swings.filter((swing) => swing.type === "HIGH").slice(-2);
  const lows = swings.filter((swing) => swing.type === "LOW").slice(-2);
  const latestHigh = highs.at(-1);
  const latestLow = lows.at(-1);
  const highClassification = latestHigh?.classification;
  const lowClassification = latestLow?.classification;
  let state: StructureState = "UNKNOWN";
  if (highClassification === "HH" && lowClassification === "HL") state = "BULLISH";
  else if (highClassification === "LH" && lowClassification === "LL") state = "BEARISH";
  else if (highClassification?.startsWith("EQ") || lowClassification?.startsWith("EQ")) state = "RANGING";
  else if (latestHigh && latestLow) state = "TRANSITIONAL";
  return {
    timeframe,
    state,
    latestHigh,
    latestLow,
    highClassification,
    lowClassification,
    toleranceAtr: config.structureToleranceATR
  };
}

function detectPivots(candles: Candle[], left: number, right: number) {
  const pivots: Array<{ index: number; kind: "HIGH" | "LOW"; price: number; time: string }> = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const candle = candles[index];
    const leftCandles = candles.slice(index - left, index);
    const rightCandles = candles.slice(index + 1, index + right + 1);
    const swingHigh = leftCandles.every((item) => candle.high > item.high) && rightCandles.every((item) => candle.high >= item.high);
    const swingLow = leftCandles.every((item) => candle.low < item.low) && rightCandles.every((item) => candle.low <= item.low);
    if (swingHigh) pivots.push({ index, kind: "HIGH", price: candle.high, time: candle.timestampUtc });
    if (swingLow) pivots.push({ index, kind: "LOW", price: candle.low, time: candle.timestampUtc });
  }
  return pivots;
}

function detectBias(candles: Candle[]) {
  const pivots = detectPivots(candles, 2, 2).slice(-8);
  const highs = pivots.filter((pivot) => pivot.kind === "HIGH").slice(-2);
  const lows = pivots.filter((pivot) => pivot.kind === "LOW").slice(-2);
  const ema = exponentialMovingAverage(candles.map((candle) => candle.close), Math.min(200, Math.max(20, Math.floor(candles.length / 2))));
  const latest = candles.at(-1)?.close ?? 0;
  if (highs.length >= 2 && lows.length >= 2 && highs[1].price > highs[0].price && lows[1].price > lows[0].price && latest >= ema) return "BULLISH";
  if (highs.length >= 2 && lows.length >= 2 && highs[1].price < highs[0].price && lows[1].price < lows[0].price && latest <= ema) return "BEARISH";
  return "NEUTRAL";
}

function averageTrueRange(candles: Candle[], period: number) {
  const rows = candles.slice(-period - 1);
  if (rows.length < 2) return Math.max(0.01, (candles.at(-1)?.high ?? 0) - (candles.at(-1)?.low ?? 0));
  const ranges = rows.slice(1).map((candle, index) => {
    const previous = rows[index];
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  });
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function medianTrueRange(candles: Candle[], period: number) {
  const rows = candles.slice(-period - 1);
  if (rows.length < 2) return averageTrueRange(candles, Math.min(14, candles.length));
  const ranges = rows.slice(1).map((candle, index) => {
    const previous = rows[index];
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  }).sort((left, right) => left - right);
  const middle = Math.floor(ranges.length / 2);
  return ranges.length % 2 === 0 ? (ranges[middle - 1] + ranges[middle]) / 2 : ranges[middle];
}

function exponentialMovingAverage(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  return values.reduce((ema, value, index) => index === 0 ? value : value * multiplier + ema * (1 - multiplier), values[0] ?? 0);
}

function isInsideNewYorkWindow(timestamp: string, start: string, end: string) {
  const minutes = newYorkMinutes(timestamp);
  return minutes >= parseTime(start) && minutes <= parseTime(end);
}

function newYorkMinutes(timestamp: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp));
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function newYorkDateKey(timestamp: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function previousTradingDayCandles(candles: Candle[], timestamp: string) {
  const currentDate = newYorkDateKey(timestamp);
  const previousDate = [...new Set(candles.map((candle) => newYorkDateKey(candle.timestampUtc)))]
    .filter((date) => date < currentDate && !isWeekendDateKey(date))
    .sort()
    .at(-1);
  return previousDate ? candles.filter((candle) => newYorkDateKey(candle.timestampUtc) === previousDate) : [];
}

function isWeekendDateKey(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function timeOnly(timestamp: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}

function dedupeLevels(levels: LiquidityLevel[]) {
  const out: LiquidityLevel[] = [];
  for (const level of levels.sort((left, right) => priorityScore(right.priority) - priorityScore(left.priority))) {
    if (!out.some((existing) => Math.abs(existing.price - level.price) < 0.05 && existing.side === level.side)) out.push(level);
  }
  return out;
}

function evaluateLiquidityLifecycle(level: LiquidityLevel, candles: Candle[], now: string, atr: number, config: LiquiditySweepConfig) {
  const lowerBound = level.lowerBound ?? level.price;
  const upperBound = level.upperBound ?? level.price;
  const formedAtMs = new Date(level.formedAt ?? level.confirmedAt ?? now).getTime();
  const expiresAtMs = level.expiresAt ? new Date(level.expiresAt).getTime() : Number.POSITIVE_INFINITY;
  let touchCount = 0;
  let sweepCount = 0;
  let closeCountBeyond = 0;
  let lastTouchedAt: string | undefined;
  let state: LiquidityLevelState = level.state ?? "ACTIVE";
  for (const candle of candles) {
    const candleMs = new Date(candle.timestampUtc).getTime();
    if (Number.isFinite(formedAtMs) && candleMs < formedAtMs) continue;
    const touched = level.side === "BUY_SIDE" ? candle.high >= lowerBound : candle.low <= upperBound;
    const penetration = level.side === "BUY_SIDE" ? candle.high - upperBound : lowerBound - candle.low;
    const penetrationAtr = atr > 0 ? penetration / atr : 0;
    const closeBeyond = candleCloseBeyondLevel(candle, level);
    if (touched) {
      touchCount += 1;
      lastTouchedAt = candle.timestampUtc;
      if (state === "ACTIVE") state = "TOUCHED";
    }
    if (touched && penetration > 0 && penetrationAtr < config.minimumSweepDistanceATR) {
      state = "PARTIALLY_SWEPT";
    }
    if (penetrationAtr >= config.minimumSweepDistanceATR && penetrationAtr <= config.maximumSweepDistanceATR) {
      sweepCount += 1;
      state = "SWEPT";
    }
    if (closeBeyond) {
      closeCountBeyond += 1;
      if (closeCountBeyond >= config.acceptanceCloseCount) state = "ACCEPTED_BEYOND";
    } else if (closeCountBeyond > 0 && touched) {
      state = "RECLAIMED";
    }
  }
  const nowMs = new Date(now).getTime();
  if (Number.isFinite(nowMs) && nowMs > expiresAtMs) state = "EXPIRED";
  if (state === "ACCEPTED_BEYOND" && config.liquidityReusePolicy === "NEVER_REUSE") state = "CONSUMED";
  const freshnessScore = state === "CONSUMED" || state === "EXPIRED" || state === "ACCEPTED_BEYOND"
    ? 0
    : closeCountBeyond > 0
      ? 30
      : state === "PARTIALLY_SWEPT"
        ? 60
        : touchCount > 0
          ? 80
          : 100;
  const status = state === "EXPIRED" ? "EXPIRED" : state === "CONSUMED" || state === "ACCEPTED_BEYOND" ? "BROKEN" : state === "SWEPT" ? "SWEPT" : touchCount > 0 ? "TOUCHED" : "ACTIVE";
  return {
    state,
    status: status as LiquidityLevel["status"],
    touchCount,
    sweepCount,
    closeCountBeyond,
    lastTouchedAt,
    freshnessScore
  };
}

function summarizeLiquidityLifecycle(levels: LiquidityLevel[]) {
  const byState = levels.reduce<Record<string, number>>((accumulator, level) => {
    const state = level.state ?? "ACTIVE";
    accumulator[state] = (accumulator[state] ?? 0) + 1;
    return accumulator;
  }, {});
  return {
    total: levels.length,
    byState,
    activeLevels: levels
      .filter((level) => !["CONSUMED", "EXPIRED", "RETIRED"].includes(level.state ?? "ACTIVE"))
      .slice(0, 12)
      .map((level) => ({
        id: level.id,
        type: level.type,
        side: level.side,
        price: level.price,
        state: level.state,
        freshnessScore: level.freshnessScore,
        qualityScore: level.qualityScore,
        touchCount: level.touchCount,
        sweepCount: level.sweepCount,
        sourceIds: level.sourceIds
      }))
  };
}

function rankLiquidityLevels(levels: LiquidityLevel[], candles: Candle[], now: string, atr: number, config: LiquiditySweepConfig) {
  const currentDate = newYorkDateKey(now);
  const tolerance = Math.max(0.05, atr * config.liquidityMergeToleranceATR);
  const ranked = levels.map((level) => {
    const lifecycle = evaluateLiquidityLifecycle(level, candles, now, atr, config);
    const reactions = countLevelReactions(candles, level, tolerance);
    const overlaps = levels.some((other) => other !== level && other.side === level.side && Math.abs(other.price - level.price) <= tolerance * 2);
    const nearestOpposite = levels
      .filter((other) => other.side !== level.side)
      .sort((left, right) => Math.abs(left.price - level.price) - Math.abs(right.price - level.price))[0];
    const untouched = !candles.some((candle) => {
      const candleDate = newYorkDateKey(candle.timestampUtc);
      if (candleDate >= currentDate) return false;
      return level.side === "BUY_SIDE" ? candle.high >= level.price : candle.low <= level.price;
    });
    const overlapBonus = overlaps ? 10 : 0;
    const htfBonus = ["PREVIOUS_WEEK_HIGH", "PREVIOUS_WEEK_LOW", "PREVIOUS_DAY_HIGH", "PREVIOUS_DAY_LOW", "LONDON_HIGH", "LONDON_LOW"].includes(level.type) ? 5 : 0;
    const clusterBonus = (level.clusterSize ?? 1) >= 3 ? 4 : 0;
    const acceptedPenalty = acceptedPastLevel(candles, level, atr) ? -10 : 0;
    const opposingPenalty = nearestOpposite && atr > 0 && Math.abs(nearestOpposite.price - level.price) / atr < 0.75 ? -8 : 0;
    const oldPenalty = olderThanTradingDays(level, now, 5) ? -5 : 0;
    const lowLiquidityPenalty = ["ROUND_NUMBER", "SWING_HIGH", "SWING_LOW"].includes(level.type) && reactions < 2 ? -5 : 0;
    const reactionBonus = reactions >= 2 ? 6 : 0;
    const untouchedBonus = untouched ? 8 : 0;
    const reactionScore = reactionBonus + untouchedBonus;
    const overlapScore = overlapBonus + htfBonus + clusterBonus + opposingPenalty;
    const score = (level.priorityScore ?? levelPriorityScore(level.type, level.priority))
      + reactionScore
      + overlapScore
      + acceptedPenalty
      + oldPenalty
      + lowLiquidityPenalty;
    const qualityScore = Math.max(0, Math.min(100, score + lifecycle.freshnessScore * 0.25));
    return {
      ...level,
      ...lifecycle,
      priorityScore: score,
      reactionScore,
      overlapScore,
      qualityScore: Number(qualityScore.toFixed(2)),
      touchCount: Math.max(level.touchCount ?? 0, reactions, lifecycle.touchCount),
      status: acceptedPenalty < 0 && lifecycle.state !== "SWEPT" ? "BROKEN" as const : lifecycle.status
    };
  });
  const latestClose = candles.at(-1)?.close ?? 0;
  return mergeNearbyLevels(ranked, tolerance)
    .sort((left, right) => (right.priorityScore ?? 0) - (left.priorityScore ?? 0) || Math.abs(left.price - latestClose) - Math.abs(right.price - latestClose));
}

function mergeNearbyLevels(levels: LiquidityLevel[], tolerance: number) {
  const merged: LiquidityLevel[] = [];
  for (const level of levels.sort((left, right) => (right.priorityScore ?? 0) - (left.priorityScore ?? 0))) {
    const existing = merged.find((item) => item.side === level.side && Math.abs(item.price - level.price) <= tolerance && Math.abs((item.priorityScore ?? 0) - (level.priorityScore ?? 0)) <= 5);
    if (!existing) {
      merged.push(level);
      continue;
    }
    existing.price = level.side === "BUY_SIDE" ? Math.max(existing.price, level.price) : Math.min(existing.price, level.price);
    existing.type = "COMPOSITE";
    existing.lowerBound = Math.min(existing.lowerBound ?? existing.price, level.lowerBound ?? level.price);
    existing.upperBound = Math.max(existing.upperBound ?? existing.price, level.upperBound ?? level.price);
    existing.priorityScore = Math.max(existing.priorityScore ?? 0, level.priorityScore ?? 0) + 10;
    existing.touchCount = (existing.touchCount ?? 0) + (level.touchCount ?? 0);
    existing.sweepCount = (existing.sweepCount ?? 0) + (level.sweepCount ?? 0);
    existing.closeCountBeyond = (existing.closeCountBeyond ?? 0) + (level.closeCountBeyond ?? 0);
    existing.clusterSize = (existing.clusterSize ?? 1) + (level.clusterSize ?? 1);
    existing.sourceIds = [...new Set([...(existing.sourceIds ?? [existing.source]), ...(level.sourceIds ?? [level.source])])];
    existing.source = `${existing.source} + ${level.source}`;
    existing.state = existing.state === "ACTIVE" ? level.state ?? existing.state : existing.state;
  }
  return merged;
}

function countLevelReactions(candles: Candle[], level: LiquidityLevel, tolerance: number) {
  return candles.reduce((count, candle) => {
    const touched = level.side === "BUY_SIDE"
      ? Math.abs(candle.high - level.price) <= tolerance
      : Math.abs(candle.low - level.price) <= tolerance;
    const rejected = level.side === "BUY_SIDE" ? candle.close < level.price : candle.close > level.price;
    return touched && rejected ? count + 1 : count;
  }, 0);
}

function acceptedPastLevel(candles: Candle[], level: LiquidityLevel, atr: number) {
  const threshold = Math.max(0.05, atr * 0.15);
  return candles.slice(-80).some((candle) => level.side === "BUY_SIDE"
    ? candle.close > level.price + threshold
    : candle.close < level.price - threshold);
}

function olderThanTradingDays(level: LiquidityLevel, now: string, days: number) {
  if (!["SWING_HIGH", "SWING_LOW", "EQUAL_HIGH", "EQUAL_LOW"].includes(level.type)) return false;
  const currentDate = new Date(`${newYorkDateKey(now)}T12:00:00Z`).getTime();
  const match = level.source.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return false;
  const levelDate = new Date(`${match[0]}T12:00:00Z`).getTime();
  return Number.isFinite(currentDate) && Number.isFinite(levelDate) && currentDate - levelDate > days * 24 * 60 * 60 * 1000;
}

function addEqualHighLowLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>, atr: number) {
  const tolerance = Math.max(0.05, atr * 0.05);
  addEqualLevels(levels, pivots.filter((pivot) => pivot.kind === "HIGH"), "EQUAL_HIGH", "BUY_SIDE", tolerance);
  addEqualLevels(levels, pivots.filter((pivot) => pivot.kind === "LOW"), "EQUAL_LOW", "SELL_SIDE", tolerance);
}

function addExternalSwingLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>) {
  const latestHigh = [...pivots].reverse().find((pivot) => pivot.kind === "HIGH");
  const latestLow = [...pivots].reverse().find((pivot) => pivot.kind === "LOW");
  if (latestHigh) {
    levels.push({
      type: "SWING_HIGH",
      side: "BUY_SIDE",
      price: latestHigh.price,
      timeframe: "15min",
      formedAt: latestHigh.time,
      confirmedAt: latestHigh.time,
      priority: "MEDIUM",
      priorityScore: levelPriorityScore("SWING_HIGH", "MEDIUM"),
      source: `CONFIRMED_EXTERNAL_SWING_HIGH:${newYorkDateKey(latestHigh.time)}`,
      touchCount: 1,
      clusterSize: 1,
      status: "ACTIVE"
    });
  }
  if (latestLow) {
    levels.push({
      type: "SWING_LOW",
      side: "SELL_SIDE",
      price: latestLow.price,
      timeframe: "15min",
      formedAt: latestLow.time,
      confirmedAt: latestLow.time,
      priority: "MEDIUM",
      priorityScore: levelPriorityScore("SWING_LOW", "MEDIUM"),
      source: `CONFIRMED_EXTERNAL_SWING_LOW:${newYorkDateKey(latestLow.time)}`,
      touchCount: 1,
      clusterSize: 1,
      status: "ACTIVE"
    });
  }
}

function addInternalSwingLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>) {
  const latestHigh = [...pivots].reverse().find((pivot) => pivot.kind === "HIGH");
  const latestLow = [...pivots].reverse().find((pivot) => pivot.kind === "LOW");
  if (latestHigh) {
    levels.push({
      type: "SWING_HIGH",
      side: "BUY_SIDE",
      price: latestHigh.price,
      timeframe: "5min",
      formedAt: latestHigh.time,
      confirmedAt: latestHigh.time,
      priority: "LOW",
      priorityScore: 45,
      source: `CONFIRMED_INTERNAL_SWING_HIGH:${newYorkDateKey(latestHigh.time)}`,
      touchCount: 1,
      clusterSize: 1,
      status: "ACTIVE"
    });
  }
  if (latestLow) {
    levels.push({
      type: "SWING_LOW",
      side: "SELL_SIDE",
      price: latestLow.price,
      timeframe: "5min",
      formedAt: latestLow.time,
      confirmedAt: latestLow.time,
      priority: "LOW",
      priorityScore: 45,
      source: `CONFIRMED_INTERNAL_SWING_LOW:${newYorkDateKey(latestLow.time)}`,
      touchCount: 1,
      clusterSize: 1,
      status: "ACTIVE"
    });
  }
}

function addManualLevels(levels: LiquidityLevel[], config: LiquiditySweepConfig) {
  for (const item of config.manualLevels ?? []) {
    if (!Number.isFinite(item.price)) continue;
    levels.push({
      type: "MANUAL_LEVEL",
      side: item.side ?? "BUY_SIDE",
      price: item.price,
      priority: item.priority ?? "MEDIUM",
      priorityScore: levelPriorityScore("MANUAL_LEVEL", item.priority ?? "MEDIUM"),
      source: item.label ? `MANUAL: ${item.label}` : "MANUAL_LEVEL",
      touchCount: 1,
      clusterSize: 1,
      status: "ACTIVE"
    });
  }
}

function addRoundNumberLevels(levels: LiquidityLevel[], candles: Candle[], config: LiquiditySweepConfig) {
  const latest = candles.at(-1);
  if (!latest || config.roundNumberStep <= 0) return;
  const center = Math.round(latest.close / config.roundNumberStep) * config.roundNumberStep;
  const formedAt = latest.timestampUtc;
  for (let offset = -config.roundNumberWindowSteps; offset <= config.roundNumberWindowSteps; offset += 1) {
    const price = center + offset * config.roundNumberStep;
    if (price <= 0) continue;
    levels.push({
      type: "ROUND_NUMBER",
      side: price >= latest.close ? "BUY_SIDE" : "SELL_SIDE",
      price,
      timeframe: "CONTEXT",
      formedAt,
      confirmedAt: formedAt,
      priority: "LOW",
      priorityScore: levelPriorityScore("ROUND_NUMBER", "LOW"),
      source: `ROUND_NUMBER:${price.toFixed(2)}`,
      sourceIds: [`ROUND_NUMBER:${price.toFixed(2)}`],
      touchCount: 0,
      clusterSize: 1,
      status: "ACTIVE",
      state: "ACTIVE"
    });
  }
}

function addEqualLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>, type: LiquidityLevelType, side: LiquidityLevel["side"], tolerance: number) {
  for (let index = 0; index < pivots.length; index += 1) {
    const cluster = pivots.filter((pivot, otherIndex) => otherIndex !== index && Math.abs(pivot.price - pivots[index].price) <= tolerance);
    if (cluster.length === 0) continue;
    const prices = [pivots[index], ...cluster].map((pivot) => pivot.price);
    const times = [pivots[index], ...cluster].map((pivot) => pivot.time).sort();
    levels.push({
      type,
      side,
      price: side === "BUY_SIDE" ? Math.max(...prices) : Math.min(...prices),
      timeframe: "5min",
      formedAt: times[0],
      confirmedAt: times.at(-1) ?? times[0],
      priority: "MEDIUM",
      priorityScore: levelPriorityScore(type, "MEDIUM"),
      source: `${type} cluster`,
      touchCount: prices.length,
      clusterSize: prices.length,
      status: "ACTIVE"
    });
    return;
  }
}

function priorityScore(priority: LiquidityLevel["priority"]) {
  return priority === "HIGH" ? 3 : priority === "MEDIUM" ? 2 : 1;
}

function module2VariantCandidates(input: {
  direction: Direction;
  sweep: SweepCandidate;
  displacement: unknown;
  bos: any;
  structureType: string;
  zone: unknown;
  retrace: boolean;
  entryConfirmation: boolean;
  ema200Ok: boolean;
  vwapOk: boolean;
  fvgOk: boolean;
  engulfingOk: boolean;
  volumeExpansionOk: boolean;
  orderBlockRetestOk: boolean;
  spreadOk: boolean;
  newsOk: boolean;
  rrOk: boolean;
  stopValid: boolean;
  score: number;
  scoreOk: boolean;
  dataHealthOk: boolean;
  sessionActive: boolean;
  tradeLimitOk: boolean;
  activeSetupOk: boolean;
  activePositionOk: boolean;
  riskLimitsOk: boolean;
  manualConfirmationOk: boolean;
  directionalConflictClear: boolean;
  geometryValid: boolean;
  riskOk: boolean;
}): Module2Variant[] {
  const base = {
    version: MODULE2_VARIANT_VERSION,
    qualityOk: input.spreadOk && input.newsOk && input.rrOk && input.stopValid
  };
  const rows: Module2Variant[] = [
    variant("A", "SWEEP_CLOSE_BACK_INSIDE", "A. Sweep + close-back inside", "ENTRY_GRADE", "PAPER_APPROVED", true, 55, ["LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["SWEEP_REJECTION_CONFIRMED", Boolean(input.sweep)]
    ], "Variant A passed: sweep and close-back-inside confirmed the strategy profile.", base, input.direction),
    variant("B", "SWEEP_BOS", "B. Sweep + BOS", "ENTRY_GRADE", "PAPER_APPROVED", true, 68, ["LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "CONTINUATION_BOS"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["SWEEP_REJECTION_CONFIRMED", Boolean(input.sweep)],
      ["CONTINUATION_BOS", input.structureType === "CONTINUATION_BOS" && Boolean(input.bos)]
    ], "Variant B passed: sweep and continuation BOS confirmed the strategy profile.", base, input.direction),
    variant("C", "SWEEP_MSS", "C. Sweep + MSS", "ENTRY_GRADE", "PAPER_APPROVED", true, 75, ["LIQUIDITY_SWEEP_CONFIRMED", "SWEEP_REJECTION_CONFIRMED", "REVERSAL_MSS", "MSS_STRENGTH"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["SWEEP_REJECTION_CONFIRMED", Boolean(input.sweep)],
      ["REVERSAL_MSS", input.structureType === "REVERSAL_MSS" && Boolean(input.bos)],
      ["MSS_STRENGTH", Boolean(input.bos?.breakDistanceAtr != null && input.bos.breakDistanceAtr >= DEFAULT_CONFIG.minimumBosCloseDistanceATR && input.bos.bodyRatio >= 0.5)]
    ], "Variant C passed: sweep and reversal MSS confirmed the strategy profile.", base, input.direction),
    variant("D", "SWEEP_ENGULFING", "D. Sweep + engulfing", "ENTRY_GRADE", "PAPER_APPROVED", true, 62, ["LIQUIDITY_SWEEP_CONFIRMED", "CONFIRM_ENGULFING"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["CONFIRM_ENGULFING", input.engulfingOk]
    ], "Variant D passed: sweep plus engulfing rejection confirmed the strategy profile.", base, input.direction),
    variant("E", "SWEEP_BOS_RETEST", "E. Sweep + BOS + retest", "PRODUCTION", "PRODUCTION_APPROVED", true, 82, ["LIQUIDITY_SWEEP_CONFIRMED", "CONTINUATION_BOS", "ENTRY_ZONE_RETRACE"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["CONTINUATION_BOS", input.structureType === "CONTINUATION_BOS" && Boolean(input.bos)],
      ["ENTRY_ZONE_RETRACE", input.retrace]
    ], "Variant E passed: sweep, BOS, and retest confirmed the strategy profile.", base, input.direction),
    variant("F", "SWEEP_MSS_RETEST", "F. Sweep + MSS + retest", "PRODUCTION", "PRODUCTION_APPROVED", true, 90, [
      "LIQUIDITY_LEVEL_IDENTIFIED",
      "LIQUIDITY_SWEEP_CONFIRMED",
      "SWEEP_REJECTION_CONFIRMED",
      "SWEEP_ACCEPTANCE_BLOCK",
      "REVERSAL_MSS",
      "MSS_STRENGTH",
      "ENTRY_ZONE_READY",
      "ENTRY_ZONE_RETRACE",
      "CONFIRM_ENTRY_CANDLE",
      "DIRECTIONAL_CONFLICT_CLEAR"
    ], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["SWEEP_REJECTION_CONFIRMED", Boolean(input.sweep)],
      ["REVERSAL_MSS", input.structureType === "REVERSAL_MSS" && Boolean(input.bos)],
      ["MSS_STRENGTH", Boolean(input.bos?.breakDistanceAtr != null && input.bos.breakDistanceAtr >= DEFAULT_CONFIG.minimumBosCloseDistanceATR && input.bos.bodyRatio >= 0.5)],
      ["ENTRY_ZONE_READY", Boolean(input.zone)],
      ["ENTRY_ZONE_RETRACE", input.retrace],
      ["CONFIRM_ENTRY_CANDLE", input.entryConfirmation],
      ["DIRECTIONAL_CONFLICT_CLEAR", input.directionalConflictClear]
    ], "Strict production path passed: sweep, close-back rejection, reversal MSS, MSS-zone retest, and entry confirmation are complete.", base, input.direction),
    variant("G", "SWEEP_EMA_ALIGNMENT", "G. Sweep + EMA alignment", "ENTRY_GRADE", "PAPER_APPROVED", true, 64, ["LIQUIDITY_SWEEP_CONFIRMED", "CONFIRM_EMA_200"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["CONFIRM_EMA_200", input.ema200Ok]
    ], "Variant G passed: sweep and EMA alignment confirmed the strategy profile.", base, input.direction),
    variant("H", "SWEEP_VOLUME_EXPANSION", "H. Sweep + volume expansion", "ENTRY_GRADE", "PAPER_APPROVED", true, 60, ["LIQUIDITY_SWEEP_CONFIRMED", "CONFIRM_VOLUME_EXPANSION"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["CONFIRM_VOLUME_EXPANSION", input.volumeExpansionOk]
    ], "Variant H passed: sweep and provider volume expansion confirmed the strategy profile.", base, input.direction),
    variant("I", "SWEEP_MSS_DISPLACEMENT_RETEST", "I. Sweep + MSS + displacement + retest", "PRODUCTION", "PRODUCTION_APPROVED", true, 96, ["LIQUIDITY_SWEEP_CONFIRMED", "REVERSAL_MSS", "DISPLACEMENT_CONFIRMED", "ENTRY_ZONE_RETRACE"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["REVERSAL_MSS", input.structureType === "REVERSAL_MSS" && Boolean(input.bos)],
      ["DISPLACEMENT_CONFIRMED", Boolean(input.displacement)],
      ["ENTRY_ZONE_RETRACE", input.retrace]
    ], "Variant I passed: sweep, MSS, displacement, and retest confirmed the highest-confirmation strategy profile.", base, input.direction),
    variant("J", "SWEEP_NO_CONFIRMATION", "J. Sweep + no confirmation", "RESEARCH", "RESEARCH_ONLY", false, 12, ["LIQUIDITY_SWEEP_CONFIRMED"], [
      ["LIQUIDITY_SWEEP_CONFIRMED", Boolean(input.sweep)],
      ["NO_STRUCTURE_CONFIRMATION", !input.displacement || !input.bos]
    ], "Variant J passed: sweep-only control for backtesting comparison, not actionable BUY/SELL output.", base, input.direction)
  ];
  return rows.map((row) => ({ ...row, score: row.status === "PASS" ? row.score + Math.min(10, Math.round(input.score / 10)) : row.score }));
}

function variant(
  profileKey: Module2Variant["profileKey"],
  code: Module2VariantCode,
  name: string,
  category: Module2Variant["category"],
  approvalStatus: Module2Variant["approvalStatus"],
  paperVariant: boolean,
  score: number,
  requiredRules: string[],
  checks: Array<[string, boolean]>,
  passReason: string,
  base: { version: string; qualityOk: boolean },
  direction: Direction
): Module2Variant {
  const missingRules = checks.filter(([, passed]) => !passed).map(([rule]) => rule);
  const passed = missingRules.length === 0;
  return {
    code,
    profileKey,
    sortOrder: profileKey.charCodeAt(0) - 64,
    version: base.version,
    name,
    category,
    approvalStatus,
    status: passed ? paperVariant ? "PASS" : "RESEARCH_ONLY" : "WAIT",
    decision: passed ? paperVariant ? direction === "LONG" ? "BUY_READY" : "SELL_READY" : "RESEARCH_ONLY" : "WAIT",
    paperEligible: paperVariant && passed,
    score,
    requiredRules,
    missingRules,
    reason: passed ? passReason : `Waiting for ${missingRules.join(", ")}.`
  };
}

function selectModule2Variant(variants: Module2Variant[]) {
  return variants
    .filter((row) => row.paperEligible)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function scoreSetup(input: any) {
  let score = 0;
  if (input.sessionActive) score += 5;
  if (input.level?.priority === "HIGH") score += 10;
  else if (input.level) score += 6;
  if (input.sweep) score += 15;
  if (input.sweep?.distanceAtr >= 0.15) score += 5;
  if (input.displacement) score += 15;
  if (input.bos) score += 15;
  if (input.fvg) score += 10;
  if (input.orderBlock) score += 5;
  if (input.biasOk) score += 10;
  if (input.confirmation) score += 5;
  if (input.plan?.rr >= 2) score += 5;
  if (input.newsOk && input.spreadOk) score += 5;
  return Math.min(score, 110);
}

function grade(score: number): "A+" | "A" | "B" | "C" | "D" {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}

function tradeGrade(confirmationCount: number, qualityCount: number): "A+" | "A" | "B" | "C" {
  if (confirmationCount >= 4 && qualityCount >= 5) return "A+";
  if (confirmationCount >= 3 && qualityCount >= 3) return "A";
  if (confirmationCount >= 2 && qualityCount >= 3) return "B";
  return "C";
}

function reasonList(score: number, level: LiquidityLevel, htfBias: string, fvg: unknown, orderBlock: unknown, rr: number, confirmationCount: number, qualityCount: number) {
  return [
    `${level.type} ${level.side === "BUY_SIDE" ? "buy-side" : "sell-side"} liquidity swept`,
    `HTF bias: ${htfBias}`,
    `${confirmationCount}/7 confirmations matched`,
    `${qualityCount}/6 quality filters matched`,
    fvg ? "Fresh FVG found" : "Order-block fallback used",
    orderBlock ? "Order-block confluence available" : "No order-block confluence",
    `Risk-reward ${rr.toFixed(2)}R`,
    `Confidence ${score}%`
  ];
}

function candleShape(candle: Candle) {
  return candle.close > candle.open ? "BULLISH_CLOSE" : candle.close < candle.open ? "BEARISH_CLOSE" : "DOJI";
}

function push(evaluations: RuleEvaluation[], ruleCode: string, name: string, passed: boolean, blocking: boolean, source: "AUTOMATIC" | "MANUAL", actualValue: unknown, requiredValue: unknown, explanation: string) {
  evaluations.push({
    ruleCode,
    name,
    ...module2RuleLayer(ruleCode),
    status: passed ? "PASS" : "FAIL",
    blocking,
    source,
    actualValue: actualValue == null ? null : String(actualValue),
    requiredValue: requiredValue == null ? null : String(requiredValue),
    explanation
  });
}

function waitDecision(scenario: string, reason: string, evaluations: RuleEvaluation[], flags: Record<string, unknown>, levels?: unknown, htfBias?: unknown, sweep?: unknown, direction?: Direction, zone?: unknown): LiquiditySweepDecision {
  const state = stateFromScenario(scenario);
  const at = latestStateTransitionTime(flags) ?? new Date().toISOString();
  const stateMachine = appendStateTransition(flags.stateMachine, state, at, reason);
  return {
    scenario,
    direction: direction ?? null,
    status: "WAIT",
    state,
    finalReason: reason,
    evaluations,
    scenarioFlags: { ...flags, levels, htfBias, sweep, entryZone: zone, state, stateMachine },
    favorabilityScore: 0,
    favorabilityGrade: "D",
    favorabilityReasons: [reason]
  };
}

function blockedDecision(scenario: string, reason: string, evaluations: RuleEvaluation[], flags: Record<string, unknown>, direction?: Direction | null, score = 0): LiquiditySweepDecision {
  const at = latestStateTransitionTime(flags) ?? new Date().toISOString();
  const status = scenario.includes("INVALID") ? "INVALIDATED" : scenario.includes("BLOCK") ? "BLOCKED" : "NO TRADE";
  const state: LiquiditySweepState = status === "INVALIDATED" ? "INVALIDATED" : status === "BLOCKED" ? "BLOCKED" : "NO_TRADE";
  const stateMachine = appendStateTransition(flags.stateMachine, state, at, reason);
  return {
    scenario,
    direction: direction ?? null,
    status,
    state,
    finalReason: reason,
    evaluations,
    scenarioFlags: {
      ...flags,
      state,
      stateMachine,
      ...(state === "INVALIDATED" ? { invalidationReason: reason } : { blockReason: reason })
    },
    favorabilityScore: score,
    favorabilityGrade: grade(score),
    favorabilityReasons: [reason]
  };
}

function expiredDecision(scenario: string, reason: string, evaluations: RuleEvaluation[], flags: Record<string, unknown>, direction?: Direction | null, score = 0): LiquiditySweepDecision {
  const at = latestStateTransitionTime(flags) ?? new Date().toISOString();
  const stateMachine = appendStateTransition(flags.stateMachine, "EXPIRED", at, reason);
  return {
    scenario,
    direction: direction ?? null,
    status: "EXPIRED",
    state: "EXPIRED",
    finalReason: reason,
    evaluations,
    scenarioFlags: { ...flags, state: "EXPIRED", stateMachine, expirationReason: reason },
    favorabilityScore: score,
    favorabilityGrade: grade(score),
    favorabilityReasons: [reason]
  };
}

function latestStateTransitionTime(flags: Record<string, unknown>) {
  const transitions = Array.isArray((flags.stateMachine as any)?.transitions) ? (flags.stateMachine as any).transitions : [];
  const latest = transitions.at(-1)?.at;
  return typeof latest === "string" ? latest : null;
}

function appendStateTransition(machine: unknown, to: LiquiditySweepState, at: string, reason: string) {
  const current = typeof machine === "object" && machine !== null && "current" in machine
    ? String((machine as any).current)
    : null;
  const transitions = typeof machine === "object" && machine !== null && Array.isArray((machine as any).transitions)
    ? (machine as any).transitions
    : [];
  if (current === to && transitions.at(-1)?.reason === reason) return { current: to, transitions };
  return {
    current: to,
    transitions: [
      ...transitions,
      { from: current, to, at, reason }
    ]
  };
}

function stateFromScenario(scenario: string): LiquiditySweepState {
  if (scenario.includes("SESSION_INACTIVE")) return "IDLE";
  if (scenario.includes("WAITING_FOR_MSS")) return "WAITING_FOR_CONFIRMATION";
  if (scenario.includes("WAITING_FOR_RETRACE")) return "WAITING_FOR_RETRACE";
  if (scenario.includes("ENTRY_CONFIRMATION")) return "ENTRY_CONFIRMATION";
  if (scenario.includes("ENTRY_ZONE_READY")) return "ENTRY_ZONE_READY";
  if (scenario.includes("SWEEP")) return "LEVEL_APPROACH";
  if (scenario.includes("DISPLACEMENT")) return "SWEEP_DETECTED";
  if (scenario.includes("BOS")) return "DISPLACEMENT_CONFIRMED";
  if (scenario.includes("ENTRY_ZONE")) return "BOS_CONFIRMED";
  return "IDLE";
}
