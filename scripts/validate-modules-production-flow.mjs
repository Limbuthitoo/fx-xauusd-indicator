const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:7073";
const tenantEmail = process.env.TENANT_EMAIL ?? process.env.SUBSCRIBER_EMAIL ?? "";
const tenantPassword = process.env.TENANT_PASSWORD ?? process.env.SUBSCRIBER_PASSWORD ?? "";
const tenantOtp = process.env.TENANT_OTP ?? process.env.SUBSCRIBER_OTP ?? "";
const requestTimeoutMs = Number(process.env.MODULE_FLOW_VALIDATE_TIMEOUT_MS ?? 15000);

const checks = [];

if (!tenantEmail || !tenantPassword) {
  console.error("TENANT_EMAIL and TENANT_PASSWORD are required for tenant proof validation.");
  process.exit(1);
}

await check("API health", async () => {
  const health = await json("/api/health");
  return { ok: health?.status === "ok", detail: `API status ${health?.status ?? "UNKNOWN"}.`, evidence: health };
});

const login = await check("Tenant login", async () => {
  const payload = await json("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: tenantEmail, password: tenantPassword, ...(tenantOtp ? { otp: tenantOtp } : {}) })
  });
  return { ok: Boolean(payload?.token), detail: payload?.user?.email ? `Logged in as ${payload.user.email}.` : "Tenant token received.", evidence: { user: payload?.user }, token: payload?.token };
});

const headers = { authorization: `Bearer ${login.evidence?.token ?? login.token ?? ""}` };
if (!headers.authorization.endsWith(" ")) {
  const module1 = await check("Module 1 proof chain", async () => {
    const proof = await json("/api/module1/production-proof/run", { method: "POST", headers });
    const failed = Object.entries(proof?.checks ?? {}).filter(([, value]) => value !== true).map(([key]) => key);
    return {
      ok: proof?.status === "PASS" && failed.length === 0,
      detail: failed.length === 0 ? "Module 1 created setup, BUY/SELL signal proof, notification, Python brain approval, and secondary paper-tracking evidence." : `Failed checks: ${failed.join(", ")}.`,
      evidence: summarizeProof(proof)
    };
  });

  const module2 = await check("Module 2 proof chain", async () => {
    const proof = await json("/api/module2/production-proof/run", { method: "POST", headers });
    const failed = Object.entries(proof?.checks ?? {}).filter(([, value]) => value !== true).map(([key]) => key);
    return {
      ok: (proof?.status === "PASS" || proof?.finalStatus === "PASS") && failed.length === 0,
      detail: failed.length === 0 ? "Module 2 created a selected-variant setup, BUY/SELL signal proof, notification, Python brain approval, and secondary paper-tracking evidence." : `Failed checks: ${failed.join(", ")}.`,
      evidence: summarizeProof(proof)
    };
  });

  await check("Module 2 A-J variant matrix proof", async () => {
    const proof = await json("/api/module2/variant-matrix-proof/run", { method: "POST", headers });
    const failed = Array.isArray(proof?.results) ? proof.results.filter((row) => row.finalStatus !== "PASS") : [];
    return {
      ok: proof?.finalStatus === "PASS" && failed.length === 0,
      detail: failed.length === 0
        ? "Module 2 A-I profiles produced signal-proof artifacts and J remained research-only."
        : `${failed.length} variant profile proof row(s) failed.`,
      evidence: {
        summary: proof?.summary,
        failed: failed.map((row) => ({ replayCase: row.replayCase, variantCode: row.variantCode, checks: row.checks })),
        profiles: (proof?.results ?? []).map((row) => ({
          profile: row.variantProfile,
          variantCode: row.variantCode,
          expectedPaperTrade: row.expectedPaperTrade,
          finalStatus: row.finalStatus,
          tradeId: row.tradeId,
          notificationId: row.notificationId
        }))
      }
    };
  });

  await checkModuleSurface("Module 1", "orb_max_options", module1.evidence?.setupId);
  await checkModuleSurface("Module 2", "high_probability_strategy_2", module2.evidence?.setupId);
  await checkLiveSurfaceFreshness("Module 1", "orb_max_options");
  await checkLiveSurfaceFreshness("Module 2", "high_probability_strategy_2");

  await check("Paper Trading page data", async () => {
    const paper = await json("/api/trades/paper?limit=50&includeProof=true", { headers });
    const rows = Array.isArray(paper?.trades) ? paper.trades : [];
    const proofRows = rows.filter((row) => ["orb_max_options", "high_probability_strategy_2"].includes(row.moduleCode ?? row.module_code));
    return {
      ok: proofRows.length >= 2,
      detail: `${proofRows.length} Module 1/2 secondary paper-tracking row(s) visible for win-rate measurement.`,
      evidence: proofRows.slice(0, 5).map((row) => ({ moduleCode: row.moduleCode ?? row.module_code, outcome: row.outcome, entry: row.actualEntry ?? row.actual_entry }))
    };
  });

  await check("Live paper-tracking price guard", async () => {
    const paper = await json("/api/trades/paper?limit=50", { headers });
    const rows = Array.isArray(paper?.trades) ? paper.trades : [];
    const activeRows = rows.filter((row) => row.status === "ACTIVE" || row.outcome === "ACTIVE");
    const staleActive = activeRows.filter((row) => row.staleMarketDistance === true || row.marketContext === "HISTORICAL_PRICE_CONTEXT");
    return {
      ok: staleActive.length === 0,
      warn: activeRows.length === 0,
      detail: activeRows.length === 0
        ? "No active live paper-tracking rows right now; historical proof rows are excluded from normal ledger validation."
        : `${activeRows.length} active paper-tracking row(s), ${staleActive.length} stale vs live price.`,
      evidence: staleActive.length > 0
        ? staleActive.slice(0, 5).map(pickTradeFields)
        : activeRows.slice(0, 5).map(pickTradeFields)
    };
  });

  await check("Notification details payloads", async () => {
    const notifications = await json("/api/notifications?limit=50", { headers });
    const rows = Array.isArray(notifications) ? notifications : [];
    const proofRows = rows.filter((row) =>
      ["MODULE1_PRODUCTION_PROOF", "MODULE2_PRODUCTION_PROOF", "PAPER_TRADE_OPENED"].includes(row.event_type) ||
      row.data?.proofMode === true ||
      row.data?.productionProof === true
    );
    const withTradePayload = proofRows.filter((row) => row.data?.entry != null || row.data?.stopLoss != null || row.data?.takeProfit != null || row.data?.trade?.entry != null);
    return {
      ok: withTradePayload.length >= 1,
      detail: `${withTradePayload.length}/${proofRows.length} proof notification(s) include trade payload details.`,
      evidence: withTradePayload.slice(0, 5).map((row) => ({ eventType: row.event_type, title: row.title, data: row.data }))
    };
  });
}

