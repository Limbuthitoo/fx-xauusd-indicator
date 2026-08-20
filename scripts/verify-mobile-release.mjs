import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

process.env.MOBILE_BUILD_SEED ??= "20260817170000";
process.env.EXPO_PUBLIC_API_BASE_URL ??= "https://fx.bijaysubbalimbu.com.np";

const appJson = readJson("apps/mobile/app.json").expo;
const eas = readJson("apps/mobile/eas.json");
const firebase = readJson("apps/mobile/google-services.json");
const mobilePackage = readJson("apps/mobile/package.json");
const resolvedExpo = require(resolve(root, "apps/mobile/app.config.js")).expo;
const firebasePackages = (firebase.client ?? [])
  .map((client) => client.client_info?.android_client_info?.package_name)
  .filter(Boolean);

check("Android package is stable", appJson.android?.package === resolvedExpo.android?.package, resolvedExpo.android?.package);
check("Firebase package matches", firebasePackages.includes(resolvedExpo.android?.package), firebasePackages.join(", ") || "missing");
for (const permission of [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW"
]) {
  check(`Blocks ${permission}`, resolvedExpo.android?.blockedPermissions?.includes(permission), "blocked");
}
check("EAS project is configured", Boolean(resolvedExpo.extra?.eas?.projectId), resolvedExpo.extra?.eas?.projectId ?? "missing");

for (const profile of ["production", "production-apk"]) {
  const url = eas.build?.[profile]?.env?.EXPO_PUBLIC_API_BASE_URL;
  check(`${profile} uses HTTPS API`, typeof url === "string" && url.startsWith("https://"), url ?? "missing");
}

for (const asset of ["icon.png", "adaptive-icon.png", "splash.png", "brand-logo.png", "brand-mark.png"]) {
  check(`Asset ${asset}`, existsSync(resolve(root, "apps/mobile/assets", asset)), "present");
}

for (const dependency of ["expo-notifications", "expo-secure-store", "lucide-react-native", "react-native-svg"]) {
  check(`Dependency ${dependency}`, Boolean(mobilePackage.dependencies?.[dependency]), mobilePackage.dependencies?.[dependency] ?? "missing");
}

const appSource = readFileSync(resolve(root, "apps/mobile/App.tsx"), "utf8");
const pushSource = readFileSync(resolve(root, "apps/api/src/modules/notifications/push.ts"), "utf8");
const setupSource = readFileSync(resolve(root, "apps/api/src/modules/setups/routes.ts"), "utf8");
check("Android alert channel is created", appSource.includes('setNotificationChannelAsync("trading-alerts"'), "trading-alerts");
check("Blocked setups cannot become signals", appSource.includes("setupIsBlocked(setup)") && appSource.includes("hasActionableSignal"), "mobile risk guard");
check("Session restore refreshes push", appSource.includes("registerPush(savedToken)"), "automatic token refresh");
check("Test pushes stay neutral", appSource.includes('["MOBILE_TEST_PUSH", "PLATFORM_TEST_PUSH", "PLATFORM_PUSH_TEST"].includes(eventType)') && appSource.includes('return "GENERAL"'), "no BUY/SELL fallback");
check("Notification layouts vary by event family", ["RiskNotification", "SetupProgressNotification", "ReportNotification", "LearningNotification", "SecurityNotification"].every((name) => appSource.includes(`function ${name}`)), "category-driven detail UI");
check("Risk classification precedes trade geometry", appSource.indexOf('if (/NO_TRADE|BLOCKED') < appSource.indexOf('if (hasTradeDetails(detail)'), "blocked payloads remain NO TRADE");
check("Paper lifecycle precedes entry classification", appSource.indexOf('if (/PAPER_TRADE_OPENED') < appSource.indexOf('if (hasTradeDetails(detail)'), "paper events use lifecycle layout");
check("Header bell opens notification history", appSource.includes('accessibilityLabel={`Open notifications') && appSource.includes('setMoreView("notification-history")'), "bell is navigation, not registration");
check("Bell badge counts unread alerts", appSource.includes("const unreadAlerts =") && appSource.includes("!item.acknowledged_at"), "unread notification count");
check("Signal Desk trusts entry contracts", !appSource.includes("setupProbability(setup) >= 80"), "no unrelated confidence threshold");
check("Paper tracking is distinct from fresh entry", appSource.includes("hasTrackedSignal") && appSource.includes('PAPER TRACKING'), "duplicate-entry guard");
check("Paper performance shows breakeven efficiency", appSource.includes('label="BE Saves"') && appSource.includes("breakevenSaveRate"), "managed-runner evidence");
check("Paper journal shows MFE and MAE", appSource.includes('label="MFE"') && appSource.includes('label="MAE"'), "entry-quality excursions");
check("Blocked Home cards hide execution geometry", appSource.includes("const showTradeGeometry") && appSource.includes("primaryMode === \"BLOCKED\""), "NO TRADE context only");
check("Expo push uses alert channel", pushSource.includes('channelId: "trading-alerts"'), "trading-alerts");
check("Firebase push is high priority", pushSource.includes('priority: "high"'), "high");
check("Stale Firebase tokens are disabled", pushSource.includes("isUnregisteredFirebaseError"), "provider error cleanup");
check("QA signal reaches push provider", setupSource.includes("QA_TEST_SIGNAL") && setupSource.includes("await sendTenantPush({"), "authenticated QA route");
check("Production API baked into config", resolvedExpo.extra?.apiBaseUrl === "https://fx.bijaysubbalimbu.com.np", resolvedExpo.extra?.apiBaseUrl ?? "missing");

for (const item of checks) {
  console.log(`${item.passed ? "PASS" : "FAIL"}  ${item.name}: ${item.detail}`);
}

const failed = checks.filter((item) => !item.passed);
console.log(`\nMobile release preflight: ${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length > 0) process.exit(1);
