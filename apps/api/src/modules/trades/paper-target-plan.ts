export type PaperTarget = {
  id?: string;
  target_number: number;
  price: number;
  risk_multiple: number;
  position_fraction: number;
  realized_r?: number | null;
  status: "PENDING" | "HIT" | "CANCELLED";
  hit_at?: string | null;
  hit_price?: number | null;
};

export function buildPaperTargetPlan(entry: number, stop: number, target: number, direction: string) {
  if (![entry, stop, target].every(Number.isFinite)) return [];
  const normalizedDirection = direction.toUpperCase();
  if (!["LONG", "SHORT", "BUY", "SELL"].includes(normalizedDirection)) return [];
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) return [];
  const multiplier = normalizedDirection === "SHORT" || normalizedDirection === "SELL" ? -1 : 1;
  if ((entry - stop) * multiplier <= 0 || (target - entry) * multiplier <= 0) return [];
  const finalR = Math.abs(target - entry) / riskDistance;
  const fractions = [0.333333, 0.333333, 0.333334];
  return [Math.min(1, finalR), Math.min(1.5, finalR), finalR].map((riskMultiple, index) => ({
    targetNumber: index + 1,
    price: Number((entry + multiplier * riskDistance * riskMultiple).toFixed(5)),
    riskMultiple: Number(riskMultiple.toFixed(4)),
    positionFraction: fractions[index]
  }));
}

export function paperTargetTouches(trade: any, targets: PaperTarget[], candle: any) {
  const direction = String(trade.direction).toUpperCase();
  const stop = Number(trade.actual_stop ?? trade.structural_stop);
  const high = Number(candle.high);
  const low = Number(candle.low);
  if (![stop, high, low].every(Number.isFinite) || !["LONG", "SHORT"].includes(direction)) {
    return { stopHit: false, ambiguous: false, pendingHit: [] as PaperTarget[] };
  }
  const stopHit = direction === "SHORT" ? high >= stop : low <= stop;
  const pendingHit = targets.filter((target) =>
    target.status === "PENDING" && (direction === "SHORT" ? low <= target.price : high >= target.price)
  );
  return { stopHit, ambiguous: stopHit && pendingHit.length > 0, pendingHit };
}

export function paperSettlement(trade: any, targets: PaperTarget[], exitPrice: number) {
  const entry = Number(trade.actual_entry);
  const structuralStop = Number(trade.structural_stop ?? trade.actual_stop);
  const direction = String(trade.direction).toUpperCase();
  const directionMultiplier = direction === "SHORT" || direction === "SELL" ? -1 : 1;
  const initialRisk = Number(trade.initial_risk_distance ?? Math.abs(entry - structuralStop));
  const hitTargets = targets.filter((target) => target.status === "HIT");
  const lockedR = hitTargets.reduce((total, target) => {
    const contribution = Number(target.realized_r ?? target.risk_multiple * paperTargetFraction(target));
    return total + (Number.isFinite(contribution) ? contribution : 0);
  }, 0);
  const hitFraction = hitTargets.reduce((total, target) => total + paperTargetFraction(target), 0);
  const remainingFraction = Math.max(0, Math.min(1, targets.length > 0 ? 1 - hitFraction : Number(trade.remaining_fraction ?? 1)));
  const runnerR = Number.isFinite(exitPrice) && initialRisk > 0
    ? ((exitPrice - entry) * directionMultiplier) / initialRisk
    : 0;
  const resultR = lockedR + remainingFraction * runnerR;
  return {
    lockedR: Number(lockedR.toFixed(6)),
    remainingFraction: Number(remainingFraction.toFixed(6)),
    runnerR: Number(runnerR.toFixed(6)),
    resultR: Number(resultR.toFixed(4)),
    outcome: resultR > 0.00005 ? "WIN" : resultR < -0.00005 ? "LOSS" : "BREAKEVEN"
  };
}

function paperTargetFraction(target: PaperTarget) {
  const value = Number(target.position_fraction);
  if (Number.isFinite(value) && value > 0) return value;
  return target.target_number === 3 ? 0.333334 : 0.333333;
}
