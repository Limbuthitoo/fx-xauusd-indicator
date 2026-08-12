import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { existsSync, readFileSync } from "node:fs";
import { config } from "../../infrastructure/config.js";
import { query } from "../../infrastructure/db/client.js";

type PushInput = {
  tenantId: string | null;
  title: string;
  body: string;
  eventKey?: string | null;
  eventType?: string | null;
  preferenceKey?: keyof PushPreferences | null;
  force?: boolean;
  data?: Record<string, unknown>;
};

type PushPreferences = {
  nyPreSession: boolean;
  validEntries: boolean;
  paperTradeOpened: boolean;
  takeProfitStopLoss: boolean;
  dailyReports: boolean;
  weeklyMonthlyReports: boolean;
  learningReviews: boolean;
  systemDiagnostics: boolean;
};

const defaultPushPreferences: PushPreferences = {
  nyPreSession: true,
  validEntries: true,
  paperTradeOpened: true,
  takeProfitStopLoss: true,
  dailyReports: true,
  weeklyMonthlyReports: true,
  learningReviews: false,
  systemDiagnostics: false
};

export async function registerMobilePushToken(input: {
  tenantId: string;
  adminUserId: string;
  expoPushToken?: string | null;
  fcmToken?: string | null;
  platform?: string | null;
  deviceName?: string | null;
}) {
  const provider = input.fcmToken ? "FIREBASE" : "EXPO";
  if (input.fcmToken) {
    const existing = await query(
      `UPDATE mobile_push_tokens
       SET admin_user_id = $3,
           expo_push_token = COALESCE($4, expo_push_token),
           push_provider = 'FIREBASE',
           platform = $5,
           device_name = $6,
           enabled = true,
           last_seen_at = now()
       WHERE tenant_id = $1 AND fcm_token = $2
       RETURNING id, expo_push_token, fcm_token, push_provider, platform, device_name, enabled, preferences, last_seen_at`,
      [input.tenantId, input.fcmToken, input.adminUserId, input.expoPushToken ?? null, input.platform ?? null, input.deviceName ?? null]
    );
    if (existing.rows[0]) return existing.rows[0];
  }
  const { rows } = await query(
    `INSERT INTO mobile_push_tokens (
       tenant_id, admin_user_id, expo_push_token, fcm_token, push_provider, platform, device_name, enabled, last_seen_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,now())
     ON CONFLICT (tenant_id, expo_push_token) DO UPDATE SET
       admin_user_id = EXCLUDED.admin_user_id,
       fcm_token = COALESCE(EXCLUDED.fcm_token, mobile_push_tokens.fcm_token),
       push_provider = EXCLUDED.push_provider,
       platform = EXCLUDED.platform,
       device_name = EXCLUDED.device_name,
       enabled = true,
       last_seen_at = now()
     RETURNING id, expo_push_token, fcm_token, push_provider, platform, device_name, enabled, preferences, last_seen_at`,
    [input.tenantId, input.adminUserId, input.expoPushToken ?? `fcm:${input.fcmToken}`, input.fcmToken ?? null, provider, input.platform ?? null, input.deviceName ?? null]
  );
  return rows[0];
}

export async function disableMobilePushToken(tenantId: string, expoPushToken: string) {
  const { rows } = await query(
    `UPDATE mobile_push_tokens
     SET enabled = false, last_seen_at = now()
     WHERE tenant_id = $1 AND expo_push_token = $2
     RETURNING id`,
    [tenantId, expoPushToken]
  );
  return { disabled: rows.length };
}

