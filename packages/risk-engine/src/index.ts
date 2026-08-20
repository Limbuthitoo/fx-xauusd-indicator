import type { RiskInput, RiskResult } from "@orb-guide/shared-types";

export const XAUUSD_PRODUCTION_SIGNAL_POLICY = {
  pipSize: 0.01,
  minimumEvidenceScore: 80,
  minimumTp1Pips: 100,
  minimumFinalRewardToRisk: 2,
  maximumSignalsPerNewYorkDate: 3,
  maximumSignalsPerStrategyProfile: 2,
  sameProfileCooldownMinutes: 45,
  maximumEntryChaseR: 0.35,
  maximumEntryDriftR: 0.5,
  correlatedSignalWindowMinutes: 30,
  correlatedEntryDistanceR: 0.5
} as const;

export type SignalExecutionQualityInput = {
  direction: string;
  entry: number;
  stop: number;
  currentPrice: number;
  evidenceScore: number;
  maximumEntryChaseR: number;
  maximumEntryDriftR: number;
};

export function evaluateSignalExecutionQuality(input: SignalExecutionQualityInput) {
  const directionMultiplier = ["SHORT", "SELL"].includes(input.direction.toUpperCase()) ? -1 : 1;
  const riskDistance = Math.abs(input.entry - input.stop);
  const favorableDriftR = riskDistance > 0
    ? ((input.currentPrice - input.entry) * directionMultiplier) / riskDistance
    : Number.POSITIVE_INFINITY;
  const absoluteDriftR = Math.abs(favorableDriftR);
  const reasons: string[] = [];
  if (![input.entry, input.stop, input.currentPrice, input.evidenceScore].every(Number.isFinite) || riskDistance <= 0) {
    reasons.push("Live entry quality could not be measured from valid signal geometry.");
  } else {
    if (favorableDriftR > input.maximumEntryChaseR) {
      reasons.push(`Price has already moved ${favorableDriftR.toFixed(2)}R beyond entry; do not chase above ${input.maximumEntryChaseR.toFixed(2)}R.`);
    }
    if (absoluteDriftR > input.maximumEntryDriftR) {
      reasons.push(`Live price is ${absoluteDriftR.toFixed(2)}R from entry; wait for a new confirmed contract.`);
    }
  }
  const executionScore = Number.isFinite(favorableDriftR)
    ? Math.max(0, Math.min(100, input.evidenceScore - Math.max(0, favorableDriftR) * 20 - Math.max(0, -favorableDriftR) * 10))
    : 0;
  return {
    passed: reasons.length === 0,
    riskDistance,
    favorableDriftR,
    absoluteDriftR,
    executionScore: Number(executionScore.toFixed(2)),
    reasons
  };
}

export type CorrelatedSignalInput = {
  direction: string;
  entry: number;
  riskDistance: number;
  signalAt: string | Date;
};

export function signalsAreCorrelated(
  candidate: CorrelatedSignalInput,
  incumbent: CorrelatedSignalInput,
  windowMinutes: number,
  maximumEntryDistanceR: number
) {
  if (candidate.direction.toUpperCase() !== incumbent.direction.toUpperCase()) return false;
  const candidateAt = new Date(candidate.signalAt).getTime();
  const incumbentAt = new Date(incumbent.signalAt).getTime();
  if (!Number.isFinite(candidateAt) || !Number.isFinite(incumbentAt)) return false;
  if (Math.abs(candidateAt - incumbentAt) > windowMinutes * 60_000) return false;
  const referenceRisk = Math.max(candidate.riskDistance, incumbent.riskDistance);
  return referenceRisk > 0 && Math.abs(candidate.entry - incumbent.entry) / referenceRisk <= maximumEntryDistanceR;
}

export type SignalGeometryQualityInput = {
  direction: string;
  entry: number;
  stop: number;
  target: number;
  pipSize: number;
  minimumTp1Pips: number;
  minimumFinalRewardToRisk: number;
};

