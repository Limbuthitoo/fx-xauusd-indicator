import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

type CheckStatus = "PASS" | "WARN" | "FAIL";

type Check = {
  name: string;
  status: CheckStatus;
  detail: string;
  evidence?: unknown;
};

loadEnv(process.argv[2] ?? ".env");

const MODULE_CODE = "high_probability_strategy_2";
const SYMBOL = "XAUUSD";
const MIN_PROBABILITY = 80;
const VALIDATION_SINCE_HOURS = Math.max(1, Number(process.env.MODULE2_VALIDATION_SINCE_HOURS ?? 36));
const databaseUrl = process.env.DATABASE_URL ?? "postgres://orb_user:orb_password@localhost:5433/orb_guide";
const tenantEmail = process.env.TENANT_EMAIL ?? process.env.SUBSCRIBER_EMAIL ?? "";
const client = new pg.Client({ connectionString: databaseUrl });
const checks: Check[] = [];

try {
  await client.connect();
  const tenant = await resolveTenant();
  await validateCatalog(tenant?.id ?? null);
  await validateCandles();
  await validateLatestBacktest(tenant?.id ?? null);
  await validateSetupChain(tenant?.id ?? null);
  await validateLearningReviews(tenant?.id ?? null);

  const summary = summarize(checks);
  const payload = {
    status: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
    generatedAt: new Date().toISOString(),
    moduleCode: MODULE_CODE,
    symbol: SYMBOL,
    validationSinceHours: VALIDATION_SINCE_HOURS,
    tenant: tenant ? { id: tenant.id, name: tenant.name, email: tenant.email } : null,
    summary,
    checks
  };
  console.log(JSON.stringify(payload, null, 2));
  if (summary.fail > 0) process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}

async function resolveTenant() {
  if (tenantEmail) {
    const { rows } = await client.query(
      `SELECT t.id, t.name, COALESCE(au.email, t.owner_email) AS email
       FROM platform_tenants t
       LEFT JOIN admin_users au ON au.tenant_id = t.id
       WHERE lower(COALESCE(au.email, t.owner_email)) = lower($1)
       ORDER BY au.created_at ASC NULLS LAST
       LIMIT 1`,
      [tenantEmail]
    );
    if (!rows[0]) {
      checks.push({
        name: "Subscriber tenant",
        status: "FAIL",
        detail: `No subscriber tenant found for ${tenantEmail}.`
      });
      return null;
    }
    checks.push({
      name: "Subscriber tenant",
      status: "PASS",
      detail: `Validating ${rows[0].name} (${rows[0].email}).`
    });
    return rows[0];
  }

  const { rows } = await client.query(
    `SELECT t.id, t.name, COALESCE(au.email, t.owner_email) AS email
     FROM tenant_modules tm
     JOIN platform_strategy_modules m ON m.id = tm.module_id
     JOIN platform_tenants t ON t.id = tm.tenant_id
     LEFT JOIN admin_users au ON au.tenant_id = t.id
     WHERE m.code = $1 AND tm.status = 'ENABLED'
     ORDER BY t.created_at ASC
     LIMIT 1`,
    [MODULE_CODE]
  );
  if (!rows[0]) {
    checks.push({
      name: "Subscriber tenant",
      status: "FAIL",
      detail: "No tenant has Module 2 enabled."
    });
    return null;
  }
  checks.push({
    name: "Subscriber tenant",
    status: "PASS",
    detail: `Validating first Module 2 tenant: ${rows[0].name} (${rows[0].email ?? "no email"}).`
  });
  return rows[0];
}

async function validateCatalog(tenantId: string | null) {
  const module = await one(
    `SELECT code, name, status
     FROM platform_strategy_modules
     WHERE code = $1`,
    [MODULE_CODE]
  );
  checks.push({
    name: "Module 2 catalog",
    status: module?.status === "ACTIVE" ? "PASS" : "FAIL",
    detail: module ? `${module.name} is ${module.status}.` : "Module 2 catalog row is missing.",
    evidence: module
  });

  if (!tenantId) return;
  const assignment = await one(
    `SELECT tm.status, m.name
     FROM tenant_modules tm
     JOIN platform_strategy_modules m ON m.id = tm.module_id
     WHERE tm.tenant_id = $1 AND m.code = $2`,
    [tenantId, MODULE_CODE]
  );
  checks.push({
    name: "Tenant Module 2 assignment",
    status: assignment?.status === "ENABLED" ? "PASS" : "FAIL",
    detail: assignment ? `Tenant assignment is ${assignment.status}.` : "Tenant does not have Module 2 assigned.",
    evidence: assignment
  });
}

