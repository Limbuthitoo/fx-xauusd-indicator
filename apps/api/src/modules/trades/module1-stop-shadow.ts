import { buildLiquidityAwareStop } from "@orb-guide/strategy-engine";

export const MODULE1_STOP_SHADOW_MINIMUM_SIGNALS = 30;
export const MODULE1_STOP_SHADOW_MAXIMUM_STOP_ATR = 3;

export type Module1StopShadowCandidate = {
  code: "BASELINE_CURRENT" | "STRUCTURAL_ATR_2_25" | "STRUCTURAL_ATR_2_50" | "SWING_BUFFER_0_50" | "MAX_STOP_3_ATR";
  label: string;
  entry: number;
  stop: number;
  target: number;
  riskDistance: number;
  stopDistanceAtr: number | null;
  minimumStopAtr: number;
  liquidityBufferAtr: number;
  tradeAccepted: boolean;
  rejectionReason: string | null;
};

export type Module1StopShadowState = {
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  riskDistance: number;
  targetHitIndex: number;
  realizedR: number;
  remainingFraction: number;
  maximumFavorableExcursionR: number;
  maximumAdverseExcursionR: number;
  observationUntil: string | Date;
};

export type Module1StopShadowCandle = {
  timestampUtc: string;
  high: number;
  low: number;
  close: number;
};

export function buildModule1StopShadowCandidates(input: {
  direction: "LONG" | "SHORT";
  entry: number;
  baselineStop: number;
  structuralInvalidation: number;
  atr: number | null;
  spread?: number | null;
  baselineMinimumStopAtr?: number | null;
  baselineLiquidityBufferAtr?: number | null;
}) {
  const baselineRisk = Math.abs(input.entry - input.baselineStop);
  if (![input.entry, input.baselineStop, baselineRisk].every(Number.isFinite) || baselineRisk <= 0) return [];
  const atr = Number.isFinite(input.atr) && Number(input.atr) > 0 ? Number(input.atr) : null;
  const baselineStopAtr = atr == null ? null : baselineRisk / atr;
  const directionFactor = input.direction === "LONG" ? 1 : -1;
  const baselineMinimumStopAtr = Math.max(2, Number(input.baselineMinimumStopAtr ?? 2));
  const baselineLiquidityBufferAtr = Math.max(0.25, Number(input.baselineLiquidityBufferAtr ?? 0.25));

  const candidate = (
    code: Module1StopShadowCandidate["code"],
    label: string,
    stop: number,
    minimumStopAtr: number,
    liquidityBufferAtr: number,
    tradeAccepted = true,
    rejectionReason: string | null = null
  ): Module1StopShadowCandidate => {
    const riskDistance = Math.abs(input.entry - stop);
    return {
      code,
      label,
      entry: roundPrice(input.entry),
      stop: roundPrice(stop),
      target: roundPrice(input.entry + directionFactor * riskDistance * 2),
      riskDistance: roundPrice(riskDistance),
      stopDistanceAtr: atr == null ? null : Number((riskDistance / atr).toFixed(4)),
      minimumStopAtr,
      liquidityBufferAtr,
      tradeAccepted,
      rejectionReason
    };
  };

  const candidates = [candidate(
    "BASELINE_CURRENT",
    "Current production stop",
    input.baselineStop,
    baselineMinimumStopAtr,
    baselineLiquidityBufferAtr
  )];

  if (atr != null && Number.isFinite(input.structuralInvalidation)) {
    for (const plan of [
      { code: "STRUCTURAL_ATR_2_25" as const, label: "Structural plus 2.25 ATR floor", minimumStopAtr: 2.25, liquidityBufferAtr: baselineLiquidityBufferAtr },
      { code: "STRUCTURAL_ATR_2_50" as const, label: "Structural plus 2.50 ATR floor", minimumStopAtr: 2.5, liquidityBufferAtr: baselineLiquidityBufferAtr },
      { code: "SWING_BUFFER_0_50" as const, label: "Swing liquidity plus 0.50 ATR buffer", minimumStopAtr: baselineMinimumStopAtr, liquidityBufferAtr: 0.5 }
    ]) {
      const stopPlan = buildLiquidityAwareStop({
        direction: input.direction,
        entry: input.entry,
        structuralInvalidation: input.structuralInvalidation,
        atr,
        spread: input.spread,
        minimumStopAtr: plan.minimumStopAtr,
        liquidityBufferAtr: plan.liquidityBufferAtr
      });
      candidates.push(candidate(plan.code, plan.label, stopPlan.stop, plan.minimumStopAtr, plan.liquidityBufferAtr));
    }
  }

  const baselineAccepted = baselineStopAtr == null || baselineStopAtr <= MODULE1_STOP_SHADOW_MAXIMUM_STOP_ATR;
  candidates.push(candidate(
    "MAX_STOP_3_ATR",
    "Skip when structural stop exceeds 3 ATR",
    input.baselineStop,
    baselineMinimumStopAtr,
    baselineLiquidityBufferAtr,
    baselineAccepted,
    baselineAccepted ? null : `Required stop is ${baselineStopAtr?.toFixed(2)} ATR, above the 3.00 ATR shadow limit.`
  ));
  return candidates;
}

