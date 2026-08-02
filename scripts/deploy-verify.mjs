const baseUrl = process.env.API_BASE_URL ?? process.env.PUBLIC_API_BASE_URL ?? "http://localhost:7073";
const email = process.env.ADMIN_EMAIL ?? "admin@orb.local";
const password = process.env.ADMIN_PASSWORD ?? process.env.LOCAL_PIN ?? "1234";

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${body?.message ?? text}`);
  return body;
}

async function main() {
  const health = await json("/api/health");
  const login = await json("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const headers = { authorization: `Bearer ${login.token}` };
  const [system, backups, usage, push] = await Promise.all([
    json("/api/platform/system-health", { headers }),
    json("/api/platform/backups/status", { headers }),
    json("/api/platform/usage/twelve-data", { headers }),
    json("/api/platform/push/overview", { headers })
  ]);
  const requiredServices = ["API", "PostgreSQL", "Redis", "Market-data worker", "Twelve Data guardrail", "Production configuration"];
  const services = new Map((system.services ?? []).map((service) => [service.name, service]));
  const failed = requiredServices
    .map((name) => services.get(name))
    .filter((service) => !service || ["CRITICAL", "DOWN", "STALE"].includes(service.status));
  const result = {
    api: health.status,
    system: system.overall,
    backups: backups.status,
    worker: services.get("Market-data worker")?.status ?? "UNKNOWN",
    redis: services.get("Redis")?.status ?? "UNKNOWN",
    postgres: services.get("PostgreSQL")?.status ?? "UNKNOWN",
    pushProvider: push.health?.provider ?? "UNKNOWN",
    firebase: push.health?.firebase?.status ?? "UNKNOWN",
    activePushDevices: push.devices?.active_devices ?? 0,
    twelveDataCredits: `${usage.creditsUsedToday}/${usage.dailyLimit}`,
    workerMode: usage.worker?.mode,
    failed: failed.map((service) => service?.name ?? "missing service")
  };
  console.log(JSON.stringify(result, null, 2));
  if (push.health?.provider === "firebase" && push.health?.firebase?.status !== "CONFIGURED") {
    result.failed.push("Firebase push");
  }
  if (failed.length > 0 || usage.worker?.embeddedApiWorker === true || result.failed.length > failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
