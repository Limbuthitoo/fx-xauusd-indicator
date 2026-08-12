export type PaperTarget = {
  id?: string;
  target_number: number;
  price: number;
  risk_multiple: number;
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
  return [Math.min(1, finalR), Math.min(1.5, finalR), finalR].map((riskMultiple, index) => ({
    targetNumber: index + 1,
    price: Number((entry + multiplier * riskDistance * riskMultiple).toFixed(5)),
    riskMultiple: Number(riskMultiple.toFixed(4))
  }));
}

export function paperTargetTouches(trade: any, targets: PaperTarget[], candle: any) {
  const direction = String(trade.direction).toUpperCase();
  const stop = Number(trade.structural_stop ?? trade.actual_stop);
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
