import type { Candle, Direction, RuleEvaluation } from "@orb-guide/shared-types";

export type LiquiditySweepState =
  | "IDLE"
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
  priority: "HIGH" | "MEDIUM" | "LOW";
  source: string;
};

export type LiquiditySweepConfig = {
  timezone: string;
  newYorkStartTime: string;
  newYorkEndTime: string;
  maximumTradesPerSession: number;
  minimumSweepDistanceATR: number;
  maximumSweepDistanceATR: number;
  closeBackMaximumBars: number;
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

const DEFAULT_CONFIG: LiquiditySweepConfig = {
  timezone: "America/New_York",
  newYorkStartTime: "09:30",
  newYorkEndTime: "16:00",
  maximumTradesPerSession: 1,
  minimumSweepDistanceATR: 0.1,
  maximumSweepDistanceATR: 1,
  closeBackMaximumBars: 3,
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
  const htfBias = detectBias(biasCandles);
  const levels = detectLiquidityLevels(setupCandles, current.timestampUtc, atr);
  const pivots = detectPivots(setupCandles, config.pivotLeftBars, config.pivotRightBars);
  const sessionActive = isInsideNewYorkWindow(current.timestampUtc, config.newYorkStartTime, config.newYorkEndTime);
  const spreadOk = context.spread == null || context.spread <= config.maximumSpread;
  const newsOk = !config.enableNewsFilter || !String(context.newsStatus ?? "CLEAR").includes("BLOCKED");
  const tradeLimitOk = (context.tradesTakenThisSession ?? 0) < config.maximumTradesPerSession;

  push(evaluations, "NY_SESSION_ACTIVE", "New York session active", sessionActive, true, "AUTOMATIC", timeOnly(current.timestampUtc), `${config.newYorkStartTime}-${config.newYorkEndTime}`, sessionActive ? "Current candle is inside the configured New York sweep window." : "No Module 2 signal is allowed outside the configured New York window.");
  push(evaluations, "DAILY_TRADE_LIMIT", "Daily trade limit not reached", tradeLimitOk, true, "AUTOMATIC", context.tradesTakenThisSession ?? 0, `< ${config.maximumTradesPerSession}`, tradeLimitOk ? "Session trade limit allows another paper setup." : "The configured session trade limit has already been reached.");

  if (!sessionActive || !tradeLimitOk) {
    return blockedDecision("HARD_RULE_BLOCK", "Module 2 hard rules failed before liquidity evaluation.", evaluations, flags);
  }

  const sweep = detectLatestSweep(setupCandles, levels, atr, config);
  push(evaluations, "LIQUIDITY_LEVEL_IDENTIFIED", "Meaningful liquidity level identified", Boolean(sweep?.level), true, "AUTOMATIC", sweep?.level?.type ?? null, "PDH/PDL, Asian, London, equal high/low", sweep?.level ? `${sweep.level.type} at ${sweep.level.price.toFixed(2)} was selected.` : "No valid liquidity level has been swept.");
  push(evaluations, "LIQUIDITY_SWEEP_CONFIRMED", "Liquidity sweep confirmed", Boolean(sweep), true, "AUTOMATIC", sweep?.distanceAtr == null ? null : Number(sweep.distanceAtr.toFixed(2)), `${config.minimumSweepDistanceATR}-${config.maximumSweepDistanceATR} ATR`, sweep ? "Price traded beyond liquidity and closed back through the level within the allowed candles." : "No valid close-back sweep has been confirmed.");
  if (!sweep) return waitDecision("WAITING_FOR_SWEEP", "Waiting for a valid liquidity sweep and close-back.", evaluations, flags, levels, htfBias);

  const direction: Direction = sweep.level.side === "SELL_SIDE" ? "LONG" : "SHORT";
  const displacement = detectDisplacement(setupCandles, sweep.index, direction, atr, config);
  push(evaluations, "DISPLACEMENT_CONFIRMED", `${direction === "LONG" ? "Bullish" : "Bearish"} displacement confirmed`, Boolean(displacement), true, "AUTOMATIC", displacement?.rangeAtr == null ? null : Number(displacement.rangeAtr.toFixed(2)), `>= ${config.minimumDisplacementRangeATR} ATR`, displacement ? "A strong directional candle appeared after the sweep." : "No strong displacement candle appeared after the sweep.");
  if (!displacement) return waitDecision("WAITING_FOR_DISPLACEMENT", "Sweep found. Waiting for displacement in the reversal direction.", evaluations, flags, levels, htfBias, sweep, direction);

  const bos = detectBos(setupCandles, sweep.index, displacement.index, direction, pivots, atr, config);
  push(evaluations, "BOS_CHOCH_CONFIRMED", "BOS or CHoCH confirmed by close", Boolean(bos), true, "AUTOMATIC", bos?.level ?? null, `close beyond structure by ${config.minimumBosCloseDistanceATR} ATR`, bos ? "Candle body closed beyond the selected internal structure point." : "No candle-close BOS/CHoCH has confirmed yet.");
  if (!bos) return waitDecision("WAITING_FOR_BOS", "Displacement found. Waiting for candle-close BOS/CHoCH.", evaluations, flags, levels, htfBias, sweep, direction);

  const currentIndex = setupCandles.length - 1;
  const fvg = detectFreshFvg(setupCandles, sweep.index, displacement.index, direction, atr, config);
  const orderBlock = detectOrderBlock(setupCandles, displacement.index, direction, atr);
  const zone = selectFreshEntryZone(setupCandles, currentIndex, direction, fvg, orderBlock);

  const setupFresh = currentIndex - bos.index <= config.maximumBarsAfterBosForEntry;
  if (!setupFresh) return blockedDecision("SETUP_TIMEOUT", "Module 2 setup expired before a valid candidate trade.", evaluations, { ...flags, levels, htfBias, sweep, displacement, bos, entryZone: zone }, direction);

  push(evaluations, "ENTRY_ZONE_READY", "Fresh entry zone ready", Boolean(zone), true, "AUTOMATIC", zone?.kind ?? null, "fresh FVG or order block", zone ? "A fresh imbalance/order-block zone is available for entry." : "No fresh FVG or order-block zone is available after BOS/CHoCH.");
  if (!zone) return waitDecision("WAITING_FOR_ENTRY_ZONE", "BOS/CHoCH is confirmed. Waiting for a fresh FVG/order-block entry zone.", evaluations, flags, levels, htfBias, sweep, direction, zone);

  const retrace = zone ? current.low <= zone.high && current.high >= zone.low : false;
  push(evaluations, "ENTRY_ZONE_RETRACE", "Price retraced into entry zone", retrace, true, "AUTOMATIC", retrace ? `${zone.low.toFixed(2)}-${zone.high.toFixed(2)}` : candleShape(current), "current candle overlaps entry zone", retrace ? "Price has returned into the selected entry zone." : "Price has not returned into the selected FVG/order-block zone yet.");
  if (!retrace) return waitDecision("WAITING_FOR_RETRACE", "Fresh entry zone is ready. Waiting for price to retrace into it before any paper entry.", evaluations, flags, levels, htfBias, sweep, direction, zone);

  const entryConfirmation = zone ? confirmsEntry(current, direction, zone) : confirmsDirectionalEntry(current, direction);
  const ema200Ok = ema200Aligned(biasCandles.length > 0 ? biasCandles : setupCandles, direction);
  const vwap = volumeWeightedAveragePrice(setupCandles);
  const vwapOk = direction === "LONG" ? current.close >= vwap : current.close <= vwap;
  const fvgOk = Boolean(fvg);
  const orderBlockRetestOk = Boolean(orderBlock && current.low <= orderBlock.high && current.high >= orderBlock.low);
  const confirmations = [
    { code: "CONFIRM_EMA_200", name: "200 EMA trend alignment", passed: ema200Ok, points: 15, actual: ema200Ok ? "aligned" : "not aligned", required: "aligned", explanation: ema200Ok ? "Price and trend context align with the 200 EMA." : "Price/trend context is not aligned with the 200 EMA." },
    { code: "CONFIRM_VWAP", name: "VWAP alignment", passed: vwapOk, points: 10, actual: current.close.toFixed(2), required: direction === "LONG" ? `>= ${vwap.toFixed(2)}` : `<= ${vwap.toFixed(2)}`, explanation: vwapOk ? "Price is aligned with session VWAP." : "Price is not aligned with session VWAP." },
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
  const mandatoryPassed = evaluations.filter((item) => item.blocking).every((item) => item.status === "PASS");
  flags.levels = levels;
  flags.htfBias = htfBias;
  flags.sweep = sweep;
  flags.displacement = displacement;
  flags.bos = bos;
  flags.entryZone = zone;
  flags.confirmationLayer = { count: confirmationCount, required: 3, score: confirmationScore, rules: confirmations };
  flags.qualityLayer = { count: qualityCount, required: 3, rules: quality };
  flags.tradeGrade = gradeValue;
  flags.confidence = score;
  flags.state = mandatoryPassed ? "SIGNAL_ACTIVE" : "ENTRY_CONFIRMATION";
  flags.riskReward = plan.rr;

  if (!mandatoryPassed) {
    return blockedDecision("LAYERED_RULE_FAILED", `NO TRADE: hard rules passed, but confirmation/quality requirements failed. Confirmations ${confirmationCount}/5, quality ${qualityCount}/6.`, evaluations, flags, direction, score);
  }

  if (gradeValue === "B" || gradeValue === "C") {
    return blockedDecision(`${gradeValue}_GRADE_NO_TRADE`, `NO TRADE: Trade grade ${gradeValue}. Automatic Module 2 entries require at least 3 confirmations and 3 quality filters, producing A/A+ readiness.`, evaluations, flags, direction, score);
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

function normalizeCandles(candles: Candle[]) {
  return candles
    .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
}

function detectLiquidityLevels(candles: Candle[], now: string, atr: number): LiquidityLevel[] {
  const nowDate = new Date(now);
  const previousDay = candles.filter((candle) => new Date(candle.timestampUtc).toISOString().slice(0, 10) < nowDate.toISOString().slice(0, 10));
  const today = candles.filter((candle) => new Date(candle.timestampUtc).toISOString().slice(0, 10) === nowDate.toISOString().slice(0, 10));
  const asian = today.filter((candle) => hourUtc(candle.timestampUtc) >= 0 && hourUtc(candle.timestampUtc) < 7);
  const london = today.filter((candle) => hourUtc(candle.timestampUtc) >= 7 && hourUtc(candle.timestampUtc) < 13);
  const levels: LiquidityLevel[] = [];
  addRangeLevels(levels, previousDay, "PREVIOUS_DAY_HIGH", "PREVIOUS_DAY_LOW", "HIGH");
  addRangeLevels(levels, asian, "ASIAN_HIGH", "ASIAN_LOW", "MEDIUM");
  addRangeLevels(levels, london, "LONDON_HIGH", "LONDON_LOW", "HIGH");
  const pivots = detectPivots(candles, 2, 2).slice(-18);
  addEqualHighLowLevels(levels, pivots, atr);
  return dedupeLevels(levels);
}

function addRangeLevels(levels: LiquidityLevel[], candles: Candle[], highType: LiquidityLevelType, lowType: LiquidityLevelType, priority: LiquidityLevel["priority"]) {
  if (candles.length === 0) return;
  levels.push({ type: highType, side: "BUY_SIDE", price: Math.max(...candles.map((candle) => candle.high)), priority, source: highType });
  levels.push({ type: lowType, side: "SELL_SIDE", price: Math.min(...candles.map((candle) => candle.low)), priority, source: lowType });
}

function detectLatestSweep(candles: Candle[], levels: LiquidityLevel[], atr: number, config: LiquiditySweepConfig) {
  for (let index = candles.length - 1; index >= Math.max(0, candles.length - 12 - config.closeBackMaximumBars); index -= 1) {
    const candle = candles[index];
    for (const level of levels) {
      const penetration = level.side === "SELL_SIDE" ? level.price - candle.low : candle.high - level.price;
      const distanceAtr = atr > 0 ? penetration / atr : 0;
      if (penetration <= 0 || distanceAtr < config.minimumSweepDistanceATR || distanceAtr > config.maximumSweepDistanceATR) continue;
      const closeBackEnd = Math.min(candles.length - 1, index + config.closeBackMaximumBars);
      for (let closeIndex = index; closeIndex <= closeBackEnd; closeIndex += 1) {
        const closeBackCandle = candles[closeIndex];
        const closedBack = level.side === "SELL_SIDE" ? closeBackCandle.close > level.price : closeBackCandle.close < level.price;
        if (closedBack) {
          return { index: closeIndex, sweepIndex: index, level, candle, closeBackCandle, distanceAtr, sweptAt: candle.timestampUtc, closedBackAt: closeBackCandle.timestampUtc };
        }
      }
    }
  }
  return null;
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

function detectBos(candles: Candle[], sweepIndex: number, displacementIndex: number, direction: Direction, pivots: ReturnType<typeof detectPivots>, atr: number, config: LiquiditySweepConfig) {
  const structure = [...pivots]
    .reverse()
    .find((pivot) => pivot.index < sweepIndex && (direction === "LONG" ? pivot.kind === "HIGH" : pivot.kind === "LOW"));
  if (!structure) return null;
  const end = Math.min(candles.length - 1, sweepIndex + config.maximumBarsAfterSweepForBos);
  for (let index = displacementIndex; index <= end; index += 1) {
    const candle = candles[index];
    const threshold = config.minimumBosCloseDistanceATR * atr;
    const broken = direction === "LONG" ? candle.close > structure.price + threshold : candle.close < structure.price - threshold;
    if (broken) return { index, level: structure.price, candle, structure };
  }
  return null;
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

function buildTradePlan(candles: Candle[], levels: LiquidityLevel[], direction: Direction, sweep: NonNullable<ReturnType<typeof detectLatestSweep>>, zone: { midpoint: number; low: number; high: number }, atr: number, config: LiquiditySweepConfig) {
  const entry = zone.midpoint;
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
  sweep: NonNullable<ReturnType<typeof detectLatestSweep>>,
  zone: ReturnType<typeof selectFreshEntryZone>,
  current: Candle,
  atr: number,
  config: LiquiditySweepConfig
) {
  if (zone) return buildTradePlan(candles, levels, direction, sweep, zone, atr, config);
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

function hourUtc(timestamp: string) {
  return new Date(timestamp).getUTCHours();
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
  const tolerance = Math.max(0.05, atr * 0.1);
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
      price: prices.reduce((sum, value) => sum + value, 0) / prices.length,
      priority: "MEDIUM",
      source: `${type} cluster`
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