export function evaluateSignalGeometryQuality(input: SignalGeometryQualityInput) {
  const direction = input.direction.toUpperCase();
  const values = [input.entry, input.stop, input.target, input.pipSize, input.minimumTp1Pips, input.minimumFinalRewardToRisk];
  const finite = values.every(Number.isFinite);
  const directional = finite && (direction === "LONG" || direction === "BUY"
    ? input.stop < input.entry && input.entry < input.target
    : direction === "SHORT" || direction === "SELL"
      ? input.target < input.entry && input.entry < input.stop
      : false);
  const riskDistance = finite ? Math.abs(input.entry - input.stop) : 0;
  const finalRewardToRisk = directional && riskDistance > 0 ? Math.abs(input.target - input.entry) / riskDistance : 0;
  const tp1Pips = input.pipSize > 0 ? riskDistance / input.pipSize : 0;
  const reasons: string[] = [];
  if (!directional) reasons.push("Entry, structural stop, and target are not ordered correctly for the signal direction.");
  if (tp1Pips + 0.0001 < input.minimumTp1Pips) reasons.push(`TP1 would be ${Math.floor(tp1Pips)} pips; at least ${input.minimumTp1Pips} pips is required.`);
  if (finalRewardToRisk + 0.0001 < input.minimumFinalRewardToRisk) reasons.push(`Final target is ${finalRewardToRisk.toFixed(2)}R; at least ${input.minimumFinalRewardToRisk.toFixed(2)}R is required.`);
  return {
    passed: reasons.length === 0,
    directional,
    riskDistance,
    tp1Pips: Math.floor(tp1Pips),
    finalRewardToRisk,
    reasons
  };
}

const roundDownToStep = (value: number, step: number) => {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
};

export function calculateRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  const stopDistance = Math.abs(input.entry - input.stop);
  const targetDistance = Math.abs(input.target - input.entry);
  const plannedRiskAmount = input.accountEquity * (input.riskPerTradePercent / 100);

  if (stopDistance <= 0) {
    reasons.push("Stop-loss distance must be greater than zero.");
  }

  const valuePerPriceUnitPerLot = input.tickValue / input.tickSize;
  const rawLot = stopDistance > 0 ? plannedRiskAmount / (stopDistance * valuePerPriceUnitPerLot) : 0;
  const suggestedLotSize = Math.min(input.maximumLot, roundDownToStep(rawLot, input.lotStep));
  const estimatedSpreadCost = input.spread * valuePerPriceUnitPerLot * suggestedLotSize;
  const estimatedCommission = input.commissionPerLot * suggestedLotSize;
  const targetReward = targetDistance * valuePerPriceUnitPerLot * suggestedLotSize;
  const maximumPossibleLoss = stopDistance * valuePerPriceUnitPerLot * suggestedLotSize + estimatedSpreadCost + estimatedCommission;
  const rewardToRisk = maximumPossibleLoss > 0 ? targetReward / maximumPossibleLoss : 0;

  if (suggestedLotSize < input.minimumLot) {
    reasons.push("Calculated paper size is below the configured minimum.");
  }
  if (suggestedLotSize > input.maximumLot) {
    reasons.push("Calculated paper size is above the configured maximum.");
  }
  if (rewardToRisk < input.minimumRewardToRisk) {
    reasons.push(`Reward-to-risk is below ${input.minimumRewardToRisk}.`);
  }
  if ((input.existingDailyLossPercent ?? 0) >= (input.maximumDailyLossPercent ?? Number.POSITIVE_INFINITY)) {
    reasons.push("Daily loss limit has been reached.");
  }
  if ((input.existingWeeklyLossPercent ?? 0) >= (input.maximumWeeklyLossPercent ?? Number.POSITIVE_INFINITY)) {
    reasons.push("Weekly loss limit has been reached.");
  }

  return {
    plannedRiskAmount,
    stopDistance,
    suggestedLotSize,
    estimatedSpreadCost,
    estimatedCommission,
    targetReward,
    rewardToRisk,
    maximumPossibleLoss,
    status: reasons.length > 0 ? "BLOCKED" : "PERMITTED",
    reasons
  };
}