export function evaluateModule1StopShadowCandle(state: Module1StopShadowState, candle: Module1StopShadowCandle) {
  const long = state.direction === "LONG";
  const expired = new Date(candle.timestampUtc).getTime() >= new Date(state.observationUntil).getTime();
  if (expired) {
    const openPositionR = (long ? candle.close - state.entry : state.entry - candle.close) / state.riskDistance;
    const resultR = state.realizedR + state.remainingFraction * openPositionR;
    return {
      completed: true,
      outcome: resultR > 0 ? "WIN" : resultR < 0 ? "LOSS" : "BREAKEVEN",
      closeReason: "SESSION_EXIT",
      exitPrice: candle.close,
      resultR: Number(resultR.toFixed(4)),
      targetHitIndex: state.targetHitIndex,
      realizedR: state.realizedR,
      remainingFraction: 0,
      maximumFavorableExcursionR: state.maximumFavorableExcursionR,
      maximumAdverseExcursionR: state.maximumAdverseExcursionR,
      ambiguous: false
    };
  }
  const favorablePrice = long ? candle.high : candle.low;
  const adversePrice = long ? candle.low : candle.high;
  const favorableR = Math.max(0, (long ? favorablePrice - state.entry : state.entry - favorablePrice) / state.riskDistance);
  const adverseR = Math.max(0, (long ? state.entry - adversePrice : adversePrice - state.entry) / state.riskDistance);
  const mfeR = Math.max(state.maximumFavorableExcursionR, favorableR);
  const maeR = Math.max(state.maximumAdverseExcursionR, adverseR);
  const activeStop = state.targetHitIndex >= 2 ? state.entry : state.stop;
  const stopHit = long ? candle.low <= activeStop : candle.high >= activeStop;
  const targetPrices = [1, 1.5, 2].map((multiple) => state.entry + (long ? 1 : -1) * state.riskDistance * multiple);
  let touchedTarget = state.targetHitIndex;
  for (let index = state.targetHitIndex; index < targetPrices.length; index += 1) {
    const touched = long ? candle.high >= targetPrices[index] : candle.low <= targetPrices[index];
    if (touched) touchedTarget = index + 1;
    else break;
  }

  // Five-minute OHLC cannot prove whether a new target or stop happened first.
  if (stopHit) {
    return {
      completed: true,
      outcome: state.targetHitIndex >= 2 ? "WIN" : state.targetHitIndex === 1 ? "LOSS" : "LOSS",
      closeReason: state.targetHitIndex >= 2 ? "TP2_BREAKEVEN" : "STOP",
      exitPrice: activeStop,
      resultR: shadowStopResultR(state.targetHitIndex),
      targetHitIndex: state.targetHitIndex,
      realizedR: state.realizedR,
      remainingFraction: 0,
      maximumFavorableExcursionR: touchedTarget > state.targetHitIndex ? state.maximumFavorableExcursionR : mfeR,
      maximumAdverseExcursionR: maeR,
      ambiguous: touchedTarget > state.targetHitIndex
    };
  }

  const targetProgress = shadowTargetProgress(touchedTarget);
  if (touchedTarget >= 3) {
    return {
      completed: true,
      outcome: "WIN",
      closeReason: "TP3",
      exitPrice: state.target,
      resultR: 1.5,
      targetHitIndex: 3,
      realizedR: 1.5,
      remainingFraction: 0,
      maximumFavorableExcursionR: mfeR,
      maximumAdverseExcursionR: maeR,
      ambiguous: false
    };
  }

  return {
    completed: false,
    outcome: "ACTIVE",
    closeReason: null,
    exitPrice: null,
    resultR: null,
    targetHitIndex: touchedTarget,
    realizedR: targetProgress.realizedR,
    remainingFraction: targetProgress.remainingFraction,
    maximumFavorableExcursionR: mfeR,
    maximumAdverseExcursionR: maeR,
    ambiguous: false
  };
}

function shadowTargetProgress(targetHitIndex: number) {
  if (targetHitIndex >= 3) return { realizedR: 1.5, remainingFraction: 0 };
  if (targetHitIndex === 2) return { realizedR: Number((1 / 3 + 0.5).toFixed(4)), remainingFraction: 1 / 3 };
  if (targetHitIndex === 1) return { realizedR: Number((1 / 3).toFixed(4)), remainingFraction: 2 / 3 };
  return { realizedR: 0, remainingFraction: 1 };
}

function shadowStopResultR(targetHitIndex: number) {
  if (targetHitIndex >= 2) return Number((1 / 3 + 0.5).toFixed(4));
  if (targetHitIndex === 1) return Number((1 / 3 - 2 / 3).toFixed(4));
  return -1;
}

function roundPrice(value: number) {
  return Number(value.toFixed(5));
}
