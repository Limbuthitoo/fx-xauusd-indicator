import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import { Bell, CheckCircle2, Clock, CreditCard, Database, Download, FileText, KeyRound, Layers, LineChart, Lock, LogOut, Plus, Settings, ShieldCheck, Smartphone, Trash2, UploadCloud, Users, XCircle } from "lucide-react";
import { TwelveDataChart, type ChartPriceLine } from "./features/dashboard/TwelveDataChart";
import { API_BASE_URL, api, clearAuthToken, setAuthToken } from "./shared/api";
import "./styles.css";

const DEFAULT_SYMBOL = "XAUUSD";
const DEFAULT_TIMEFRAME_MINUTES = 5;
const WEB_BRAND_LOGO = "/brand/brand-logo.png";
const WEB_BRAND_MARK = "/brand/brand-mark.png";
const STRATEGY_MODULE_CODES = ["orb_max_options", "high_probability_strategy_2", "strategy_lab_3"];
const DEFAULT_PUSH_PREFERENCES = {
  nyPreSession: true,
  validEntries: true,
  paperTradeOpened: true,
  takeProfitStopLoss: true,
  dailyReports: true,
  weeklyMonthlyReports: true,
  learningReviews: false,
  systemDiagnostics: false
};

type ActiveSection = "command" | "live" | "health" | "orb" | "reports" | "learning" | "notifications" | "account" | "settings" | "data";
type PlatformSection = "overview" | "subscribers" | "tickets" | "modules" | "plans" | "app-updates" | "billing" | "automation" | "usage" | "system" | "settings";

type PanelState = {
  clocks?: { utc: string; newYork: string; nepal: string };
  session?: any;
  strategies: any[];
  analytics?: any;
  orbAdmin?: any;
  currentSetup?: any;
  moduleCommand?: any[];
  automationStatus?: any;
  feedStatus?: any;
  twelveStatus?: any;
  cacheStatus?: any;
  newsStatus?: any;
  tradePlan?: any;
  currentTrade?: any;
  sessionReview?: any;
  weeklyReport?: any[];
  monthlyReport?: any[];
  latestBacktest?: any;
  orbDataReadiness?: any;
  orbRangeAudit?: any;
  orbRehearsals?: any[];
  module2JournalTrades?: any[];
  module2Audit?: any;
  module2Readiness?: any;
  module2TuningLab?: any;
  module2TuningHistory?: any[];
  module2Health?: any;
  module2DataReadiness?: any;
  module2Operator?: any;
  module2Rehearsals?: any[];
  module2Learning?: any;
  module2LearningReviews?: any[];
  module2SessionReports?: any[];
  module2Closeouts?: any[];
  module3JournalTrades?: any[];
  module3DataReadiness?: any;
  module3Learning?: any;
  module3SessionReports?: any[];
  module3SetupHistory?: any[];
  module3Rehearsals?: any[];
  strategyConfidence?: any;
  productionReadiness?: any;
  notifications?: any[];
  notificationSummary?: any[];
  settings?: any[];
  orbModuleSettings?: any[];
  activeModuleSettings?: any[];
  auditLogs?: any[];
  orbLearning?: any;
  platform?: any;
  platformAutomation?: any[];
  platformUsage?: any;
  platformSystemHealth?: any;
  platformSecurityAudit?: any;
  platformOperationalEvents?: any;
  platformBackupStatus?: any;
  platformRequestLoad?: any;
  platformBusinessSettings?: any;
  platformPushOverview?: any;
  platformTickets?: any[];
  platformAppReleases?: any[];
  tenantPushStatus?: any;
  tenantContext?: any;
};

type AdminUser = {
  displayName: string;
  email: string;
  role: string;
  tenantId?: string | null;
  platformSuperAdmin?: boolean;
  passwordChangeRequired?: boolean;
  mfaEnabled?: boolean;
  mfaEnrollmentRequired?: boolean;
  permissions: string[];
};

function App() {
  const currentPath = window.location.pathname;
  const isPlatformAdminRoute = currentPath === "/platform" || currentPath.startsWith("/platform/") || currentPath === "/platform-admin" || currentPath.startsWith("/platform-admin/");
  const [state, setState] = useState<PanelState>({ strategies: [] });
  const [message, setMessage] = useState("Automatic paper trading is ready.");
  const [activeSection, setActiveSection] = useState<ActiveSection>("live");
  const [activeModuleCode, setActiveModuleCodeState] = useState(() => window.localStorage.getItem("orb_active_module_code") ?? "orb_max_options");
  const [selectedModule2TradeId, setSelectedModule2TradeId] = useState<string | null>(null);
  const [orbQaSuite, setOrbQaSuite] = useState<any | null>(null);
  const [module2TradeDetail, setModule2TradeDetail] = useState<any | null>(null);
  const [module2DryRun, setModule2DryRun] = useState<any | null>(null);
  const [module2TuningLab, setModule2TuningLab] = useState<any | null>(null);
  const [module2QaSuite, setModule2QaSuite] = useState<any | null>(null);
  const [selectedModule3TradeId, setSelectedModule3TradeId] = useState<string | null>(null);
  const [module3TradeDetail, setModule3TradeDetail] = useState<any | null>(null);
  const [module3QaSuite, setModule3QaSuite] = useState<any | null>(null);
  const [notificationFilters, setNotificationFilters] = useState({ moduleCode: "", priority: "", unreadOnly: false, eventType: "" });
  const activeModuleCodeRef = useRef(activeModuleCode);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  function routeAccountError(nextUser: AdminUser) {
    if (nextUser.platformSuperAdmin && !isPlatformAdminRoute) return "Platform admin accounts must use the platform console.";
    if (!nextUser.platformSuperAdmin && isPlatformAdminRoute) return "Subscriber accounts cannot access platform admin.";
    return null;
  }

  function setActiveModuleCode(moduleCode: string) {
    activeModuleCodeRef.current = moduleCode;
    window.localStorage.setItem("orb_active_module_code", moduleCode);
    setActiveModuleCodeState(moduleCode);
  }

  async function refresh(moduleCode = activeModuleCodeRef.current) {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const task = refreshNow(moduleCode);
    refreshInFlightRef.current = task;
    try {
      await task;
    } finally {
      refreshInFlightRef.current = null;
    }
  }

  async function refreshNow(moduleCode = activeModuleCodeRef.current) {
    if (isPlatformAdminRoute) {
      const bundle = await api<any>("/api/platform/bundle").catch(() => undefined);
      setState((previous) => ({
        ...previous,
        strategies: previous.strategies ?? [],
        platform: bundle?.platform,
        platformAutomation: bundle?.platformAutomation ?? [],
        platformUsage: bundle?.platformUsage,
        platformSystemHealth: bundle?.platformSystemHealth,
        platformSecurityAudit: bundle?.platformSecurityAudit,
        platformOperationalEvents: bundle?.platformOperationalEvents,
        platformBackupStatus: bundle?.platformBackupStatus,
        platformBusinessSettings: bundle?.platformBusinessSettings,
        platformPushOverview: bundle?.platformPushOverview,
        platformTickets: bundle?.platformTickets ?? [],
        platformAppReleases: bundle?.platformAppReleases ?? [],
        platformRequestLoad: bundle?.requestLoad
      }));
      return;
    }

    const refreshSymbol = settingValue<string>(state.settings, "trading.symbol", DEFAULT_SYMBOL);
    const refreshTimeframe = moduleTimeframe(moduleCode, settingValue<number>(state.settings, "trading.timeframeMinutes", DEFAULT_TIMEFRAME_MINUTES));
    const notificationQuery = notificationSearchParams(notificationFilters);
    const isModule1 = moduleCode === "orb_max_options";
    const isModule2 = moduleCode === "high_probability_strategy_2";
    const isModule3 = moduleCode === "strategy_lab_3";
    const needsCommand = activeSection === "command";
    const needsStrategy = activeSection === "orb";
    const needsReports = activeSection === "reports";
    const needsLearning = activeSection === "learning";
    const needsNotifications = activeSection === "notifications";
    const needsSettings = activeSection === "settings";
    const needsData = activeSection === "data" || activeSection === "health";
    const needsModuleOps = needsCommand || needsStrategy || needsReports || needsLearning || needsData;
    const bundle = await api<any>(`/api/dashboard/bundle?moduleCode=${moduleCode}&section=${activeSection}&symbol=${refreshSymbol}&timeframeMinutes=${refreshTimeframe}&notificationQuery=${encodeURIComponent(notificationQuery)}`).catch(() => undefined);
    if (!bundle) return;
    setState((previous) => ({
      ...previous,
      ...bundle,
      orbAdmin: bundle.orbAdmin ?? previous.orbAdmin,
      moduleCommand: bundle.moduleCommand?.length ? bundle.moduleCommand : previous.moduleCommand ?? [],
      weeklyReport: bundle.weeklyReport?.length ? bundle.weeklyReport : previous.weeklyReport ?? [],
      monthlyReport: bundle.monthlyReport?.length ? bundle.monthlyReport : previous.monthlyReport ?? [],
      latestBacktest: bundle.latestBacktest ?? previous.latestBacktest,
      orbDataReadiness: bundle.orbDataReadiness ?? previous.orbDataReadiness,
      orbRehearsals: bundle.orbRehearsals?.length ? bundle.orbRehearsals : previous.orbRehearsals ?? [],
      module2JournalTrades: bundle.module2JournalTrades?.length ? bundle.module2JournalTrades : previous.module2JournalTrades ?? [],
      module2Audit: bundle.module2Audit ?? previous.module2Audit,
      module2Readiness: bundle.module2Readiness ?? previous.module2Readiness,
      module2TuningHistory: bundle.module2TuningHistory?.length ? bundle.module2TuningHistory : previous.module2TuningHistory ?? [],
      module2Health: bundle.module2Health ?? previous.module2Health,
      module2DataReadiness: bundle.module2DataReadiness ?? previous.module2DataReadiness,
      module2Operator: bundle.module2Operator ?? previous.module2Operator,
      module2Rehearsals: bundle.module2Rehearsals?.length ? bundle.module2Rehearsals : previous.module2Rehearsals ?? [],
      module2Learning: bundle.module2Learning ?? previous.module2Learning,
      module2LearningReviews: bundle.module2LearningReviews?.length ? bundle.module2LearningReviews : previous.module2LearningReviews ?? [],
      module2SessionReports: bundle.module2SessionReports?.length ? bundle.module2SessionReports : previous.module2SessionReports ?? [],
      module2Closeouts: bundle.module2Closeouts?.length ? bundle.module2Closeouts : previous.module2Closeouts ?? [],
      module3JournalTrades: bundle.module3JournalTrades?.length ? bundle.module3JournalTrades : previous.module3JournalTrades ?? [],
      module3DataReadiness: bundle.module3DataReadiness ?? previous.module3DataReadiness,
      module3Learning: bundle.module3Learning ?? previous.module3Learning,
      module3SessionReports: bundle.module3SessionReports?.length ? bundle.module3SessionReports : previous.module3SessionReports ?? [],
      module3SetupHistory: bundle.module3SetupHistory?.length ? bundle.module3SetupHistory : previous.module3SetupHistory ?? [],
      module3Rehearsals: bundle.module3Rehearsals?.length ? bundle.module3Rehearsals : previous.module3Rehearsals ?? [],
      strategyConfidence: bundle.strategyConfidence ?? previous.strategyConfidence,
      productionReadiness: bundle.productionReadiness ?? previous.productionReadiness,
      notifications: bundle.notifications?.length ? bundle.notifications : previous.notifications ?? [],
      notificationSummary: bundle.notificationSummary?.length ? bundle.notificationSummary : previous.notificationSummary ?? [],
      settings: bundle.settings?.length ? bundle.settings : previous.settings ?? [],
      orbModuleSettings: bundle.orbModuleSettings?.length ? bundle.orbModuleSettings : previous.orbModuleSettings ?? [],
      activeModuleSettings: bundle.activeModuleSettings?.length ? bundle.activeModuleSettings : previous.activeModuleSettings ?? [],
      auditLogs: bundle.auditLogs?.length ? bundle.auditLogs : previous.auditLogs ?? [],
      orbLearning: bundle.orbLearning ?? previous.orbLearning,
      platform: previous.platform,
      platformAutomation: previous.platformAutomation ?? [],
      platformUsage: previous.platformUsage
    }));
  }

  useEffect(() => {
    async function restoreSession() {
      setAuthChecked(true);
      const result = await api<{ user: AdminUser }>("/api/auth/me").catch(() => undefined);
      if (result?.user) {
        const routeError = routeAccountError(result.user);
        if (routeError) {
          clearAuthToken();
          setUser(null);
          setMessage(routeError);
          setAuthChecked(true);
          return;
        }
        setUser(result.user);
        refresh().catch(() => setMessage("API offline. Start PostgreSQL and the API server."));
        return;
      } else {
        clearAuthToken();
      }
      setAuthChecked(true);
    }
    restoreSession().catch(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => refresh(activeModuleCodeRef.current).catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      api<{ token: string; user: AdminUser }>("/api/auth/refresh", { method: "POST", body: JSON.stringify({}) })
        .then((result) => {
          const routeError = routeAccountError(result.user);
          if (routeError) {
            clearAuthToken();
            setUser(null);
            setMessage(routeError);
            return;
          }
          setAuthToken(result.token);
          setUser(result.user);
        })
        .catch(() => {
          clearAuthToken();
          setUser(null);
          setMessage("Session expired. Please sign in again.");
        });
    }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user || isPlatformAdminRoute) return;
    activeModuleCodeRef.current = activeModuleCode;
    refresh(activeModuleCode).catch(() => undefined);
  }, [activeModuleCode]);

  useEffect(() => {
    if (!user || isPlatformAdminRoute) return;
    const seen = new Set<string>(JSON.parse(window.localStorage.getItem("orb_seen_notifications") ?? "[]"));
    async function pollNotifications() {
      const notifications = await api<any[]>("/api/notifications?unacknowledged=true&limit=10").catch(() => []);
      for (const item of notifications.reverse()) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        await browserNotify(item.title, item.body);
      }
      window.localStorage.setItem("orb_seen_notifications", JSON.stringify([...seen].slice(-100)));
    }
    pollNotifications().catch(() => undefined);
    const timer = window.setInterval(() => pollNotifications().catch(() => undefined), 60_000);
    return () => window.clearInterval(timer);
  }, [user]);

  const activeVersion = useMemo(() => {
    for (const strategy of state.strategies) {
      const version = strategy.versions?.find((item: any) => item.status === "ACTIVE");
      if (version) return version;
    }
    return null;
  }, [state.strategies]);

  const can = (permission: string) => user?.permissions.includes(permission);
  const subscriptionActive = ["TRIAL", "ACTIVE"].includes(String(state.tenantContext?.subscription?.status ?? "ACTIVE"));
  const hasModule = (moduleCode: string) => subscriptionActive && Boolean(state.tenantContext?.modules?.some((module: any) => module.code === moduleCode && module.tenant_module_status === "ENABLED"));
  const enabledModules = (state.tenantContext?.modules ?? []).filter((module: any) => module.tenant_module_status === "ENABLED");
  const enabledModuleCodes = enabledModules.map((module: any) => module.code).join("|");
  const activeModule = enabledModules.find((module: any) => module.code === activeModuleCode) ?? (enabledModules.length === 0 ? null : { code: activeModuleCode, name: moduleShortName(activeModuleCode) });
  const selectedModuleCode = activeModuleCode;
  const currentModuleSetup = state.currentSetup?.module_code === selectedModuleCode ? state.currentSetup : undefined;
  const currentModuleTrade = state.currentTrade?.module_code === selectedModuleCode ? state.currentTrade : undefined;
  const currentModuleTradePlan = state.tradePlan?.module_code === selectedModuleCode ? state.tradePlan : undefined;
  const signal = getSignal(currentModuleSetup, currentModuleTrade);
  const orb = state.session?.opening_range;
  const latestWeek = state.weeklyReport?.[0];
  const latestMonth = state.monthlyReport?.[0];
  const reasons = currentModuleSetup?.favorability_reasons ?? [];
  const scenarioFlags = currentModuleSetup?.scenario_flags ?? {};
  const scenarioMatrix = scenarioFlags.matrix ?? {};
  const favorabilityFlags = scenarioFlags.favorability ?? {};
  const breakoutProfile = scenarioFlags.breakoutProfile ?? {};
  const ruleEvaluations = currentModuleSetup?.evaluations ?? [];
  const feedHealth = state.feedStatus?.live ? "LIVE" : state.feedStatus?.testMode ? "TEST MODE" : state.feedStatus?.latestCandle ? "STALE" : "WAITING";
  const accountLocked = enabledModules.length === 0;
  const activeSymbol = settingValue<string>(state.settings, "trading.symbol", DEFAULT_SYMBOL);
  const activeTimeframeMinutes = moduleTimeframe(selectedModuleCode, settingValue<number>(state.settings, "trading.timeframeMinutes", DEFAULT_TIMEFRAME_MINUTES));

  useEffect(() => {
    if (!user || enabledModules.length === 0) return;
    if (!enabledModules.some((module: any) => module.code === activeModuleCode)) {
      setActiveModuleCode(enabledModules[0].code);
    }
  }, [user, enabledModuleCodes, activeModuleCode]);

  async function login(email: string, password: string, otp?: string) {
    clearAuthToken();
    const result = await api<{ token: string; user: AdminUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, otp })
    });
    const routeError = routeAccountError(result.user);
    if (routeError) {
      clearAuthToken();
      throw new Error(routeError);
    }
    setAuthToken(result.token);
    setUser(result.user);
    setMessage("Admin dashboard unlocked.");
    if (!result.user.passwordChangeRequired) refresh().catch(() => setMessage("API offline. Start PostgreSQL and the API server."));
  }

  async function changeOwnPassword(currentPassword: string, newPassword: string) {
    const result = await api<{ token: string; user: AdminUser }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    });
    setAuthToken(result.token);
    setUser(result.user);
    setMessage("Password changed. Your dashboard is now unlocked.");
    await refresh();
  }

  async function startMfaSetup() {
    return api<{ secret: string; otpAuthUrl: string }>("/api/auth/mfa/setup", {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async function enableMfa(otp: string) {
    const result = await api<{ token: string; user: AdminUser }>("/api/auth/mfa/enable", {
      method: "POST",
      body: JSON.stringify({ otp })
    });
    setAuthToken(result.token);
    setUser(result.user);
    setMessage("Two-factor authentication is enabled.");
    if (!result.user.mfaEnrollmentRequired && !result.user.passwordChangeRequired) await refresh();
  }

  async function disableMfa(otp: string) {
    const result = await api<{ token: string; user: AdminUser }>("/api/auth/mfa/disable", {
      method: "POST",
      body: JSON.stringify({ otp })
    });
    setAuthToken(result.token);
    setUser(result.user);
    setMessage(result.user.mfaEnrollmentRequired ? "Two-factor setup is required for platform admin." : "Two-factor authentication is disabled.");
  }

  function logout() {
    api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => undefined);
    clearAuthToken();
    setUser(null);
    setState({ strategies: [] });
  }

  async function browserNotify(title: string, body: string) {
    if (!("Notification" in window)) return;
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") new Notification(title, { body });
  }

  async function triggerTestSignal(direction: "LONG" | "SHORT") {
    const result = await api<any>("/api/dev/test-signal", {
      method: "POST",
      body: JSON.stringify({ direction })
    });
    setState((previous) => ({ ...previous, currentSetup: result.setup }));
    setMessage(`QA ${direction === "LONG" ? "BUY" : "SELL"} test signal fired. This bypasses ORB rules.`);
    await browserNotify(`QA ${direction === "LONG" ? "BUY" : "SELL"} test signal`, "Notification and dashboard signal test only.");
    await refresh();
  }

  async function clearTestSignals() {
    await api<any>("/api/dev/test-signal/clear", { method: "POST", body: JSON.stringify({}) });
    setMessage("QA and replay test signals cleared.");
    await refresh();
  }

  async function triggerOrbReplay(replayCase: string) {
    const result = await api<any>("/api/dev/orb-replay", {
      method: "POST",
      body: JSON.stringify({ case: replayCase })
    });
    setState((previous) => ({ ...previous, currentSetup: result.setup }));
    setMessage(`ORB replay ${replayCase} produced ${result.setup.scenario}.`);
    await browserNotify("ORB replay complete", `${replayCase} produced ${result.setup.status}.`);
    await refresh();
  }

  async function runOrbQaSuite() {
    const result = await api<any>("/api/dev/orb-qa-suite", { method: "POST", body: JSON.stringify({}) });
    setOrbQaSuite(result);
    setMessage(`Module 1 ORB QA suite ${result.finalStatus}: ${result.summary?.passed ?? 0}/${result.summary?.total ?? 0} cases passed.`);
    await refresh("orb_max_options");
  }

  async function runOrbLaunchRehearsal() {
    const result = await api<any>("/api/module1/launch-rehearsal", { method: "POST", body: JSON.stringify({}) });
    setOrbQaSuite(result.qaSuite);
    setState((previous) => ({
      ...previous,
      orbRehearsals: [result, ...(previous.orbRehearsals ?? [])].slice(0, 20)
    }));
    setMessage(`Module 1 launch rehearsal: ${result.finalStatus === "GO" ? "GO" : "NO GO"} · ${result.handoff?.expectedNextAction ?? "Review checklist"}`);
    await refresh("orb_max_options");
  }

  async function triggerModule2Replay(replayCase: string, openPaperTrade = false) {
    const result = await api<any>("/api/dev/module2-replay", {
      method: "POST",
      body: JSON.stringify({ case: replayCase, openPaperTrade })
    });
    setState((previous) => ({ ...previous, currentSetup: result.setup }));
    setMessage(`Module 2 replay ${replayCase} produced ${result.setup.scenario}${result.trade ? " and opened QA paper trade" : ""}.`);
    await browserNotify("Module 2 replay complete", `${replayCase} produced ${result.setup.status}.`);
    await refresh("high_probability_strategy_2");
  }

  async function runModule2QaSuite() {
    const result = await api<any>("/api/dev/module2-qa-suite", { method: "POST", body: JSON.stringify({}) });
    setModule2QaSuite(result);
    setMessage(`Module 2 QA suite ${result.finalStatus}: ${result.summary?.passed ?? 0}/${result.summary?.total ?? 0} cases passed.`);
    await refresh("high_probability_strategy_2");
  }

  async function triggerModule3Replay(replayCase: string, openPaperTrade = false) {
    const result = await api<any>("/api/dev/module3-replay", {
      method: "POST",
      body: JSON.stringify({ case: replayCase, openPaperTrade })
    });
    setMessage(`Module 3 replay ${replayCase} produced ${result.setup.scenario}${result.trade ? " and opened QA paper trade" : ""}.`);
    await browserNotify("Module 3 replay complete", `${replayCase} produced ${result.setup.status}.`);
    await refresh("strategy_lab_3");
  }

  async function runModule3QaSuite() {
    const result = await api<any>("/api/dev/module3-qa-suite", { method: "POST", body: JSON.stringify({}) });
    setModule3QaSuite(result);
    setMessage(`Module 3 QA suite ${result.finalStatus}: ${result.summary.passed}/${result.summary.total} passed.`);
  }

  async function runModule3LaunchRehearsal() {
    const result = await api<any>("/api/module3/launch-rehearsal", { method: "POST", body: JSON.stringify({}) });
    setModule3QaSuite(result.qaSuite);
    setState((previous) => ({
      ...previous,
      module3Rehearsals: [result, ...(previous.module3Rehearsals ?? [])].slice(0, 20)
    }));
    setMessage(`Module 3 launch rehearsal: ${result.finalStatus === "GO" ? "GO" : "NO GO"} · ${result.handoff?.expectedNextAction ?? "Review checklist"}`);
    await refresh("strategy_lab_3");
  }

  async function loadModule3TradeDetail(tradeId: string) {
    setSelectedModule3TradeId(tradeId);
    const detail = await api<any>(`/api/modules/strategy_lab_3/journal/trades/${tradeId}`);
    setModule3TradeDetail(detail);
  }

  async function runModuleLifecycle(moduleCode: string, event: string, tradeId?: string | null, setupId?: string | null) {
    const result = await api<any>(`/api/dev/modules/${moduleCode}/trade-lifecycle`, {
      method: "POST",
      body: JSON.stringify({ event, tradeId, setupId })
    });
    setMessage(`${moduleShortName(moduleCode)} lifecycle ${event}: ${result.trade?.outcome ?? result.setup?.status ?? "recorded"}.`);
    await refresh(moduleCode);
    if (moduleCode === "strategy_lab_3" && result.trade?.id) await loadModule3TradeDetail(result.trade.id);
  }

  async function runModule3Learning() {
    const result = await api<any>("/api/module3/learning/run", { method: "POST", body: JSON.stringify({}) });
    setState((previous) => ({ ...previous, module3Learning: result }));
    setMessage(`Module 3 learning complete: ${result.sample_size ?? 0} trades, ${(result.recommendations ?? []).length} recommendation(s).`);
  }

  async function generateModule3SessionReport() {
    const result = await api<any>("/api/module3/session-reports/generate", { method: "POST", body: JSON.stringify({}) });
    setState((previous) => ({ ...previous, module3SessionReports: [result, ...(previous.module3SessionReports ?? []).filter((row: any) => row.id !== result.id)] }));
    setMessage(`Module 3 session report generated: ${result.final_status}.`);
  }

  async function runModule3Backfill() {
    const feedSettings = settingValue<any>(state.settings, "feed.provider", { startupBackfillCount: 300 });
    const result = await api<any>("/api/module3/data-readiness/backfill", {
      method: "POST",
      body: JSON.stringify({ count: feedSettings.startupBackfillCount ?? 300 })
    });
    setState((previous) => ({ ...previous, module3DataReadiness: result.after }));
    setMessage(`Module 3 backfill complete: 1 Twelve Data call requested ${result.requestedCount} candles.`);
  }

  async function runModule2Lifecycle(event: string, tradeId?: string | null, setupId?: string | null) {
    const result = await api<any>("/api/dev/module2-trade-lifecycle", {
      method: "POST",
      body: JSON.stringify({ event, tradeId, setupId })
    });
    setMessage(`Module 2 QA lifecycle: ${event}${result.trade?.outcome ? ` -> ${result.trade.outcome}` : ""}.`);
    await refresh("high_probability_strategy_2");
    if (result.trade?.id) await loadModule2TradeDetail(result.trade.id);
  }

  async function loadModule2TradeDetail(tradeId: string) {
    setSelectedModule2TradeId(tradeId);
    const detail = await api<any>(`/api/module2/journal/trades/${tradeId}`);
    setModule2TradeDetail(detail);
  }

  async function runModule2DryRun() {
    const result = await api<any>("/api/module2/readiness/dry-run", { method: "POST", body: JSON.stringify({}) });
    setModule2DryRun(result.dryRunResult);
    setState((previous) => ({ ...previous, module2Readiness: result }));
    setMessage(`Module 2 dry-run: ${result.dryRunResult?.status ?? "WAIT"} · ${result.dryRunResult?.finalReason ?? result.dryRunResult?.reason ?? "No decision"}`);
  }

  async function runModule2TuningLab() {
    const result = await api<any>("/api/backtests/module2/tuning-lab", {
      method: "POST",
      body: JSON.stringify({ symbol: activeSymbol })
    });
    setModule2TuningLab(result);
    setState((previous) => ({ ...previous, module2TuningLab: result }));
    setMessage(`Module 2 tuning complete. Best preset: ${result.recommendation?.bestPreset ?? "none"}.`);
  }

  async function applyModule2Preset(presetCode: string, qaOnly = false) {
    const result = await api<any>("/api/backtests/module2/tuning-promotions/apply", {
      method: "POST",
      body: JSON.stringify({ presetCode, qaOnly, reason: `Applied from Module 2 tuning lab (${qaOnly ? "QA-only" : "production"}).` })
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage(`Module 2 preset applied: ${presetCode}.`);
    await refresh("high_probability_strategy_2");
  }

  async function rollbackModule2Preset(promotionId: string) {
    const result = await api<any>(`/api/backtests/module2/tuning-promotions/${promotionId}/rollback`, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage("Module 2 configuration rolled back.");
    await refresh("high_probability_strategy_2");
  }

  async function runModule2HealthMonitor() {
    const result = await api<any>("/api/module2/health/run", { method: "POST", body: JSON.stringify({}) });
    setState((previous) => ({ ...previous, module2Health: result }));
    setMessage(`Module 2 health: ${result.summary?.status ?? "OK"} · ${result.summary?.warnings ?? 0} warning(s).`);
    await refresh("high_probability_strategy_2");
  }

  async function runModule2LaunchRehearsal() {
    const result = await api<any>("/api/module2/launch-rehearsal", { method: "POST", body: JSON.stringify({}) });
    setModule2DryRun(result.readiness?.dryRunResult ?? null);
    setState((previous) => ({
      ...previous,
      module2Operator: result,
      module2Readiness: result.readiness,
      module2Health: result.health,
      module2Audit: result.audit,
      module2Rehearsals: [result, ...(previous.module2Rehearsals ?? [])].slice(0, 20)
    }));
    setMessage(`Module 2 launch rehearsal: ${result.finalStatus === "GO" ? "GO" : "NO GO"} · ${result.handoff?.expectedNextAction ?? "Review checklist"}`);
    await refresh("high_probability_strategy_2");
  }

  async function runModule2Learning() {
    const result = await api<any>("/api/module2/learning/run", { method: "POST", body: JSON.stringify({}) });
    setState((previous) => ({ ...previous, module2Learning: result }));
    setMessage(`Module 2 learning complete: ${result.sample_size ?? 0} trades, ${(result.recommendations ?? []).length} recommendation(s).`);
    await refresh("high_probability_strategy_2");
  }

  async function createModule2LearningReview(recommendationId: string) {
    const result = await api<any>("/api/module2/learning/reviews", {
      method: "POST",
      body: JSON.stringify({ recommendationId })
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage("Module 2 learning recommendation added to review queue.");
    await refresh("high_probability_strategy_2");
  }

  async function updateModule2LearningReview(reviewId: string, status: string, note?: string) {
    const result = await api<any>(`/api/module2/learning/reviews/${reviewId}/status`, {
      method: "POST",
      body: JSON.stringify({ status, note })
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage(`Module 2 learning review marked ${status}.`);
    await refresh("high_probability_strategy_2");
  }

  async function generateModule2SessionReport() {
    const result = await api<any>("/api/module2/session-reports/generate", { method: "POST", body: JSON.stringify({}) });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage(`Module 2 session report generated: ${result.final_status}.`);
    await refresh("high_probability_strategy_2");
  }

  async function saveModule2SessionReportNotes(reportId: string, operatorNotes: string, trustedManually: boolean | null) {
    const result = await api<any>(`/api/module2/session-reports/${reportId}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ operatorNotes, trustedManually })
    });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage("Module 2 session report notes saved.");
    await refresh("high_probability_strategy_2");
  }

  async function runModule2CloseoutAction(action: "rerun" | "report-only" | "learning-only" | "reseed-reviews") {
    const labels = {
      "rerun": "full closeout",
      "report-only": "report recovery",
      "learning-only": "learning recovery",
      "reseed-reviews": "review queue reseed"
    };
    const result = await api<any>(`/api/module2/closeouts/${action}`, { method: "POST", body: JSON.stringify({}) });
    if (result.error) {
      setMessage(result.error);
      return;
    }
    setMessage(`Module 2 ${labels[action]} completed.`);
    await refresh("high_probability_strategy_2");
  }

  async function clearLiveCache() {
    const result = await api<any>(`/api/market-data/live/cache?symbol=${activeSymbol}&timeframeMinutes=${activeTimeframeMinutes}`, { method: "DELETE" });
    setMessage(`Live memory cache cleared: ${result.cleared ?? 0} candles removed.`);
    await refresh();
  }

  async function recoverStalePaperTrades() {
    const result = await api<any>(`/api/trades/recover-stale?moduleCode=${selectedModuleCode}`, {
      method: "POST",
      body: JSON.stringify({ olderThanHours: 6 })
    });
    setMessage(`${moduleShortName(selectedModuleCode)} stale paper recovery checked ${result.checked ?? 0}, closed ${result.recovered?.length ?? 0}.`);
    await refresh(selectedModuleCode);
  }

  async function runCacheBacktest() {
    if (selectedModuleCode === "orb_max_options" && state.orbDataReadiness?.readiness?.canBacktest === false) {
      setMessage(`Module 1 backtest blocked: ${state.orbDataReadiness.readiness.reason}`);
      return;
    }
    if (selectedModuleCode === "high_probability_strategy_2" && state.module2DataReadiness?.readiness?.canBacktest === false) {
      setMessage(`Module 2 backtest blocked: ${state.module2DataReadiness.readiness.reason}`);
      return;
    }
    const result = await api<any>("/api/backtests/memory-cache/run", {
      method: "POST",
      body: JSON.stringify({ symbol: activeSymbol, timeframeMinutes: activeTimeframeMinutes, moduleCode: selectedModuleCode })
    });
    setMessage(`${moduleShortName(selectedModuleCode)} backtest complete: ${result.run.summary?.trades ?? 0} trades, ${formatPercent(result.run.summary?.winRate)} win rate.`);
    await refresh();
  }

  async function runModule2Backfill() {
    const result = await api<any>("/api/module2/data-readiness/backfill", {
      method: "POST",
      body: JSON.stringify({ count: 100 })
    });
    setState((previous) => ({ ...previous, module2DataReadiness: result.after }));
    setMessage(`Module 2 backfill complete: imported ${result.result?.imported ?? 0} candles using about ${result.estimatedApiCreditsUsed ?? 1} API credit.`);
    await refresh("high_probability_strategy_2");
  }

  async function runOrbBackfill() {
    const result = await api<any>("/api/orb/data-readiness/backfill", {
      method: "POST",
      body: JSON.stringify({ count: 100 })
    });
    setState((previous) => ({ ...previous, orbDataReadiness: result.after }));
    setMessage(`Module 1 backfill complete: imported ${result.result?.imported ?? 0} candles using about ${result.estimatedApiCreditsUsed ?? 1} API credit.`);
    await refresh("orb_max_options");
  }

  async function acknowledgeNotification(id: string) {
    await api<any>(`/api/notifications/${id}/ack`, { method: "POST", body: JSON.stringify({}) });
    await refresh();
  }

  async function updateSetting(key: string, value: unknown) {
    await api<any>(`/api/tenant/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value })
    });
    setMessage(`${key} updated.`);
    await refresh();
  }

  async function updateModuleSetting(moduleCode: string, key: string, value: unknown) {
    await api<any>(`/api/tenant/modules/${moduleCode}/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value })
    });
    setMessage(`${key} updated for this user account.`);
    await refresh();
  }

  async function runOrbLearning() {
    const result = await api<any>("/api/admin/orb-learning/run", { method: "POST", body: JSON.stringify({}) });
    setMessage(`ORB learning complete: ${result.recommendations ?? 0} recommendations from ${result.sampleSize ?? 0} results.`);
    await refresh();
  }

  async function createTenant(input: { name: string; ownerEmail: string; password: string; planCode: string; moduleCodes: string[] }) {
    await api<any>("/api/platform/tenants", {
      method: "POST",
      body: JSON.stringify(input)
    });
    setMessage(`${input.name} subscriber created.`);
    await refresh();
  }

  async function updateTenantModules(tenantId: string, planCode: string, moduleCodes: string[]) {
    await api<any>(`/api/platform/tenants/${tenantId}/modules`, {
      method: "PUT",
      body: JSON.stringify({ planCode, moduleCodes })
    });
    setMessage("Subscriber plan and modules updated.");
    await refresh();
  }

  async function runPlatformAutomationNow() {
    await api<any>("/api/platform/automation/run", { method: "POST", body: JSON.stringify({}) });
    setMessage("Platform automation heartbeat completed.");
    await refresh();
  }

  async function runPlatformForceSync() {
    const result = await api<any>("/api/platform/market-data/force-sync", {
      method: "POST",
      body: JSON.stringify({ count: 2, reason: "Platform admin guarded force sync test" })
    });
    setMessage(`Force sync ${result.skipped ? "skipped" : "completed"}: ${result.reason ?? result.imported + " candle(s) imported"}.`);
    await refresh();
  }

  async function updateTenantAutomation(tenantId: string, enabled: boolean) {
    await api<any>(`/api/platform/tenants/${tenantId}/automation`, {
      method: "PUT",
      body: JSON.stringify({ enabled })
    });
    setMessage(enabled ? "Subscriber automation resumed." : "Subscriber automation paused.");
    await refresh();
  }

  async function updateTenantSubscription(tenantId: string, status: string, renewsAt: string | null) {
    await api<any>(`/api/platform/tenants/${tenantId}/subscription`, {
      method: "PUT",
      body: JSON.stringify({ status, renewsAt })
    });
    setMessage("Subscriber subscription updated.");
    await refresh();
  }

  async function updateTenantStatus(tenantId: string, status: "ACTIVE" | "PAUSED" | "REMOVED") {
    await api<any>(`/api/platform/tenants/${tenantId}/status`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    setMessage(status === "ACTIVE" ? "Subscriber resumed." : status === "PAUSED" ? "Subscriber paused. Login and automation are disabled." : "Subscriber removed. Login and automation are disabled.");
    await refresh();
  }

  async function deleteTenant(tenantId: string) {
    await api<any>(`/api/platform/tenants/${tenantId}`, { method: "DELETE" });
    setMessage("Subscriber deleted. Related access records were removed and historical trading records were preserved where configured.");
    await refresh();
  }

  async function resetSubscriberPassword(tenantId: string, password: string) {
    await api<any>(`/api/platform/tenants/${tenantId}/owner-password`, {
      method: "PUT",
      body: JSON.stringify({ password })
    });
    setMessage("Subscriber temporary password reset.");
    await refresh();
  }

  async function createBillingCheckout(planCode: string, mode: "SUBSCRIPTION" | "RENEWAL") {
    const result = await api<any>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ planCode, mode })
    });
    setMessage(`Manual payment request created. Invoice ${result.invoice?.invoice_number ?? "created"} is pending admin review.`);
    await refresh();
  }

  async function updateManualInvoiceStatus(invoiceId: string, status: "PAID" | "PAST_DUE" | "CANCELED") {
    await api<any>(`/api/platform/billing/invoices/${invoiceId}/status`, {
      method: "POST",
      body: JSON.stringify({ status })
    });
    setMessage(`Invoice marked ${status}. Subscription and automation state updated.`);
    await refresh();
  }

  async function updateSupportTicket(ticketId: string, status: string, priority?: string) {
    await api<any>(`/api/platform/support-tickets/${ticketId}`, {
      method: "PUT",
      body: JSON.stringify({ status, priority })
    });
    setMessage("Support ticket updated.");
    await refresh();
  }

  async function updatePlatformBusinessSettings(value: any) {
    await api<any>("/api/platform/business-settings", {
      method: "PUT",
      body: JSON.stringify({ value })
    });
    setMessage("Platform business settings updated.");
    await refresh();
  }

  async function createTenantSupportTicket(input: { ticketType: string; title: string; description: string; requestedModuleCode?: string | null }) {
    await api<any>("/api/tenant/support-tickets", {
      method: "POST",
      body: JSON.stringify(input)
    });
    setMessage("Support ticket submitted.");
    await refresh();
  }

  async function sendPlatformPushTest() {
    const result = await api<any>("/api/platform/push/test", { method: "POST" });
    setMessage(`Platform push test ${Number(result.sent ?? 0) > 0 ? "sent" : result.reason ?? "skipped"}.`);
    await refresh();
  }

  async function uploadMobileAppRelease(input: { file: File; changelog: string; versionName?: string; versionCode?: string }) {
    const form = new FormData();
    form.append("apk", input.file);
    form.append("changelog", input.changelog);
    if (input.versionName) form.append("versionName", input.versionName);
    if (input.versionCode) form.append("versionCode", input.versionCode);
    const result = await api<any>("/api/platform/mobile-app/releases", {
      method: "POST",
      body: form
    });
    setMessage(`Mobile APK ${result.version_name} uploaded. Android users will see the update prompt from the app.`);
    await refresh();
    return result;
  }

  async function updateTenantPushPreferences(preferences: any) {
    await api<any>("/api/mobile/push-preferences", {
      method: "PUT",
      body: JSON.stringify({ preferences })
    });
    setMessage("Mobile push preferences updated.");
    await refresh();
  }

  async function disableTenantPushDevice(deviceId: string) {
    await api<any>(`/api/mobile/push-devices/${deviceId}`, { method: "DELETE" });
    setMessage("Mobile push device disabled.");
    await refresh();
  }

  if (!authChecked) {
    return <main className="login-screen"><p className="reason">Checking admin session...</p></main>;
  }

  if (!user) {
    return <LoginScreen mode={isPlatformAdminRoute ? "platform" : "tenant"} onLogin={login} />;
  }

  if (user.passwordChangeRequired) {
    return <RequiredPasswordChangeScreen user={user} onChangePassword={changeOwnPassword} logout={logout} />;
  }

  if (user.mfaEnrollmentRequired) {
    return <RequiredMfaSetupScreen user={user} onStart={startMfaSetup} onEnable={enableMfa} logout={logout} />;
  }

  if (isPlatformAdminRoute) {
    return (
      <PlatformAdminApp
        state={state}
        user={user}
        can={can}
        message={message}
        refresh={refresh}
        logout={logout}
        createTenant={createTenant}
        updateTenantModules={updateTenantModules}
        runAutomationNow={runPlatformAutomationNow}
        forceSyncNow={runPlatformForceSync}
        updateTenantAutomation={updateTenantAutomation}
        updateTenantSubscription={updateTenantSubscription}
        updateTenantStatus={updateTenantStatus}
        deleteTenant={deleteTenant}
        resetSubscriberPassword={resetSubscriberPassword}
        updateManualInvoiceStatus={updateManualInvoiceStatus}
        updateSupportTicket={updateSupportTicket}
        updatePlatformBusinessSettings={updatePlatformBusinessSettings}
        sendPlatformPushTest={sendPlatformPushTest}
        uploadMobileAppRelease={uploadMobileAppRelease}
      />
    );
  }

  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <div className="brand-block">
          <img src={WEB_BRAND_LOGO} alt="XAUUSD Signal" />
          <span>Subscriber Dashboard</span>
        </div>
        <nav>
          {can("dashboard.view") ? <NavButton icon={<ShieldCheck />} label="Command Center" active={activeSection === "command"} onClick={() => setActiveSection("command")} /> : null}
          {can("chart.view") ? <NavButton icon={<LineChart />} label="Live Chart" active={activeSection === "live"} onClick={() => setActiveSection("live")} /> : null}
          {can("dashboard.view") ? <NavButton icon={<Database />} label="System Status" active={activeSection === "health"} onClick={() => setActiveSection("health")} /> : null}
          {can("signals.view") ? <NavButton icon={<Database />} label="Strategy Center" active={activeSection === "orb"} onClick={() => setActiveSection("orb")} /> : null}
          {can("reports.view") ? <NavButton icon={<FileText />} label="Reports" active={activeSection === "reports"} onClick={() => setActiveSection("reports")} /> : null}
          {can("reports.view") ? <NavButton icon={<LineChart />} label="Learning" active={activeSection === "learning"} onClick={() => setActiveSection("learning")} /> : null}
          {can("notifications.manage") ? <NavButton icon={<Bell />} label="Notifications" active={activeSection === "notifications"} onClick={() => setActiveSection("notifications")} /> : null}
          <NavButton icon={<CreditCard />} label="My Account" active={activeSection === "account"} onClick={() => setActiveSection("account")} />
          {can("settings.manage") ? <NavButton icon={<Settings />} label="Settings" active={activeSection === "settings"} onClick={() => setActiveSection("settings")} /> : null}
          {can("data.manage") ? <NavButton icon={<Database />} label="Data Admin" active={activeSection === "data"} onClick={() => setActiveSection("data")} /> : null}
        </nav>
        <div className="nav-footer">
          <span>{user.displayName}</span>
          <strong>{user.role}</strong>
          <button onClick={logout}><LogOut size={16} />Logout</button>
        </div>
      </aside>

      <section className="admin-main">
        <header className="topbar terminal-topbar">
          <div>
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <div className="clock-grid">
            <TimeBadge icon={<Clock size={16} />} label="New York" value={state.clocks?.newYork ?? "--"} />
            <TimeBadge icon={<Clock size={16} />} label="Nepal" value={state.clocks?.nepal ?? "--"} />
          </div>
        </header>

        <section className="status-strip auto-status-strip">
          <Status label="Symbol" value={activeSymbol} />
          <Status label="Timeframe" value={`${activeTimeframeMinutes}m`} />
          <Status label="Session" value={state.session?.state ?? "AUTO WAITING"} tone={toneFor(state.session?.state)} />
          <Status label="Market Feed" value={state.feedStatus?.live ? "LIVE" : state.feedStatus?.testMode ? "TEST" : state.feedStatus?.latestCandle ? "STALE" : "WAITING"} tone={state.feedStatus?.live ? "good" : "warn"} />
          <Status label="Provider" value={feedProviderLabel(state.feedStatus?.provider)} tone={state.feedStatus?.live ? "good" : "neutral"} />
          <Status label="Module" value={activeModule?.name ?? "No modules assigned"} tone={activeModule ? "good" : "warn"} />
          <Status label="Paper Mode" value="AUTO" tone="good" />
          <Status label="Real Orders" value="OFF" tone="bad" />
        </section>

        {!accountLocked ? (
          <section className="module-switcher">
            {enabledModules.map((module: any) => (
              <button
                key={module.code}
                className={selectedModuleCode === module.code ? "active" : ""}
                onClick={() => setActiveModuleCode(module.code)}
              >
                <Layers size={15} />
                <span>{moduleShortName(module.code, module.name)}</span>
              </button>
            ))}
          </section>
        ) : null}

        {accountLocked && activeSection !== "account" && activeSection !== "health" ? (
          <section className="admin-page-grid">
            <AccountLockedPanel state={state} subscriptionActive={subscriptionActive} />
          </section>
        ) : null}

        {activeSection === "command" && !accountLocked ? (
          <section className="admin-page-grid command-center-grid">
            <CrossModuleCommandCenter
              state={state}
              modules={enabledModules}
              activeModuleCode={selectedModuleCode}
              onOpenModule={(moduleCode) => {
                setActiveModuleCode(moduleCode);
                setActiveSection("live");
              }}
              onRunRehearsal={(moduleCode) => {
                if (moduleCode === "orb_max_options") return runOrbLaunchRehearsal();
                if (moduleCode === "high_probability_strategy_2") return runModule2LaunchRehearsal();
                return runModule3LaunchRehearsal();
              }}
            />
          </section>
        ) : null}

        {activeSection === "account" ? (
          <section className="admin-page-grid">
            <MyAccountPanel state={state} user={user} onCheckout={createBillingCheckout} onCreateTicket={createTenantSupportTicket} onSavePushPreferences={updateTenantPushPreferences} onDisablePushDevice={disableTenantPushDevice} onStartMfa={startMfaSetup} onEnableMfa={enableMfa} onDisableMfa={disableMfa} />
            <AccountModulesPanel state={state} />
            <PlanUsagePanel state={state} />
            <PasswordPlaceholderPanel />
          </section>
        ) : null}

        {activeSection === "health" ? (
          <section className="admin-page-grid">
            <ProductionHealthDashboard
              state={state}
              modules={enabledModules}
              activeModuleCode={selectedModuleCode}
              onRefresh={() => refresh().catch(() => setMessage("Health refresh failed."))}
              onRecoverStale={() => recoverStalePaperTrades().catch(() => setMessage("Stale paper recovery failed."))}
              onOpenData={() => setActiveSection("data")}
              onOpenChart={(moduleCode) => {
                setActiveModuleCode(moduleCode);
                setActiveSection("live");
              }}
            />
          </section>
        ) : null}

        {activeSection === "live" && !accountLocked ? (
          <section className="auto-layout admin-section">
            <section className="chart-shell auto-chart-shell">
              <div className="chart-head">
                <div>
                  <h2><LineChart size={18} />Live Chart and Indicators</h2>
                  <p className="chart-subtitle">{signal.reason}</p>
                </div>
                <div className="chart-head-actions">
                  <strong className={`signal-badge ${signal.tone}`}>{signal.label}</strong>
                  <button onClick={() => refresh().catch(() => setMessage("Refresh failed."))}><LineChart size={16} />Refresh</button>
                  <button onClick={() => browserNotify("XAUUSD ORB alerts", "Browser notifications are enabled.")}><Bell size={16} />Alerts</button>
                </div>
              </div>
              <TwelveDataChart
                symbol={activeSymbol}
                timeframeMinutes={activeTimeframeMinutes}
                moduleCode={selectedModuleCode}
                moduleName={activeModule?.name}
                session={state.session}
                openingRange={selectedModuleCode === "orb_max_options" ? orb : null}
                setup={currentModuleSetup}
                priceLines={moduleChartPriceLines(selectedModuleCode, currentModuleSetup, orb)}
                showEma={selectedModuleCode !== "orb_max_options"}
                onMessage={setMessage}
              />
            </section>

            <aside className="auto-sidebar">
              <LiveSystemStatusPanel state={state} moduleCode={selectedModuleCode} setup={currentModuleSetup} trade={currentModuleTrade} feedHealth={feedHealth} />
              <LiveStrategyCenterPanel
                moduleCode={selectedModuleCode}
                moduleName={activeModule?.name}
                setup={currentModuleSetup}
                trade={currentModuleTrade}
                tradePlan={currentModuleTradePlan}
                evaluations={ruleEvaluations}
                openingRange={selectedModuleCode === "orb_max_options" ? orb : null}
                session={state.session}
              />
            </aside>
          </section>
        ) : null}

        {activeSection === "orb" && !accountLocked ? (
          <section className="admin-page-grid">
            {selectedModuleCode === "orb_max_options" ? <ModulePerformancePanel state={state} moduleCode={selectedModuleCode} moduleName={activeModule?.name} /> : <ModuleStrategyPanel setup={currentModuleSetup} moduleCode={selectedModuleCode} moduleName={activeModule?.name ?? "Strategy Module"} />}
            <ScenarioStatsPanel state={state} />
            <Panel icon={<CheckCircle2 />} title="Rule Checklist">
              <RuleList evaluations={ruleEvaluations} setup={currentModuleSetup} session={state.session} moduleCode={selectedModuleCode} />
            </Panel>
            <Panel icon={<Database />} title="Scenario Evidence">
              <Metric label="Sweep" value={formatSweep(scenarioFlags.sweep)} />
              <Metric label="Fakeout" value={scenarioFlags.failedBreakoutState ?? "--"} />
              <Metric label="Prior fakeout" value={scenarioFlags.priorFailedBreakout?.type ?? "--"} />
              <Metric label="Retest" value={scenarioFlags.retest ?? "--"} />
              <Metric label="Midpoint crosses" value={scenarioFlags.midpointCrossCount ?? "--"} />
              <Metric label="Candles after ORB" value={scenarioMatrix.candlesAfterOrb ?? "--"} />
              <Metric label="Body ratio" value={formatRatio(breakoutProfile.bodyRatio ?? favorabilityFlags.bodyRatio)} />
              <Metric label="Close location" value={formatRatio(breakoutProfile.closeLocationRatio ?? favorabilityFlags.closeLocationRatio)} />
              <Metric label="Trend" value={favorabilityFlags.trend ? `${favorabilityFlags.trend}${favorabilityFlags.trendAligned ? " aligned" : ""}` : "--"} />
            </Panel>
            <Panel icon={<LineChart />} title="Why">
              <p className="reason">{currentModuleSetup?.final_reason ?? "The system is waiting for this module to produce a completed signal candle."}</p>
              <div className="signal-reasons">
                {reasons.length > 0 ? reasons.slice(0, 6).map((reason: string) => <span key={reason}>{reason}</span>) : <span>No setup scored yet</span>}
              </div>
            </Panel>
            <Panel icon={<Database />} title="ORB Levels">
              <Metric label="High" value={orb?.high ?? "--"} />
              <Metric label="Midpoint" value={orb?.midpoint ?? "--"} />
              <Metric label="Low" value={orb?.low ?? "--"} />
              {state.orbRangeAudit ? (
                <div className="mini-audit-list">
                  <div className="mini-audit-row">
                    <span>Range window</span>
                    <strong>{state.orbRangeAudit.sessionStartNepal ?? "--"} - {state.orbRangeAudit.openingRangeEndNepal ?? "--"} NPT</strong>
                  </div>
                  <div className="mini-audit-row">
                    <span>Source candles</span>
                    <strong>{state.orbRangeAudit.candles?.length ?? 0}/{state.orbRangeAudit.expectedSourceCandles ?? "--"} x {state.orbRangeAudit.sourceTimeframeMinutes ?? "--"}M</strong>
                  </div>
                  <div className="mini-audit-row">
                    <span>Recalculated</span>
                    <strong>
                      H {formatPriceValue(state.orbRangeAudit.recalculatedOpeningRange?.high)} / L {formatPriceValue(state.orbRangeAudit.recalculatedOpeningRange?.low)}
                    </strong>
                  </div>
                  <div className="orb-source-candles">
                    {(state.orbRangeAudit.candles ?? []).map((candle: any) => (
                      <div key={candle.timestampUtc}>
                        <span>{candle.nepalTime}</span>
                        <strong>H {formatPriceValue(candle.high)} / L {formatPriceValue(candle.low)}</strong>
                      </div>
                    ))}
                    {(state.orbRangeAudit.candles ?? []).length === 0 ? <p className="reason">No saved source candles found for the ORB window yet.</p> : null}
                  </div>
                </div>
              ) : null}
            </Panel>
          </section>
        ) : null}

        {activeSection === "reports" && !accountLocked ? (
          <section className="admin-page-grid">
            {selectedModuleCode === "orb_max_options" ? <LearningPanel state={state} onRun={runOrbLearning} /> : null}
            <Panel icon={<FileText />} title="Weekly Report">
              <Metric label="Week win ratio" value={formatPercent(latestWeek?.winRatio)} />
              <Metric label="Week trades" value={latestWeek?.totalTrades ?? 0} />
              <Metric label="Week total R" value={formatR(latestWeek?.totalR)} />
              <Metric label="Week average R" value={formatR(latestWeek?.avgR)} />
            </Panel>
            <Panel icon={<FileText />} title="Monthly Report">
              <Metric label="Month win ratio" value={formatPercent(latestMonth?.winRatio)} />
              <Metric label="Month trades" value={latestMonth?.totalTrades ?? 0} />
              <Metric label="Month total R" value={formatR(latestMonth?.totalR)} />
              <Metric label="Month average R" value={formatR(latestMonth?.avgR)} />
            </Panel>
            <ModulePerformancePanel state={state} moduleCode={selectedModuleCode} moduleName={activeModule?.name} />
            <StrategyConfidencePanel confidence={state.strategyConfidence} activeModuleCode={selectedModuleCode} />
            <ScenarioStatsPanel state={state} />
            <BacktestSummaryPanel state={state} moduleCode={selectedModuleCode} onRun={runCacheBacktest} />
            {selectedModuleCode === "orb_max_options" ? (
              <>
                <OrbCompletionCenter state={state} qaSuite={orbQaSuite} />
                <ModuleLaunchRehearsalPanel moduleName="Module 1" rehearsals={state.orbRehearsals} onRun={runOrbLaunchRehearsal} />
                <OrbDataReadinessPanel readiness={state.orbDataReadiness} onBackfill={runOrbBackfill} onBacktest={runCacheBacktest} />
              </>
            ) : null}
            {selectedModuleCode === "high_probability_strategy_2" ? (
              <>
                <Module2ProductionCockpit state={state} setup={currentModuleSetup} trade={currentModuleTrade} onRunRehearsal={runModule2LaunchRehearsal} />
                <Module2CompletionCenter state={state} qaSuite={module2QaSuite} />
                <Module2DataReadinessPanel readiness={state.module2DataReadiness} onBackfill={runModule2Backfill} onBacktest={runCacheBacktest} />
                <Module2CloseoutPanel closeouts={state.module2Closeouts} onAction={runModule2CloseoutAction} />
                <Module2SessionReportsPanel reports={state.module2SessionReports} onGenerate={generateModule2SessionReport} onSaveNotes={saveModule2SessionReportNotes} />
                <Module2JournalPanel
                  state={state}
                  setup={currentModuleSetup}
                  selectedTradeId={selectedModule2TradeId}
                  detail={module2TradeDetail}
                  onSelectTrade={loadModule2TradeDetail}
                  onLifecycle={runModule2Lifecycle}
                />
                <Module2LearningPanel
                  learning={state.module2Learning}
                  reviews={state.module2LearningReviews}
                  onRun={runModule2Learning}
                  onCreateReview={createModule2LearningReview}
                  onUpdateReview={updateModule2LearningReview}
                />
                <Module2HealthPanel health={state.module2Health} onRun={runModule2HealthMonitor} />
              <Module2HandoffReportPanel operator={state.module2Operator} />
                <Module2LaunchEvidenceLogPanel rehearsals={state.module2Rehearsals} />
                <Module2ProductionAuditPanel audit={state.module2Audit} />
                <Module2RuleAuditPanel setup={currentModuleSetup} />
                <Module2FinalReadinessChecklist readiness={state.module2Readiness} audit={state.module2Audit} dryRun={module2DryRun} />
                <Module2TuningLabPanel
                  lab={module2TuningLab ?? state.module2TuningLab}
                  history={state.module2TuningHistory}
                  onRun={runModule2TuningLab}
                  onApply={applyModule2Preset}
                  onRollback={rollbackModule2Preset}
                />
                <Module2BacktestTable latest={state.latestBacktest} />
              </>
            ) : null}
            {selectedModuleCode === "strategy_lab_3" ? (
              <>
                <ModuleCompletionCenter
                  moduleName="Module 3 VWAP Drive"
                  dataReadiness={state.module3DataReadiness}
                  qaSuite={module3QaSuite}
                  learning={state.module3Learning}
                  journalTrades={state.module3JournalTrades}
                  reports={state.module3SessionReports}
                  rehearsals={state.module3Rehearsals}
                  confidence={state.strategyConfidence}
                  setupHistory={state.module3SetupHistory}
                />
                <ModuleDataReadinessPanel title="Module 3 Data Readiness" readiness={state.module3DataReadiness} onBackfill={runModule3Backfill} onBacktest={runCacheBacktest} />
                <ModuleLaunchRehearsalPanel moduleName="Module 3" rehearsals={state.module3Rehearsals} onRun={runModule3LaunchRehearsal} />
                <Module3ResultsReportPanel state={state} />
                <Module3SetupHistoryPanel history={state.module3SetupHistory} />
                <ModuleSessionReportsPanel moduleName="Module 3" reports={state.module3SessionReports} onGenerate={generateModule3SessionReport} />
                <ModuleJournalPanel
                  moduleName="Module 3"
                  trades={state.module3JournalTrades}
                  setup={currentModuleSetup}
                  selectedTradeId={selectedModule3TradeId}
                  detail={module3TradeDetail}
                  onSelectTrade={loadModule3TradeDetail}
                  onLifecycle={(event, tradeId, setupId) => runModuleLifecycle("strategy_lab_3", event, tradeId, setupId)}
                />
                <ModuleLearningPanel moduleName="Module 3" learning={state.module3Learning} onRun={runModule3Learning} />
                <Module3RuleAuditPanel setup={currentModuleSetup} />
                <Module3BacktestTable latest={state.latestBacktest} />
              </>
            ) : null}
          </section>
        ) : null}

        {activeSection === "learning" && !accountLocked ? (
          <section className="admin-page-grid">
            <UnifiedLearningDashboard
              state={state}
              modules={enabledModules}
              onRun={(moduleCode) => {
                if (moduleCode === "orb_max_options") return runOrbLearning();
                if (moduleCode === "high_probability_strategy_2") return runModule2Learning();
                return runModule3Learning();
              }}
              onOpenReports={(moduleCode) => {
                setActiveModuleCode(moduleCode);
                setActiveSection("reports");
              }}
            />
          </section>
        ) : null}

        {activeSection === "notifications" && !accountLocked ? (
          <section className="admin-page-grid">
            <ModuleNotificationSummaryPanel summary={state.notificationSummary} notifications={state.notifications} />
            <Panel icon={<Bell />} title="Notifications">
              <NotificationFilters filters={notificationFilters} onChange={setNotificationFilters} onRefresh={() => refresh().catch(() => undefined)} />
              <div className="admin-list">
                {(state.notifications ?? []).map((item: any) => (
                  <div className="notice-row" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.body}</span>
                      <em>{formatNepalTime(item.created_at)} · {item.priority}</em>
                    </div>
                    {item.acknowledged_at ? <span className="pill good">ACK</span> : <button onClick={() => acknowledgeNotification(item.id).catch(() => setMessage("Notification ack failed."))}>Acknowledge</button>}
                  </div>
                ))}
                {(state.notifications ?? []).length === 0 ? <p className="reason">No notifications yet.</p> : null}
              </div>
            </Panel>
          </section>
        ) : null}

        {activeSection === "settings" ? (
          <section className="admin-page-grid">
            <SettingsEditor settings={state.settings ?? []} onUpdate={updateSetting} />
            {selectedModuleCode === "orb_max_options"
              ? <OrbStrategySettings settings={state.orbModuleSettings ?? []} onUpdate={(key, value) => updateModuleSetting("orb_max_options", key, value)} />
              : selectedModuleCode === "strategy_lab_3"
                ? <VwapOpeningDriveSettings settings={state.activeModuleSettings ?? []} onUpdate={(key, value) => updateModuleSetting(selectedModuleCode, key, value)} />
                : <LiquiditySweepSettings settings={state.activeModuleSettings ?? []} onUpdate={(key, value) => updateModuleSetting(selectedModuleCode, key, value)} />}
            <PlanUsagePanel state={state} />
            <Panel icon={<Settings />} title="Trading Settings">
              <Metric label="Symbol" value={activeSymbol} />
              <Metric label="Strategy" value={activeVersion ? `v${activeVersion.version}` : "Not seeded"} />
              <Metric label="Signal timeframe" value={`${activeTimeframeMinutes} minutes`} />
              <Metric label="Session start NPT" value={formatNepalTime(state.automationStatus?.sessionStartAt)} />
              <Metric label="Session stop NPT" value={formatNepalTime(state.automationStatus?.apiStopAt)} />
              <Metric label="External execution" value="Disabled" />
            </Panel>
            <Panel icon={<Settings />} title="Feed Settings">
              <Metric label="Provider" value={feedProviderLabel(state.feedStatus?.provider)} />
              <Metric label="Twelve Data" value={state.twelveStatus?.configured === false ? "API KEY MISSING" : "Configured"} />
              <Metric label="Polling" value={state.twelveStatus?.pollSeconds ? `${state.twelveStatus.pollSeconds}s` : "--"} />
              <Metric label="Raw candle storage" value={state.twelveStatus?.persistRawCandles === false ? "OFF" : "ON"} />
              <Metric label="Cache retention" value={state.cacheStatus?.cacheDays ? `${state.cacheStatus.cacheDays} days` : "--"} />
            </Panel>
          </section>
        ) : null}

        {activeSection === "data" && !accountLocked ? (
          <section className="admin-page-grid">
            <DataAdminPanel state={state} refresh={refresh} runCacheBacktest={runCacheBacktest} clearLiveCache={clearLiveCache} clearTestSignals={clearTestSignals} />
            {selectedModuleCode === "orb_max_options" ? (
              <>
                <OrbDataReadinessPanel readiness={state.orbDataReadiness} onBackfill={runOrbBackfill} onBacktest={runCacheBacktest} />
                <ModuleLaunchRehearsalPanel moduleName="Module 1" rehearsals={state.orbRehearsals} onRun={runOrbLaunchRehearsal} />
                <OrbQAControlPanel onRunSuite={runOrbQaSuite} suite={orbQaSuite} />
                <Panel icon={<Database />} title="ORB Replay">
                  <div className="replay-grid">
                    <button onClick={() => triggerOrbReplay("BUY").catch(() => setMessage("Replay BUY failed."))}>BUY</button>
                    <button onClick={() => triggerOrbReplay("SELL").catch(() => setMessage("Replay SELL failed."))}>SELL</button>
                    <button onClick={() => triggerOrbReplay("RETEST").catch(() => setMessage("Replay retest failed."))}>Retest</button>
                    <button onClick={() => triggerOrbReplay("FAKEOUT").catch(() => setMessage("Replay fakeout failed."))}>Fakeout</button>
                    <button onClick={() => triggerOrbReplay("SWEEP_REVERSAL").catch(() => setMessage("Replay sweep failed."))}>Sweep</button>
                    <button onClick={() => triggerOrbReplay("OVEREXTENDED").catch(() => setMessage("Replay overextended failed."))}>Overext</button>
                    <button onClick={() => triggerOrbReplay("NO_TRADE").catch(() => setMessage("Replay no-trade failed."))}>No Trade</button>
                    <button onClick={() => clearTestSignals().catch(() => setMessage("Clear replay failed."))}>Clear</button>
                  </div>
                  <p className="reason">Replay uses fake candles through the real ORB engine. No Twelve Data call, no real order.</p>
                </Panel>
                <Panel icon={<LineChart />} title="ORB Test Signals">
                  <div className="admin-actions">
                    <button onClick={() => triggerTestSignal("LONG").catch(() => setMessage("Test BUY failed."))}>Test BUY</button>
                    <button onClick={() => triggerTestSignal("SHORT").catch(() => setMessage("Test SELL failed."))}>Test SELL</button>
                  </div>
                  <p className="reason">Test signals are only for UI and notification QA. They are excluded from ORB performance.</p>
                </Panel>
              </>
            ) : null}
            {selectedModuleCode === "high_probability_strategy_2" ? (
              <>
                <Module2DataReadinessPanel readiness={state.module2DataReadiness} onBackfill={runModule2Backfill} onBacktest={runCacheBacktest} />
                <Module2QAControlPanel onReplay={triggerModule2Replay} onRunSuite={runModule2QaSuite} suite={module2QaSuite} onDryRun={runModule2DryRun} onClear={clearTestSignals} />
                <Module2LifecycleTester setup={currentModuleSetup} trade={currentModuleTrade} onLifecycle={runModule2Lifecycle} />
                <Module2RuleAuditPanel setup={currentModuleSetup} />
                <Module2LaunchEvidenceLogPanel rehearsals={state.module2Rehearsals} />
              </>
            ) : null}
            {selectedModuleCode === "strategy_lab_3" ? (
              <>
                <ModuleDataReadinessPanel title="Module 3 Data Readiness" readiness={state.module3DataReadiness} onBackfill={runModule3Backfill} onBacktest={runCacheBacktest} />
                <ModuleLaunchRehearsalPanel moduleName="Module 3" rehearsals={state.module3Rehearsals} onRun={runModule3LaunchRehearsal} />
                <Module3QAControlPanel onReplay={triggerModule3Replay} onRunSuite={runModule3QaSuite} suite={module3QaSuite} onClear={clearTestSignals} />
                <Module3RuleAuditPanel setup={currentModuleSetup} />
              </>
            ) : null}
            <BacktestSummaryPanel state={state} moduleCode={selectedModuleCode} onRun={runCacheBacktest} />
          </section>
        ) : null}
      </section>
    </main>
  );
}

function LoginScreen({ mode, onLogin }: { mode: "platform" | "tenant"; onLogin: (email: string, password: string, otp?: string) => Promise<void> }) {
  const [email, setEmail] = useState(mode === "platform" ? "" : "admin@orb.local");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onLogin(email, password, otp);
    } catch (error) {
      const message = (error as Error).message;
      setError(
        message.includes("Too many login attempts")
          ? message
          : message.includes("Two-factor")
            ? "Enter your 6-digit two-factor code."
            : message.includes("Platform admin") || message.includes("Subscriber account")
              ? message
              : "Invalid admin email or password."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><img src={WEB_BRAND_MARK} alt="" /></div>
        <h1>{mode === "platform" ? "Platform Admin" : "Subscriber Dashboard"}</h1>
        <p>{mode === "platform" ? "Sign in to manage subscribers, modules, plans, platform settings, and production operations." : "Sign in to monitor assigned strategy modules, live chart signals, reports, notifications, and account settings."}</p>
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoFocus />
        </label>
        <label>
          Password
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
        </label>
        <label>
          Two-factor code
          <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="Optional unless enabled" />
        </label>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="wide" disabled={loading}>{loading ? "Signing in..." : "Sign In"}</button>
      </form>
    </main>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      {React.cloneElement(icon as React.ReactElement, { size: 17 })}
      <span>{label}</span>
    </button>
  );
}

function RequiredPasswordChangeScreen({
  user,
  onChangePassword,
  logout
}: {
  user: AdminUser;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    setLoading(true);
    try {
      await onChangePassword(currentPassword, newPassword);
    } catch (error) {
      setError((error as Error).message || "Password change failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><img src={WEB_BRAND_MARK} alt="" /></div>
        <h1>Change Password</h1>
        <p>Platform admin created a temporary password for {user.email}. Set your own password before opening the dashboard.</p>
        <label>
          Temporary password
          <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoFocus />
        </label>
        <label>
          New password
          <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" />
        </label>
        <label>
          Confirm new password
          <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" />
        </label>
        <p className="reason">Use at least 12 characters with uppercase, lowercase, number, and symbol.</p>
        {error ? <p className="form-error">{error}</p> : null}
        <button disabled={loading}>{loading ? "Changing..." : "Change Password"}</button>
        <button type="button" className="secondary-button" onClick={logout}>Logout</button>
      </form>
    </main>
  );
}

function RequiredMfaSetupScreen({
  user,
  onStart,
  onEnable,
  logout
}: {
  user: AdminUser;
  onStart: () => Promise<{ secret: string; otpAuthUrl: string }>;
  onEnable: (otp: string) => Promise<void>;
  logout: () => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; otpAuthUrl: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function start() {
    setError("");
    setLoading(true);
    try {
      const next = await onStart();
      setSetup(next);
      setQrDataUrl(await QRCode.toDataURL(next.otpAuthUrl, { margin: 1, width: 220, color: { dark: "#07100c", light: "#f4f7f4" } }));
    } catch (error) {
      setError((error as Error).message || "Could not start two-factor setup.");
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onEnable(otp);
    } catch (error) {
      setError((error as Error).message || "Invalid two-factor code.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-mark"><ShieldCheck size={22} /></div>
        <h1>Enable Two-Factor</h1>
        <p>Platform admin access requires a 6-digit authenticator code. Add this account in Google Authenticator, Microsoft Authenticator, Authy, or any TOTP app.</p>
        <Metric label="Account" value={user.email} />
        {!setup ? (
          <button type="button" className="wide" disabled={loading} onClick={start}>{loading ? "Starting..." : "Start Setup"}</button>
        ) : (
          <>
            {qrDataUrl ? (
              <div className="mfa-qr-wrap">
                <img src={qrDataUrl} alt="Scan this QR code in your authenticator app" />
                <span>Scan with Google Authenticator</span>
              </div>
            ) : null}
            <label>
              Secret
              <input readOnly value={setup.secret} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label>
              Authenticator URL
              <textarea readOnly value={setup.otpAuthUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <label>
              6-digit code
              <input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoFocus />
            </label>
            <p className="reason">Copy the secret or URL into your authenticator app, then enter the current 6-digit code to finish setup.</p>
            <button className="wide" disabled={loading || otp.length !== 6}>{loading ? "Verifying..." : "Enable 2FA"}</button>
          </>
        )}
        {error ? <p className="form-error">{error}</p> : null}
        <button type="button" className="secondary-button" onClick={logout}>Logout</button>
      </form>
    </main>
  );
}

function PlatformAdminApp({
  state,
  user,
  can,
  message,
  refresh,
  logout,
  createTenant,
  updateTenantModules,
  runAutomationNow,
  forceSyncNow,
  updateTenantAutomation,
  updateTenantSubscription,
  updateTenantStatus,
  deleteTenant,
  resetSubscriberPassword,
  updateManualInvoiceStatus,
  updateSupportTicket,
  updatePlatformBusinessSettings,
  sendPlatformPushTest,
  uploadMobileAppRelease
}: {
  state: PanelState;
  user: AdminUser;
  can: (permission: string) => boolean | undefined;
  message: string;
  refresh: () => Promise<void>;
  logout: () => void;
  createTenant: (input: { name: string; ownerEmail: string; password: string; planCode: string; moduleCodes: string[] }) => Promise<void>;
  updateTenantModules: (tenantId: string, planCode: string, moduleCodes: string[]) => Promise<void>;
  runAutomationNow: () => Promise<void>;
  forceSyncNow: () => Promise<void>;
  updateTenantAutomation: (tenantId: string, enabled: boolean) => Promise<void>;
  updateTenantSubscription: (tenantId: string, status: string, renewsAt: string | null) => Promise<void>;
  updateTenantStatus: (tenantId: string, status: "ACTIVE" | "PAUSED" | "REMOVED") => Promise<void>;
  deleteTenant: (tenantId: string) => Promise<void>;
  resetSubscriberPassword: (tenantId: string, password: string) => Promise<void>;
  updateManualInvoiceStatus: (invoiceId: string, status: "PAID" | "PAST_DUE" | "CANCELED") => Promise<void>;
  updateSupportTicket: (ticketId: string, status: string, priority?: string) => Promise<void>;
  updatePlatformBusinessSettings: (value: any) => Promise<void>;
  sendPlatformPushTest: () => Promise<void>;
  uploadMobileAppRelease: (input: { file: File; changelog: string; versionName?: string; versionCode?: string }) => Promise<any>;
}) {
  const [platformSection, setPlatformSectionState] = useState<PlatformSection>(() => platformSectionFromPath(window.location.pathname));
  const [selectedSubscriberId, setSelectedSubscriberId] = useState<string | null>(null);
  const [showSubscriberCreate, setShowSubscriberCreate] = useState(false);
  function setPlatformSection(section: PlatformSection) {
    setPlatformSectionState(section);
    window.history.replaceState(null, "", section === "overview" ? "/platform-admin" : `/platform-admin/${section}`);
  }
  if (!can("platform.manage")) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="login-mark"><ShieldCheck size={22} /></div>
          <h1>Platform Admin</h1>
          <p>Your account does not have super-user platform access.</p>
          <button onClick={logout}>Logout</button>
        </section>
      </main>
    );
  }

  const platform = state.platform ?? {};
  const tenants = platform.tenants ?? [];
  const modules = platform.modules ?? [];
  const plans = platform.plans ?? [];
  const usage = state.platformUsage;
  const platformTitle = platformSectionTitle(platformSection);
  const platformSubtitle = platformSectionSubtitle(platformSection);

  return (
    <main className="platform-shell">
      <aside className="platform-nav">
        <div className="brand-block">
          <img src={WEB_BRAND_LOGO} alt="XAUUSD Signal" />
          <span>Super Admin Console</span>
        </div>
        <nav className="platform-menu">
          <PlatformNavGroup label="Business">
            <PlatformNavButton icon={<LineChart />} label="Overview" active={platformSection === "overview"} onClick={() => setPlatformSection("overview")} />
            <PlatformNavButton icon={<Users />} label="Subscribers" active={platformSection === "subscribers"} onClick={() => setPlatformSection("subscribers")} />
            <PlatformNavButton icon={<FileText />} label="Tickets" active={platformSection === "tickets"} onClick={() => setPlatformSection("tickets")} />
            <PlatformNavButton icon={<CreditCard />} label="Billing" active={platformSection === "billing"} onClick={() => setPlatformSection("billing")} />
          </PlatformNavGroup>
          <PlatformNavGroup label="Product">
            <PlatformNavButton icon={<Layers />} label="Strategy Modules" active={platformSection === "modules"} onClick={() => setPlatformSection("modules")} />
            <PlatformNavButton icon={<KeyRound />} label="Plans & Access" active={platformSection === "plans"} onClick={() => setPlatformSection("plans")} />
            <PlatformNavButton icon={<Smartphone />} label="App Updates" active={platformSection === "app-updates"} onClick={() => setPlatformSection("app-updates")} />
            <PlatformNavButton icon={<Database />} label="Usage & Data" active={platformSection === "usage"} onClick={() => setPlatformSection("usage")} />
          </PlatformNavGroup>
          <PlatformNavGroup label="Operations">
            <PlatformNavButton icon={<Clock />} label="Automation" active={platformSection === "automation"} onClick={() => setPlatformSection("automation")} />
            <PlatformNavButton icon={<ShieldCheck />} label="System" active={platformSection === "system"} onClick={() => setPlatformSection("system")} />
            <PlatformNavButton icon={<Settings />} label="Settings" active={platformSection === "settings"} onClick={() => setPlatformSection("settings")} />
          </PlatformNavGroup>
        </nav>
        <div className="nav-footer">
          <span>{user.displayName}</span>
          <strong>SUPER USER</strong>
          <button onClick={logout}><LogOut size={16} />Logout</button>
        </div>
      </aside>

      <section className="platform-main">
        <header className="platform-header">
          <div>
            <span className="eyebrow">Platform Admin</span>
            <h1>{platformTitle}</h1>
            <p>{platformSubtitle}</p>
            <p>{message}</p>
          </div>
          <div className="platform-actions">
            <button onClick={() => runAutomationNow().catch(() => undefined)}><LineChart size={16} />Run Automation Now</button>
            <button onClick={() => refresh().catch(() => undefined)}><Database size={16} />Refresh</button>
            <button onClick={() => setPlatformSection("modules")}><Layers size={16} />Modules</button>
            <button onClick={() => setPlatformSection("plans")}><KeyRound size={16} />Plans</button>
          </div>
        </header>

        {platformSection === "overview" ? <section className="platform-metrics">
          <PlatformMetric icon={<Users />} label="Subscribers" value={platform.metrics?.tenants ?? tenants.length} />
          <PlatformMetric icon={<CheckCircle2 />} label="Active subscribers" value={platform.metrics?.activeTenants ?? 0} />
          <PlatformMetric icon={<Layers />} label="Strategy modules" value={platform.metrics?.modules ?? modules.length} />
          <PlatformMetric icon={<CreditCard />} label="Plans" value={platform.metrics?.plans ?? plans.length} />
          <PlatformMetric icon={<Database />} label="Twelve Data today" value={`${usage?.creditsUsedToday ?? 0}/${usage?.dailyLimit ?? 800}`} />
          <PlatformMetric icon={<Clock />} label="Credit guardrail" value={usage?.guardrail?.status ?? "OK"} />
          <PlatformMetric icon={<ShieldCheck />} label="Worker health" value={usage?.worker?.health ?? "UNKNOWN"} />
        </section> : null}

        <section className="platform-grid">
          {platformSection === "overview" ? <PlatformOverviewPanel platform={platform} tenants={tenants} modules={modules} usage={usage} automationRows={state.platformAutomation ?? []} /> : null}
          {platformSection === "subscribers" ? (
            <PlatformSubscribersPanel
              tenants={tenants}
              plans={plans}
              modules={modules}
              selectedTenantId={selectedSubscriberId}
              showCreate={showSubscriberCreate}
              onShowCreate={setShowSubscriberCreate}
              onSelectTenant={setSelectedSubscriberId}
              onCreate={createTenant}
              onUpdate={updateTenantModules}
              onUpdateSubscription={updateTenantSubscription}
              onUpdateStatus={updateTenantStatus}
              onDelete={deleteTenant}
              onResetPassword={resetSubscriberPassword}
            />
          ) : null}
          {platformSection === "tickets" ? <PlatformTicketsPanel tickets={state.platformTickets ?? []} onUpdate={updateSupportTicket} /> : null}
          {platformSection === "modules" ? <PlatformModulesPanel modules={modules} /> : null}
          {platformSection === "plans" ? <PlatformPlansPanel plans={plans} /> : null}
          {platformSection === "app-updates" ? <PlatformAppUpdatesPanel releases={state.platformAppReleases ?? []} onUpload={uploadMobileAppRelease} /> : null}
          {platformSection === "billing" ? <PlatformBillingPanel billing={platform.billing} onInvoiceStatus={updateManualInvoiceStatus} /> : null}
          {platformSection === "automation" ? <PlatformAutomationPanel rows={state.platformAutomation ?? []} usage={usage} onRunNow={runAutomationNow} onForceSync={forceSyncNow} onToggle={updateTenantAutomation} /> : null}
          {platformSection === "usage" ? <PlatformUsagePanel usage={usage} onForceSync={forceSyncNow} /> : null}
          {platformSection === "system" ? <PlatformSystemPanel user={user} message={message} health={state.platformSystemHealth} audit={state.platformSecurityAudit} operational={state.platformOperationalEvents} backups={state.platformBackupStatus} requestLoad={state.platformRequestLoad} /> : null}
          {platformSection === "settings" ? <PlatformBusinessSettingsPanel settings={state.platformBusinessSettings} pushOverview={state.platformPushOverview} onSave={updatePlatformBusinessSettings} onTestPush={sendPlatformPushTest} /> : null}
        </section>
      </section>
    </main>
  );
}

function PlatformNavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="platform-nav-group">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function PlatformNavButton({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      {React.cloneElement(icon as React.ReactElement, { size: 17 })}
      <span>{label}</span>
    </button>
  );
}

function PlatformMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="platform-metric">
      {React.cloneElement(icon as React.ReactElement, { size: 18 })}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlatformOverviewPanel({ platform, tenants, modules, usage, automationRows }: { platform: any; tenants: any[]; modules: any[]; usage: any; automationRows: any[] }) {
  const billing = platform.billing ?? {};
  const revenue = billing.revenue ?? {};
  const activeAutomation = automationRows.filter((row) => row.phase === "MONITORING").length;
  const activeModules = modules.filter((module) => module.status === "ACTIVE");
  const plans = platform.plans ?? [];
  const recentInvoices = billing.recentInvoices ?? [];
  return (
    <section className="platform-overview platform-wide">
      <div className="overview-card overview-primary">
        <div>
          <span className="eyebrow">Business Health</span>
          <h2>{platform.metrics?.activeTenants ?? 0} active subscribers</h2>
          <p>{tenants.length} total subscribers across {modules.length} strategy modules and {platform.metrics?.plans ?? 0} plans.</p>
        </div>
        <div className="overview-kpis">
          <Metric label="Paid revenue" value={formatCurrency(revenue.paid_revenue)} />
          <Metric label="Outstanding" value={formatCurrency(revenue.outstanding_revenue)} />
          <Metric label="Open invoices" value={revenue.open_invoices ?? 0} />
        </div>
      </div>

      <div className="overview-card">
        <h2><Clock size={18} />Automation Pulse</h2>
        <Metric label="Monitoring now" value={`${activeAutomation}/${automationRows.length}`} />
        <Metric label="Twelve Data today" value={`${usage?.creditsUsedToday ?? 0}/${usage?.dailyLimit ?? 800}`} />
        <Metric label="Guardrail" value={usage?.guardrail?.status ?? "OK"} />
        <Metric label="Worker mode" value={usage?.worker?.mode ?? "--"} />
        <Metric label="Worker health" value={usage?.worker?.health ?? "--"} />
        <Metric label="Heartbeat age" value={usage?.worker?.heartbeatAgeSeconds == null ? "--" : `${usage.worker.heartbeatAgeSeconds}s`} />
        <Metric label="Imported candles" value={usage?.importedCandlesToday ?? 0} />
      </div>

      <div className="overview-card">
        <h2><Layers size={18} />Module Coverage</h2>
        <div className="overview-list">
          {activeModules.slice(0, 4).map((module) => (
            <div key={module.code}>
              <strong>{moduleShortName(module.code, module.name)}</strong>
              <span>{module.assigned_tenants ?? 0} subscribers · {module.target_win_rate ?? "Research pending"}</span>
            </div>
          ))}
          {activeModules.length === 0 ? <p className="reason">No active strategy modules found.</p> : null}
        </div>
      </div>

      <div className="overview-card">
        <h2><KeyRound size={18} />Plan Access</h2>
        <div className="overview-list">
          {plans.slice(0, 4).map((plan: any) => (
            <div key={plan.code}>
              <strong>{plan.name} · {formatCurrency(plan.price_usd)}</strong>
              <span>{(plan.modules ?? []).map((module: any) => module.name).join(", ") || "No modules assigned"}</span>
            </div>
          ))}
          {plans.length === 0 ? <p className="reason">No subscription plans found.</p> : null}
        </div>
      </div>

      <div className="overview-card">
        <h2><CreditCard size={18} />Billing Pulse</h2>
        <div className="overview-list">
          {recentInvoices.slice(0, 3).map((invoice: any) => (
            <div key={invoice.id}>
              <strong>{invoice.subscriber_name ?? invoice.invoice_number}</strong>
              <span>{invoice.status} · {formatCurrency(invoice.amount_due_usd)} · {formatNepalTime(invoice.created_at)}</span>
            </div>
          ))}
          {recentInvoices.length === 0 ? <p className="reason">No invoices recorded yet.</p> : null}
        </div>
      </div>

      <div className="overview-card overview-wide">
        <h2><Layers size={18} />Strategy Modules</h2>
        <div className="overview-list">
          {modules.map((module) => (
            <div key={module.code}>
              <strong>{module.name}</strong>
              <span>{module.description}</span>
              <em>{module.status} · {module.assigned_tenants ?? 0} subscribers · {module.target_win_rate ?? "Research pending"}</em>
            </div>
          ))}
          {modules.length === 0 ? <p className="reason">No strategy modules are configured yet.</p> : null}
        </div>
      </div>

      <div className="overview-card overview-wide">
        <h2><KeyRound size={18} />Subscription Plans</h2>
        <div className="overview-list">
          {plans.map((plan: any) => (
            <div key={plan.code}>
              <strong>{plan.name} · {formatCurrency(plan.price_usd)}/{String(plan.billing_period ?? "MONTHLY").toLowerCase()}</strong>
              <span>{plan.description}</span>
              <em>{(plan.modules ?? []).map((module: any) => module.name).join(", ") || "No modules assigned"}</em>
            </div>
          ))}
          {plans.length === 0 ? <p className="reason">No subscription plans are configured yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

function PlatformBillingPanel({
  billing,
  onInvoiceStatus
}: {
  billing: any;
  onInvoiceStatus: (invoiceId: string, status: "PAID" | "PAST_DUE" | "CANCELED") => Promise<void>;
}) {
  const revenue = billing?.revenue ?? {};
  const statuses = billing?.statusCounts ?? [];
  const plans = billing?.planDistribution ?? [];
  const invoices = billing?.recentInvoices ?? [];
  const pendingRequests = billing?.pendingRequests ?? [];
  const auditTrail = billing?.auditTrail ?? [];
  return (
    <section className="platform-panel platform-wide">
      <h2><CreditCard size={18} />Billing</h2>
      <div className="billing-metrics-grid">
        <Metric label="Paid revenue" value={formatCurrency(revenue.paid_revenue)} />
        <Metric label="Outstanding" value={formatCurrency(revenue.outstanding_revenue)} />
        <Metric label="Paid invoices" value={revenue.paid_invoices ?? 0} />
        <Metric label="Open invoices" value={revenue.open_invoices ?? 0} />
      </div>
      <div className="billing-tags">
        {statuses.map((row: any) => <span key={row.status}>{row.status}: {row.count}</span>)}
        {plans.map((row: any) => <span key={row.code}>{row.name}: {row.subscribers}</span>)}
      </div>
      <div className="billing-section">
        <h3>Pending Manual Requests</h3>
        <div className="admin-list">
          {pendingRequests.map((request: any) => (
            <div className="invoice-admin-row" key={request.id}>
              <div>
                <strong>{request.subscriber_name} · {request.plan_name}</strong>
                <span>{request.mode} · {formatCurrency(request.amount_usd)} · Requested {formatNepalTime(request.created_at)} · Invoice {request.invoice_number ?? "--"}</span>
              </div>
              <div className="invoice-actions">
                <button disabled={!request.invoice_id} onClick={() => onInvoiceStatus(request.invoice_id, "PAID").catch(() => undefined)}>Paid</button>
                <button disabled={!request.invoice_id} onClick={() => onInvoiceStatus(request.invoice_id, "PAST_DUE").catch(() => undefined)}>Past Due</button>
                <button disabled={!request.invoice_id} onClick={() => onInvoiceStatus(request.invoice_id, "CANCELED").catch(() => undefined)}>Cancel</button>
              </div>
            </div>
          ))}
          {pendingRequests.length === 0 ? <p className="reason">No pending manual payment requests.</p> : null}
        </div>
      </div>
      <div className="billing-section">
        <h3>Recent Invoices</h3>
      <div className="admin-list">
        {invoices.slice(0, 4).map((invoice: any) => (
          <div className="invoice-admin-row" key={invoice.id}>
            <div>
              <strong>{invoice.invoice_number}</strong>
              <span>{invoice.subscriber_name} · {invoice.plan_name ?? "--"} · {invoice.status} · {formatCurrency(invoice.amount_due_usd)}</span>
            </div>
            <div className="invoice-actions">
              <button disabled={invoice.status === "PAID"} onClick={() => onInvoiceStatus(invoice.id, "PAID").catch(() => undefined)}>Paid</button>
              <button disabled={invoice.status === "PAST_DUE"} onClick={() => onInvoiceStatus(invoice.id, "PAST_DUE").catch(() => undefined)}>Past Due</button>
              <button disabled={invoice.status === "CANCELED"} onClick={() => onInvoiceStatus(invoice.id, "CANCELED").catch(() => undefined)}>Cancel</button>
            </div>
          </div>
        ))}
        {invoices.length === 0 ? <p className="reason">No invoices yet. Manual payment requests will populate this panel.</p> : null}
      </div>
      </div>
      <div className="billing-section">
        <h3>Billing Audit</h3>
        <div className="admin-list">
          {auditTrail.map((event: any) => (
            <div className="admin-row" key={event.id}>
              <strong>{event.action}</strong>
              <span>{event.display_name ?? event.email ?? "System"} · {event.resource_type} · {formatNepalTime(event.created_at)}</span>
            </div>
          ))}
          {auditTrail.length === 0 ? <p className="reason">No billing audit events yet.</p> : null}
        </div>
      </div>
    </section>
  );
}

function TenantCreatePanel({ plans, modules, onCreate, embedded = false }: { plans: any[]; modules: any[]; embedded?: boolean; onCreate: (input: { name: string; ownerEmail: string; password: string; planCode: string; moduleCodes: string[] }) => Promise<void> }) {
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [planCode, setPlanCode] = useState("starter_orb");
  const [moduleCodes, setModuleCodes] = useState<string[]>(["orb_max_options"]);
  const selectedPlan = plans.find((plan) => plan.code === planCode);
  const allowedModuleCodes = new Set<string>((selectedPlan?.modules ?? []).map((module: any) => module.code));

  useEffect(() => {
    const allowed = moduleCodes.filter((code) => allowedModuleCodes.has(code));
    if (allowed.length !== moduleCodes.length) setModuleCodes(allowed.length > 0 ? allowed : [...allowedModuleCodes].slice(0, 1));
  }, [planCode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await onCreate({ name, ownerEmail, password, planCode, moduleCodes });
    setName("");
    setOwnerEmail("");
    setPassword("");
  }

  return (
    <section className={embedded ? "subscriber-create-inline" : "platform-panel"}>
      <h2><Plus size={18} />Create Subscriber</h2>
      <form className="platform-form" onSubmit={submit}>
        <label>Subscriber name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Trader name" required /></label>
        <label>Subscriber email<input value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} type="email" placeholder="user@example.com" required /></label>
        <label>Login password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" placeholder="Temporary password" required /></label>
        <label>Subscription plan
          <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
          </select>
        </label>
        <ModuleChecklist modules={modules.filter((module) => allowedModuleCodes.has(module.code))} selected={moduleCodes} onChange={setModuleCodes} />
        <button className="wide"><Plus size={16} />Create Subscriber</button>
      </form>
    </section>
  );
}

function ModuleChecklist({ modules, selected, onChange, allowedCodes }: { modules: any[]; selected: string[]; onChange: (next: string[]) => void; allowedCodes?: Set<string> }) {
  return (
    <div className="module-checklist">
      {modules.map((module) => {
        const allowed = !allowedCodes || allowedCodes.has(module.code);
        return (
        <label key={module.code} className={allowed ? "" : "module-locked"}>
          <input
            type="checkbox"
            disabled={!allowed}
            checked={selected.includes(module.code)}
            onChange={(event) => {
              onChange(event.target.checked ? [...selected, module.code] : selected.filter((code) => code !== module.code));
            }}
          />
          <span>{module.name}</span>
          {!allowed ? <em>Plan upgrade required</em> : null}
        </label>
        );
      })}
    </div>
  );
}

function PlatformTicketsPanel({ tickets, onUpdate }: { tickets: any[]; onUpdate: (ticketId: string, status: string, priority?: string) => Promise<void> }) {
  const openTickets = tickets.filter((ticket) => !["RESOLVED", "CLOSED"].includes(ticket.status));
  const resolvedTickets = tickets.filter((ticket) => ["RESOLVED", "CLOSED"].includes(ticket.status));
  return (
    <section className="platform-panel platform-wide">
      <div className="panel-title-row">
        <div>
          <h2><FileText size={18} />Support Tickets</h2>
          <p className="reason">Tenant-created requests from web and mobile. Use this queue for forgot-password, module upgrade, billing, and technical support flow.</p>
        </div>
        <div className="overview-kpis compact">
          <Metric label="Open" value={openTickets.length} />
          <Metric label="Resolved" value={resolvedTickets.length} />
        </div>
      </div>
      <div className="activity-list ticket-queue">
        {tickets.map((ticket) => (
          <div key={ticket.id}>
            <div className="ticket-heading">
              <strong>{ticket.title}</strong>
              <span className={`pill ${ticket.priority === "URGENT" || ticket.priority === "HIGH" ? "bad" : ticket.status === "RESOLVED" ? "good" : "warn"}`}>{ticket.priority} · {ticket.status}</span>
            </div>
            <span>{ticket.tenant_name ?? "Subscriber"} · {ticket.owner_email ?? ticket.created_by_email ?? "--"} · {ticket.ticket_type} · {formatNepalTime(ticket.created_at)}</span>
            <em>{ticket.description ?? ticket.requested_module_name ?? "No notes"}</em>
            {ticket.requested_module_name ? <span>Requested module: {ticket.requested_module_name}</span> : null}
            <div className="ticket-actions">
              {["IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED"].map((status) => (
                <button key={status} disabled={ticket.status === status} onClick={() => onUpdate(ticket.id, status).catch(() => undefined)}>{status.replaceAll("_", " ")}</button>
              ))}
              {ticket.priority !== "HIGH" ? <button onClick={() => onUpdate(ticket.id, ticket.status, "HIGH").catch(() => undefined)}>Mark High</button> : null}
              {ticket.priority !== "NORMAL" ? <button onClick={() => onUpdate(ticket.id, ticket.status, "NORMAL").catch(() => undefined)}>Normal</button> : null}
            </div>
          </div>
        ))}
        {tickets.length === 0 ? <p className="reason">No tenant-created support tickets yet.</p> : null}
      </div>
    </section>
  );
}

function PlatformModulesPanel({ modules }: { modules: any[] }) {
  return (
    <section className="platform-panel">
      <h2><Layers size={18} />Strategy Modules</h2>
      <div className="platform-list">
        {modules.map((module) => (
          <div className="platform-row" key={module.code}>
            <div>
              <strong>{module.name}</strong>
              <span>{module.description}</span>
              <em>{module.target_win_rate ?? "Research pending"} · {module.assigned_tenants ?? 0} subscribers</em>
            </div>
            <span className={`pill ${module.status === "ACTIVE" ? "good" : "warn"}`}>{module.status}</span>
          </div>
        ))}
        {modules.length === 0 ? <p className="reason">No strategy modules are configured yet.</p> : null}
      </div>
    </section>
  );
}

function PlatformPlansPanel({ plans }: { plans: any[] }) {
  return (
    <section className="platform-panel">
      <h2><CreditCard size={18} />Subscription Plans</h2>
      <div className="platform-list">
        {plans.map((plan) => (
          <div className="platform-row" key={plan.code}>
            <div>
              <strong>{plan.name} · ${Number(plan.price_usd ?? 0).toFixed(0)}/{String(plan.billing_period ?? "MONTHLY").toLowerCase()}</strong>
              <span>{plan.description}</span>
              <em>{(plan.modules ?? []).map((module: any) => module.name).join(", ") || "No modules assigned"}</em>
              <em>Provider {plan.provider_code ?? "manual"} · Price ID {plan.provider_price_id ?? "not connected"} · Checkout {plan.checkout_enabled === false ? "Off" : "On"}</em>
              <em>User logins {plan.max_admin_users ?? "Unlimited"} · Notifications {plan.max_notifications_per_month ?? "Unlimited"}/mo · Reports {plan.max_report_history_months ?? "Unlimited"} months · Automation {plan.automation_included === false ? "No" : "Yes"}</em>
            </div>
            <span className="pill good">{plan.status}</span>
          </div>
        ))}
        {plans.length === 0 ? <p className="reason">No subscription plans are configured yet.</p> : null}
      </div>
    </section>
  );
}

function PlatformAppUpdatesPanel({
  releases,
  onUpload
}: {
  releases: any[];
  onUpload: (input: { file: File; changelog: string; versionName?: string; versionCode?: string }) => Promise<any>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [changelog, setChangelog] = useState("");
  const [versionName, setVersionName] = useState("");
  const [versionCode, setVersionCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadedRelease, setUploadedRelease] = useState<any | null>(null);
  const [uploadError, setUploadError] = useState("");
  const detectedVersion = useMemo(() => file ? detectVersionFromFileName(file.name) : "", [file]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      window.alert("Browse and select an APK file first.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".apk")) {
      window.alert("Only Android APK files are supported here.");
      return;
    }
    setUploadError("");
    setBusy(true);
    try {
      const release = await onUpload({
        file,
        changelog,
        versionName: versionName.trim() || detectedVersion || undefined,
        versionCode: versionCode.trim() || undefined
      });
      setUploadedRelease(release);
      setFile(null);
      setChangelog("");
      setVersionName("");
      setVersionCode("");
      const input = document.getElementById("platform-apk-upload") as HTMLInputElement | null;
      if (input) input.value = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "APK upload failed.";
      setUploadError(message);
      window.alert(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="platform-panel platform-wide">
      <div className="panel-title-row">
        <div>
          <h2><Smartphone size={18} />Mobile App Updates</h2>
          <p className="reason">Upload production APK builds for Android users. The app checks this release feed and prompts users to install newer builds.</p>
        </div>
        <div className="overview-kpis compact">
          <Metric label="Latest version" value={releases[0]?.version_name ?? "--"} />
          <Metric label="Releases" value={releases.length} />
        </div>
      </div>

      <form className="platform-form app-update-form" onSubmit={submit}>
        <label>
          APK file
          <input
            id="platform-apk-upload"
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setUploadError("");
            }}
          />
        </label>
        <label>
          Version fallback
          <input placeholder={detectedVersion ? `Detected ${detectedVersion}` : "Optional if APK or filename has version"} value={versionName} onChange={(event) => setVersionName(event.target.value)} />
        </label>
        <label>
          Version code fallback
          <input placeholder="Optional Android versionCode" value={versionCode} onChange={(event) => setVersionCode(event.target.value)} />
        </label>
        <label>
          Change logs
          <textarea rows={5} placeholder="What changed in this APK?" value={changelog} onChange={(event) => setChangelog(event.target.value)} />
        </label>
        <button className="wide" disabled={busy}><UploadCloud size={16} />{busy ? "Uploading APK..." : "Upload APK Release"}</button>
      </form>

      {file ? (
        <div className="platform-row">
          <div>
            <strong>Selected {file.name} · {formatFileSize(file.size)}</strong>
            <span>{file.size > 95 * 1024 * 1024 ? "Cloudflare proxied uploads may block APKs near or above 100 MB." : "Ready to upload."}</span>
          </div>
        </div>
      ) : null}

      {uploadError ? <p className="form-error">{uploadError}</p> : null}

      {uploadedRelease ? (
        <div className="platform-row success-row">
          <div>
            <strong>Uploaded {uploadedRelease.version_name} · {formatFileSize(uploadedRelease.file_size_bytes)}</strong>
            <span>{uploadedRelease.file_name} · versionCode {uploadedRelease.version_code ?? "--"} · {formatNepalTime(uploadedRelease.created_at)}</span>
            <em>{uploadedRelease.changelog || "No changelog provided."}</em>
            <em>SHA256 {String(uploadedRelease.sha256 ?? "").slice(0, 24)}...</em>
          </div>
          <a className="button-link" href={absoluteApiDownloadUrl(uploadedRelease.download_path)} target="_blank" rel="noreferrer"><Download size={15} />Download</a>
        </div>
      ) : null}

      <div className="platform-list">
        {releases.map((release) => (
          <div className="platform-row" key={release.id}>
            <div>
              <strong>{release.version_name} · {formatFileSize(release.file_size_bytes)}</strong>
              <span>{release.file_name} · {formatNepalTime(release.created_at)}</span>
              <em>{release.changelog || "No changelog provided."}</em>
              <em>SHA256 {String(release.sha256 ?? "").slice(0, 16)}...</em>
            </div>
            <a className="button-link" href={absoluteApiDownloadUrl(release.download_path)} target="_blank" rel="noreferrer"><Download size={15} />Download</a>
          </div>
        ))}
        {releases.length === 0 ? <p className="reason">No APK releases uploaded yet.</p> : null}
      </div>
    </section>
  );
}

function PlatformBusinessSettingsPanel({ settings, pushOverview, onSave, onTestPush }: { settings: any; pushOverview: any; onSave: (value: any) => Promise<void>; onTestPush: () => Promise<void> }) {
  const [form, setForm] = useState({
    brandName: settings?.brandName ?? "XAUUSD Signal",
    supportPhone: settings?.supportPhone ?? "",
    supportEmail: settings?.supportEmail ?? "",
    businessAddress: settings?.businessAddress ?? "",
    websiteUrl: settings?.websiteUrl ?? "",
    whatsappUrl: settings?.whatsappUrl ?? "",
    supportHours: settings?.supportHours ?? "",
    helpText: settings?.helpText ?? ""
  });

  useEffect(() => {
    setForm({
      brandName: settings?.brandName ?? "XAUUSD Signal",
      supportPhone: settings?.supportPhone ?? "",
      supportEmail: settings?.supportEmail ?? "",
      businessAddress: settings?.businessAddress ?? "",
      websiteUrl: settings?.websiteUrl ?? "",
      whatsappUrl: settings?.whatsappUrl ?? "",
      supportHours: settings?.supportHours ?? "",
      helpText: settings?.helpText ?? ""
    });
  }, [settings]);

  const update = (key: string, value: string) => setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <section className="platform-panel platform-wide">
      <h2><Settings size={18} />Platform Settings</h2>
      <p className="reason">These contact/help details are shown in the user dashboard and mobile app support screens.</p>
      <div className="billing-metrics-grid">
        <Metric label="Push provider" value={pushOverview?.health?.provider ?? "--"} />
        <Metric label="Firebase" value={pushOverview?.health?.firebase?.status ?? "--"} />
        <Metric label="Active devices" value={pushOverview?.devices?.active_devices ?? 0} />
        <Metric label="FCM devices" value={pushOverview?.devices?.firebase_devices ?? 0} />
        <Metric label="Expo devices" value={pushOverview?.devices?.expo_devices ?? 0} />
        <Metric label="Latest device" value={formatNepalTime(pushOverview?.devices?.latest_seen_at)} />
      </div>
      <div className="billing-tags">
        {(pushOverview?.delivery ?? []).map((row: any) => <span key={row.status}>{row.status}: {row.count}</span>)}
        {pushOverview?.health?.firebase?.error ? <span>Firebase error: {pushOverview.health.firebase.error}</span> : null}
      </div>
      <div className="account-actions">
        <button onClick={() => onTestPush().catch(() => undefined)}><Bell size={16} />Send Platform Push Test</button>
      </div>
      <form className="platform-form" onSubmit={(event) => { event.preventDefault(); onSave(form).catch(() => undefined); }}>
        <label>Brand name<input value={form.brandName} onChange={(event) => update("brandName", event.target.value)} /></label>
        <label>Help line number<input value={form.supportPhone} onChange={(event) => update("supportPhone", event.target.value)} /></label>
        <label>Support email<input value={form.supportEmail} onChange={(event) => update("supportEmail", event.target.value)} /></label>
        <label>Business address<input value={form.businessAddress} onChange={(event) => update("businessAddress", event.target.value)} /></label>
        <label>Website URL<input value={form.websiteUrl} onChange={(event) => update("websiteUrl", event.target.value)} /></label>
        <label>WhatsApp URL<input value={form.whatsappUrl} onChange={(event) => update("whatsappUrl", event.target.value)} /></label>
        <label>Support hours<input value={form.supportHours} onChange={(event) => update("supportHours", event.target.value)} /></label>
        <label>Help text<textarea value={form.helpText} onChange={(event) => update("helpText", event.target.value)} rows={4} /></label>
        <button className="wide"><Settings size={16} />Save Platform Settings</button>
      </form>
      <div className="admin-list">
        {(pushOverview?.latest ?? []).slice(0, 8).map((log: any) => (
          <div className="admin-row" key={log.id}>
            <strong>{log.event_type ?? "Push"} · {log.status}</strong>
            <span>{log.subscriber_name ?? "--"} · {log.preference_key ?? "manual"} · {formatNepalTime(log.created_at)}</span>
            {log.error ? <em>{log.error}</em> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function PlatformAutomationPanel({
  rows,
  usage,
  onRunNow,
  onForceSync,
  onToggle
}: {
  rows: any[];
  usage: any;
  onRunNow: () => Promise<void>;
  onForceSync: () => Promise<void>;
  onToggle: (tenantId: string, enabled: boolean) => Promise<void>;
}) {
  return (
    <section className="platform-panel platform-wide">
      <div className="panel-title-row">
        <h2><LineChart size={18} />Subscriber Automation</h2>
        <div className="row-actions">
          <button onClick={() => onRunNow().catch(() => undefined)}><Clock size={16} />Run Now</button>
          <button onClick={() => onForceSync().catch(() => undefined)}><Database size={16} />Force Sync</button>
        </div>
      </div>
      <div className="usage-strip">
        <Metric label="Credits today" value={`${usage?.creditsUsedToday ?? 0}/${usage?.dailyLimit ?? 800}`} />
        <Metric label="Remaining today" value={usage?.estimatedRemainingToday ?? "--"} />
        <Metric label="Last minute" value={`${usage?.creditsUsedLastMinute ?? 0}/${usage?.minuteLimit ?? 8}`} />
        <Metric label="Guardrail" value={usage?.guardrail?.status ?? "OK"} />
        <Metric label="Market" value={usage?.market?.closed ? "CLOSED" : "OPEN DAY"} />
        <Metric label="Market reason" value={usage?.market?.reason ?? "--"} />
        <Metric label="Calls today" value={usage?.callsToday ?? 0} />
        <Metric label="Candles imported" value={usage?.importedCandlesToday ?? 0} />
        <Metric label="Subscriber evaluations" value={usage?.tenantEvaluationsToday ?? 0} />
      </div>
      <div className="platform-list automation-list">
        {rows.map((row) => (
          <div className="platform-row automation-row" key={row.tenant_id}>
            <div>
              <strong>{row.tenant_name}</strong>
              <span>{row.symbol ?? "XAUUSD"} · {row.timeframe_minutes ?? 15}m · {row.slug}</span>
              <em>{row.latest_reason ?? "Waiting for automation heartbeat."}</em>
            </div>
            <span className={`pill ${row.phase === "MONITORING" ? "good" : row.phase === "API_KEY_MISSING" || row.latest_error ? "bad" : "warn"}`}>{row.phase ?? "STARTING"}</span>
            <div className="automation-metrics">
              <Metric label="Running" value={row.running ? "YES" : "NO"} />
              <Metric label="Enabled" value={row.enabled === false ? "NO" : "YES"} />
              <Metric label="Session" value={row.session_state ?? "--"} />
              <Metric label="Latest candle" value={formatNepalTime(row.latest_candle_at)} />
              <Metric label="API start" value={formatNepalTime(row.api_start_at)} />
              <Metric label="API stop" value={formatNepalTime(row.api_stop_at)} />
              <Metric label="Error" value={row.latest_error ?? "None"} />
            </div>
            <div className="automation-actions">
              {row.enabled === false ? (
                <button onClick={() => onToggle(row.tenant_id, true).catch(() => undefined)}><CheckCircle2 size={16} />Resume</button>
              ) : (
                <button onClick={() => onToggle(row.tenant_id, false).catch(() => undefined)}><XCircle size={16} />Pause</button>
              )}
            </div>
          </div>
        ))}
        {rows.length === 0 ? <p className="reason">Subscriber automation states will appear after the supervisor heartbeat runs.</p> : null}
      </div>
      <div className="usage-events">
        {(usage?.recent ?? []).slice(0, 6).map((event: any) => (
          <span key={`${event.created_at}-${event.symbol}`}>
            {formatNepalTime(event.created_at)} · {event.status} · {event.symbol} {event.timeframe_minutes}m · {event.credits_used} credit
          </span>
        ))}
      </div>
    </section>
  );
}

function PlatformUsagePanel({ usage, onForceSync }: { usage: any; onForceSync: () => Promise<void> }) {
  return (
    <section className="platform-panel platform-wide">
      <div className="panel-title-row">
        <h2><Database size={18} />Twelve Data Usage</h2>
        <button onClick={() => onForceSync().catch(() => undefined)}><Database size={16} />Force Sync</button>
      </div>
      <div className="usage-strip">
        <Metric label="Credits today" value={`${usage?.creditsUsedToday ?? 0}/${usage?.dailyLimit ?? 800}`} />
        <Metric label="Remaining today" value={usage?.estimatedRemainingToday ?? "--"} />
        <Metric label="Last minute" value={`${usage?.creditsUsedLastMinute ?? 0}/${usage?.minuteLimit ?? 8}`} />
        <Metric label="Guardrail" value={usage?.guardrail?.status ?? "OK"} />
        <Metric label="Market" value={usage?.market?.closed ? "CLOSED" : "OPEN DAY"} />
        <Metric label="Market reason" value={usage?.market?.reason ?? "--"} />
        <Metric label="Stop at" value={usage?.guardrail?.stopAt ?? 760} />
        <Metric label="Worker" value={usage?.worker?.mode ?? "--"} />
        <Metric label="Worker health" value={usage?.worker?.health ?? "--"} />
        <Metric label="Heartbeat age" value={usage?.worker?.heartbeatAgeSeconds == null ? "--" : `${usage.worker.heartbeatAgeSeconds}s`} />
        <Metric label="Worker PID" value={usage?.worker?.pid ?? "--"} />
        <Metric label="Calls today" value={usage?.callsToday ?? 0} />
        <Metric label="Candles imported" value={usage?.importedCandlesToday ?? 0} />
        <Metric label="Subscribers evaluated" value={usage?.tenantEvaluationsToday ?? 0} />
      </div>
      <p className="reason">{usage?.guardrail?.message ?? "Twelve Data guardrail is active."}</p>
      <p className="reason">{usage?.market?.message ?? "Market calendar guard is active."}</p>
      <p className="reason">
        Worker heartbeat: {usage?.worker?.heartbeatAt ? formatNepalTime(usage.worker.heartbeatAt) : "not recorded yet"}
        {usage?.worker?.stale ? " · stale" : " · healthy"}.
      </p>
      <div className="platform-list">
        {(usage?.recent ?? []).map((event: any) => (
          <div className="platform-row" key={`${event.created_at}-${event.symbol}-${event.timeframe_minutes}`}>
            <div>
              <strong>{event.provider ?? "TWELVE_DATA"} · {event.symbol} · {event.timeframe_minutes}m</strong>
              <span>{event.status} · requested {event.requested_count ?? 0} · imported {event.imported_count ?? 0} · {event.credits_used ?? 1} credit</span>
              <em>{event.trigger_source ?? "SYSTEM"} · {event.usage_reason ?? "No reason recorded"}{event.forced ? " · forced" : ""}</em>
              <em>{formatNepalTime(event.created_at)} · {event.error ?? "No error"}</em>
            </div>
            <span className={`pill ${event.status === "OK" ? "good" : "bad"}`}>{event.status}</span>
          </div>
        ))}
        {(usage?.recent ?? []).length === 0 ? <p className="reason">No Twelve Data usage events recorded yet.</p> : null}
      </div>
    </section>
  );
}

function PlatformSystemPanel({ user, message, health, audit, operational, backups, requestLoad }: { user: AdminUser; message: string; health?: any; audit?: any; operational?: any; backups?: any; requestLoad?: any }) {
  const services = health?.services ?? [];
  const database = services.find((service: any) => service.name === "PostgreSQL")?.detail ?? {};
  const redis = services.find((service: any) => service.name === "Redis")?.detail ?? {};
  const worker = services.find((service: any) => service.name === "Market-data worker")?.detail ?? {};
  const apiService = services.find((service: any) => service.name === "API")?.detail ?? {};
  const securityEvents = audit?.security ?? [];
  const actionEvents = audit?.actions ?? [];
  const activeSessions = (audit?.sessions ?? []).filter((session: any) => !session.revoked_at);
  const mfa = audit?.mfa ?? {};
  const operationalEvents = operational?.events ?? [];
  return (
    <section className="platform-panel platform-wide">
      <h2><ShieldCheck size={18} />System Health</h2>
      <div className="usage-strip">
        <Metric label="Overall" value={health?.overall ?? "UNKNOWN"} />
        <Metric label="Checked" value={formatNepalTime(health?.checkedAt)} />
        <Metric label="Signed in as" value={user.email} />
        <Metric label="Role" value={user.platformSuperAdmin ? "SUPER USER" : user.role} />
        <Metric label="API uptime" value={apiService.uptimeSeconds == null ? "--" : `${apiService.uptimeSeconds}s`} />
        <Metric label="Worker age" value={worker.heartbeatAgeSeconds == null ? "--" : `${worker.heartbeatAgeSeconds}s`} />
        <Metric label="DB latency" value={database.latencyMs == null ? "--" : `${database.latencyMs}ms`} />
        <Metric label="Pool waiting" value={database.pool?.waiting ?? "--"} />
        <Metric label="Redis" value={redis.status ?? "UNKNOWN"} />
        <Metric label="Backup" value={backups?.status ?? "UNKNOWN"} />
        <Metric label="Slow routes" value={requestLoad?.summary?.slow_requests ?? 0} />
      </div>
      <p className="reason">{message}</p>
      <div className="platform-list">
        {services.map((service: any) => (
          <div className="platform-row" key={service.name}>
            <div>
              <strong>{service.name}</strong>
              <span>{service.message}</span>
              <em>{systemDetailLine(service.detail)}</em>
            </div>
            <span className={`pill ${systemStatusTone(service.status)}`}>{service.status}</span>
          </div>
        ))}
        {services.length === 0 ? (
          <div className="platform-row">
            <div>
              <strong>System health unavailable</strong>
              <span>The API did not return platform health yet. Refresh after the API reloads.</span>
              <em>Endpoint: /api/platform/system-health</em>
            </div>
            <span className="pill warn">UNKNOWN</span>
          </div>
        ) : null}
        <div className="platform-row">
          <div>
            <strong>PostgreSQL Backup Status</strong>
            <span>{backups?.latest ? `Latest backup ${backups.latest.file}` : "No backup dump has been found yet."}</span>
            <em>{backups?.backupDir ?? "backups/postgres"} · {backups?.count ?? 0} file(s) · {formatBytes(backups?.totalSizeBytes ?? 0)} · retention {backups?.retentionDays ?? "--"} day(s)</em>
          </div>
          <span className={`pill ${backups?.status === "HEALTHY" ? "good" : backups?.status === "STALE" ? "warn" : "bad"}`}>{backups?.status ?? "UNKNOWN"}</span>
        </div>
        <div className="platform-row">
          <div>
            <strong>Recovery Commands</strong>
            <span>{backups?.commands?.backup ?? "npm run db:backup"}</span>
            <em>{backups?.commands?.restore ?? "npm run db:restore -- <backup-file.dump>"} · {backups?.commands?.cleanup ?? "npm run db:backup:retention"}</em>
          </div>
          <span className="pill good">RUNBOOK</span>
        </div>
        {(backups?.recent ?? []).slice(0, 5).map((backup: any) => (
          <div className="platform-row" key={backup.file}>
            <div>
              <strong>{backup.file}</strong>
              <span>{formatBytes(backup.sizeBytes)} · {backup.ageHours} hour(s) old</span>
              <em>{backup.path}</em>
            </div>
            <span className="pill good">{formatNepalTime(backup.createdAt)}</span>
          </div>
        ))}
        <div className="platform-row">
          <div>
            <strong>Request Load</strong>
            <span>{requestLoad?.summary?.events ?? 0} API operational event(s) in the last {requestLoad?.windowMinutes ?? 15} minutes.</span>
            <em>Slow {requestLoad?.summary?.slow_requests ?? 0} · failed {requestLoad?.summary?.failed_requests ?? 0} · average {requestLoad?.summary?.avg_duration_ms ?? "--"}ms · max {requestLoad?.summary?.max_duration_ms ?? "--"}ms</em>
          </div>
          <span className={`pill ${Number(requestLoad?.summary?.failed_requests ?? 0) > 0 ? "bad" : Number(requestLoad?.summary?.slow_requests ?? 0) > 0 ? "warn" : "good"}`}>15M</span>
        </div>
        {(requestLoad?.topRoutes ?? []).map((row: any) => (
          <div className="platform-row" key={`${row.method}-${row.route}`}>
            <div>
              <strong>{row.method ?? "--"} {row.route ?? "--"}</strong>
              <span>{row.events} event(s)</span>
              <em>Average {row.avg_duration_ms ?? "--"}ms · max {row.max_duration_ms ?? "--"}ms</em>
            </div>
            <span className="pill warn">ROUTE</span>
          </div>
        ))}
        <div className="platform-row">
          <div>
            <strong>Recovery Guidance</strong>
            <span>{(health?.recovery ?? ["No recovery action needed."]).join(" ")}</span>
            <em>API {health?.endpoints?.api ?? "--"} · Frontend {health?.endpoints?.frontend ?? "--"}</em>
          </div>
          <span className={`pill ${health?.overall === "HEALTHY" ? "good" : health?.overall === "CRITICAL" ? "bad" : "warn"}`}>{health?.overall ?? "UNKNOWN"}</span>
        </div>
        <div className="platform-row">
          <div>
            <strong>Authentication Posture</strong>
            <span>{mfa.platform_super_admins_with_mfa ?? 0}/{mfa.platform_super_admins ?? 0} platform super admin(s) have 2FA enabled.</span>
            <em>{mfa.mfa_enabled ?? 0}/{mfa.total_admins ?? 0} active admin account(s) protected by 2FA.</em>
          </div>
          <span className={`pill ${Number(mfa.platform_super_admins ?? 0) > 0 && Number(mfa.platform_super_admins_with_mfa ?? 0) < Number(mfa.platform_super_admins ?? 0) ? "warn" : "good"}`}>2FA</span>
        </div>
        <div className="platform-row">
          <div>
            <strong>Active Admin Sessions</strong>
            <span>{activeSessions.length} active session(s) across platform and subscriber users.</span>
            <em>Revoked and expired sessions are blocked through PostgreSQL before protected routes run.</em>
          </div>
          <span className="pill good">ENFORCED</span>
        </div>
        {activeSessions.slice(0, 5).map((session: any) => (
          <div className="platform-row" key={session.id}>
            <div>
              <strong>{session.email ?? "Admin session"}</strong>
              <span>{session.ip_address ?? "unknown IP"} · {session.platform_super_admin ? "Platform super admin" : "Subscriber user"}</span>
              <em>Last seen {formatNepalTime(session.last_seen_at)} · expires {formatNepalTime(session.expires_at)}</em>
            </div>
            <span className="pill good">ACTIVE</span>
          </div>
        ))}
        <div className="platform-row">
          <div>
            <strong>Recent Security Events</strong>
            <span>Login success, failed attempts, lockouts, session refreshes, 2FA, and password resets.</span>
            <em>{securityEvents.length} event(s) loaded from the platform security trail.</em>
          </div>
          <span className={`pill ${securityEvents.some((event: any) => String(event.event_type).includes("FAILED") || String(event.event_type).includes("LOCKED") || String(event.event_type).includes("RATE")) ? "warn" : "good"}`}>
            {securityEvents.some((event: any) => String(event.event_type).includes("FAILED") || String(event.event_type).includes("LOCKED") || String(event.event_type).includes("RATE")) ? "REVIEW" : "CLEAR"}
          </span>
        </div>
        {securityEvents.slice(0, 6).map((event: any) => (
          <div className="platform-row" key={event.id}>
            <div>
              <strong>{event.event_type}</strong>
              <span>{event.email ?? event.admin_email ?? "unknown user"} · {event.ip_address ?? "unknown IP"}</span>
              <em>{formatNepalTime(event.created_at)} · {event.user_agent ?? "No user agent"}</em>
            </div>
            <span className={`pill ${String(event.event_type).includes("SUCCESS") || String(event.event_type).includes("REFRESH") ? "good" : "warn"}`}>{String(event.event_type).replace("AUTH_", "")}</span>
          </div>
        ))}
        <div className="platform-row">
          <div>
            <strong>Recent Platform Actions</strong>
            <span>Subscriber, subscription, password, role, and manual billing changes.</span>
            <em>{actionEvents.length} action(s) loaded.</em>
          </div>
          <span className="pill good">AUDITED</span>
        </div>
        {actionEvents.slice(0, 6).map((event: any) => (
          <div className="platform-row" key={event.id}>
            <div>
              <strong>{event.action}</strong>
              <span>{event.email ?? event.display_name ?? "System"} · {event.resource_type}</span>
              <em>{formatNepalTime(event.created_at)} · {event.resource_id ?? "No resource id"}</em>
            </div>
            <span className="pill good">LOGGED</span>
          </div>
        ))}
        <div className="platform-row">
          <div>
            <strong>Operational Events</strong>
            <span>Slow requests, API failures, worker cycles, auth events, and Twelve Data calls.</span>
            <em>Retention {operational?.retentionDays ?? "--"} day(s) · slow request threshold {operational?.slowRequestThresholdMs ?? "--"}ms.</em>
          </div>
          <span className={`pill ${operationalEvents.some((event: any) => ["ERROR", "CRITICAL"].includes(event.severity)) ? "bad" : operationalEvents.some((event: any) => event.severity === "WARN") ? "warn" : "good"}`}>
            {operationalEvents.length}
          </span>
        </div>
        {operationalEvents.slice(0, 10).map((event: any) => (
          <div className="platform-row" key={event.id}>
            <div>
              <strong>{event.category} · {event.event_type}</strong>
              <span>{event.message}</span>
              <em>{event.method ?? "--"} {event.route ?? event.source} · {event.status_code ?? "--"} · {event.duration_ms == null ? "--" : `${event.duration_ms}ms`} · {formatNepalTime(event.created_at)}</em>
            </div>
            <span className={`pill ${event.severity === "ERROR" || event.severity === "CRITICAL" ? "bad" : event.severity === "WARN" ? "warn" : "good"}`}>{event.severity}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function systemStatusTone(status: string) {
  if (status === "HEALTHY") return "good";
  if (status === "CRITICAL" || status === "DOWN") return "bad";
  return "warn";
}

function systemDetailLine(detail: any) {
  if (!detail) return "No detail available.";
  if (detail.pool) return `Pool total ${detail.pool.total ?? "--"}, idle ${detail.pool.idle ?? "--"}, waiting ${detail.pool.waiting ?? "--"}, max ${detail.pool.max ?? "--"}.`;
  if (detail.connectionStatus || detail.memory) return `Connection ${detail.connectionStatus ?? "--"} · latency ${detail.latencyMs ?? "--"}ms · memory ${detail.memory?.used ?? "--"}.`;
  if (detail.heartbeatAt) return `Heartbeat ${formatNepalTime(detail.heartbeatAt)} · PID ${detail.pid ?? "--"}.`;
  if (detail.creditsToday != null) return `Credits ${detail.creditsToday}/${detail.dailyLimit}, minute ${detail.creditsLastMinute}/${detail.minuteLimit}.`;
  if (detail.uptimeSeconds != null) return `PID ${detail.pid ?? "--"} · port ${detail.port ?? "--"}.`;
  return detail.error ?? "No detail available.";
}

function PlatformSubscribersPanel({
  tenants,
  plans,
  modules,
  selectedTenantId,
  showCreate,
  onShowCreate,
  onSelectTenant,
  onCreate,
  onUpdate,
  onUpdateSubscription,
  onUpdateStatus,
  onDelete,
  onResetPassword
}: {
  tenants: any[];
  plans: any[];
  modules: any[];
  selectedTenantId: string | null;
  showCreate: boolean;
  onShowCreate: (show: boolean) => void;
  onSelectTenant: (tenantId: string | null) => void;
  onCreate: (input: { name: string; ownerEmail: string; password: string; planCode: string; moduleCodes: string[] }) => Promise<void>;
  onUpdate: (tenantId: string, planCode: string, moduleCodes: string[]) => Promise<void>;
  onUpdateSubscription: (tenantId: string, status: string, renewsAt: string | null) => Promise<void>;
  onUpdateStatus: (tenantId: string, status: "ACTIVE" | "PAUSED" | "REMOVED") => Promise<void>;
  onDelete: (tenantId: string) => Promise<void>;
  onResetPassword: (tenantId: string, password: string) => Promise<void>;
}) {
  const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId);
  if (selectedTenant) {
    return (
      <SubscriberDetailPanel
        tenant={selectedTenant}
        plans={plans}
        modules={modules}
        onBack={() => onSelectTenant(null)}
        onUpdate={onUpdate}
        onUpdateSubscription={onUpdateSubscription}
        onUpdateStatus={onUpdateStatus}
        onDelete={async (tenantId) => {
          await onDelete(tenantId);
          onSelectTenant(null);
        }}
        onResetPassword={onResetPassword}
      />
    );
  }

  return (
    <section className="platform-panel platform-wide subscribers-panel">
      <div className="panel-title-row">
        <div>
          <h2><Users size={18} />Subscribers</h2>
          <p className="reason">Manage user accounts from the detail page. Add a subscriber only when a new user signs up.</p>
        </div>
        <button onClick={() => onShowCreate(!showCreate)}><Plus size={16} />{showCreate ? "Close" : "Add Subscriber"}</button>
      </div>
      {showCreate ? <TenantCreatePanel embedded plans={plans} modules={modules} onCreate={async (input) => { await onCreate(input); onShowCreate(false); }} /> : null}
      <div className="subscriber-table">
        <div className="subscriber-table-head">
          <span>Subscriber</span>
          <span>Plan</span>
          <span>Modules</span>
          <span>Subscription</span>
          <span>Automation</span>
          <span>Last Login</span>
        </div>
        {tenants.map((tenant) => (
          <button className="subscriber-table-row" key={tenant.id} onClick={() => onSelectTenant(tenant.id)}>
            <span>
              <strong>{tenant.name}</strong>
              <em>{tenant.primary_login_email ?? tenant.owner_email ?? "No email"}</em>
            </span>
            <span>{tenant.plan_name ?? "--"}</span>
            <span>{(tenant.modules ?? []).map((module: any) => module.name).join(", ") || "--"}</span>
            <span><i className={`pill ${["TRIAL", "ACTIVE"].includes(tenant.subscription_status) ? "good" : "bad"}`}>{tenant.subscription_status ?? tenant.status}</i></span>
            <span>{tenant.automation_enabled === false ? "Paused" : tenant.automation_phase ?? "Starting"}</span>
            <span>{formatNepalTime(tenant.primary_login_last_login_at)}</span>
          </button>
        ))}
        {tenants.length === 0 ? <p className="reason">No subscribers yet.</p> : null}
      </div>
    </section>
  );
}

function SubscriberDetailPanel({
  tenant,
  plans,
  modules,
  onBack,
  onUpdate,
  onUpdateSubscription,
  onUpdateStatus,
  onDelete,
  onResetPassword
}: {
  tenant: any;
  plans: any[];
  modules: any[];
  onBack: () => void;
  onUpdate: (tenantId: string, planCode: string, moduleCodes: string[]) => Promise<void>;
  onUpdateSubscription: (tenantId: string, status: string, renewsAt: string | null) => Promise<void>;
  onUpdateStatus: (tenantId: string, status: "ACTIVE" | "PAUSED" | "REMOVED") => Promise<void>;
  onDelete: (tenantId: string) => Promise<void>;
  onResetPassword: (tenantId: string, password: string) => Promise<void>;
}) {
  const [planCode, setPlanCode] = useState(tenant.plan_code ?? "starter_orb");
  const [moduleCodes, setModuleCodes] = useState<string[]>((tenant.modules ?? []).map((module: any) => module.code));
  const [subscriptionStatus, setSubscriptionStatus] = useState(tenant.subscription_status ?? "TRIAL");
  const [renewsAt, setRenewsAt] = useState(dateInputValue(tenant.subscription_renews_at));
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [activity, setActivity] = useState<any>({ audit: [], tickets: [], invoices: [] });
  const selectedPlan = plans.find((plan) => plan.code === planCode);
  const allowedModuleCodes = new Set<string>((selectedPlan?.modules ?? []).map((module: any) => module.code));

  useEffect(() => {
    setPlanCode(tenant.plan_code ?? "starter_orb");
    setModuleCodes((tenant.modules ?? []).map((module: any) => module.code));
    setSubscriptionStatus(tenant.subscription_status ?? "TRIAL");
    setRenewsAt(dateInputValue(tenant.subscription_renews_at));
    setTemporaryPassword("");
    loadSubscriberActivity(tenant.id).then(setActivity).catch(() => setActivity({ audit: [], tickets: [], invoices: [] }));
  }, [tenant.id, tenant.plan_code, tenant.modules, tenant.subscription_status, tenant.subscription_renews_at]);

  async function updateTicket(ticketId: string, status: string) {
    await api<any>(`/api/platform/support-tickets/${ticketId}`, {
      method: "PUT",
      body: JSON.stringify({ status })
    });
    setActivity(await loadSubscriberActivity(tenant.id));
  }

  function pauseSubscriber() {
    if (!window.confirm(`Pause ${tenant.name}? This will disable subscriber login, revoke active sessions, and pause automation without deleting history.`)) return;
    onUpdateStatus(tenant.id, "PAUSED").catch(() => undefined);
  }

  function resumeSubscriber() {
    onUpdateStatus(tenant.id, "ACTIVE").catch(() => undefined);
  }

  function removeSubscriber() {
    if (!window.confirm(`Delete ${tenant.name}? This will permanently remove the subscriber account, login, subscription, module assignments, support tickets, invoices, push devices, and automation state.`)) return;
    if (!window.confirm(`Confirm permanent deletion of ${tenant.name}. This cannot be undone from the dashboard.`)) return;
    onDelete(tenant.id).catch(() => undefined);
  }

  return (
    <section className="platform-panel platform-wide subscriber-detail">
      <div className="panel-title-row">
        <div>
          <button className="back-button" onClick={onBack}>Back to Subscribers</button>
          <h2><Users size={18} />{tenant.name}</h2>
          <p className="reason">{tenant.primary_login_email ?? tenant.owner_email ?? "No email"} · {tenant.slug}</p>
        </div>
        <div className="tenant-lifecycle-actions">
          <span className={`pill ${tenant.status === "ACTIVE" && ["TRIAL", "ACTIVE"].includes(tenant.subscription_status) ? "good" : tenant.status === "PAUSED" ? "warn" : "bad"}`}>{tenant.status ?? "ACTIVE"} · {tenant.subscription_status ?? "--"}</span>
          {tenant.status === "PAUSED" ? <button onClick={resumeSubscriber}>Resume</button> : null}
          {tenant.status === "ACTIVE" ? <button onClick={pauseSubscriber}>Pause</button> : null}
          <button className="danger-button" onClick={removeSubscriber}>Delete</button>
        </div>
      </div>

      <div className="subscriber-profile-grid">
        <Metric label="Account" value={tenant.status ?? "ACTIVE"} />
        <Metric label="Login" value={tenant.primary_login_status ?? "NOT CREATED"} />
        <Metric label="Last login" value={formatNepalTime(tenant.primary_login_last_login_at)} />
        <Metric label="Plan" value={tenant.plan_name ?? "--"} />
        <Metric label="Automation" value={tenant.automation_enabled === false ? "PAUSED" : tenant.automation_phase ?? "STARTING"} />
        <Metric label="User logins" value={`${tenant.active_admin_users ?? 0}/${tenant.max_admin_users ?? "Unlimited"}`} />
        <Metric label="Notifications" value={`${tenant.notifications_used_this_month ?? 0}/${tenant.max_notifications_per_month ?? "Unlimited"}/mo`} />
      </div>

      <div className="subscriber-detail-grid">
        <section className="detail-block">
          <h3>Plan & Modules</h3>
          <label>Subscription plan
            <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
              {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
            </select>
          </label>
          <ModuleChecklist modules={modules} selected={moduleCodes} onChange={setModuleCodes} allowedCodes={allowedModuleCodes} />
          <p className="reason">Modules outside the selected plan are visible here for upgrade review, but cannot be enabled until the subscriber is moved to a plan that includes them.</p>
          <button onClick={() => onUpdate(tenant.id, planCode, moduleCodes).catch(() => undefined)}>Save Module Access</button>
        </section>

        <section className="detail-block">
          <h3>Subscription</h3>
          <label>Plan upgrade
            <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
              {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
            </select>
          </label>
          <p className="reason">Changing the plan updates which modules can be enabled. Professional and Enterprise include Module 2.</p>
          <label>Status
            <select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value)}>
              {["TRIAL", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"].map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
          <label>Renews<input type="date" value={renewsAt} onChange={(event) => setRenewsAt(event.target.value)} /></label>
          <button onClick={() => onUpdateSubscription(tenant.id, subscriptionStatus, renewsAt ? new Date(`${renewsAt}T00:00:00`).toISOString() : null).catch(() => undefined)}>Save Subscription</button>
          <button onClick={() => Promise.all([
            onUpdate(tenant.id, planCode, moduleCodes),
            onUpdateSubscription(tenant.id, subscriptionStatus, renewsAt ? new Date(`${renewsAt}T00:00:00`).toISOString() : null)
          ]).catch(() => undefined)}>Save Plan Upgrade</button>
        </section>

        <section className="detail-block">
          <h3>Password Reset</h3>
          <p className="reason">Use this only after the subscriber has generated a forgot-password support ticket.</p>
          <label>Temporary password<input type="password" value={temporaryPassword} onChange={(event) => setTemporaryPassword(event.target.value)} placeholder="Temporary password" /></label>
          <button disabled={temporaryPassword.trim().length < 4} onClick={() => onResetPassword(tenant.id, temporaryPassword).then(() => setTemporaryPassword("")).catch(() => undefined)}>Reset Password</button>
        </section>
      </div>

      <div className="subscriber-detail-grid two">
        <section className="detail-block">
          <h3>Support Tickets</h3>
          <p className="reason">Tickets are created by subscribers from their dashboard or mobile app. Platform admin can triage, resolve, and use verified forgot-password tickets for password resets.</p>
          <div className="activity-list">
            {(activity.tickets ?? []).map((ticket: any) => (
              <div key={ticket.id}>
                <strong>{ticket.title}</strong>
                <span>{ticket.ticket_type} · {ticket.status} · {ticket.priority} · {formatNepalTime(ticket.created_at)}</span>
                <em>{ticket.description ?? ticket.requested_module_name ?? "No notes"}</em>
                <div className="ticket-actions">
                  {["IN_PROGRESS", "WAITING_USER", "RESOLVED", "CLOSED"].map((status) => (
                    <button key={status} disabled={ticket.status === status} onClick={() => updateTicket(ticket.id, status).catch(() => undefined)}>{status.replaceAll("_", " ")}</button>
                  ))}
                </div>
              </div>
            ))}
            {(activity.tickets ?? []).length === 0 ? <p className="reason">No support tickets yet.</p> : null}
          </div>
        </section>

        <section className="detail-block">
          <h3>Activity Timeline</h3>
          <div className="activity-list">
            {(activity.audit ?? []).map((event: any) => (
              <div key={event.id}>
                <strong>{event.action}</strong>
                <span>{event.display_name ?? event.email ?? "System"} · {formatNepalTime(event.created_at)}</span>
                <em>{event.resource_type}</em>
              </div>
            ))}
            {(activity.invoices ?? []).map((invoice: any) => (
              <div key={invoice.id}>
                <strong>Invoice {invoice.status}</strong>
                <span>{invoice.plan_name ?? "--"} · {formatCurrency(invoice.amount_due_usd)} · {formatNepalTime(invoice.created_at)}</span>
                <em>{invoice.invoice_number}</em>
              </div>
            ))}
            {(activity.audit ?? []).length === 0 && (activity.invoices ?? []).length === 0 ? <p className="reason">No activity recorded yet.</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}

async function loadSubscriberActivity(tenantId: string) {
  return api<any>(`/api/platform/tenants/${tenantId}/activity`);
}

function TenantDirectory({
  tenants,
  plans,
  modules,
  onUpdate,
  onUpdateSubscription
}: {
  tenants: any[];
  plans: any[];
  modules: any[];
  onUpdate: (tenantId: string, planCode: string, moduleCodes: string[]) => Promise<void>;
  onUpdateSubscription: (tenantId: string, status: string, renewsAt: string | null) => Promise<void>;
}) {
  return (
    <section className="platform-panel platform-wide">
      <h2><Users size={18} />Subscriber Directory</h2>
      <div className="tenant-table">
        {tenants.map((tenant) => (
          <TenantRow key={tenant.id} tenant={tenant} plans={plans} modules={modules} onUpdate={onUpdate} onUpdateSubscription={onUpdateSubscription} />
        ))}
        {tenants.length === 0 ? <p className="reason">No subscribers yet. Create the first user account from the form above.</p> : null}
      </div>
    </section>
  );
}

function TenantRow({
  tenant,
  plans,
  modules,
  onUpdate,
  onUpdateSubscription
}: {
  tenant: any;
  plans: any[];
  modules: any[];
  onUpdate: (tenantId: string, planCode: string, moduleCodes: string[]) => Promise<void>;
  onUpdateSubscription: (tenantId: string, status: string, renewsAt: string | null) => Promise<void>;
}) {
  const [planCode, setPlanCode] = useState(tenant.plan_code ?? "starter_orb");
  const [moduleCodes, setModuleCodes] = useState<string[]>((tenant.modules ?? []).map((module: any) => module.code));
  const [subscriptionStatus, setSubscriptionStatus] = useState(tenant.subscription_status ?? "TRIAL");
  const [renewsAt, setRenewsAt] = useState(dateInputValue(tenant.subscription_renews_at));
  const selectedPlan = plans.find((plan) => plan.code === planCode);
  const allowedModuleCodes = new Set<string>((selectedPlan?.modules ?? []).map((module: any) => module.code));
  const allowedModules = modules.filter((module) => allowedModuleCodes.has(module.code));

  useEffect(() => {
    setPlanCode(tenant.plan_code ?? "starter_orb");
    setModuleCodes((tenant.modules ?? []).map((module: any) => module.code));
    setSubscriptionStatus(tenant.subscription_status ?? "TRIAL");
    setRenewsAt(dateInputValue(tenant.subscription_renews_at));
  }, [tenant.id, tenant.plan_code, tenant.modules, tenant.subscription_status, tenant.subscription_renews_at]);

  return (
    <div className="tenant-row">
      <div className="tenant-identity">
        <div className="subscriber-heading">
          <strong>{tenant.name}</strong>
          <span className={`pill ${tenant.status === "ACTIVE" && ["TRIAL", "ACTIVE"].includes(tenant.subscription_status) ? "good" : "bad"}`}>{tenant.subscription_status ?? tenant.status}</span>
        </div>
        <span>{tenant.primary_login_email ?? tenant.owner_email ?? "No subscriber email"} · {tenant.slug}</span>
        <em>{tenant.primary_login_name ?? "Subscriber"} · Login {tenant.primary_login_status ?? "NOT CREATED"} · Last login {formatNepalTime(tenant.primary_login_last_login_at)}</em>
        <div className="subscriber-profile-grid">
          <Metric label="Plan" value={tenant.plan_name ?? "No plan"} />
          <Metric label="User logins" value={`${tenant.active_admin_users ?? 0}/${tenant.max_admin_users ?? "Unlimited"}`} />
          <Metric label="Notifications" value={`${tenant.notifications_used_this_month ?? 0}/${tenant.max_notifications_per_month ?? "Unlimited"}/mo`} />
          <Metric label="Reports" value={tenant.max_report_history_months == null ? "Unlimited" : `${tenant.max_report_history_months} months`} />
          <Metric label="Automation" value={tenant.automation_enabled === false ? "PAUSED" : tenant.automation_phase ?? "STARTING"} />
          <Metric label="Latest candle" value={formatNepalTime(tenant.automation_latest_candle_at)} />
        </div>
        <em>{tenant.automation_reason ?? "Automation will update on the next heartbeat."}</em>
      </div>
      <div className="tenant-access-editor">
        <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
          {plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}
        </select>
        <ModuleChecklist modules={allowedModules} selected={moduleCodes} onChange={setModuleCodes} />
        <button onClick={() => onUpdate(tenant.id, planCode, moduleCodes).catch(() => undefined)}>Save Access</button>
      </div>
      <div className="tenant-billing-editor">
        <label>Status
          <select value={subscriptionStatus} onChange={(event) => setSubscriptionStatus(event.target.value)}>
            {["TRIAL", "ACTIVE", "PAST_DUE", "CANCELED", "EXPIRED"].map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label>Renews<input type="date" value={renewsAt} onChange={(event) => setRenewsAt(event.target.value)} /></label>
        <button onClick={() => onUpdateSubscription(tenant.id, subscriptionStatus, renewsAt ? new Date(`${renewsAt}T00:00:00`).toISOString() : null).catch(() => undefined)}>Save Billing</button>
      </div>
    </div>
  );
}

function AutoEnginePanel({ state, setup, activeVersion, feedHealth, message }: { state: PanelState; setup?: any; activeVersion: any; feedHealth: string; message: string }) {
  return (
    <Panel icon={<Database />} title="Auto Engine">
      <strong className={`bridge-health ${state.feedStatus?.live ? "good" : state.feedStatus?.testMode || state.feedStatus?.latestCandle ? "warn" : "bad"}`}>{feedHealth}</strong>
      <Metric label="Auto mode" value={state.automationStatus?.phase ?? "STARTING"} />
      <Metric label="Strategy" value={activeVersion ? `v${activeVersion.version}` : "Not seeded"} />
      <Metric label="Market feed" value={feedProviderLabel(state.feedStatus?.provider)} />
      <Metric label="Feed status" value={state.feedStatus?.live ? "LIVE" : state.feedStatus?.testMode ? `TEST ${formatAge(state.feedStatus?.testAgeSeconds)}` : state.feedStatus?.latestCandle ? `STALE ${formatAge(state.feedStatus?.ageSeconds)}` : "WAITING"} />
      <Metric label="Scenario" value={setup?.scenario ?? "WAITING"} />
      <Metric label="Favorability" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/100 ${setup.favorability_grade ?? ""}`} />
      <Metric label="News" value={state.newsStatus?.status ?? "CLEAR"} />
      <Metric label="Latest candle" value={formatNepalTime(state.feedStatus?.latestCandle?.timestampUtc)} />
      <p className="reason">{message}</p>
    </Panel>
  );
}

function PaperTradePanel({ trade, tradePlan, setup }: { trade?: any; tradePlan?: any; setup?: any }) {
  const setupTier = setup?.scenario_flags?.setupTier === "MANDATORY" ? "Mandatory setup" : setup?.scenario_flags?.setupTier === "FULL" ? "Full checklist setup" : "--";
  return (
    <Panel icon={<LineChart />} title="Paper Trade">
      <Metric label="Status" value={trade?.id ? trade.outcome ?? "ACTIVE" : "NONE"} />
      <Metric label="Setup tier" value={setupTier} />
      <Metric label="Direction" value={trade?.direction ?? setup?.direction ?? "--"} />
      <Metric label="Entry" value={trade?.actual_entry ?? tradePlan?.planned_entry ?? setup?.entry_price ?? "--"} />
      <Metric label="Stop" value={trade?.actual_stop ?? tradePlan?.planned_stop ?? setup?.stop_price ?? "--"} />
      <Metric label="Target" value={trade?.actual_target ?? tradePlan?.planned_target ?? setup?.target_price ?? "--"} />
      <Metric label="Result R" value={formatR(trade?.result_r)} />
    </Panel>
  );
}

function ScenarioPanel({ setup, scenarioMatrix }: { setup?: any; scenarioMatrix: any }) {
  return (
    <Panel icon={<CheckCircle2 />} title="Scenario">
      <Metric label="Selected" value={formatScenario(setup?.scenario)} />
      <Metric label="Decision" value={setup?.status ?? "WAITING"} />
      <Metric label="Direction" value={setup?.direction ?? "--"} />
      <Metric label="Auto eligible" value={scenarioMatrix.autoEligible == null ? "--" : scenarioMatrix.autoEligible ? "YES" : "NO"} />
      <Metric label="Checklist matched" value={scenarioMatrix.checklistMatched == null ? "--" : scenarioMatrix.checklistMatched ? "YES" : "NO"} />
      <Metric label="Priority" value={scenarioMatrix.priority ?? "--"} />
      <Metric label="Favorability" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/100 ${setup.favorability_grade ?? ""}`} />
      <div className="tag-row">
        {(scenarioMatrix.tags ?? []).length > 0 ? scenarioMatrix.tags.map((tag: string) => <span key={tag}>{tag}</span>) : <span>Waiting for scenario evidence</span>}
      </div>
    </Panel>
  );
}

function LiveSystemStatusPanel({ state, moduleCode, setup, trade, feedHealth }: { state: PanelState; moduleCode: string; setup?: any; trade?: any; feedHealth: string }) {
  const latestCandle = state.feedStatus?.latestCandle?.timestampUtc ?? state.cacheStatus?.latestCandle?.timestampUtc;
  const checks = moduleCode === "high_probability_strategy_2" ? state.module2Readiness?.checks ?? [] : [];
  const module2FeedReady = moduleCode === "high_probability_strategy_2" ? checkStatus(checks, "FIVE_MIN_CANDLES") : null;
  return (
    <Panel icon={<Database />} title="System Status">
      <div className={`live-side-hero ${state.feedStatus?.live ? "good" : state.feedStatus?.latestCandle ? "warn" : "bad"}`}>
        <div>
          <span>Feed</span>
          <strong>{feedHealth}</strong>
        </div>
        <div>
          <span>Paper</span>
          <strong>{trade?.id ? "ACTIVE" : "READY"}</strong>
        </div>
      </div>
      <div className="live-side-metrics">
        <Metric label="Module" value={moduleShortName(moduleCode)} />
        <Metric label="Timing" value={moduleTimingLabel(moduleCode)} />
        <Metric label="Provider" value={feedProviderLabel(state.feedStatus?.provider)} />
        <Metric label="Socket" value={state.feedStatus?.live ? "LIVE" : "WAIT"} />
        <Metric label="NY phase" value={state.automationStatus?.phase ?? state.session?.state ?? "WAITING"} />
        <Metric label="Latest candle" value={formatNepalTime(latestCandle)} />
        {module2FeedReady ? <Metric label="M2 5M candles" value={module2FeedReady} /> : null}
        <Metric label="News" value={state.newsStatus?.status ?? "CLEAR"} />
      </div>
      <p className="reason">{setup?.final_reason ?? "Waiting for the module to produce a valid New York session setup."}</p>
    </Panel>
  );
}

function LiveStrategyCenterPanel({
  moduleCode,
  moduleName,
  setup,
  trade,
  tradePlan,
  evaluations,
  openingRange,
  session
}: {
  moduleCode: string;
  moduleName?: string;
  setup?: any;
  trade?: any;
  tradePlan?: any;
  evaluations: any[];
  openingRange?: any;
  session?: any;
}) {
  const signal = getSignal(setup, trade);
  const rows = moduleCode === "orb_max_options"
    ? maxOrbChecklistRows(evaluations, setup, session)
    : moduleCode === "high_probability_strategy_2"
      ? liquiditySweepChecklistRows(evaluations, setup)
      : moduleCode === "strategy_lab_3"
        ? vwapOpeningDriveChecklistRows(evaluations, setup)
      : genericModuleChecklistRows(evaluations, setup, moduleCode);
  const sections = groupedChecklistSections(moduleCode, rows);
  const entry = trade?.actual_entry ?? tradePlan?.planned_entry ?? setup?.entry_price;
  const stop = trade?.actual_stop ?? tradePlan?.planned_stop ?? setup?.stop_price;
  const target = trade?.actual_target ?? tradePlan?.planned_target ?? setup?.target_price;
  return (
    <Panel icon={<ShieldCheck />} title="Strategy Center">
      <div className={`live-signal-summary ${signal.tone}`}>
        <div>
          <span>{moduleShortName(moduleCode, moduleName)}</span>
          <strong>{signal.label}</strong>
        </div>
        <em>{setup?.scenario ? formatScenario(setup.scenario) : "Waiting for valid setup"}</em>
      </div>
      <div className="live-trade-plan">
        <Metric label="Direction" value={trade?.direction ?? setup?.direction ?? "--"} />
        <Metric label="Entry" value={formatPriceValue(entry)} />
        <Metric label="Stop" value={formatPriceValue(stop)} />
        <Metric label="Target" value={formatPriceValue(target)} />
      </div>
      <LiveModuleEvidence moduleCode={moduleCode} setup={setup} openingRange={openingRange} />
      <div className="live-check-summary">
        {sections.map((section) => (
          <div key={section.title}>
            <span>{section.title}</span>
            <strong>{section.rows.filter((item: any) => item.status === "PASS").length}/{section.rows.length}</strong>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function LiveModuleEvidence({ moduleCode, setup, openingRange }: { moduleCode: string; setup?: any; openingRange?: any }) {
  const flags = setup?.scenario_flags ?? {};
  if (moduleCode === "orb_max_options") {
    return (
      <div className="live-evidence-list">
        <div><span>ORB High</span><strong>{formatPriceValue(openingRange?.high)}</strong></div>
        <div><span>ORB Mid</span><strong>{formatPriceValue(openingRange?.midpoint)}</strong></div>
        <div><span>ORB Low</span><strong>{formatPriceValue(openingRange?.low)}</strong></div>
      </div>
    );
  }
  if (moduleCode === "high_probability_strategy_2") {
    const sweep = flags.sweep ?? {};
    const displacement = flags.displacement ?? {};
    const bos = flags.bos ?? {};
    const zone = flags.entryZone ?? {};
    return (
      <div className="live-evidence-list">
        <div><span>Liquidity</span><strong>{sweep?.level?.price == null ? "--" : `${formatScenario(sweep.level.type)} ${Number(sweep.level.price).toFixed(2)}`}</strong></div>
        <div><span>Sweep</span><strong>{formatNepalTime(sweep?.closedBackAt ?? sweep?.sweptAt)}</strong></div>
        <div><span>Displacement</span><strong>{displacement?.rangeAtr == null ? "--" : `${Number(displacement.rangeAtr).toFixed(2)} ATR`}</strong></div>
        <div><span>BOS / CHoCH</span><strong>{bos?.level == null ? "--" : Number(bos.level).toFixed(2)}</strong></div>
        <div><span>Entry zone</span><strong>{zone?.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`}</strong></div>
      </div>
    );
  }
  if (moduleCode === "strategy_lab_3") {
    const drive = flags.drive ?? {};
    const zone = flags.entryZone ?? {};
    return (
      <div className="live-evidence-list">
        <div><span>Opening drive</span><strong>{drive?.rangeAtr == null ? "--" : `${Number(drive.rangeAtr).toFixed(2)} ATR`}</strong></div>
        <div><span>VWAP</span><strong>{flags.vwapAlignment ?? flags.vwapBias ?? "--"}</strong></div>
        <div><span>Pullback zone</span><strong>{zone?.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`}</strong></div>
        <div><span>Confirmation</span><strong>{flags.confirmationCandle?.timestampUtc ? formatNepalTime(flags.confirmationCandle.timestampUtc) : "--"}</strong></div>
      </div>
    );
  }
  return null;
}

function Module2LiveControlPanel({ state, setup, trade, tradePlan, feedHealth }: { state: PanelState; setup?: any; trade?: any; tradePlan?: any; feedHealth: string }) {
  const cockpit = module2CockpitState(state, setup, trade);
  const signal = getSignal(setup, trade);
  const rows = liquiditySweepChecklistRows(setup?.evaluations ?? [], setup);
  const mandatory = rows.filter((row: any) => ["MODULE2_STATE", "NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_ENTRY_CANDLE"].includes(row.rule_code ?? row.ruleCode));
  const confirmations = rows.filter((row: any) => module2RuleLayer(row.rule_code ?? row.ruleCode) === "confirmation");
  const quality = rows.filter((row: any) => module2RuleLayer(row.rule_code ?? row.ruleCode) === "quality");
  const passed = (items: any[]) => items.filter((row: any) => row.status === "PASS").length;
  const entry = trade?.actual_entry ?? tradePlan?.planned_entry ?? setup?.entry_price;
  const stop = trade?.actual_stop ?? tradePlan?.planned_stop ?? setup?.stop_price;
  const target = trade?.actual_target ?? tradePlan?.planned_target ?? setup?.target_price;
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Live Control">
      <div className={`module2-live-hero ${signal.tone}`}>
        <div>
          <span>Signal</span>
          <strong>{signal.label}</strong>
        </div>
        <div>
          <span>Trust</span>
          <strong>{cockpit.trustScore}/100</strong>
        </div>
      </div>
      <div className="module2-live-metrics">
        <Metric label="Feed" value={feedHealth} />
        <Metric label="NY phase" value={cockpit.phase} />
        <Metric label="Mandatory" value={`${passed(mandatory)}/${mandatory.length}`} />
        <Metric label="Confirmations" value={`${passed(confirmations)}/${confirmations.length}`} />
        <Metric label="Quality" value={`${passed(quality)}/${quality.length}`} />
        <Metric label="Paper" value={trade?.id ? `${trade.direction ?? "--"} ${trade.outcome ?? "ACTIVE"}` : "READY"} />
      </div>
      <div className="module2-trade-plan">
        <span>{setup?.scenario ? formatScenario(setup.scenario) : "Waiting for sweep + BOS setup"}</span>
        <strong>{setup?.direction ?? trade?.direction ?? "--"}</strong>
        <em>Entry {formatPriceValue(entry)} · SL {formatPriceValue(stop)} · TP {formatPriceValue(target)}</em>
      </div>
      <p className="reason">{setup?.final_reason ?? signal.reason}</p>
    </Panel>
  );
}

function Module2LiveEvidencePanel({ setup }: { setup?: any }) {
  const flags = setup?.scenario_flags ?? {};
  const sweep = flags.sweep ?? {};
  const displacement = flags.displacement ?? {};
  const bos = flags.bos ?? {};
  const zone = flags.entryZone ?? {};
  const confirmationLayer = flags.confirmationLayer ?? {};
  const qualityLayer = flags.qualityLayer ?? {};
  const steps = [
    {
      label: "Liquidity",
      status: sweep?.level?.price != null ? "PASS" : "WAIT",
      value: sweep?.level?.price == null ? "--" : `${formatScenario(sweep.level.type)} ${Number(sweep.level.price).toFixed(2)}`
    },
    {
      label: "Sweep",
      status: sweep?.closedBackAt || sweep?.sweptAt ? "PASS" : "WAIT",
      value: formatNepalTime(sweep?.closedBackAt ?? sweep?.sweptAt ?? sweep?.candle?.timestampUtc)
    },
    {
      label: "Displacement",
      status: displacement?.candle ? "PASS" : "WAIT",
      value: displacement?.rangeAtr == null ? "--" : `${Number(displacement.rangeAtr).toFixed(2)} ATR`
    },
    {
      label: "BOS / CHoCH",
      status: bos?.candle ? "PASS" : "WAIT",
      value: bos?.level == null ? "--" : Number(bos.level).toFixed(2)
    },
    {
      label: "Entry Zone",
      status: zone?.low != null && zone?.high != null ? "PASS" : "WAIT",
      value: zone?.low == null ? "--" : `${zone.kind ?? "Zone"} ${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`
    }
  ];
  return (
    <Panel icon={<Database />} title="Module 2 Setup Evidence">
      <div className="module2-sequence">
        {steps.map((step) => (
          <div className={`module2-step ${step.status === "PASS" ? "good" : "warn"}`} key={step.label}>
            <span>{step.label}</span>
            <strong>{step.value}</strong>
          </div>
        ))}
      </div>
      <div className="module2-live-metrics">
        <Metric label="Confirm layer" value={confirmationLayer?.count == null ? "--" : `${confirmationLayer.count}/${confirmationLayer.required ?? 5}`} />
        <Metric label="Quality layer" value={qualityLayer?.count == null ? "--" : `${qualityLayer.count}/${qualityLayer.required ?? 3}`} />
        <Metric label="Setup tier" value={flags.setupTier ?? "--"} />
        <Metric label="Score" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/100`} />
      </div>
    </Panel>
  );
}

function ModulePerformancePanel({ state, moduleCode, moduleName }: { state: PanelState; moduleCode: string; moduleName?: string }) {
  const shortName = moduleShortName(moduleCode, moduleName);
  return (
    <Panel icon={<Database />} title={`${shortName} Performance`}>
      <Metric label="Generated BUY/SELL" value={state.orbAdmin?.generatedSignals ?? 0} />
      <Metric label="Paper trades" value={state.orbAdmin?.trades ?? 0} />
      <Metric label="Wins" value={state.orbAdmin?.wins ?? 0} />
      <Metric label="Losses" value={state.orbAdmin?.losses ?? 0} />
      <Metric label="Active" value={state.orbAdmin?.active ?? 0} />
      <Metric label="Average win rate" value={formatPercent(state.orbAdmin?.winRate)} />
      <Metric label="Average R" value={formatR(state.orbAdmin?.averageR)} />
      <Metric label="Total R" value={formatR(state.orbAdmin?.totalR)} />
      <div className="admin-list">
        {(state.orbAdmin?.signals ?? []).slice(0, 8).map((signal: any) => (
          <div className="admin-row" key={signal.id}>
            <strong>{signal.direction} · {formatScenario(signal.scenario)}</strong>
            <span>{formatNepalTime(signal.detected_at)} · {signal.outcome ?? signal.status} · {formatR(signal.result_r)}R · {signal.snapshot_candles ?? 0} evidence candles</span>
          </div>
        ))}
        {(state.orbAdmin?.signals ?? []).length === 0 ? <p className="reason">No real automatic {shortName} BUY/SELL records yet. Replay and QA signals are excluded.</p> : null}
      </div>
    </Panel>
  );
}

function CrossModuleCommandCenter({
  state,
  modules,
  activeModuleCode,
  onOpenModule,
  onRunRehearsal
}: {
  state: PanelState;
  modules: any[];
  activeModuleCode: string;
  onOpenModule: (moduleCode: string) => void;
  onRunRehearsal: (moduleCode: string) => Promise<void>;
}) {
  const rows = modules.map((module: any) => commandModuleRow(state, module));
  const readyCount = rows.filter((row) => row.readiness === "READY").length;
  const activeTrades = rows.filter((row) => row.trade?.outcome === "ACTIVE").length;
  const buySellSignals = rows.filter((row) => ["BUY", "SELL"].includes(row.signalLabel)).length;
  const blockedRows = rows.filter((row) => row.readiness === "BLOCKED").length;
  return (
    <>
      <Panel icon={<ShieldCheck />} title="Strategy Command Center">
        <div className="strategy-validation-hero">
          <div>
            <span>System posture</span>
            <strong className={blockedRows > 0 ? "bad-text" : readyCount === rows.length && rows.length > 0 ? "good-text" : "warn-text"}>{blockedRows > 0 ? `${blockedRows} BLOCKED` : `${readyCount}/${rows.length} READY`}</strong>
          </div>
          <em>{activeTrades} active paper trade{activeTrades === 1 ? "" : "s"}</em>
        </div>
        <div className="metrics-grid compact">
          <Metric label="Shared symbol" value="XAUUSD" />
          <Metric label="Feed" value={state.feedStatus?.live ? "LIVE" : state.feedStatus?.latestCandle ? "STALE" : "WAITING"} />
          <Metric label="Provider" value={feedProviderLabel(state.feedStatus?.provider)} />
          <Metric label="Enabled modules" value={rows.length} />
          <Metric label="Buy/Sell signals" value={buySellSignals} />
          <Metric label="Twelve usage" value={`${state.productionReadiness?.data?.twelveData?.usedToday ?? 0}/800`} />
        </div>
        <p className="reason">Command Center is the tenant control room. Candles are shared from Twelve Data, but each module keeps isolated setup logic, paper trades, journal, reports, and checklist evidence.</p>
      </Panel>

      <Panel icon={<Layers />} title="Strategy Center">
        <div className="command-module-grid">
          {rows.map((row) => (
            <article className={`command-module-card ${row.moduleCode === activeModuleCode ? "active" : ""}`} key={row.moduleCode}>
              <header>
                <div>
                  <span>{row.timeframe}</span>
                  <strong>{row.name}</strong>
                </div>
                <em className={`status-pill ${row.readinessTone}`}>{row.readiness}</em>
              </header>
              <div className="command-signal-row">
                <div>
                  <span>Signal</span>
                  <strong className={row.signalTone === "good" ? "good-text" : row.signalTone === "bad" ? "bad-text" : "warn-text"}>{row.signalLabel}</strong>
                </div>
                <div>
                  <span>Paper trade</span>
                  <strong>{row.tradeLabel}</strong>
                </div>
              </div>
              <div className="command-metrics">
                <Metric label="Confidence" value={row.confidenceLabel} />
                <Metric label="Samples" value={row.sampleSize} />
                <Metric label="Rehearsal" value={row.rehearsalStatus} />
                <Metric label="Audit" value={row.auditStatus} />
              </div>
              <div className="command-setup-plan">
                <span>{row.setup?.scenario ? formatScenario(row.setup.scenario) : "Waiting for setup"}</span>
                <strong>{row.setup?.direction ?? row.trade?.direction ?? "--"}</strong>
                <em>{row.nextAction}</em>
              </div>
              <div className="admin-actions inline-actions">
                <button onClick={() => onOpenModule(row.moduleCode)}>Open Chart</button>
                <button onClick={() => onRunRehearsal(row.moduleCode).catch(() => undefined)}>Run Rehearsal</button>
              </div>
            </article>
          ))}
          {rows.length === 0 ? <p className="reason">No enabled strategy modules.</p> : null}
        </div>
      </Panel>

      <Panel icon={<FileText />} title="Action Queue">
        <div className="admin-list">
          {rows
            .slice()
            .sort((left, right) => commandPriority(right) - commandPriority(left))
            .map((row) => (
              <div className="admin-row" key={row.moduleCode}>
                <strong>{row.name}</strong>
                <span>{row.nextAction} · {row.readiness} · {row.signalLabel}</span>
              </div>
            ))}
        </div>
      </Panel>
    </>
  );
}

function ProductionHealthDashboard({
  state,
  modules,
  activeModuleCode,
  onRefresh,
  onRecoverStale,
  onOpenData,
  onOpenChart
}: {
  state: PanelState;
  modules: any[];
  activeModuleCode: string;
  onRefresh: () => void;
  onRecoverStale: () => void;
  onOpenData: () => void;
  onOpenChart: (moduleCode: string) => void;
}) {
  const rows = modules.map((module: any) => productionModuleRow(state, module));
  const diagnostics = productionDiagnostics(state);
  const readinessChecks = state.productionReadiness?.checks ?? [];
  const blocked = diagnostics.filter((item) => item.tone === "bad").length;
  const warnings = diagnostics.filter((item) => item.tone === "warn").length;
  const rawOverall = state.productionReadiness?.status ?? (blocked > 0 ? "BLOCKED" : warnings > 0 ? "CAUTION" : "READY");
  const overall = rawOverall === "BLOCKED" ? "NEEDS ATTENTION" : rawOverall;
  const chartReason = liveChartDiagnostic(state);
  const latestCandle = state.cacheStatus?.latestCandle ?? state.feedStatus?.latestCandle;
  return (
    <>
      <Panel icon={<ShieldCheck />} title="Production Health">
        <div className="strategy-validation-hero">
          <div>
            <span>System status</span>
            <strong className={rawOverall === "READY" ? "good-text" : rawOverall === "CAUTION" ? "warn-text" : "bad-text"}>{overall}</strong>
          </div>
          <em>{warnings} warning{warnings === 1 ? "" : "s"} · {blocked} blocker{blocked === 1 ? "" : "s"}</em>
        </div>
        <div className="metrics-grid compact">
          <Metric label="Feed provider" value={feedProviderLabel(state.feedStatus?.provider)} />
          <Metric label="Twelve Data" value={state.twelveStatus?.configured === false ? "API KEY MISSING" : state.twelveStatus?.running ? "RUNNING" : "STOPPED"} />
          <Metric label="PostgreSQL" value={postgresHealthLabel(state)} />
          <Metric label="Candle store" value={`${state.cacheStatus?.cachedCandles ?? state.twelveStatus?.cachedCandles ?? 0}/${state.cacheStatus?.cacheLimit ?? "--"}`} />
          <Metric label="Latest candle" value={formatNepalTime(latestCandle?.timestampUtc)} />
          <Metric label="Scheduler" value={state.automationStatus?.phase ?? state.session?.state ?? "WAITING"} />
          <Metric label="Twelve usage" value={`${state.productionReadiness?.data?.twelveData?.usedToday ?? state.platformUsage?.creditsUsedToday ?? 0}/800`} />
        </div>
        <div className="admin-actions">
          <button onClick={onRefresh}><LineChart size={16} />Refresh Health</button>
          <button onClick={onRecoverStale}><CheckCircle2 size={16} />Recover Stale Paper</button>
          <button onClick={onOpenData}><Database size={16} />Open Data Admin</button>
        </div>
        <p className="reason">{chartReason.message}</p>
      </Panel>

      <Panel icon={<Database />} title="Feed, Cache, Scheduler">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Status</th>
                <th>Evidence</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.map((item) => (
                <tr key={item.name}>
                  <td>{item.name}</td>
                  <td><span className={`status-pill ${item.tone}`}>{item.status}</span></td>
                  <td>{item.evidence}</td>
                  <td>{item.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel icon={<ShieldCheck />} title="Launch Readiness Audit">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Launch Gate</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {readinessChecks.map((check: any) => (
                <tr key={check.code}>
                  <td>{check.label}</td>
                  <td><span className={`status-pill ${check.status === "PASS" ? "good" : "bad"}`}>{check.status}</span></td>
                  <td>{check.evidence}</td>
                </tr>
              ))}
              {readinessChecks.length === 0 ? <tr><td colSpan={3}>Production readiness audit is waiting for the API response.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <p className="reason">This audit is calculated in the API from PostgreSQL, paper trades, module/session isolation, notifications, and Twelve Data usage records.</p>
      </Panel>

      <Panel icon={<Layers />} title="Module Automation Health">
        <div className="table-wrap">
          <table className="data-table command-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Timeframe</th>
                <th>Signal</th>
                <th>Readiness</th>
                <th>Rehearsal</th>
                <th>Paper Trade</th>
                <th>Next Action</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.moduleCode} className={row.moduleCode === activeModuleCode ? "selected-row" : ""}>
                  <td>
                    <strong>{row.name}</strong>
                    <span>{row.enabled ? "Enabled" : "Locked"}</span>
                  </td>
                  <td>{row.timeframe}</td>
                  <td><span className={`status-pill ${row.signalTone}`}>{row.signalLabel}</span></td>
                  <td><span className={`status-pill ${row.readinessTone}`}>{row.readiness}</span></td>
                  <td>{row.rehearsal}</td>
                  <td>{row.tradeLabel}</td>
                  <td>{row.nextAction}</td>
                  <td><button onClick={() => onOpenChart(row.moduleCode)}>Chart</button></td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={8}>No enabled modules on this user account.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel icon={<LineChart />} title="Chart Readiness">
        <strong className={`bridge-health ${chartReason.tone}`}>{chartReason.status}</strong>
        <Metric label="Chart candle source" value="Shared XAUUSD Twelve Data cache" />
        <Metric label="Active chart module" value={moduleShortName(activeModuleCode)} />
        <Metric label="Chart feed" value={`${moduleTimeframe(activeModuleCode, DEFAULT_TIMEFRAME_MINUTES)}M shared XAUUSD`} />
        <Metric label="Strategy timing" value={moduleTimingLabel(activeModuleCode)} />
        <Metric label="Latest cached NPT" value={formatNepalTime(state.cacheStatus?.latestCandle?.timestampUtc)} />
        <Metric label="Latest feed NPT" value={formatNepalTime(state.feedStatus?.latestCandle?.timestampUtc)} />
        <Metric label="Last Twelve error" value={state.twelveStatus?.lastError ?? "--"} />
        <p className="reason">{chartReason.detail}</p>
      </Panel>
    </>
  );
}

function commandModuleRow(state: PanelState, module: any) {
  const moduleCode = module.code;
  const snapshot = (state.moduleCommand ?? []).find((item: any) => item.moduleCode === moduleCode) ?? {};
  const readinessModule = (state.productionReadiness?.modules ?? []).find((row: any) => row.moduleCode === moduleCode) ?? {};
  const setup = snapshot.setup ?? readinessModule.latestSetup;
  const trade = snapshot.trade ?? readinessModule.latestTrade;
  const confidence = (state.strategyConfidence?.modules ?? []).find((row: any) => row.moduleCode === moduleCode);
  const rehearsals = moduleCode === "orb_max_options" ? state.orbRehearsals : moduleCode === "high_probability_strategy_2" ? state.module2Rehearsals : state.module3Rehearsals;
  const latestRehearsal = rehearsals?.[0];
  const rehearsalStatus = readinessModule.rehearsal?.final_status ?? latestRehearsal?.finalStatus ?? latestRehearsal?.final_status ?? "WAIT";
  const auditStatus = readinessModule.audit?.status ?? confidence?.audit?.summary?.status ?? latestRehearsal?.audit?.status ?? latestRehearsal?.audit_json?.status ?? "WAIT";
  const signal = getSignal(setup, trade);
  const confidenceLabel = confidence?.confidence?.label ?? "Do not trust yet";
  const sampleSize = confidence?.confidence?.sampleSize ?? 0;
  const readiness = readinessModule.status ?? moduleReadinessLabel(state, moduleCode).label;
  const readinessTone = readiness === "READY" ? "good" : readiness === "BLOCKED" ? "bad" : "warn";
  const tradeLabel = trade ? `${trade.direction ?? "--"} · ${trade.outcome ?? "ACTIVE"}` : "NONE";
  const nextAction = readinessModule.nextAction ?? commandNextAction({ setup, trade, rehearsalStatus, auditStatus, confidence });
  return {
    moduleCode,
    name: moduleShortName(moduleCode, module.name),
    enabled: module.tenant_module_status === "ENABLED",
    timeframe: moduleTimingLabel(moduleCode),
    setup,
    trade,
    signalLabel: signal.label,
    signalTone: signal.tone,
    confidenceLabel,
    sampleSize,
    rehearsalStatus,
    auditStatus,
    readiness,
    readinessTone,
    tradeLabel,
    nextAction
  };
}

function commandPriority(row: any) {
  if (row.trade?.outcome === "ACTIVE") return 50;
  if (row.signalLabel === "BUY" || row.signalLabel === "SELL") return 45;
  if (row.readiness === "BLOCKED") return 40;
  if (row.rehearsalStatus !== "GO") return 30;
  if (row.auditStatus !== "PASS") return 20;
  return 10;
}

function productionModuleRow(state: PanelState, module: any) {
  const command = commandModuleRow(state, module);
  const readinessModule = (state.productionReadiness?.modules ?? []).find((row: any) => row.moduleCode === module.code);
  const readiness = moduleReadinessLabel(state, module.code);
  const latestTrade = readinessModule?.latestTrade ?? command.trade;
  const tradeLabel = latestTrade ? `${latestTrade.direction ?? "--"} · ${latestTrade.outcome ?? "ACTIVE"}` : "NONE";
  return {
    ...command,
    readiness: readinessModule?.status ?? readiness.label,
    readinessTone: readinessModule?.status === "READY" ? "good" : readinessModule?.status === "BLOCKED" ? "bad" : readiness.tone,
    rehearsal: readinessModule?.rehearsal?.final_status ?? command.rehearsalStatus,
    tradeLabel
  };
}

function productionDiagnostics(state: PanelState) {
  const latestCandle = state.cacheStatus?.latestCandle ?? state.feedStatus?.latestCandle;
  const cacheCount = Number(state.cacheStatus?.cachedCandles ?? state.twelveStatus?.cachedCandles ?? 0);
  const twelveConfigured = state.twelveStatus?.configured !== false;
  const feedLive = Boolean(state.feedStatus?.live);
  const feedHasCandle = Boolean(latestCandle);
  const postgresReady = postgresHealthLabel(state) === "CONNECTED";
  const apiStopAt = state.automationStatus?.apiStopAt;
  const apiStartAt = state.automationStatus?.apiStartAt ?? state.automationStatus?.sessionStartAt;
  return [
    {
      name: "Twelve Data key",
      status: twelveConfigured ? "PASS" : "FAIL",
      tone: twelveConfigured ? "good" : "bad",
      evidence: twelveConfigured ? "Provider credentials are configured." : "TWELVE_DATA_API_KEY is missing or unreadable by the API.",
      action: twelveConfigured ? "None" : "Add the key to .env and restart API."
    },
    {
      name: "Market feed",
      status: feedLive ? "LIVE" : feedHasCandle ? "STALE" : "WAITING",
      tone: feedLive ? "good" : feedHasCandle ? "warn" : "bad",
      evidence: feedHasCandle ? `Latest candle ${formatNepalTime(latestCandle?.timestampUtc)}.` : "No XAUUSD candle has reached the dashboard yet.",
      action: feedLive ? "None" : "Confirm NY schedule or run the scheduled backfill."
    },
    {
      name: "PostgreSQL/cache path",
      status: postgresReady ? "PASS" : "WAIT",
      tone: postgresReady ? "good" : "warn",
      evidence: postgresReady ? `${cacheCount} cached candle(s) visible to the API.` : "Dashboard has not received database-backed state yet.",
      action: postgresReady ? "None" : "Check API and PostgreSQL containers."
    },
    {
      name: "Candle cache",
      status: cacheCount > 0 ? "READY" : "EMPTY",
      tone: cacheCount > 0 ? "good" : "warn",
      evidence: `${cacheCount}/${state.cacheStatus?.cacheLimit ?? "--"} candles retained for the active chart timeframe.`,
      action: cacheCount > 0 ? "None" : "Wait for NY polling or use module backfill."
    },
    {
      name: "NY scheduler",
      status: state.automationStatus?.phase ?? state.session?.state ?? "WAITING",
      tone: state.feedStatus?.live ? "good" : "warn",
      evidence: `Starts ${formatNepalTime(apiStartAt)} · Stops ${formatNepalTime(apiStopAt)}.`,
      action: "Polling is intentionally limited to the NY window to preserve Twelve Data credits."
    },
    {
      name: "News guard",
      status: state.newsStatus?.status ?? "UNKNOWN",
      tone: state.newsStatus?.status === "BLOCKED" ? "bad" : "good",
      evidence: state.newsStatus?.reason ?? "No high-impact block reported.",
      action: state.newsStatus?.status === "BLOCKED" ? "Wait until news guard clears." : "None"
    }
  ];
}

function postgresHealthLabel(state: PanelState) {
  if (state.cacheStatus || state.session || state.tenantContext || state.analytics) return "CONNECTED";
  return "UNKNOWN";
}

function liveChartDiagnostic(state: PanelState) {
  const latestCandle = state.cacheStatus?.latestCandle ?? state.feedStatus?.latestCandle;
  if (state.twelveStatus?.configured === false) {
    return {
      status: "BLOCKED",
      tone: "bad",
      message: "Live chart is blocked because Twelve Data is not configured.",
      detail: "Set TWELVE_DATA_API_KEY in the API environment, restart the API, then refresh the dashboard."
    };
  }
  if (!latestCandle) {
    return {
      status: "NO CANDLES",
      tone: "bad",
      message: "The chart has no candle data yet.",
      detail: "Because API credits are protected, polling only runs in the scheduled NY window. Run a module backfill from Data Admin if you need chart history outside the window."
    };
  }
  if (state.feedStatus?.live) {
    return {
      status: "LIVE",
      tone: "good",
      message: "The chart should be updating from the shared XAUUSD Twelve Data feed.",
      detail: "Modules use the same candles for charting, but each module keeps its own indicators, checklist, trade entries, journal, and reports."
    };
  }
  return {
    status: "STALE",
    tone: "warn",
    message: "The chart has cached XAUUSD candles, but continuous polling is not live right now.",
    detail: "This usually means the NY polling window is closed or the scheduler is waiting for the next allowed API call window."
  };
}

function moduleReadinessLabel(state: PanelState, moduleCode: string) {
  if (moduleCode === "orb_max_options") {
    const readiness = state.orbDataReadiness?.readiness;
    if (!readiness) return { label: "WAIT", tone: "warn" };
    return { label: readiness.canBacktest === false ? "MISSING DATA" : "READY", tone: readiness.canBacktest === false ? "warn" : "good" };
  }
  if (moduleCode === "high_probability_strategy_2") {
    const checks = state.module2Readiness?.checks ?? [];
    const failed = checks.filter((check: any) => check.status === "FAIL").length;
    if (checks.length === 0) return { label: "WAIT", tone: "warn" };
    return { label: failed > 0 ? `${failed} FAIL` : "READY", tone: failed > 0 ? "bad" : "good" };
  }
  if (moduleCode === "strategy_lab_3") {
    const readiness = state.module3DataReadiness?.readiness;
    if (!readiness) return { label: "WAIT", tone: "warn" };
    return { label: readiness.canBacktest === false ? "MISSING DATA" : "READY", tone: readiness.canBacktest === false ? "warn" : "good" };
  }
  return { label: "WAIT", tone: "warn" };
}

function commandNextAction({ setup, trade, rehearsalStatus, auditStatus, confidence }: { setup?: any; trade?: any; rehearsalStatus: string; auditStatus: string; confidence?: any }) {
  if (trade?.outcome === "ACTIVE") return "Monitor active paper trade and let TP/SL lifecycle record outcome.";
  if (setup?.status === "LONG SETUP READY" || setup?.status === "SHORT SETUP READY") return `${setup.direction === "SHORT" ? "SELL" : "BUY"} paper setup ready; review checklist and chart marker.`;
  if (rehearsalStatus !== "GO") return "Run GO / NO-GO rehearsal.";
  if (auditStatus !== "PASS") return "Resolve production audit before trusting signals.";
  if (!confidence?.confidence?.trust) return "Feature-ready. Collect non-QA paper/backtest samples for trust.";
  return "Ready. Wait for next valid NY session signal.";
}

function UnifiedLearningDashboard({
  state,
  modules,
  onRun,
  onOpenReports
}: {
  state: PanelState;
  modules: any[];
  onRun: (moduleCode: string) => Promise<void>;
  onOpenReports: (moduleCode: string) => void;
}) {
  const rows = modules.map((module: any) => learningModuleRow(state, module));
  const totalSample = rows.reduce((sum, row) => sum + row.sampleSize, 0);
  const readyRows = rows.filter((row) => row.sampleSize >= 20).length;
  const recommendations = rows.flatMap((row) => row.recommendations.map((item: any) => ({ ...item, moduleCode: row.moduleCode, moduleName: row.name })));
  return (
    <>
      <Panel icon={<LineChart />} title="Unified Learning Dashboard">
        <div className="strategy-validation-hero">
          <div>
            <span>Learning posture</span>
            <strong className={readyRows === rows.length && rows.length > 0 ? "good-text" : "warn-text"}>{readyRows}/{rows.length} MODULES SAMPLE READY</strong>
          </div>
          <em>{totalSample} total samples</em>
        </div>
        <div className="metrics-grid compact">
          <Metric label="Modules" value={rows.length} />
          <Metric label="Recommendations" value={recommendations.length} />
          <Metric label="Pending reviews" value={state.module2LearningReviews?.filter((row: any) => row.status === "PENDING").length ?? 0} />
          <Metric label="Best expectancy" value={formatR(Math.max(...rows.map((row) => row.expectancy), 0))} />
          <Metric label="Most samples" value={[...rows].sort((left, right) => right.sampleSize - left.sampleSize)[0]?.name ?? "--"} />
          <Metric label="Mode" value="Paper learning only" />
        </div>
        <p className="reason">Learning remains separate by module. This page only compares results and recommendations so you can decide which strategy deserves more monitoring.</p>
      </Panel>

      <Panel icon={<Database />} title="Learning Comparison">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Status</th>
                <th>Sample</th>
                <th>Win Rate</th>
                <th>Expectancy</th>
                <th>Total R</th>
                <th>Recommendations</th>
                <th>Weak Rules</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.moduleCode}>
                  <td>{row.name}</td>
                  <td><span className={`status-pill ${row.sampleSize >= 20 ? "good" : "warn"}`}>{row.status}</span></td>
                  <td>{row.sampleSize}</td>
                  <td>{formatPercent(row.winRate)}</td>
                  <td>{formatR(row.expectancy)}</td>
                  <td>{formatR(row.totalR)}</td>
                  <td>{row.recommendations.length}</td>
                  <td>{row.weakRules.slice(0, 2).map((rule: any) => formatScenario(rule.rule_code ?? rule.ruleCode)).join(", ") || "--"}</td>
                  <td>
                    <div className="admin-actions inline-actions">
                      <button onClick={() => onRun(row.moduleCode).catch(() => undefined)}>Run</button>
                      <button onClick={() => onOpenReports(row.moduleCode)}>Detail</button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? <tr><td colSpan={9}>No enabled modules for learning.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel icon={<FileText />} title="Learning Recommendations">
        <div className="admin-list">
          {recommendations.slice(0, 12).map((item: any, index: number) => (
            <div className="admin-row" key={item.id ?? `${item.moduleCode}-${index}`}>
              <strong>{item.moduleName}: {item.title ?? item.recommendation_type ?? "Recommendation"}</strong>
              <span><span className={`pill ${item.confidence === "HIGH" ? "good" : item.confidence === "MEDIUM" ? "warn" : "neutral"}`}>{item.confidence ?? "LOW"}</span> {item.rationale ?? item.suggested_action?.action ?? "Review module learning evidence."}</span>
            </div>
          ))}
          {recommendations.length === 0 ? <p className="reason">No learning recommendations yet. Run learning after paper trades or backtests exist.</p> : null}
        </div>
      </Panel>
    </>
  );
}

function learningModuleRow(state: PanelState, module: any) {
  const moduleCode = module.code;
  const learning = moduleCode === "orb_max_options" ? state.orbLearning : moduleCode === "high_probability_strategy_2" ? state.module2Learning : state.module3Learning;
  const summary = learning?.summary ?? {};
  const overall = summary.overall ?? {};
  const winRate = Number(overall.winRate ?? overall.win_rate ?? 0);
  const expectancy = Number(overall.expectancy ?? 0);
  const totalR = Number(overall.totalR ?? overall.total_r ?? 0);
  const weakRules = summary.failureRules ?? summary.failedRules ?? [];
  return {
    moduleCode,
    name: moduleShortName(moduleCode, module.name),
    status: learning?.status ?? (learning?.id ? "COMPLETED" : "NOT RUN"),
    sampleSize: Number(learning?.sample_size ?? 0),
    winRate,
    expectancy,
    totalR,
    recommendations: learning?.recommendations ?? [],
    weakRules
  };
}

function BacktestSummaryPanel({ state, moduleCode, onRun }: { state: PanelState; moduleCode: string; onRun: () => Promise<void> }) {
  const latest = state.latestBacktest;
  const metrics = latest?.metrics ?? [];
  const metricByKey = new Map(metrics.map((item: any) => [item.metric_key, item.metric_json ?? item.metric_value]));
  const moduleName = moduleShortName(moduleCode);
  const liquidityTags = breakdownTags(metricByKey.get("liquidity_type_breakdown"));
  const hourTags = breakdownTags(metricByKey.get("hour_breakdown"));
  const scoreTags = breakdownTags(metricByKey.get("score_breakdown"));
  return (
    <Panel icon={<LineChart />} title={`${moduleName} Backtest`}>
      <Metric label="Status" value={latest?.status ?? "NOT RUN"} />
      <Metric label="Candles" value={latest?.summary?.candleCount ?? 0} />
      <Metric label="Sessions tested" value={latest?.summary?.sessionsTested ?? 0} />
      <Metric label={moduleCode === "high_probability_strategy_2" ? "Valid sessions" : "Valid ranges"} value={latest?.summary?.sessionsWithRange ?? 0} />
      <Metric label="Trades" value={latest?.summary?.trades ?? 0} />
      <Metric label="Win rate" value={formatPercent(latest?.summary?.winRate)} />
      <Metric label="Total R" value={formatR(latest?.summary?.totalR)} />
      <Metric label="Completed" value={formatNepalTime(latest?.completed_at)} />
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><LineChart size={16} />Run {moduleName}</button>
      </div>
      <div className="tag-row">
        {scenarioBreakdownTags(latest?.summary?.scenarioBreakdown).length > 0
          ? scenarioBreakdownTags(latest?.summary?.scenarioBreakdown).map((tag) => <span key={tag}>{tag}</span>)
          : <span>No scenario trades yet</span>}
      </div>
      {moduleCode === "high_probability_strategy_2" ? (
        <>
          <div className="tag-row">
            {liquidityTags.length > 0 ? liquidityTags.map((tag) => <span key={tag}>{tag}</span>) : <span>No liquidity-type stats yet</span>}
          </div>
          <div className="tag-row">
            {scoreTags.length > 0 ? scoreTags.map((tag) => <span key={tag}>{tag}</span>) : <span>No score-band stats yet</span>}
          </div>
          <div className="tag-row">
            {hourTags.length > 0 ? hourTags.slice(0, 8).map((tag) => <span key={tag}>{tag}</span>) : <span>No hour stats yet</span>}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function OrbCompletionCenter({ state, qaSuite }: { state: PanelState; qaSuite?: any }) {
  const latestBacktest = state.latestBacktest?.summary ?? {};
  const dataReady = state.orbDataReadiness?.readiness ?? {};
  const qaPass = qaSuite?.finalStatus === "PASS";
  const dataUsable = dataReady.canBacktest === true || Number(state.orbDataReadiness?.postgres?.candleCount ?? 0) > 0;
  const backtestRan = state.latestBacktest?.status === "COMPLETED";
  const performanceProven = ["PAPER_TRADING_READY", "STRONG_CANDIDATE"].includes(String(latestBacktest.confidence?.grade ?? ""));
  const latestRehearsal = state.orbRehearsals?.[0];
  const rehearsalStatus = latestRehearsal?.finalStatus ?? latestRehearsal?.final_status;
  const confidenceRow = (state.strategyConfidence?.modules ?? []).find((row: any) => row.moduleCode === "orb_max_options");
  const auditStatusValue = confidenceRow?.audit?.summary?.status ?? latestRehearsal?.audit?.status ?? latestRehearsal?.audit_json?.status;
  const trustComplete = Boolean(confidenceRow?.confidence?.trust);
  const rows = [
    { phase: "ORB MAX engine", status: "COMPLETE", detail: "Breakout, retest, fakeout, sweep, overextension, and no-trade scenarios are implemented." },
    { phase: "Shared XAUUSD feed", status: "COMPLETE", detail: "Module 1 uses the shared Twelve Data feed and isolated ORB setup/trade records." },
    { phase: "Paper trading", status: "COMPLETE", detail: "Real external execution is disabled; paper trades use ORB risk and TP/SL planning." },
    { phase: "QA replay suite", status: qaPass ? "COMPLETE" : "READY", detail: qaPass ? `${qaSuite.summary?.passed ?? 0}/${qaSuite.summary?.total ?? 0} cases passed.` : "Run Full ORB QA Suite from Data Admin to refresh proof." },
    { phase: "GO / NO-GO rehearsal", status: rehearsalStatus === "GO" ? "COMPLETE" : "READY", detail: rehearsalStatus === "GO" ? "End-to-end ORB replay, paper trade, close, journal, notification, and isolation proof passed." : "Run Module 1 launch rehearsal." },
    { phase: "Production audit", status: auditStatusValue === "PASS" ? "COMPLETE" : "READY", detail: auditStatusValue === "PASS" ? "Module 1 audit is clean." : "Run rehearsal and confidence audit." },
    { phase: "Data readiness", status: dataUsable ? "COMPLETE" : "NEEDS_DATA", detail: dataReady.reason ?? "Waiting for ORB timeframe NY candles." },
    { phase: "Backtest confidence", status: performanceProven ? "COMPLETE" : backtestRan ? "NEEDS_DATA" : "READY", detail: latestBacktest.confidence?.recommendation ?? "Run Module 1 backtest after candles are ready." },
    { phase: "Learning system", status: state.orbLearning?.status === "COMPLETED" || state.orbLearning?.id ? "COMPLETE" : "READY", detail: "ORB learning reviews closed paper-trade outcomes and scenario performance." },
    { phase: "Reports", status: (state.weeklyReport?.length ?? 0) > 0 || (state.monthlyReport?.length ?? 0) > 0 ? "COMPLETE" : "READY", detail: "Weekly and monthly ORB reports are available from real non-QA paper trades." },
    { phase: "Journal evidence", status: Number(state.orbAdmin?.trades ?? 0) > 0 ? "COMPLETE" : "READY", detail: Number(state.orbAdmin?.trades ?? 0) > 0 ? `${state.orbAdmin?.trades} ORB paper trades recorded.` : "Will populate from live paper trades." },
    { phase: "Live NY observation", status: state.feedStatus?.live ? "COMPLETE" : "READY", detail: "Live proof completes during upcoming NY sessions." }
  ];
  const built = rows.filter((row) => row.status === "COMPLETE").length;
  const featureComplete = qaPass && rehearsalStatus === "GO" && auditStatusValue === "PASS";
  const finalLabel = featureComplete ? "FEATURE COMPLETE" : "READY TO FINISH";
  return (
    <Panel icon={<ShieldCheck />} title="Module 1 Completion Center">
      <div className="cockpit-hero good">
        <div>
          <span>Build completion</span>
          <strong>{built}/{rows.length}</strong>
        </div>
        <div>
          <span>Final status</span>
          <strong>{finalLabel}</strong>
        </div>
        <div>
          <span>Performance trust</span>
          <strong>{trustComplete || performanceProven ? "TRUSTED" : "LOW SAMPLE"}</strong>
        </div>
      </div>
      <div className="completion-grid">
        {rows.map((row) => (
          <div className={`completion-row ${row.status === "COMPLETE" ? "good" : row.status === "NEEDS_DATA" ? "warn" : ""}`} key={row.phase}>
            <strong>{row.phase}</strong>
            <span className={`status-pill ${row.status === "COMPLETE" ? "good" : ""}`}>{row.status}</span>
            <p>{row.detail}</p>
          </div>
        ))}
      </div>
      <p className="reason">{featureComplete ? "Module 1 is complete as an automated ORB indicator and paper-trading module. Performance proof must come from enough real NY-session paper/backtest samples." : "Finish the READY rows above to complete Module 1."}</p>
    </Panel>
  );
}

function OrbQAControlPanel({ onRunSuite, suite }: { onRunSuite: () => Promise<void>; suite?: any }) {
  return (
    <Panel icon={<ShieldCheck />} title="Module 1 ORB QA Suite">
      <div className="admin-actions">
        <button onClick={() => onRunSuite().catch(() => undefined)}><ShieldCheck size={16} />Run Full ORB QA Suite</button>
      </div>
      {suite ? (
        <div className="module2-qa-suite">
          <div className="metrics-grid compact">
            <Metric label="Suite status" value={suite.finalStatus ?? "--"} />
            <Metric label="Passed" value={`${suite.summary?.passed ?? 0}/${suite.summary?.total ?? 0}`} />
            <Metric label="API credits" value={suite.twelveDataCreditsUsed ?? 0} />
            <Metric label="Real orders" value={suite.externalOrdersPlaced ?? 0} />
          </div>
          <table className="data-table">
            <thead><tr><th>Case</th><th>Expected</th><th>Actual</th><th>Tradable</th><th>Status</th></tr></thead>
            <tbody>
              {(suite.cases ?? []).map((item: any) => (
                <tr key={item.code}>
                  <td>{item.label}</td>
                  <td>{formatScenario(item.expected)}</td>
                  <td>{formatScenario(item.actual)}</td>
                  <td>{item.actualTradable ? "YES" : "NO"}</td>
                  <td><span className={`status-pill ${item.status === "PASS" ? "good" : "bad"}`}>{item.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="reason">Runs all Module 1 replay cases without Twelve Data credits or real orders.</p>}
    </Panel>
  );
}

function Module2ProductionCockpit({
  state,
  setup,
  trade,
  onRunRehearsal
}: {
  state: PanelState;
  setup?: any;
  trade?: any;
  onRunRehearsal: () => Promise<void>;
}) {
  const cockpit = module2CockpitState(state, setup, trade);
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Production Cockpit">
      <div className={`cockpit-hero ${cockpit.statusTone}`}>
        <div>
          <span>Session trust score</span>
          <strong>{cockpit.trustScore}/100</strong>
        </div>
        <div>
          <span>Launch status</span>
          <strong>{cockpit.launchStatus}</strong>
        </div>
      </div>
      <div className="cockpit-grid">
        <Metric label="NY phase" value={cockpit.phase} />
        <Metric label="Feed" value={cockpit.feedStatus} />
        <Metric label="Paper trading" value={cockpit.paperStatus} />
        <Metric label="Health" value={cockpit.healthStatus} />
        <Metric label="Learning reviews" value={cockpit.reviewStatus} />
        <Metric label="Latest rehearsal" value={cockpit.rehearsalStatus} />
        <Metric label="Current setup" value={setup?.status ?? "WAITING"} />
        <Metric label="Active trade" value={trade?.id ? `${trade.direction ?? "--"} · ${trade.outcome ?? "ACTIVE"}` : "NONE"} />
      </div>
      <div className="admin-actions">
        <button onClick={() => onRunRehearsal().catch(() => undefined)}><ShieldCheck size={16} />Run Rehearsal</button>
      </div>
      <div className="evidence-notes">
        <strong>Blocking Items</strong>
        {cockpit.blockers.map((item) => <span key={item}>{item}</span>)}
      </div>
      <div className="cockpit-checklists">
        {cockpit.checklists.map((group) => (
          <div className="cockpit-checklist" key={group.title}>
            <strong>{group.title}</strong>
            {group.items.map((item) => <span key={item}>{item}</span>)}
          </div>
        ))}
      </div>
      <p className="reason">{cockpit.verdict}</p>
    </Panel>
  );
}

function Module2CompletionCenter({ state, qaSuite }: { state: PanelState; qaSuite?: any }) {
  const latestBacktest = state.latestBacktest?.summary ?? {};
  const dataReady = state.module2DataReadiness?.readiness ?? {};
  const auditChecks = state.module2Audit?.checks ?? [];
  const readinessChecks = state.module2Readiness?.checks ?? [];
  const reports = state.module2SessionReports ?? [];
  const journalTrades = state.module2JournalTrades ?? [];
  const closeouts = state.module2Closeouts ?? [];
  const learning = state.module2Learning ?? {};
  const auditPass = auditChecks.length > 0 && auditChecks.every((check: any) => check.status !== "FAIL");
  const qaPass = qaSuite?.finalStatus === "PASS";
  const dataUsable = dataReady.canBacktest === true || Number(state.module2DataReadiness?.postgres?.candleCount ?? 0) > 0;
  const backtestRan = state.latestBacktest?.status === "COMPLETED";
  const performanceProven = ["PAPER_TRADING_READY", "STRONG_CANDIDATE"].includes(String(latestBacktest.confidence?.grade ?? ""));
  const rows = [
    { phase: "Strategy engine", status: "COMPLETE", detail: "Hard rules, confirmation scoring, quality filters, valid BUY/SELL only." },
    { phase: "Shared XAUUSD feed", status: "COMPLETE", detail: "Module 2 uses the shared Twelve Data chart/feed while keeping trades and logic isolated." },
    { phase: "Paper trading", status: "COMPLETE", detail: "External execution disabled; paper trades open only after Module 2 checklist eligibility." },
    { phase: "QA replay suite", status: qaPass ? "COMPLETE" : "READY", detail: qaPass ? `${qaSuite.summary?.passed ?? 0}/${qaSuite.summary?.total ?? 0} cases passed.` : "Run Full QA Suite from Data Admin to refresh proof." },
    { phase: "Data readiness", status: dataUsable ? "COMPLETE" : "NEEDS_DATA", detail: dataReady.reason ?? "Waiting for 5-minute NY candles." },
    { phase: "Backtest confidence", status: performanceProven ? "COMPLETE" : backtestRan ? "NEEDS_DATA" : "READY", detail: latestBacktest.confidence?.recommendation ?? "Run Module 2 backtest after candles are ready." },
    { phase: "Learning system", status: learning.status === "COMPLETED" || learning.id ? "COMPLETE" : "READY", detail: learning.summary?.generatedFrom === "CACHE_BACKTEST" ? "Latest learning snapshot came from Module 2 cache/PostgreSQL backtest." : "Learning runs after backtests or completed paper trades." },
    { phase: "Journal evidence", status: journalTrades.length > 0 ? "COMPLETE" : "READY", detail: journalTrades.length > 0 ? `${journalTrades.length} Module 2 journal trade rows available.` : "Will populate when real or QA paper trades exist." },
    { phase: "Daily reports", status: reports.length > 0 ? "COMPLETE" : "READY", detail: reports.length > 0 ? `${reports.length} Module 2 session reports stored.` : "Generate after a Module 2 NY session." },
    { phase: "Closeout recovery", status: closeouts.length > 0 ? "COMPLETE" : "READY", detail: closeouts.length > 0 ? "Closeout history and recovery actions are available." : "Ready for first session closeout." },
    { phase: "Production safeguards", status: auditPass ? "COMPLETE" : "READY", detail: auditPass ? "Audit checks pass; replay data stays excluded." : "Production audit is available and will flag boundary issues." },
    { phase: "Live NY observation", status: state.module2Health?.summary?.status === "OK" ? "COMPLETE" : "READY", detail: "Live proof completes naturally during upcoming NY sessions." }
  ];
  const built = rows.filter((row) => row.status === "COMPLETE").length;
  const finalLabel = performanceProven ? "MODULE 2 COMPLETE AND PAPER-CONFIDENCE READY" : "MODULE 2 FEATURE COMPLETE, PERFORMANCE NEEDS MORE MARKET DATA";
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Completion Center">
      <div className="cockpit-hero good">
        <div>
          <span>Build completion</span>
          <strong>{built}/{rows.length}</strong>
        </div>
        <div>
          <span>Final status</span>
          <strong>{finalLabel}</strong>
        </div>
      </div>
      <div className="completion-grid">
        {rows.map((row) => (
          <div className={`completion-row ${row.status === "COMPLETE" ? "good" : row.status === "NEEDS_DATA" ? "warn" : ""}`} key={row.phase}>
            <strong>{row.phase}</strong>
            <span className={`status-pill ${row.status === "COMPLETE" ? "good" : row.status === "NEEDS_DATA" ? "" : ""}`}>{row.status}</span>
            <p>{row.detail}</p>
          </div>
        ))}
      </div>
      <p className="reason">No real external execution is enabled. Module 2 is finished as an automated indicator and paper-trading module; market performance must keep accumulating from real NY-session candles.</p>
    </Panel>
  );
}

function Module2SessionReportsPanel({
  reports,
  onGenerate,
  onSaveNotes
}: {
  reports?: any[];
  onGenerate: () => Promise<void>;
  onSaveNotes: (reportId: string, operatorNotes: string, trustedManually: boolean | null) => Promise<void>;
}) {
  const latest = reports?.[0];
  const [notes, setNotes] = useState("");
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [filters, setFilters] = useState({ status: "", outcome: "", from: "", to: "" });

  useEffect(() => {
    setNotes(latest?.operator_notes ?? "");
    setTrusted(latest?.trusted_manually ?? null);
  }, [latest?.id]);

  const summary = latest?.summary ?? {};
  const feed = latest?.feed_snapshot ?? {};
  const setup = latest?.setup_snapshot ?? {};
  const trade = latest?.trade_snapshot ?? {};
  const blocked = latest?.blocked_reasons ?? [];
  const learning = latest?.learning_notes ?? {};
  const filteredReports = (reports ?? []).filter((row: any) => {
    const date = String(row.session_date ?? "");
    if (filters.status && row.final_status !== filters.status) return false;
    if (filters.outcome && row.trade_snapshot?.dominantOutcome !== filters.outcome) return false;
    if (filters.from && date < filters.from) return false;
    if (filters.to && date > filters.to) return false;
    return true;
  });
  return (
    <Panel icon={<FileText />} title="Module 2 Daily Session Report">
      <Metric label="Latest report" value={latest?.session_date ?? "NOT GENERATED"} />
      <Metric label="Status" value={latest?.final_status ?? "--"} />
      <Metric label="5M candles" value={feed.candles5m ?? 0} />
      <Metric label="Valid setups" value={setup.valid ?? summary.validSetups ?? 0} />
      <Metric label="Paper trades" value={summary.paperTrades ?? trade.total ?? 0} />
      <Metric label="W/L/Active" value={`${summary.wins ?? 0}/${summary.losses ?? 0}/${summary.active ?? 0}`} />
      <Metric label="Total R" value={formatR(summary.totalR)} />
      <Metric label="Learning sample" value={learning.sampleSize ?? 0} />
      <div className="admin-actions">
        <button onClick={() => onGenerate().catch(() => undefined)}><FileText size={16} />Generate Today</button>
        <button onClick={() => exportModule2ReportsCsv(filteredReports)}><FileText size={16} />Export CSV</button>
      </div>
      <div className="filter-bar">
        <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
          <option value="">All statuses</option>
          <option value="GO">GO</option>
          <option value="REVIEW">REVIEW</option>
          <option value="NO_GO">NO GO</option>
        </select>
        <select value={filters.outcome} onChange={(event) => setFilters((current) => ({ ...current, outcome: event.target.value }))}>
          <option value="">All outcomes</option>
          <option value="WIN">Win</option>
          <option value="LOSS">Loss</option>
          <option value="ACTIVE">Active</option>
          <option value="NONE">No trade</option>
        </select>
        <input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
        <input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
      </div>
      <div className="evidence-notes">
        <strong>Blocked Reasons</strong>
        {blocked.slice(0, 6).map((item: string) => <span key={item}>{item}</span>)}
        {blocked.length === 0 ? <span>No blocked reasons in the latest report.</span> : null}
      </div>
      {latest ? (
        <div className="session-note-editor">
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Operator notes after the NY session" />
          <select value={trusted === null ? "" : trusted ? "true" : "false"} onChange={(event) => setTrusted(event.target.value === "" ? null : event.target.value === "true")}>
            <option value="">Manual trust not marked</option>
            <option value="true">Trusted manually</option>
            <option value="false">Not trusted manually</option>
          </select>
          <button onClick={() => onSaveNotes(latest.id, notes, trusted).catch(() => undefined)}>Save Notes</button>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Setups</th>
              <th>Trades</th>
              <th>Result</th>
              <th>Trusted</th>
            </tr>
          </thead>
          <tbody>
            {filteredReports.slice(0, 12).map((row: any) => (
              <tr key={row.id}>
                <td>{row.session_date}</td>
                <td><span className={`pill ${row.final_status === "GO" ? "good" : row.final_status === "NO_GO" ? "bad" : "warn"}`}>{row.final_status}</span></td>
                <td>{row.summary?.validSetups ?? row.setup_snapshot?.valid ?? 0}</td>
                <td>{row.summary?.paperTrades ?? row.trade_snapshot?.total ?? 0}</td>
                <td>{formatR(row.summary?.totalR ?? row.trade_snapshot?.total_r)}</td>
                <td>{row.trusted_manually == null ? "--" : row.trusted_manually ? "YES" : "NO"}</td>
              </tr>
            ))}
            {filteredReports.length === 0 ? <tr><td colSpan={6}>No Module 2 session reports match the filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Module2CloseoutPanel({
  closeouts,
  onAction
}: {
  closeouts?: any[];
  onAction: (action: "rerun" | "report-only" | "learning-only" | "reseed-reviews") => Promise<void>;
}) {
  const latest = closeouts?.[0];
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Closeout Status">
      <Metric label="Latest date" value={latest?.session_date ?? "--"} />
      <Metric label="Closeout" value={latest?.status ?? "NOT RUN"} />
      <Metric label="Report" value={latest?.report_status ?? (latest?.report_id ? "READY" : "--")} />
      <Metric label="Learning" value={latest?.learning_status ?? (latest?.learning_run_id ? "READY" : "SKIPPED")} />
      <Metric label="Review items" value={latest?.review_items_created ?? 0} />
      <Metric label="Notification" value={latest?.notification_id ? "SENT" : "--"} />
      {latest?.error ? <p className="reason form-error">{latest.error}</p> : null}
      <div className="admin-actions">
        <button onClick={() => onAction("rerun").catch(() => undefined)}><ShieldCheck size={16} />Rerun Closeout</button>
        <button onClick={() => onAction("report-only").catch(() => undefined)}><FileText size={16} />Report Only</button>
        <button onClick={() => onAction("learning-only").catch(() => undefined)}><LineChart size={16} />Learning Only</button>
        <button onClick={() => onAction("reseed-reviews").catch(() => undefined)}><CheckCircle2 size={16} />Reseed Reviews</button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Report</th>
              <th>Learning</th>
              <th>Reviews</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {(closeouts ?? []).slice(0, 12).map((row: any) => (
              <tr key={row.id}>
                <td>{row.session_date}</td>
                <td><span className={`pill ${row.status === "COMPLETED" ? "good" : row.status === "FAILED" ? "bad" : "warn"}`}>{row.status}</span></td>
                <td>{row.report_status ?? (row.report_id ? "READY" : "--")}</td>
                <td>{row.learning_status ?? (row.learning_run_id ? "READY" : "SKIPPED")}</td>
                <td>{row.review_items_created ?? 0}</td>
                <td>{row.error ?? "--"}</td>
              </tr>
            ))}
            {!(closeouts ?? []).length ? <tr><td colSpan={6}>No automatic closeout has run yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Module2QAControlPanel({
  onReplay,
  onRunSuite,
  suite,
  onDryRun,
  onClear
}: {
  onReplay: (replayCase: string, openPaperTrade?: boolean) => Promise<void>;
  onRunSuite: () => Promise<void>;
  suite?: any;
  onDryRun: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const cases = [
    { code: "BUY", label: "Valid BUY", paper: true },
    { code: "SELL", label: "Valid SELL", paper: true },
    { code: "SWEEP_NO_DISPLACEMENT", label: "Hard fail: no displacement" },
    { code: "DISPLACEMENT_NO_BOS", label: "Hard fail: no BOS" },
    { code: "BOS_NO_RETRACE", label: "Setup waiting: no retrace" },
    { code: "INVALIDATED_SETUP", label: "Invalidated setup" },
    { code: "LOW_SCORE_NO_TRADE", label: "Score fail: no trade" }
  ];
  return (
    <Panel icon={<Database />} title="Module 2 QA Control">
      <div className="replay-grid module2-replay-grid">
        {cases.map((item) => (
          <button key={item.code} onClick={() => onReplay(item.code, item.paper).catch(() => undefined)}>{item.label}</button>
        ))}
      </div>
      <div className="admin-actions">
        <button onClick={() => onRunSuite().catch(() => undefined)}><ShieldCheck size={16} />Run Full QA Suite</button>
        <button onClick={() => onDryRun().catch(() => undefined)}><LineChart size={16} />Dry-run Saved Candles</button>
        <button onClick={() => onClear().catch(() => undefined)}><Trash2 size={16} />Clear QA Signals</button>
      </div>
      {suite ? (
        <div className="module2-qa-suite">
          <div className="metrics-grid compact">
            <Metric label="Suite status" value={suite.finalStatus ?? "--"} />
            <Metric label="Passed" value={`${suite.summary?.passed ?? 0}/${suite.summary?.total ?? 0}`} />
            <Metric label="API credits" value={suite.twelveDataCreditsUsed ?? 0} />
            <Metric label="Real orders" value={suite.externalOrdersPlaced ?? 0} />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Rules</th>
                <th>Paper</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(suite.cases ?? []).map((item: any) => (
                <tr key={item.code}>
                  <td>{item.label}</td>
                  <td>{item.expectedStatus}</td>
                  <td>{item.actualStatus}</td>
                  <td>{item.hardRulesPassed ? "Hard pass" : item.blockingFailure ?? item.failureRule ?? "Blocked"} · C{item.confirmationCount}/5 · Q{item.qualityCount}/6</td>
                  <td>{item.actualPaperEligible ? "Eligible" : "Blocked"}</td>
                  <td><span className={`status-pill ${item.status === "PASS" ? "good" : "bad"}`}>{item.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {suite.finalStatus !== "PASS" ? <p className="reason">{(suite.cases ?? []).find((item: any) => item.status !== "PASS")?.reason}</p> : null}
        </div>
      ) : null}
      <p className="reason">QA replays are isolated to Module 2, use fake/saved candles, spend no Twelve Data credits, and never open real orders.</p>
    </Panel>
  );
}

function Module3QAControlPanel({
  onReplay,
  onRunSuite,
  suite,
  onClear
}: {
  onReplay: (replayCase: string, openPaperTrade?: boolean) => Promise<void>;
  onRunSuite: () => Promise<void>;
  suite?: any;
  onClear: () => Promise<void>;
}) {
  const cases = [
    { code: "BUY", label: "Valid BUY", paper: true },
    { code: "SELL", label: "Valid SELL", paper: true },
    { code: "WEAK_OPENING_DRIVE", label: "Hard fail: weak drive" },
    { code: "NO_VWAP_ALIGNMENT", label: "Hard fail: no VWAP" },
    { code: "NO_PULLBACK", label: "Hard fail: no pullback" },
    { code: "NO_CONFIRMATION", label: "Hard fail: no confirmation" },
    { code: "INVALID_RR", label: "Risk fail: RR" },
    { code: "NO_TRADE", label: "No trade" }
  ];
  return (
    <Panel icon={<Database />} title="Module 3 QA Control">
      <div className="replay-grid module2-replay-grid">
        {cases.map((item) => (
          <button key={item.code} onClick={() => onReplay(item.code, item.paper).catch(() => undefined)}>{item.label}</button>
        ))}
      </div>
      <div className="admin-actions">
        <button onClick={() => onRunSuite().catch(() => undefined)}><ShieldCheck size={16} />Run Full QA Suite</button>
        <button onClick={() => onClear().catch(() => undefined)}><Trash2 size={16} />Clear QA Signals</button>
      </div>
      {suite ? <QaSuiteTable suite={suite} /> : null}
      <p className="reason">QA replays are isolated to Module 3, use generated replay evidence, spend no Twelve Data credits, and never open real orders.</p>
    </Panel>
  );
}

function QaSuiteTable({ suite }: { suite: any }) {
  return (
    <div className="module2-qa-suite">
      <div className="metrics-grid compact">
        <Metric label="Suite status" value={suite.finalStatus ?? "--"} />
        <Metric label="Passed" value={`${suite.summary?.passed ?? 0}/${suite.summary?.total ?? 0}`} />
        <Metric label="API credits" value={suite.twelveDataCreditsUsed ?? 0} />
        <Metric label="Real orders" value={suite.externalOrdersPlaced ?? 0} />
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>Blocker</th>
            <th>Paper</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {(suite.cases ?? []).map((item: any) => (
            <tr key={item.code}>
              <td>{item.label}</td>
              <td>{item.expectedStatus}</td>
              <td>{item.actualStatus}</td>
              <td>{item.blockingFailure ?? item.failureRule ?? "--"}</td>
              <td>{item.actualPaperEligible ? "Eligible" : "Blocked"}</td>
              <td><span className={`status-pill ${item.status === "PASS" ? "good" : "bad"}`}>{item.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Module2LifecycleTester({
  setup,
  trade,
  onLifecycle
}: {
  setup?: any;
  trade?: any;
  onLifecycle: (event: string, tradeId?: string | null, setupId?: string | null) => Promise<void>;
}) {
  const events = [
    ["ENTRY_HIT", "Entry touched"],
    ["TP_HIT", "TP hit"],
    ["SL_HIT", "SL hit"],
    ["EXPIRED_SETUP", "Expired setup"],
    ["MISSED_ENTRY", "Missed entry"],
    ["MANUAL_CLOSE", "Manual close"]
  ];
  return (
    <Panel icon={<Clock />} title="Module 2 Lifecycle Tester">
      <Metric label="Current setup" value={setup?.scenario ? `${formatScenario(setup.scenario)} · ${setup.status}` : "No setup selected"} />
      <Metric label="Current trade" value={trade?.id ? `${trade.direction ?? "--"} · ${trade.outcome ?? "ACTIVE"}` : "No active trade"} />
      <div className="replay-grid module2-replay-grid">
        {events.map(([code, label]) => (
          <button key={code} onClick={() => onLifecycle(code, trade?.id, setup?.id).catch(() => undefined)}>{label}</button>
        ))}
      </div>
      <p className="reason">Use this after a valid BUY/SELL replay to verify journal, outcome, notifications, and report math.</p>
    </Panel>
  );
}

function Module2RuleAuditPanel({ setup }: { setup?: any }) {
  const evaluations = setup?.evaluations ?? [];
  const hard = evaluations.filter((row: any) => module2RuleLayer(row.rule_code ?? row.ruleCode) === "hard");
  const confirmations = evaluations.filter((row: any) => module2RuleLayer(row.rule_code ?? row.ruleCode) === "confirmation");
  const quality = evaluations.filter((row: any) => module2RuleLayer(row.rule_code ?? row.ruleCode) === "quality");
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Rule Audit">
      <Metric label="Decision" value={setup?.status ?? "WAITING"} />
      <Metric label="Scenario" value={formatScenario(setup?.scenario)} />
      <Metric label="Why" value={setup?.final_reason ?? "Waiting for Module 2 evidence."} />
      <Module2RuleLayer title="Hard Rules" rows={hard} empty="No hard-rule evidence yet." />
      <Module2RuleLayer title="Confirmation Rules" rows={confirmations} empty="No confirmation evidence yet." />
      <Module2RuleLayer title="Quality Filters" rows={quality} empty="No quality-filter evidence yet." />
    </Panel>
  );
}

function Module2RuleLayer({ title, rows, empty }: { title: string; rows: any[]; empty: string }) {
  const passed = rows.filter((row) => row.status === "PASS").length;
  return (
    <div className="rule-layer">
      <div className="rule-layer-head">
        <strong>{title}</strong>
        <span>{passed}/{rows.length} pass</span>
      </div>
      <div className="rule-list compact-rule-list">
        {rows.map((row) => (
          <div className={`rule-row ${row.status === "PASS" ? "good" : row.status === "FAIL" ? "bad" : "warn"}`} key={row.rule_code ?? row.ruleCode}>
            <div>
              <strong>{row.name}</strong>
              <p>{row.explanation}</p>
            </div>
            <span>{row.status}</span>
          </div>
        ))}
        {rows.length === 0 ? <p className="reason">{empty}</p> : null}
      </div>
    </div>
  );
}

function Module2LaunchEvidenceLogPanel({ rehearsals }: { rehearsals?: any[] }) {
  const rows = rehearsals ?? [];
  return (
    <Panel icon={<FileText />} title="Module 2 Launch Evidence Log">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Checklist</th>
              <th>Health</th>
              <th>Dry-run</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row: any) => {
              const checklist = row.checklist_json ?? row.checklist ?? [];
              const health = row.health_json ?? row.health?.summary ?? {};
              const dryRun = row.dry_run_json ?? row.readiness?.dryRunResult ?? {};
              const passed = Array.isArray(checklist) ? checklist.filter((item: any) => item.status === "PASS").length : 0;
              return (
                <tr key={row.id ?? row.generatedAt ?? row.created_at}>
                  <td>{formatNepalTime(row.created_at ?? row.generatedAt)}</td>
                  <td><span className={`pill ${row.final_status === "GO" || row.finalStatus === "GO" ? "good" : "bad"}`}>{row.final_status ?? row.finalStatus}</span></td>
                  <td>{passed}/{Array.isArray(checklist) ? checklist.length : 0}</td>
                  <td>{health.status ?? "--"}</td>
                  <td>{dryRun.status ?? "--"}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? <tr><td colSpan={5}>No launch rehearsal has been saved yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Module2LearningPanel({
  learning,
  reviews,
  onRun,
  onCreateReview,
  onUpdateReview
}: {
  learning?: any;
  reviews?: any[];
  onRun: () => Promise<void>;
  onCreateReview: (recommendationId: string) => Promise<void>;
  onUpdateReview: (reviewId: string, status: string, note?: string) => Promise<void>;
}) {
  const summary = learning?.summary ?? {};
  const overall = summary.overall ?? {};
  const recommendations = learning?.recommendations ?? [];
  return (
    <Panel icon={<LineChart />} title="Module 2 Learning Engine">
      <Metric label="Last run" value={formatNepalTime(learning?.completed_at)} />
      <Metric label="Status" value={learning?.status ?? "NOT RUN"} />
      <Metric label="Sample size" value={learning?.sample_size ?? 0} />
      <Metric label="Win rate" value={formatPercent(overall.winRate)} />
      <Metric label="Expectancy" value={`${formatR(overall.expectancy)}R`} />
      <Metric label="Total R" value={`${formatR(overall.totalR)}R`} />
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><LineChart size={16} />Run Module 2 Learning</button>
      </div>
      {summary.sampleWarning ? <p className="reason">Learning is in QA mode because the sample is below 20 closed non-QA Module 2 trades.</p> : null}
      <Module2LearningBuckets title="By Grade" rows={summary.byGrade} />
      <Module2LearningBuckets title="By Direction" rows={summary.byDirection} />
      <Module2LearningBuckets title="By Liquidity" rows={summary.byLiquidity} />
      <div className="evidence-notes">
        <strong>Most Common Rule Failures</strong>
        {(summary.failureRules ?? []).slice(0, 6).map((rule: any) => (
          <span key={`${rule.rule_code}-${rule.status}`}>{formatScenario(rule.rule_code)}: {rule.count} · {rule.status}</span>
        ))}
        {!(summary.failureRules ?? []).length ? <span>No saved Module 2 rule failures yet.</span> : null}
      </div>
      <div className="admin-list">
        {recommendations.slice(0, 6).map((item: any) => (
          <div className="admin-row" key={item.id ?? item.title}>
            <strong>{item.title}</strong>
            <span>
              <span className={`pill ${item.confidence === "HIGH" ? "good" : item.confidence === "MEDIUM" ? "warn" : "neutral"}`}>{item.confidence}</span> {item.rationale}
              {item.id ? <button onClick={() => onCreateReview(item.id).catch(() => undefined)}>Review</button> : null}
            </span>
          </div>
        ))}
        {recommendations.length === 0 ? <p className="reason">No Module 2 learning recommendations yet.</p> : null}
      </div>
      <Module2LearningReviewQueue reviews={reviews} onUpdateReview={onUpdateReview} />
    </Panel>
  );
}

function Module2LearningReviewQueue({ reviews, onUpdateReview }: { reviews?: any[]; onUpdateReview: (reviewId: string, status: string, note?: string) => Promise<void> }) {
  const rows = reviews ?? [];
  return (
    <div className="learning-review-queue">
      <div className="rule-layer-head">
        <strong>Learning Review Queue</strong>
        <span>{rows.filter((row) => row.status === "PENDING").length} pending</span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Recommendation</th>
              <th>Status</th>
              <th>Guardrails</th>
              <th>Proposal</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row: any) => {
              const guardrails = row.guardrails ?? [];
              const failed = guardrails.filter((check: any) => check.status === "FAIL").length;
              const warned = guardrails.filter((check: any) => check.status === "WARN").length;
              const proposal = row.proposed_change ?? {};
              return (
                <tr key={row.id}>
                  <td>{row.title}</td>
                  <td><span className={`pill ${row.status === "APPROVED_QA" || row.status === "APPLIED" ? "good" : row.status === "REJECTED" ? "bad" : "warn"}`}>{row.status}</span></td>
                  <td>{failed > 0 ? `${failed} fail` : warned > 0 ? `${warned} warn` : "PASS"}</td>
                  <td>{proposal.mode ?? "--"} · {Object.keys(proposal.changes ?? {}).join(", ") || "no config change"}</td>
                  <td>
                    <div className="table-actions">
                      <button onClick={() => onUpdateReview(row.id, "APPROVED_QA").catch(() => undefined)}>QA</button>
                      <button onClick={() => onUpdateReview(row.id, "REJECTED", "Rejected from dashboard review.").catch(() => undefined)}>Reject</button>
                      <button onClick={() => onUpdateReview(row.id, "APPLIED").catch(() => undefined)}>Applied</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? <tr><td colSpan={5}>No learning recommendations have been sent to review yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Module2LearningBuckets({ title, rows }: { title: string; rows?: Record<string, any> }) {
  const entries = Object.entries(rows ?? {});
  return (
    <div className="table-wrap learning-bucket-table">
      <table className="data-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th>Trades</th>
            <th>Win</th>
            <th>Total R</th>
            <th>Expectancy</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 8).map(([key, value]: [string, any]) => (
            <tr key={key}>
              <td>{formatScenario(key)}</td>
              <td>{value.trades ?? 0}</td>
              <td>{formatPercent(value.winRate)}</td>
              <td>{formatR(value.totalR)}</td>
              <td>{formatR(value.expectancy)}</td>
            </tr>
          ))}
          {entries.length === 0 ? <tr><td colSpan={5}>No learning buckets yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

function Module2OperatorModePanel({ operator, onRun }: { operator?: any; onRun: () => Promise<void> }) {
  const data = operator?.operator ?? {};
  const status = operator?.finalStatus ?? "WAIT";
  const setup = data.latestSetupState ?? {};
  const trade = data.activeTradeStatus;
  return (
    <Panel icon={<Clock />} title="Module 2 Operator Mode">
      <div className={`operator-status-strip ${status === "GO" ? "good" : status === "NO_GO" ? "bad" : "warn"}`}>
        <strong>{status === "NO_GO" ? "NO GO" : status}</strong>
        <span>{data.currentPhase ?? "Waiting for operator status"}</span>
      </div>
      <Metric label="NY start" value={formatNepalTime(data.timeline?.sessionStartAt)} />
      <Metric label="Signal end" value={formatNepalTime(data.timeline?.signalWindowEndAt)} />
      <Metric label="Next action" value={data.nextAction ?? "--"} />
      <Metric label="Latest candle" value={formatNepalTime(data.latestCandle)} />
      <Metric label="Setup state" value={setup.status ? `${setup.status}${setup.direction ? ` · ${setup.direction}` : ""}` : "--"} />
      <Metric label="Active trade" value={trade ? `${trade.direction ?? "--"} · ${trade.outcome ?? "ACTIVE"}` : "NONE"} />
      <Metric label="Last alert" value={data.lastAlert?.title ?? "--"} />
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><ShieldCheck size={16} />Run Launch Rehearsal</button>
      </div>
    </Panel>
  );
}

function Module2LaunchChecklistPanel({ operator }: { operator?: any }) {
  const checklist = operator?.checklist ?? [];
  return (
    <Panel icon={<CheckCircle2 />} title="Module 2 Launch Checklist">
      <div className="rule-list compact-rule-list">
        {checklist.map((row: any) => (
          <div className={`rule-row ${row.status === "PASS" ? "good" : row.status === "FAIL" ? "bad" : "warn"}`} key={row.code}>
            <div>
              <strong>{row.label}</strong>
              <p>{row.detail}</p>
            </div>
            <span>{row.status}</span>
          </div>
        ))}
        {checklist.length === 0 ? <p className="reason">Run Module 2 launch rehearsal to populate the full launch checklist.</p> : null}
      </div>
    </Panel>
  );
}

function Module2HandoffReportPanel({ operator }: { operator?: any }) {
  const handoff = operator?.handoff ?? {};
  const preset = handoff.currentPreset ?? {};
  const watch = handoff.watchDuringSession ?? [];
  const warnings = handoff.activeWarnings ?? [];
  return (
    <Panel icon={<FileText />} title="Module 2 Session Handoff">
      <Metric label="Launch status" value={operator?.finalStatus === "NO_GO" ? "NO GO" : operator?.finalStatus ?? "WAIT"} />
      <Metric label="Preset" value={preset.preset_code ?? "--"} />
      <Metric label="Expected action" value={handoff.expectedNextAction ?? "--"} />
      <div className="admin-list">
        {watch.slice(0, 5).map((item: string) => (
          <div className="admin-row" key={item}>
            <strong>Watch</strong>
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div className="evidence-notes">
        <strong>Active warnings</strong>
        {warnings.slice(0, 5).map((warning: string) => <span key={warning}>{warning}</span>)}
      </div>
      <p className="reason">{handoff.manualTraderNotes ?? "Run launch rehearsal before the NY session to generate the handoff report."}</p>
    </Panel>
  );
}

function Module2ReadinessPanel({ readiness, dryRun, onDryRun }: { readiness?: any; dryRun?: any; onDryRun: () => Promise<void> }) {
  const checks = readiness?.checks ?? [];
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Live Readiness">
      <Metric label="Twelve Data" value={readiness?.feed?.twelveDataConfigured ? "CONFIGURED" : "MISSING"} />
      <Metric label="NY window" value={checkValue(checks, "NY_WINDOW") ?? "--"} />
      <Metric label="5M candles" value={readiness?.feed?.fiveMinute ? `${readiness.feed.fiveMinute.cache} cache / ${readiness.feed.fiveMinute.postgres} DB` : "--"} />
      <Metric label="15M bias" value={readiness?.feed?.fifteenMinute ? `${readiness.feed.fifteenMinute.cache} cache / ${readiness.feed.fifteenMinute.postgres} DB` : "--"} />
      <Metric label="Automation" value={readiness?.automation?.enabled === false ? "DISABLED" : "ENABLED"} />
      <Metric label="Paper trading" value={checkStatus(checks, "PAPER_TRADING_ENABLED")} />
      <Metric label="Latest evaluated" value={formatNepalTime(checkValue(checks, "LATEST_EVALUATED_CANDLE"))} />
      <Metric label="Active trade" value={readiness?.activeTrade?.id ? "ACTIVE" : "NONE"} />
      <div className="admin-actions">
        <button onClick={() => onDryRun().catch(() => undefined)}><LineChart size={16} />Dry Run</button>
      </div>
      {dryRun ? (
        <div className="evidence-notes">
          <strong>{dryRun.status} · {dryRun.state ?? "NO STATE"}</strong>
          <span>{dryRun.finalReason ?? dryRun.reason}</span>
          <span>{dryRun.setupCandles ?? 0} setup candles · {dryRun.biasCandles ?? 0} bias candles · Would trade: {dryRun.wouldOpenPaperTrade ? "YES" : "NO"}</span>
        </div>
      ) : null}
      <div className="tag-row">
        {checks.map((check: any) => <span key={check.code}>{check.label}: {check.status}</span>)}
      </div>
    </Panel>
  );
}

function Module2EvidenceInspector({ setup }: { setup?: any }) {
  const flags = setup?.scenario_flags ?? {};
  const zone = flags.entryZone ?? {};
  const sweep = flags.sweep ?? {};
  const displacement = flags.displacement ?? {};
  const bos = flags.bos ?? {};
  const levels = Array.isArray(flags.levels) ? flags.levels : [];
  const confirmationLayer = flags.confirmationLayer ?? {};
  const qualityLayer = flags.qualityLayer ?? {};
  const displacementCandle = displacement?.candle ?? {};
  return (
    <Panel icon={<Database />} title="Module 2 Evidence">
      <Metric label="State" value={String(flags.state ?? setup?.status ?? "WAITING")} />
      <Metric label="Liquidity map" value={levels.length ? `${levels.length} levels` : "--"} />
      <Metric label="Swept liquidity" value={sweep?.level?.type ? `${formatScenario(sweep.level.type)} · ${sweep.level.side ?? "--"}` : "--"} />
      <Metric label="Sweep level" value={sweep?.level?.price == null ? "--" : Number(sweep.level.price).toFixed(2)} />
      <Metric label="Sweep distance" value={sweep?.distanceAtr == null ? "--" : `${Number(sweep.distanceAtr).toFixed(2)} ATR`} />
      <Metric label="Sweep time" value={formatNepalTime(sweep?.closedBackAt ?? sweep?.sweptAt ?? sweep?.candle?.timestampUtc)} />
      <Metric label="Displacement time" value={formatNepalTime(displacementCandle?.timestampUtc)} />
      <Metric label="Displacement range" value={displacement?.rangeAtr == null ? "--" : `${Number(displacement.rangeAtr).toFixed(2)} ATR`} />
      <Metric label="BOS level" value={bos?.level == null ? "--" : Number(bos.level).toFixed(2)} />
      <Metric label="BOS time" value={formatNepalTime(bos?.candle?.timestampUtc)} />
      <Metric label="BOS structure" value={bos?.structure?.kind ? `${bos.structure.kind} · ${Number(bos.structure.price ?? bos.level).toFixed(2)}` : "--"} />
      <Metric label="Zone type" value={zone?.kind ?? "--"} />
      <Metric label="Zone bounds" value={zone?.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`} />
      <Metric label="Confirmations" value={confirmationLayer?.count == null ? "--" : `${confirmationLayer.count}/${confirmationLayer.required ?? 5}`} />
      <Metric label="Quality filters" value={qualityLayer?.count == null ? "--" : `${qualityLayer.count}/${qualityLayer.required ?? 3}`} />
      <Metric label="Checklist tier" value={flags.setupTier ?? "--"} />
      <Metric label="Entry / SL / TP" value={setup?.entry_price == null ? "--" : `${Number(setup.entry_price).toFixed(2)} / ${Number(setup.stop_price).toFixed(2)} / ${Number(setup.target_price).toFixed(2)}`} />
      <div className="evidence-notes">
        <strong>Liquidity Levels</strong>
        {levels.slice(0, 8).map((level: any) => (
          <span key={`${level.type}-${level.price}`}>{formatScenario(level.type)} · {Number(level.price).toFixed(2)} · {level.priority ?? "LOW"}</span>
        ))}
        {levels.length === 0 ? <span>Waiting for PDH/PDL, Asian, London, equal high/low, or swing liquidity evidence.</span> : null}
      </div>
    </Panel>
  );
}

function Module3StrategyValidationPanel({ setup, evaluations, session }: { setup?: any; evaluations: any[]; session?: any }) {
  const flags = setup?.scenario_flags ?? {};
  const zone = flags.entryZone ?? {};
  const drive = flags.drive ?? {};
  const rows = vwapOpeningDriveChecklistRows(evaluations, setup);
  const groups = [
    {
      title: "Hard Rules",
      description: "All must pass before Module 3 can create a paper-trade candidate.",
      codes: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "OPENING_DRIVE_COMPLETE", "OPENING_DRIVE_STRONG", "VWAP_ALIGNMENT", "PULLBACK_ZONE_READY", "PULLBACK_ZONE_TOUCHED", "CONFIRMATION_CANDLE"]
    },
    {
      title: "Confirmations",
      description: "These improve continuation quality after the opening drive.",
      codes: ["EMA_ALIGNMENT"]
    },
    {
      title: "Quality Filters",
      description: "These protect the paper entry from poor execution conditions.",
      codes: ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "SIGNAL_SCORE"]
    }
  ];
  const rowByCode = new Map(rows.map((row: any) => [row.rule_code ?? row.ruleCode, row]));
  const hardPass = groups[0].codes.every((code) => rowByCode.get(code)?.status === "PASS");
  const passCount = rows.filter((row: any) => row.status === "PASS").length;
  const state = flags.state ?? setup?.status ?? session?.state ?? "WAITING";
  return (
    <Panel icon={<ShieldCheck />} title="Module 3 Strategy Validation">
      <div className="strategy-validation-hero">
        <div>
          <span>NY VWAP Opening Drive Pullback</span>
          <strong className={hardPass ? "good-text" : "warn-text"}>{hardPass ? "TRADE READY" : String(state).replaceAll("_", " ")}</strong>
        </div>
        <em>{passCount}/{rows.length} checks</em>
      </div>
      <div className="journal-evidence-grid">
        <Metric label="Drive" value={drive.high == null ? "--" : `${Number(drive.low).toFixed(2)}-${Number(drive.high).toFixed(2)}`} />
        <Metric label="VWAP" value={flags.vwap == null ? "--" : Number(flags.vwap).toFixed(2)} />
        <Metric label="EMA 20" value={flags.ema == null ? "--" : Number(flags.ema).toFixed(2)} />
        <Metric label="Pullback zone" value={zone.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`} />
        <Metric label="RR" value={flags.riskReward == null ? "--" : `${Number(flags.riskReward).toFixed(2)}R`} />
        <Metric label="Plan" value={setup?.entry_price == null ? "--" : `${Number(setup.entry_price).toFixed(2)} / ${Number(setup.stop_price).toFixed(2)} / ${Number(setup.target_price).toFixed(2)}`} />
      </div>
      <div className="validation-groups">
        {groups.map((group) => {
          const groupRows = group.codes.map((code) => rowByCode.get(code)).filter(Boolean);
          const groupPassed = groupRows.filter((row: any) => row.status === "PASS").length;
          return (
            <div className="validation-group" key={group.title}>
              <div className="validation-group-head">
                <div>
                  <strong>{group.title}</strong>
                  <span>{group.description}</span>
                </div>
                <em>{groupPassed}/{groupRows.length}</em>
              </div>
              <div className="rule-list compact-rule-list">
                {groupRows.map((row: any) => (
                  <div className={`rule-row ${ruleTone(row.status)}`} key={row.rule_code ?? row.ruleCode}>
                    {row.status === "PASS" ? <CheckCircle2 size={15} /> : row.status === "FAIL" ? <XCircle size={15} /> : <Clock size={15} />}
                    <strong>{row.name}</strong>
                    <span>{row.status}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Module2FinalReadinessChecklist({ readiness, audit, dryRun }: { readiness?: any; audit?: any; dryRun?: any }) {
  const checks = readiness?.checks ?? [];
  const auditChecks = audit?.checks ?? [];
  const rows = [
    { label: "Data feed ready", status: ["TWELVE_DATA_CONFIGURED", "FIVE_MIN_CANDLES", "FIFTEEN_MIN_BIAS"].every((code) => checkStatus(checks, code) === "PASS") ? "PASS" : "WAIT" },
    { label: "Rules ready", status: dryRun?.evaluations?.length > 0 ? "PASS" : "WAIT" },
    { label: "Automation ready", status: checkStatus(checks, "AUTOMATION_ENABLED") === "PASS" ? "PASS" : "FAIL" },
    { label: "Reporting ready", status: auditChecks.length > 0 ? "PASS" : "WAIT" },
    { label: "QA replay separated", status: auditStatus(auditChecks, "REPLAY_EXCLUDED_FROM_PRODUCTION") },
    { label: "Production audit passed", status: auditChecks.filter((check: any) => check.status === "FAIL").length === 0 && auditChecks.length > 0 ? "PASS" : "WAIT" }
  ];
  return (
    <Panel icon={<CheckCircle2 />} title="Module 2 Final Checklist">
      <div className="rule-list compact-rule-list">
        {rows.map((row) => (
          <div className={`rule-row ${row.status === "PASS" ? "good" : row.status === "FAIL" ? "bad" : "warn"}`} key={row.label}>
            <strong>{row.label}</strong>
            <span>{row.status}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Module2JournalPanel({
  state,
  setup,
  selectedTradeId,
  detail,
  onSelectTrade,
  onLifecycle
}: {
  state: PanelState;
  setup?: any;
  selectedTradeId?: string | null;
  detail?: any;
  onSelectTrade: (tradeId: string) => Promise<void>;
  onLifecycle: (event: string, tradeId?: string | null, setupId?: string | null) => Promise<void>;
}) {
  const trades = state.module2JournalTrades ?? [];
  const flags = setup?.scenario_flags ?? {};
  const snapshot = flags.chartSnapshotCandles ?? [];
  const selectedTrade = detail?.trade;
  const selectedSnapshot = detail?.chartSnapshotCandles ?? [];
  return (
    <Panel icon={<FileText />} title="Module 2 Journal Detail">
      <div className="journal-evidence-grid">
        <Metric label="Latest setup" value={formatScenario(setup?.scenario)} />
        <Metric label="Direction" value={setup?.direction ?? "--"} />
        <Metric label="Score" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/110`} />
        <Metric label="Result" value={state.currentTrade?.outcome ?? "Tracking"} />
        <Metric label="Sweep" value={flags.sweep?.level?.type ?? "--"} />
        <Metric label="BOS time" value={formatNepalTime(flags.bos?.candle?.timestampUtc)} />
        <Metric label="Entry zone" value={flags.entryZone?.low == null ? "--" : `${Number(flags.entryZone.low).toFixed(2)}-${Number(flags.entryZone.high).toFixed(2)}`} />
        <Metric label="Snapshot candles" value={snapshot.length} />
      </div>
      <div className="evidence-notes">
        <strong>Learning notes</strong>
        <span>{setup?.final_reason ?? "Module 2 journal will populate after a replay or real automatic paper setup."}</span>
      </div>
      <div className="admin-actions lifecycle-actions">
        <button onClick={() => onLifecycle("ENTRY_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>Entry Hit</button>
        <button onClick={() => onLifecycle("TP_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>TP Hit</button>
        <button onClick={() => onLifecycle("SL_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>SL Hit</button>
        <button onClick={() => onLifecycle("EXPIRED_SETUP", selectedTradeId, setup?.id).catch(() => undefined)}>Expire</button>
        <button onClick={() => onLifecycle("MISSED_ENTRY", selectedTradeId, setup?.id).catch(() => undefined)}>Missed</button>
        <button onClick={() => onLifecycle("MANUAL_CLOSE", selectedTradeId, setup?.id).catch(() => undefined)}>Manual Close</button>
      </div>
      {selectedTrade ? (
        <div className="journal-detail-card">
          <div>
            <strong>{selectedTrade.direction} · {formatScenario(selectedTrade.scenario)}</strong>
            <span>{formatNepalTime(selectedTrade.opened_at)} · {selectedTrade.outcome ?? "ACTIVE"} · {formatR(selectedTrade.result_r)}</span>
          </div>
          <div className="journal-evidence-grid">
            <Metric label="Entry" value={selectedTrade.actual_entry ?? selectedTrade.planned_entry ?? "--"} />
            <Metric label="Stop" value={selectedTrade.actual_stop ?? selectedTrade.planned_stop ?? "--"} />
            <Metric label="Target" value={selectedTrade.actual_target ?? selectedTrade.planned_target ?? "--"} />
            <Metric label="Exit" value={selectedTrade.actual_exit ?? "--"} />
            <Metric label="Checklist rows" value={detail.evaluations?.length ?? 0} />
            <Metric label="Events" value={detail.events?.length ?? 0} />
            <Metric label="Journal notes" value={detail.journal?.length ?? 0} />
            <Metric label="Snapshot candles" value={selectedSnapshot.length} />
          </div>
          <div className="rule-list compact-rule-list">
            {(detail.evaluations ?? []).slice(0, 8).map((row: any) => (
              <div className={`rule-row ${row.status === "PASS" ? "good" : row.status === "FAIL" ? "bad" : "warn"}`} key={row.id ?? row.rule_code}>
                <strong>{row.name}</strong>
                <span>{row.status}</span>
              </div>
            ))}
          </div>
          <div className="admin-list">
            {(detail.events ?? []).slice(-5).map((event: any) => (
              <div className="admin-row" key={event.id}>
                <strong>{event.event_type}</strong>
                <span>{formatNepalTime(event.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Direction</th>
              <th>Scenario</th>
              <th>Score</th>
              <th>Status</th>
              <th>Result R</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 10).map((trade: any) => (
              <tr key={trade.id} className={trade.id === selectedTradeId ? "selected-row" : ""}>
                <td>{formatNepalTime(trade.opened_at ?? trade.detected_at)}</td>
                <td>{trade.direction ?? "--"}</td>
                <td>{formatScenario(trade.scenario)}</td>
                <td>{trade.favorability_score ?? "--"}</td>
                <td>{trade.outcome ?? trade.setup_status ?? "--"}</td>
                <td>{formatR(trade.result_r)}</td>
                <td><button onClick={() => onSelectTrade(trade.id).catch(() => undefined)}>Open</button></td>
              </tr>
            ))}
            {trades.length === 0 ? (
              <tr><td colSpan={7}>No Module 2 paper trades yet. Run BUY + paper or SELL + paper from Data Admin.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleCompletionCenter({
  moduleName,
  dataReadiness,
  qaSuite,
  learning,
  journalTrades,
  reports,
  rehearsals,
  confidence,
  setupHistory
}: {
  moduleName: string;
  dataReadiness?: any;
  qaSuite?: any;
  learning?: any;
  journalTrades?: any[];
  reports?: any[];
  rehearsals?: any[];
  confidence?: any;
  setupHistory?: any[];
}) {
  const qaPass = qaSuite?.finalStatus === "PASS";
  const dataReady = dataReadiness?.readiness ?? {};
  const latestRehearsal = rehearsals?.[0];
  const rehearsalStatus = latestRehearsal?.finalStatus ?? latestRehearsal?.final_status;
  const confidenceRow = (confidence?.modules ?? []).find((row: any) => row.moduleCode === "strategy_lab_3");
  const auditStatusValue = confidenceRow?.audit?.summary?.status ?? latestRehearsal?.audit?.status ?? latestRehearsal?.audit_json?.status;
  const sampleSize = confidenceRow?.confidence?.sampleSize ?? 0;
  const featureComplete = qaPass && rehearsalStatus === "GO" && (journalTrades?.length ?? 0) > 0 && (reports?.length ?? 0) > 0 && auditStatusValue === "PASS" && (setupHistory?.length ?? 0) > 0;
  const trustComplete = Boolean(confidenceRow?.confidence?.trust);
  const phases = [
    { phase: "Shared XAUUSD feed", status: "COMPLETE", detail: `${moduleName} uses the shared Twelve Data chart/feed while keeping trades and logic isolated.` },
    { phase: "Data readiness", status: dataReady.canBacktest ? "COMPLETE" : "READY", detail: dataReady.reason ?? "Collect NY 5M candles for validation." },
    { phase: "QA replay suite", status: qaPass ? "COMPLETE" : "READY", detail: qaPass ? `${qaSuite.summary?.passed ?? 0}/${qaSuite.summary?.total ?? 0} cases passed.` : "Run the QA suite from Data Admin." },
    { phase: "GO / NO-GO rehearsal", status: rehearsalStatus === "GO" ? "COMPLETE" : "READY", detail: rehearsalStatus === "GO" ? "End-to-end replay, paper trade, close, journal, notification, and isolation proof passed." : "Run Module 3 launch rehearsal." },
    { phase: "Production audit", status: auditStatusValue === "PASS" ? "COMPLETE" : "READY", detail: auditStatusValue === "PASS" ? "Module 3 audit is clean." : "Run rehearsal and confidence audit." },
    { phase: "Setup history", status: (setupHistory?.length ?? 0) > 0 ? "COMPLETE" : "READY", detail: `${setupHistory?.length ?? 0} Module 3 setup history rows available.` },
    { phase: "Journal evidence", status: (journalTrades?.length ?? 0) > 0 ? "COMPLETE" : "READY", detail: `${journalTrades?.length ?? 0} journal trade rows available.` },
    { phase: "Session reports", status: (reports?.length ?? 0) > 0 ? "COMPLETE" : "READY", detail: "Generate reports after NY session or QA evidence." },
    { phase: "Learning system", status: learning?.status === "COMPLETED" || learning?.id ? "COMPLETE" : "READY", detail: "Learning runs after completed non-QA paper trades." },
    { phase: "Performance confidence", status: trustComplete ? "COMPLETE" : "NEEDS_SAMPLE", detail: confidenceRow?.confidence?.reason ?? `Needs non-QA sample. Current sample size: ${sampleSize}.` }
  ];
  return (
    <Panel icon={<ShieldCheck />} title={`${moduleName} Completion Center`}>
      <div className="strategy-validation-hero">
        <div>
          <span>Final Module Status</span>
          <strong className={featureComplete ? "good-text" : "warn-text"}>{featureComplete ? "FEATURE COMPLETE" : "READY TO FINISH"}</strong>
        </div>
        <em>{trustComplete ? "TRUSTED" : "LOW SAMPLE"}</em>
      </div>
      <div className="admin-list">
        {phases.map((item) => (
          <div className="admin-row" key={item.phase}>
            <strong>{item.phase}</strong>
            <span>{item.status} · {item.detail}</span>
          </div>
        ))}
      </div>
      <p className="reason">{featureComplete ? `${moduleName} is complete for automatic paper trading. Real-money trust still requires enough non-QA paper/backtest samples.` : "Finish the READY rows above to complete the module."}</p>
    </Panel>
  );
}

function Module3ResultsReportPanel({ state }: { state: PanelState }) {
  const trades = state.module3JournalTrades ?? [];
  const closed = trades.filter((trade: any) => ["WIN", "LOSS", "BREAKEVEN"].includes(String(trade.outcome ?? "")));
  const wins = closed.filter((trade: any) => trade.outcome === "WIN").length;
  const losses = closed.filter((trade: any) => trade.outcome === "LOSS").length;
  const totalR = closed.reduce((sum: number, trade: any) => sum + Number(trade.result_r ?? 0), 0);
  const confidenceRow = (state.strategyConfidence?.modules ?? []).find((row: any) => row.moduleCode === "strategy_lab_3");
  const latestReport = state.module3SessionReports?.[0];
  const best = [...closed].sort((left: any, right: any) => Number(right.result_r ?? 0) - Number(left.result_r ?? 0))[0];
  const worst = [...closed].sort((left: any, right: any) => Number(left.result_r ?? 0) - Number(right.result_r ?? 0))[0];
  return (
    <Panel icon={<LineChart />} title="Module 3 Results Report">
      <div className="metrics-grid compact">
        <Metric label="Paper trades" value={trades.length} />
        <Metric label="Closed sample" value={closed.length} />
        <Metric label="Wins / Losses" value={`${wins} / ${losses}`} />
        <Metric label="Win rate" value={formatPercent(closed.length ? wins / closed.length : null)} />
        <Metric label="Average R" value={formatR(closed.length ? totalR / closed.length : 0)} />
        <Metric label="Total R" value={formatR(totalR)} />
        <Metric label="Confidence" value={confidenceRow?.confidence?.label ?? "Do not trust yet"} />
        <Metric label="Audit" value={confidenceRow?.audit?.summary?.status ?? "--"} />
      </div>
      <div className="module2-breakdown-grid">
        <div className="mini-breakdown">
          <strong>Best setup</strong>
          <span>{best ? `${best.direction} · ${formatScenario(best.scenario)} · ${formatR(best.result_r)}` : "No closed winner yet"}</span>
        </div>
        <div className="mini-breakdown">
          <strong>Worst setup</strong>
          <span>{worst ? `${worst.direction} · ${formatScenario(worst.scenario)} · ${formatR(worst.result_r)}` : "No closed loser yet"}</span>
        </div>
        <div className="mini-breakdown">
          <strong>Latest weekly/monthly report</strong>
          <span>{latestReport ? `${latestReport.session_date} · ${latestReport.final_status} · ${formatR(latestReport.summary?.totalR)}` : "Generate a session report after Module 3 paper trades."}</span>
        </div>
      </div>
      <p className="reason">{confidenceRow?.confidence?.reason ?? "Module 3 becomes trusted only after enough non-QA paper trades/backtests plus a clean audit."}</p>
    </Panel>
  );
}

function Module3SetupHistoryPanel({ history }: { history?: any[] }) {
  const rows = history ?? [];
  const valid = rows.filter((row: any) => ["BUY", "SELL"].includes(row.recommendation)).length;
  const blocked = rows.filter((row: any) => row.recommendation === "NO TRADE").length;
  const waiting = rows.filter((row: any) => row.recommendation === "WAIT").length;
  return (
    <Panel icon={<FileText />} title="Module 3 Setup History">
      <div className="metrics-grid compact">
        <Metric label="Total setups" value={rows.length} />
        <Metric label="Buy/Sell signals" value={valid} />
        <Metric label="No trade" value={blocked} />
        <Metric label="Waiting" value={waiting} />
        <Metric label="Latest blocker" value={formatScenario(rows[0]?.blocking_rule)} />
        <Metric label="Latest recommendation" value={rows[0]?.recommendation ?? "--"} />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Detected</th>
              <th>Recommendation</th>
              <th>Direction</th>
              <th>Scenario</th>
              <th>Checklist</th>
              <th>Blocked By</th>
              <th>Paper Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((row: any) => (
              <tr key={row.id}>
                <td>{formatNepalTime(row.detected_at)}</td>
                <td><span className={`status-pill ${["BUY", "SELL"].includes(row.recommendation) ? "good" : row.recommendation === "NO TRADE" ? "bad" : "warn"}`}>{row.recommendation}</span></td>
                <td>{row.direction ?? "--"}</td>
                <td>{formatScenario(row.scenario)}</td>
                <td>{row.checklist_passed ?? 0}/{row.checklist_count ?? 0}</td>
                <td>{formatScenario(row.blocking_rule)}</td>
                <td>{row.outcome ? `${row.outcome} ${formatR(row.result_r)}` : row.trade_status ?? "--"}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={7}>No Module 3 setup history yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleLaunchRehearsalPanel({ moduleName, rehearsals, onRun }: { moduleName: string; rehearsals?: any[]; onRun: () => Promise<void> }) {
  const latest = rehearsals?.[0];
  const checklist = latest?.checklist ?? latest?.checklist_json ?? [];
  const health = latest?.health_json ?? latest?.health ?? {};
  const handoff = latest?.handoff ?? latest?.handoff_json ?? {};
  return (
    <Panel icon={<ShieldCheck />} title={`${moduleName} GO / NO-GO Rehearsal`}>
      <div className="metrics-grid compact">
        <Metric label="Launch status" value={latest?.finalStatus === "NO_GO" || latest?.final_status === "NO_GO" ? "NO GO" : latest?.finalStatus ?? latest?.final_status ?? "WAIT"} />
        <Metric label="QA mode" value="YES" />
        <Metric label="Twelve credits" value={latest?.twelveDataCreditsUsed ?? health.twelveDataCreditsUsed ?? 0} />
        <Metric label="Real orders" value={latest?.externalOrdersPlaced ?? health.externalOrdersPlaced ?? 0} />
        <Metric label="Notifications" value={latest?.notificationProof?.total ?? health.notificationProof?.total ?? "--"} />
        <Metric label="Isolation" value={(latest?.isolation ?? health.isolation)?.mixedTrades === 0 ? "PASS" : "--"} />
      </div>
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><ShieldCheck size={16} />Run {moduleName} Rehearsal</button>
      </div>
      <div className="rule-list compact-rule-list">
        {(checklist ?? []).map((row: any) => (
          <div className={`rule-row ${row.status === "PASS" ? "good" : "bad"}`} key={row.code}>
            <div>
              <strong>{row.label}</strong>
              <p>{row.detail}</p>
            </div>
            <span>{row.status}</span>
          </div>
        ))}
        {!checklist?.length ? <p className="reason">Run rehearsal to prove replay, paper trading, journal, report, notification, and isolation flow.</p> : null}
      </div>
      <div className="evidence-notes">
        <strong>Handoff</strong>
        <span>{handoff.expectedNextAction ?? "No handoff generated yet."}</span>
        <span>{handoff.manualTraderNotes ?? "External execution remains disabled; this proves paper trading only."}</span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Time</th><th>Status</th><th>Checks</th><th>Audit</th></tr></thead>
          <tbody>
            {(rehearsals ?? []).slice(0, 8).map((row: any) => {
              const rows = row.checklist ?? row.checklist_json ?? [];
              const passed = rows.filter((item: any) => item.status === "PASS").length;
              const audit = row.audit ?? row.audit_json ?? {};
              return (
                <tr key={row.id ?? row.generatedAt}>
                  <td>{formatNepalTime(row.created_at ?? row.generatedAt)}</td>
                  <td><span className={`pill ${(row.final_status ?? row.finalStatus) === "GO" ? "good" : "bad"}`}>{row.final_status ?? row.finalStatus}</span></td>
                  <td>{passed}/{rows.length}</td>
                  <td>{audit.status ?? (audit.failedChecks === 0 ? "PASS" : "--")}</td>
                </tr>
              );
            })}
            {(rehearsals ?? []).length === 0 ? <tr><td colSpan={4}>No {moduleName} rehearsal has been saved yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function StrategyConfidencePanel({ confidence, activeModuleCode }: { confidence?: any; activeModuleCode: string }) {
  const rows = confidence?.modules ?? [];
  return (
    <Panel icon={<ShieldCheck />} title="Strategy Confidence">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Trust</th>
              <th>Sample</th>
              <th>Win</th>
              <th>Expectancy</th>
              <th>Audit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any) => {
              const auditFailures = (row.audit?.checks ?? []).filter((check: any) => check.status === "FAIL").length;
              return (
                <tr key={row.moduleCode} className={row.moduleCode === activeModuleCode ? "selected-row" : ""}>
                  <td>{moduleShortName(row.moduleCode, row.moduleName)}</td>
                  <td><span className={`status-pill ${row.confidence?.trust ? "good" : row.confidence?.grade === "BLOCKED" ? "bad" : "warn"}`}>{row.confidence?.label ?? "--"}</span></td>
                  <td>{row.confidence?.sampleSize ?? 0}</td>
                  <td>{formatPercent(row.paper?.winRate ?? row.backtest?.summary?.winRate)}</td>
                  <td>{formatR(row.paper?.averageR ?? row.backtest?.summary?.averageR)}</td>
                  <td>{auditFailures === 0 ? "PASS" : `${auditFailures} fail`}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? <tr><td colSpan={6}>No module confidence data yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="reason">{rows.find((row: any) => row.moduleCode === activeModuleCode)?.confidence?.reason ?? "Confidence requires closed non-QA paper trades or backtests plus clean production audit checks."}</p>
    </Panel>
  );
}

function ModuleDataReadinessPanel({ title, readiness, onBackfill, onBacktest }: { title: string; readiness?: any; onBackfill: () => Promise<void>; onBacktest: () => Promise<void> }) {
  const grade = readiness?.readiness ?? {};
  return (
    <Panel icon={<Database />} title={title}>
      <div className="metrics-grid compact">
        <Metric label="Grade" value={grade.grade ?? "--"} />
        <Metric label="Can backtest" value={grade.canBacktest ? "YES" : "NO"} />
        <Metric label="Cache candles" value={readiness?.cache?.candleCount ?? 0} />
        <Metric label="PostgreSQL candles" value={readiness?.postgres?.candleCount ?? 0} />
        <Metric label="Ready sessions" value={(readiness?.nyCoverage ?? []).filter((row: any) => row.status === "READY").length} />
        <Metric label="Latest backtest" value={formatNepalTime(readiness?.latestBacktest?.completed_at)} />
      </div>
      <p className="reason">{grade.reason ?? "Waiting for data-readiness check."}</p>
      <div className="admin-actions">
        <button onClick={() => onBackfill().catch(() => undefined)}><Database size={16} />Backfill</button>
        <button onClick={() => onBacktest().catch(() => undefined)}><LineChart size={16} />Backtest</button>
      </div>
    </Panel>
  );
}

function ModuleSessionReportsPanel({ moduleName, reports, onGenerate }: { moduleName: string; reports?: any[]; onGenerate: () => Promise<void> }) {
  const latest = reports?.[0];
  return (
    <Panel icon={<FileText />} title={`${moduleName} Session Reports`}>
      <div className="metrics-grid compact">
        <Metric label="Latest status" value={latest?.final_status ?? "--"} />
        <Metric label="Paper trades" value={latest?.summary?.paperTrades ?? 0} />
        <Metric label="Wins" value={latest?.summary?.wins ?? 0} />
        <Metric label="Losses" value={latest?.summary?.losses ?? 0} />
        <Metric label="Total R" value={formatR(latest?.summary?.totalR)} />
        <Metric label="Generated" value={formatNepalTime(latest?.generated_at)} />
      </div>
      <div className="admin-actions">
        <button onClick={() => onGenerate().catch(() => undefined)}><FileText size={16} />Generate Report</button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Date</th><th>Status</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Total R</th></tr></thead>
          <tbody>
            {(reports ?? []).slice(0, 8).map((row: any) => (
              <tr key={row.id}>
                <td>{row.session_date}</td>
                <td>{row.final_status}</td>
                <td>{row.summary?.paperTrades ?? 0}</td>
                <td>{row.summary?.wins ?? 0}</td>
                <td>{row.summary?.losses ?? 0}</td>
                <td>{formatR(row.summary?.totalR)}</td>
              </tr>
            ))}
            {(reports ?? []).length === 0 ? <tr><td colSpan={6}>No session reports yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleJournalPanel({ moduleName, trades, setup, selectedTradeId, detail, onSelectTrade, onLifecycle }: { moduleName: string; trades?: any[]; setup?: any; selectedTradeId?: string | null; detail?: any; onSelectTrade: (tradeId: string) => Promise<void>; onLifecycle?: (event: string, tradeId?: string | null, setupId?: string | null) => Promise<void> }) {
  const flags = setup?.scenario_flags ?? {};
  const selectedTrade = detail?.trade;
  return (
    <Panel icon={<FileText />} title={`${moduleName} Journal Detail`}>
      <div className="journal-evidence-grid">
        <Metric label="Latest setup" value={formatScenario(setup?.scenario)} />
        <Metric label="Direction" value={setup?.direction ?? "--"} />
        <Metric label="Score" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/100`} />
        <Metric label="VWAP" value={flags.vwap == null ? "--" : Number(flags.vwap).toFixed(2)} />
        <Metric label="EMA" value={flags.ema == null ? "--" : Number(flags.ema).toFixed(2)} />
        <Metric label="Entry zone" value={flags.entryZone?.low == null ? "--" : `${Number(flags.entryZone.low).toFixed(2)}-${Number(flags.entryZone.high).toFixed(2)}`} />
      </div>
      <div className="evidence-notes">
        <strong>Learning notes</strong>
        <span>{setup?.final_reason ?? `${moduleName} journal will populate after replay or live paper trades.`}</span>
      </div>
      {onLifecycle ? (
        <div className="admin-actions lifecycle-actions">
          <button onClick={() => onLifecycle("ENTRY_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>Entry Hit</button>
          <button onClick={() => onLifecycle("TP_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>TP Hit</button>
          <button onClick={() => onLifecycle("SL_HIT", selectedTradeId, setup?.id).catch(() => undefined)}>SL Hit</button>
          <button onClick={() => onLifecycle("EXPIRED_SETUP", selectedTradeId, setup?.id).catch(() => undefined)}>Expire</button>
          <button onClick={() => onLifecycle("MISSED_ENTRY", selectedTradeId, setup?.id).catch(() => undefined)}>Missed</button>
          <button onClick={() => onLifecycle("MANUAL_CLOSE", selectedTradeId, setup?.id).catch(() => undefined)}>Manual Close</button>
        </div>
      ) : null}
      {selectedTrade ? (
        <div className="journal-detail-card">
          <div>
            <strong>{selectedTrade.direction} · {formatScenario(selectedTrade.scenario)}</strong>
            <span>{formatNepalTime(selectedTrade.opened_at)} · {selectedTrade.outcome ?? "ACTIVE"} · {formatR(selectedTrade.result_r)}</span>
          </div>
          <div className="journal-evidence-grid">
            <Metric label="Entry" value={selectedTrade.actual_entry ?? selectedTrade.planned_entry ?? "--"} />
            <Metric label="Stop" value={selectedTrade.actual_stop ?? selectedTrade.planned_stop ?? "--"} />
            <Metric label="Target" value={selectedTrade.actual_target ?? selectedTrade.planned_target ?? "--"} />
            <Metric label="Checklist rows" value={detail.evaluations?.length ?? 0} />
            <Metric label="Events" value={detail.events?.length ?? 0} />
            <Metric label="Snapshot candles" value={detail.chartSnapshotCandles?.length ?? 0} />
          </div>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Date</th><th>Direction</th><th>Scenario</th><th>Score</th><th>Status</th><th>Result R</th><th>Detail</th></tr></thead>
          <tbody>
            {(trades ?? []).slice(0, 10).map((trade: any) => (
              <tr key={trade.id} className={trade.id === selectedTradeId ? "selected-row" : ""}>
                <td>{formatNepalTime(trade.opened_at ?? trade.detected_at)}</td>
                <td>{trade.direction ?? "--"}</td>
                <td>{formatScenario(trade.scenario)}</td>
                <td>{trade.favorability_score ?? "--"}</td>
                <td>{trade.outcome ?? trade.setup_status ?? "--"}</td>
                <td>{formatR(trade.result_r)}</td>
                <td><button onClick={() => onSelectTrade(trade.id).catch(() => undefined)}>Open</button></td>
              </tr>
            ))}
            {(trades ?? []).length === 0 ? <tr><td colSpan={7}>No {moduleName} paper trades yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleLearningPanel({ moduleName, learning, onRun }: { moduleName: string; learning?: any; onRun: () => Promise<void> }) {
  const summary = learning?.summary ?? {};
  const indicatorRows = summary.indicatorPlaybook?.indicators ?? [];
  const weakRows = summary.indicatorPlaybook?.weakestIndicators ?? [];
  return (
    <Panel icon={<LineChart />} title={`${moduleName} Learning`}>
      <div className="metrics-grid compact">
        <Metric label="Status" value={learning?.status ?? "NOT RUN"} />
        <Metric label="Sample size" value={learning?.sample_size ?? 0} />
        <Metric label="Paper / backtest" value={`${summary.sampleSources?.paperTrades ?? 0} / ${summary.sampleSources?.backtestTrades ?? 0}`} />
        <Metric label="Recommendations" value={(learning?.recommendations ?? []).length} />
        <Metric label="Win rate" value={formatPercent(summary.overall?.winRate)} />
        <Metric label="Expectancy" value={formatR(summary.overall?.expectancy)} />
        <Metric label="Last run" value={formatNepalTime(learning?.completed_at)} />
      </div>
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><LineChart size={16} />Run Learning</button>
      </div>
      <div className="admin-list">
        {(learning?.recommendations ?? []).slice(0, 5).map((item: any) => (
          <div className="admin-row" key={item.id}>
            <strong>{item.title}</strong>
            <span>{item.confidence} · {item.rationale}</span>
          </div>
        ))}
        {!learning ? <p className="reason">No learning run yet.</p> : null}
      </div>
      {indicatorRows.length > 0 ? (
        <div className="journal-detail-card">
          <div>
            <strong>Indicator Learning</strong>
            <span>{weakRows.length} weak indicator focus area{weakRows.length === 1 ? "" : "s"} found from saved checklist evidence.</span>
          </div>
          <div className="module2-breakdown-grid">
            {indicatorRows.slice(0, 6).map((row: any) => (
              <div className="mini-breakdown" key={row.ruleCode}>
                <strong>{row.indicator}</strong>
                <span>{formatPercent(row.passRate)} pass · {row.total} evaluation{row.total === 1 ? "" : "s"}</span>
                <em>{row.treatment}</em>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Module3RuleAuditPanel({ setup }: { setup?: any }) {
  const evaluations = setup?.module_code === "strategy_lab_3" ? setup?.evaluations ?? [] : [];
  const gates = evaluations.filter((row: any) => ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "OPENING_DRIVE_COMPLETE", "OPENING_DRIVE_STRONG", "VWAP_ALIGNMENT", "PULLBACK_ZONE_READY", "PULLBACK_ZONE_TOUCHED", "CONFIRMATION_CANDLE"].includes(row.rule_code ?? row.ruleCode));
  const confirmations = evaluations.filter((row: any) => ["EMA_ALIGNMENT"].includes(row.rule_code ?? row.ruleCode));
  const filters = evaluations.filter((row: any) => ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "SIGNAL_SCORE"].includes(row.rule_code ?? row.ruleCode));
  return (
    <Panel icon={<ShieldCheck />} title="Module 3 Rule Audit">
      <Module2RuleLayer title="Signal Gates" rows={gates} empty="No Module 3 signal-gate evidence yet." />
      <Module2RuleLayer title="Confirmations" rows={confirmations} empty="No Module 3 confirmation evidence yet." />
      <Module2RuleLayer title="Safety Filters" rows={filters} empty="No Module 3 safety-filter evidence yet." />
    </Panel>
  );
}

function Module2BacktestTable({ latest }: { latest?: any }) {
  const trades = latest?.trades ?? [];
  const [selected, setSelected] = useState<any | null>(null);
  const detail = selected?.details ?? {};
  const detailZone = detail.entryZone ?? {};
  const summary = latest?.summary ?? {};
  const metrics = module2BacktestMetricMap(latest?.metrics ?? []);
  const confidence = summary.confidence ?? metrics.confidence ?? {};
  const failureAnalytics = summary.failureAnalytics ?? metrics.failure_analytics ?? {};
  const directionBreakdown = summary.directionBreakdown ?? metrics.direction_breakdown ?? {};
  const liquidityBreakdown = summary.liquidityBreakdown ?? metrics.liquidity_type_breakdown ?? {};
  return (
    <Panel icon={<LineChart />} title="Module 2 Backtest Table">
      <div className="journal-detail-card">
        <div>
          <strong>{confidence.label ?? "No confidence report yet"}</strong>
          <span>{confidence.recommendation ?? "Run a Module 2 cache backtest after candles are available."}</span>
        </div>
        <div className="journal-evidence-grid">
          <Metric label="Trades" value={summary.trades ?? metrics.total_trades ?? 0} />
          <Metric label="Win rate" value={formatPercent(summary.winRate ?? metrics.win_rate)} />
          <Metric label="Average R" value={formatR(summary.averageR ?? metrics.average_r)} />
          <Metric label="Total R" value={formatR(summary.totalR ?? metrics.total_r)} />
          <Metric label="Max drawdown" value={formatR(summary.maxDrawdownR ?? metrics.max_drawdown_r)} />
          <Metric label="Loss streak" value={summary.maxLossStreak ?? metrics.max_loss_streak ?? 0} />
          <Metric label="Candles" value={summary.candleCount ?? metrics.candle_count ?? 0} />
          <Metric label="Sessions" value={summary.sessionsTested ?? metrics.sessions_tested ?? 0} />
        </div>
        <div className="module2-breakdown-grid">
          <MiniBreakdown title="BUY / SELL" rows={directionBreakdown} />
          <MiniBreakdown title="Liquidity Type" rows={liquidityBreakdown} />
          <MiniFailures title="Failed Rule Focus" rows={failureAnalytics.topFailedRules ?? []} />
        </div>
      </div>
      {selected ? (
        <div className="journal-detail-card">
          <div>
            <strong>{selected.direction ?? "--"} · {formatScenario(selected.scenario)}</strong>
            <span>{formatNepalTime(selected.entryTime ?? selected.session_date)} · {formatR(selected.resultR ?? selected.result_r)}R · {selected.outcome}</span>
          </div>
          <div className="journal-evidence-grid">
            <Metric label="Liquidity" value={detail.liquidityType ?? detail.sweep?.level?.type ?? "--"} />
            <Metric label="Sweep ATR" value={detail.sweepDistanceAtr == null ? "--" : Number(detail.sweepDistanceAtr).toFixed(2)} />
            <Metric label="BOS time" value={formatNepalTime(detail.bosTime ?? detail.bos?.candle?.timestampUtc)} />
            <Metric label="Entry zone" value={detailZone.low == null ? "--" : `${Number(detailZone.low).toFixed(2)}-${Number(detailZone.high).toFixed(2)}`} />
            <Metric label="Score" value={selected.score ?? detail.score ?? detail.favorabilityScore ?? "--"} />
            <Metric label="RR" value={detail.riskReward == null ? "--" : Number(detail.riskReward).toFixed(2)} />
            <Metric label="Entry" value={selected.entry_price ?? selected.entryPrice ?? "--"} />
            <Metric label="Stop / target" value={`${selected.stop_price ?? selected.stopPrice ?? "--"} / ${selected.target_price ?? selected.targetPrice ?? "--"}`} />
          </div>
          <div className="evidence-notes">
            <strong>Backtest Evidence</strong>
            {detail.instruction ? <span>{detail.instruction.operatorInstruction}</span> : null}
            <span>{detail.finalReason ?? detail.reason ?? "Backtest evidence is stored in the trade details snapshot."}</span>
            <span>Checklist rows: {(detail.evaluations ?? detail.checklist ?? []).length || "not stored for this older run"}</span>
          </div>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data-table module2-backtest-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Direction</th>
              <th>Liquidity</th>
              <th>Sweep ATR</th>
              <th>BOS time</th>
              <th>Entry zone</th>
              <th>Score</th>
              <th>Result R</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 16).map((trade: any, index: number) => {
              const details = trade.details ?? {};
              const zone = details.entryZone ?? {};
              return (
                <tr key={`${trade.date ?? trade.entryTime}-${index}`}>
                  <td>{formatNepalTime(details.entryTime ?? trade.entryTime ?? trade.date)}</td>
                  <td>{trade.direction ?? "--"}</td>
                  <td>{details.liquidityType ?? details.sweep?.level?.type ?? "--"}</td>
                  <td>{details.sweepDistanceAtr == null ? "--" : Number(details.sweepDistanceAtr).toFixed(2)}</td>
                  <td>{formatNepalTime(details.bosTime ?? details.bos?.candle?.timestampUtc)}</td>
                  <td>{zone.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`}</td>
                  <td>{trade.score ?? details.score ?? "--"}</td>
                  <td>{formatR(trade.resultR ?? trade.result_r)}</td>
                  <td>{trade.outcome ?? "--"}</td>
                  <td><button onClick={() => setSelected(trade)}>Detail</button></td>
                </tr>
              );
            })}
            {trades.length === 0 ? (
              <tr><td colSpan={10}>Run a Module 2 cache backtest after NY candles are stored to populate this table.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Module3BacktestTable({ latest }: { latest?: any }) {
  const trades = latest?.trades ?? [];
  const [selected, setSelected] = useState<any | null>(null);
  const detail = selected?.details ?? {};
  const zone = detail.entryZone ?? {};
  const drive = detail.drive ?? {};
  const summary = latest?.summary ?? {};
  const metrics = module2BacktestMetricMap(latest?.metrics ?? []);
  const confidence = summary.confidence ?? metrics.confidence ?? {};
  const failureAnalytics = summary.failureAnalytics ?? metrics.failure_analytics ?? {};
  const directionBreakdown = summary.directionBreakdown ?? metrics.direction_breakdown ?? {};
  return (
    <Panel icon={<LineChart />} title="Module 3 Backtest Table">
      <div className="journal-detail-card">
        <div>
          <strong>{confidence.label ?? "No confidence report yet"}</strong>
          <span>{confidence.recommendation ?? "Run a Module 3 cache backtest after NY 5-minute candles are available."}</span>
        </div>
        <div className="journal-evidence-grid">
          <Metric label="Trades" value={summary.trades ?? metrics.total_trades ?? 0} />
          <Metric label="Win rate" value={formatPercent(summary.winRate ?? metrics.win_rate)} />
          <Metric label="Average R" value={formatR(summary.averageR ?? metrics.average_r)} />
          <Metric label="Total R" value={formatR(summary.totalR ?? metrics.total_r)} />
          <Metric label="Max drawdown" value={formatR(summary.maxDrawdownR ?? metrics.max_drawdown_r)} />
          <Metric label="Loss streak" value={summary.maxLossStreak ?? metrics.max_loss_streak ?? 0} />
          <Metric label="Candles" value={summary.candleCount ?? metrics.candle_count ?? 0} />
          <Metric label="Sessions" value={summary.sessionsTested ?? metrics.sessions_tested ?? 0} />
        </div>
        <div className="module2-breakdown-grid">
          <MiniBreakdown title="BUY / SELL" rows={directionBreakdown} />
          <MiniFailures title="Failed Rule Focus" rows={failureAnalytics.topFailedRules ?? []} />
          <div className="mini-breakdown">
            <strong>Module Logic</strong>
            <span>NY opening drive, VWAP alignment, pullback zone, confirmation candle, RR gate.</span>
          </div>
        </div>
      </div>
      {selected ? (
        <div className="journal-detail-card">
          <div>
            <strong>{selected.direction ?? "--"} · {formatScenario(selected.scenario)}</strong>
            <span>{formatNepalTime(selected.entryTime ?? selected.session_date)} · {formatR(selected.resultR ?? selected.result_r)} · {selected.outcome}</span>
          </div>
          <div className="journal-evidence-grid">
            <Metric label="Drive" value={drive.low == null ? "--" : `${Number(drive.low).toFixed(2)}-${Number(drive.high).toFixed(2)}`} />
            <Metric label="VWAP" value={detail.vwap == null ? "--" : Number(detail.vwap).toFixed(2)} />
            <Metric label="EMA 20" value={detail.ema == null ? "--" : Number(detail.ema).toFixed(2)} />
            <Metric label="Pullback zone" value={zone.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`} />
            <Metric label="Score" value={selected.score ?? detail.score ?? "--"} />
            <Metric label="RR" value={detail.riskReward == null ? "--" : Number(detail.riskReward).toFixed(2)} />
            <Metric label="Entry" value={selected.entry_price ?? selected.entryPrice ?? "--"} />
            <Metric label="Stop / target" value={`${selected.stop_price ?? selected.stopPrice ?? "--"} / ${selected.target_price ?? selected.targetPrice ?? "--"}`} />
          </div>
          <div className="evidence-notes">
            <strong>Backtest Evidence</strong>
            {detail.instruction ? <span>{detail.instruction.operatorInstruction}</span> : null}
            <span>{detail.finalReason ?? detail.reason ?? "Backtest evidence is stored in the Module 3 details snapshot."}</span>
            <span>Checklist rows: {(detail.evaluations ?? detail.checklist ?? []).length || "not stored for this older run"}</span>
          </div>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="data-table module2-backtest-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Direction</th>
              <th>VWAP</th>
              <th>Drive</th>
              <th>Pullback Zone</th>
              <th>Score</th>
              <th>RR</th>
              <th>Result R</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, 16).map((trade: any, index: number) => {
              const details = trade.details ?? {};
              const entryZone = details.entryZone ?? {};
              const openingDrive = details.drive ?? {};
              return (
                <tr key={`${trade.date ?? trade.entryTime}-${index}`}>
                  <td>{formatNepalTime(details.entryTime ?? trade.entryTime ?? trade.date)}</td>
                  <td>{trade.direction ?? "--"}</td>
                  <td>{details.vwap == null ? "--" : Number(details.vwap).toFixed(2)}</td>
                  <td>{openingDrive.low == null ? "--" : `${Number(openingDrive.low).toFixed(2)}-${Number(openingDrive.high).toFixed(2)}`}</td>
                  <td>{entryZone.low == null ? "--" : `${Number(entryZone.low).toFixed(2)}-${Number(entryZone.high).toFixed(2)}`}</td>
                  <td>{trade.score ?? details.score ?? "--"}</td>
                  <td>{details.riskReward == null ? "--" : Number(details.riskReward).toFixed(2)}</td>
                  <td>{formatR(trade.resultR ?? trade.result_r)}</td>
                  <td>{trade.outcome ?? "--"}</td>
                  <td><button onClick={() => setSelected(trade)}>Detail</button></td>
                </tr>
              );
            })}
            {trades.length === 0 ? (
              <tr><td colSpan={10}>Run a Module 3 cache backtest after NY 5-minute candles are stored to populate this table.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function MiniBreakdown({ title, rows }: { title: string; rows?: Record<string, any> }) {
  const entries = Object.entries(rows ?? {}).slice(0, 4);
  return (
    <div className="mini-breakdown">
      <strong>{title}</strong>
      {entries.map(([key, value]) => (
        <span key={key}>{key}: {value.trades ?? 0} trades · {formatPercent(value.winRate ?? ((value.wins ?? 0) / Math.max(1, value.trades ?? 0)))} · {formatR(value.totalR)}</span>
      ))}
      {entries.length === 0 ? <span>No breakdown yet</span> : null}
    </div>
  );
}

function MiniFailures({ title, rows }: { title: string; rows?: any[] }) {
  return (
    <div className="mini-breakdown">
      <strong>{title}</strong>
      {(rows ?? []).slice(0, 4).map((row) => <span key={row.ruleCode}>{formatScenario(row.ruleCode)}: {row.count}</span>)}
      {!(rows ?? []).length ? <span>No failed-rule data yet</span> : null}
    </div>
  );
}

function Module2ProductionAuditPanel({ audit }: { audit?: any }) {
  const checks = audit?.checks ?? [];
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Production Audit">
      <div className="admin-list">
        {checks.map((check: any) => (
          <div className="admin-row" key={check.code}>
            <strong>{formatScenario(check.code)}</strong>
            <span><span className={`pill ${check.status === "PASS" ? "good" : check.status === "FAIL" ? "bad" : "warn"}`}>{check.status}</span> Count {check.count ?? 0}</span>
          </div>
        ))}
        {checks.length === 0 ? <p className="reason">Audit checks will load when Module 2 is available on this account.</p> : null}
      </div>
    </Panel>
  );
}

function Module2HealthPanel({ health, onRun }: { health?: any; onRun: () => Promise<void> }) {
  const summary = health?.summary ?? {};
  const issues = health?.issues ?? [];
  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Health Monitor">
      <Metric label="Status" value={summary.status ?? "UNKNOWN"} />
      <Metric label="Candles today" value={summary.candleCount ?? 0} />
      <Metric label="Latest evaluation" value={formatNepalTime(summary.latestEvaluationAt)} />
      <Metric label="Setups today" value={summary.setupCountToday ?? 0} />
      <Metric label="Trades today" value={summary.tradeCountToday ?? 0} />
      <Metric label="Warnings" value={summary.warnings ?? 0} />
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><ShieldCheck size={16} />Run Health Check</button>
      </div>
      <div className="admin-list">
        {issues.slice(0, 6).map((issue: any) => (
          <div className="admin-row" key={issue.code}>
            <strong>{issue.title}</strong>
            <span><span className={`pill ${issue.severity === "CRITICAL" ? "bad" : issue.severity === "HIGH" ? "warn" : "good"}`}>{issue.severity}</span> {issue.body}</span>
          </div>
        ))}
        {issues.length === 0 ? <p className="reason">No Module 2 health warnings right now.</p> : null}
      </div>
      <p className="reason">Action needed: {summary.actionNeeded ?? "None"}</p>
    </Panel>
  );
}

function Module2DataReadinessPanel({
  readiness,
  onBackfill,
  onBacktest
}: {
  readiness?: any;
  onBackfill: () => Promise<void>;
  onBacktest: () => Promise<void>;
}) {
  const state = readiness?.readiness ?? {};
  const coverage = readiness?.nyCoverage ?? [];
  return (
    <Panel icon={<Database />} title="Module 2 Data Readiness">
      <div className="journal-detail-card">
        <div>
          <strong>{state.label ?? "Checking data"}</strong>
          <span>{state.reason ?? "Module 2 needs real 5-minute XAUUSD candles for meaningful backtests."}</span>
        </div>
        <div className="journal-evidence-grid">
          <Metric label="Symbol" value={readiness?.symbol ?? "XAUUSD"} />
          <Metric label="Timeframe" value={`${readiness?.timeframeMinutes ?? 5}M`} />
          <Metric label="Cache candles" value={readiness?.cache?.candleCount ?? 0} />
          <Metric label="PostgreSQL candles" value={readiness?.postgres?.candleCount ?? 0} />
          <Metric label="Cache latest" value={formatNepalTime(readiness?.cache?.latestCandleAt)} />
          <Metric label="DB latest" value={formatNepalTime(readiness?.postgres?.latestCandleAt)} />
          <Metric label="Missing/partial NY days" value={readiness?.missingSessions?.length ?? 0} />
          <Metric label="Backfill estimate" value={`${readiness?.apiEstimate?.estimatedCreditsPerBackfill ?? 1} credit / 100 candles`} />
        </div>
        <div className="admin-actions">
          <button onClick={() => onBackfill().catch(() => undefined)}><Database size={16} />Backfill 100 Candles</button>
          <button onClick={() => onBacktest().catch(() => undefined)}><LineChart size={16} />Run Backtest</button>
        </div>
        <p className="reason">{readiness?.apiEstimate?.note ?? "Backfill uses Twelve Data only when you click the button or during the scheduled NY window."}</p>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>NY Date</th>
              <th>Cache</th>
              <th>PostgreSQL</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {coverage.slice(0, 7).map((row: any) => (
              <tr key={row.sessionDate}>
                <td>{row.sessionDate}</td>
                <td>{row.cacheCount}</td>
                <td>{row.postgresCount}</td>
                <td><span className={`status-pill ${row.status === "READY" ? "good" : row.status === "MISSING" ? "bad" : ""}`}>{row.status}</span></td>
              </tr>
            ))}
            {coverage.length === 0 ? <tr><td colSpan={4}>No Module 2 coverage data yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function OrbDataReadinessPanel({
  readiness,
  onBackfill,
  onBacktest
}: {
  readiness?: any;
  onBackfill: () => Promise<void>;
  onBacktest: () => Promise<void>;
}) {
  const state = readiness?.readiness ?? {};
  const coverage = readiness?.nyCoverage ?? [];
  return (
    <Panel icon={<Database />} title="Module 1 Data Readiness">
      <div className="journal-detail-card">
        <div>
          <strong>{state.label ?? "Checking data"}</strong>
          <span>{state.reason ?? "Module 1 needs 5-minute XAUUSD execution candles to build the 15-minute ORB range and test valid breakouts."}</span>
        </div>
        <div className="journal-evidence-grid">
          <Metric label="Symbol" value={readiness?.symbol ?? "XAUUSD"} />
          <Metric label="Chart/feed timeframe" value={`${readiness?.executionTimeframeMinutes ?? readiness?.timeframeMinutes ?? 5}M`} />
          <Metric label="ORB range" value={`${readiness?.openingRangeMinutes ?? 15} minutes`} />
          <Metric label="Range candles" value={`${readiness?.openingRangeCandleCount ?? 3} x 5M`} />
          <Metric label="Cache candles" value={readiness?.cache?.candleCount ?? 0} />
          <Metric label="PostgreSQL candles" value={readiness?.postgres?.candleCount ?? 0} />
          <Metric label="Cache latest" value={formatNepalTime(readiness?.cache?.latestCandleAt)} />
          <Metric label="DB latest" value={formatNepalTime(readiness?.postgres?.latestCandleAt)} />
          <Metric label="Missing/partial NY days" value={readiness?.missingSessions?.length ?? 0} />
          <Metric label="Backfill estimate" value={`${readiness?.apiEstimate?.estimatedCreditsPerBackfill ?? 1} credit / 100 candles`} />
        </div>
        <div className="admin-actions">
          <button onClick={() => onBackfill().catch(() => undefined)}><Database size={16} />Backfill 100 Candles</button>
          <button onClick={() => onBacktest().catch(() => undefined)}><LineChart size={16} />Run Backtest</button>
        </div>
        <p className="reason">{readiness?.apiEstimate?.note ?? "Backfill uses Twelve Data only when clicked or during the scheduled NY window."}</p>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>NY Date</th>
              <th>Opening</th>
              <th>Signal</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {coverage.slice(0, 7).map((row: any) => (
              <tr key={row.sessionDate}>
                <td>{row.sessionDate}</td>
                <td>{Math.max(row.cacheOpening ?? 0, row.postgresOpening ?? 0)}/{row.expectedOpeningCandles ?? "--"}</td>
                <td>{Math.max(row.cacheSignal ?? 0, row.postgresSignal ?? 0)}</td>
                <td><span className={`status-pill ${row.status === "READY" ? "good" : row.status === "MISSING" ? "bad" : ""}`}>{row.status}</span></td>
              </tr>
            ))}
            {coverage.length === 0 ? <tr><td colSpan={4}>No Module 1 coverage data yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleNotificationSummaryPanel({ summary, notifications }: { summary?: any[]; notifications?: any[] }) {
  const rows = summary ?? [];
  const unread = rows.reduce((sum, row) => sum + Number(row.unread ?? 0), 0);
  const high = rows.reduce((sum, row) => sum + Number(row.highPriority ?? 0), 0);
  const duplicateIssues = rows.reduce((sum, row) => sum + Number(row.duplicateCount ?? 0), 0);
  return (
    <Panel icon={<Bell />} title="Module Alert Command">
      <div className="metrics-grid compact">
        <Metric label="Unread" value={unread} />
        <Metric label="High priority" value={high} />
        <Metric label="Duplicate issues" value={duplicateIssues} />
        <Metric label="Current filter rows" value={notifications?.length ?? 0} />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Total</th>
              <th>Unread</th>
              <th>Signals</th>
              <th>Paper</th>
              <th>Rehearsal</th>
              <th>Lifecycle</th>
              <th>Duplicate Guard</th>
              <th>Latest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any) => (
              <tr key={row.moduleCode}>
                <td>{moduleShortName(row.moduleCode, row.moduleName)}</td>
                <td>{row.total}</td>
                <td>{row.unread}</td>
                <td>{row.signalAlerts}</td>
                <td>{row.paperTradeAlerts}</td>
                <td>{row.rehearsalAlerts}</td>
                <td>{row.lifecycleAlerts}</td>
                <td><span className={`status-pill ${row.duplicateProtected ? "good" : "bad"}`}>{row.duplicateProtected ? "PROTECTED" : `${row.duplicateCount} DUPES`}</span></td>
                <td>{row.latest ? `${row.latest.event_type} · ${formatNepalTime(row.latest.created_at)}` : "--"}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={9}>No notification summary yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="reason">Duplicate guard is backed by unique notification event keys and insert-on-conflict protection in the API.</p>
    </Panel>
  );
}

function NotificationFilters({ filters, onChange, onRefresh }: { filters: any; onChange: (filters: any) => void; onRefresh: () => void }) {
  function update(key: string, value: unknown) {
    onChange({ ...filters, [key]: value });
  }
  return (
    <div className="filter-bar">
      <select value={filters.moduleCode} onChange={(event) => update("moduleCode", event.target.value)}>
        <option value="">All modules</option>
        <option value="high_probability_strategy_2">Module 2</option>
        <option value="strategy_lab_3">Module 3</option>
        <option value="orb_max_options">Module 1 ORB</option>
      </select>
      <select value={filters.priority} onChange={(event) => update("priority", event.target.value)}>
        <option value="">All severity</option>
        <option value="CRITICAL">Critical</option>
        <option value="HIGH">High</option>
        <option value="NORMAL">Normal</option>
      </select>
      <select value={filters.eventType} onChange={(event) => update("eventType", event.target.value)}>
        <option value="">All event types</option>
        <option value="MODULE1_REHEARSAL_TEST">Module 1 rehearsal</option>
        <option value="ORB_REPLAY">Module 1 replay</option>
        <option value="MODULE2_SETUP_READY">Module 2 setup ready</option>
        <option value="MODULE2_REHEARSAL_TEST">Module 2 rehearsal</option>
        <option value="MODULE3_SETUP_READY">Module 3 setup ready</option>
        <option value="MODULE3_REHEARSAL_TEST">Module 3 rehearsal</option>
      </select>
      <label><input type="checkbox" checked={Boolean(filters.unreadOnly)} onChange={(event) => update("unreadOnly", event.target.checked)} /> Unread</label>
      <button onClick={onRefresh}><Bell size={16} />Apply</button>
      <button onClick={() => onChange({ moduleCode: "", priority: "", unreadOnly: false, eventType: "" })}>Clear</button>
    </div>
  );
}

function Module2TuningLabPanel({
  lab,
  history,
  onRun,
  onApply,
  onRollback
}: {
  lab?: any;
  history?: any[];
  onRun: () => Promise<void>;
  onApply: (presetCode: string, qaOnly?: boolean) => Promise<void>;
  onRollback: (promotionId: string) => Promise<void>;
}) {
  const presets = lab?.presets ?? [];
  const recommendation = lab?.recommendation ?? {};
  const selected = presets.find((preset: any) => preset.preset === recommendation.bestPreset) ?? presets[0];
  const failures = selected?.failureAnalytics?.stageCounts ?? {};
  return (
    <Panel icon={<LineChart />} title="Module 2 Tuning Lab">
      <Metric label="Candles" value={lab?.candleCount ?? 0} />
      <Metric label="Best preset" value={recommendation.bestPreset ?? "--"} />
      <Metric label="Safest preset" value={recommendation.safestPreset ?? "--"} />
      <Metric label="Most trades" value={recommendation.mostTradesPreset ?? "--"} />
      <div className="admin-actions">
        <button onClick={() => onRun().catch(() => undefined)}><LineChart size={16} />Run Tuning Lab</button>
      </div>
      {recommendation.sampleSizeWarning ? <p className="reason">{recommendation.sampleSizeWarning}</p> : null}
      <div className="table-wrap">
        <table className="data-table module2-tuning-table">
          <thead>
            <tr>
              <th>Preset</th>
              <th>Trades</th>
              <th>Win rate</th>
              <th>Total R</th>
              <th>Average R</th>
              <th>Max loss streak</th>
              <th>Low-score avoided</th>
              <th>Apply</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((preset: any) => (
              <tr key={preset.preset}>
                <td>{preset.label}</td>
                <td>{preset.summary?.trades ?? 0}</td>
                <td>{formatPercent(preset.summary?.winRate)}</td>
                <td>{formatR(preset.summary?.totalR)}</td>
                <td>{formatR(preset.summary?.averageR)}</td>
                <td>{preset.summary?.maxLossStreak ?? 0}</td>
                <td>{preset.summary?.lowScoreTradesAvoided ?? 0}</td>
                <td>
                  {preset.preset === "custom_current" ? (
                    <span className="pill warn">READ ONLY</span>
                  ) : (
                    <div className="table-actions">
                      <button onClick={() => onApply(preset.preset, false).catch(() => undefined)}>Apply</button>
                      <button onClick={() => onApply(preset.preset, true).catch(() => undefined)}>QA-only</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {presets.length === 0 ? <tr><td colSpan={8}>Run the tuning lab after Module 2 candles are cached.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="journal-evidence-grid">
        <Metric label="Sweep passed, displacement failed" value={failures.sweepPassedDisplacementFailed ?? 0} />
        <Metric label="Displacement passed, BOS failed" value={failures.displacementPassedBosFailed ?? 0} />
        <Metric label="BOS passed, retrace failed" value={failures.bosPassedRetraceFailed ?? 0} />
        <Metric label="Score too low" value={failures.scoreTooLow ?? 0} />
        <Metric label="RR too low" value={failures.rrTooLow ?? 0} />
        <Metric label="Evaluated candles" value={selected?.failureAnalytics?.evaluatedCandles ?? 0} />
      </div>
      <div className="tag-row">
        {(selected?.failureAnalytics?.topFailedRules ?? []).slice(0, 6).map((rule: any) => <span key={rule.ruleCode}>{formatScenario(rule.ruleCode)}: {rule.count}</span>)}
        {!selected?.failureAnalytics?.topFailedRules?.length ? <span>No failure analytics yet</span> : null}
      </div>
      <div className="table-wrap">
        <table className="data-table module2-history-table">
          <thead>
            <tr>
              <th>Applied</th>
              <th>Action</th>
              <th>Preset</th>
              <th>Mode</th>
              <th>Reason</th>
              <th>Rollback</th>
            </tr>
          </thead>
          <tbody>
            {(history ?? []).slice(0, 8).map((item: any) => (
              <tr key={item.id}>
                <td>{formatNepalTime(item.applied_at)}</td>
                <td>{formatScenario(item.action)}</td>
                <td>{item.preset_code}</td>
                <td>{item.qa_only ? "QA-only" : "Production"}</td>
                <td>{item.reason ?? "--"}</td>
                <td>{item.action === "APPLY_PRESET" ? <button onClick={() => onRollback(item.id).catch(() => undefined)}>Rollback</button> : "--"}</td>
              </tr>
            ))}
            {(history ?? []).length === 0 ? <tr><td colSpan={6}>No Module 2 tuning promotions yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ModuleStrategyPanel({ setup, moduleCode, moduleName }: { setup?: any; moduleCode: string; moduleName: string }) {
  const flags = setup?.scenario_flags ?? {};
  if (moduleCode === "strategy_lab_3") {
    const zone = flags.entryZone ?? {};
    const drive = flags.drive ?? {};
    return (
      <Panel icon={<Database />} title={moduleShortName(moduleCode, moduleName)}>
        <Metric label="Current state" value={String(flags.state ?? setup?.status ?? "WAITING")} />
        <Metric label="Candidate direction" value={setup?.direction ?? "--"} />
        <Metric label="Paper entry" value={setup?.status === "PAPER_TRADE_OPENED" ? "OPEN" : "NOT OPENED"} />
        <Metric label="Score" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/100 ${setup.favorability_grade ?? ""}`} />
        <Metric label="Opening drive" value={drive?.high == null ? "--" : `${Number(drive.low).toFixed(2)}-${Number(drive.high).toFixed(2)}`} />
        <Metric label="VWAP" value={flags.vwap == null ? "--" : Number(flags.vwap).toFixed(2)} />
        <Metric label="EMA" value={flags.ema == null ? "--" : Number(flags.ema).toFixed(2)} />
        <Metric label="Pullback zone" value={zone?.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`} />
        <Metric label="Risk reward" value={flags.riskReward == null ? "--" : `${Number(flags.riskReward).toFixed(2)}R`} />
        <div className="tag-row">
          {(setup?.favorability_reasons ?? []).length > 0
            ? setup.favorability_reasons.map((reason: string) => <span key={reason}>{reason}</span>)
            : <span>Waiting for Module 3 NY opening-drive, VWAP pullback, and confirmation evidence</span>}
        </div>
      </Panel>
    );
  }
  const zone = flags.entryZone ?? {};
  const sweep = flags.sweep ?? {};
  const bos = flags.bos ?? {};
  return (
    <Panel icon={<Database />} title={moduleShortName(moduleCode, moduleName)}>
      <Metric label="Current state" value={String(flags.state ?? setup?.status ?? "WAITING")} />
      <Metric label="Candidate direction" value={setup?.direction ?? "--"} />
      <Metric label="Paper entry" value={setup?.status === "PAPER_TRADE_OPENED" ? "OPEN" : "NOT OPENED"} />
      <Metric label="Score" value={setup?.favorability_score == null ? "--" : `${setup.favorability_score}/110 ${setup.favorability_grade ?? ""}`} />
      <Metric label="Bias" value={flags.htfBias ?? "--"} />
      <Metric label="Liquidity" value={sweep?.level?.type ?? "--"} />
      <Metric label="Sweep level" value={sweep?.level?.price == null ? "--" : Number(sweep.level.price).toFixed(2)} />
      <Metric label="BOS level" value={bos?.level == null ? "--" : Number(bos.level).toFixed(2)} />
      <Metric label="Entry zone" value={zone?.low == null ? "--" : `${Number(zone.low).toFixed(2)}-${Number(zone.high).toFixed(2)}`} />
      <Metric label="Risk reward" value={flags.riskReward == null ? "--" : `${Number(flags.riskReward).toFixed(2)}R`} />
      <div className="tag-row">
        {(setup?.favorability_reasons ?? []).length > 0
          ? setup.favorability_reasons.map((reason: string) => <span key={reason}>{reason}</span>)
          : <span>Waiting for Module 2 liquidity sweep + BOS evidence</span>}
      </div>
    </Panel>
  );
}

function ScenarioStatsPanel({ state }: { state: PanelState }) {
  return (
    <Panel icon={<LineChart />} title="Scenario Stats">
      <div className="admin-list">
        {(state.orbAdmin?.byScenario ?? []).slice(0, 8).map((row: any) => (
          <div className="admin-row" key={`${row.scenario}-${row.direction}`}>
            <strong>{row.direction} · {formatScenario(row.scenario)}</strong>
            <span>{row.trades} trades · {formatPercent(row.winRate)} win · {formatR(row.total_r)}R</span>
          </div>
        ))}
        {(state.orbAdmin?.byScenario ?? []).length === 0 ? <p className="reason">Scenario performance will populate after this module closes real paper trades.</p> : null}
      </div>
    </Panel>
  );
}

function DataAdminPanel({ state, refresh, runCacheBacktest, clearLiveCache, clearTestSignals }: { state: PanelState; refresh: () => Promise<void>; runCacheBacktest: () => Promise<void>; clearLiveCache: () => Promise<void>; clearTestSignals: () => Promise<void> }) {
  return (
    <Panel icon={<Database />} title="Data Admin">
      <Metric label="Twelve Data" value={state.twelveStatus?.configured === false ? "API KEY MISSING" : state.twelveStatus?.running ? "RUNNING" : "STOPPED"} />
      <Metric label="Raw DB candles" value={state.twelveStatus?.persistRawCandles === false ? "OFF" : "ON"} />
      <Metric label="Candle store" value={`${state.cacheStatus?.cachedCandles ?? state.twelveStatus?.cachedCandles ?? 0}/${state.cacheStatus?.cacheLimit ?? "--"}`} />
      <Metric label="Cache retention" value={state.cacheStatus?.cacheDays ? `${state.cacheStatus.cacheDays} days` : "--"} />
      <Metric label="Startup request" value={`${state.twelveStatus?.startupBackfillCount ?? "--"} candles`} />
      <Metric label="Minute request" value={`${state.twelveStatus?.livePollCount ?? "--"} candles`} />
      <Metric label="Last requested" value={state.twelveStatus?.lastRequestedCount ?? "--"} />
      <Metric label="Last cached" value={state.twelveStatus?.lastImported ?? "--"} />
      <Metric label="Last sync" value={formatNepalTime(state.twelveStatus?.lastSyncAt)} />
      <Metric label="Latest cached" value={formatNepalTime(state.cacheStatus?.latestCandle?.timestampUtc)} />
      <Metric label="Last error" value={state.twelveStatus?.lastError ?? "--"} />
      <div className="admin-actions">
        <button onClick={() => refresh().catch(() => undefined)}><LineChart size={16} />Refresh</button>
        <button onClick={() => runCacheBacktest().catch(() => undefined)}><LineChart size={16} />Backtest</button>
        <button onClick={() => clearLiveCache().catch(() => undefined)}><Trash2 size={16} />Clear Cache</button>
        <button onClick={() => clearTestSignals().catch(() => undefined)}><Trash2 size={16} />Clear Replay</button>
      </div>
    </Panel>
  );
}

function AccountLockedPanel({ state, subscriptionActive }: { state: PanelState; subscriptionActive: boolean }) {
  return (
    <Panel icon={<Lock />} title={subscriptionActive ? "Module Locked" : "Subscription Inactive"}>
      <p className="reason">
        {subscriptionActive
          ? "Module 1: ORB MAX Options Strategy is not enabled on this account. Trading tools stay locked until the module is assigned."
          : "This subscription is not active. Live chart, ORB signals, paper trading, reports, and notifications are locked until billing is restored."}
      </p>
      <Metric label="Plan" value={state.tenantContext?.subscription?.plan_name ?? "--"} />
      <Metric label="Subscription" value={state.tenantContext?.subscription?.status ?? "--"} />
      <Metric label="Account" value={state.tenantContext?.tenant?.status ?? "--"} />
    </Panel>
  );
}

function MyAccountPanel({
  state,
  user,
  onCheckout,
  onCreateTicket,
  onSavePushPreferences,
  onDisablePushDevice,
  onStartMfa,
  onEnableMfa,
  onDisableMfa
}: {
  state: PanelState;
  user: AdminUser;
  onCheckout: (planCode: string, mode: "SUBSCRIPTION" | "RENEWAL") => Promise<void>;
  onCreateTicket: (input: { ticketType: string; title: string; description: string; requestedModuleCode?: string | null }) => Promise<void>;
  onSavePushPreferences: (preferences: any) => Promise<void>;
  onDisablePushDevice: (deviceId: string) => Promise<void>;
  onStartMfa: () => Promise<{ secret: string; otpAuthUrl: string }>;
  onEnableMfa: (otp: string) => Promise<void>;
  onDisableMfa: (otp: string) => Promise<void>;
}) {
  const tenant = state.tenantContext?.tenant ?? {};
  const subscription = state.tenantContext?.subscription ?? {};
  const latestCheckout = state.tenantContext?.latestCheckoutSession;
  const invoices = state.tenantContext?.invoices ?? [];
  const supportInfo = state.tenantContext?.supportInfo ?? {};
  const supportTickets = state.tenantContext?.supportTickets ?? [];
  const modules = state.tenantContext?.availableModules ?? state.tenantContext?.modules ?? [];
  const currentPlan = subscription.plan_code ?? "starter_orb";
  const upgradePlan = currentPlan === "starter_orb" ? "professional_multi_strategy" : "enterprise_platform";
  const [ticketType, setTicketType] = useState("TECHNICAL");
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [requestedModuleCode, setRequestedModuleCode] = useState("");

  async function submitTicket() {
    await onCreateTicket({
      ticketType,
      title: ticketTitle.trim() || ticketType.replaceAll("_", " "),
      description: ticketDescription,
      requestedModuleCode: ticketType === "MODULE_UPGRADE" ? requestedModuleCode || null : null
    });
    setTicketTitle("");
    setTicketDescription("");
    setRequestedModuleCode("");
  }

  return (
    <Panel icon={<CreditCard />} title="My Account">
      <Metric label="Name" value={user.displayName ?? tenant.name ?? "--"} />
      <Metric label="Email" value={user.email ?? tenant.owner_email ?? "--"} />
      <Metric label="Account status" value={tenant.status ?? "--"} />
      <Metric label="Plan" value={subscription.plan_name ?? "--"} />
      <Metric label="Subscription" value={subscription.status ?? "--"} />
      <Metric label="Billing" value={subscription.price_usd == null ? "--" : `$${Number(subscription.price_usd).toFixed(0)}/${String(subscription.billing_period ?? "MONTHLY").toLowerCase()}`} />
      <Metric label="Provider" value={subscription.plan_provider_code ?? subscription.provider_code ?? "manual"} />
      <Metric label="Renews" value={formatNepalTime(subscription.renews_at)} />
      <Metric label="Last login" value="Current session" />
      <Metric label="Manual request" value={latestCheckout ? `${latestCheckout.status} · ${latestCheckout.checkout_url}` : "None"} />
      <div className="manual-payment-note">
        <strong>Manual payment flow</strong>
        <span>Request renewal or upgrade here. Platform Admin reviews the request, records payment status, and your subscription updates automatically.</span>
      </div>
      <div className="manual-payment-note">
        <strong>Support</strong>
        <span>{supportInfo.helpText ?? "Contact support for account, billing, notification, or signal help."}</span>
        <span>Phone: {supportInfo.supportPhone ?? "--"} · Email: {supportInfo.supportEmail ?? "--"}</span>
        <span>Address: {supportInfo.businessAddress ?? "--"} · Hours: {supportInfo.supportHours ?? "--"}</span>
      </div>
      <div className="manual-payment-note">
        <strong>Create Support Ticket</strong>
        <span>Send account, password, billing, module upgrade, or technical requests to the platform admin team.</span>
        <label>Request type
          <select value={ticketType} onChange={(event) => setTicketType(event.target.value)}>
            {["TECHNICAL", "FORGOT_PASSWORD", "MODULE_UPGRADE", "BILLING", "GENERAL"].map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        {ticketType === "MODULE_UPGRADE" ? (
          <label>Requested module
            <select value={requestedModuleCode} onChange={(event) => setRequestedModuleCode(event.target.value)}>
              <option value="">Select module</option>
              {modules.map((module: any) => <option key={module.code} value={module.code}>{module.name}</option>)}
            </select>
          </label>
        ) : null}
        <label>Title<input value={ticketTitle} onChange={(event) => setTicketTitle(event.target.value)} placeholder="Short request title" /></label>
        <label>Details<textarea value={ticketDescription} onChange={(event) => setTicketDescription(event.target.value)} placeholder="Explain what you need help with" /></label>
        <button disabled={!ticketTitle.trim() && !ticketDescription.trim()} onClick={() => submitTicket().catch(() => undefined)}><FileText size={16} />Submit Ticket</button>
      </div>
      <div className="account-actions">
        <button onClick={() => onCheckout(currentPlan, "RENEWAL").catch(() => undefined)}><CreditCard size={16} />Request Renewal</button>
        <button onClick={() => onCheckout(upgradePlan, "SUBSCRIPTION").catch(() => undefined)}><Layers size={16} />Request Upgrade</button>
      </div>
      <MfaSettingsPanel user={user} onStart={onStartMfa} onEnable={onEnableMfa} onDisable={onDisableMfa} />
      <div className="admin-list">
        {supportTickets.slice(0, 5).map((ticket: any) => (
          <div className="admin-row" key={ticket.id}>
            <strong>{ticket.title}</strong>
            <span>{ticket.ticket_type} · {ticket.status} · {ticket.priority} · {formatNepalTime(ticket.created_at)}</span>
          </div>
        ))}
        {supportTickets.length === 0 ? <p className="reason">No support tickets submitted yet.</p> : null}
      </div>
      <div className="admin-list">
        {invoices.slice(0, 4).map((invoice: any) => (
          <div className="admin-row" key={invoice.id}>
            <strong>{invoice.invoice_number}</strong>
            <span>{invoice.status} · {invoice.plan_name ?? "--"} · {formatCurrency(invoice.amount_due_usd)} · Due {formatNepalTime(invoice.due_at)}</span>
          </div>
        ))}
        {invoices.length === 0 ? <p className="reason">No invoices yet.</p> : null}
      </div>
      <TenantPushSettingsPanel status={state.tenantPushStatus} onSave={onSavePushPreferences} onDisableDevice={onDisablePushDevice} />
    </Panel>
  );
}

function MfaSettingsPanel({
  user,
  onStart,
  onEnable,
  onDisable
}: {
  user: AdminUser;
  onStart: () => Promise<{ secret: string; otpAuthUrl: string }>;
  onEnable: (otp: string) => Promise<void>;
  onDisable: (otp: string) => Promise<void>;
}) {
  const [setup, setSetup] = useState<{ secret: string; otpAuthUrl: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setMessage("");
    try {
      const next = await onStart();
      setSetup(next);
      setQrDataUrl(await QRCode.toDataURL(next.otpAuthUrl, { margin: 1, width: 220, color: { dark: "#07100c", light: "#f4f7f4" } }));
      setMessage("Add the secret to your authenticator app, then verify the 6-digit code.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
    setBusy(true);
    setMessage("");
    try {
      await onEnable(otp);
      setSetup(null);
      setOtp("");
      setMessage("Two-factor authentication enabled.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!window.confirm("Disable two-factor authentication for this account?")) return;
    setBusy(true);
    setMessage("");
    try {
      await onDisable(otp);
      setOtp("");
      setMessage("Two-factor authentication disabled.");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-payment-note">
      <strong>Two-Factor Authentication</strong>
      <span>{user.mfaEnabled ? "Enabled. Login requires a 6-digit authenticator code." : "Not enabled. Add an authenticator app for stronger account security."}</span>
      {setup ? (
        <>
          {qrDataUrl ? (
            <div className="mfa-qr-wrap compact">
              <img src={qrDataUrl} alt="Scan this QR code in your authenticator app" />
              <span>Scan with Google Authenticator</span>
            </div>
          ) : null}
          <label>Secret<input readOnly value={setup.secret} onFocus={(event) => event.currentTarget.select()} /></label>
          <label>Authenticator URL<textarea readOnly value={setup.otpAuthUrl} onFocus={(event) => event.currentTarget.select()} /></label>
        </>
      ) : null}
      <label>6-digit code<input value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" /></label>
      <div className="account-actions">
        {!user.mfaEnabled ? <button disabled={busy} onClick={() => start().catch(() => undefined)}><ShieldCheck size={16} />Start 2FA Setup</button> : null}
        {!user.mfaEnabled && setup ? <button disabled={busy || otp.length !== 6} onClick={() => enable().catch(() => undefined)}><CheckCircle2 size={16} />Verify and Enable</button> : null}
        {user.mfaEnabled ? <button disabled={busy || otp.length !== 6} onClick={() => disable().catch(() => undefined)}><Lock size={16} />Disable 2FA</button> : null}
      </div>
      {message ? <span>{message}</span> : null}
    </div>
  );
}

function TenantPushSettingsPanel({ status, onSave, onDisableDevice }: { status: any; onSave: (preferences: any) => Promise<void>; onDisableDevice: (deviceId: string) => Promise<void> }) {
  const [preferences, setPreferences] = useState<Record<string, boolean>>({ ...DEFAULT_PUSH_PREFERENCES, ...(status?.preferences ?? {}) });
  useEffect(() => {
    setPreferences({ ...DEFAULT_PUSH_PREFERENCES, ...(status?.preferences ?? {}) });
  }, [status?.preferences]);
  const rows = [
    ["nyPreSession", "NY pre-session reminder"],
    ["validEntries", "Valid buy/sell entries"],
    ["paperTradeOpened", "Paper trade opened"],
    ["takeProfitStopLoss", "TP / SL closeouts"],
    ["dailyReports", "Daily reports"],
    ["weeklyMonthlyReports", "Weekly / monthly reports"],
    ["learningReviews", "Learning reviews"],
    ["systemDiagnostics", "System diagnostics"]
  ];
  return (
    <div className="manual-payment-note">
      <strong>Mobile Push Notifications</strong>
      <span>{status?.registered ? `${status.activeDevices} active device(s) registered.` : "No mobile device registered yet. Register from the mobile app first."}</span>
      <div className="settings-list compact">
        {rows.map(([key, label]) => (
          <label key={key} className="setting-row">
            <span>{label}</span>
            <input
              type="checkbox"
              checked={Boolean((preferences as any)[key])}
              onChange={(event) => setPreferences((previous) => ({ ...previous, [key]: event.target.checked }))}
            />
          </label>
        ))}
      </div>
      <button onClick={() => onSave(preferences).catch(() => undefined)}><Bell size={16} />Save Push Preferences</button>
      <div className="admin-list">
        {(status?.devices ?? []).map((device: any) => (
          <div className="admin-row" key={device.id}>
            <strong>{device.deviceName ?? "Mobile device"} · {device.provider ?? "--"}</strong>
            <span>{device.platform ?? "--"} · Firebase {device.hasFcmToken ? "yes" : "no"} · Expo {device.hasExpoToken ? "yes" : "no"} · Last seen {formatNepalTime(device.lastSeenAt)}</span>
            {device.enabled ? <button onClick={() => onDisableDevice(device.id).catch(() => undefined)}><Trash2 size={14} />Disable</button> : <em>Disabled</em>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountModulesPanel({ state }: { state: PanelState }) {
  const subscriptionActive = ["TRIAL", "ACTIVE"].includes(String(state.tenantContext?.subscription?.status ?? "ACTIVE"));
  const modules = state.tenantContext?.availableModules ?? state.tenantContext?.modules ?? [];
  return (
    <Panel icon={<Layers />} title="Modules">
      <div className="account-module-list">
        {modules.map((module: any) => {
          const enabled = subscriptionActive && module.plan_included !== false && module.tenant_module_status === "ENABLED";
          const status = enabled ? "ACTIVE" : module.plan_included === false ? "UPGRADE REQUIRED" : module.tenant_module_status ? module.tenant_module_status : "COMING SOON";
          return (
            <div className="account-module-row" key={module.code}>
              <div>
                <strong>{module.name}</strong>
                <span>{module.description}</span>
                <em>{module.target_win_rate ?? "Research pending"}</em>
              </div>
              <span className={`pill ${enabled ? "good" : module.plan_included === false ? "warn" : "bad"}`}>{status}</span>
            </div>
          );
        })}
        {modules.length === 0 ? <p className="reason">No modules are available for this account yet.</p> : null}
      </div>
    </Panel>
  );
}

function PasswordPlaceholderPanel() {
  return (
    <Panel icon={<KeyRound />} title="Password">
      <Metric label="Password change" value="Coming soon" />
      <p className="reason">Password reset and email verification will be connected when the account email service is added.</p>
    </Panel>
  );
}

function SettingsEditor({ settings, onUpdate }: { settings: any[]; onUpdate: (key: string, value: unknown) => Promise<void> }) {
  return (
    <Panel icon={<Settings />} title="Account Settings">
      <div className="settings-list">
        {settings.map((setting) => (
          <SettingControl key={setting.key} setting={setting} onUpdate={onUpdate} />
        ))}
        {settings.length === 0 ? <p className="reason">Settings will appear after the admin security migration is applied.</p> : null}
      </div>
    </Panel>
  );
}

function PlanUsagePanel({ state }: { state: PanelState }) {
  const usage = state.tenantContext?.usage ?? {};
  const subscription = state.tenantContext?.subscription ?? {};
  return (
    <Panel icon={<CreditCard />} title="Plan Usage">
      <Metric label="Plan" value={subscription.plan_name ?? "--"} />
      <Metric label="Subscription" value={subscription.status ?? "--"} />
      <Metric label="Subscriber account" value="1 login" />
      <Metric label="Notifications month" value={`${usage.notifications_used_this_month ?? 0}/${usage.max_notifications_per_month ?? "Unlimited"}`} />
      <Metric label="Report history" value={usage.max_report_history_months == null ? "Unlimited" : `${usage.max_report_history_months} months`} />
      <Metric label="Automation included" value={usage.automation_included === false ? "NO" : "YES"} />
    </Panel>
  );
}

function OrbStrategySettings({ settings, onUpdate }: { settings: any[]; onUpdate: (key: string, value: unknown) => Promise<void> }) {
  const setting = settings.find((item) => item.key === "orb.strategy");
  const [draft, setDraft] = useState<any>(setting?.value ?? {});

  useEffect(() => {
    setDraft(setting?.value ?? {});
  }, [setting?.value]);

  function patch(path: string, value: unknown) {
    const keys = path.split(".");
    setDraft((current: any) => {
      const next = { ...(current ?? {}) };
      let cursor = next;
      for (const key of keys.slice(0, -1)) {
        cursor[key] = { ...(cursor[key] ?? {}) };
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = value;
      return next;
    });
  }

  return (
    <Panel icon={<ShieldCheck />} title="ORB Strategy Config">
      <div className="setting-row strategy-setting-row">
        <div>
          <strong>orb.strategy</strong>
          <span>{setting?.description ?? "User-account ORB MAX rule thresholds."}</span>
          <em>{setting?.updated_at ? `Updated ${formatNepalTime(setting.updated_at)}` : "Using strategy defaults"}</em>
        </div>
        <div className="setting-fields strategy-fields">
          <label>Minimum body ratio<input type="number" min="0" max="1" step="0.01" value={draft?.breakout?.minimumBodyRatio ?? 0.45} onChange={(event) => patch("breakout.minimumBodyRatio", Number(event.target.value))} /></label>
          <label>Close location ratio<input type="number" min="0" max="1" step="0.01" value={draft?.breakout?.minimumCloseLocationRatio ?? 0.6} onChange={(event) => patch("breakout.minimumCloseLocationRatio", Number(event.target.value))} /></label>
          <label>Max extension<input type="number" min="0" max="1" step="0.01" value={draft?.breakout?.maximumEntryExtensionPercentOfRange ?? 0.25} onChange={(event) => patch("breakout.maximumEntryExtensionPercentOfRange", Number(event.target.value))} /></label>
          <label>Retest zone<input type="number" min="0" max="1" step="0.01" value={draft?.retest?.zonePercentOfRange ?? 0.1} onChange={(event) => patch("retest.zonePercentOfRange", Number(event.target.value))} /></label>
          <label>Retest candles<input type="number" min="1" max="50" value={draft?.retest?.maximumCandles ?? 4} onChange={(event) => patch("retest.maximumCandles", Number(event.target.value))} /></label>
          <label>Min favorability<input type="number" min="1" max="100" value={draft?.favorability?.minimumScoreForPaperTrade ?? 70} onChange={(event) => patch("favorability.minimumScoreForPaperTrade", Number(event.target.value))} /></label>
          <label>Minimum R:R<input type="number" min="0.1" max="10" step="0.1" value={draft?.risk?.minimumRewardToRisk ?? 2} onChange={(event) => patch("risk.minimumRewardToRisk", Number(event.target.value))} /></label>
          <label>Max session trades<input type="number" min="1" max="20" value={draft?.risk?.maximumTradesPerSession ?? 1} onChange={(event) => { patch("risk.maximumTradesPerSession", Number(event.target.value)); patch("paperTrading.maximumTradesPerSession", Number(event.target.value)); }} /></label>
          <label><input type="checkbox" checked={draft?.retest?.enabled !== false} onChange={(event) => patch("retest.enabled", event.target.checked)} /> Retest scenarios</label>
          <label><input type="checkbox" checked={draft?.paperTrading?.enabled !== false} onChange={(event) => patch("paperTrading.enabled", event.target.checked)} /> Automatic paper trades</label>
        </div>
        <button onClick={() => onUpdate("orb.strategy", draft).catch(() => undefined)}>Save Strategy</button>
      </div>
    </Panel>
  );
}

function LiquiditySweepSettings({ settings, onUpdate }: { settings: any[]; onUpdate: (key: string, value: unknown) => Promise<void> }) {
  const setting = settings.find((item) => item.key === "liquiditySweep.strategy");
  const [draft, setDraft] = useState<any>(setting?.value ?? {});

  useEffect(() => {
    setDraft(setting?.value ?? {});
  }, [setting?.value]);

  function patch(path: string, value: unknown) {
    const keys = path.split(".");
    setDraft((current: any) => {
      const next = { ...(current ?? {}) };
      let cursor = next;
      for (const key of keys.slice(0, -1)) {
        cursor[key] = { ...(cursor[key] ?? {}) };
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = value;
      return next;
    });
  }

  return (
    <Panel icon={<ShieldCheck />} title="Module 2 Strategy Config">
      <div className="setting-row strategy-setting-row">
        <div>
          <strong>liquiditySweep.strategy</strong>
          <span>{setting?.description ?? "XAUUSD NY liquidity sweep + BOS thresholds."}</span>
          <em>{setting?.updated_at ? `Updated ${formatNepalTime(setting.updated_at)}` : "Using Module 2 defaults"}</em>
          <p className="reason">Settings are locked during the live NY window. Any change requires a fresh launch rehearsal before trusting Module 2 signals.</p>
        </div>
        <div className="setting-fields strategy-fields">
          <label>NY start<input type="time" value={draft?.newYorkStartTime ?? "09:30"} onChange={(event) => patch("newYorkStartTime", event.target.value)} /></label>
          <label>NY end<input type="time" value={draft?.newYorkEndTime ?? "12:00"} onChange={(event) => patch("newYorkEndTime", event.target.value)} /></label>
          <label>Min sweep ATR<input type="number" min="0.01" max="5" step="0.01" value={draft?.minimumSweepDistanceATR ?? 0.1} onChange={(event) => patch("minimumSweepDistanceATR", Number(event.target.value))} /></label>
          <label>Max sweep ATR<input type="number" min="0.1" max="10" step="0.01" value={draft?.maximumSweepDistanceATR ?? 1} onChange={(event) => patch("maximumSweepDistanceATR", Number(event.target.value))} /></label>
          <label>Displacement ATR<input type="number" min="0.1" max="5" step="0.05" value={draft?.minimumDisplacementRangeATR ?? 1.2} onChange={(event) => patch("minimumDisplacementRangeATR", Number(event.target.value))} /></label>
          <label>Body %<input type="number" min="0" max="1" step="0.01" value={draft?.minimumBodyPercentage ?? 0.6} onChange={(event) => patch("minimumBodyPercentage", Number(event.target.value))} /></label>
          <label>BOS close ATR<input type="number" min="0.01" max="2" step="0.01" value={draft?.minimumBosCloseDistanceATR ?? 0.05} onChange={(event) => patch("minimumBosCloseDistanceATR", Number(event.target.value))} /></label>
          <label>Entry timeout<input type="number" min="1" max="50" value={draft?.maximumBarsAfterBosForEntry ?? 15} onChange={(event) => patch("maximumBarsAfterBosForEntry", Number(event.target.value))} /></label>
          <label>Min FVG ATR<input type="number" min="0.01" max="5" step="0.01" value={draft?.minimumFvgSizeATR ?? 0.1} onChange={(event) => patch("minimumFvgSizeATR", Number(event.target.value))} /></label>
          <label>Minimum R:R<input type="number" min="0.5" max="10" step="0.1" value={draft?.minimumRiskReward ?? 2} onChange={(event) => patch("minimumRiskReward", Number(event.target.value))} /></label>
          <label>Max spread<input type="number" min="0.01" max="20" step="0.01" value={draft?.maximumSpread ?? 0.8} onChange={(event) => patch("maximumSpread", Number(event.target.value))} /></label>
          <label>Max trades<input type="number" min="1" max="10" value={draft?.maximumTradesPerSession ?? 1} onChange={(event) => { patch("maximumTradesPerSession", Number(event.target.value)); patch("paperTrading.maximumTradesPerSession", Number(event.target.value)); }} /></label>
          <label><input type="checkbox" checked={draft?.enableNewsFilter !== false} onChange={(event) => patch("enableNewsFilter", event.target.checked)} /> News filter</label>
          <label><input type="checkbox" checked={draft?.paperTrading?.enabled !== false} onChange={(event) => patch("paperTrading.enabled", event.target.checked)} /> Automatic paper trades</label>
        </div>
        <button onClick={() => onUpdate("liquiditySweep.strategy", draft).catch(() => undefined)}>Save Module 2</button>
      </div>
    </Panel>
  );
}

function VwapOpeningDriveSettings({ settings, onUpdate }: { settings: any[]; onUpdate: (key: string, value: unknown) => Promise<void> }) {
  const setting = settings.find((item) => item.key === "vwapOpeningDrive.strategy");
  const [draft, setDraft] = useState<any>(setting?.value ?? {});

  useEffect(() => {
    setDraft(setting?.value ?? {});
  }, [setting?.value]);

  function patch(path: string, value: unknown) {
    const keys = path.split(".");
    setDraft((current: any) => {
      const next = { ...(current ?? {}) };
      let cursor = next;
      for (const key of keys.slice(0, -1)) {
        cursor[key] = { ...(cursor[key] ?? {}) };
        cursor = cursor[key];
      }
      cursor[keys[keys.length - 1]] = value;
      return next;
    });
  }

  return (
    <Panel icon={<ShieldCheck />} title="Module 3 Strategy Config">
      <div className="setting-row strategy-setting-row">
        <div>
          <strong>vwapOpeningDrive.strategy</strong>
          <span>{setting?.description ?? "XAUUSD NY VWAP opening-drive pullback thresholds."}</span>
          <em>{setting?.updated_at ? `Updated ${formatNepalTime(setting.updated_at)}` : "Using Module 3 defaults"}</em>
          <p className="reason">Module 3 is independent from ORB and Sweep+BOS. These settings affect only VWAP opening-drive paper signals.</p>
        </div>
        <div className="setting-fields strategy-fields">
          <label>NY start<input type="time" value={draft?.newYorkStartTime ?? "09:30"} onChange={(event) => patch("newYorkStartTime", event.target.value)} /></label>
          <label>NY end<input type="time" value={draft?.newYorkEndTime ?? "12:00"} onChange={(event) => patch("newYorkEndTime", event.target.value)} /></label>
          <label>Opening drive min<input type="number" min="5" max="90" value={draft?.openingDriveMinutes ?? 30} onChange={(event) => patch("openingDriveMinutes", Number(event.target.value))} /></label>
          <label>Drive ATR<input type="number" min="0.1" max="5" step="0.05" value={draft?.minimumDriveRangeATR ?? 1} onChange={(event) => patch("minimumDriveRangeATR", Number(event.target.value))} /></label>
          <label>Drive body %<input type="number" min="0" max="1" step="0.01" value={draft?.minimumDriveBodyPercent ?? 0.55} onChange={(event) => patch("minimumDriveBodyPercent", Number(event.target.value))} /></label>
          <label>VWAP distance ATR<input type="number" min="0" max="2" step="0.01" value={draft?.minimumVwapDistanceATR ?? 0.05} onChange={(event) => patch("minimumVwapDistanceATR", Number(event.target.value))} /></label>
          <label>Pullback bars<input type="number" min="1" max="40" value={draft?.pullbackMaxBars ?? 12} onChange={(event) => patch("pullbackMaxBars", Number(event.target.value))} /></label>
          <label>Zone ATR<input type="number" min="0.01" max="2" step="0.01" value={draft?.pullbackZoneAtr ?? 0.35} onChange={(event) => patch("pullbackZoneAtr", Number(event.target.value))} /></label>
          <label>Confirm body %<input type="number" min="0" max="1" step="0.01" value={draft?.confirmationBodyPercent ?? 0.45} onChange={(event) => patch("confirmationBodyPercent", Number(event.target.value))} /></label>
          <label>EMA period<input type="number" min="5" max="200" value={draft?.emaPeriod ?? 20} onChange={(event) => patch("emaPeriod", Number(event.target.value))} /></label>
          <label>Minimum R:R<input type="number" min="0.5" max="10" step="0.1" value={draft?.minimumRiskReward ?? 2} onChange={(event) => patch("minimumRiskReward", Number(event.target.value))} /></label>
          <label>Max stop ATR<input type="number" min="0.1" max="10" step="0.05" value={draft?.maximumStopATR ?? 1.35} onChange={(event) => patch("maximumStopATR", Number(event.target.value))} /></label>
          <label>Max spread<input type="number" min="0.01" max="20" step="0.01" value={draft?.maximumSpread ?? 0.8} onChange={(event) => patch("maximumSpread", Number(event.target.value))} /></label>
          <label>Min score<input type="number" min="1" max="100" value={draft?.minimumSignalScore ?? 80} onChange={(event) => patch("minimumSignalScore", Number(event.target.value))} /></label>
          <label>Max trades<input type="number" min="1" max="10" value={draft?.maximumTradesPerSession ?? 1} onChange={(event) => { patch("maximumTradesPerSession", Number(event.target.value)); patch("paperTrading.maximumTradesPerSession", Number(event.target.value)); }} /></label>
          <label><input type="checkbox" checked={draft?.enableNewsFilter !== false} onChange={(event) => patch("enableNewsFilter", event.target.checked)} /> News filter</label>
          <label><input type="checkbox" checked={draft?.paperTrading?.enabled !== false} onChange={(event) => patch("paperTrading.enabled", event.target.checked)} /> Automatic paper trades</label>
        </div>
        <button onClick={() => onUpdate("vwapOpeningDrive.strategy", draft).catch(() => undefined)}>Save Module 3</button>
      </div>
    </Panel>
  );
}

function SettingControl({ setting, onUpdate }: { setting: any; onUpdate: (key: string, value: unknown) => Promise<void> }) {
  const [draft, setDraft] = useState<any>(setting.value);

  useEffect(() => {
    setDraft(setting.value);
  }, [setting.value, setting.key]);

  async function save(nextValue = draft) {
    await onUpdate(setting.key, nextValue);
  }

  return (
    <div className="setting-row">
      <div>
        <strong>{setting.key}</strong>
        <span>{setting.category} · {setting.description ?? "No description"}</span>
      </div>
      <div className="setting-control">
        {setting.key === "trading.symbol" ? (
          <input value={draft ?? ""} onChange={(event) => setDraft(event.target.value.toUpperCase())} />
        ) : null}
        {setting.key === "trading.timeframeMinutes" ? (
          <select value={Number(draft ?? 15)} onChange={(event) => setDraft(Number(event.target.value))}>
            {[1, 5, 15, 30, 45, 60].map((value) => <option key={value} value={value}>{value} minutes</option>)}
          </select>
        ) : null}
        {setting.key === "trading.paperTrading" ? (
          <div className="toggle-grid">
            <label><input type="checkbox" checked={Boolean(draft?.enabled)} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked, brokerExecution: false })} /> Paper trading</label>
            <label><input type="checkbox" checked={false} disabled /> External execution locked off</label>
          </div>
        ) : null}
        {setting.key === "orb.session" ? (
          <div className="setting-fields">
            <label>Session start<input type="time" value={draft?.sessionStart ?? "09:15"} onChange={(event) => setDraft({ ...draft, sessionStart: event.target.value })} /></label>
            <label>Trade window end<input type="time" value={draft?.tradeWindowEnd ?? "16:00"} onChange={(event) => setDraft({ ...draft, tradeWindowEnd: event.target.value })} /></label>
            <label>Opening range<input type="number" min="1" max="240" value={draft?.openingRangeMinutes ?? 15} onChange={(event) => setDraft({ ...draft, openingRangeMinutes: Number(event.target.value) })} /></label>
            <label>API lead minutes<input type="number" min="1" max="240" value={draft?.apiStartLeadMinutes ?? 15} onChange={(event) => setDraft({ ...draft, apiStartLeadMinutes: Number(event.target.value) })} /></label>
          </div>
        ) : null}
        {setting.key === "feed.provider" ? (
          <div className="setting-fields">
            <label>Provider symbol<input value={draft?.providerSymbol ?? "XAU/USD"} onChange={(event) => setDraft({ ...draft, providerSymbol: event.target.value })} /></label>
            <label>Poll seconds<input type="number" min="60" max="3600" value={draft?.pollSeconds ?? 60} onChange={(event) => setDraft({ ...draft, pollSeconds: Number(event.target.value) })} /></label>
            <label>Cache days<input type="number" min="1" max="30" value={draft?.cacheDays ?? 7} onChange={(event) => setDraft({ ...draft, cacheDays: Number(event.target.value) })} /></label>
            <label>Startup candles<input type="number" min="1" max="5000" value={draft?.startupBackfillCount ?? 300} onChange={(event) => setDraft({ ...draft, startupBackfillCount: Number(event.target.value) })} /></label>
            <label>Live poll candles<input type="number" min="1" max="100" value={draft?.livePollCount ?? 2} onChange={(event) => setDraft({ ...draft, livePollCount: Number(event.target.value) })} /></label>
            <label><input type="checkbox" checked={Boolean(draft?.rawCandleStorage)} onChange={(event) => setDraft({ ...draft, rawCandleStorage: event.target.checked })} /> Store raw Twelve Data candles</label>
          </div>
        ) : null}
        {setting.key === "notifications.browser" ? (
          <label><input type="checkbox" checked={Boolean(draft?.enabled)} onChange={(event) => setDraft({ enabled: event.target.checked })} /> Browser notifications</label>
        ) : null}
      </div>
      <button onClick={() => save().catch(() => undefined)}>Save</button>
    </div>
  );
}

function AuditPanel({ state }: { state: PanelState }) {
  const logs = state.auditLogs ?? [];
  return (
    <Panel icon={<FileText />} title="Audit Log">
      <div className="admin-list">
        {logs.slice(0, 8).map((log: any) => (
          <div className="notice-row" key={log.id}>
            <div>
              <strong>{log.action}</strong>
              <span>{log.resource_type}{log.resource_id ? ` · ${log.resource_id}` : ""}</span>
              <em>{formatNepalTime(log.created_at)} · {log.email ?? "system"}</em>
            </div>
          </div>
        ))}
        {logs.length === 0 ? <p className="reason">No admin changes recorded yet.</p> : null}
      </div>
    </Panel>
  );
}

function LearningPanel({ state, onRun }: { state: PanelState; onRun: () => Promise<void> }) {
  const learning = state.orbLearning;
  const overall = learning?.summary?.overall ?? {};
  const recommendations = learning?.recommendations ?? [];
  return (
    <Panel icon={<FileText />} title="Python ORB Learning">
      <Metric label="Last run" value={formatNepalTime(learning?.completed_at)} />
      <Metric label="Sample size" value={learning?.sample_size ?? 0} />
      <Metric label="Win rate" value={formatPercent(overall.win_rate)} />
      <Metric label="Expectancy" value={`${formatR(overall.expectancy)}R`} />
      <Metric label="Total R" value={`${formatR(overall.total_r)}R`} />
      <button onClick={() => onRun().catch(() => undefined)}><FileText size={16} />Run Learning</button>
      <div className="admin-list">
        {recommendations.slice(0, 6).map((item: any) => (
          <div className="notice-row" key={item.id}>
            <div>
              <strong>{item.title}</strong>
              <span>{item.rationale}</span>
              <em>{item.confidence} · {item.recommendation_type}</em>
            </div>
            <span className={`pill ${item.recommendation_type === "FAVOR" ? "good" : item.recommendation_type === "AVOID_OR_REVIEW" ? "bad" : "warn"}`}>{item.direction ?? "LEARN"}</span>
          </div>
        ))}
        {!learning ? <p className="reason">No learning run yet. Run learning after paper trades or backtests exist.</p> : null}
      </div>
    </Panel>
  );
}

function getSignal(setup?: any, trade?: any) {
  if (trade?.outcome === "ACTIVE") {
    return {
      label: trade.direction === "SHORT" ? "SELL ACTIVE" : "BUY ACTIVE",
      tone: trade.direction === "SHORT" ? "bad" : "good",
      reason: "A valid paper trade is open. The system will close it automatically at TP or SL."
    };
  }
  if (setup?.status === "LONG SETUP READY" || setup?.status === "PAPER_TRADE_OPENED") {
    return { label: "BUY", tone: "good", reason: setup.final_reason ?? "Valid long ORB setup detected." };
  }
  if (setup?.status === "SHORT SETUP READY") {
    return { label: "SELL", tone: "bad", reason: setup.final_reason ?? "Valid short ORB setup detected." };
  }
  if (setup?.status === "BLOCKED" || setup?.status === "NO TRADE") {
    return { label: "NO TRADE", tone: "bad", reason: setup.final_reason ?? "Current conditions are blocked." };
  }
  return { label: "WAIT", tone: "warn", reason: setup?.final_reason ?? "Waiting for a valid completed NY ORB signal." };
}

function TimeBadge({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="time-badge">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Status({ label, value, tone = "neutral" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={`pill ${tone}`}>{value}</strong>
    </div>
  );
}

function RuleList({ evaluations, setup, session, moduleCode = "orb_max_options" }: { evaluations: any[]; setup?: any; session?: any; moduleCode?: string }) {
  const activeModuleCode = setup?.module_code ?? moduleCode;
  const rows = activeModuleCode === "orb_max_options"
    ? maxOrbChecklistRows(evaluations, setup, session)
    : activeModuleCode === "high_probability_strategy_2"
      ? liquiditySweepChecklistRows(evaluations, setup)
      : activeModuleCode === "strategy_lab_3"
        ? vwapOpeningDriveChecklistRows(evaluations, setup)
      : genericModuleChecklistRows(evaluations, setup, activeModuleCode);
  const sections = groupedChecklistSections(activeModuleCode, rows);
  return (
    <div className="rule-list">
      {sections.map((section) => (
        <section className="rule-section" key={section.title}>
          <header>
            <div>
              <strong>{section.title}</strong>
              <span>{section.description}</span>
            </div>
            <em>{section.rows.filter((item: any) => item.status === "PASS").length}/{section.rows.length}</em>
          </header>
          <div className="rule-section-rows">
            {section.rows.map((item: any) => (
              <div className={`rule-row ${ruleTone(item.status)}`} key={item.id ?? item.rule_code ?? item.ruleCode}>
                {item.status === "PASS" ? <CheckCircle2 size={16} /> : item.status === "FAIL" ? <XCircle size={16} /> : <Clock size={16} />}
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.explanation}</span>
                  <small>{ruleLayerLabel(item)}</small>
                </div>
                <em>{item.status}</em>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ruleLayerLabel(item: any) {
  const layer = item.ruleLayer ?? item.rule_layer;
  const required = item.requiredForEntry ?? item.required_for_entry;
  if (!layer) return required ? "Required for automatic paper entry" : "Strategy evidence";
  const label = String(layer).replaceAll("_", " ").toLowerCase();
  return required ? `${label} · required for paper entry` : label;
}

function groupedChecklistSections(moduleCode: string, rows: any[]) {
  if (moduleCode === "orb_max_options") {
    return checklistSections(rows, [
      {
        title: "Engine State",
        description: "Current Module 1 ORB decision state.",
        codes: ["SCENARIO_SELECTED"]
      },
      {
        title: "Mandatory Entry Checklist",
        description: "These rules must pass before Module 1 can produce a paper BUY/SELL.",
        codes: ["SESSION_READY", "ORB_LOCKED", "AUTO_ELIGIBLE", "CLOSE_ABOVE_ORB_HIGH", "CLOSE_BELOW_ORB_LOW"]
      },
      {
        title: "Breakout Confirmation Checklist",
        description: "Quality confirmation for a completed ORB breakout candle.",
        codes: ["BREAKOUT_BODY_RATIO", "CLOSE_LOCATION_RATIO", "FAVORABILITY_SCORE"]
      },
      {
        title: "Risk & Quality Filters",
        description: "Filters that protect the setup from poor execution conditions.",
        codes: ["ENTRY_NOT_OVEREXTENDED", "NEWS_FILTER", "RISK_PERMISSION"]
      },
      {
        title: "Final Automation Gate",
        description: "The final strict checklist gate before automatic paper trading.",
        codes: ["STRICT_CHECKLIST", "REPLAY_MATCH"]
      }
    ]);
  }
  if (moduleCode === "high_probability_strategy_2") {
    return checklistSections(rows, [
      {
        title: "Engine State",
        description: "Current Module 2 Liquidity Sweep + BOS sequence state.",
        codes: ["MODULE2_STATE"]
      },
      {
        title: "Mandatory Entry Checklist",
        description: "The institutional sequence must complete in order: NY session, sweep, displacement, BOS/CHoCH, zone, retrace, entry candle.",
        codes: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE", "CONFIRM_ENTRY_CANDLE"]
      },
      {
        title: "Confirmation Checklist",
        description: "At least 3 of 5 confirmation rules must pass for a valid Module 2 signal.",
        codes: ["CONFIRM_EMA_200", "CONFIRM_VWAP", "CONFIRM_FRESH_FVG", "CONFIRM_ORDER_BLOCK_RETEST", "CONFIRMATION_COUNT"]
      },
      {
        title: "Risk & Quality Filters",
        description: "At least 3 quality filters plus required risk controls must pass.",
        codes: ["QUALITY_ATR_VOLATILITY", "QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE", "QUALITY_FRESH_SETUP", "QUALITY_FILTER_COUNT"]
      },
      {
        title: "Final Automation Gate",
        description: "Minimum confidence required before automatic paper trading.",
        codes: ["SIGNAL_SCORE"]
      }
    ]);
  }
  if (moduleCode === "strategy_lab_3") {
    return checklistSections(rows, [
      {
        title: "Engine State",
        description: "Current Module 3 VWAP opening-drive pullback state.",
        codes: ["MODULE3_STATE"]
      },
      {
        title: "Mandatory Entry Checklist",
        description: "The NY opening drive, VWAP alignment, pullback zone touch, and confirmation candle must all pass.",
        codes: ["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "OPENING_DRIVE_COMPLETE", "OPENING_DRIVE_STRONG", "VWAP_ALIGNMENT", "PULLBACK_ZONE_READY", "PULLBACK_ZONE_TOUCHED", "CONFIRMATION_CANDLE"]
      },
      {
        title: "Confirmation Checklist",
        description: "Trend continuation evidence supporting the VWAP pullback.",
        codes: ["EMA_ALIGNMENT"]
      },
      {
        title: "Risk & Quality Filters",
        description: "Execution filters for spread, news, reward-to-risk, and stop size.",
        codes: ["QUALITY_SPREAD", "QUALITY_NEWS", "QUALITY_RR", "QUALITY_STOP_SIZE"]
      },
      {
        title: "Final Automation Gate",
        description: "Minimum confidence required before automatic paper trading.",
        codes: ["SIGNAL_SCORE"]
      }
    ]);
  }
  return [{ title: "Strategy Checklist", description: "Module-specific rules.", rows }];
}

function checklistSections(rows: any[], definitions: Array<{ title: string; description: string; codes: string[] }>) {
  const used = new Set<string>();
  const normalized = rows.map((row) => ({ ...row, rule_code: row.rule_code ?? row.ruleCode }));
  const sections = definitions
    .map((definition) => {
      const sectionRows = normalized.filter((row) => {
        const code = row.rule_code ?? row.ruleCode;
        if (!definition.codes.includes(code)) return false;
        used.add(code);
        return true;
      });
      return { ...definition, rows: sectionRows };
    })
    .filter((section) => section.rows.length > 0);
  const remaining = normalized.filter((row) => !used.has(row.rule_code ?? row.ruleCode));
  if (remaining.length > 0) {
    sections.push({
      title: "Additional Evidence",
      description: "Extra module evidence saved with the setup.",
      codes: [],
      rows: remaining
    });
  }
  return sections;
}

function vwapOpeningDriveChecklistRows(evaluations: any[], setup?: any) {
  const flags = setup?.scenario_flags ?? {};
  const byCode = new Map(evaluations.map((item: any) => [item.rule_code ?? item.ruleCode, item]));
  const setupState = flags.state ?? setup?.status;
  const hasTerminalSetup = ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "NO TRADE", "BLOCKED"].includes(String(setup?.status ?? ""));
  const defaults = [
    ["NY_SESSION_ACTIVE", "New York session active", "Module 3 only evaluates during its configured New York VWAP window."],
    ["DAILY_TRADE_LIMIT", "Daily trade limit not reached", "Only the configured number of Module 3 paper trades can trigger per session."],
    ["OPENING_DRIVE_COMPLETE", "Opening drive complete", "The first NY impulse window must finish before pullback entries."],
    ["OPENING_DRIVE_STRONG", "Opening drive strength", "The opening drive must meet ATR range and candle body requirements."],
    ["VWAP_ALIGNMENT", "VWAP alignment", "Price must remain on the correct side of VWAP after the opening drive."],
    ["EMA_ALIGNMENT", "20 EMA alignment", "EMA alignment supports the continuation context."],
    ["PULLBACK_ZONE_READY", "VWAP/EMA pullback zone ready", "A valid VWAP/EMA value zone must exist before pullback entry."],
    ["PULLBACK_ZONE_TOUCHED", "Pullback zone touched", "Price must pull back into the VWAP/EMA value zone."],
    ["CONFIRMATION_CANDLE", "Confirmation candle", "A completed candle must confirm continuation away from the pullback zone."],
    ["QUALITY_SPREAD", "Spread filter", "Spread must be acceptable for XAUUSD paper entry."],
    ["QUALITY_NEWS", "No high-impact news", "News filter must be clear for automation."],
    ["QUALITY_RR", "Minimum RR 2:1", "Reward-to-risk must meet the configured minimum."],
    ["QUALITY_STOP_SIZE", "Maximum stop size", "Stop distance must remain inside the configured ATR limit."],
    ["SIGNAL_SCORE", "Minimum signal score", "Module 3 requires a high-quality opening-drive pullback score."]
  ];
  const rows = defaults.map(([code, name, explanation]) => checklistRow(byCode, code, name, hasTerminalSetup ? "NOT_APPLICABLE" : "WAITING", explanation));
  rows.unshift({
    rule_code: "MODULE3_STATE",
    name: "Module 3 state",
    status: setup?.status === "LONG SETUP READY" || setup?.status === "SHORT SETUP READY" || setup?.status === "PAPER_TRADE_OPENED" ? "PASS" : "WAITING",
    explanation: setupState ? `Current engine state: ${String(setupState).replaceAll("_", " ")}.` : "Waiting for NY opening-drive and VWAP pullback evidence."
  });
  return rows;
}

function liquiditySweepChecklistRows(evaluations: any[], setup?: any) {
  const flags = setup?.scenario_flags ?? {};
  const byCode = new Map(evaluations.map((item: any) => [item.rule_code ?? item.ruleCode, item]));
  const setupState = flags.state ?? setup?.status;
  const hasTerminalSetup = ["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "NO TRADE", "BLOCKED"].includes(String(setup?.status ?? ""));
  const defaults = [
    ["NY_SESSION_ACTIVE", "New York session active", "Module 2 only evaluates during its configured NY liquidity window."],
    ["DAILY_TRADE_LIMIT", "Daily trade limit not reached", "Only the configured number of paper trades can trigger per session."],
    ["LIQUIDITY_LEVEL_IDENTIFIED", "Meaningful liquidity level identified", "PDH/PDL, Asian, London, or equal high/low liquidity must be available."],
    ["LIQUIDITY_SWEEP_CONFIRMED", "Liquidity sweep confirmed", "Price must sweep liquidity and close back through the level."],
    ["DISPLACEMENT_CONFIRMED", "Displacement confirmed", "A strong reversal candle must appear after the sweep."],
    ["BOS_CHOCH_CONFIRMED", "BOS or CHoCH confirmed", "A candle body must close beyond internal structure."],
    ["ENTRY_ZONE_READY", "Fresh entry zone ready", "A fresh FVG or order-block zone must exist after BOS/CHoCH."],
    ["ENTRY_ZONE_RETRACE", "Entry zone retrace", "Price must return into the fresh FVG/order-block zone before paper entry."],
    ["CONFIRM_EMA_200", "Confirmation: 200 EMA alignment", "Scored confirmation worth 15 points."],
    ["CONFIRM_VWAP", "Confirmation: VWAP alignment", "Scored confirmation worth 10 points."],
    ["CONFIRM_FRESH_FVG", "Confirmation: fresh FVG", "Scored confirmation worth 15 points."],
    ["CONFIRM_ORDER_BLOCK_RETEST", "Confirmation: order block retest", "Scored confirmation worth 10 points."],
    ["CONFIRM_ENTRY_CANDLE", "Entry confirmation candle", "Mandatory entry trigger and scored confirmation worth 10 points."],
    ["CONFIRMATION_COUNT", "Confirmation layer passed", "At least 3 of 5 confirmation rules must pass."],
    ["QUALITY_ATR_VOLATILITY", "Quality: ATR volatility", "Optimization quality filter."],
    ["QUALITY_SPREAD", "Quality: spread", "Optimization quality filter."],
    ["QUALITY_NEWS", "Quality: no high-impact news", "Optimization quality filter."],
    ["QUALITY_RR", "Quality: RR >= 2:1", "Optimization quality filter."],
    ["QUALITY_STOP_SIZE", "Quality: stop size", "Optimization quality filter."],
    ["QUALITY_FRESH_SETUP", "Quality: fresh setup", "Optimization quality filter."],
    ["QUALITY_FILTER_COUNT", "Quality layer passed", "At least 3 quality filters must pass."],
    ["SIGNAL_SCORE", "Minimum signal score", "The final Module 2 confidence score must pass the configured threshold."]
  ];
  const rows = defaults.map(([code, name, explanation]) => checklistRow(byCode, code, name, hasTerminalSetup ? "NOT_APPLICABLE" : "WAITING", explanation));
  rows.unshift({
    rule_code: "MODULE2_STATE",
    name: "Module 2 state",
    status: setup?.status === "LONG SETUP READY" || setup?.status === "SHORT SETUP READY" || setup?.status === "PAPER_TRADE_OPENED" ? "PASS" : "WAITING",
    explanation: setupState ? `Current engine state: ${String(setupState).replaceAll("_", " ")}.` : "Waiting for enough live candles and a valid Module 2 sequence."
  });
  return rows;
}

function genericModuleChecklistRows(evaluations: any[], setup?: any, moduleCode?: string) {
  if (evaluations.length > 0) return evaluations;
  return [
    {
      rule_code: "MODULE_READY",
      name: `${moduleShortName(moduleCode ?? "", "Strategy Module")} rules`,
      status: setup?.scenario ? "PASS" : "WAITING",
      explanation: setup?.final_reason ?? "Waiting for this module to produce a scored setup."
    }
  ];
}

function maxOrbChecklistRows(evaluations: any[], setup?: any, session?: any) {
  const flags = setup?.scenario_flags ?? {};
  const matrix = flags.matrix ?? {};
  const profile = flags.breakoutProfile ?? {};
  const favorability = flags.favorability ?? {};
  const byCode = new Map(evaluations.map((item: any) => [item.rule_code ?? item.ruleCode, item]));
  const bodyRatio = numberOrNull(profile.bodyRatio ?? favorability.bodyRatio);
  const closeLocationRatio = numberOrNull(profile.closeLocationRatio ?? favorability.closeLocationRatio);
  const extension = numberOrNull(profile.extension);
  const outsideClose = profile.outsideClose === true;
  const automaticReady = setup?.status === "LONG SETUP READY" || setup?.status === "SHORT SETUP READY" || setup?.status === "PAPER_TRADE_OPENED";
  const unmatchedRules = Array.isArray(matrix.unmatchedChecklistRules) ? matrix.unmatchedChecklistRules : [];
  const sessionActive = ["OPENING_RANGE_LOCKED", "WAITING_FOR_SETUP", "TRADE_ACTIVE"].includes(session?.state) || Boolean(setup?.expires_at && new Date(setup.expires_at).getTime() >= Date.now());
  const orbLocked = Boolean(session?.opening_range) || Boolean(setup?.detected_at);

  const rows = [
    {
      rule_code: "SESSION_READY",
      name: "New York session active",
      status: sessionActive ? "PASS" : "WAITING",
      explanation: sessionActive ? "The full NY monitoring window is active." : "Waiting for the configured NY monitoring window."
    },
    {
      rule_code: "ORB_LOCKED",
      name: "Opening range is locked",
      status: ruleStatus(byCode, "ORB_LOCKED", orbLocked ? "PASS" : "WAITING"),
      explanation: byCode.get("ORB_LOCKED")?.explanation ?? (orbLocked ? "The opening range is locked and cannot repaint." : "The first completed ORB candle must be available.")
    },
    {
      rule_code: "SCENARIO_SELECTED",
      name: "Scenario selected",
      status: setup?.scenario ? "PASS" : "WAITING",
      explanation: setup?.scenario ? `${formatScenario(setup.scenario)} was selected by the ORB scenario matrix.` : "No completed setup has been scored yet."
    },
    {
      rule_code: "AUTO_ELIGIBLE",
      name: "Automatic paper eligibility",
      status: matrix.autoEligible ? "PASS" : "NOT_APPLICABLE",
      explanation: matrix.autoEligible ? "This scenario can trigger automatic paper entry." : "This scenario is tracked, but it is not an automatic entry scenario."
    },
    checklistRow(byCode, setup?.direction === "SHORT" ? "CLOSE_BELOW_ORB_LOW" : "CLOSE_ABOVE_ORB_HIGH", "Completed candle closes outside ORB", outsideClose ? "PASS" : setup?.scenario ? "FAIL" : "WAITING", outsideClose ? "The signal candle closed outside the ORB boundary." : "No valid completed outside-close breakout for automatic entry."),
    checklistRow(byCode, "BREAKOUT_BODY_RATIO", "Breakout candle body ratio", ratioStatus(bodyRatio, 0.55, setup), bodyRatio == null ? "Waiting for a scored breakout candle." : `Body ratio is ${formatRatio(bodyRatio)}. Required: 55% or higher.`),
    checklistRow(byCode, "CLOSE_LOCATION_RATIO", "Breakout close location", ratioStatus(closeLocationRatio, 0.65, setup), closeLocationRatio == null ? "Waiting for a scored breakout candle." : `Close location is ${formatRatio(closeLocationRatio)}. Required: 65% or higher.`),
    checklistRow(byCode, "ENTRY_NOT_OVEREXTENDED", "Entry is not overextended", extension == null || !outsideClose ? "NOT_APPLICABLE" : extension <= 0.25 ? "PASS" : "FAIL", extension == null || !outsideClose ? "Only applies after a completed outside-close breakout." : `Extension is ${formatRatio(extension)} of ORB range. Maximum: 25%.`),
    checklistRow(byCode, "NEWS_FILTER", "No blocked USD news", "NOT_APPLICABLE", "News filter is disabled or no backend news evaluation is attached to this candidate."),
    checklistRow(byCode, "RISK_PERMISSION", "Risk engine permits the trade", automaticReady ? "PASS" : "NOT_APPLICABLE", automaticReady ? "Risk checks permitted this automatic paper setup." : "Risk permission is required only when the setup reaches automatic entry readiness."),
    {
      rule_code: "FAVORABILITY_SCORE",
      name: "Favorability threshold",
      status: setup?.favorability_score == null ? "WAITING" : Number(setup.favorability_score) >= 70 ? "PASS" : "FAIL",
      explanation: setup?.favorability_score == null ? "Waiting for favorability scoring." : `Score is ${setup.favorability_score}/100. Required: 70/100 or higher for automatic paper trading.`
    },
    {
      rule_code: "STRICT_CHECKLIST",
      name: "Strict checklist gate",
      status: automaticReady || matrix.checklistMatched ? "PASS" : unmatchedRules.length > 0 ? "FAIL" : "NOT_APPLICABLE",
      explanation: automaticReady || matrix.checklistMatched ? "Every automatic-entry checklist rule matched." : unmatchedRules.length > 0 ? `Blocked by: ${unmatchedRules.join(", ")}.` : "Current scenario is being tracked, not traded automatically."
    }
  ];

  if (flags.replay || flags.replayMatchedExpectedScenario === false) {
    rows.push({
      rule_code: "REPLAY_MATCH",
      name: "Replay expected scenario",
      status: flags.replayMatchedExpectedScenario === false ? "FAIL" : "PASS",
      explanation: `Replay expected ${formatScenario(flags.replayExpectedScenario)}.`
    });
  }
  return rows;
}

function checklistRow(byCode: Map<any, any>, code: string, name: string, fallbackStatus: string, fallbackExplanation: string) {
  const existing = byCode.get(code);
  return existing
    ? { ...existing, rule_code: existing.rule_code ?? existing.ruleCode, name: existing.name ?? name }
    : { rule_code: code, name, status: fallbackStatus, explanation: fallbackExplanation };
}

function ruleStatus(byCode: Map<any, any>, code: string, fallback: string) {
  return byCode.get(code)?.status ?? fallback;
}

function ratioStatus(value: number | null, threshold: number, setup?: any) {
  if (value == null) return setup?.scenario ? "FAIL" : "WAITING";
  return value >= threshold ? "PASS" : "FAIL";
}

function ruleTone(status?: string) {
  if (status === "PASS") return "good";
  if (status === "FAIL") return "bad";
  return "warn";
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{React.cloneElement(icon as React.ReactElement, { size: 18 })}{title}</h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function sectionTitle(section: ActiveSection) {
  const titles: Record<ActiveSection, string> = {
    command: "Command Center",
    live: "Live Chart",
    health: "System Status",
    orb: "Strategy Center",
    reports: "Reports",
    learning: "Learning",
    notifications: "Notifications",
    account: "My Account",
    settings: "Settings",
    data: "Data Admin"
  };
  return titles[section];
}

function sectionSubtitle(section: ActiveSection) {
  const subtitles: Record<ActiveSection, string> = {
    command: "One operational view for all enabled XAUUSD strategy modules, paper trades, confidence, and rehearsals.",
    live: "Realtime XAUUSD candles, live indicators, and automatic paper-trade signal state.",
    health: "Live service checks for Twelve Data, PostgreSQL/cache, NY scheduler, chart readiness, and module automation.",
    orb: "Module-specific setup evidence, generated BUY/SELL records, outcomes, and scenario reasoning.",
    reports: "Weekly, monthly, and scenario performance for the ORB Max options trading logic.",
    learning: "Compare module learning, weak rules, recommendations, and sample readiness.",
    notifications: "Signal, replay, and system notifications with acknowledgement controls.",
    account: "Profile, subscription, module access, usage, and account controls.",
    settings: "Trading session, feed, and paper-execution configuration overview.",
    data: "Cache, replay, backtest, and provider diagnostics."
  };
  return subtitles[section];
}

function platformSectionTitle(section: PlatformSection) {
  const titles: Record<PlatformSection, string> = {
    overview: "Platform Overview",
    subscribers: "Subscriber Management",
    tickets: "Support Tickets",
    modules: "Strategy Modules",
    plans: "Plans & Access",
    "app-updates": "Mobile App Updates",
    billing: "Manual Billing",
    automation: "Automation Control",
    usage: "Usage & Data",
    system: "System Access",
    settings: "Platform Settings"
  };
  return titles[section];
}

function platformSectionFromPath(pathname: string): PlatformSection {
  const section = pathname.split("/").filter(Boolean)[1];
  if (
    section === "subscribers" ||
    section === "tickets" ||
    section === "modules" ||
    section === "plans" ||
    section === "app-updates" ||
    section === "billing" ||
    section === "automation" ||
    section === "usage" ||
    section === "system" ||
    section === "settings"
  ) {
    return section;
  }
  return "overview";
}

function platformSectionSubtitle(section: PlatformSection) {
  const subtitles: Record<PlatformSection, string> = {
    overview: "High-level subscriber, module, plan, automation, and API usage health.",
    subscribers: "Create users, assign plans, enable modules, and manage subscription status.",
    tickets: "Review tenant-created tickets, prioritize requests, and move them through resolution.",
    modules: "Control the strategy module catalog available to subscriber plans.",
    plans: "Review subscription plans, included modules, account limits, and automation access.",
    "app-updates": "Upload Android APK releases and manage the update feed used by the mobile app.",
    billing: "Track manual payment requests, invoices, revenue, and billing audit activity.",
    automation: "Monitor shared Twelve Data ingestion and per-subscriber module automation.",
    usage: "Inspect Twelve Data credits, grouped calls, imported candles, and recent provider events.",
    system: "Super-user session scope and platform console boundaries.",
    settings: "Manage business contact, support, and help information shown to subscribers."
  };
  return subtitles[section];
}

function detectVersionFromFileName(fileName: string) {
  return fileName.match(/(?:^|[-_v])(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9._-]+)?)(?:[-_.]|$)/)?.[1] ?? "";
}

function formatFileSize(value: unknown) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function absoluteApiDownloadUrl(path: string) {
  if (!path) return "#";
  if (path.startsWith("http")) return path;
  return `${API_BASE_URL.replace(/\/$/, "")}${path}`;
}

function settingValue<T>(settings: any[] | undefined, key: string, fallback: T): T {
  const setting = settings?.find((item) => item.key === key);
  return setting?.value ?? fallback;
}

async function loadCommandSnapshots() {
  return Promise.all(STRATEGY_MODULE_CODES.map(async (moduleCode) => {
    const [setup, trade] = await Promise.all([
      api<any>(`/api/setups/current?moduleCode=${moduleCode}`).catch(() => null),
      api<any>(`/api/trades/current?moduleCode=${moduleCode}`).catch(() => null)
    ]);
    return { moduleCode, setup, trade };
  }));
}

function moduleTimeframe(moduleCode: string, fallback: number) {
  return moduleCode === "orb_max_options" || moduleCode === "high_probability_strategy_2" || moduleCode === "strategy_lab_3" ? 5 : fallback;
}

function moduleTimingLabel(moduleCode: string) {
  if (moduleCode === "orb_max_options") return "15M OR range / 5M trigger";
  if (moduleCode === "high_probability_strategy_2") return "5M sweep + BOS / 15M bias";
  if (moduleCode === "strategy_lab_3") return "5M VWAP pullback / 15M bias";
  return `${DEFAULT_TIMEFRAME_MINUTES}M execution`;
}

function module2CockpitState(state: PanelState, setup?: any, trade?: any) {
  const readinessChecks = state.module2Readiness?.checks ?? [];
  const operator = state.module2Operator ?? {};
  const latestRehearsal = state.module2Rehearsals?.[0];
  const reviewRows = state.module2LearningReviews ?? [];
  const auditChecks = state.module2Audit?.checks ?? [];
  const health = state.module2Health?.summary ?? {};
  const learning = state.module2Learning ?? {};
  const pendingReviews = reviewRows.filter((row: any) => row.status === "PENDING").length;
  const failedGuardrails = reviewRows.filter((row: any) => (row.guardrails ?? []).some((check: any) => check.status === "FAIL")).length;
  const latestCloseout = state.module2Closeouts?.[0];
  const closeoutFailed = latestCloseout?.status === "FAILED";
  const feedReady = checkStatus(readinessChecks, "TWELVE_DATA_CONFIGURED") === "PASS" && checkStatus(readinessChecks, "FIVE_MIN_CANDLES") === "PASS";
  const biasReady = checkStatus(readinessChecks, "FIFTEEN_MIN_BIAS") === "PASS";
  const paperReady = checkStatus(readinessChecks, "PAPER_TRADING_ENABLED") === "PASS";
  const auditReady = auditChecks.length > 0 && auditChecks.filter((check: any) => check.status === "FAIL").length === 0;
  const healthReady = health.status === "OK";
  const rehearsalStatus = latestRehearsal?.final_status ?? operator.finalStatus ?? "WAIT";
  const rehearsalReady = rehearsalStatus === "GO";
  const learningSample = Number(learning.sample_size ?? 0);
  const learningReady = learningSample >= 20;
  const blockers = [
    !feedReady ? "Feed/candle readiness is not complete." : null,
    !biasReady ? "15M bias candles are not ready." : null,
    !paperReady ? "Paper trading is not ready." : null,
    !healthReady ? `Health status is ${health.status ?? "UNKNOWN"}.` : null,
    !auditReady ? "Production audit is not passing yet." : null,
    !rehearsalReady ? "Latest launch rehearsal is not GO." : null,
    closeoutFailed ? `Latest closeout failed: ${latestCloseout.error ?? "unknown error"}` : null,
    pendingReviews > 0 ? `${pendingReviews} learning review item(s) are pending.` : null,
    failedGuardrails > 0 ? `${failedGuardrails} learning review item(s) have failed guardrails.` : null
  ].filter(Boolean) as string[];
  const trustScore = Math.max(0, Math.min(100,
    (feedReady ? 20 : 0) +
    (biasReady ? 10 : 0) +
    (paperReady ? 15 : 0) +
    (healthReady ? 15 : 0) +
    (auditReady ? 10 : 0) +
    (rehearsalReady ? 15 : 0) +
    (!closeoutFailed && pendingReviews === 0 && failedGuardrails === 0 ? 10 : 0) +
    (learningReady ? 5 : 2)
  ));
  const launchStatus = blockers.length === 0 && trustScore >= 85 ? "TRUST NEXT VALID SIGNAL" : trustScore >= 70 ? "CAUTION" : "NO GO";
  return {
    trustScore,
    launchStatus,
    statusTone: launchStatus === "TRUST NEXT VALID SIGNAL" ? "good" : launchStatus === "CAUTION" ? "warn" : "bad",
    phase: state.module2Readiness?.automation?.phase ?? state.module2Operator?.operator?.currentPhase ?? checkValue(readinessChecks, "NY_WINDOW") ?? "UNKNOWN",
    feedStatus: feedReady ? "READY" : "WAIT",
    paperStatus: paperReady ? "READY" : "BLOCKED",
    healthStatus: health.status ?? "UNKNOWN",
    reviewStatus: failedGuardrails > 0 ? "FAILED GUARDRAILS" : pendingReviews > 0 ? `${pendingReviews} PENDING` : "CLEAR",
    rehearsalStatus,
    blockers: blockers.length > 0 ? blockers : ["No blocking items. Wait for a valid completed Module 2 setup."],
    verdict: launchStatus === "TRUST NEXT VALID SIGNAL"
      ? "Module 2 is ready for today’s NY session. Only act on signals after the module checklist is valid."
      : launchStatus === "CAUTION"
        ? "Module 2 can be monitored, but review the blocking items before trusting the next signal."
        : "Do not trust Module 2 signals yet. Resolve the blocking items first.",
    checklists: [
      {
        title: "Before NY Session",
        items: ["Run launch rehearsal", "Confirm Twelve Data feed", "Confirm paper trading", "Review pending learning items"]
      },
      {
        title: "During NY Session",
        items: ["Watch only valid sweep + displacement + BOS", "Wait for confirmation and quality counts", "Let paper trade lifecycle record outcome"]
      },
      {
        title: "After NY Session",
        items: ["Review journal outcomes", "Run Module 2 learning", "Send useful recommendations to review queue"]
      }
    ],
    setup,
    trade
  };
}

function exportModule2ReportsCsv(reports: any[]) {
  const header = ["date", "status", "outcome", "valid_setups", "paper_trades", "wins", "losses", "active", "total_r", "trusted_manually"];
  const rows = reports.map((row) => [
    row.session_date ?? "",
    row.final_status ?? "",
    row.trade_snapshot?.dominantOutcome ?? "",
    row.summary?.validSetups ?? row.setup_snapshot?.valid ?? 0,
    row.summary?.paperTrades ?? row.trade_snapshot?.total ?? 0,
    row.summary?.wins ?? 0,
    row.summary?.losses ?? 0,
    row.summary?.active ?? 0,
    row.summary?.totalR ?? row.trade_snapshot?.total_r ?? 0,
    row.trusted_manually == null ? "" : row.trusted_manually ? "YES" : "NO"
  ]);
  const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `module2-session-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function module2BacktestMetricMap(rows: any[]) {
  return (rows ?? []).reduce<Record<string, any>>((accumulator, row) => {
    accumulator[row.metric_key] = row.metric_json ?? row.metric_value;
    return accumulator;
  }, {});
}

function moduleChartPriceLines(moduleCode: string, setup?: any, _openingRange?: any): ChartPriceLine[] | undefined {
  if (moduleCode === "orb_max_options") return undefined;
  const moduleSetup = setup?.module_code === moduleCode ? setup : null;
  if (!moduleSetup) return [];
  const flags = moduleSetup.scenario_flags ?? {};
  if (moduleCode === "strategy_lab_3") {
    const zone = flags.entryZone ?? {};
    const drive = flags.drive ?? {};
    return [
      { title: "VWAP", price: flags.vwap, color: "#38bdf8" },
      { title: "EMA 20", price: flags.ema, color: "#f0b429" },
      { title: "Zone High", price: zone.high, color: "#a78bfa" },
      { title: "Zone 50%", price: zone.midpoint, color: "#c4b5fd" },
      { title: "Zone Low", price: zone.low, color: "#a78bfa" },
      { title: "Drive High", price: drive.high, color: "#7c9cff" },
      { title: "Drive Low", price: drive.low, color: "#7c9cff" },
      { title: "Entry", price: moduleSetup.entry_price, color: "#16a46c" },
      { title: "Stop", price: moduleSetup.stop_price, color: "#e05252" },
      { title: "Target", price: moduleSetup.target_price, color: "#7c9cff" }
    ];
  }
  const sweepPrice = flags.sweep?.level?.price;
  const bosLevel = flags.bos?.level;
  const zone = flags.entryZone ?? {};
  const levelLines = Array.isArray(flags.levels)
    ? flags.levels.slice(0, 8).map((level: any) => ({
        title: String(level.type ?? "Liquidity").replaceAll("_", " "),
        price: level.price,
        color: level.priority === "HIGH" ? "#f0b429" : level.priority === "MEDIUM" ? "#38bdf8" : "#64748b"
      }))
    : [];
  return [
    ...levelLines,
    { title: "Liquidity", price: sweepPrice, color: "#f0b429" },
    { title: "BOS", price: bosLevel, color: "#38bdf8" },
    { title: "Zone High", price: zone.high, color: "#a78bfa" },
    { title: "Zone 50%", price: zone.midpoint, color: "#c4b5fd" },
    { title: "Zone Low", price: zone.low, color: "#a78bfa" },
    { title: "Entry", price: moduleSetup.entry_price, color: "#16a46c" },
    { title: "Stop", price: moduleSetup.stop_price, color: "#e05252" },
    { title: "Target", price: moduleSetup.target_price, color: "#7c9cff" }
  ];
}

function moduleShortName(moduleCode: string, name?: string) {
  if (moduleCode === "orb_max_options") return "Module 1 ORB";
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Sweep + BOS";
  if (moduleCode === "strategy_lab_3") return "Module 3 VWAP Drive";
  return name ?? "Strategy Module";
}

function module2RuleLayer(code?: string) {
  if (!code) return "other";
  if (code.startsWith("CONFIRM_") || code === "CONFIRMATION_COUNT") return "confirmation";
  if (code.startsWith("QUALITY_") || code === "QUALITY_FILTER_COUNT" || code === "SIGNAL_SCORE") return "quality";
  if (["NY_SESSION_ACTIVE", "DAILY_TRADE_LIMIT", "LIQUIDITY_LEVEL_IDENTIFIED", "LIQUIDITY_SWEEP_CONFIRMED", "DISPLACEMENT_CONFIRMED", "BOS_CHOCH_CONFIRMED", "ENTRY_ZONE_READY", "ENTRY_ZONE_RETRACE"].includes(code)) return "hard";
  return "other";
}

function formatScenario(value?: string) {
  if (!value) return "WAITING";
  return value.replaceAll("_", " ");
}

function formatSweep(value?: any) {
  if (!value?.swept) return "None";
  return `${value.firstSide ?? "Both"} swept`;
}

function formatRatio(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${Math.round(number * 100)}%`;
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scenarioBreakdownTags(value: any) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([scenario, row]: [string, any]) => {
    const trades = Number(row.trades ?? 0);
    const wins = Number(row.wins ?? 0);
    const winRate = trades > 0 ? Math.round((wins / trades) * 100) : 0;
    return `${formatScenario(scenario)}: ${trades} trades, ${winRate}%, ${formatR(row.totalR)}R`;
  });
}

function breakdownTags(value: any) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([label, row]: [string, any]) => {
    const trades = Number(row.trades ?? 0);
    const wins = Number(row.wins ?? 0);
    const winRate = trades > 0 ? Math.round((wins / trades) * 100) : 0;
    return `${formatScenario(label)}: ${trades} trades, ${winRate}%, ${formatR(row.totalR)}R`;
  });
}

function checkStatus(checks: any[] | undefined, code: string) {
  return checks?.find((check) => check.code === code)?.status ?? "--";
}

function checkValue(checks: any[] | undefined, code: string) {
  const check = checks?.find((item) => item.code === code);
  return check?.value ?? check?.status ?? null;
}

function auditStatus(checks: any[] | undefined, code: string) {
  return checks?.find((check) => check.code === code)?.status ?? "WAIT";
}

function notificationSearchParams(filters: any) {
  const params = new URLSearchParams();
  if (filters.moduleCode) params.set("moduleCode", filters.moduleCode);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.eventType) params.set("eventType", filters.eventType);
  if (filters.unreadOnly) params.set("unacknowledged", "true");
  const value = params.toString();
  return value ? `&${value}` : "";
}

function formatPercent(value: unknown) {
  const number = Number(value ?? 0);
  return `${(number * 100).toFixed(1)}%`;
}

function formatCurrency(value: unknown) {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

function formatPriceValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "--";
}

function formatR(value: unknown) {
  return Number(value ?? 0).toFixed(2);
}

function formatNepalTime(value?: string | null) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(new Date(value));
}

function dateInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function feedProviderLabel(provider?: string) {
  if (provider === "TWELVE_DATA") return "Twelve Data";
  if (provider && provider !== "NONE") return provider;
  return "Waiting";
}

function formatAge(seconds: unknown) {
  const number = Number(seconds);
  if (!Number.isFinite(number)) return "--";
  if (number < 60) return `${Math.round(number)}s`;
  const minutes = Math.floor(number / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function toneFor(value?: string) {
  if (!value) return "neutral";
  if (["LONG SETUP READY", "SHORT SETUP READY", "PAPER_TRADE_OPENED", "ACTIVE", "WIN", "PERMITTED", "TWELVE DATA LIVE", "RUNNING", "CLEAR", "WAITING_FOR_SETUP", "OPENING_RANGE_LOCKED"].includes(value)) return "good";
  if (["BLOCKED", "NO_TRADE", "SESSION_EXPIRED", "BLOCKED_BEFORE_EVENT", "BLOCKED_AFTER_EVENT", "LOSS"].includes(value)) return "bad";
  if (["WAIT", "PRE_SESSION", "OPENING_RANGE_FORMING", "WAITING_FOR_DATA", "UPCOMING_WARNING", "WAIT FOR RETEST"].includes(value)) return "warn";
  return "neutral";
}

createRoot(document.getElementById("root")!).render(<App />);