export async function sendTenantPush(input: PushInput) {
  if (!input.tenantId) return { sent: 0, skipped: true };
  const eventType = String(input.eventType ?? input.data?.eventType ?? "");
  const eventKey = String(input.eventKey ?? input.data?.eventKey ?? "");
  const preferenceKey = input.preferenceKey ?? pushPreferenceForEvent(eventType);
  const { rows } = await query(
    `SELECT id, expo_push_token, fcm_token, push_provider, preferences
     FROM mobile_push_tokens
     WHERE tenant_id = $1 AND enabled = true
     ORDER BY last_seen_at DESC
     LIMIT 25`,
    [input.tenantId]
  );
  const eligibleRows = rows.filter((row: any) => {
    const token = String(row.expo_push_token ?? "");
    const hasExpoToken = /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token);
    const hasFcmToken = typeof row.fcm_token === "string" && row.fcm_token.length > 20;
    if (!hasExpoToken && !hasFcmToken) return false;
    if (input.force || !preferenceKey) return true;
    const preferences = normalizePushPreferences(row.preferences);
    return preferences[preferenceKey] !== false;
  });
  const skippedByPreference = rows.length - eligibleRows.length;
  const hasValidToken = rows.some((row: any) => {
    const token = String(row.expo_push_token ?? "");
    return /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)
      || (typeof row.fcm_token === "string" && row.fcm_token.length > 20);
  });
  const firebaseRows = firebaseEnabled()
    ? eligibleRows.filter((row: any) => row.fcm_token && ["auto", "firebase"].includes(config.pushProvider))
    : [];
  const expoRows = eligibleRows.filter((row: any) => {
    if (config.pushProvider === "firebase") return false;
    if (firebaseRows.some((firebaseRow: any) => firebaseRow.id === row.id)) return false;
    return /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(String(row.expo_push_token ?? ""));
  });
  const messages = expoRows.map((row: any) => ({
    to: row.expo_push_token,
    sound: "default",
    title: input.title,
    body: input.body,
    data: input.data ?? {}
  }));
  if (firebaseRows.length === 0 && messages.length === 0) {
    const skipStatus = hasValidToken && !input.force ? "PREFERENCE_DISABLED" : "NO_VALID_TOKEN";
    await logSkippedPushes(rows, input.tenantId, eventKey, eventType, preferenceKey ?? null, skipStatus);
    return { sent: 0, skipped: true, preferenceKey, skippedByPreference };
  }
  const firebaseResult = firebaseRows.length > 0
    ? await sendFirebasePushes({ ...input, tenantId: input.tenantId, eventKey, eventType, preferenceKey: preferenceKey ?? null, rows: firebaseRows })
    : { sent: 0 };
  if (messages.length === 0) {
    return { sent: firebaseResult.sent, firebase: firebaseResult, preferenceKey, skippedByPreference };
  }
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(messages)
    });
    const payload = await response.json().catch(() => null);
    await logPushDeliveries({
      tenantId: input.tenantId,
      rows: expoRows,
      eventKey,
      eventType,
      preferenceKey: preferenceKey ?? null,
      status: response.ok ? "SENT" : "FAILED",
      providerStatus: response.status,
      providerResponse: payload
    });
    await disableUnregisteredTokens(input.tenantId, expoRows, payload);
    return { sent: messages.length + Number(firebaseResult.sent ?? 0), ok: response.ok, status: response.status, preferenceKey, skippedByPreference, provider: payload, firebase: firebaseResult };
  } catch (error) {
    await logPushDeliveries({
      tenantId: input.tenantId,
      rows: expoRows,
      eventKey,
      eventType,
      preferenceKey: preferenceKey ?? null,
      status: "ERROR",
      error: (error as Error).message
    });
    return { sent: Number(firebaseResult.sent ?? 0), error: (error as Error).message, preferenceKey, skippedByPreference, firebase: firebaseResult };
  }
}

export function pushProviderHealth() {
  const firebaseConfigured = firebaseEnabled();
  let firebaseStatus = firebaseConfigured ? "CONFIGURED" : "NOT_CONFIGURED";
  let firebaseError: string | null = null;
  if (firebaseConfigured) {
    try {
      firebaseApp();
    } catch (error) {
      firebaseStatus = "INVALID";
      firebaseError = (error as Error).message;
    }
  }
  return {
    provider: config.pushProvider,
    firebase: {
      status: firebaseStatus,
      configured: firebaseConfigured,
      projectId: config.firebaseProjectId || firebaseCredentialProjectId(),
      serviceAccountPath: config.firebaseServiceAccountPath || null,
      error: firebaseError
    },
    expo: {
      fallbackEnabled: config.pushProvider !== "firebase"
    }
  };
}

async function sendFirebasePushes(input: PushInput & { tenantId: string; eventKey: string; eventType: string; preferenceKey: string | null; rows: any[] }) {
  try {
    const app = firebaseApp();
    if (!app) return { sent: 0, skipped: true, reason: "FIREBASE_NOT_CONFIGURED" };
    const messaging = getMessaging(app);
    let sent = 0;
    for (const row of input.rows) {
      try {
        const response = await messaging.send({
          token: row.fcm_token,
          notification: { title: input.title, body: input.body },
          data: stringifyData({
            ...(input.data ?? {}),
            eventKey: input.eventKey,
            eventType: input.eventType
          }),
          android: {
            priority: "high",
            notification: {
              channelId: "trading-alerts",
              sound: "default"
            }
          }
        });
        sent += 1;
        await logPushDeliveries({
          tenantId: input.tenantId,
          rows: [row],
          eventKey: input.eventKey,
          eventType: input.eventType,
          preferenceKey: input.preferenceKey,
          status: "FIREBASE_SENT",
          providerResponse: { messageId: response }
        });
      } catch (error) {
        const message = (error as Error).message;
        await logPushDeliveries({
          tenantId: input.tenantId,
          rows: [row],
          eventKey: input.eventKey,
          eventType: input.eventType,
          preferenceKey: input.preferenceKey,
          status: "FIREBASE_ERROR",
          error: message
        });
        if (/registration-token-not-registered|not registered/i.test(message)) {
          await disableMobilePushToken(input.tenantId, row.expo_push_token);
        }
      }
    }
    return { sent };
  } catch (error) {
    await logPushDeliveries({
      tenantId: input.tenantId,
      rows: input.rows,
      eventKey: input.eventKey,
      eventType: input.eventType,
      preferenceKey: input.preferenceKey,
      status: "FIREBASE_ERROR",
      error: (error as Error).message
    });
    return { sent: 0, error: (error as Error).message };
  }
}

