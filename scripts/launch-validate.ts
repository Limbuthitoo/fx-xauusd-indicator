type ReadinessResponse = {
  status: string;
  checks: Array<{ code: string; label: string; status: string; evidence: string }>;
  data?: {
    twelveData?: { usedToday?: number; dailyLimit?: number; usedLastMinute?: number; minuteLimit?: number };
    candles?: { storedCandles?: number; latestCandleAt?: string };
    notifications?: { total?: number; unread?: number };
  };
  modules: Array<{
    moduleCode: string;
    moduleName: string;
    status: string;
    audit?: { status?: string; failedChecks?: number };
    rehearsal?: { final_status?: string; created_at?: string } | null;
    nextAction?: string;
  }>;
};

const apiBase = process.env.API_BASE_URL ?? "http://localhost:7073";
const webBase = process.env.WEB_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.ADMIN_EMAIL ?? "admin@orb.local";
const adminPassword = process.env.ADMIN_PASSWORD ?? process.env.LOCAL_PIN ?? "1234";

const failures: string[] = [];

await checkApiHealth();
await checkWebShell();
const token = await login();
const readiness = await checkProductionReadiness(token);
printReadiness(readiness);

if (failures.length > 0) {
  console.error("\nLaunch validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\nLaunch validation PASS. System is operationally ready for paper-trading observation.");

async function checkApiHealth() {
  const response = await fetch(`${apiBase}/api/health`).catch((error) => {
    failures.push(`API health request failed: ${(error as Error).message}`);
    return null;
  });
  if (!response) return;
  if (!response.ok) failures.push(`API health returned HTTP ${response.status}.`);
}

async function checkWebShell() {
  const response = await fetch(webBase).catch((error) => {
    failures.push(`Web dashboard request failed: ${(error as Error).message}`);
    return null;
  });
  if (!response) return;
  const html = await response.text();
  if (!response.ok) failures.push(`Web dashboard returned HTTP ${response.status}.`);
  if (!html.includes('<div id="root"></div>')) failures.push("Web dashboard shell did not contain the React root element.");
}

async function login() {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  }).catch((error) => {
    failures.push(`Admin login request failed: ${(error as Error).message}`);
    return null;
  });
  if (!response) return "";
  if (!response.ok) {
    failures.push(`Admin login returned HTTP ${response.status}.`);
    return "";
  }
  const payload = await response.json() as { token?: string };
  if (!payload.token) failures.push("Admin login did not return a token.");
  return payload.token ?? "";
}

async function checkProductionReadiness(token: string) {
  if (!token) return { status: "BLOCKED", checks: [], modules: [] } as ReadinessResponse;
  const response = await fetch(`${apiBase}/api/analytics/production-readiness`, {
    headers: { authorization: `Bearer ${token}` }
  }).catch((error) => {
    failures.push(`Production readiness request failed: ${(error as Error).message}`);
    return null;
  });
  if (!response) return { status: "BLOCKED", checks: [], modules: [] } as ReadinessResponse;
  if (!response.ok) {
    failures.push(`Production readiness returned HTTP ${response.status}: ${await response.text()}`);
    return { status: "BLOCKED", checks: [], modules: [] } as ReadinessResponse;
  }
  const readiness = await response.json() as ReadinessResponse;
  if (readiness.status !== "READY") failures.push(`Production readiness status is ${readiness.status}.`);
  for (const check of readiness.checks) {
    if (check.status !== "PASS") failures.push(`${check.label} is ${check.status}: ${check.evidence}`);
  }
  for (const module of readiness.modules) {
    if (module.status !== "READY") failures.push(`${module.moduleName} is ${module.status}: ${module.nextAction ?? "No action supplied."}`);
    if (module.audit?.status && module.audit.status !== "PASS") failures.push(`${module.moduleName} audit is ${module.audit.status}.`);
    if (module.rehearsal?.final_status !== "GO") failures.push(`${module.moduleName} latest rehearsal is not GO.`);
  }
  return readiness;
}

function printReadiness(readiness: ReadinessResponse) {
  console.log(`Production readiness: ${readiness.status}`);
  console.log(`Twelve Data: ${readiness.data?.twelveData?.usedToday ?? 0}/${readiness.data?.twelveData?.dailyLimit ?? 800} today, ${readiness.data?.twelveData?.usedLastMinute ?? 0}/${readiness.data?.twelveData?.minuteLimit ?? 8} last minute`);
  console.log(`Candles: ${readiness.data?.candles?.storedCandles ?? 0} stored, latest ${readiness.data?.candles?.latestCandleAt ?? "--"}`);
  console.log(`Notifications: ${readiness.data?.notifications?.total ?? 0} total, ${readiness.data?.notifications?.unread ?? 0} unread`);
  for (const check of readiness.checks) console.log(`- ${check.status} ${check.label}: ${check.evidence}`);
  for (const module of readiness.modules) {
    console.log(`- ${module.status} ${module.moduleName}: rehearsal ${module.rehearsal?.final_status ?? "WAIT"}, audit ${module.audit?.status ?? "--"}`);
  }
}
