import type { Candle, Direction, RuleEvaluation } from "@orb-guide/shared-types";

export type LiquiditySweepState =
  | "IDLE"
  | "LEVEL_SELECTED"
  | "SWEEP_CANDIDATE"
  | "SWEEP_CONFIRMED"
  | "WAITING_FOR_CONFIRMATION"
  | "STRUCTURE_BREAK_CANDIDATE"
  | "STRUCTURE_BREAK_CONFIRMED"
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
  | "INVALIDATED";

export type LiquidityLevelType =
  | "PREVIOUS_DAY_HIGH"
  | "PREVIOUS_DAY_LOW"
  | "ASIAN_HIGH"
  | "ASIAN_LOW"
  | "LONDON_HIGH"
  | "LONDON_LOW"
  | "EQUAL_HIGH"
  | "EQUAL_LOW"
  | "SWING_HIGH"
  | "SWING_LOW";

export type LiquidityLevel = {
  type: LiquidityLevelType;
  side: "BUY_SIDE" | "SELL_SIDE";
  price: number;
  lowerBound?: number;
  upperBound?: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
  priorityScore?: number;
  source: string;
  zoneHalfWidth?: number;
  touchCount?: number;
  clusterSize?: number;
  status?: "ACTIVE" | "TOUCHED" | "SWEPT" | "BROKEN" | "EXPIRED";
};

export type SwingPoint = {
  id: string;
  type: "HIGH" | "LOW";
  price: number;
  candleIndex: number;
  formedAt: string;
  confirmedAt: string;
  timeframe: string;
  prominence: number;
  prominenceAtr: number;
  strengthScore: number;
  classification?: "HH" | "HL" | "LH" | "LL" | "EQH" | "EQL";
  status: "ACTIVE" | "BROKEN" | "SWEPT" | "EXPIRED";
};

export type StructureState = "BULLISH" | "BEARISH" | "RANGING" | "TRANSITIONAL" | "UNKNOWN";

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
  asianStartTime: string;
  asianEndTime: string;
  londonStartTime: string;
  londonEndTime: string;
  maximumTradesPerSession: number;
  zoneToleranceATR: number;
  equalityToleranceATR: number;
  minimumSwingProminenceATR: number;
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
  spread?: number | null;
  newsStatus?: string;
  tradesTakenThisSession?: number;
  configuration?: Partial<LiquiditySweepConfig>;
};