async function validateCandles() {
  const row = await one(
    `SELECT
       count(*)::int AS count,
       min(timestamp_utc) AS first_at,
       max(timestamp_utc) AS latest_at,
       extract(epoch from now() - max(timestamp_utc))::int AS age_seconds
     FROM candles
     WHERE symbol = $1
       AND timeframe_minutes = 5
       AND source LIKE 'TWELVE_DATA%'`,
    [SYMBOL]
  );
  const count = Number(row?.count ?? 0);
  const ageSeconds = Number(row?.age_seconds ?? 999999);
  checks.push({
    name: "PostgreSQL 5M candle cache",
    status: count >= 300 ? "PASS" : count > 0 ? "WARN" : "FAIL",
    detail: `${count} Twelve Data candle(s), latest ${row?.latest_at ?? "missing"}.`,
    evidence: { ...row, ageMinutes: Math.round(ageSeconds / 60) }
  });
}

async function validateLatestBacktest(tenantId: string | null) {
  const params: unknown[] = [MODULE_CODE];
  const tenantFilter = tenantId ? `AND tenant_id = $${params.push(tenantId)}` : "";
  const run = await one(
    `SELECT id, status, started_at, completed_at, summary
     FROM backtest_runs
     WHERE module_code = $1
       ${tenantFilter}
     ORDER BY started_at DESC
     LIMIT 1`,
    params
  );
  if (!run) {
    checks.push({
      name: "Module 2 cache backtest",
      status: "WARN",
      detail: "No Module 2 cache backtest run found. Run the dashboard Module 2 backtest before trusting production validation."
    });
    return;
  }
  const trades = Number(run.summary?.trades ?? 0);
  const winRate = Number(run.summary?.winRate ?? run.summary?.win_rate ?? 0);
  checks.push({
    name: "Module 2 cache backtest",
    status: run.status === "COMPLETED" ? "PASS" : "FAIL",
    detail: `Latest run ${run.status}; trades=${trades}, winRate=${formatPercent(winRate)}.`,
    evidence: {
      id: run.id,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      trades,
      winRate,
      missedReviewsCreated: run.summary?.missedReviewsCreated ?? 0,
      variantReview: run.summary?.variantReview ?? run.summary?.variant_review ?? null
    }
  });

  const backtestTrades = await one(
    `SELECT count(*)::int AS count
     FROM backtest_trades
     WHERE backtest_run_id = $1`,
    [run.id]
  );
  checks.push({
    name: "Backtest trade rows",
    status: Number(backtestTrades?.count ?? 0) > 0 ? "PASS" : "WARN",
    detail: `${backtestTrades?.count ?? 0} persisted Module 2 backtest trade row(s).`
  });
}

async function validateSetupChain(tenantId: string | null) {
  const params: unknown[] = [MODULE_CODE, VALIDATION_SINCE_HOURS];
  const tenantFilter = tenantId ? `AND sc.tenant_id = $${params.push(tenantId)}` : "";
  const rows = (await client.query(
    `SELECT
       sc.id,
       sc.tenant_id,
       sc.status,
       sc.scenario,
       sc.direction,
       sc.favorability_score,
       sc.detected_at,
       sc.entry_price,
       sc.stop_price,
       sc.target_price,
       sc.scenario_flags,
       tp.id AS trade_plan_id,
       tp.reward_to_risk,
       t.id AS trade_id,
       t.outcome AS trade_outcome,
       n.id AS notification_id,
       n.data AS notification_data,
       j.id AS journal_id
     FROM setup_candidates sc
     LEFT JOIN trade_plans tp ON tp.setup_candidate_id = sc.id
     LEFT JOIN trades t ON t.trade_plan_id = tp.id
     LEFT JOIN notifications n ON n.tenant_id = sc.tenant_id
       AND n.event_type LIKE 'MODULE2%'
       AND n.created_at BETWEEN sc.detected_at - interval '2 minutes' AND sc.detected_at + interval '15 minutes'
     LEFT JOIN journal_entries j ON j.setup_candidate_id = sc.id
     WHERE sc.module_code = $1
       AND sc.detected_at >= now() - ($2::int * interval '1 hour')
       AND sc.scenario <> 'QA_TEST_SIGNAL'
       AND COALESCE(sc.scenario_flags->>'replay', 'false') <> 'true'
       AND COALESCE(sc.scenario_flags->>'rehearsal', 'false') <> 'true'
       ${tenantFilter}
       AND (
         sc.favorability_score >= $${params.push(MIN_PROBABILITY)}
         OR sc.status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'PAPER_TRADE_OPENED', 'TRADE_PLANNED')
         OR t.outcome = 'ACTIVE'
       )
     ORDER BY sc.detected_at DESC
     LIMIT 25`,
    params
  )).rows;

  checks.push({
    name: "80%+ Module 2 predictions",
    status: rows.length > 0 ? "PASS" : "WARN",
    detail: rows.length > 0
      ? `${rows.length} high-probability setup candidate(s) found.`
      : "No 80%+ Module 2 candidate exists yet. That is acceptable if no valid setup occurred.",
    evidence: rows.slice(0, 5).map(setupEvidence)
  });

  const entryReady = rows.filter((row) => isEntryReady(row));
  checks.push({
    name: "Entry-ready setup detection",
    status: entryReady.length > 0 ? "PASS" : rows.length > 0 ? "WARN" : "WARN",
    detail: entryReady.length > 0
      ? `${entryReady.length} candidate(s) reached entry-ready status.`
      : "No entry-ready Module 2 setup was found in the current evidence window."
  });

  if (entryReady.length === 0) return;
  assertComplete("Trade plan generated", entryReady, (row) => Boolean(row.trade_plan_id), "entry-ready setup(s) have no trade plan.");
  assertComplete("Paper trade generated", entryReady, (row) => Boolean(row.trade_id), "entry-ready setup(s) have no paper trade.");
  assertComplete("Push/web notification generated", entryReady, (row) => Boolean(row.notification_id), "entry-ready setup(s) have no Module 2 notification near detected time.");
  assertComplete("Journal row generated", entryReady, (row) => Boolean(row.journal_id), "entry-ready setup(s) have no journal row.");
  assertComplete("Entry / SL / TP complete", entryReady, (row) => row.entry_price != null && row.stop_price != null && row.target_price != null, "entry-ready setup(s) are missing entry, SL, or TP.");
  assertComplete("Notification payload detail", entryReady, (row) => {
    const data = row.notification_data ?? {};
    return data.entry != null || data.entryRange != null || data.stopLoss != null || data.target != null || data.trade != null;
  }, "entry-ready setup notification(s) are missing trade detail payload.");
}