const failed = checks.filter((item) => item.status === "FAIL");
const warn = checks.filter((item) => item.status === "WARN");
const result = {
  status: failed.length > 0 ? "FAIL" : warn.length > 0 ? "WARN" : "PASS",
  generatedAt: new Date().toISOString(),
  apiBaseUrl,
  summary: { pass: checks.filter((item) => item.status === "PASS").length, warn: warn.length, fail: failed.length },
  checks
};
console.log(JSON.stringify(result, null, 2));
if (failed.length > 0) process.exit(1);

async function checkModuleSurface(label, moduleCode, setupId) {
  await check(`${label} predictions proof`, async () => {
    const payload = await json(`/api/setups/predictions?moduleCode=${encodeURIComponent(moduleCode)}&includeProof=true&limit=20`, { headers });
    const rows = Array.isArray(payload?.predictions) ? payload.predictions : [];
    const match = rows.find((row) => !setupId || row.id === setupId);
    const brainApproved = match?.brainPrediction?.approved === true;
    return {
      ok: Boolean(match?.entry && match?.stopLoss && (match?.takeProfit || match?.target) && brainApproved),
      detail: match
        ? `${label} proof prediction visible with ${match.probability ?? "--"}% probability and signal-first Python brain approval ${brainApproved ? "present" : "missing"}.`
        : `${label} proof prediction missing.`,
      evidence: match ? pickTradeFields(match) : payload?.summary
    };
  });

  await check(`${label} BUY & SELL proof`, async () => {
    const payload = await json(`/api/setups/signals?moduleCode=${encodeURIComponent(moduleCode)}&includeProof=true&limit=20`, { headers });
    const rows = Array.isArray(payload?.signals) ? payload.signals : [];
    const match = rows.find((row) => !setupId || row.id === setupId);
    return {
      ok: Boolean(match?.entry && match?.stopLoss && match?.tp1 && match?.tp2 && match?.tp3),
      detail: match ? `${label} BUY & SELL card visible with entry, SL, TP1, TP2, TP3.` : `${label} BUY & SELL proof card missing.`,
      evidence: match ? pickTradeFields(match) : payload?.summary
    };
  });

  await check(`${label} dashboard bundle`, async () => {
    const bundle = await json(`/api/dashboard/bundle?moduleCode=${encodeURIComponent(moduleCode)}&section=command_center&symbol=XAUUSD&timeframeMinutes=5`, { headers });
    return {
      ok: Boolean(bundle?.currentSetup || bundle?.tradeSignals || bundle?.tradePredictions),
      detail: `${label} dashboard bundle returned setup/signal surfaces.`,
      evidence: {
        hasCurrentSetup: Boolean(bundle?.currentSetup),
        signals: bundle?.tradeSignals?.summary?.total ?? null,
        predictions: bundle?.tradePredictions?.summary?.total ?? null
      }
    };
  });
}

