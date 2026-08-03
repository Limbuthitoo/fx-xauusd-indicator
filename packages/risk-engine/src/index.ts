import type { RiskInput, RiskResult } from "@orb-guide/shared-types";

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
