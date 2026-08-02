import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";

export async function importRoutes(app: FastifyInstance) {
  app.post("/api/imports/candles", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number; candles: any[] };
    const errors: string[] = [];
    const timeframe = body.timeframeMinutes ?? 15;
    let imported = 0;
    for (const [index, candle] of body.candles.entries()) {
      try {
        await query(
          `INSERT INTO candles (symbol, timeframe_minutes, timestamp_utc, open, high, low, close, volume, spread)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (symbol, timeframe_minutes, timestamp_utc) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
             volume = EXCLUDED.volume, spread = EXCLUDED.spread`,
          [
            body.symbol ?? "XAUUSD",
            timeframe,
            normalizeToTimeframe(candle.timestamp ?? candle.timestampUtc, timeframe),
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            candle.volume ?? null,
            candle.spread ?? null
          ]
        );
        imported += 1;
      } catch (error) {
        errors.push(`Row ${index + 1}: ${(error as Error).message}`);
      }
    }
    return { imported, errors, dataQualityStatus: errors.length ? "WARNINGS" : "VALID" };
  });

  app.post("/api/imports/demo-candles", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number; count?: number; startPrice?: number };
    const symbol = body.symbol ?? "XAUUSD";
    const timeframe = body.timeframeMinutes ?? 15;
    const count = Math.min(body.count ?? 260, 1000);
    const startPrice = body.startPrice ?? 2350;
    const now = Date.now();
    const start = now - count * timeframe * 60_000;
    let previousClose = startPrice;
    const candles = [];

    for (let index = 0; index < count; index += 1) {
      const timestamp = new Date(start + index * timeframe * 60_000).toISOString();
      const drift = Math.sin(index / 9) * 0.55 + Math.cos(index / 17) * 0.35;
      const impulse = index % 67 === 0 ? 2.4 : index % 89 === 0 ? -2.1 : 0;
      const open = previousClose;
      const close = open + drift + impulse;
      const high = Math.max(open, close) + 0.65 + (index % 5) * 0.08;
      const low = Math.min(open, close) - 0.62 - (index % 7) * 0.07;
      const spread = 0.22 + (index % 8) * 0.01;
      previousClose = close;
      candles.push({ timestamp, open, high, low, close, volume: 1000 + index * 3, spread });
    }

    let imported = 0;
    for (const candle of candles) {
      await query(
        `INSERT INTO candles (symbol, timeframe_minutes, timestamp_utc, open, high, low, close, volume, spread)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (symbol, timeframe_minutes, timestamp_utc) DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
           volume = EXCLUDED.volume, spread = EXCLUDED.spread`,
        [symbol, timeframe, normalizeToTimeframe(candle.timestamp, timeframe), candle.open, candle.high, candle.low, candle.close, candle.volume, candle.spread]
      );
      imported += 1;
    }

    return {
      imported,
      symbol,
      timeframeMinutes: timeframe,
      source: "DEMO_SYNTHETIC_LOCAL_ONLY",
      dataQualityStatus: "VALID"
    };
  });

  app.post("/api/imports/demo-candles/append", async (request) => {
    const body = request.body as { symbol?: string; timeframeMinutes?: number };
    const symbol = body.symbol ?? "XAUUSD";
    const timeframe = body.timeframeMinutes ?? 15;
    const latest = await query(
      `SELECT timestamp_utc, close
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2
       ORDER BY timestamp_utc DESC
       LIMIT 1`,
      [symbol, timeframe]
    );
    const latestRow = latest.rows[0];
    const previousClose = latestRow ? Number(latestRow.close) : 2350;
    const previousTime = latestRow ? new Date(String(latestRow.timestamp_utc)).getTime() : Date.now() - timeframe * 60_000;
    const nextTime = new Date(previousTime + timeframe * 60_000);
    const phase = Math.floor(nextTime.getTime() / 60_000);
    const drift = Math.sin(phase / 6) * 0.42 + Math.cos(phase / 13) * 0.28;
    const open = previousClose;
    const close = open + drift;
    const high = Math.max(open, close) + 0.58;
    const low = Math.min(open, close) - 0.56;
    const spread = 0.22 + (phase % 7) * 0.01;

    const { rows } = await query(
      `INSERT INTO candles (symbol, timeframe_minutes, timestamp_utc, open, high, low, close, volume, spread)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (symbol, timeframe_minutes, timestamp_utc) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         volume = EXCLUDED.volume, spread = EXCLUDED.spread
       RETURNING timestamp_utc, open, high, low, close, volume, spread`,
      [symbol, timeframe, nextTime.toISOString(), open, high, low, close, 1200 + (phase % 100), spread]
    );

    return {
      symbol,
      timeframeMinutes: timeframe,
      source: "SIMULATED_LIVE_LOCAL_ONLY",
      candle: {
        timestampUtc: rows[0].timestamp_utc,
        open: Number(rows[0].open),
        high: Number(rows[0].high),
        low: Number(rows[0].low),
        close: Number(rows[0].close),
        volume: rows[0].volume == null ? null : Number(rows[0].volume),
        spread: rows[0].spread == null ? null : Number(rows[0].spread)
      }
    };
  });
}

function normalizeToTimeframe(timestamp: string, timeframeMinutes: number) {
  const date = new Date(timestamp);
  const bucketMs = timeframeMinutes * 60_000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}