async function checkLiveSurfaceFreshness(label, moduleCode) {
  await check(`${label} current predictions freshness`, async () => {
    const payload = await json(`/api/setups/predictions?moduleCode=${encodeURIComponent(moduleCode)}&limit=50`, { headers });
    const rows = Array.isArray(payload?.predictions) ? payload.predictions : [];
    const stale = rows.filter(isStaleLiveSurfaceRow);
    return {
      ok: stale.length === 0,
      warn: rows.length === 0,
      detail: rows.length === 0
        ? `${label} has no current 80%+ live predictions. This is acceptable when no fresh setup exists, but it means there is no real-market prediction to prove right now.`
        : `${label} exposes ${rows.length} current prediction(s), ${stale.length} stale/far from live price.`,
      evidence: stale.length > 0 ? stale.slice(0, 5).map(pickTradeFields) : rows.slice(0, 5).map(pickTradeFields)
    };
  });

  await check(`${label} current BUY & SELL freshness`, async () => {
    const payload = await json(`/api/setups/signals?moduleCode=${encodeURIComponent(moduleCode)}&limit=50`, { headers });
    const rows = Array.isArray(payload?.signals) ? payload.signals : [];
    const stale = rows.filter(isStaleLiveSurfaceRow);
    return {
      ok: stale.length === 0,
      warn: rows.length === 0,
      detail: rows.length === 0
        ? `${label} has no current BUY/SELL cards. This is acceptable when no fresh valid profile is complete, but should be watched during active sessions.`
        : `${label} exposes ${rows.length} BUY/SELL card(s), ${stale.length} stale/far from live price.`,
      evidence: stale.length > 0 ? stale.slice(0, 5).map(pickTradeFields) : rows.slice(0, 5).map(pickTradeFields)
    };
  });
}

async function check(name, fn) {
  try {
    const result = await fn();
    const item = {
      name,
      status: result.ok ? "PASS" : result.warn ? "WARN" : "FAIL",
      detail: result.detail,
      evidence: result.evidence
    };
    checks.push(item);
    return { ...result, ...item, token: result.token };
  } catch (error) {
    const item = { name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) };
    checks.push(item);
    return item;
  }
}

async function json(path, options = {}) {
  const response = await timedFetch(`${apiBaseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${body?.message ?? text}`);
  return body;
}

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${requestTimeoutMs}ms`)), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeProof(proof) {
  const flags = proof?.setup?.scenario_flags ?? {};
  const variant = flags?.module2Variant ?? {};
  return {
    status: proof?.status ?? proof?.finalStatus,
    setupId: proof?.setup?.id,
    tradeId: proof?.trade?.id,
    setupStatus: proof?.setup?.status,
    scenario: proof?.setup?.scenario,
    variantCode: variant?.code ?? flags?.variantCode ?? null,
    variantName: variant?.name ?? null,
    variantProfile: variant?.profileKey ?? null,
    direction: proof?.setup?.direction,
    entry: proof?.setup?.entry_price,
    stop: proof?.setup?.stop_price,
    target: proof?.setup?.target_price,
    checks: proof?.checks,
    brainDecision: Array.isArray(proof?.brain?.decisions) ? proof.brain.decisions[0]?.decisionType : null
  };
}

function pickTradeFields(row) {
  return {
    id: row.id,
    moduleCode: row.moduleCode ?? row.module_code,
    action: row.action,
    direction: row.direction,
    probability: row.probability,
    chance: row.chance,
    entry: row.entry ?? row.actualEntry ?? row.actual_entry,
    stopLoss: row.stopLoss ?? row.actualStop ?? row.actual_stop,
    takeProfit: row.takeProfit ?? row.target ?? row.actualTarget ?? row.actual_target,
    tp1: row.tp1,
    tp2: row.tp2,
    tp3: row.tp3,
    trade: row.trade,
    status: row.status ?? row.outcome,
    brainPrediction: row.brainPrediction,
    currentPrice: row.currentPrice,
    detectedAgeMinutes: row.detectedAgeMinutes,
    entryDistanceFromCurrent: row.entryDistanceFromCurrent,
    maxLiveEntryDistance: row.maxLiveEntryDistance,
    isNearLivePrice: row.isNearLivePrice,
    livePriceStatus: row.livePriceStatus,
    staleMarketDistance: row.staleMarketDistance,
    marketContext: row.marketContext
  };
}

function isStaleLiveSurfaceRow(row) {
  if (row?.isNearLivePrice === false) return true;
  if (["STALE_TIME", "ENTRY_PRICE_TOO_FAR_FROM_LIVE_MARKET", "HISTORICAL_PRICE_CONTEXT"].includes(String(row?.livePriceStatus ?? row?.marketContext ?? ""))) return true;
  const distance = Number(row?.entryDistanceFromCurrent);
  const maxDistance = Number(row?.maxLiveEntryDistance);
  if (Number.isFinite(distance) && Number.isFinite(maxDistance) && distance > maxDistance) return true;
  return row?.staleMarketDistance === true;
}
