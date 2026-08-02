import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const envFile = process.argv[2] ?? ".env.production";
const results = [];

checkFile(".env.production.example", "Production env template");
checkFile(envFile, "Local production env");
checkFile("docker-compose.yml", "Base Docker compose");
checkFile("docker-compose.prod.yml", "Production Docker compose");
checkFile("nginx/xauusd-signal.conf", "Nginx app config");
checkFile("nginx/cloudflare-real-ip.conf", "Cloudflare real-IP config");
checkFile("apps/mobile/eas.json", "Mobile EAS config");
checkFile("db/migrations/037_auth_hardening.sql", "Auth hardening migration");

checkCommand("Production env template validation", "npm", ["run", "release:validate-env"]);
checkCommand("Sensitive file guard", "npm", ["run", "release:check-sensitive"]);
checkCommand("Production Docker compose config", "docker", [
  "compose",
  "--env-file",
  ".env.production.example",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.prod.yml",
  "--profile",
  "prod",
  "config",
  "--quiet"
]);

if (existsSync(envFile)) {
  const env = parseEnv(readFileSync(envFile, "utf8"));
  const blockers = productionEnvBlockers(env);
  results.push({
    name: "Production secrets readiness",
    status: blockers.length ? "BLOCKED" : "PASS",
    detail: blockers.length ? blockers : ["All required production secret slots look filled."]
  });
} else {
  results.push({
    name: "Production secrets readiness",
    status: "BLOCKED",
    detail: [`${envFile} does not exist.`]
  });
}

const mobileConfig = existsSync("apps/mobile/eas.json")
  ? JSON.parse(readFileSync("apps/mobile/eas.json", "utf8"))
  : null;
const mobileProductionUrl = mobileConfig?.build?.production?.env?.EXPO_PUBLIC_API_BASE_URL;
results.push({
  name: "Mobile production API URL",
  status: mobileProductionUrl === "https://fx.bijaysubbalimbu.com.np" ? "PASS" : "BLOCKED",
  detail: mobileProductionUrl ?? "Missing production URL"
});

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  envFile,
  summary: {
    pass: results.filter((result) => result.status === "PASS").length,
    blocked: results.filter((result) => result.status === "BLOCKED").length,
    fail: results.filter((result) => result.status === "FAIL").length
  },
  results
}, null, 2));

if (results.some((result) => ["FAIL", "BLOCKED"].includes(result.status))) process.exit(1);

function checkFile(path, name) {
  results.push({
    name,
    status: existsSync(path) ? "PASS" : "FAIL",
    detail: path
  });
}

function checkCommand(name, command, args) {
  try {
    execFileSync(command, args, { stdio: "pipe" });
    results.push({ name, status: "PASS", detail: `${command} ${args.join(" ")}` });
  } catch (error) {
    results.push({
      name,
      status: "FAIL",
      detail: String(error.stderr || error.message).slice(0, 1200)
    });
  }
}

function productionEnvBlockers(env) {
  const required = [
    "POSTGRES_PASSWORD",
    "LOCAL_PIN",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "ADMIN_SESSION_SECRET",
    "PUBLIC_API_BASE_URL",
    "EXPO_PUBLIC_API_BASE_URL",
    "EXPO_PUBLIC_EAS_PROJECT_ID",
    "TWELVE_DATA_API_KEY"
  ];
  const blockers = [];
  for (const key of required) {
    if (!env[key] || isPlaceholder(env[key])) blockers.push(`${key} is missing or placeholder.`);
  }
  if ((env.PUSH_PROVIDER ?? "auto") === "firebase" && !hasFirebase(env)) {
    blockers.push("Firebase service credentials are missing.");
  }
  const passwordError = validateStrongPassword(env.ADMIN_PASSWORD ?? "");
  if (passwordError) blockers.push(`ADMIN_PASSWORD ${passwordError}`);
  if ((env.ADMIN_SESSION_SECRET ?? "").length < 32) blockers.push("ADMIN_SESSION_SECRET must be at least 32 characters.");
  return blockers;
}

function hasFirebase(env) {
  return Boolean(
    env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY && !isPlaceholder(env.FIREBASE_PROJECT_ID) && !isPlaceholder(env.FIREBASE_CLIENT_EMAIL) && !isPlaceholder(env.FIREBASE_PRIVATE_KEY))
  );
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
