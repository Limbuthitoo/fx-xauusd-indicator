import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const envFile = process.argv[2] ?? ".env.production";
const errors = [];
const warnings = [];

if (!existsSync(envFile)) {
  errors.push(`${envFile} does not exist. Copy .env.production.example first.`);
} else {
  const env = parseEnv(readFileSync(envFile, "utf8"));
  required(env, "POSTGRES_PASSWORD");
  required(env, "ADMIN_EMAIL");
  required(env, "ADMIN_PASSWORD");
  required(env, "ADMIN_SESSION_SECRET");
  required(env, "PUBLIC_API_BASE_URL");
  required(env, "TWELVE_DATA_API_KEY");
  for (const [key, value] of Object.entries(env)) {
    if (isPlaceholder(value)) errors.push(`${key} still contains a placeholder value.`);
  }
  if (env.REDIS_REQUIRED !== "true") errors.push("REDIS_REQUIRED must be true.");
  if (env.EMBEDDED_MARKET_DATA_WORKER === "true") errors.push("EMBEDDED_MARKET_DATA_WORKER must be false.");
  if ((env.TWELVE_DATA_INTERVAL ?? "5min") !== "5min") errors.push("TWELVE_DATA_INTERVAL must be 5min.");
  if (!isAtLeast(env.TWELVE_DATA_POLL_SECONDS ?? "300", 300)) errors.push("TWELVE_DATA_POLL_SECONDS must be at least 300.");
  if (!isAtLeast(env.TWELVE_DATA_CATCHUP_SECONDS ?? "300", 300)) errors.push("TWELVE_DATA_CATCHUP_SECONDS must be at least 300.");
  if ((env.PUSH_PROVIDER ?? "auto") === "firebase" && !hasFirebase(env)) {
    errors.push("PUSH_PROVIDER=firebase requires Firebase service account credentials.");
  }
  if (!env.EXPO_PUBLIC_API_BASE_URL) warnings.push("EXPO_PUBLIC_API_BASE_URL is not set for mobile builds.");
  if (!env.EXPO_PUBLIC_EAS_PROJECT_ID) warnings.push("EXPO_PUBLIC_EAS_PROJECT_ID is not set for APK push identity.");
  if (String(env.PUBLIC_API_BASE_URL ?? "").includes("localhost")) warnings.push("PUBLIC_API_BASE_URL still points to localhost.");
}

checkCommand("docker", ["--version"], "Docker is not available.");
checkCommand("npm", ["--version"], "npm is not available.");
checkOptional("nginx", ["-v"], "Nginx is not installed yet. Install it before enabling nginx/xauusd-signal.conf.");

if (!existsSync("ecosystem.config.cjs")) errors.push("ecosystem.config.cjs is missing.");
if (!existsSync("nginx/xauusd-signal.conf")) errors.push("nginx/xauusd-signal.conf is missing.");
if (!existsSync("docker-compose.prod.yml")) errors.push("docker-compose.prod.yml is missing.");
if (!existsSync("deploy/systemd/xauusd-backup.service")) errors.push("deploy/systemd/xauusd-backup.service is missing.");
if (!existsSync("deploy/systemd/xauusd-backup.timer")) errors.push("deploy/systemd/xauusd-backup.timer is missing.");

if (errors.length > 0) {
  console.error("VPS preflight failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

console.log(JSON.stringify({ status: "OK", envFile, warnings }, null, 2));

function required(env, key) {
  if (!env[key] || String(env[key]).includes("change-this")) errors.push(`${key} is required and must not be a placeholder.`);
}

function hasFirebase(env) {
  return Boolean(
    env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY)
  );
}

function isPlaceholder(value) {
  const text = String(value ?? "");
  return text.includes("change-this") || text.includes("CHANGE_ME") || text.includes("example.com");
}

function isAtLeast(value, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum;
}

function checkCommand(command, args, error) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    errors.push(error);
  }
}

function checkOptional(command, args, warning) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
  } catch {
    warnings.push(warning);
  }
}

function parseEnv(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    env[trimmed.slice(0, separator)] = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, "");
  }
  return env;
}
