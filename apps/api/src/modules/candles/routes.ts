import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";

export async function candleRoutes(app: FastifyInstance) {
  app.get("/api/candles", async (request) => {
    const search = request.query as {
      symbol?: string;
      timeframeMinutes?: string;
      limit?: string;
      from?: string;
      to?: string;
    };
    const symbol = search.symbol ?? "XAUUSD";
    const timeframe = Number(search.timeframeMinutes ?? 15);
    const limit = Math.min(Number(search.limit ?? 300), 2000);
    const { rows } = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1
         AND timeframe_minutes = $2
         AND ($3::timestamptz IS NULL OR timestamp_utc >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR timestamp_utc <= $4::timestamptz)
       ORDER BY timestamp_utc DESC
       LIMIT $5`,
      [symbol, timeframe, search.from ?? null, search.to ?? null, limit]
    );
    return uniqueByChartSecond(
      rows.reverse().map((row) => ({
        timestampUtc: row.timestamp_utc,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume == null ? null : Number(row.volume),
        spread: row.spread == null ? null : Number(row.spread)
      }))
    );
  });

  app.delete("/api/candles/duplicates", async (request) => {
    const search = request.query as { symbol?: string; timeframeMinutes?: string };
    const symbol = search.symbol ?? "XAUUSD";
    const timeframe = Number(search.timeframeMinutes ?? 15);
    const { rowCount } = await query(
      `WITH ranked AS (
        SELECT id,
          row_number() OVER (
            PARTITION BY symbol, timeframe_minutes, floor(extract(epoch from timestamp_utc))
            ORDER BY created_at DESC
          ) AS rn
        FROM candles
        WHERE symbol = $1 AND timeframe_minutes = $2
      )
      DELETE FROM candles
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`,
      [symbol, timeframe]
    );
    return { deleted: rowCount ?? 0, symbol, timeframeMinutes: timeframe };
  });

  app.get("/api/indicators/live", async (request) => {
    const search = request.query as { symbol?: string; timeframeMinutes?: string };
    const symbol = search.symbol ?? "XAUUSD";
    const timeframe = Number(search.timeframeMinutes ?? 15);
    const { rows } = await query(
      `SELECT timestamp_utc, close, high, low, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc DESC
       LIMIT 260`,
      [symbol, timeframe]
    );
    const candles = uniqueByChartSecond(
      rows.reverse().map((row) => ({
        timestampUtc: row.timestamp_utc,
        close: Number(row.close),
        high: Number(row.high),
        low: Number(row.low),
        spread: row.spread == null ? null : Number(row.spread)
      }))
    ).slice(-220);
    const closes = candles.map((candle) => candle.close);
    const latest = candles.at(-1);
    return {
      symbol,
      timeframeMinutes: timeframe,
      latestPrice: latest?.close ?? null,
      latestTimestampUtc: latest?.timestampUtc ?? null,
      spread: latest?.spread ?? null,
      ema20: latestEma(closes, 20),
      ema50: latestEma(closes, 50),
      ema200: latestEma(closes, 200),
      atr14: latestAtr(candles, 14),
      candleCount: candles.length
    };
  });
}

function uniqueByChartSecond<T extends { timestampUtc: string }>(candles: T[]) {
  const bySecond = new Map<number, T>();
  for (const candle of candles) {
    bySecond.set(Math.floor(new Date(candle.timestampUtc).getTime() / 1000), candle);
  }
  return [...bySecond.values()].sort((left, right) => new Date(left.timestampUtc).getTime() - new Date(right.timestampUtc).getTime());
}

function latestEma(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) {
    ema = value * multiplier + ema * (1 - multiplier);
  }
  return Number(ema.toFixed(5));
}

function latestAtr(candles: Array<{ high: number; low: number; close: number }>, period: number) {
  if (candles.length <= period) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  const recent = trueRanges.slice(-period);
  return Number((recent.reduce((sum, value) => sum + value, 0) / period).toFixed(5));
}
