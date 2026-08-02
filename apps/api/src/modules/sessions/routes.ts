import { buildOpeningRange } from "@orb-guide/strategy-engine";
import type { Candle } from "@orb-guide/shared-types";
import type { FastifyInstance } from "fastify";
import { query } from "../../infrastructure/db/client.js";
import { clocks, newYorkDate, sessionTimesForDate } from "../../infrastructure/time.js";
import { getRuntimeSettings } from "../admin/settings.js";
import { requireTenantModule } from "../auth/routes.js";

const readinessItems = [
  ["MT5_LIVE_RUNNING", "MT5 live ingestion is running"],
  ["ACCOUNT_UPDATED", "Account balance and equity are updated"],
  ["NEWS_REVIEWED", "Manual USD news events reviewed"],
  ["SPREAD_CHECKED", "Current spread is acceptable"],
  ["READINESS_CONFIRMED", "Physical and emotional readiness confirmed"],
  ["NO_REVENGE_TRADING", "No revenge-trading or FOMO risk"]
];

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/clocks", async () => clocks());

  app.post("/api/sessions/start", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const settings = await getRuntimeSettings(auth.tenantId);
    const body = request.body as { sessionDate?: string; strategyVersionId?: string; symbol?: string; preset?: string };
    const versionResult = await query("SELECT * FROM strategy_versions WHERE id = COALESCE($1::uuid, (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1))", [
      body.strategyVersionId ?? null
    ]);
    const version = versionResult.rows[0] as any;
    const sessionDate = body.sessionDate ?? new Date().toISOString().slice(0, 10);
    const symbol = body.symbol ?? settings.symbol;
    const times = sessionTimesForDate(sessionDate, settings.orb.sessionStart, settings.orb.openingRangeMinutes, settings.orb.tradeWindowEnd);
    const existing = await query(
      `SELECT * FROM trading_sessions
       WHERE symbol = $1 AND strategy_version_id = $2 AND session_date = $3 AND session_preset = $4 AND tenant_id = $5 AND module_code = 'orb_max_options'
       ORDER BY created_at DESC
       LIMIT 1`,
      [symbol, version.id, sessionDate, body.preset ?? "NY_0930", auth.tenantId]
    );
    if (existing.rows[0]) {
      await ensureReadiness(existing.rows[0].id);
      return existing.rows[0];
    }
    const { rows } = await query(
      `INSERT INTO trading_sessions (
        tenant_id, module_code, user_id, symbol, strategy_version_id, session_date, session_preset, state,
        session_start_at, opening_range_end_at, signal_window_end_at
      ) VALUES (
        $8, 'orb_max_options', (SELECT id FROM users WHERE tenant_id = $8 LIMIT 1), $1, $2, $3, $4, 'PRE_SESSION', $5, $6, $7
      ) RETURNING *`,
      [symbol, version.id, sessionDate, body.preset ?? "NY_0930", times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, auth.tenantId]
    );
    await ensureReadiness(rows[0].id);
    return rows[0];
  });

  app.post("/api/sessions/today", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const settings = await getRuntimeSettings(auth.tenantId);
    const versionResult = await query("SELECT * FROM strategy_versions WHERE id = (SELECT selected_strategy_version_id FROM user_preferences LIMIT 1)");
    const version = versionResult.rows[0] as any;
    const sessionDate = newYorkDate();
    const times = sessionTimesForDate(sessionDate, settings.orb.sessionStart, settings.orb.openingRangeMinutes, settings.orb.tradeWindowEnd);
    const existing = await query(
      `SELECT * FROM trading_sessions
       WHERE symbol = $3 AND strategy_version_id = $1 AND session_date = $2 AND session_preset = 'NY_0930' AND tenant_id = $4 AND module_code = 'orb_max_options'
       ORDER BY created_at DESC
       LIMIT 1`,
      [version.id, sessionDate, settings.symbol, auth.tenantId]
    );
    if (existing.rows[0]) {
      await ensureReadiness(existing.rows[0].id);
      return updateSessionState(existing.rows[0].id);
    }
    const { rows } = await query(
      `INSERT INTO trading_sessions (
        tenant_id, module_code, user_id, symbol, strategy_version_id, session_date, session_preset, state,
        session_start_at, opening_range_end_at, signal_window_end_at
      ) VALUES (
        $7, 'orb_max_options', (SELECT id FROM users WHERE tenant_id = $7 LIMIT 1), $1, $2, $3, 'NY_0930', 'PRE_SESSION', $4, $5, $6
      ) RETURNING *`,
      [settings.symbol, version.id, sessionDate, times.sessionStartAt, times.openingRangeEndAt, times.signalWindowEndAt, auth.tenantId]
    );
    await ensureReadiness(rows[0].id);
    return updateSessionState(rows[0].id);
  });

  app.get("/api/sessions/current", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const { rows } = await query(`
      SELECT ts.*, row_to_json(orr.*) AS opening_range
      FROM trading_sessions ts
      LEFT JOIN opening_ranges orr ON orr.session_id = ts.id
      WHERE ts.tenant_id = $1
        AND ts.module_code = $2
      ORDER BY ts.created_at DESC
      LIMIT 1
    `, [auth.tenantId, moduleCode]);
    return rows[0] ?? null;
  });

  app.post("/api/sessions/current/refresh-state", async (request) => {
    const body = request.body as { moduleCode?: string };
    const moduleCode = body.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const current = await query(
      "SELECT id FROM trading_sessions WHERE tenant_id = $1 AND module_code = $2 ORDER BY created_at DESC LIMIT 1",
      [auth.tenantId, moduleCode]
    );
    if (!current.rows[0]) return null;
    return updateSessionState(current.rows[0].id);
  });

  app.get("/api/sessions/:id/readiness", async (request) => {
    await requireTenantModule(request, "orb_max_options");
    const { id } = request.params as { id: string };
    await ensureReadiness(id);
    const { rows } = await query("SELECT * FROM pre_session_readiness WHERE session_id = $1 ORDER BY item_code", [id]);
    return rows;
  });

  app.put("/api/sessions/:id/readiness", async (request) => {
    await requireTenantModule(request, "orb_max_options");
    const { id } = request.params as { id: string };
    const body = request.body as { answers: Array<{ itemCode: string; answer: string }> };
    await ensureReadiness(id);
    for (const answer of body.answers ?? []) {
      await query(
        "UPDATE pre_session_readiness SET answer = $3, updated_at = now() WHERE session_id = $1 AND item_code = $2",
        [id, answer.itemCode, answer.answer]
      );
    }
    const { rows } = await query("SELECT * FROM pre_session_readiness WHERE session_id = $1 ORDER BY item_code", [id]);
    return rows;
  });

  app.post("/api/sessions/:id/lock-range", async (request) => {
    const auth = await requireTenantModule(request, "orb_max_options");
    const settings = await getRuntimeSettings(auth.tenantId);
    const { id } = request.params as { id: string };
    const sessionResult = await query(
      `SELECT ts.*, sv.signal_timeframe_minutes, sv.opening_range_minutes
       FROM trading_sessions ts
       JOIN strategy_versions sv ON sv.id = ts.strategy_version_id
       WHERE ts.id = $1 AND ts.tenant_id = $2`,
      [id, auth.tenantId]
    );
    const session = sessionResult.rows[0] as any;
    const timeframe = settings.timeframeMinutes;
    const candlesResult = await query(
      `SELECT timestamp_utc, open, high, low, close, volume, spread
       FROM candles
       WHERE symbol = $1 AND timeframe_minutes = $2 AND timestamp_utc >= $3 AND timestamp_utc < $4
       ORDER BY timestamp_utc`,
      [session.symbol, timeframe, session.session_start_at, session.opening_range_end_at]
    );
    const candles: Candle[] = candlesResult.rows.map((row: any) => ({
      timestampUtc: row.timestamp_utc,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: row.volume == null ? null : Number(row.volume),
      spread: row.spread == null ? null : Number(row.spread)
    }));
    const range = buildOpeningRange(candles, 0.01, Math.ceil(Number(settings.orb.openingRangeMinutes) / timeframe));
    const { rows } = await query(
      `INSERT INTO opening_ranges (
        session_id, status, high, low, midpoint, width, width_ticks, width_atr_percent,
        source_candle_count, data_quality_status, invalid_reason, locked_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (session_id) DO UPDATE SET
        status = EXCLUDED.status,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        midpoint = EXCLUDED.midpoint,
        width = EXCLUDED.width,
        width_ticks = EXCLUDED.width_ticks,
        width_atr_percent = EXCLUDED.width_atr_percent,
        source_candle_count = EXCLUDED.source_candle_count,
        data_quality_status = EXCLUDED.data_quality_status,
        invalid_reason = EXCLUDED.invalid_reason,
        locked_at = EXCLUDED.locked_at
      RETURNING *`,
      [
        id,
        range.status,
        range.high,
        range.low,
        range.midpoint,
        range.width,
        range.widthTicks,
        range.widthAtrPercent ?? null,
        range.sourceCandleCount,
        range.dataQualityStatus,
        range.invalidReason ?? null,
        range.lockedAt ?? null
      ]
    );
    await query("UPDATE trading_sessions SET state = $2, data_status = $3 WHERE id = $1", [
      id,
      range.status === "LOCKED" ? "WAITING_FOR_SETUP" : "NO_TRADE",
      range.dataQualityStatus
    ]);
    return rows[0];
  });

  app.post("/api/sessions/:id/complete", async (request) => {
    const { id } = request.params as { id: string };
    const scopeResult = await query("SELECT tenant_id, module_code FROM trading_sessions WHERE id = $1", [id]);
    const scope = scopeResult.rows[0] as any;
    if (!scope) return null;
    const auth = await requireTenantModule(request, scope.module_code ?? "orb_max_options");
    if (scope.tenant_id !== auth.tenantId) return null;
    const body = request.body as { classification?: string };
    const { rows } = await query(
      "UPDATE trading_sessions SET state = 'SESSION_COMPLETED', final_classification = $2, completed_at = now() WHERE id = $1 AND tenant_id = $3 RETURNING *",
      [id, body.classification ?? "SESSION_COMPLETED", auth.tenantId]
    );
    return rows[0];
  });

  app.get("/api/sessions/history", async (request) => {
    const search = request.query as { moduleCode?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const auth = await requireTenantModule(request, moduleCode);
    const { rows } = await query("SELECT * FROM trading_sessions WHERE tenant_id = $1 AND module_code = $2 ORDER BY session_date DESC, created_at DESC LIMIT 100", [auth.tenantId, moduleCode]);
    return rows;
  });
}

