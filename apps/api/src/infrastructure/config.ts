import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

export const config = {
  port: Number(process.env.API_PORT ?? 7070),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://orb_user:orb_password@localhost:5433/orb_guide",
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX ?? 8),
  databaseConnectionTimeoutMs: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 10_000),
  databaseIdleTimeoutMs: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
  databaseStatementTimeoutMs: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 12_000),
  databaseQueryTimeoutMs: Number(process.env.DATABASE_QUERY_TIMEOUT_MS ?? 15_000),
  publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL ?? "",
  publicWebBaseUrl: process.env.PUBLIC_WEB_BASE_URL ?? process.env.WEB_BASE_URL ?? "",
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  redisUrl: process.env.REDIS_URL ?? "",
  redisRequired: booleanEnv(process.env.REDIS_REQUIRED, false),
  localPin: process.env.LOCAL_PIN ?? "1234",
  adminEmail: process.env.ADMIN_EMAIL ?? "admin@orb.local",
  adminPassword: process.env.ADMIN_PASSWORD ?? process.env.LOCAL_PIN ?? "1234",
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET ?? "",
  adminTokenTtlMinutes: Number(process.env.ADMIN_TOKEN_TTL_MINUTES ?? 720),
  loginRateLimitWindowSeconds: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_SECONDS ?? 300),
  loginRateLimitMaxAttempts: Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? 5),
  loginRateLimitLockoutSeconds: Number(process.env.LOGIN_RATE_LIMIT_LOCKOUT_SECONDS ?? 900),
  slowRequestThresholdMs: Number(process.env.SLOW_REQUEST_THRESHOLD_MS ?? 1500),
  operationalEventRetentionDays: Number(process.env.OPERATIONAL_EVENT_RETENTION_DAYS ?? 30),
  securityEventRetentionDays: Number(process.env.SECURITY_EVENT_RETENTION_DAYS ?? 90),
  apiUsageRetentionDays: Number(process.env.API_USAGE_RETENTION_DAYS ?? 90),
  workerHeartbeatRetentionDays: Number(process.env.WORKER_HEARTBEAT_RETENTION_DAYS ?? 14),
  backupDir: process.env.BACKUP_DIR ?? "backups/postgres",
  backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 14),
  nodeEnv: process.env.NODE_ENV ?? "development",
  twelveDataApiKey: process.env.TWELVE_DATA_API_KEY ?? "",
  twelveDataSymbol: process.env.TWELVE_DATA_SYMBOL ?? "XAU/USD",
  twelveDataInterval: process.env.TWELVE_DATA_INTERVAL ?? "5min",
  twelveDataPollSeconds: Number(process.env.TWELVE_DATA_POLL_SECONDS ?? 60),
  autoRunSupervisorSeconds: Math.max(Number(process.env.AUTO_RUN_SUPERVISOR_SECONDS ?? 60), 30),
  embeddedMarketDataWorker: booleanEnv(process.env.EMBEDDED_MARKET_DATA_WORKER, false),
  twelveDataDailyCreditLimit: Number(process.env.TWELVE_DATA_DAILY_CREDIT_LIMIT ?? 800),
  twelveDataMinuteCreditLimit: Number(process.env.TWELVE_DATA_MINUTE_CREDIT_LIMIT ?? 8),
  twelveDataWarnCredits: Number(process.env.TWELVE_DATA_WARN_CREDITS ?? 650),
  twelveDataDangerCredits: Number(process.env.TWELVE_DATA_DANGER_CREDITS ?? 720),
  twelveDataStopCredits: Number(process.env.TWELVE_DATA_STOP_CREDITS ?? 760),
  marketClosedDates: (process.env.MARKET_CLOSED_DATES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  billingProvider: (process.env.BILLING_PROVIDER ?? "manual").toLowerCase(),
  billingWebhookSecret: process.env.BILLING_WEBHOOK_SECRET ?? "",
  billingSuccessUrl: process.env.BILLING_SUCCESS_URL ?? "http://localhost:3000/dashboard?billing=success",
  billingCancelUrl: process.env.BILLING_CANCEL_URL ?? "http://localhost:3000/dashboard?billing=cancel",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  paddleApiKey: process.env.PADDLE_API_KEY ?? "",
  paddleWebhookSecret: process.env.PADDLE_WEBHOOK_SECRET ?? "",
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "",
  firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL ?? "",
  firebasePrivateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "",
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "",
  pushProvider: (process.env.PUSH_PROVIDER ?? "auto").toLowerCase()
};

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function loadDotEnv() {
  const currentFile = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(currentFile, "../../../../.env")
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (process.env[key] != null) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}
