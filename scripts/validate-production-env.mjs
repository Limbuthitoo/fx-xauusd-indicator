import { existsSync, readFileSync } from "node:fs";

const envFile = process.argv[2] ?? ".env.production.example";
const allowPlaceholders = process.argv.includes("--allow-placeholders");

if (!existsSync(envFile)) {
  fail([`Environment file not found: ${envFile}`]);
}

const env = parseEnv(readFileSync(envFile, "utf8"));
const errors = [];

required("POSTGRES_PASSWORD");
required("LOCAL_PIN");
required("ADMIN_EMAIL");
required("ADMIN_PASSWORD");
required("ADMIN_SESSION_SECRET");
required("PUBLIC_API_BASE_URL");
required("TWELVE_DATA_API_KEY");

if (!allowPlaceholders) {
  for (const key of ["POSTGRES_PASSWORD", "LOCAL_PIN", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "TWELVE_DATA_API_KEY"]) {
    if (isPlaceholder(env[key])) errors.push(`${key} still contains a placeholder value.`);
  }
  const passwordError = validateStrongPassword(env.ADMIN_PASSWORD ?? "");
  if (passwordError) errors.push(`ADMIN_PASSWORD ${passwordError}`);
  if ((env.ADMIN_SESSION_SECRET ?? "").length < 32) errors.push("ADMIN_SESSION_SECRET must be at least 32 characters.");
}

if (env.REDIS_REQUIRED !== "true") errors.push("REDIS_REQUIRED must be true in production.");
if (env.EMBEDDED_MARKET_DATA_WORKER === "true") errors.push("EMBEDDED_MARKET_DATA_WORKER must stay false in production.");
if ((env.PUSH_PROVIDER ?? "auto") === "firebase" && !hasFirebaseCredentials()) {
  errors.push("PUSH_PROVIDER=firebase requires FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON, or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.");
}

const daily = numberValue("TWELVE_DATA_DAILY_CREDIT_LIMIT");
const minute = numberValue("TWELVE_DATA_MINUTE_CREDIT_LIMIT");
const warn = numberValue("TWELVE_DATA_WARN_CREDITS");
const danger = numberValue("TWELVE_DATA_DANGER_CREDITS");
const stop = numberValue("TWELVE_DATA_STOP_CREDITS");
const interval = env.TWELVE_DATA_INTERVAL ?? "5min";
const pollSeconds = Number(env.TWELVE_DATA_POLL_SECONDS ?? 300);
const catchupSeconds = Number(env.TWELVE_DATA_CATCHUP_SECONDS ?? 300);
if (!(warn < danger && danger < stop && stop < daily)) errors.push("Twelve Data thresholds must satisfy warn < danger < stop < daily.");
if (minute > 8) errors.push("TWELVE_DATA_MINUTE_CREDIT_LIMIT should not exceed Twelve Data free limit of 8/minute.");
if (interval !== "5min") errors.push("TWELVE_DATA_INTERVAL must be 5min for the shared completed-candle feed.");
if (!Number.isFinite(pollSeconds) || pollSeconds < 300) errors.push("TWELVE_DATA_POLL_SECONDS must be at least 300 seconds.");
if (!Number.isFinite(catchupSeconds) || catchupSeconds < 300) errors.push("TWELVE_DATA_CATCHUP_SECONDS must be at least 300 seconds.");

if (errors.length) fail(errors);

console.log(JSON.stringify({
  status: "OK",
  envFile,
  redisRequired: env.REDIS_REQUIRED,
  twelveData: { daily, minute, warn, danger, stop, interval, pollSeconds, catchupSeconds },
  workerFirst: env.EMBEDDED_MARKET_DATA_WORKER !== "true",
  pushProvider: env.PUSH_PROVIDER ?? "auto"
}, null, 2));

function required(key) {
  if (!env[key]) errors.push(`${key} is required.`);
}

function isPlaceholder(value) {
  const text = String(value ?? "");
  return text.includes("change-this") || text.includes("CHANGE_ME") || text.includes("example.com");
}

function validateStrongPassword(password) {
  if (password.length < 12) return "must be at least 12 characters.";
  if (!/[a-z]/.test(password)) return "must include a lowercase letter.";
  if (!/[A-Z]/.test(password)) return "must include an uppercase letter.";
  if (!/[0-9]/.test(password)) return "must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "must include a symbol.";
  if (/change-this|password|admin|1234/i.test(password)) return "contains a blocked weak phrase.";
  return null;
}

function numberValue(key) {
  const value = Number(env[key]);
  if (!Number.isFinite(value)) errors.push(`${key} must be a number.`);
  return value;
}

function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function hasFirebaseCredentials() {
  return Boolean(
    env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY)
  );
}

function fail(items) {
  console.error("Production environment validation failed:");
  for (const item of items) console.error(`- ${item}`);
  process.exit(1);
}