async function validateLearningReviews(tenantId: string | null) {
  const hasReviewType = await hasColumn("module_learning_reviews", "review_type");
  if (!hasReviewType) {
    checks.push({
      name: "Module 2 learning review queue",
      status: "WARN",
      detail: "module_learning_reviews.review_type is missing. Run database migrations so missed-trade backtest reviews can be validated."
    });
    return;
  }
  const params: unknown[] = [MODULE_CODE];
  const tenantFilter = tenantId ? `AND tenant_id = $${params.push(tenantId)}` : "";
  const row = await one(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE review_type = 'MISSED_TRADE_BACKTEST')::int AS missed_trade_reviews,
       count(*) FILTER (WHERE status = 'PENDING')::int AS pending
     FROM module_learning_reviews
     WHERE module_code = $1
       ${tenantFilter}`,
    params
  );
  checks.push({
    name: "Module 2 learning review queue",
    status: Number(row?.total ?? 0) > 0 ? "PASS" : "WARN",
    detail: `${row?.total ?? 0} review(s), ${row?.missed_trade_reviews ?? 0} missed-trade review(s), ${row?.pending ?? 0} pending.`,
    evidence: row
  });
}

function assertComplete(name: string, rows: any[], predicate: (row: any) => boolean, missingText: string) {
  const missing = rows.filter((row) => !predicate(row));
  checks.push({
    name,
    status: missing.length === 0 ? "PASS" : "FAIL",
    detail: missing.length === 0 ? `All ${rows.length} entry-ready setup(s) passed.` : `${missing.length}/${rows.length} ${missingText}`,
    evidence: missing.slice(0, 5).map(setupEvidence)
  });
}

function isEntryReady(row: any) {
  return ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "TRADE_PLANNED"].includes(row.status) || row.trade_outcome === "ACTIVE";
}

function setupEvidence(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    scenario: row.scenario,
    direction: row.direction,
    probability: row.favorability_score,
    detectedAt: row.detected_at,
    entry: row.entry_price,
    stop: row.stop_price,
    target: row.target_price,
    tradePlanId: row.trade_plan_id,
    tradeId: row.trade_id,
    notificationId: row.notification_id,
    journalId: row.journal_id,
    variant: row.scenario_flags?.module2Variant?.code ?? row.scenario_flags?.variantCode ?? null
  };
}

async function one(text: string, params: unknown[] = []) {
  const { rows } = await client.query(text, params);
  return rows[0] ?? null;
}

async function hasColumn(tableName: string, columnName: string) {
  const row = await one(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(row);
}

function summarize(items: Check[]) {
  return {
    pass: items.filter((item) => item.status === "PASS").length,
    warn: items.filter((item) => item.status === "WARN").length,
    fail: items.filter((item) => item.status === "FAIL").length
  };
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "--";
  return value <= 1 ? `${Math.round(value * 100)}%` : `${Math.round(value)}%`;
}

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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
