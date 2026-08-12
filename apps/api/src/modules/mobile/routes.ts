import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { clocks } from "../../infrastructure/time.js";
import { query } from "../../infrastructure/db/client.js";
import { requireAdmin } from "../auth/routes.js";
import { disableMobilePushToken, registerMobilePushToken, sendTenantPush } from "../notifications/push.js";
import { recentOrbRangesForTenant } from "../sessions/routes.js";

export async function mobileRoutes(app: FastifyInstance) {
  app.get("/api/mobile/app-update", async (request) => {
    const search = request.query as { platform?: string; currentVersion?: string; currentCode?: string };
    const platform = String(search.platform ?? "android").toLowerCase() === "android" ? "android" : "android";
    const { rows } = await query(
      `SELECT id, platform, version_name, version_code, file_name, download_path, file_size_bytes, sha256, changelog, created_at
       FROM mobile_app_releases
       WHERE platform = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 1`,
      [platform]
    );
    const latest = rows[0] ?? null;
    if (!latest) return { updateAvailable: false, latest: null };
    const updateAvailable = isNewerRelease(latest.version_name, latest.version_code, search.currentVersion, search.currentCode);
    return {
      updateAvailable,
      current: {
        version: search.currentVersion ?? null,
        code: search.currentCode ?? null
      },
      latest: {
        ...latest,
        downloadUrl: absoluteApiUrl(latest.download_path, request)
      }
    };
  });

  app.get("/api/mobile/app-releases/:fileName", async (request, reply) => {
    const params = request.params as { fileName: string };
    const { rows } = await query(
      `SELECT *
       FROM mobile_app_releases
       WHERE download_path = $1 AND status = 'ACTIVE'
       LIMIT 1`,
      [`/api/mobile/app-releases/${params.fileName}`]
    );
    const release = rows[0];
    if (!release) {
      reply.code(404);
      return "APK release not found.";
    }
    reply.header("content-type", "application/vnd.android.package-archive");
    reply.header("content-disposition", `attachment; filename="${release.file_name}"`);
    reply.header("content-length", String(release.file_size_bytes));
    return reply.send(createReadStream(release.storage_path));
  });

  app.get("/api/mobile/chart", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("Tenant account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const search = request.query as { moduleCode?: string; symbol?: string; limit?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const symbol = search.symbol ?? "XAUUSD";
    const timeframe = 5;
    const limit = Math.min(Math.max(Number(search.limit ?? 120), 40), 300);
    const moduleAccess = await query(
      `SELECT 1
       FROM tenant_modules tm
       JOIN platform_strategy_modules m ON m.id = tm.module_id
       WHERE tm.tenant_id = $1 AND m.code = $2 AND tm.status = 'ENABLED' AND m.status = 'ACTIVE'
       LIMIT 1`,
      [session.tenantId, moduleCode]
    );
    if (!moduleAccess.rows[0] && !session.platformSuperAdmin) {
      const error = new Error("Module access denied.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const [candles, setup, trade, openingRanges] = await Promise.all([
      query(
        `SELECT timestamp_utc, open, high, low, close, volume, spread
         FROM candles
         WHERE symbol = $1 AND timeframe_minutes = $2
         ORDER BY timestamp_utc DESC
         LIMIT $3`,
        [symbol, timeframe, limit]
      ),
      query(
        `SELECT id, status, scenario, direction, entry_price, stop_price, target_price, detected_at, final_reason, scenario_flags
         FROM setup_candidates
         WHERE tenant_id = $1 AND module_code = $2
         ORDER BY detected_at DESC
         LIMIT 1`,
        [session.tenantId, moduleCode]
      ),
      query(
        `SELECT t.*, sc.direction, sc.scenario, target_progress.targets
         FROM trades t
         JOIN trade_plans tp ON tp.id = t.trade_plan_id
         JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'targetNumber', ptt.target_number,
             'price', ptt.price,
             'riskMultiple', ptt.risk_multiple,
             'status', ptt.status,
             'hitAt', ptt.hit_at,
             'hitPrice', ptt.hit_price
           ) ORDER BY ptt.target_number) AS targets
           FROM paper_trade_targets ptt
           WHERE ptt.trade_id = t.id
         ) target_progress ON true
         WHERE sc.tenant_id = $1 AND sc.module_code = $2
         ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END, COALESCE(t.opened_at, t.closed_at) DESC
        LIMIT 1`,
        [session.tenantId, moduleCode]
      ),
      moduleCode === "orb_max_options" ? recentOrbRangesForTenant(session.tenantId, 2) : []
    ]);
    const latestSetup = setup.rows[0] ?? null;
    const chartCandles = candles.rows.reverse()
      .map((row: any) => ({
        timestampUtc: row.timestamp_utc,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume == null ? null : Number(row.volume),
        spread: row.spread == null ? null : Number(row.spread)
      }))
      .filter((row: any) => row.timestampUtc && [row.open, row.high, row.low, row.close].every(Number.isFinite));
    return {
      symbol,
      moduleCode,
      timeframeMinutes: timeframe,
      provider: "TWELVE_DATA",
      status: chartCandles.length > 0 ? "CACHE_READY" : "EMPTY_CACHE",
      latestCandleAt: chartCandles[chartCandles.length - 1]?.timestampUtc ?? null,
      candles: chartCandles,
      setup: latestSetup,
      trade: trade.rows[0] ?? null,
      levels: mobileChartLevels(moduleCode, latestSetup, trade.rows[0] ?? null, openingRanges)
    };
  });

  app.get("/api/mobile/dashboard", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) return { user: session, tenant: null, modules: [], notifications: [], clocks: clocks() };
    const [tenant, modules, notifications, supportTickets, supportInfo] = await Promise.all([
      query(
        `SELECT t.*, s.status AS subscription_status, p.name AS plan_name
         FROM platform_tenants t
         LEFT JOIN LATERAL (
           SELECT *
           FROM tenant_subscriptions
           WHERE tenant_id = t.id
           ORDER BY created_at DESC
           LIMIT 1
         ) s ON true
         LEFT JOIN subscription_plans p ON p.id = s.plan_id
         WHERE t.id = $1`,
        [session.tenantId]
      ),
      query(
        `SELECT m.code, m.name, m.description, m.target_win_rate, tm.status AS tenant_module_status
         FROM tenant_modules tm
         JOIN platform_strategy_modules m ON m.id = tm.module_id
         WHERE tm.tenant_id = $1 AND tm.status = 'ENABLED' AND m.status = 'ACTIVE'
         ORDER BY m.sort_order`,
        [session.tenantId]
      ),
      query(
        `SELECT *
         FROM notifications
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [session.tenantId]
      ),
      query(
        `SELECT st.*, m.name AS requested_module_name
         FROM platform_support_tickets st
         LEFT JOIN platform_strategy_modules m ON m.code = st.requested_module_code
         WHERE st.tenant_id = $1
         ORDER BY st.created_at DESC
         LIMIT 20`,
        [session.tenantId]
      ),
      query("SELECT value FROM app_settings WHERE key = 'platform.business' LIMIT 1")
    ]);
    const moduleRows = [];
    for (const module of modules.rows as any[]) {
      const [setup, trade, weekly, monthly, latestSession] = await Promise.all([
        query(
          `SELECT
             sc.id, sc.status, sc.scenario, sc.direction, sc.favorability_score, sc.favorability_grade,
             sc.entry_price, sc.stop_price, sc.target_price, sc.final_reason, sc.detected_at, sc.scenario_flags,
             COALESCE(
               json_agg(sre ORDER BY sre.evaluated_at) FILTER (WHERE sre.id IS NOT NULL),
               '[]'::json
             ) AS evaluations
           FROM setup_candidates sc
           LEFT JOIN setup_rule_evaluations sre ON sre.setup_candidate_id = sc.id
           WHERE sc.tenant_id = $1 AND sc.module_code = $2
           GROUP BY sc.id
           ORDER BY sc.detected_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        ),
        query(
          `SELECT t.*, sc.direction, sc.scenario, sc.module_code, target_progress.targets
           FROM trades t
           JOIN trade_plans tp ON tp.id = t.trade_plan_id
           JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(jsonb_build_object(
               'targetNumber', ptt.target_number,
               'price', ptt.price,
               'riskMultiple', ptt.risk_multiple,
               'status', ptt.status,
               'hitAt', ptt.hit_at,
               'hitPrice', ptt.hit_price
             ) ORDER BY ptt.target_number) AS targets
             FROM paper_trade_targets ptt
             WHERE ptt.trade_id = t.id
           ) target_progress ON true
           WHERE sc.tenant_id = $1 AND sc.module_code = $2
           ORDER BY CASE WHEN t.outcome = 'ACTIVE' THEN 0 ELSE 1 END, COALESCE(t.opened_at, t.closed_at) DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        ),
        modulePerformance(session.tenantId, module.code, "week"),
        modulePerformance(session.tenantId, module.code, "month"),
        query(
          `SELECT state, session_start_at, opening_range_end_at, signal_window_end_at
           FROM trading_sessions
           WHERE tenant_id = $1 AND module_code = $2
           ORDER BY session_date DESC, created_at DESC
           LIMIT 1`,
          [session.tenantId, module.code]
        )
      ]);
      moduleRows.push({
        ...module,
        shortName: moduleShortName(module.code),
        timeframeMinutes: 5,
        currentSetup: setup.rows[0] ?? null,
        currentTrade: trade.rows[0] ?? null,
        weekly,
        monthly,
        session: latestSession.rows[0] ?? null
      });
    }
    return {
      user: session,
      tenant: tenant.rows[0] ?? null,
      clocks: clocks(),
      modules: moduleRows,
      notifications: notifications.rows,
      supportTickets: supportTickets.rows,
      supportInfo: normalizeSupportInfo(supportInfo.rows[0]?.value)
    };
  });

  app.post("/api/mobile/push-token", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("Tenant account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body as { expoPushToken?: string; fcmToken?: string; platform?: string; deviceName?: string };
    if (!body.expoPushToken && !body.fcmToken) {
      const error = new Error("expoPushToken or fcmToken is required.") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    return registerMobilePushToken({
      tenantId: session.tenantId,
      adminUserId: session.sub,
      expoPushToken: body.expoPushToken,
      fcmToken: body.fcmToken,
      platform: body.platform,
      deviceName: body.deviceName
    });
  });

  app.get("/api/mobile/push-status", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("Tenant account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const [{ rows }, deliveryLogs] = await Promise.all([
      query(
      `SELECT id, platform, device_name, enabled, preferences, expo_push_token, fcm_token, push_provider, last_seen_at, created_at
       FROM mobile_push_tokens
       WHERE tenant_id = $1 AND admin_user_id = $2
       ORDER BY enabled DESC, last_seen_at DESC
       LIMIT 10`,
        [session.tenantId, session.sub]
      ),
      query(
        `SELECT event_key, event_type, preference_key, status, provider_status, error, created_at
         FROM mobile_push_delivery_logs
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 12`,
        [session.tenantId]
      )
    ]);
    const activeDevices = rows.filter((row: any) => row.enabled === true);
    return {
      registered: activeDevices.length > 0,
      activeDevices: activeDevices.length,
      latestDevice: activeDevices[0] ?? rows[0] ?? null,
      preferences: normalizePushPreferences(activeDevices[0]?.preferences ?? rows[0]?.preferences),
      devices: rows.map((row: any) => ({
        id: row.id,
        platform: row.platform,
        deviceName: row.device_name,
        enabled: row.enabled,
        provider: row.push_provider,
        hasExpoToken: Boolean(row.expo_push_token),
        hasFcmToken: Boolean(row.fcm_token),
        preferences: normalizePushPreferences(row.preferences),
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at
      })),
      deliveryLogs: deliveryLogs.rows
    };
  });

  app.put("/api/mobile/push-preferences", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("Tenant account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body as { preferences?: Record<string, unknown> };
    const preferences = normalizePushPreferences(body.preferences);
    const { rows } = await query(
      `UPDATE mobile_push_tokens
       SET preferences = $3::jsonb, last_seen_at = now()
       WHERE tenant_id = $1 AND admin_user_id = $2 AND enabled = true
       RETURNING id, preferences, last_seen_at`,
      [session.tenantId, session.sub, JSON.stringify(preferences)]
    );
    return {
      updated: rows.length,
      preferences,
      devices: rows
    };
  });

  app.post("/api/mobile/test-push", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) {
      const error = new Error("Tenant account required.") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const eventKey = `mobile-test-push-${session.sub}-${Date.now()}`;
    const title = "XAUUSD Signal test alert";
    const body = "Push notifications are connected for this mobile device.";
    const notification = await query(
      `INSERT INTO notifications (tenant_id, event_key, event_type, title, body, priority)
       VALUES ($1,$2,'MOBILE_TEST_PUSH',$3,$4,'LOW')
       RETURNING id, created_at`,
      [session.tenantId, eventKey, title, body]
    );
    const push = await sendTenantPush({
      tenantId: session.tenantId,
      title,
      body,
      eventKey,
      eventType: "MOBILE_TEST_PUSH",
      force: true,
      data: { eventKey, eventType: "MOBILE_TEST_PUSH", notificationId: notification.rows[0]?.id ?? null }
    });
    return {
      notification: notification.rows[0] ?? null,
      push
    };
  });

  app.delete("/api/mobile/push-token", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) return { disabled: 0 };
    const body = request.body as { expoPushToken?: string };
    if (!body.expoPushToken) return { disabled: 0 };
    return disableMobilePushToken(session.tenantId, body.expoPushToken);
  });

  app.delete("/api/mobile/push-devices/:id", async (request) => {
    const session = requireAdmin(request);
    if (!session.tenantId) return { disabled: 0 };
    const { id } = request.params as { id: string };
    const { rows } = await query(
      `UPDATE mobile_push_tokens
       SET enabled = false, last_seen_at = now()
       WHERE id = $1 AND tenant_id = $2 AND admin_user_id = $3
       RETURNING id`,
      [id, session.tenantId, session.sub]
    );
    return { disabled: rows.length };
  });
}

function absoluteApiUrl(path: string, request?: { headers?: Record<string, string | string[] | undefined>; protocol?: string }) {
  const base = process.env.PUBLIC_API_BASE_URL || process.env.PUBLIC_WEB_BASE_URL || "";
  if (base) return `${base.replace(/\/$/, "")}${path}`;
  const headers = request?.headers ?? {};
  const host = String(headers["x-forwarded-host"] ?? headers.host ?? "");
  const protocol = String(headers["x-forwarded-proto"] ?? request?.protocol ?? "https").split(",")[0] || "https";
  return host ? `${protocol}://${host.replace(/\/$/, "")}${path}` : path;
}

function isNewerRelease(latestVersion: string, latestCode: number | null, currentVersion?: string, currentCode?: string) {
  const latestCodeNumber = Number(latestCode);
  const currentCodeNumber = Number(currentCode);
  if (Number.isFinite(latestCodeNumber) && Number.isFinite(currentCodeNumber)) return latestCodeNumber > currentCodeNumber;
  if (!currentVersion) return true;
  return compareVersions(latestVersion, currentVersion) > 0;
}

function compareVersions(left: string, right: string) {
  const leftParts = String(left).split(/[.+-]/).map((part) => Number(part));
  const rightParts = String(right).split(/[.+-]/).map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

async function modulePerformance(tenantId: string, moduleCode: string, period: "week" | "month") {
  const { rows } = await query(
    `SELECT
       count(t.id)::int AS trades,
       count(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
       count(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses,
       count(t.id) FILTER (WHERE t.outcome = 'BREAKEVEN')::int AS breakeven,
       count(t.id) FILTER (WHERE t.outcome = 'ACTIVE')::int AS active,
       COALESCE(sum(t.result_r), 0)::float AS total_r
     FROM trades t
     JOIN trade_plans tp ON tp.id = t.trade_plan_id
     JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
     WHERE sc.tenant_id = $1
       AND sc.module_code = $2
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       AND COALESCE(t.closed_at, t.opened_at) >= date_trunc($3, now())`,
    [tenantId, moduleCode, period]
  );
  const row = rows[0] ?? {};
  const decided = Number(row.wins ?? 0) + Number(row.losses ?? 0) + Number(row.breakeven ?? 0);
  return {
    trades: Number(row.trades ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    breakeven: Number(row.breakeven ?? 0),
    active: Number(row.active ?? 0),
    totalR: Number(row.total_r ?? 0),
    winRate: decided > 0 ? Number(row.wins ?? 0) / decided : 0
  };
}

function moduleShortName(moduleCode: string) {
  if (moduleCode === "orb_max_options") return "Module 1 ORB";
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Ultimate Sweep";
  return "Strategy Module";
}

function normalizePushPreferences(input?: Record<string, unknown> | null) {
  const defaults = {
    nyPreSession: true,
    validEntries: true,
    paperTradeOpened: true,
    takeProfitStopLoss: true,
    dailyReports: true,
    weeklyMonthlyReports: true,
    learningReviews: false,
    systemDiagnostics: false
  };
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof source[key] === "boolean" ? source[key] : value]));
}

function normalizeSupportInfo(input?: Record<string, unknown> | null) {
  const source = input && typeof input === "object" ? input : {};
  return {
    brandName: typeof source.brandName === "string" ? source.brandName : "XAUUSD Signal",
    supportPhone: typeof source.supportPhone === "string" ? source.supportPhone : "",
    supportEmail: typeof source.supportEmail === "string" ? source.supportEmail : "",
    businessAddress: typeof source.businessAddress === "string" ? source.businessAddress : "",
    websiteUrl: typeof source.websiteUrl === "string" ? source.websiteUrl : "",
    whatsappUrl: typeof source.whatsappUrl === "string" ? source.whatsappUrl : "",
    supportHours: typeof source.supportHours === "string" ? source.supportHours : "",
    helpText: typeof source.helpText === "string" ? source.helpText : ""
  };
}

function mobileChartLevels(moduleCode: string, setup?: any, trade?: any, openingRanges?: any[]) {
  const levels = [];
  if (moduleCode === "orb_max_options" && openingRanges?.length) {
    for (const range of openingRanges.slice(0, 2)) {
      const prefix = mobileOrbShortLabel(range.session_preset);
      levels.push({ label: `${prefix} ORB High`, price: Number(range.high), tone: "warn" });
      levels.push({ label: `${prefix} ORB Mid`, price: Number(range.midpoint), tone: "neutral" });
      levels.push({ label: `${prefix} ORB Low`, price: Number(range.low), tone: "warn" });
    }
  }
  const entry = Number(trade?.actual_entry ?? setup?.entry_price);
  const stop = Number(trade?.actual_stop ?? setup?.stop_price);
  const targetValue = trade?.actual_target ?? setup?.target_price ?? setup?.take_profit;
  const target = targetValue == null ? Number.NaN : Number(targetValue);
  const direction = String(trade?.direction ?? setup?.direction ?? "").toUpperCase();
  if (Number.isFinite(entry)) levels.push({ label: "Entry", price: entry, tone: "entry" });
  if (Number.isFinite(stop)) levels.push({ label: "SL", price: stop, tone: "bad" });
  const persistedTargets = Array.isArray(trade?.targets) ? trade.targets : [];
  const targets = persistedTargets.length > 0
    ? persistedTargets.map((item: any) => ({
        riskMultiple: Number(item.riskMultiple),
        price: Number(item.price),
        status: String(item.status ?? "PENDING")
      }))
    : mobileRiskTargets(entry, stop, target, direction);
  for (const [index, targetLevel] of targets.entries()) {
    const progress = targetLevel.status === "HIT" ? " HIT" : targetLevel.status === "CANCELLED" ? " CLOSED" : "";
    levels.push({ label: `TP${index + 1} ${targetLevel.riskMultiple}R${progress}`, price: targetLevel.price, tone: "good" });
  }
  const flags = setup?.scenario_flags ?? {};
  if (moduleCode === "high_probability_strategy_2") {
    const sweepLevel = flags.sweep?.level;
    const bosLevel = flags.bos?.level;
    const displacementPrice = flags.displacement?.candle?.close ?? flags.displacement?.close;
    if (sweepLevel?.price != null) levels.push({ label: `${formatLevelLabel(sweepLevel.type, "Liquidity")}`, price: Number(sweepLevel.price), tone: "warn" });
    if (flags.sweep?.candle?.high != null) levels.push({ label: "Sweep High", price: Number(flags.sweep.candle.high), tone: "bad" });
    if (flags.sweep?.candle?.low != null) levels.push({ label: "Sweep Low", price: Number(flags.sweep.candle.low), tone: "bad" });
    if (bosLevel != null) levels.push({ label: "BOS / CHoCH", price: Number(bosLevel), tone: "entry" });
    if (displacementPrice != null) levels.push({ label: "Displacement", price: Number(displacementPrice), tone: "entry" });
  }
  const zone = flags.entryZone ?? flags.pullbackZone;
  if (zone?.low != null && zone?.high != null) {
    const zoneName = zone.kind === "ORDER_BLOCK" ? "OB" : "FVG";
    levels.push({ label: `${zoneName} Low`, price: Number(zone.low), tone: "neutral" });
    if (zone.midpoint != null) levels.push({ label: `${zoneName} Mid`, price: Number(zone.midpoint), tone: "neutral" });
    levels.push({ label: `${zoneName} High`, price: Number(zone.high), tone: "neutral" });
  }
  return dedupeMobileLevels(levels.filter((level) => Number.isFinite(level.price)));
}

function mobileRiskTargets(entry: number, stop: number, target: number, direction: string) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !["LONG", "SHORT", "BUY", "SELL"].includes(direction)) return [];
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) return [];
  const multiplier = direction === "SHORT" || direction === "SELL" ? -1 : 1;
  const targetIsDirectional = Number.isFinite(target) && (target - entry) * multiplier > 0;
  const finalTarget = targetIsDirectional ? target : entry + multiplier * riskDistance * 2;
  const finalR = Math.abs(finalTarget - entry) / riskDistance;
  return [Math.min(1, finalR), Math.min(1.5, finalR), finalR].map((riskMultiple) => ({
    riskMultiple: Number(riskMultiple.toFixed(2)),
    price: Number((entry + multiplier * riskDistance * riskMultiple).toFixed(2))
  }));
}

function mobileOrbShortLabel(preset?: string | null) {
  if (preset === "SYDNEY_ORB") return "SY";
  if (preset === "TOKYO_ORB") return "TY";
  if (preset === "LONDON_ORB") return "LN";
  if (preset === "NEW_YORK_ORB" || preset === "NY_0915" || preset === "NY_0930") return "NY";
  return "ORB";
}

function formatLevelLabel(value: unknown, fallback: string) {
  const text = String(value ?? fallback).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
  return text || fallback;
}

function dedupeMobileLevels(levels: Array<{ label: string; price: number; tone: string }>) {
  const seen = new Set<string>();
  const output = [];
  for (const level of levels) {
    const key = `${level.label}:${level.price.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(level);
  }
  return output;
}