export type LiquiditySweepDecision = {
  scenario: string;
  direction: Direction | null;
  status: "WAIT" | "LONG SETUP READY" | "SHORT SETUP READY" | "NO TRADE" | "BLOCKED";
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
  asianStartTime: "19:00",
  asianEndTime: "04:00",
  londonStartTime: "03:00",
  londonEndTime: "09:30",
  maximumTradesPerSession: 3,
  zoneToleranceATR: 0.02,
  equalityToleranceATR: 0.05,
  minimumSwingProminenceATR: 0.2,
  structureToleranceATR: 0.05,
  protectedPointMinimumConfidence: "MEDIUM",
  minimumSweepDistanceATR: 0.1,
  maximumSweepDistanceATR: 1,
  minimumSweepRejectionWickRatio: 0.35,
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
  minimumBosCloseDistanceATR: 0.05,
  maximumBarsAfterSweepForBos: 10,
  maximumBarsAfterBosForEntry: 15,
  minimumFvgSizeATR: 0.1,
  entryAtFvgPercentage: 50,
  minimumRiskReward: 2,
  maximumStopATR: 1.25,
  stopBufferATR: 0.1,
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
    return waitDecision("WAITING_FOR_DATA", "Waiting for enough 5M candles to evaluate liquidity sweep + BOS.", evaluations, flags);
  }

  const atr = averageTrueRange(setupCandles, 14);
  const internalSwings = detectSwingPoints(setupCandles, config.pivotLeftBars, config.pivotRightBars, atr, "5min", config);
  const externalSwings = detectSwingPoints(biasCandles, config.pivotLeftBars, config.pivotRightBars, averageTrueRange(biasCandles, 14), "15min", config);
  const internalStructure = classifyStructure(internalSwings, atr, config, "5min");
  const externalStructure = classifyStructure(externalSwings, averageTrueRange(biasCandles, 14), config, "15min");
  const htfBias = detectBias(biasCandles);
  const levels = detectLiquidityLevels(setupCandles, current.timestampUtc, atr, config);
  const pivots = detectPivots(setupCandles, config.pivotLeftBars, config.pivotRightBars);
  const sessionActive = isInsideNewYorkWindow(current.timestampUtc, config.newYorkStartTime, config.newYorkEndTime);
  const spreadOk = context.spread == null || context.spread <= config.maximumSpread;
  const newsOk = !config.enableNewsFilter || !String(context.newsStatus ?? "CLEAR").includes("BLOCKED");
  const tradeLimitOk = (context.tradesTakenThisSession ?? 0) < config.maximumTradesPerSession;
  flags.terminologyVersion = "LIQUIDITY_SWEEP_STRUCTURE_CONFIRMATION_V1";
  flags.atr14 = Number(atr.toFixed(5));
  flags.internalStructure = internalStructure;
  flags.externalStructure = externalStructure;
  flags.recentSwings = internalSwings.slice(-12);
  flags.stateMachine = {
    current: "IDLE",
    transitions: [{ from: null, to: "IDLE", at: current.timestampUtc, reason: "Processing latest closed 5M candle." }]
  };

  push(evaluations, "NY_SESSION_ACTIVE", "New York session active", sessionActive, true, "AUTOMATIC", timeOnly(current.timestampUtc), `${config.newYorkStartTime}-${config.newYorkEndTime}`, sessionActive ? "Current candle is inside the configured New York sweep window." : "No Module 2 signal is allowed outside the configured New York window.");
  push(evaluations, "DAILY_TRADE_LIMIT", "Daily trade limit not reached", tradeLimitOk, true, "AUTOMATIC", context.tradesTakenThisSession ?? 0, `< ${config.maximumTradesPerSession}`, tradeLimitOk ? "Session trade limit allows another paper setup." : "The configured session trade limit has already been reached.");

  if (!sessionActive || !tradeLimitOk) {
    return blockedDecision("HARD_RULE_BLOCK", "Module 2 hard rules failed before liquidity evaluation.", evaluations, flags);
  }

  const sweepAnalysis = analyzeSweepCandidates(setupCandles, levels, atr, config);
  const sequence = detectBestLiquiditySequence(setupCandles, sweepAnalysis.candidates, pivots, internalSwings, atr, config);
  const sweep = sequence?.sweep ?? null;
  const latestSweepInvalidation = sweepAnalysis.invalidations.at(-1) ?? null;
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
  if (!sweep) return waitDecision("WAITING_FOR_SWEEP", "Waiting for a valid liquidity sweep and close-back.", evaluations, flags, levels, htfBias);
  if (!sweepAcceptanceOk) return blockedDecision("SWEEP_ACCEPTANCE_INVALIDATION", "Price accepted beyond the liquidity level instead of rejecting it.", evaluations, flags);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "LEVEL_SELECTED", sweep.closedBackAt, `${sweep.level.type} ${sweep.level.side} zone selected at ${sweep.level.price.toFixed(2)}.`);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "SWEEP_CANDIDATE", sweep.sweptAt, `Price penetrated ${sweep.level.type} by ${sweep.distanceAtr.toFixed(2)} ATR.`);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "SWEEP_CONFIRMED", sweep.closedBackAt, "Sweep rejection confirmed by close-back-inside rule.");

  const direction: Direction = sequence?.direction ?? (sweep.level.side === "SELL_SIDE" ? "LONG" : "SHORT");
  const displacement = sequence?.displacement ?? null;
  push(evaluations, "DISPLACEMENT_CONFIRMED", `${direction === "LONG" ? "Bullish" : "Bearish"} displacement confirmed`, Boolean(displacement), true, "AUTOMATIC", displacement?.rangeAtr == null ? null : Number(displacement.rangeAtr.toFixed(2)), `>= ${config.minimumDisplacementRangeATR} ATR`, displacement ? "A strong directional candle appeared after the sweep." : "No strong displacement candle appeared after the sweep.");
  if (!displacement) return waitDecision("WAITING_FOR_DISPLACEMENT", "Sweep found. Waiting for displacement in the reversal direction.", evaluations, flags, levels, htfBias, sweep, direction);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "WAITING_FOR_CONFIRMATION", displacement.candle.timestampUtc, "Displacement confirmed; waiting for protected-structure break.");

  const bos = sequence?.bos ?? null;
  const structureType = bos?.subtype ?? (htfBias === "NEUTRAL"
    ? "REVERSAL_MSS"
    : htfBias === (direction === "LONG" ? "BULLISH" : "BEARISH") ? "CONTINUATION_BOS" : "REVERSAL_MSS");
  push(evaluations, "PROTECTED_POINT_CONFIDENCE", "Protected structure point has usable confidence", Boolean(bos?.protectedPoint && protectedConfidenceRank(bos.protectedPoint.confidence) >= protectedConfidenceRank(config.protectedPointMinimumConfidence)), true, "AUTOMATIC", bos?.protectedPoint?.confidence ?? null, `>= ${config.protectedPointMinimumConfidence}`, bos?.protectedPoint ? `${bos.protectedPoint.type} at ${bos.protectedPoint.price.toFixed(2)} selected with ${bos.protectedPoint.confidence} confidence.` : "No protected structure point is available yet.");
  push(evaluations, "BOS_CHOCH_CONFIRMED", `${structureType} confirmed by candle close`, Boolean(bos), true, "AUTOMATIC", bos?.level ?? null, `close beyond structure by ${config.minimumBosCloseDistanceATR} ATR`, bos ? `Candle body closed beyond the protected ${bos.protectedPoint?.type?.toLowerCase() ?? "structure point"}; classified ${structureType}.` : "No candle-close BOS/MSS has confirmed yet.");
  if (!bos) return waitDecision("WAITING_FOR_BOS", "Displacement found. Waiting for candle-close BOS/CHoCH.", evaluations, flags, levels, htfBias, sweep, direction);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "STRUCTURE_BREAK_CONFIRMED", bos.candle.timestampUtc, `${structureType} confirmed by candle close beyond protected structure.`);

  const currentIndex = setupCandles.length - 1;
  const fvg = sequence?.fvg ?? null;
  const orderBlock = sequence?.orderBlock ?? null;
  const zone = sequence?.zone ?? null;

  const setupFresh = currentIndex - bos.index <= config.maximumBarsAfterBosForEntry;
  if (!setupFresh) return blockedDecision("SETUP_TIMEOUT", "Module 2 setup expired before a valid candidate trade.", evaluations, { ...flags, levels, htfBias, sweep, displacement, bos, entryZone: zone }, direction);

  push(evaluations, "ENTRY_ZONE_READY", "Fresh entry zone ready", Boolean(zone), true, "AUTOMATIC", zone?.kind ?? null, "fresh FVG or order block", zone ? "A fresh imbalance/order-block zone is available for entry." : "No fresh FVG or order-block zone is available after BOS/CHoCH.");
  if (!zone) return waitDecision("WAITING_FOR_ENTRY_ZONE", "BOS/CHoCH is confirmed. Waiting for a fresh FVG/order-block entry zone.", evaluations, flags, levels, htfBias, sweep, direction, zone);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "ENTRY_ZONE_READY", zone.createdAt, `${zone.kind} entry zone prepared after structure break.`);

  const retrace = zone ? current.low <= zone.high && current.high >= zone.low : false;
  push(evaluations, "ENTRY_ZONE_RETRACE", "Price retraced into entry zone", retrace, true, "AUTOMATIC", retrace ? `${zone.low.toFixed(2)}-${zone.high.toFixed(2)}` : candleShape(current), "current candle overlaps entry zone", retrace ? "Price has returned into the selected entry zone." : "Price has not returned into the selected FVG/order-block zone yet.");
  if (!retrace) return waitDecision("WAITING_FOR_RETRACE", "Fresh entry zone is ready. Waiting for price to retrace into it before any paper entry.", evaluations, flags, levels, htfBias, sweep, direction, zone);
  flags.stateMachine = appendStateTransition(flags.stateMachine, "RETEST_REACHED", current.timestampUtc, "Price overlapped the selected entry zone.");

  const entryConfirmation = zone ? confirmsEntry(current, direction, zone) : confirmsDirectionalEntry(current, direction);
  const ema200Ok = ema200Aligned(biasCandles.length > 0 ? biasCandles : setupCandles, direction)
    && (!config.requireHtfBias || htfBias === (direction === "LONG" ? "BULLISH" : "BEARISH"));
  const sessionCandles = setupCandles.filter((candle) =>
    newYorkDateKey(candle.timestampUtc) === newYorkDateKey(current.timestampUtc)
      && newYorkMinutes(candle.timestampUtc) >= parseTime(config.newYorkStartTime)
  );
  const vwap = volumeWeightedAveragePrice(sessionCandles.length > 0 ? sessionCandles : setupCandles);
  const vwapRows = sessionCandles.length > 0 ? sessionCandles : setupCandles;
  const vwapVolumeCoverage = vwapRows.length > 0 ? vwapRows.filter((candle) => Number(candle.volume) > 0).length / vwapRows.length : 0;
  const vwapOk = vwapVolumeCoverage >= 0.8 && (direction === "LONG" ? current.close >= vwap : current.close <= vwap);
  const fvgOk = Boolean(fvg);
  const orderBlockRetestOk = Boolean(orderBlock && current.low <= orderBlock.high && current.high >= orderBlock.low);
  const confirmations = [
    { code: "CONFIRM_EMA_200", name: "15M structure and 200 EMA alignment", passed: ema200Ok, points: 15, actual: `${htfBias} / ${ema200Ok ? "aligned" : "not aligned"}`, required: `${direction === "LONG" ? "BULLISH" : "BEARISH"} 15M context`, explanation: ema200Ok ? "The completed 15M structure and EMA context align with the setup." : "The 15M structure/EMA context is neutral or opposes the setup." },
    { code: "CONFIRM_VWAP", name: "Session VWAP alignment", passed: vwapOk, points: 10, actual: `${current.close.toFixed(2)} / ${Math.round(vwapVolumeCoverage * 100)}% volume`, required: direction === "LONG" ? `>= ${vwap.toFixed(2)} with >=80% volume` : `<= ${vwap.toFixed(2)} with >=80% volume`, explanation: vwapOk ? "Price is aligned with a volume-backed session VWAP." : "Price is misaligned or provider volume is insufficient for true VWAP confirmation." },
    { code: "CONFIRM_FRESH_FVG", name: "Fresh Fair Value Gap", passed: fvgOk, points: 15, actual: fvg?.kind ?? null, required: "fresh FVG", explanation: fvgOk ? "A fresh FVG is available after displacement." : "No fresh FVG is available." },
    { code: "CONFIRM_ORDER_BLOCK_RETEST", name: "Order block retest", passed: orderBlockRetestOk, points: 10, actual: orderBlock ? `${orderBlock.low.toFixed(2)}-${orderBlock.high.toFixed(2)}` : null, required: "retest", explanation: orderBlockRetestOk ? "Price retested the detected order block." : "No order-block retest is confirmed." },
    { code: "CONFIRM_ENTRY_CANDLE", name: "Entry confirmation candle", passed: entryConfirmation, points: 10, actual: candleShape(current), required: "directional confirmation", explanation: entryConfirmation ? "The latest completed candle confirms the intended direction." : "The latest completed candle does not confirm entry." }
  ];
  for (const item of confirmations) {
    push(evaluations, item.code, item.name, item.passed, item.code === "CONFIRM_ENTRY_CANDLE", "AUTOMATIC", item.actual, item.required, `${item.explanation} (+${item.points})`);
  }
  const confirmationCount = confirmations.filter((item) => item.passed).length;
  const confirmationScore = confirmations.reduce((sum, item) => sum + (item.passed ? item.points : 0), 0);
  push(evaluations, "CONFIRMATION_COUNT", "Minimum confirmation rules matched", confirmationCount >= 3, true, "AUTOMATIC", confirmationCount, ">= 3 of 5", confirmationCount >= 3 ? "Minimum confirmation layer passed." : "Fewer than 3 confirmation rules matched.");

  const plan = buildLayeredTradePlan(setupCandles, levels, direction, sweep, zone, current, atr, config);
  const atrVolatilityOk = current.close > 0 && atr / current.close >= 0.00015;
  const rrOk = plan.rr >= config.minimumRiskReward;
  const quality = [
    { code: "QUALITY_ATR_VOLATILITY", name: "ATR volatility filter", passed: atrVolatilityOk, actual: `${((atr / current.close) * 100).toFixed(3)}%`, required: ">= 0.015%", explanation: atrVolatilityOk ? "ATR shows enough volatility for the setup." : "ATR volatility is too low." },
    { code: "QUALITY_SPREAD", name: "Spread filter", passed: spreadOk, blocking: true, actual: context.spread ?? "unknown", required: `<= ${config.maximumSpread}`, explanation: spreadOk ? "Spread is acceptable." : "Spread is above the configured maximum." },
    { code: "QUALITY_NEWS", name: "No high-impact news", passed: newsOk, blocking: true, actual: context.newsStatus ?? "CLEAR", required: "CLEAR", explanation: newsOk ? "No high-impact news block is active." : "High-impact news filter is blocking the setup." },
    { code: "QUALITY_RR", name: "Minimum RR 2:1", passed: rrOk, blocking: true, actual: Number(plan.rr.toFixed(2)), required: `>= ${config.minimumRiskReward}`, explanation: rrOk ? "Reward-to-risk meets the minimum." : "Reward-to-risk is below the minimum." },
    { code: "QUALITY_STOP_SIZE", name: "Maximum stop-loss size", passed: plan.stopValid, blocking: true, actual: Number(plan.stopDistanceAtr.toFixed(2)), required: `<= ${config.maximumStopATR} ATR`, explanation: plan.stopValid ? "Stop size is acceptable." : "Stop size is too large." },
    { code: "QUALITY_FRESH_SETUP", name: "Fresh setup", passed: setupFresh, actual: currentIndex - bos.index, required: `<= ${config.maximumBarsAfterBosForEntry} candles after BOS`, explanation: setupFresh ? "Setup is still fresh." : "Setup is stale." }
  ];
  for (const item of quality) {
    push(evaluations, item.code, item.name, item.passed, "blocking" in item ? Boolean(item.blocking) : false, "AUTOMATIC", item.actual, item.required, item.explanation);
  }
  const qualityCount = quality.filter((item) => item.passed).length;
  push(evaluations, "QUALITY_FILTER_COUNT", "Minimum quality filters matched", qualityCount >= 3, true, "AUTOMATIC", qualityCount, ">= 3", qualityCount >= 3 ? "Minimum quality layer passed." : "Fewer than 3 quality filters passed.");

  const gradeValue = tradeGrade(confirmationCount, qualityCount);
  const score = Math.min(100, Math.round(40 + confirmationScore + (qualityCount / quality.length) * 20));
  const scoreOk = score >= config.minimumSignalScore;
  push(evaluations, "SIGNAL_SCORE", "Minimum signal score", scoreOk, true, "AUTOMATIC", score, `>= ${config.minimumSignalScore}`, scoreOk ? "Module 2 signal score is high enough for automatic paper entry." : "Module 2 signal score is below the automatic paper-entry threshold.");
  const mandatoryEntryPassed = module2MandatoryEntryPassed(evaluations);
  const fullChecklistPassed = evaluations.filter((item) => item.blocking).every((item) => item.status === "PASS");
  flags.levels = levels;
  flags.htfBias = htfBias;
  flags.vwap = vwap;
  flags.vwapVolumeCoverage = vwapVolumeCoverage;
  flags.sweep = sweep;
  flags.displacement = displacement;
  flags.bos = bos ? { ...bos, structureType } : null;
  flags.protectedPoint = bos?.protectedPoint ?? null;
  flags.entryZone = zone;
  flags.confirmationLayer = { count: confirmationCount, required: 3, score: confirmationScore, rules: confirmations };
  flags.qualityLayer = { count: qualityCount, required: 3, rules: quality };
  flags.tradeGrade = gradeValue;
  flags.confidence = score;
  flags.mandatoryChecklistMatched = mandatoryEntryPassed;
  flags.fullChecklistMatched = fullChecklistPassed;
  flags.setupTier = fullChecklistPassed && gradeValue !== "B" && gradeValue !== "C" ? "FULL" : mandatoryEntryPassed ? "MANDATORY" : "WATCH";
  flags.state = mandatoryEntryPassed ? "SIGNAL_ACTIVE" : "ENTRY_CONFIRMATION";
  flags.riskReward = plan.rr;
  flags.stateMachine = appendStateTransition(flags.stateMachine, mandatoryEntryPassed ? "ENTRY_READY" : "RETEST_REACHED", current.timestampUtc, mandatoryEntryPassed ? "Risk and checklist gates produced setup-ready decision." : "Retest happened but entry gates are still waiting or blocked.");

  if (!mandatoryEntryPassed) {
    if (!entryConfirmation) {
      return {
        scenario: "WAITING_FOR_ENTRY_CONFIRMATION",
        direction,
        status: "WAIT",
        state: "ENTRY_CONFIRMATION",
        finalReason: `Entry zone was reached after sweep, displacement, and BOS/CHoCH. Waiting for a valid ${direction} confirmation candle before any paper entry. Confirmations ${confirmationCount}/5, quality ${qualityCount}/6.`,
        evaluations,
        scenarioFlags: flags,
        favorabilityScore: score,
        favorabilityGrade: gradeValue,
        favorabilityReasons: [
          "Sweep, displacement, BOS/CHoCH, and entry zone are candidate evidence only.",
          "No trade is valid until the confirmation candle closes in the setup direction."
        ]
      };
    }
    return blockedDecision("LAYERED_RULE_FAILED", `NO TRADE: mandatory entry rules are not fully matched yet. Confirmations ${confirmationCount}/5, quality ${qualityCount}/6.`, evaluations, flags, direction, score);
  }

  if (!fullChecklistPassed || gradeValue === "B" || gradeValue === "C") {
    return {
      scenario: direction === "LONG" ? "MANDATORY_LIQUIDITY_SWEEP_BOS_BUY" : "MANDATORY_LIQUIDITY_SWEEP_BOS_SELL",
      direction,
      status: direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY",
      state: "SIGNAL_ACTIVE",
      entryPrice: plan.entry,
      stopPrice: plan.stop,
      targetPrice: plan.target,
      finalReason: `Mandatory Module 2 entry checklist passed. Small paper setup created while full confirmations continue. Confirmations ${confirmationCount}/5, quality ${qualityCount}/6, confidence ${score}%.`,
      evaluations,
      scenarioFlags: flags,
      favorabilityScore: score,
      favorabilityGrade: gradeValue,
      favorabilityReasons: reasonList(score, sweep.level, htfBias, fvg, orderBlock, plan.rr, confirmationCount, qualityCount)
    };
  }

  return {
    scenario: direction === "LONG" ? "NY_LIQUIDITY_SWEEP_BOS_BUY" : "NY_LIQUIDITY_SWEEP_BOS_SELL",
    direction,
    status: direction === "LONG" ? "LONG SETUP READY" : "SHORT SETUP READY",
    state: "SIGNAL_ACTIVE",
    entryPrice: plan.entry,
    stopPrice: plan.stop,
    targetPrice: plan.target,
    finalReason: `Trade Grade ${gradeValue}: ${direction === "LONG" ? "BUY" : "SELL"} candidate passed hard rules, ${confirmationCount}/5 confirmations, and ${qualityCount}/6 quality filters. Confidence ${score}%.`,
    evaluations,
    scenarioFlags: flags,
    favorabilityScore: score,
    favorabilityGrade: gradeValue,
    favorabilityReasons: reasonList(score, sweep.level, htfBias, fvg, orderBlock, plan.rr, confirmationCount, qualityCount)
  };
}