function firebaseEnabled() {
  return Boolean(config.firebaseServiceAccountJson || config.firebaseServiceAccountPath || (config.firebaseProjectId && config.firebaseClientEmail && config.firebasePrivateKey));
}

function firebaseApp() {
  if (!firebaseEnabled()) return null;
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({ credential: cert(firebaseCredential()) });
}

function firebaseCredential() {
  if (config.firebaseServiceAccountJson) return JSON.parse(config.firebaseServiceAccountJson);
  if (config.firebaseServiceAccountPath && existsSync(config.firebaseServiceAccountPath)) {
    return JSON.parse(readFileSync(config.firebaseServiceAccountPath, "utf8"));
  }
  return {
    projectId: config.firebaseProjectId,
    clientEmail: config.firebaseClientEmail,
    privateKey: config.firebasePrivateKey
  };
}

function firebaseCredentialProjectId() {
  try {
    const value = firebaseCredential() as any;
    return value.projectId ?? value.project_id ?? "";
  } catch {
    return "";
  }
}

function stringifyData(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

function normalizePushPreferences(input: unknown): PushPreferences {
  const value = input && typeof input === "object" ? input as Partial<PushPreferences> : {};
  return { ...defaultPushPreferences, ...value };
}

function pushPreferenceForEvent(eventType: string): keyof PushPreferences | null {
  if (/NY_PRE_SESSION/.test(eventType)) return "nyPreSession";
  if (/SETUP_READY|SIGNAL|ENTRY_ZONE_READY|ENTRY_CONFIRMATION/.test(eventType)) return "validEntries";
  if (/PAPER_TRADE_OPENED|PAPER_ENTRY/.test(eventType)) return "paperTradeOpened";
  if (/PAPER_TRADE_CLOSED|TP_HIT|SL_HIT|TARGET|STOP/.test(eventType)) return "takeProfitStopLoss";
  if (/DAILY_REPORT|CLOSEOUT/.test(eventType)) return "dailyReports";
  if (/WEEKLY|MONTHLY/.test(eventType)) return "weeklyMonthlyReports";
  if (/LEARNING|RECOMMENDATION|REVIEW/.test(eventType)) return "learningReviews";
  if (/TEST_PUSH|ERROR|FAILED|HEALTH|AUDIT|DIAGNOSTIC|TWELVE_DATA|RANGE_INVALID/.test(eventType)) return "systemDiagnostics";
  return null;
}

async function logSkippedPushes(rows: any[], tenantId: string, eventKey: string, eventType: string, preferenceKey: string | null, status: string) {
  for (const row of rows) {
    await query(
      `INSERT INTO mobile_push_delivery_logs (
        tenant_id, mobile_push_token_id, event_key, event_type, preference_key, expo_push_token, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, row.id ?? null, eventKey || null, eventType || null, preferenceKey, row.expo_push_token ?? null, status]
    );
  }
}

async function logPushDeliveries(input: {
  tenantId: string;
  rows: any[];
  eventKey: string;
  eventType: string;
  preferenceKey: string | null;
  status: string;
  providerStatus?: number;
  providerResponse?: unknown;
  error?: string;
}) {
  for (const row of input.rows) {
    await query(
      `INSERT INTO mobile_push_delivery_logs (
        tenant_id, mobile_push_token_id, event_key, event_type, preference_key,
        expo_push_token, status, provider_status, provider_response, error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [
        input.tenantId,
        row.id ?? null,
        input.eventKey || null,
        input.eventType || null,
        input.preferenceKey,
        row.expo_push_token ?? null,
        input.status,
        input.providerStatus ?? null,
        input.providerResponse == null ? null : JSON.stringify(input.providerResponse),
        input.error ?? null
      ]
    );
  }
}

async function disableUnregisteredTokens(tenantId: string, rows: any[], payload: any) {
  const receipts = Array.isArray(payload?.data) ? payload.data : [];
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (receipt?.details?.error !== "DeviceNotRegistered") continue;
    const row = rows[index];
    if (!row?.expo_push_token) continue;
    await disableMobilePushToken(tenantId, row.expo_push_token);
  }
}
