import { existsSync, readFileSync } from "node:fs";

const envFile = argumentValue("--env-file");
if (envFile) loadEnv(envFile);

const days = boundedInteger(argumentValue("--days") ?? process.env.MODULE1_STOP_REPLAY_DAYS, 90, 1, 180);
const setupLimit = boundedInteger(argumentValue("--setup-limit") ?? process.env.MODULE1_STOP_REPLAY_SETUP_LIMIT, 100, 1, 300);
const { pool, query } = await import("../apps/api/src/infrastructure/db/client.js");
const { replayModule1StopCalibration } = await import("../apps/api/src/modules/trades/routes.js");

try {
  const schema = await query(
    `SELECT
       to_regclass('public.module1_stop_shadow_observations') IS NOT NULL AS observations,
       to_regclass('public.module1_profile_stop_shadow_calibration') IS NOT NULL AS calibration`
  );
  if (!Object.values(schema.rows[0] ?? {}).every(Boolean)) {
    throw new Error("Module 1 stop calibration schema is missing; apply migration 108 first.");
  }

  const tenants = await query<{ id: string; slug: string }>(
    `SELECT DISTINCT tenant.id, tenant.slug
     FROM platform_tenants tenant
     JOIN tenant_modules assignment ON assignment.tenant_id = tenant.id
     JOIN platform_strategy_modules module ON module.id = assignment.module_id
     WHERE tenant.status = 'ACTIVE'
       AND assignment.status = 'ENABLED'
       AND module.status = 'ACTIVE'
       AND module.code = 'orb_max_options'
     ORDER BY tenant.slug`
  );
  const results = [];
  for (const tenant of tenants.rows) {
    const result = await replayModule1StopCalibration(tenant.id, days, setupLimit);
    results.push({ tenant: tenant.slug, ...result });
  }
  console.log(JSON.stringify({
    status: "PASS",
    mode: "OBSERVE_ONLY",
    days,
    setupLimit,
    tenantsEvaluated: results.length,
    totals: {
      setupsEvaluated: results.reduce((sum, result) => sum + result.setupsEvaluated, 0),
      candidatesCreated: results.reduce((sum, result) => sum + result.candidatesCreated, 0),
      candidatesCompleted: results.reduce((sum, result) => sum + result.candidatesCompleted, 0)
    },
    results
  }, null, 2));
} finally {
  await pool.end();
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function loadEnv(path: string) {
  if (!existsSync(path)) throw new Error(`Environment file not found: ${path}`);
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value.replace(/\$\$/g, "$" );
  }
}