function module2MandatoryEntryPassed(evaluations: RuleEvaluation[]) {
  const required = new Set([
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "DISPLACEMENT_CONFIRMED",
    "PROTECTED_POINT_CONFIDENCE",
    "BOS_CHOCH_CONFIRMED",
    "ENTRY_ZONE_READY",
    "ENTRY_ZONE_RETRACE",
    "CONFIRM_ENTRY_CANDLE"
  ]);
  return [...required].every((ruleCode) =>
    evaluations.some((evaluation) => evaluation.ruleCode === ruleCode && evaluation.status === "PASS")
  );
}

function module2RuleLayer(ruleCode: string): Pick<RuleEvaluation, "ruleLayer" | "requiredForEntry"> {
  const mandatory = new Set([
    "NY_SESSION_ACTIVE",
    "DAILY_TRADE_LIMIT",
    "LIQUIDITY_LEVEL_IDENTIFIED",
    "LIQUIDITY_SWEEP_CONFIRMED",
    "SWEEP_REJECTION_CONFIRMED",
    "SWEEP_ACCEPTANCE_BLOCK",
    "DISPLACEMENT_CONFIRMED",
    "PROTECTED_POINT_CONFIDENCE",
    "BOS_CHOCH_CONFIRMED",
    "ENTRY_ZONE_READY",
    "ENTRY_ZONE_RETRACE",
    "CONFIRM_ENTRY_CANDLE"
  ]);
  const confirmations = new Set(["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRMATION_COUNT"]);
  const quality = new Set(["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT"]);
  if (mandatory.has(ruleCode)) return { ruleLayer: "MANDATORY", requiredForEntry: true };
  if (ruleCode === "PROTECTED_POINT_CONFIDENCE") return { ruleLayer: "MANDATORY", requiredForEntry: true };
  if (confirmations.has(ruleCode)) return { ruleLayer: "CONFIRMATION", requiredForEntry: ruleCode === "CONFIRMATION_COUNT" };
  if (quality.has(ruleCode)) return { ruleLayer: "QUALITY", requiredForEntry: ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FILTER_COUNT"].includes(ruleCode) };
  if (ruleCode === "SIGNAL_SCORE") return { ruleLayer: "FINAL", requiredForEntry: false };
  return { ruleLayer: "EVIDENCE", requiredForEntry: false };
}

function normalizeCandles(candles: Candle[]) {
  return candles
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
}

function detectLiquidityLevels(candles: Candle[], now: string, atr: number, config: LiquiditySweepConfig): LiquidityLevel[] {
  const currentDate = newYorkDateKey(now);
  const priorDates = [...new Set(candles.map((candle) => newYorkDateKey(candle.timestampUtc)).filter((date) => date < currentDate))].sort();
  const previousCalendarDate = priorDates.at(-1);
  const previousTradingDate = [...priorDates].reverse().find((date) => !isWeekendDateKey(date));
  const previousDay = previousTradingDate ? candles.filter((candle) => newYorkDateKey(candle.timestampUtc) === previousTradingDate) : [];
  const preSession = candles.filter((candle) => {
    const date = newYorkDateKey(candle.timestampUtc);
    const minute = newYorkMinutes(candle.timestampUtc);
    return date < currentDate || (date === currentDate && minute < parseTime(config.newYorkStartTime));
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
  addRangeLevels(levels, previousDay, "PREVIOUS_DAY_HIGH", "PREVIOUS_DAY_LOW", "HIGH");
  addRangeLevels(levels, asian, "ASIAN_HIGH", "ASIAN_LOW", "MEDIUM");
  addRangeLevels(levels, london, "LONDON_HIGH", "LONDON_LOW", "HIGH");
  const pivots = detectPivots(preSession, 2, 2).slice(-18);
  addEqualHighLowLevels(levels, pivots, atr);
  return dedupeLevels(levels.map((level) => liquidityZone(level, atr, config)));
}

function addRangeLevels(levels: LiquidityLevel[], candles: Candle[], highType: LiquidityLevelType, lowType: LiquidityLevelType, priority: LiquidityLevel["priority"]) {
  if (candles.length === 0) return;
  levels.push({ type: highType, side: "BUY_SIDE", price: Math.max(...candles.map((candle) => candle.high)), priority, priorityScore: levelPriorityScore(highType, priority), source: highType, touchCount: 1, clusterSize: 1, status: "ACTIVE" });
  levels.push({ type: lowType, side: "SELL_SIDE", price: Math.min(...candles.map((candle) => candle.low)), priority, priorityScore: levelPriorityScore(lowType, priority), source: lowType, touchCount: 1, clusterSize: 1, status: "ACTIVE" });
}

function liquidityZone(level: LiquidityLevel, atr: number, config: LiquiditySweepConfig): LiquidityLevel {
  const zoneHalfWidth = Math.max(0.01, atr * config.zoneToleranceATR);
  return {
    ...level,
    lowerBound: level.price - zoneHalfWidth,
    upperBound: level.price + zoneHalfWidth,
    zoneHalfWidth,
    priorityScore: level.priorityScore ?? levelPriorityScore(level.type, level.priority),
    status: level.status ?? "ACTIVE"
  };
}

function levelPriorityScore(type: LiquidityLevelType, priority: LiquidityLevel["priority"]) {
  const typeScores: Record<LiquidityLevelType, number> = {
    PREVIOUS_DAY_HIGH: 95,
    PREVIOUS_DAY_LOW: 95,
    LONDON_HIGH: 85,
    LONDON_LOW: 85,
    ASIAN_HIGH: 80,
    ASIAN_LOW: 80,
    EQUAL_HIGH: 70,
    EQUAL_LOW: 70,
    SWING_HIGH: 45,
    SWING_LOW: 45
  };
  return typeScores[type] ?? priorityScore(priority) * 10;
}

function detectBestLiquiditySequence(candles: Candle[], sweeps: SweepCandidate[], pivots: ReturnType<typeof detectPivots>, swings: SwingPoint[], atr: number, config: LiquiditySweepConfig) {
  const currentIndex = candles.length - 1;
  const sequences = sweeps.map((sweep) => {
    const direction: Direction = sweep.level.side === "SELL_SIDE" ? "LONG" : "SHORT";
    const displacement = detectDisplacement(candles, sweep.index, direction, atr, config);
    const bos = displacement ? detectBos(candles, sweep.index, displacement.index, direction, pivots, swings, atr, config) : null;
    const fvg = displacement ? detectFreshFvg(candles, sweep.index, displacement.index, direction, atr, config) : null;
    const orderBlock = displacement ? detectOrderBlock(candles, displacement.index, direction, atr) : null;
    const zone = bos ? selectFreshEntryZone(candles, currentIndex, direction, fvg, orderBlock) : null;
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

function analyzeSweepCandidates(candles: Candle[], levels: LiquidityLevel[], atr: number, config: LiquiditySweepConfig) {
  const candidates: SweepCandidate[] = [];
  const invalidations: SweepInvalidation[] = [];
  for (let index = candles.length - 1; index >= Math.max(0, candles.length - config.maximumSweepLookbackBars - config.closeBackMaximumBars); index -= 1) {
    const candle = candles[index];
    if (!isInsideNewYorkWindow(candle.timestampUtc, config.newYorkStartTime, config.newYorkEndTime)) continue;
    for (const level of levels) {
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
  const structure = protectedPoint
    ? { index: protectedPoint.candleIndex, kind: protectedPoint.type, price: protectedPoint.price, time: protectedPoint.formedAt }
    : [...pivots]
        .reverse()
        .find((pivot) => pivot.index < sweepIndex && (direction === "LONG" ? pivot.kind === "HIGH" : pivot.kind === "LOW"));
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
      const subtype = protectedPoint ? "REVERSAL_MSS" : "CONTINUATION_BOS";
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

function buildTradePlan(candles: Candle[], levels: LiquidityLevel[], direction: Direction, sweep: SweepCandidate, zone: { midpoint: number; low: number; high: number }, current: Candle, atr: number, config: LiquiditySweepConfig) {
  const entry = current.close;
  const stop = direction === "LONG" ? Math.min(sweep.candle.low, zone.low) - atr * config.stopBufferATR : Math.max(sweep.candle.high, zone.high) + atr * config.stopBufferATR;
  const targets = levels
    .filter((level) => direction === "LONG" ? level.side === "BUY_SIDE" && level.price > entry : level.side === "SELL_SIDE" && level.price < entry)
    .sort((left, right) => direction === "LONG" ? left.price - right.price : right.price - left.price);
  const fallback = direction === "LONG" ? entry + Math.abs(entry - stop) * config.minimumRiskReward : entry - Math.abs(entry - stop) * config.minimumRiskReward;
  const target = targets[0]?.price ?? fallback;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const stopDistanceAtr = atr > 0 ? risk / atr : 999;
  return { entry, stop, target, rr, stopValid: stopDistanceAtr <= config.maximumStopATR, stopDistanceAtr };
}

function buildLayeredTradePlan(
  candles: Candle[],
  levels: LiquidityLevel[],
  direction: Direction,
  sweep: SweepCandidate,
  zone: ReturnType<typeof selectFreshEntryZone>,
  current: Candle,
  atr: number,
  config: LiquiditySweepConfig
) {
  if (zone) return buildTradePlan(candles, levels, direction, sweep, zone, current, atr, config);
  const entry = current.close;
  const stop = direction === "LONG" ? sweep.candle.low - atr * config.stopBufferATR : sweep.candle.high + atr * config.stopBufferATR;
  const targets = levels
    .filter((level) => direction === "LONG" ? level.side === "BUY_SIDE" && level.price > entry : level.side === "SELL_SIDE" && level.price < entry)
    .sort((left, right) => direction === "LONG" ? left.price - right.price : right.price - left.price);
  const fallback = direction === "LONG" ? entry + Math.abs(entry - stop) * config.minimumRiskReward : entry - Math.abs(entry - stop) * config.minimumRiskReward;
  const target = targets[0]?.price ?? fallback;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  const stopDistanceAtr = atr > 0 ? risk / atr : 999;
  return { entry, stop, target, rr, stopValid: stopDistanceAtr <= config.maximumStopATR, stopDistanceAtr };
}

function confirmsEntry(candle: Candle, direction: Direction, zone: { low: number; high: number; midpoint: number }) {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  if (direction === "LONG") return candle.close > zone.midpoint && (candle.close > candle.open || lowerWick / range >= 0.35);
  return candle.close < zone.midpoint && (candle.close < candle.open || upperWick / range >= 0.35);
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
    const confirmedAt = candles[pivot.index + right]?.timestampUtc ?? pivot.time;
    swings.push({
      id: `${timeframe}-${pivot.kind}-${pivot.index}-${pivot.time}`,
      type: pivot.kind,
      price: pivot.price,
      candleIndex: pivot.index,
      formedAt: pivot.time,
      confirmedAt,
      timeframe,
      prominence,
      prominenceAtr,
      strengthScore: Math.min(100, Math.round(40 + prominenceAtr * 60)),
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
    const window = candles.slice(index - left, index + right + 1);
    const candle = candles[index];
    if (candle.high === Math.max(...window.map((item) => item.high))) pivots.push({ index, kind: "HIGH", price: candle.high, time: candle.timestampUtc });
    if (candle.low === Math.min(...window.map((item) => item.low))) pivots.push({ index, kind: "LOW", price: candle.low, time: candle.timestampUtc });
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

function addEqualHighLowLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>, atr: number) {
  const tolerance = Math.max(0.05, atr * 0.05);
  addEqualLevels(levels, pivots.filter((pivot) => pivot.kind === "HIGH"), "EQUAL_HIGH", "BUY_SIDE", tolerance);
  addEqualLevels(levels, pivots.filter((pivot) => pivot.kind === "LOW"), "EQUAL_LOW", "SELL_SIDE", tolerance);
}

function addEqualLevels(levels: LiquidityLevel[], pivots: ReturnType<typeof detectPivots>, type: LiquidityLevelType, side: LiquidityLevel["side"], tolerance: number) {
  for (let index = 0; index < pivots.length; index += 1) {
    const cluster = pivots.filter((pivot, otherIndex) => otherIndex !== index && Math.abs(pivot.price - pivots[index].price) <= tolerance);
    if (cluster.length === 0) continue;
    const prices = [pivots[index], ...cluster].map((pivot) => pivot.price);
    levels.push({
      type,
      side,
      price: side === "BUY_SIDE" ? Math.max(...prices) : Math.min(...prices),
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
    `${confirmationCount}/5 confirmations matched`,
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
  return {
    scenario,
    direction: direction ?? null,
    status: "WAIT",
    state: stateFromScenario(scenario),
    finalReason: reason,
    evaluations,
    scenarioFlags: { ...flags, levels, htfBias, sweep, entryZone: zone, state: stateFromScenario(scenario) },
    favorabilityScore: 0,
    favorabilityGrade: "D",
    favorabilityReasons: [reason]
  };
}

function blockedDecision(scenario: string, reason: string, evaluations: RuleEvaluation[], flags: Record<string, unknown>, direction?: Direction | null, score = 0): LiquiditySweepDecision {
  return {
    scenario,
    direction: direction ?? null,
    status: scenario.includes("BLOCK") ? "BLOCKED" : "NO TRADE",
    state: "INVALIDATED",
    finalReason: reason,
    evaluations,
    scenarioFlags: { ...flags, state: "INVALIDATED", invalidationReason: reason },
    favorabilityScore: score,
    favorabilityGrade: grade(score),
    favorabilityReasons: [reason]
  };
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
  if (scenario.includes("WAITING_FOR_RETRACE")) return "WAITING_FOR_RETRACE";
  if (scenario.includes("ENTRY_CONFIRMATION")) return "ENTRY_CONFIRMATION";
  if (scenario.includes("ENTRY_ZONE_READY")) return "ENTRY_ZONE_READY";
  if (scenario.includes("SWEEP")) return "LEVEL_APPROACH";
  if (scenario.includes("DISPLACEMENT")) return "SWEEP_DETECTED";
  if (scenario.includes("BOS")) return "DISPLACEMENT_CONFIRMED";
  if (scenario.includes("ENTRY_ZONE")) return "BOS_CONFIRMED";
  return "IDLE";
}