async function ensureReadiness(sessionId: string) {
  for (const [code, prompt] of readinessItems) {
    await query(
      `INSERT INTO pre_session_readiness (session_id, item_code, prompt)
       VALUES ($1,$2,$3)
       ON CONFLICT (session_id, item_code) DO NOTHING`,
      [sessionId, code, prompt]
    );
  }
}

async function updateSessionState(sessionId: string) {
  const result = await query(
    `SELECT ts.*, row_to_json(orr.*) AS opening_range
     FROM trading_sessions ts
     LEFT JOIN opening_ranges orr ON orr.session_id = ts.id
     WHERE ts.id = $1`,
    [sessionId]
  );
  const session = result.rows[0] as any;
  if (!session) return null;
  const now = new Date();
  let state = session.state;
  if (["TRADE_PLANNED", "TRADE_ACTIVE", "TRADE_CLOSED", "SESSION_COMPLETED", "NO_TRADE"].includes(state)) return session;
  if (now < new Date(session.session_start_at)) state = "PRE_SESSION";
  else if (now >= new Date(session.session_start_at) && now < new Date(session.opening_range_end_at)) state = "OPENING_RANGE_FORMING";
  else if (session.opening_range?.status === "LOCKED") state = "WAITING_FOR_SETUP";
  else if (now >= new Date(session.opening_range_end_at) && now <= new Date(session.signal_window_end_at)) state = "OPENING_RANGE_LOCKED";
  else if (now > new Date(session.signal_window_end_at)) state = "SESSION_EXPIRED";

  const updated = await query("UPDATE trading_sessions SET state = $2 WHERE id = $1 RETURNING *", [sessionId, state]);
  return { ...updated.rows[0], opening_range: session.opening_range };
}
