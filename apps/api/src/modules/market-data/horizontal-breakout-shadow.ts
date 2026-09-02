import type { Candle, Direction } from "@orb-guide/shared-types";

export type HorizontalBreakoutShadowState = {
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  maxFavorableExcursionR?: number;
  maxAdverseExcursionR?: number;
  tp1HitAt?: string | null;
  tp2HitAt?: string | null;
  tp3HitAt?: string | null;
};

export type HorizontalBreakoutShadowProgress = {
  status: "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "STOPPED";
  completed: boolean;
  terminalReason: "TP3" | "STOP" | null;
  maxFavorablePrice: number;
  maxAdversePrice: number;
  maxFavorableExcursionR: number;
  maxAdverseExcursionR: number;
  tp1HitAt: string | null;
  tp2HitAt: string | null;
  tp3HitAt: string | null;
  stopHitAt: string | null;
};

export function evaluateHorizontalBreakoutShadow(
  shadow: HorizontalBreakoutShadowState,
  candle: Candle
): HorizontalBreakoutShadowProgress {
  const risk = Math.abs(shadow.entry - shadow.stop);
  if (!Number.isFinite(risk) || risk <= 0) throw new Error("Horizontal breakout shadow requires positive risk.");
  const long = shadow.direction === "LONG";
  const favorablePrice = long ? candle.high : candle.low;
  const adversePrice = long ? candle.low : candle.high;
  const favorableR = Math.max(0, long ? (favorablePrice - shadow.entry) / risk : (shadow.entry - favorablePrice) / risk);
  const adverseR = Math.max(0, long ? (shadow.entry - adversePrice) / risk : (adversePrice - shadow.entry) / risk);
  const stopHit = long ? candle.low <= shadow.stop : candle.high >= shadow.stop;

  // Completed candles do not reveal intrabar ordering, so stop-first is the conservative outcome.
  if (stopHit) {
    return {
      status: "STOPPED",
      completed: true,
      terminalReason: "STOP",
      maxFavorablePrice: shadow.entry,
      maxAdversePrice: adversePrice,
      maxFavorableExcursionR: Number(shadow.maxFavorableExcursionR ?? 0),
      maxAdverseExcursionR: Math.max(Number(shadow.maxAdverseExcursionR ?? 0), adverseR),
      tp1HitAt: shadow.tp1HitAt ?? null,
      tp2HitAt: shadow.tp2HitAt ?? null,
      tp3HitAt: shadow.tp3HitAt ?? null,
      stopHitAt: candle.timestampUtc
    };
  }

  const reached = (target: number) => long ? candle.high >= target : candle.low <= target;
  const tp1HitAt = shadow.tp1HitAt ?? (reached(shadow.tp1) ? candle.timestampUtc : null);
  const tp2HitAt = shadow.tp2HitAt ?? (reached(shadow.tp2) ? candle.timestampUtc : null);
  const tp3HitAt = shadow.tp3HitAt ?? (reached(shadow.tp3) ? candle.timestampUtc : null);
  return {
    status: tp3HitAt ? "TP3_HIT" : tp2HitAt ? "TP2_HIT" : tp1HitAt ? "TP1_HIT" : "ACTIVE",
    completed: Boolean(tp3HitAt),
    terminalReason: tp3HitAt ? "TP3" : null,
    maxFavorablePrice: favorablePrice,
    maxAdversePrice: adversePrice,
    maxFavorableExcursionR: Math.max(Number(shadow.maxFavorableExcursionR ?? 0), favorableR),
    maxAdverseExcursionR: Math.max(Number(shadow.maxAdverseExcursionR ?? 0), adverseR),
    tp1HitAt,
    tp2HitAt,
    tp3HitAt,
    stopHitAt: null
  };
}
