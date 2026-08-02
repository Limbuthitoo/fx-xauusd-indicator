import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const envFile = valueAfter("--env") ?? ".env.production";
const exampleFile = valueAfter("--example") ?? ".env.production.example";
const force = args.includes("--force");

if (!existsSync(exampleFile)) {
  console.error(`Production env template not found: ${exampleFile}`);
  process.exit(1);
}

const exampleContent = readFileSync(exampleFile, "utf8");
const existingContent = existsSync(envFile) ? readFileSync(envFile, "utf8") : exampleContent;
const exampleEnv = parseEnv(exampleContent);
const existingEnv = parseEnv(existingContent);
const nextEnv = { ...exampleEnv, ...existingEnv };

const generated = [];
setGenerated("POSTGRES_PASSWORD", () => randomSecret(36));
setGenerated("LOCAL_PIN", () => randomSecret(24));
setGenerated("ADMIN_PASSWORD", () => `Fx!${randomSecret(22)}9Aa`);
setGenerated("ADMIN_SESSION_SECRET", () => randomSecret(64));

const content = renderEnv(exampleContent, nextEnv, existingEnv);
writeFileSync(envFile, content);

const placeholders = [
  "ADMIN_EMAIL",
  "TWELVE_DATA_API_KEY",
  "EXPO_PUBLIC_EAS_PROJECT_ID",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
].filter((key) => isPlaceholder(nextEnv[key]));

console.log(JSON.stringify({
  status: "OK",
  envFile,
  generated,
  needsManualValues: placeholders
}, null, 2));

function setGenerated(key, createValue) {
  if (force || !nextEnv[key] || isPlaceholder(nextEnv[key])) {
    nextEnv[key] = createValue();
    generated.push(key);
  }
}

function randomSecret(length) {
  return randomBytes(Math.ceil(length * 0.75))
    .toString("base64url")
    .slice(0, length);
}

function parseEnv(content) {
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return result;
}

function renderEnv(templateContent, env, existingEnv) {
  const seen = new Set();
  const lines = templateContent.split(/\r?\n/).map((line) => {
    const index = line.indexOf("=");
    if (index <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, index);
    seen.add(key);
    return `${key}=${env[key] ?? ""}`;
  });

  const extraKeys = Object.keys(existingEnv).filter((key) => !seen.has(key));
  if (extraKeys.length) {
    lines.push("", "# Existing local-only values");
    for (const key of extraKeys) lines.push(`${key}=${env[key] ?? ""}`);
  }

  return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}

function isPlaceholder(value) {
  const text = String(value ?? "");
  return !text || text.includes("change-this") || text.includes("CHANGE_ME") || text.includes("example");
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}
