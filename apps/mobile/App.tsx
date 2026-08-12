import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as LocalAuthentication from "expo-local-authentication";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { StatusBar } from "expo-status-bar";
import React, { Component, ReactNode, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Switch,
  View
} from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

const TOKEN_KEY = "orb_mobile_token";
const API_URL_KEY = "orb_mobile_api_url";
const BIOMETRIC_ENABLED_KEY = "orb_mobile_biometric_enabled";
const PUSH_TOKEN_KEY = "orb_mobile_push_token";
const PUSH_SYNC_KEY = "orb_mobile_push_synced_at";
const UPDATE_PROMPT_KEY = "orb_mobile_update_prompted_version";
const DEFAULT_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  "http://localhost:7073";
const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const APP_VERSION_CODE = Number(Application.nativeBuildVersion ?? Constants.expoConfig?.android?.versionCode ?? 0);
const BRAND_LOGO = require("./assets/brand-logo.png");
const BRAND_MARK = require("./assets/brand-mark.png");

type ModuleRow = {
  code: string;
  name: string;
  shortName: string;
  target_win_rate?: string;
  timeframeMinutes: number;
  currentSetup?: any;
  currentTrade?: any;
  weekly?: any;
  monthly?: any;
  session?: any;
};

type Dashboard = {
  user: AuthUser;
  tenant: { name: string; subscription_status?: string; plan_name?: string } | null;
  clocks: { newYork: string; nepal: string; utc: string };
  modules: ModuleRow[];
  notifications: any[];
  supportTickets?: any[];
  supportInfo?: any;
};

type AuthUser = {
  displayName: string;
  email: string;
  tenantId?: string | null;
  platformSuperAdmin?: boolean;
  passwordChangeRequired?: boolean;
  mfaEnabled?: boolean;
  mfaEnrollmentRequired?: boolean;
};

type PushDiagnostics = {
  permission: string;
  expoPushToken: string | null;
  backendRegistered: boolean;
  activeDevices: number;
  latestDevice?: any;
  devices?: any[];
  deliveryLogs?: any[];
  lastSyncedAt: string | null;
  lastTestStatus: string;
};

type BiometricState = {
  available: boolean;
  enrolled: boolean;
  enabled: boolean;
  label: string;
};

type PushPreferences = {
  nyPreSession: boolean;
  validEntries: boolean;
  paperTradeOpened: boolean;
  takeProfitStopLoss: boolean;
  dailyReports: boolean;
  weeklyMonthlyReports: boolean;
  learningReviews: boolean;
  systemDiagnostics: boolean;
};

type NotificationDetail = {
  id?: string | number | null;
  title: string;
  body: string;
  eventType?: string | null;
  priority?: string | null;
  createdAt?: string | null;
  moduleCode?: string | null;
  moduleName?: string | null;
  scenario?: string | null;
  direction?: string | null;
  action?: string | null;
  entry?: string | number | null;
  stopLoss?: string | number | null;
  takeProfit?: string | number | null;
  targets?: any[];
  targetNumber?: string | number | null;
  targetPrice?: string | number | null;
  riskMultiple?: string | number | null;
  rewardToRisk?: string | number | null;
  grade?: string | number | null;
  confidence?: string | number | null;
  setupTier?: string | null;
  variantCode?: string | null;
  variantName?: string | null;
  variantVersion?: string | null;
  setupCandidateId?: string | number | null;
  tradeId?: string | number | null;
  symbol?: string | null;
  finalReason?: string | null;
  status?: string | null;
  eventKey?: string | null;
  mandatoryPassed?: string | number | boolean | null;
  confirmationPassed?: string | number | boolean | null;
  qualityPassed?: string | number | boolean | null;
  missingRules?: string[];
  liquidity?: any;
  displacement?: any;
  bos?: any;
  entryZone?: any;
  category?: string | null;
  issueCode?: string | null;
  recommendedAction?: string | null;
  ageSeconds?: string | number | null;
  exitPrice?: string | number | null;
  resultR?: string | number | null;
  closeReason?: string | null;
  provider?: string | null;
  cacheStatus?: string | null;
  schedulerStatus?: string | null;
  source: "push" | "history";
};

type AppUpdateState = {
  checkedAt: string | null;
  checking: boolean;
  error: string | null;
  updateAvailable: boolean;
  latest: any | null;
};

type ModuleLearningSnapshot = {
  moduleCode: string;
  status: string;
  sample_size?: number;
  sampleSize?: number;
  summary?: any;
  recommendations?: any[];
};

type JournalTrade = {
  id: string;
  module_code?: string;
  symbol?: string;
  direction?: string;
  scenario?: string;
  outcome?: string;
  result_r?: string | number | null;
  actual_entry?: string | number | null;
  actual_stop?: string | number | null;
  actual_target?: string | number | null;
  actual_exit?: string | number | null;
  reward_to_risk?: string | number | null;
  opened_at?: string | null;
  closed_at?: string | null;
  detected_at?: string | null;
  favorability_score?: string | number | null;
  favorability_grade?: string | null;
  final_reason?: string | null;
  scenario_flags?: any;
  targets?: Array<{
    targetNumber: number;
    price: string | number;
    riskMultiple: string | number;
    status: "PENDING" | "HIT" | "CANCELLED";
    hitAt?: string | null;
  }>;
};

type MoreView = "menu" | "profile" | "security" | "push-settings" | "modules" | "chart-preferences" | "session-settings" | "notification-history" | "support" | "app-updates" | "about";

const defaultPushPreferences: PushPreferences = {
  nyPreSession: true,
  validEntries: true,
  paperTradeOpened: true,
  takeProfitStopLoss: true,
  dailyReports: true,
  weeklyMonthlyReports: true,
  learningReviews: false,
  systemDiagnostics: false
};

type ChartCandle = {
  timestampUtc: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  spread?: number | null;
};

type ChartLevel = {
  label: string;
  price: number;
  tone: "good" | "bad" | "warn" | "entry" | "neutral" | string;
};

type ChartPayload = {
  symbol: string;
  moduleCode: string;
  timeframeMinutes: number;
  candles: ChartCandle[];
  levels: ChartLevel[];
  setup?: any;
  trade?: any;
  latestCandleAt?: string | null;
  provider?: string;
  status?: string;
};

type LiveEvent =
  | { type: "connected"; sentAt: string }
  | {
      type: "candle";
      provider: string;
      symbol: string;
      timeframeMinutes: number;
      candle: ChartCandle & { source?: string; receivedAt?: string };
      sentAt: string;
      automation?: unknown;
    };

type MobileTab = "home" | "buySell" | "chart" | "paper" | "more";


const mobileTabs: Array<{ key: MobileTab; label: string }> = [
  { key: "home", label: "Home" },
  { key: "buySell", label: "BUY & SELL" },
  { key: "chart", label: "Live Chart" },
  { key: "paper", label: "Paper Trading" },
  { key: "more", label: "More" }
];

type ErrorBoundaryState = { message: string | null };

class MobileErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: Error) {
    return { message: error.message || "The mobile app hit an unexpected error." };
  }

  componentDidCatch(error: Error) {
    console.error("Mobile app crash boundary", error);
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.loginWrap}>
          <Image source={BRAND_LOGO} style={styles.loginLogo} resizeMode="contain" />
          <Text style={styles.eyebrow}>APP RECOVERY</Text>
          <Text style={styles.loginTitle}>XAUUSD Signal</Text>
          <Text style={styles.loginCopy}>{this.state.message}</Text>
          <Pressable style={styles.loginButton} onPress={() => this.setState({ message: null })}>
            <Text style={styles.loginButtonText}>Try Again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
}

export default function App() {
  return (
    <MobileErrorBoundary>
      <AppContent />
    </MobileErrorBoundary>
  );
}

function AppContent() {
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [token, setToken] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedModuleCode, setSelectedModuleCode] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartPayload | null>(null);
  const [chartsByModule, setChartsByModule] = useState<Record<string, ChartPayload>>({});
  const [selectedCandle, setSelectedCandle] = useState<ChartCandle | null>(null);
  const [chartLoadingModule, setChartLoadingModule] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pushStatus, setPushStatus] = useState("Push not registered");
  const [pushDiagnostics, setPushDiagnostics] = useState<PushDiagnostics>({
    permission: "unknown",
    expoPushToken: null,
    backendRegistered: false,
    activeDevices: 0,
    lastSyncedAt: null,
    lastTestStatus: "Not tested"
  });
  const [pushPreferences, setPushPreferences] = useState<PushPreferences>(defaultPushPreferences);
  const [biometric, setBiometric] = useState<BiometricState>({
    available: false,
    enrolled: false,
    enabled: false,
    label: "Fingerprint"
  });
  const [moreView, setMoreView] = useState<MoreView>("menu");
  const [socketStatus, setSocketStatus] = useState("Socket offline");
  const [activeTab, setActiveTab] = useState<MobileTab>("home");
  const [selectedNotificationDetail, setSelectedNotificationDetail] = useState<NotificationDetail | null>(null);
  const [learningByModule, setLearningByModule] = useState<Record<string, ModuleLearningSnapshot>>({});
  const [learningLoadingModule, setLearningLoadingModule] = useState<string | null>(null);
  const [journalByModule, setJournalByModule] = useState<Record<string, JournalTrade[]>>({});
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    checkedAt: null,
    checking: false,
    error: null,
    updateAvailable: false,
    latest: null
  });
  const selectedModule = useMemo(
    () => dashboard?.modules.find((module) => module.code === selectedModuleCode) ?? dashboard?.modules[0],
    [dashboard?.modules, selectedModuleCode]
  );

  useEffect(() => {
    restoreSession();
  }, []);

  useEffect(() => {
    let handledInitialResponse = false;
    const openFromResponse = (response: any) => {
      const content = response?.notification?.request?.content ?? {};
      const detail = notificationDetailFromPush(content.title, content.body, content.data);
      setSelectedNotificationDetail(detail);
      setActiveTab("more");
      setMoreView("menu");
      handledInitialResponse = true;
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(openFromResponse);
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response && !handledInitialResponse) openFromResponse(response);
      })
      .catch(() => undefined);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!token || authUser?.passwordChangeRequired) return;
    loadDashboard(token, false, true).catch((error) => {
      setLoading(false);
      setPushStatus((error as Error).message || "Dashboard sync failed");
    });
  }, [token, apiBaseUrl, authUser?.passwordChangeRequired]);

  useEffect(() => {
    if (!token || authUser?.passwordChangeRequired || !selectedModuleCode) return;
    loadChart(selectedModuleCode, token).catch((error) => {
      setPushStatus((error as Error).message || "Chart sync failed");
    });
    loadModuleLearning(selectedModuleCode, token).catch(() => undefined);
  }, [token, apiBaseUrl, selectedModuleCode, authUser?.passwordChangeRequired]);

  useEffect(() => {
    if (!token || authUser?.passwordChangeRequired || activeTab !== "more") return;
    checkAppUpdate(false).catch(() => undefined);
  }, [token, apiBaseUrl, activeTab, authUser?.passwordChangeRequired]);

  useEffect(() => {
    if (!token || authUser?.passwordChangeRequired) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (stopped) return;
      setSocketStatus("Socket connecting");
      const wsUrl = apiWebSocketUrl(apiBaseUrl, "/api/live/ws");
      if (!wsUrl) {
        setSocketStatus("Invalid API URL");
        return;
      }
      socket = new WebSocket(wsUrl);
      socket.onopen = () => setSocketStatus("Live socket");
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as LiveEvent;
          if (payload.type === "connected") return;
          if (payload.type !== "candle" || payload.symbol !== "XAUUSD") return;
          setChart((previous) => {
            if (!previous || previous.timeframeMinutes !== payload.timeframeMinutes) return previous;
            return {
              ...previous,
              candles: normalizeCandles([...previous.candles, payload.candle]).slice(-90)
            };
          });
          setChartsByModule((previous) => {
            const next = { ...previous };
            for (const [moduleCode, moduleChart] of Object.entries(previous)) {
              if (moduleChart.timeframeMinutes !== payload.timeframeMinutes) continue;
              next[moduleCode] = {
                ...moduleChart,
                latestCandleAt: payload.candle.timestampUtc,
                candles: normalizeCandles([...moduleChart.candles, payload.candle]).slice(-90)
              };
            }
            return next;
          });
          if (payload.automation) {
            loadDashboard(token, false, true).catch(() => undefined);
          }
        } catch {
          setSocketStatus("Socket message error");
        }
      };
      socket.onerror = () => setSocketStatus("Socket error");
      socket.onclose = () => {
        if (stopped) return;
        setSocketStatus("Socket reconnecting");
        reconnectTimer = setTimeout(connect, 2_000);
      };
    }

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [token, apiBaseUrl, authUser?.passwordChangeRequired]);

  async function restoreSession() {
    const [savedToken, savedApi, savedPushToken, savedPushSyncedAt, savedBiometricEnabled, biometricStatus] = await Promise.all([
      readSecureToken(),
      AsyncStorage.getItem(API_URL_KEY),
      AsyncStorage.getItem(PUSH_TOKEN_KEY),
      AsyncStorage.getItem(PUSH_SYNC_KEY),
      AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY),
      getBiometricStatus()
    ]);
    const biometricEnabled = savedBiometricEnabled === "true" && biometricStatus.available && biometricStatus.enrolled;
    setBiometric({ ...biometricStatus, enabled: biometricEnabled });
    const nextApiBaseUrl = normalizeApiBaseUrl(savedApi);
    if (nextApiBaseUrl) {
      setApiBaseUrl(nextApiBaseUrl);
    } else if (savedApi) {
      await AsyncStorage.removeItem(API_URL_KEY);
    }
    setPushDiagnostics((previous) => ({
      ...previous,
      expoPushToken: savedPushToken,
      lastSyncedAt: savedPushSyncedAt
    }));
    if (savedToken) {
      if (biometricEnabled) {
        const unlocked = await authenticateBiometric("Unlock XAUUSD Signal");
        if (!unlocked) {
          setLoading(false);
          return;
        }
      }
      const restoredUser = await loadMe(savedToken, nextApiBaseUrl ?? apiBaseUrl).catch(() => null);
      if (restoredUser) {
        setAuthUser(restoredUser);
        setToken(savedToken);
      } else {
        await clearSecureToken();
      }
    }
    setLoading(false);
  }

  async function updateBiometricLock(enabled: boolean) {
    const status = await getBiometricStatus();
    if (enabled) {
      if (!status.available || !status.enrolled) {
        Alert.alert("Fingerprint unavailable", "Add fingerprint or face unlock in your phone settings first.");
        setBiometric({ ...status, enabled: false });
        return;
      }
      const unlocked = await authenticateBiometric("Enable fingerprint unlock");
      if (!unlocked) return;
    }
    await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, enabled ? "true" : "false");
    setBiometric({ ...status, enabled });
    Alert.alert(enabled ? "Fingerprint enabled" : "Fingerprint disabled", enabled ? "Your saved mobile session now requires device biometric unlock." : "The saved mobile session no longer requires biometric unlock.");
  }

  async function login(email: string, password: string, otp?: string) {
    const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, otp })
    });
    if (!response.ok) {
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      throw new Error(parsed?.mfaRequired ? "Two-factor code required." : parsed?.message ?? "Invalid tenant login.");
    }
    const payload = await response.json() as { token: string; user: AuthUser };
    if (payload.user?.platformSuperAdmin) throw new Error("Platform admin accounts must use the web platform console.");
    await Promise.all([
      writeSecureToken(payload.token),
      AsyncStorage.setItem(API_URL_KEY, apiBaseUrl)
    ]);
    setAuthUser(payload.user);
    setToken(payload.token);
    if (payload.user?.passwordChangeRequired) return;
    await registerPush(payload.token);
    await loadDashboard(payload.token, true);
    await loadPushDiagnostics(payload.token);
  }

  async function startMfaSetup() {
    if (!token) throw new Error("Login required.");
    const response = await fetch(`${apiBaseUrl}/api/auth/mfa/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error(cleanErrorMessage(await response.text()));
    return response.json() as Promise<{ secret: string; otpAuthUrl: string }>;
  }

  async function enableMfa(otp: string) {
    if (!token) throw new Error("Login required.");
    const response = await fetch(`${apiBaseUrl}/api/auth/mfa/enable`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ otp })
    });
    if (!response.ok) throw new Error(cleanErrorMessage(await response.text()));
    const payload = await response.json() as { token: string; user: AuthUser };
    await writeSecureToken(payload.token);
    setAuthUser(payload.user);
    setToken(payload.token);
    return payload.token;
  }

  async function disableMfa(otp: string) {
    if (!token) throw new Error("Login required.");
    const response = await fetch(`${apiBaseUrl}/api/auth/mfa/disable`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ otp })
    });
    if (!response.ok) throw new Error(cleanErrorMessage(await response.text()));
    const payload = await response.json() as { token: string; user: AuthUser };
    await writeSecureToken(payload.token);
    setAuthUser(payload.user);
    setToken(payload.token);
    return payload.token;
  }

  async function loadMe(authToken: string, baseUrl = apiBaseUrl) {
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error("Session expired.");
    const payload = await response.json() as { user: AuthUser };
    return payload.user;
  }

  async function changeOwnPassword(currentPassword: string, newPassword: string) {
    if (!token) return;
    const response = await fetch(`${apiBaseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json() as { token: string; user: AuthUser };
    await writeSecureToken(payload.token);
    setAuthUser(payload.user);
    setToken(payload.token);
    await registerPush(payload.token);
    await loadDashboard(payload.token, true);
    await loadPushDiagnostics(payload.token);
  }

  async function logout() {
    if (token) {
      fetch(`${apiBaseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({})
      }).catch(() => undefined);
    }
    await clearSecureToken();
    setToken(null);
    setAuthUser(null);
    setDashboard(null);
    setChart(null);
    setChartsByModule({});
    setPushDiagnostics({
      permission: "unknown",
      expoPushToken: null,
      backendRegistered: false,
      activeDevices: 0,
      lastSyncedAt: null,
      lastTestStatus: "Not tested"
    });
  }

  async function loadDashboard(authToken = token, showSpinner = true, syncChart = true) {
    if (!authToken) return;
    if (showSpinner) setLoading(true);
    const response = await fetch(`${apiBaseUrl}/api/mobile/dashboard`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as Dashboard;
    setDashboard(data);
    const nextModuleCode = selectedModuleCode ?? data.modules[0]?.code ?? null;
    if (!selectedModuleCode && nextModuleCode) setSelectedModuleCode(nextModuleCode);
    loadAssignedModuleLearning(data.modules, authToken).catch(() => undefined);
    loadAssignedJournalTrades(data.modules, authToken).catch(() => undefined);
    if (syncChart && nextModuleCode) await loadChart(nextModuleCode, authToken);
    checkAppUpdate(false).catch(() => undefined);
    setLoading(false);
  }

  async function checkAppUpdate(showResult = false) {
    if (Platform.OS !== "android") return;
    setAppUpdate((previous) => ({ ...previous, checking: true, error: null }));
    const response = await fetch(`${apiBaseUrl}/api/mobile/app-update?platform=android&currentVersion=${encodeURIComponent(APP_VERSION)}&currentCode=${encodeURIComponent(String(APP_VERSION_CODE || ""))}`);
    if (!response.ok) {
      const message = await response.text();
      setAppUpdate((previous) => ({ ...previous, checking: false, checkedAt: new Date().toISOString(), error: message || "Update check failed." }));
      if (showResult) Alert.alert("Update check failed", cleanErrorMessage(message));
      return;
    }
    const payload = await response.json() as { updateAvailable?: boolean; latest?: any };
    const latest = payload.latest
      ? { ...payload.latest, downloadUrl: normalizeDownloadUrl(payload.latest.downloadUrl, apiBaseUrl) }
      : null;
    setAppUpdate({
      checkedAt: new Date().toISOString(),
      checking: false,
      error: null,
      updateAvailable: payload.updateAvailable === true,
      latest: latest ?? null
    });
    if (!payload.updateAvailable || !latest?.downloadUrl || !latest?.version_name) {
      if (showResult) Alert.alert("App is up to date", `Installed build ${APP_VERSION_CODE || APP_VERSION} is current.`);
      return;
    }
    const prompted = await AsyncStorage.getItem(UPDATE_PROMPT_KEY);
    if (!showResult && prompted === latest.version_name) return;
    await AsyncStorage.setItem(UPDATE_PROMPT_KEY, latest.version_name);
    Alert.alert(
      `Update ${latest.version_name} available`,
      latest.changelog ? String(latest.changelog) : "A newer XAUUSD Signal APK is available.",
      [
        { text: "Later", style: "cancel" },
        { text: "Install", onPress: () => Linking.openURL(latest.downloadUrl).catch(() => undefined) }
      ]
    );
  }

  async function loadChart(moduleCode: string, authToken = token) {
    if (!authToken) return;
    setChartLoadingModule(moduleCode);
    try {
      const response = await fetch(`${apiBaseUrl}/api/mobile/chart?moduleCode=${encodeURIComponent(moduleCode)}&limit=180`, {
        headers: { authorization: `Bearer ${authToken}` }
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as ChartPayload;
      setChart(data);
      setChartsByModule((previous) => ({ ...previous, [moduleCode]: data }));
      setSelectedCandle(data.candles[data.candles.length - 1] ?? null);
    } finally {
      setChartLoadingModule((current) => current === moduleCode ? null : current);
    }
  }

  async function loadModuleLearning(moduleCode: string, authToken = token) {
    if (!authToken) return;
    const response = await fetch(`${apiBaseUrl}/api/modules/${encodeURIComponent(moduleCode)}/learning/latest`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) return;
    const data = await response.json() as ModuleLearningSnapshot;
    setLearningByModule((previous) => ({ ...previous, [moduleCode]: data }));
  }

  async function loadAssignedModuleLearning(modules: ModuleRow[], authToken = token) {
    if (!authToken || modules.length === 0) return;
    const entries = await Promise.all(
      modules.map(async (module) => {
        const response = await fetch(`${apiBaseUrl}/api/modules/${encodeURIComponent(module.code)}/learning/latest`, {
          headers: { authorization: `Bearer ${authToken}` }
        });
        if (!response.ok) return null;
        const data = await response.json() as ModuleLearningSnapshot;
        return [module.code, data] as const;
      })
    );
    setLearningByModule((previous) => {
      const next = { ...previous };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }

  async function loadAssignedJournalTrades(modules: ModuleRow[], authToken = token) {
    if (!authToken || modules.length === 0) return;
    const entries = await Promise.all(
      modules.map(async (module) => {
        const response = await fetch(`${apiBaseUrl}/api/modules/${encodeURIComponent(module.code)}/journal/trades?limit=12`, {
          headers: { authorization: `Bearer ${authToken}` }
        });
        if (!response.ok) return null;
        const data = await response.json() as JournalTrade[];
        return [module.code, data] as const;
      })
    );
    setJournalByModule((previous) => {
      const next = { ...previous };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }

  async function runModuleLearning(moduleCode: string) {
    if (!token) return;
    setLearningLoadingModule(moduleCode);
    try {
      const response = await fetch(`${apiBaseUrl}/api/modules/${encodeURIComponent(moduleCode)}/learning/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({})
      });
      if (!response.ok) throw new Error(cleanErrorMessage(await response.text()));
      const data = await response.json() as ModuleLearningSnapshot;
      setLearningByModule((previous) => ({ ...previous, [moduleCode]: data }));
      Alert.alert("Learning complete", `${moduleDisplayName(moduleCode)} reviewed ${data.sample_size ?? data.sampleSize ?? 0} result(s).`);
    } finally {
      setLearningLoadingModule(null);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await loadDashboard(token, false);
      if (selectedModuleCode) await loadChart(selectedModuleCode, token);
    } catch (error) {
      Alert.alert("Refresh failed", (error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  async function registerPush(authToken = token) {
    if (!authToken) return;
    if (!Device.isDevice) {
      setPushStatus("Push requires a real device");
      setPushDiagnostics((previous) => ({ ...previous, permission: "real device required" }));
      return;
    }
    try {
      const existing = await Notifications.getPermissionsAsync();
      const permission = existing.granted ? existing : await Notifications.requestPermissionsAsync();
      setPushDiagnostics((previous) => ({ ...previous, permission: permission.status ?? (permission.granted ? "granted" : "denied") }));
      if (!permission.granted) {
        setPushStatus("Push permission denied");
        return;
      }
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      const [tokenResult, deviceTokenResult] = await Promise.all([
        Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined).catch(() => null),
        Notifications.getDevicePushTokenAsync().catch(() => null)
      ]);
      const expoPushToken = tokenResult?.data ?? "";
      const fcmToken = Platform.OS === "android" ? String(deviceTokenResult?.data ?? "") : "";
      if (!expoPushToken && !fcmToken) throw new Error("No Expo or Firebase push token was returned by this build.");
      const response = await fetch(`${apiBaseUrl}/api/mobile/push-token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`
        },
        body: JSON.stringify({
          expoPushToken: expoPushToken || undefined,
          fcmToken: fcmToken || undefined,
          platform: Platform.OS,
          deviceName: Device.deviceName ?? `${Platform.OS} device`
        })
      });
      if (!response.ok) throw new Error(await response.text());
      const syncedAt = new Date().toISOString();
      await Promise.all([
        AsyncStorage.setItem(PUSH_TOKEN_KEY, expoPushToken),
        AsyncStorage.setItem(PUSH_SYNC_KEY, syncedAt)
      ]);
      setPushStatus("Push alerts active");
      setPushDiagnostics((previous) => ({
        ...previous,
        expoPushToken: expoPushToken || fcmToken,
        lastSyncedAt: syncedAt,
        backendRegistered: true
      }));
      await loadPushDiagnostics(authToken);
    } catch (error) {
      const message = (error as Error).message || "Push setup failed";
      setPushStatus(message.includes("projectId") ? "Push setup needs Expo project" : "Push setup failed");
      setPushDiagnostics((previous) => ({ ...previous, lastTestStatus: message }));
    }
  }

  async function loadPushDiagnostics(authToken = token) {
    if (!authToken) return;
    const permission = await Notifications.getPermissionsAsync().catch(() => null);
    const response = await fetch(`${apiBaseUrl}/api/mobile/push-status`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) return;
    const status = await response.json();
    setPushDiagnostics((previous) => ({
      ...previous,
      permission: permission?.status ?? previous.permission,
      backendRegistered: status.registered === true,
      activeDevices: Number(status.activeDevices ?? 0),
      latestDevice: status.latestDevice ?? null,
      devices: status.devices ?? [],
      deliveryLogs: status.deliveryLogs ?? []
    }));
    if (status.preferences) setPushPreferences(normalizePushPreferences(status.preferences));
  }

  async function savePushPreferences(nextPreferences: PushPreferences) {
    if (!token) return;
    setPushPreferences(nextPreferences);
    const response = await fetch(`${apiBaseUrl}/api/mobile/push-preferences`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ preferences: nextPreferences })
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    setPushPreferences(normalizePushPreferences(result.preferences));
  }

  async function submitSupportTicket(input: { ticketType: string; title: string; description: string; requestedModuleCode?: string | null }) {
    if (!token) return;
    const response = await fetch(`${apiBaseUrl}/api/tenant/support-tickets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error(await response.text());
    await loadDashboard(token, false, false);
  }

  async function sendTestPush() {
    if (!token) return;
    setPushDiagnostics((previous) => ({ ...previous, lastTestStatus: "Sending..." }));
    const response = await fetch(`${apiBaseUrl}/api/mobile/test-push`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const message = await response.text();
      setPushDiagnostics((previous) => ({ ...previous, lastTestStatus: "Failed" }));
      throw new Error(message);
    }
    const result = await response.json();
    const sent = Number(result?.push?.sent ?? 0);
    const status = sent > 0 ? `Sent to ${sent} device${sent === 1 ? "" : "s"}` : "No active token";
    setPushDiagnostics((previous) => ({ ...previous, lastTestStatus: status }));
    await loadDashboard(token, false, false);
  }

  async function disablePushDevice(deviceId: string) {
    if (!token) return;
    const response = await fetch(`${apiBaseUrl}/api/mobile/push-devices/${deviceId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(await response.text());
    await loadPushDiagnostics(token);
  }

  async function acknowledgeNotification(id?: string | number | null) {
    if (!token || id == null) return;
    fetch(`${apiBaseUrl}/api/notifications/${encodeURIComponent(String(id))}/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    }).catch(() => undefined);
  }

  if (loading && !dashboard && token) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.loading}>
          <ActivityIndicator color="#21d6a2" />
          <Text style={styles.muted}>Loading trading dashboard...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!token) {
    return <LoginScreen onLogin={login} />;
  }

  if (authUser?.passwordChangeRequired) {
    return <RequiredPasswordChangeScreen user={authUser} onChangePassword={changeOwnPassword} onLogout={logout} />;
  }

  const activeSignals = dashboard?.modules.filter((module) => signalLabel(module).label !== "WAIT").length ?? 0;
  const latestAlert = dashboard?.notifications?.[0];
  if (selectedNotificationDetail) {
    return (
      <NotificationDetailScreen
        detail={selectedNotificationDetail}
        dashboard={dashboard}
        onBack={() => setSelectedNotificationDetail(null)}
        onOpenChart={(moduleCode) => {
          setSelectedNotificationDetail(null);
          setActiveTab("chart");
          setSelectedModuleCode(moduleCode);
          loadChart(moduleCode).catch((error) => Alert.alert("Chart failed", error.message));
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl tintColor="#21d6a2" refreshing={refreshing} onRefresh={refresh} />}
      >
        <View style={styles.topBar}>
          <View style={styles.searchBox}>
            <Image source={BRAND_MARK} style={styles.headerMark} resizeMode="contain" />
            <Text style={styles.searchText}>XAUUSD New York strategies</Text>
          </View>
          <Pressable style={styles.roundIconButton} onPress={() => registerPush().catch((error) => Alert.alert("Push failed", error.message))}>
            <Text style={styles.roundIconText}>{activeSignals > 0 ? String(activeSignals) : "!"}</Text>
          </Pressable>
        </View>

        {activeTab === "home" ? (
          <HomeScreen
            dashboard={dashboard}
            activeSignals={activeSignals}
            latestAlert={latestAlert}
            pushStatus={pushStatus}
            socketStatus={socketStatus}
            appUpdate={appUpdate}
            onOpenAlerts={() => {
              setActiveTab("more");
              setMoreView("notification-history");
            }}
            onOpenSignals={() => setActiveTab("buySell")}
            onOpenChart={() => setActiveTab("chart")}
            onOpenUpdates={() => {
              setActiveTab("more");
              setMoreView("app-updates");
            }}
          />
        ) : null}

        {activeTab === "buySell" ? (
          <BuySellScreen
            dashboard={dashboard}
            selectedModuleCode={selectedModule?.code ?? null}
            learningByModule={learningByModule}
            learningLoadingModule={learningLoadingModule}
            onRunLearning={(moduleCode) => runModuleLearning(moduleCode).catch((error) => Alert.alert("Learning failed", error.message))}
            onSelectModule={(moduleCode) => {
              setSelectedModuleCode(moduleCode);
              loadChart(moduleCode).catch((error) => Alert.alert("Chart failed", error.message));
            }}
          />
        ) : null}

        {activeTab === "chart" ? (
          <ChartScreen
            dashboard={dashboard}
            selectedModule={selectedModule}
            learning={selectedModule ? learningByModule[selectedModule.code] : undefined}
            learningBusy={selectedModule ? learningLoadingModule === selectedModule.code : false}
            chart={selectedModule ? (chart?.moduleCode === selectedModule.code ? chart : chartsByModule[selectedModule.code] ?? null) : null}
            chartLoading={selectedModule ? chartLoadingModule === selectedModule.code : false}
            selectedCandle={selectedCandle}
            setSelectedCandle={setSelectedCandle}
            onRunLearning={(moduleCode) => runModuleLearning(moduleCode).catch((error) => Alert.alert("Learning failed", error.message))}
            onSelectModule={(moduleCode) => {
              setSelectedModuleCode(moduleCode);
              loadChart(moduleCode).catch((error) => Alert.alert("Chart failed", error.message));
            }}
          />
        ) : null}

        {activeTab === "paper" ? <PaperTradingScreen dashboard={dashboard} journalByModule={journalByModule} /> : null}

        {activeTab === "more" ? (
          <MoreScreen
            dashboard={dashboard}
            apiBaseUrl={apiBaseUrl}
            pushStatus={pushStatus}
            pushDiagnostics={pushDiagnostics}
            pushPreferences={pushPreferences}
            biometric={biometric}
            appUpdate={appUpdate}
            view={moreView}
            setView={setMoreView}
            socketStatus={socketStatus}
            onCheckAppUpdate={() => checkAppUpdate(true).catch((error) => Alert.alert("Update check failed", error.message))}
            onToggleBiometric={(enabled) => updateBiometricLock(enabled).catch((error) => Alert.alert("Fingerprint failed", error.message))}
            onRegisterPush={() => registerPush().catch((error) => Alert.alert("Push failed", error.message))}
            onTestPush={() => sendTestPush().catch((error) => Alert.alert("Test push failed", error.message))}
            onDisablePushDevice={(deviceId) => disablePushDevice(deviceId).catch((error) => Alert.alert("Disable failed", error.message))}
            onSavePushPreferences={(preferences) => savePushPreferences(preferences).catch((error) => Alert.alert("Save failed", error.message))}
            onStartMfa={startMfaSetup}
            onEnableMfa={(otp) => enableMfa(otp).then((nextToken) => loadDashboard(nextToken, false, false)).then(() => Alert.alert("2FA enabled", "Your next login will require a 6-digit code.")).catch((error) => Alert.alert("2FA failed", error.message))}
            onDisableMfa={(otp) => disableMfa(otp).then((nextToken) => loadDashboard(nextToken, false, false)).then(() => Alert.alert("2FA disabled", "Two-factor authentication is now disabled.")).catch((error) => Alert.alert("2FA failed", error.message))}
            onCreateTicket={(input) => submitSupportTicket(input).then(() => Alert.alert("Ticket submitted", "Platform support will review your request.")).catch((error) => Alert.alert("Ticket failed", error.message))}
            onOpenNotification={(item) => {
              setSelectedNotificationDetail(notificationDetailFromHistory(item, dashboard));
              acknowledgeNotification(item.id);
            }}
          />
        ) : null}

      </ScrollView>
      <View style={styles.bottomNav}>
        {mobileTabs.map((tab) => (
          <Pressable key={tab.key} style={styles.bottomNavItem} onPress={() => setActiveTab(tab.key)}>
            <View style={styles.bottomNavIcon}>
              <BottomNavIcon tab={tab.key} active={activeTab === tab.key} />
            </View>
            <Text style={[styles.bottomNavText, activeTab === tab.key && styles.bottomNavTextActive]}>{tab.label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

async function readSecureToken() {
  const secureToken = await SecureStore.getItemAsync(TOKEN_KEY);
  if (secureToken) return secureToken;
  const legacyToken = await AsyncStorage.getItem(TOKEN_KEY);
  if (!legacyToken) return null;
  await SecureStore.setItemAsync(TOKEN_KEY, legacyToken, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
  });
  await AsyncStorage.removeItem(TOKEN_KEY);
  return legacyToken;
}

async function writeSecureToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
  });
  await AsyncStorage.removeItem(TOKEN_KEY);
}

async function clearSecureToken() {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    AsyncStorage.removeItem(TOKEN_KEY)
  ]);
}

async function getBiometricStatus(): Promise<Omit<BiometricState, "enabled">> {
  const [available, enrolled, supportedTypes] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => [])
  ]);
  const label = biometricLabel(supportedTypes);
  return { available, enrolled, label };
}

async function authenticateBiometric(promptMessage: string) {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: "Use password",
    disableDeviceFallback: false
  });
  return result.success === true;
}

function biometricLabel(types: LocalAuthentication.AuthenticationType[]) {
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return "Face unlock";
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return "Fingerprint";
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return "Iris unlock";
  return "Biometric";
}

function LoginScreen({ onLogin }: { onLogin: (email: string, password: string, otp?: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.loginWrap}>
        <Image source={BRAND_LOGO} style={styles.loginLogo} resizeMode="contain" />
        <Text style={styles.eyebrow}>PAPER TRADING ONLY</Text>
        <Text style={styles.loginTitle}>XAUUSD Signal</Text>
        <Text style={styles.loginCopy}>Tenant mobile companion for NY session indicators, module alerts, and paper-trade entry details.</Text>
        <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} placeholder="Tenant email" placeholderTextColor="#6f7b75" />
        <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor="#6f7b75" />
        {showOtp ? <TextInput style={styles.input} keyboardType="number-pad" value={otp} onChangeText={(value) => setOtp(value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit two-factor code" placeholderTextColor="#6f7b75" /> : null}
        <Pressable
          style={styles.loginButton}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await onLogin(email, password, otp);
            } catch (error) {
              const message = (error as Error).message;
              if (message.includes("Two-factor")) setShowOtp(true);
              Alert.alert("Login failed", cleanErrorMessage(message));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Text style={styles.loginButtonText}>{busy ? "Signing in..." : "Sign In"}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function RequiredPasswordChangeScreen({
  user,
  onChangePassword,
  onLogout
}: {
  user: AuthUser;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.loginWrap}>
        <Image source={BRAND_LOGO} style={styles.loginLogo} resizeMode="contain" />
        <Text style={styles.eyebrow}>FIRST LOGIN SECURITY</Text>
        <Text style={styles.loginTitle}>Change Password</Text>
        <Text style={styles.loginCopy}>A temporary password was created for {user.email}. Set your own password before opening the dashboard.</Text>
        <TextInput style={styles.input} secureTextEntry value={currentPassword} onChangeText={setCurrentPassword} placeholder="Temporary password" placeholderTextColor="#6f7b75" />
        <TextInput style={styles.input} secureTextEntry value={newPassword} onChangeText={setNewPassword} placeholder="New password" placeholderTextColor="#6f7b75" />
        <TextInput style={styles.input} secureTextEntry value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Confirm new password" placeholderTextColor="#6f7b75" />
        <Text style={styles.passwordHint}>Use at least 12 characters with uppercase, lowercase, number, and symbol.</Text>
        <Pressable
          style={styles.loginButton}
          disabled={busy}
          onPress={async () => {
            if (newPassword !== confirmPassword) {
              Alert.alert("Password mismatch", "New password and confirmation do not match.");
              return;
            }
            setBusy(true);
            try {
              await onChangePassword(currentPassword, newPassword);
            } catch (error) {
              Alert.alert("Password change failed", cleanErrorMessage((error as Error).message));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Text style={styles.loginButtonText}>{busy ? "Changing..." : "Change Password"}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onLogout}>
          <Text style={styles.secondaryButtonText}>Logout</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function HomeScreen({
  dashboard,
  activeSignals,
  latestAlert,
  pushStatus,
  socketStatus,
  appUpdate,
  onOpenAlerts,
  onOpenSignals,
  onOpenChart,
  onOpenUpdates
}: {
  dashboard: Dashboard | null;
  activeSignals: number;
  latestAlert: any;
  pushStatus: string;
  socketStatus: string;
  appUpdate: AppUpdateState;
  onOpenAlerts: () => void;
  onOpenSignals: () => void;
  onOpenChart: () => void;
  onOpenUpdates: () => void;
}) {
  const modules = dashboard?.modules ?? [];
  const bestModule = modules.find((module) => signalLabel(module).label !== "WAIT") ?? modules[0];
  const latestUpdate = appUpdate.latest;
  return (
    <>
      <View style={styles.portfolioCard}>
        <View style={styles.cardGlow} />
        <View style={styles.heroTopRow}>
          <View>
            <Text style={styles.heroLabel}>Today's NY posture</Text>
            <Text style={styles.heroValue}>{activeSignals > 0 ? `${activeSignals} ALERT` : "WAITING"}</Text>
            <Text style={[styles.heroSub, activeSignals > 0 && styles.positiveText]}>{pushStatus}</Text>
          </View>
          <View style={styles.sessionBadge}>
            <Text style={styles.sessionBadgeText}>{socketStatus.replace("Socket ", "")}</Text>
          </View>
        </View>

        <View style={styles.quickActions}>
          {[
            ["Modules", String(modules.length), "signals"],
            ["NY Time", dashboard?.clocks.newYork ?? "--", "time"],
            ["Nepal", dashboard?.clocks.nepal ?? "--", "time"],
            ["Plan", dashboard?.tenant?.plan_name ?? "Active", "account"]
          ].map(([label, value, icon]) => (
            <View key={label} style={styles.quickAction}>
              <View style={styles.quickActionIcon}><MiniIcon name={icon} /></View>
              <Text style={styles.quickActionLabel}>{label}</Text>
              <Text style={styles.quickActionValue} numberOfLines={1}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      {appUpdate.updateAvailable && latestUpdate ? (
        <Pressable style={styles.updateBanner} onPress={onOpenUpdates}>
          <View style={styles.updateBannerIcon}>
            <MiniIcon name="chart" />
          </View>
          <View style={styles.updateBannerContent}>
            <Text style={styles.updateBannerTitle}>App update available</Text>
            <Text style={styles.updateBannerCopy} numberOfLines={2}>
              Version {latestUpdate.version_name ?? "--"} ({latestUpdate.version_code ?? "--"}) · {latestUpdate.changelog || "Open release notes and download the latest APK."}
            </Text>
          </View>
          <Text style={styles.updateBannerAction}>Install</Text>
        </Pressable>
      ) : null}

      <View style={styles.homeActionGrid}>
        <Pressable style={styles.homeActionCard} onPress={onOpenSignals}>
          <View style={styles.homeActionIcon}><MiniIcon name="signals" /></View>
          <Text style={styles.homeActionTitle}>BUY & SELL</Text>
          <Text style={styles.homeActionCopy}>Validated module entries with SL and TP.</Text>
        </Pressable>
        <Pressable style={styles.homeActionCard} onPress={onOpenChart}>
          <View style={styles.homeActionIcon}><MiniIcon name="chart" /></View>
          <Text style={styles.homeActionTitle}>Live Chart</Text>
          <Text style={styles.homeActionCopy}>Shared candle feed with module levels.</Text>
        </Pressable>
      </View>

      <SectionTitle title="Module Watch" />
      <View style={styles.card}>
        {modules.slice(0, 3).map((module) => {
          const signal = signalLabel(module);
          return (
            <View key={module.code} style={styles.homeModuleRow}>
              <View>
                <Text style={styles.ruleTitle}>{module.shortName}</Text>
                <Text style={styles.muted}>{moduleTimingLabel(module)}</Text>
              </View>
              <Text style={[styles.homeModuleSignal, signal.tone === "good" ? styles.goodText : signal.tone === "bad" ? styles.badText : styles.warnText]}>{signal.label}</Text>
            </View>
          );
        })}
        {modules.length === 0 ? <Text style={styles.muted}>No modules assigned yet.</Text> : null}
      </View>

      <SectionTitle title="Latest Alert" />
      {latestAlert ? (
        <Pressable style={styles.statementCard} onPress={onOpenAlerts}>
          <View style={styles.statementIcon}><MiniIcon name="alerts" /></View>
          <View style={styles.statementContent}>
            <Text style={styles.statementTitle} numberOfLines={1}>{latestAlert.title}</Text>
            <Text style={styles.statementSub} numberOfLines={1}>{latestAlert.body}</Text>
          </View>
          <Text style={styles.statementArrow}>{">"}</Text>
        </Pressable>
      ) : (
        <EmptyCard text={bestModule ? "No new alerts. Assigned modules are waiting for valid session setups." : "No alerts yet."} />
      )}
    </>
  );
}

function BuySellScreen({
  dashboard,
  selectedModuleCode,
  learningByModule,
  learningLoadingModule,
  onRunLearning,
  onSelectModule
}: {
  dashboard: Dashboard | null;
  selectedModuleCode: string | null;
  learningByModule: Record<string, ModuleLearningSnapshot>;
  learningLoadingModule: string | null;
  onRunLearning: (moduleCode: string) => void;
  onSelectModule: (moduleCode: string) => void;
}) {
  const modules = dashboard?.modules ?? [];
  const selectedModule = modules.find((module) => module.code === selectedModuleCode) ?? modules[0];
  const [horizon, setHorizon] = useState<"short" | "long">("short");
  const [detailModuleCode, setDetailModuleCode] = useState<string | null>(null);
  const actionableModules = modules.filter(isActionableModule);
  const longModules = actionableModules.filter(isFullChecklistModule);
  const visibleModules = horizon === "long"
    ? longModules.slice(0, 1)
    : actionableModules;
  const selectedDetailModule = visibleModules.find((module) => module.code === detailModuleCode) ?? null;
  if (selectedDetailModule) {
    return (
      <BuySellSetupDetail
        module={selectedDetailModule}
        horizon={horizon}
        onBack={() => setDetailModuleCode(null)}
        onOpenChart={() => onSelectModule(selectedDetailModule.code)}
      />
    );
  }
  return (
    <>
      <View style={styles.clockGrid}>
        <Metric label="New York" value={dashboard?.clocks.newYork ?? "--"} />
        <Metric label="Nepal" value={dashboard?.clocks.nepal ?? "--"} />
      </View>

      <SectionTitle title="BUY & SELL" />
      <View style={styles.horizonTabs}>
        <Pressable style={[styles.horizonTab, horizon === "short" && styles.horizonTabActive]} onPress={() => setHorizon("short")}>
          <Text style={[styles.horizonTabText, horizon === "short" && styles.horizonTabTextActive]}>Short</Text>
          <Text style={styles.horizonTabMeta}>Intraday TP1/TP2/TP3</Text>
        </Pressable>
        <Pressable style={[styles.horizonTab, horizon === "long" && styles.horizonTabActive]} onPress={() => setHorizon("long")}>
          <Text style={[styles.horizonTabText, horizon === "long" && styles.horizonTabTextActive]}>Long</Text>
          <Text style={styles.horizonTabMeta}>Full checklist setup</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.compactModuleTabs}>
        {modules.map((module) => {
          const signal = signalLabel(module);
          return (
            <Pressable
              key={module.code}
              style={[styles.compactModuleTab, selectedModule?.code === module.code && styles.compactModuleTabActive]}
              onPress={() => onSelectModule(module.code)}
            >
              <Text style={[styles.compactModuleText, selectedModule?.code === module.code && styles.compactModuleTextActive]}>{module.shortName}</Text>
              <Text style={[styles.compactModuleMeta, signal.tone === "good" ? styles.goodText : signal.tone === "bad" ? styles.badText : styles.warnText]}>{signal.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {visibleModules.map((module) => (
        <Pressable key={module.code} onPress={() => setDetailModuleCode(module.code)}>
          <BuySellSetupCard module={module} horizon={horizon} />
        </Pressable>
      ))}
      {visibleModules.length === 0 ? (
        <EmptyCard text={horizon === "long" ? "No full-checklist BUY or SELL setup is validated right now." : "No validated BUY or SELL setup right now."} />
      ) : null}
      {selectedModule ? (
        <ModuleDetail
          module={selectedModule}
          learning={learningByModule[selectedModule.code]}
          learningBusy={learningLoadingModule === selectedModule.code}
          onRunLearning={onRunLearning}
        />
      ) : null}
      {modules.length === 0 ? <EmptyCard text="No strategy modules are assigned to this tenant account." /> : null}
    </>
  );
}

function BuySellSetupCard({ module, horizon }: { module: ModuleRow; horizon: "short" | "long" }) {
  const setup = module.currentSetup ?? {};
  const trade = module.currentTrade ?? {};
  const signal = signalLabel(module);
  const direction = trade.direction ?? setup.direction ?? "--";
  const action = tradeAction(direction, signal.label);
  const entry = trade.actual_entry ?? setup.entry_price;
  const stopLoss = trade.actual_stop ?? setup.stop_price;
  const mainTarget = trade.actual_target ?? setup.target_price ?? setup.take_profit;
  const targetLadder = dayTradingTargets(entry, stopLoss, mainTarget, direction, trade.targets);
  return (
    <View style={[styles.tradeSetupCard, action === "SELL" && styles.tradeSetupCardSell]}>
      <View style={styles.tradeSetupTop}>
        <View>
          <Text style={styles.tradeSetupModule}>{module.shortName}</Text>
          <Text style={styles.tradeSetupTitle}>{action} {horizon === "long" ? "full checklist" : "intraday setup"}</Text>
          <Text style={styles.ruleExplanation}>{setup.scenario ? formatScenarioName(String(setup.scenario)) : moduleTimingLabel(module)}</Text>
        </View>
        <View style={[styles.signalPill, action === "SELL" ? styles.badPill : styles.goodPill]}>
          <Text style={styles.signalText}>{action}</Text>
        </View>
      </View>
      <View style={styles.metricsGrid}>
        <Metric label="Entry Range" value={entryRangeLabel(setup, entry)} />
        <Metric label="SL" value={formatPrice(stopLoss)} />
        {horizon === "long" ? (
          <Metric label="Main TP" value={formatPrice(mainTarget ?? targetLadder.tp2)} />
        ) : (
          <>
            <Metric label={`TP1 1R${targetLadder.statuses[0] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp1)} />
            <Metric label={`TP2 1.5R${targetLadder.statuses[1] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp2)} />
            <Metric label={`TP3 ${targetLadder.finalRLabel}${targetLadder.statuses[2] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp3)} />
          </>
        )}
        <Metric label="RR" value={formatDetailValue(trade.reward_to_risk ?? setup.reward_to_risk)} />
        <Metric label="Setup Score" value={setupScoreLabel(setup)} />
      </View>
      <Text style={styles.noticeTime}>Tap for checklist evidence and trade plan.</Text>
    </View>
  );
}

function BuySellSetupDetail({
  module,
  horizon,
  onBack,
  onOpenChart
}: {
  module: ModuleRow;
  horizon: "short" | "long";
  onBack: () => void;
  onOpenChart: () => void;
}) {
  const setup = module.currentSetup ?? {};
  const trade = module.currentTrade ?? {};
  const signal = signalLabel(module);
  const direction = trade.direction ?? setup.direction ?? "--";
  const action = tradeAction(direction, signal.label);
  const entry = trade.actual_entry ?? setup.entry_price;
  const stopLoss = trade.actual_stop ?? setup.stop_price;
  const mainTarget = trade.actual_target ?? setup.target_price ?? setup.take_profit;
  const targetLadder = dayTradingTargets(entry, stopLoss, mainTarget, direction, trade.targets);
  const groupedRules = groupedChecklist(setup.evaluations ?? [], module.code);
  return (
    <>
      <View style={styles.detailTopBar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.detailPill}>{horizon === "long" ? "FULL CHECKLIST" : "INTRADAY"}</Text>
      </View>
      <View style={[styles.tradeSetupCard, action === "SELL" && styles.tradeSetupCardSell]}>
        <Text style={styles.eyebrow}>{module.shortName}</Text>
        <Text style={styles.detailTitle}>{action} XAUUSD</Text>
        <Text style={styles.detailBody}>{setup.final_reason ?? signal.reason}</Text>
        <View style={styles.metricsGrid}>
          <Metric label="Entry Range" value={entryRangeLabel(setup, entry)} />
          <Metric label="Entry" value={formatPrice(entry)} />
          <Metric label="Stop Loss" value={formatPrice(stopLoss)} />
          {horizon === "long" ? (
            <Metric label="Main TP" value={formatPrice(mainTarget)} />
          ) : (
            <>
              <Metric label={`TP1 1R${targetLadder.statuses[0] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp1)} />
              <Metric label={`TP2 1.5R${targetLadder.statuses[1] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp2)} />
              <Metric label={`TP3 ${targetLadder.finalRLabel}${targetLadder.statuses[2] === "HIT" ? " · HIT" : ""}`} value={formatPrice(targetLadder.tp3)} />
            </>
          )}
          <Metric label="RR" value={formatDetailValue(trade.reward_to_risk ?? setup.reward_to_risk)} />
          <Metric label="Setup Score" value={setupScoreLabel(setup)} />
          <Metric label="Grade" value={formatDetailValue(setup.trade_grade ?? setup.favorability_grade)} />
          <Metric label="Paper" value={trade.outcome ?? "READY"} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionMini}>Checklist Evidence</Text>
        {groupedRules.map((group) => (
          <View key={group.title} style={styles.checklistGroup}>
            <View style={styles.checklistGroupHeader}>
              <Text style={styles.checklistGroupTitle}>{group.title}</Text>
              <Text style={styles.checklistGroupMeta}>{group.summary}</Text>
            </View>
            {group.rules.map((rule: any) => (
              <View key={rule.rule_code ?? rule.ruleCode ?? rule.name} style={styles.ruleRow}>
                <Text style={[styles.ruleStatus, ruleStatusTone(rule.status)]}>{shortRuleStatus(rule.status)}</Text>
                <View style={styles.ruleBody}>
                  <Text style={styles.ruleTitle}>{rule.name}</Text>
                  <Text style={styles.ruleExplanation}>{rule.explanation}</Text>
                </View>
              </View>
            ))}
          </View>
        ))}
        {groupedRules.length === 0 ? <Text style={styles.muted}>No checklist evidence is attached to this setup yet.</Text> : null}
        <Pressable style={styles.fullButton} onPress={onOpenChart}>
          <Text style={styles.fullButtonText}>Open Live Chart</Text>
        </Pressable>
      </View>
    </>
  );
}

function ChartScreen({
  dashboard,
  selectedModule,
  learning,
  learningBusy,
  chart,
  chartLoading,
  selectedCandle,
  setSelectedCandle,
  onRunLearning,
  onSelectModule
}: {
  dashboard: Dashboard | null;
  selectedModule?: ModuleRow;
  learning?: ModuleLearningSnapshot;
  learningBusy: boolean;
  chart: ChartPayload | null;
  chartLoading: boolean;
  selectedCandle: ChartCandle | null;
  setSelectedCandle: (candle: ChartCandle) => void;
  onRunLearning: (moduleCode: string) => void;
  onSelectModule: (moduleCode: string) => void;
}) {
  return (
    <>
      <SectionTitle title="Live Chart" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.compactModuleTabs}>
        {(dashboard?.modules ?? []).map((module) => (
          <Pressable
            key={module.code}
            style={[styles.compactModuleTab, selectedModule?.code === module.code && styles.compactModuleTabActive]}
            onPress={() => onSelectModule(module.code)}
          >
            <Text style={[styles.compactModuleText, selectedModule?.code === module.code && styles.compactModuleTextActive]}>{module.shortName}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {selectedModule ? (
        <MobileCandlestickChart chart={chart} loading={chartLoading} selectedCandle={selectedCandle} onSelectCandle={setSelectedCandle} />
      ) : (
        <EmptyCard text="No strategy module is selected." />
      )}
      {selectedModule ? <ModuleDetail module={selectedModule} learning={learning} learningBusy={learningBusy} onRunLearning={onRunLearning} /> : null}
    </>
  );
}

function PaperTradingScreen({ dashboard, journalByModule }: { dashboard: Dashboard | null; journalByModule: Record<string, JournalTrade[]> }) {
  const modules = dashboard?.modules ?? [];
  const allTrades = modules.flatMap((module) => journalByModule[module.code] ?? []);
  const decidedTrades = allTrades.filter((trade) => ["WIN", "LOSS", "BREAKEVEN"].includes(String(trade.outcome ?? "")));
  const wins = decidedTrades.filter((trade) => trade.outcome === "WIN").length;
  const totalR = allTrades.reduce((sum, trade) => sum + Number(trade.result_r ?? 0), 0);
  return (
    <>
      <SectionTitle title="Paper Trading" />
      <View style={styles.card}>
        <Text style={styles.sectionMini}>Performance Summary</Text>
        <View style={styles.metricsGrid}>
          <Metric label="Trades" value={allTrades.length} />
          <Metric label="Win Rate" value={decidedTrades.length ? formatPercent(wins / decidedTrades.length) : "--"} />
          <Metric label="Total R" value={formatR(totalR)} />
          <Metric label="Active" value={allTrades.filter((trade) => trade.outcome === "ACTIVE").length} />
        </View>
      </View>
      {modules.map((module) => {
        const trades = journalByModule[module.code] ?? [];
        return (
          <View key={module.code} style={styles.card}>
            <View style={styles.moduleHeader}>
              <View>
                <Text style={styles.cardTitle}>{module.shortName}</Text>
                <Text style={styles.muted}>{module.name}</Text>
              </View>
              <View style={styles.journalStats}>
                <Text style={styles.journalValue}>{formatPercent(module.weekly?.winRate)}</Text>
                <Text style={styles.journalLabel}>Week WR</Text>
              </View>
            </View>
            {trades.slice(0, 8).map((trade) => (
              <JournalTradeCard key={trade.id} trade={trade} module={module} />
            ))}
            {trades.length === 0 ? <Text style={styles.muted}>No paper trades recorded for this module yet.</Text> : null}
          </View>
        );
      })}
      {modules.length === 0 ? <EmptyCard text="No strategy modules are assigned to this tenant account." /> : null}
    </>
  );
}

function JournalTradeCard({ trade, module }: { trade: JournalTrade; module: ModuleRow }) {
  const setupTier = String(trade.scenario_flags?.setupTier ?? "FULL");
  const variant = trade.scenario_flags?.module2Variant?.name ?? trade.scenario_flags?.variantCode ?? null;
  const outcome = String(trade.outcome ?? "ACTIVE");
  return (
    <View style={styles.journalTradeCard}>
      <View style={styles.journalTradeTop}>
        <View>
          <Text style={styles.ruleTitle}>{trade.direction ?? "--"} · {setupTier}</Text>
          <Text style={styles.ruleExplanation}>{formatScenarioName(String(trade.scenario ?? "VALID_SETUP"))}</Text>
        </View>
        <View style={[styles.signalPill, outcome === "WIN" ? styles.goodPill : outcome === "LOSS" ? styles.badPill : styles.warnPill]}>
          <Text style={styles.signalText}>{outcome}</Text>
        </View>
      </View>
      <View style={styles.metricsGrid}>
        <Metric label="Entry" value={formatPrice(trade.actual_entry)} />
        <Metric label="SL" value={formatPrice(trade.actual_stop)} />
        <Metric label="TP" value={formatPrice(trade.actual_target)} />
        <Metric label="Exit" value={formatPrice(trade.actual_exit)} />
        <Metric label="Result" value={formatR(trade.result_r)} />
        <Metric label="RR" value={formatDetailValue(trade.reward_to_risk)} />
      </View>
      {Array.isArray(trade.targets) && trade.targets.length > 0 ? (
        <View style={styles.mobileTargetProgress}>
          {trade.targets.map((target) => (
            <View key={target.targetNumber} style={[styles.mobileTargetStep, target.status === "HIT" && styles.mobileTargetStepHit]}>
              <Text style={styles.noticeTime}>TP{target.targetNumber} · {target.riskMultiple}R</Text>
              <Text style={styles.ruleTitle}>{formatPrice(target.price)}</Text>
              <Text style={styles.noticeTime}>{target.status}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.journalEvidenceLine}>
        <Text style={styles.noticeTime}>{formatTime(trade.opened_at ?? trade.detected_at ?? "")}</Text>
        <Text style={styles.noticeTime}>{module.shortName} · {variant ? `${variant} · ` : ""}Grade {trade.favorability_grade ?? "--"} · Score {trade.favorability_score ?? "--"}</Text>
      </View>
      <Text style={styles.ruleExplanation}>{trade.final_reason ?? "Paper tracking recorded this validated BUY/SELL signal for win-rate measurement."}</Text>
    </View>
  );
}

function AlertsScreen({
  notifications,
  onOpenNotification
}: {
  notifications: any[];
  onOpenNotification: (notification: any) => void;
}) {
  return (
    <>
      <SectionTitle title="Signal Alerts" />
      <View style={styles.card}>
        {notifications.slice(0, 20).map((item) => (
          <Pressable key={item.id} style={styles.noticeRow} onPress={() => onOpenNotification(item)}>
            <View style={styles.noticePriority} />
            <View style={styles.noticeContent}>
              <Text style={styles.noticeTitle}>{item.title}</Text>
              <Text style={styles.noticeBody}>{item.body}</Text>
              <Text style={styles.noticeTime}>{formatTime(item.created_at)} · {item.priority}</Text>
            </View>
            <Text style={styles.noticeChevron}>›</Text>
          </Pressable>
        ))}
        {notifications.length === 0 ? <Text style={styles.muted}>No alerts yet.</Text> : null}
      </View>
    </>
  );
}

function NotificationDetailScreen({
  detail,
  dashboard,
  onBack,
  onOpenChart
}: {
  detail: NotificationDetail;
  dashboard: Dashboard | null;
  onBack: () => void;
  onOpenChart: (moduleCode: string) => void;
}) {
  const moduleCode = detail.moduleCode ?? moduleCodeFromText(`${detail.eventType ?? ""} ${detail.title} ${detail.body}`);
  const module = dashboard?.modules.find((item) => item.code === moduleCode) ?? null;
  const trade = module?.currentTrade ?? {};
  const direction = detail.direction ?? trade.direction ?? "--";
  const action = detail.action ?? (direction === "SHORT" ? "SELL" : direction === "LONG" ? "BUY" : "--");
  const entry = detail.entry ?? trade.actual_entry ?? trade.entry_price ?? "--";
  const stopLoss = detail.stopLoss ?? trade.actual_stop ?? trade.stop_price ?? "--";
  const takeProfit = detail.takeProfit ?? trade.actual_target ?? trade.target_price ?? "--";
  const rr = detail.rewardToRisk ?? trade.reward_to_risk ?? "--";
  const symbol = detail.symbol ?? trade.symbol ?? "XAUUSD";
  const setupReason = detail.finalReason ?? module?.currentSetup?.final_reason ?? null;
  const category = notificationCategory(detail);
  const moduleLabel = detail.moduleName ?? module?.shortName ?? moduleDisplayName(moduleCode);
  const resolvedDetail = { ...detail, moduleCode, moduleName: moduleLabel, symbol, direction, action, entry, stopLoss, takeProfit, rewardToRisk: rr, finalReason: setupReason ?? detail.finalReason };

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.detailTopBar}>
          <Pressable style={styles.backButton} onPress={onBack}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.detailPill}>{String(detail.priority ?? "ALERT").toUpperCase()}</Text>
        </View>

        <View style={styles.detailHero}>
          <Text style={styles.eyebrow}>{String(detail.eventType ?? "SIGNAL ALERT").replaceAll("_", " ")}</Text>
          <Text style={styles.detailTitle}>{detail.title}</Text>
          <Text style={styles.detailBody}>{detail.body}</Text>
          <Text style={styles.noticeTime}>{detail.createdAt ? formatTime(detail.createdAt) : detail.source === "push" ? "Opened from push notification" : "--"}</Text>
        </View>

        <NotificationTemplate detail={resolvedDetail} category={category} module={module} />

        <View style={styles.moreDiagnosticsCard}>
          <Text style={styles.sectionMini}>Open Workspace</Text>
          <Metric label="Module" value={formatDetailValue(moduleLabel)} />
          <Metric label="Event Key" value={formatDetailValue(detail.eventKey)} />
          {moduleCode ? (
            <Pressable style={styles.fullButton} onPress={() => onOpenChart(moduleCode)}>
              <Text style={styles.fullButtonText}>Open Module Chart</Text>
            </Pressable>
          ) : <Text style={styles.reason}>This alert is not tied to a specific strategy module.</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function NotificationTemplate({
  detail,
  category,
  module
}: {
  detail: NotificationDetail;
  category: string;
  module: ModuleRow | null;
}) {
  if (category === "TRADE_SETUP") return <TradeSetupNotification detail={detail} module={module} />;
  if (category === "TRADE_CLOSEOUT") return <TradeCloseoutNotification detail={detail} module={module} />;
  if (category === "TRADE_LIFECYCLE") return <PaperTradeNotification detail={detail} module={module} />;
  if (category === "FEED" || category === "SESSION" || category === "HEALTH") return <OperationalNotification detail={detail} category={category} />;
  return <SystemNotification detail={detail} category={category} />;
}

function TradeSetupNotification({ detail, module }: { detail: NotificationDetail; module: ModuleRow | null }) {
  const action = tradeAction(detail.direction, detail.action ?? undefined);
  const targetLadder = dayTradingTargets(detail.entry, detail.stopLoss, detail.takeProfit, detail.direction ?? detail.action);
  return (
    <>
      <View style={[styles.moreDiagnosticsCard, action === "SELL" ? styles.notificationTradeSell : styles.notificationTradeBuy]}>
        <Text style={styles.sectionMini}>Trade Entry Signal</Text>
        <View style={styles.tradeBadgeRow}>
          <Text style={[styles.tradeDirectionBadge, action === "SELL" && styles.tradeDirectionSell]}>{action}</Text>
          <Text style={styles.tradeSymbol}>{detail.symbol ?? "XAUUSD"}</Text>
          <Text style={styles.tradeModule}>{detail.moduleName ?? module?.shortName ?? "--"}</Text>
        </View>
        <View style={styles.metricsGrid}>
          <Metric label="Entry Range" value={entryRangeLabel(module?.currentSetup ?? {}, detail.entry)} />
          <Metric label="Entry" value={formatDetailValue(detail.entry)} />
          <Metric label="Stop Loss" value={formatDetailValue(detail.stopLoss)} />
          <Metric label="TP1 1R" value={formatPrice(targetLadder.tp1)} />
          <Metric label="TP2 1.5R" value={formatPrice(targetLadder.tp2)} />
          <Metric label={`TP3 ${targetLadder.finalRLabel}`} value={formatPrice(targetLadder.tp3)} />
          <Metric label="RR" value={formatDetailValue(detail.rewardToRisk)} />
          <Metric label="Setup Score" value={detail.confidence == null ? setupScoreLabel(module?.currentSetup ?? {}) : `${detail.confidence}/100`} />
          <Metric label="Grade" value={formatDetailValue(detail.grade)} />
          <Metric label="Setup Tier" value={formatDetailValue(detail.setupTier)} />
          <Metric label="Variant" value={formatDetailValue(detail.variantName ?? detail.variantCode)} />
          <Metric label="Missing" value={detail.missingRules?.length ? detail.missingRules.slice(0, 2).join(", ") : "--"} />
        </View>
        <NotificationEvidenceStrip detail={detail} />
        <Text style={styles.reason}>{detail.finalReason ?? "Review the setup evidence before placing any manual real trade."}</Text>
      </View>
      <SetupEvidenceNotification detail={detail} module={module} />
    </>
  );
}

function PaperTradeNotification({ detail, module }: { detail: NotificationDetail; module: ModuleRow | null }) {
  const trade = module?.currentTrade ?? {};
  const action = tradeAction(detail.direction ?? trade.direction, detail.action ?? undefined);
  return (
    <View style={[styles.moreDiagnosticsCard, action === "SELL" ? styles.notificationTradeSell : styles.notificationTradeBuy]}>
      <Text style={styles.sectionMini}>Paper Trade Status</Text>
      <View style={styles.tradeBadgeRow}>
        <Text style={[styles.tradeDirectionBadge, action === "SELL" && styles.tradeDirectionSell]}>{action}</Text>
        <Text style={styles.tradeSymbol}>{detail.symbol ?? trade.symbol ?? "XAUUSD"}</Text>
        <Text style={styles.tradeModule}>{detail.moduleName ?? module?.shortName ?? "--"}</Text>
      </View>
      <View style={styles.metricsGrid}>
        <Metric label="Entry" value={formatDetailValue(detail.entry ?? trade.actual_entry)} />
        <Metric label="Stop Loss" value={formatDetailValue(detail.stopLoss ?? trade.actual_stop)} />
        <Metric label="Target" value={formatDetailValue(detail.takeProfit ?? trade.actual_target)} />
        <Metric label="RR" value={formatDetailValue(detail.rewardToRisk ?? trade.reward_to_risk)} />
        <Metric label="Age" value={formatDuration(detail.ageSeconds)} />
        <Metric label="Status" value={formatDetailValue(detail.status ?? trade.outcome)} />
      </View>
      {detail.targetNumber != null ? (
        <View style={styles.mobileTargetProgress}>
          <View style={[styles.mobileTargetStep, styles.mobileTargetStepHit]}>
            <Text style={styles.noticeTime}>TP{detail.targetNumber} reached</Text>
            <Text style={styles.ruleTitle}>{formatPrice(detail.targetPrice)}</Text>
            <Text style={styles.noticeTime}>{formatDetailValue(detail.riskMultiple)}R</Text>
          </View>
        </View>
      ) : null}
      {Array.isArray(detail.targets) && detail.targets.length > 0 ? (
        <View style={styles.mobileTargetProgress}>
          {detail.targets.map((target: any) => (
            <View key={target.targetNumber ?? target.target_number} style={[
              styles.mobileTargetStep,
              String(target.status).toUpperCase() === "HIT" && styles.mobileTargetStepHit
            ]}>
              <Text style={styles.noticeTime}>TP{target.targetNumber ?? target.target_number} · {target.riskMultiple ?? target.risk_multiple}R</Text>
              <Text style={styles.ruleTitle}>{formatPrice(target.price)}</Text>
              <Text style={styles.noticeTime}>{target.status ?? "PENDING"}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={styles.reason}>{detail.recommendedAction ?? notificationRecommendedAction("TRADE_LIFECYCLE", detail)}</Text>
    </View>
  );
}

function TradeCloseoutNotification({ detail, module }: { detail: NotificationDetail; module: ModuleRow | null }) {
  const isWin = String(detail.closeReason ?? detail.status ?? detail.title).toUpperCase().includes("TP") || Number(detail.resultR ?? 0) > 0;
  return (
    <View style={[styles.moreDiagnosticsCard, isWin ? styles.notificationTradeBuy : styles.notificationTradeSell]}>
      <Text style={styles.sectionMini}>TP / SL Closeout</Text>
      <View style={styles.tradeBadgeRow}>
        <Text style={[styles.tradeDirectionBadge, !isWin && styles.tradeDirectionSell]}>{isWin ? "WIN" : "LOSS"}</Text>
        <Text style={styles.tradeSymbol}>{detail.symbol ?? "XAUUSD"}</Text>
        <Text style={styles.tradeModule}>{detail.moduleName ?? module?.shortName ?? "--"}</Text>
      </View>
      <View style={styles.metricsGrid}>
        <Metric label="Exit" value={formatDetailValue(detail.exitPrice)} />
        <Metric label="Result" value={formatR(detail.resultR)} />
        <Metric label="Close Reason" value={formatDetailValue(detail.closeReason ?? detail.status)} />
        <Metric label="Trade ID" value={formatDetailValue(detail.tradeId)} />
      </View>
      <Text style={styles.reason}>This result should now appear in Paper Trading and learning samples.</Text>
    </View>
  );
}

function OperationalNotification({ detail, category }: { detail: NotificationDetail; category: string }) {
  return (
    <View style={styles.moreDiagnosticsCard}>
      <Text style={styles.sectionMini}>{category === "HEALTH" ? "System Health" : category === "SESSION" ? "Session Notice" : "Market Feed Notice"}</Text>
      <View style={styles.metricsGrid}>
        <Metric label="Provider" value={formatDetailValue(detail.provider ?? "Twelve Data")} />
        <Metric label="Cache" value={formatDetailValue(detail.cacheStatus)} />
        <Metric label="Scheduler" value={formatDetailValue(detail.schedulerStatus)} />
        <Metric label="Issue" value={formatDetailValue(detail.issueCode ?? detail.eventType)} />
        <Metric label="Status" value={formatDetailValue(detail.status)} />
        <Metric label="Age" value={formatDuration(detail.ageSeconds)} />
      </View>
      <Text style={styles.reason}>{detail.recommendedAction ?? notificationRecommendedAction(category, detail)}</Text>
    </View>
  );
}

function SystemNotification({ detail, category }: { detail: NotificationDetail; category: string }) {
  return (
    <View style={styles.moreDiagnosticsCard}>
      <Text style={styles.sectionMini}>{category === "SYSTEM" ? "System / Learning Alert" : "Notification Details"}</Text>
      <View style={styles.metricsGrid}>
        <Metric label="Module" value={formatDetailValue(detail.moduleName)} />
        <Metric label="Priority" value={formatDetailValue(detail.priority)} />
        <Metric label="Status" value={formatDetailValue(detail.status)} />
        <Metric label="Source" value={detail.source === "push" ? "Push" : "History"} />
        <Metric label="Event" value={formatDetailValue(detail.eventType)} />
        <Metric label="Event Key" value={formatDetailValue(detail.eventKey)} />
      </View>
      <Text style={styles.reason}>{detail.recommendedAction ?? notificationRecommendedAction(category, detail)}</Text>
    </View>
  );
}

function SetupEvidenceNotification({ detail, module }: { detail: NotificationDetail; module: ModuleRow | null }) {
  const groupedRules = groupedChecklist(module?.currentSetup?.evaluations ?? [], module?.code ?? String(detail.moduleCode ?? ""));
  const hasSummary = detail.scenario || detail.setupCandidateId || detail.mandatoryPassed != null || detail.confirmationPassed != null || detail.qualityPassed != null;
  return (
    <View style={styles.moreDiagnosticsCard}>
      <Text style={styles.sectionMini}>Checklist Snapshot</Text>
      {hasSummary ? (
        <View style={styles.metricsGrid}>
          <Metric label="Scenario" value={formatDetailValue(detail.scenario)} />
          <Metric label="Variant" value={formatDetailValue(detail.variantName ?? detail.variantCode)} />
          <Metric label="Mandatory" value={formatDetailValue(detail.mandatoryPassed)} />
          <Metric label="Confirmations" value={formatDetailValue(detail.confirmationPassed)} />
          <Metric label="Quality" value={formatDetailValue(detail.qualityPassed)} />
          <Metric label="Missing" value={detail.missingRules?.length ? detail.missingRules.slice(0, 2).join(", ") : "--"} />
          <Metric label="Setup ID" value={formatDetailValue(detail.setupCandidateId)} />
          <Metric label="Trade ID" value={formatDetailValue(detail.tradeId)} />
        </View>
      ) : null}
      {groupedRules.map((group) => (
        <View key={group.title} style={styles.checklistGroup}>
          <View style={styles.checklistGroupHeader}>
            <Text style={styles.checklistGroupTitle}>{group.title}</Text>
            <Text style={styles.checklistGroupMeta}>{group.summary}</Text>
          </View>
          {group.rules.slice(0, 5).map((rule: any) => (
            <View key={rule.rule_code ?? rule.ruleCode ?? rule.name} style={styles.ruleRow}>
              <Text style={[styles.ruleStatus, ruleStatusTone(rule.status)]}>{shortRuleStatus(rule.status)}</Text>
              <View style={styles.ruleBody}>
                <Text style={styles.ruleTitle}>{rule.name}</Text>
                <Text style={styles.ruleExplanation}>{rule.explanation}</Text>
              </View>
            </View>
          ))}
        </View>
      ))}
      {!hasSummary && groupedRules.length === 0 ? <Text style={styles.muted}>No checklist snapshot was attached to this notification.</Text> : null}
    </View>
  );
}

function NotificationEvidenceStrip({ detail }: { detail: NotificationDetail }) {
  if (!detail.liquidity && !detail.bos && !detail.entryZone && !detail.displacement) return null;
  return (
    <View style={styles.notificationEvidenceStrip}>
      <Metric label="Liquidity" value={notificationEvidencePrice(detail.liquidity?.type, detail.liquidity?.price)} />
      <Metric label="Displacement" value={detail.displacement?.rangeAtr == null ? "--" : `${Number(detail.displacement.rangeAtr).toFixed(2)} ATR`} />
      <Metric label="BOS" value={notificationEvidencePrice(null, detail.bos?.level)} />
      <Metric label="Zone" value={notificationZoneLabel(detail.entryZone)} />
    </View>
  );
}

function MoreScreen({
  dashboard,
  apiBaseUrl,
  pushStatus,
  pushDiagnostics,
  pushPreferences,
  biometric,
  appUpdate,
  view,
  setView,
  socketStatus,
  onCheckAppUpdate,
  onToggleBiometric,
  onRegisterPush,
  onTestPush,
  onDisablePushDevice,
  onSavePushPreferences,
  onStartMfa,
  onEnableMfa,
  onDisableMfa,
  onCreateTicket,
  onOpenNotification
}: {
  dashboard: Dashboard | null;
  apiBaseUrl: string;
  pushStatus: string;
  pushDiagnostics: PushDiagnostics;
  pushPreferences: PushPreferences;
  biometric: BiometricState;
  appUpdate: AppUpdateState;
  view: MoreView;
  setView: (view: MoreView) => void;
  socketStatus: string;
  onCheckAppUpdate: () => void;
  onToggleBiometric: (enabled: boolean) => void;
  onRegisterPush: () => void;
  onTestPush: () => void;
  onDisablePushDevice: (deviceId: string) => void;
  onSavePushPreferences: (preferences: PushPreferences) => void;
  onStartMfa: () => Promise<{ secret: string; otpAuthUrl: string }>;
  onEnableMfa: (otp: string) => void;
  onDisableMfa: (otp: string) => void;
  onCreateTicket: (input: { ticketType: string; title: string; description: string; requestedModuleCode?: string | null }) => void;
  onOpenNotification: (notification: any) => void;
}) {
  const modules = dashboard?.modules ?? [];
  const supportInfo = dashboard?.supportInfo ?? {};
  const supportTickets = dashboard?.supportTickets ?? [];
  const [ticketType, setTicketType] = useState("TECHNICAL");
  const [ticketTitle, setTicketTitle] = useState("");
  const [ticketDescription, setTicketDescription] = useState("");
  const [requestedModuleCode, setRequestedModuleCode] = useState("");
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpAuthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");

  function submitTicket() {
    onCreateTicket({
      ticketType,
      title: ticketTitle.trim() || ticketType.replaceAll("_", " "),
      description: ticketDescription,
      requestedModuleCode: ticketType === "MODULE_UPGRADE" ? requestedModuleCode || null : null
    });
    setTicketTitle("");
    setTicketDescription("");
    setRequestedModuleCode("");
  }

  if (view === "profile") {
    return (
      <>
        <MoreHeader title="Profile" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="User" value={dashboard?.user?.displayName ?? dashboard?.user?.email ?? "--"} />
          <Metric label="Email" value={dashboard?.user?.email ?? "--"} />
          <Metric label="Plan" value={dashboard?.tenant?.plan_name ?? "--"} />
          <Metric label="Subscription" value={dashboard?.tenant?.subscription_status ?? "ACTIVE"} />
        </View>
      </>
    );
  }
  if (view === "security") {
    return (
      <>
        <MoreHeader title="Security" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="Device lock" value={biometric.enabled ? "Enabled" : "Off"} />
          <Metric label="Method" value={biometric.label} />
          <Metric label="Available" value={biometric.available && biometric.enrolled ? "Ready" : "Setup needed"} />
          <Metric label="Login email" value={dashboard?.user?.email ?? "--"} />
          <Text style={styles.reason}>Use your phone fingerprint or face unlock to protect the saved mobile session. The platform admin web console still uses stronger web security separately.</Text>
        </View>
        <View style={styles.moreMenuGroup}>
          <PushToggleRow
            title={`${biometric.label} unlock`}
            subtitle="Require phone biometric check before opening the saved mobile session."
            value={biometric.enabled}
            onValueChange={onToggleBiometric}
          />
          {!biometric.available || !biometric.enrolled ? <Text style={styles.reason}>No enrolled fingerprint/face unlock was found. Add it in Android settings, then return here.</Text> : null}
        </View>
      </>
    );
  }
  if (view === "push-settings") {
    return (
      <PushSettingsScreen
        preferences={pushPreferences}
        pushStatus={pushStatus}
        diagnostics={pushDiagnostics}
        onBack={() => setView("menu")}
        onRegisterPush={onRegisterPush}
        onTestPush={onTestPush}
        onDisablePushDevice={onDisablePushDevice}
        onSave={onSavePushPreferences}
      />
    );
  }
  if (view === "modules") {
    return (
      <>
        <MoreHeader title="Strategy Modules" onBack={() => setView("menu")} />
        <View style={styles.moreMenuGroup}>
          {modules.map((module) => (
            <MoreMenuRow key={module.code} icon="signals" title={module.shortName} subtitle={`${module.name} · ${module.timeframeMinutes}m`} value={signalLabel(module).label} />
          ))}
          {modules.length === 0 ? <Text style={styles.muted}>No modules assigned.</Text> : null}
        </View>
      </>
    );
  }
  if (view === "chart-preferences") {
    return (
      <>
        <MoreHeader title="Chart Preferences" onBack={() => setView("menu")} />
        <View style={styles.moreMenuGroup}>
          <MoreMenuRow icon="chart" title="Default symbol" subtitle="Shared Twelve Data backend feed" value="XAUUSD" />
          <MoreMenuRow icon="chart" title="Chart source" subtitle="Mobile uses backend cache and websocket" value="Live" />
          <MoreMenuRow icon="signals" title="Module overlays" subtitle="Show strategy levels per selected module" value="On" />
          <MoreMenuRow icon="time" title="Candle count" subtitle="Latest cached candles loaded per module" value="90" />
        </View>
      </>
    );
  }
  if (view === "session-settings") {
    return (
      <>
        <MoreHeader title="Session Settings" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="New York" value={dashboard?.clocks.newYork ?? "--"} />
          <Metric label="Nepal" value={dashboard?.clocks.nepal ?? "--"} />
          <Metric label="UTC" value={dashboard?.clocks.utc ?? "--"} />
          <Metric label="Session" value="NY Monday-Friday" />
        </View>
        <View style={styles.moreMenuGroup}>
          <MoreMenuRow icon="time" title="Trading window" subtitle="Modules evaluate during the New York session." value="Auto" />
          <MoreMenuRow icon="alerts" title="Pre-session alert" subtitle="Controlled from Push Notification Settings." value={pushPreferences.nyPreSession ? "On" : "Off"} onPress={() => setView("push-settings")} />
        </View>
      </>
    );
  }
  if (view === "notification-history") {
    return (
      <>
        <MoreHeader title="Notification History" onBack={() => setView("menu")} />
        <View style={styles.moreMenuGroup}>
          {(dashboard?.notifications ?? []).slice(0, 12).map((item: any) => (
            <MoreMenuRow key={item.id} icon="alerts" title={item.title} subtitle={item.body} value={item.priority} onPress={() => onOpenNotification(item)} />
          ))}
          {(dashboard?.notifications ?? []).length === 0 ? <Text style={styles.muted}>No notifications yet.</Text> : null}
        </View>
      </>
    );
  }
  if (view === "support") {
    return (
      <>
        <MoreHeader title="Support" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Text style={styles.reason}>{supportInfo.helpText ?? "Contact support for account, subscription, signal, or mobile notification help."}</Text>
          <Metric label="Phone" value={supportInfo.supportPhone ?? "--"} />
          <Metric label="Email" value={supportInfo.supportEmail ?? "--"} />
          <Metric label="Address" value={supportInfo.businessAddress ?? "--"} />
          <Metric label="Hours" value={supportInfo.supportHours ?? "--"} />
          <Metric label="Website" value={supportInfo.websiteUrl || "--"} />
          <Metric label="WhatsApp" value={supportInfo.whatsappUrl || "--"} />
        </View>
        <View style={styles.moreDiagnosticsCard}>
          <Text style={styles.sectionMini}>Create Ticket</Text>
          <View style={styles.ticketTypeGrid}>
            {["TECHNICAL", "FORGOT_PASSWORD", "MODULE_UPGRADE", "BILLING", "GENERAL"].map((type) => (
              <Pressable key={type} style={[styles.ticketTypeButton, ticketType === type && styles.ticketTypeButtonActive]} onPress={() => setTicketType(type)}>
                <Text style={[styles.ticketTypeText, ticketType === type && styles.ticketTypeTextActive]}>{type.replaceAll("_", " ")}</Text>
              </Pressable>
            ))}
          </View>
          {ticketType === "MODULE_UPGRADE" ? (
            <View style={styles.ticketTypeGrid}>
              {modules.map((module) => (
                <Pressable key={module.code} style={[styles.ticketTypeButton, requestedModuleCode === module.code && styles.ticketTypeButtonActive]} onPress={() => setRequestedModuleCode(module.code)}>
                  <Text style={[styles.ticketTypeText, requestedModuleCode === module.code && styles.ticketTypeTextActive]}>{module.shortName}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <TextInput style={styles.input} value={ticketTitle} onChangeText={setTicketTitle} placeholder="Ticket title" placeholderTextColor="#6f7b75" />
          <TextInput style={[styles.input, styles.ticketTextArea]} value={ticketDescription} onChangeText={setTicketDescription} placeholder="What do you need help with?" placeholderTextColor="#6f7b75" multiline />
          <Pressable style={[styles.fullButton, !ticketTitle.trim() && !ticketDescription.trim() && styles.disabledButton]} disabled={!ticketTitle.trim() && !ticketDescription.trim()} onPress={submitTicket}>
            <Text style={styles.fullButtonText}>Submit Ticket</Text>
          </Pressable>
        </View>
        <View style={styles.moreMenuGroup}>
          <Text style={styles.sectionMini}>Ticket History</Text>
          {supportTickets.slice(0, 8).map((ticket: any) => (
            <MoreMenuRow key={ticket.id} icon="account" title={ticket.title} subtitle={`${ticket.ticket_type} · ${formatTime(ticket.created_at)}`} value={ticket.status} />
          ))}
          {supportTickets.length === 0 ? <Text style={styles.muted}>No support tickets submitted yet.</Text> : null}
        </View>
      </>
    );
  }
  if (view === "app-updates") {
    const latest = appUpdate.latest;
    const latestVersion = latest?.version_name ?? "--";
    const latestCode = latest?.version_code ?? "--";
    const downloadUrl = latest?.downloadUrl;
    return (
      <>
        <MoreHeader title="App Updates" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="Installed" value={`${APP_VERSION} (${APP_VERSION_CODE || "--"})`} />
          <Metric label="Latest" value={`${latestVersion} (${latestCode})`} />
          <Metric label="Status" value={appUpdate.checking ? "Checking..." : appUpdate.updateAvailable ? "Update available" : "Current"} />
          <Metric label="Checked" value={appUpdate.checkedAt ? formatTime(appUpdate.checkedAt) : "--"} />
          {appUpdate.error ? <Text style={styles.reason}>{cleanErrorMessage(appUpdate.error)}</Text> : null}
        </View>
        {latest ? (
          <View style={styles.moreDiagnosticsCard}>
            <Text style={styles.sectionMini}>Release Details</Text>
            <Metric label="File" value={latest.file_name ?? "--"} />
            <Metric label="Size" value={formatFileSize(latest.file_size_bytes)} />
            <Metric label="SHA256" value={String(latest.sha256 ?? "--").slice(0, 18)} />
            <Text style={styles.reason}>{latest.changelog || "No changelog provided."}</Text>
            {downloadUrl ? (
              <Pressable style={styles.fullButton} onPress={() => Linking.openURL(downloadUrl).catch(() => Alert.alert("Download failed", "Could not open the APK download link."))}>
                <Text style={styles.fullButtonText}>Download APK</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <Pressable style={styles.secondaryButton} onPress={onCheckAppUpdate}>
          <Text style={styles.secondaryButtonText}>{appUpdate.checking ? "Checking..." : "Check for Updates"}</Text>
        </Pressable>
      </>
    );
  }
  if (view === "about") {
    return (
      <>
        <MoreHeader title="About" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="App" value={supportInfo.brandName ?? "XAUUSD Signal"} />
          <Metric label="Version" value={APP_VERSION} />
          <Metric label="Build code" value={APP_VERSION_CODE || "--"} />
          <Metric label="Data Source" value="Shared backend feed" />
          <Metric label="API" value={apiBaseUrl} />
        </View>
      </>
    );
  }
  return (
    <>
      <SectionTitle title="More" />
      <View style={styles.moreProfileCard}>
        <View style={styles.moreAvatar}>
          <MiniIcon name="account" />
        </View>
        <View style={styles.moreProfileText}>
          <Text style={styles.moreProfileName} numberOfLines={1}>{dashboard?.user?.displayName ?? "Trader"}</Text>
          <Text style={styles.moreProfileMeta} numberOfLines={1}>{dashboard?.user?.email ?? "--"}</Text>
        </View>
        <View style={styles.morePlanBadge}>
          <Text style={styles.morePlanText}>{dashboard?.tenant?.plan_name ?? "Active"}</Text>
        </View>
      </View>

      <View style={styles.moreMenuGroup}>
        <MoreMenuRow icon="account" title="Profile" subtitle="Account, plan, and subscription" value={dashboard?.tenant?.subscription_status ?? "ACTIVE"} onPress={() => setView("profile")} />
        <MoreMenuRow icon="account" title="Security" subtitle="Fingerprint unlock and saved session protection" value={biometric.enabled ? "On" : "Open"} onPress={() => setView("security")} />
        <MoreMenuRow icon="alerts" title="Push Alerts" subtitle={pushStatus} value={pushDiagnostics.permission} onPress={() => setView("push-settings")} />
        <MoreMenuRow icon="signals" title="Strategy Modules" subtitle={`${modules.length} assigned modules`} value="Open" onPress={() => setView("modules")} />
        <MoreMenuRow icon="chart" title="Chart Preferences" subtitle="Candle view, modules, and live stream" value="Open" onPress={() => setView("chart-preferences")} />
      </View>

      <View style={styles.moreMenuGroup}>
        <MoreMenuRow icon="time" title="Session Settings" subtitle="New York session and Nepal time display" value="NY" onPress={() => setView("session-settings")} />
        <MoreMenuRow icon="alerts" title="Notification History" subtitle="Signal, report, and paper-trade alerts" value="Open" onPress={() => setView("notification-history")} />
        <MoreMenuRow icon="account" title="Support" subtitle={supportInfo.supportEmail ?? "Help, feedback, and issue reports"} value="Help" onPress={() => setView("support")} />
        <MoreMenuRow icon="chart" title="App Updates" subtitle={appUpdate.updateAvailable ? `Version ${appUpdate.latest?.version_name ?? ""} available` : "Latest APK and changelog"} value={appUpdate.updateAvailable ? "Update" : "Open"} onPress={() => setView("app-updates")} />
        <MoreMenuRow icon="chart" title="About XAUUSD Signal" subtitle="Version, build, and data source" value="Open" onPress={() => setView("about")} />
      </View>

      <View style={styles.moreDiagnosticsCard}>
        <Text style={styles.sectionMini}>Device Diagnostics</Text>
        <View style={styles.metricsGrid}>
          <Metric label="Live Stream" value={socketStatus} />
          <Metric label="Devices" value={pushDiagnostics.activeDevices} />
          <Metric label="Last Sync" value={pushDiagnostics.lastSyncedAt ? formatTime(pushDiagnostics.lastSyncedAt) : "--"} />
          <Metric label="Test Push" value={pushDiagnostics.lastTestStatus} />
        </View>
        <Text style={styles.tokenLabel}>API endpoint</Text>
        <Text style={styles.tokenValue} numberOfLines={1}>{apiBaseUrl}</Text>
        <Pressable style={styles.secondaryButton} onPress={onTestPush}>
          <Text style={styles.secondaryButtonText}>Send Test Push</Text>
        </Pressable>
      </View>
    </>
  );
}

function MoreMenuRow({
  icon,
  title,
  subtitle,
  value,
  onPress
}: {
  icon: string;
  title: string;
  subtitle: string;
  value?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable style={styles.moreMenuRow} onPress={onPress}>
      <View style={styles.moreMenuIcon}>
        <MiniIcon name={icon} />
      </View>
      <View style={styles.moreMenuContent}>
        <Text style={styles.moreMenuTitle}>{title}</Text>
        <Text style={styles.moreMenuSubtitle} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Text style={styles.moreMenuValue} numberOfLines={1}>{value ?? ">"}</Text>
    </Pressable>
  );
}

function MoreHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.moreHeader}>
      <Pressable style={styles.moreBackButton} onPress={onBack}>
        <Text style={styles.moreBackText}>{"<"}</Text>
      </Pressable>
      <Text style={styles.moreHeaderTitle}>{title}</Text>
    </View>
  );
}

function PushSettingsScreen({
  preferences,
  pushStatus,
  diagnostics,
  onBack,
  onRegisterPush,
  onTestPush,
  onDisablePushDevice,
  onSave
}: {
  preferences: PushPreferences;
  pushStatus: string;
  diagnostics: PushDiagnostics;
  onBack: () => void;
  onRegisterPush: () => void;
  onTestPush: () => void;
  onDisablePushDevice: (deviceId: string) => void;
  onSave: (preferences: PushPreferences) => void;
}) {
  const update = (key: keyof PushPreferences, value: boolean) => onSave({ ...preferences, [key]: value });
  return (
    <>
      <MoreHeader title="Push Notification Settings" onBack={onBack} />
      <View style={styles.moreDiagnosticsCard}>
        <Text style={styles.sectionMini}>Status</Text>
        <Metric label="Push" value={pushStatus} />
        <Metric label="Permission" value={diagnostics.permission} />
        <Metric label="Devices" value={diagnostics.activeDevices} />
        <Metric label="Last Sync" value={diagnostics.lastSyncedAt ? formatTime(diagnostics.lastSyncedAt) : "--"} />
        <Pressable style={styles.fullButton} onPress={onRegisterPush}>
          <Text style={styles.fullButtonText}>Register Push Alerts</Text>
        </Pressable>
      </View>

      <View style={styles.moreMenuGroup}>
        <Text style={styles.sectionMini}>Registered Devices</Text>
        {(diagnostics.devices ?? []).map((device: any) => (
          <MoreMenuRow
            key={device.id}
            icon="account"
            title={`${device.deviceName ?? "Mobile device"} · ${device.provider ?? "--"}`}
            subtitle={`${device.platform ?? "--"} · Firebase ${device.hasFcmToken ? "on" : "off"} · Expo ${device.hasExpoToken ? "on" : "off"}`}
            value={device.enabled ? "Disable" : "Off"}
            onPress={device.enabled ? () => onDisablePushDevice(device.id) : undefined}
          />
        ))}
        {(diagnostics.devices ?? []).length === 0 ? <Text style={styles.muted}>No registered mobile devices yet.</Text> : null}
      </View>

      <View style={styles.moreMenuGroup}>
        <PushToggleRow title="NY pre-session reminder" subtitle="Notify before New York monitoring starts." value={preferences.nyPreSession} onValueChange={(value) => update("nyPreSession", value)} />
        <PushToggleRow title="Valid buy/sell entries" subtitle="Notify only when a module has a valid setup." value={preferences.validEntries} onValueChange={(value) => update("validEntries", value)} />
        <PushToggleRow title="Signal tracking started" subtitle="Notify when paper tracking starts for a valid BUY/SELL signal." value={preferences.paperTradeOpened} onValueChange={(value) => update("paperTradeOpened", value)} />
        <PushToggleRow title="TP / SL closeouts" subtitle="Notify when paper trades close by target or stop." value={preferences.takeProfitStopLoss} onValueChange={(value) => update("takeProfitStopLoss", value)} />
        <PushToggleRow title="Daily reports" subtitle="Daily module summary after session close." value={preferences.dailyReports} onValueChange={(value) => update("dailyReports", value)} />
        <PushToggleRow title="Weekly / monthly reports" subtitle="Win-rate and performance summaries." value={preferences.weeklyMonthlyReports} onValueChange={(value) => update("weeklyMonthlyReports", value)} />
        <PushToggleRow title="Learning reviews" subtitle="Optimization and learning queue reminders." value={preferences.learningReviews} onValueChange={(value) => update("learningReviews", value)} />
        <PushToggleRow title="System diagnostics" subtitle="Connectivity, feed, and device test alerts." value={preferences.systemDiagnostics} onValueChange={(value) => update("systemDiagnostics", value)} />
      </View>

      <View style={styles.moreDiagnosticsCard}>
        <Text style={styles.sectionMini}>Test</Text>
        <Metric label="Last Test" value={diagnostics.lastTestStatus} />
        <Pressable style={styles.secondaryButton} onPress={onTestPush}>
          <Text style={styles.secondaryButtonText}>Send Test Push</Text>
        </Pressable>
      </View>

      <View style={styles.moreMenuGroup}>
        <Text style={styles.sectionMini}>Recent Delivery</Text>
        {(diagnostics.deliveryLogs ?? []).slice(0, 6).map((log: any, index: number) => (
          <MoreMenuRow
            key={`${log.event_key ?? "push"}-${log.created_at ?? index}`}
            icon="alerts"
            title={String(log.event_type ?? "Push")}
            subtitle={`${log.preference_key ?? "manual"} · ${formatTime(log.created_at)}`}
            value={String(log.status ?? "--")}
          />
        ))}
        {(diagnostics.deliveryLogs ?? []).length === 0 ? <Text style={styles.muted}>No delivery attempts recorded yet.</Text> : null}
      </View>
    </>
  );
}

function PushToggleRow({
  title,
  subtitle,
  value,
  onValueChange
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.pushToggleRow}>
      <View style={styles.pushToggleText}>
        <Text style={styles.moreMenuTitle}>{title}</Text>
        <Text style={styles.moreMenuSubtitle}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: "#2b302d", true: "#176b51" }}
        thumbColor={value ? "#2fe6a8" : "#7e8781"}
      />
    </View>
  );
}

function MobileCandlestickChart({
  chart,
  loading,
  selectedCandle,
  onSelectCandle
}: {
  chart: ChartPayload | null;
  loading?: boolean;
  selectedCandle: ChartCandle | null;
  onSelectCandle: (candle: ChartCandle) => void;
}) {
  if (!chart) return <EmptyCard text={loading ? "Loading XAUUSD chart from server cache..." : "Select a module to load its XAUUSD chart."} />;
  if (chart.candles.length === 0) return <EmptyCard text="No cached XAUUSD candles are available yet." />;

  const visibleCandles = chart.candles.slice(-90);
  const plotHeight = 236;
  const topPad = 14;
  const bottomPad = 18;
  const candleStep = 8;
  const candleWidth = 5;
  const plotWidth = Math.max(340, visibleCandles.length * candleStep + 96);
  const prices = [
    ...visibleCandles.flatMap((candle) => [candle.high, candle.low]),
    ...chart.levels.map((level) => level.price)
  ].filter(Number.isFinite);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = Math.max(maxPrice - minPrice, 0.01);
  const priceToY = (price: number) => topPad + ((maxPrice - price) / range) * plotHeight;
  const latest = visibleCandles[visibleCandles.length - 1];
  const selectedInChart = selectedCandle && visibleCandles.some((candle) => candle.timestampUtc === selectedCandle.timestampUtc)
    ? selectedCandle
    : null;
  const info = selectedInChart ?? latest;
  const legend = chartLegend(chart);

  return (
    <View style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <View>
          <Text style={styles.cardTitle}>{chart.symbol}</Text>
          <Text style={styles.muted}>{chart.timeframeMinutes}m live chart · latest {visibleCandles.length}/{chart.candles.length} candles · {chart.status ?? "CACHE"}</Text>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.priceLabel}>Last</Text>
          <Text style={styles.priceValue}>{formatPrice(latest.close)}</Text>
        </View>
      </View>
      <View style={styles.chartLegend}>
        {legend.map((item) => (
          <View key={item.label} style={styles.chartLegendItem}>
            <View style={[styles.chartLegendDot, levelLineStyle(item.tone)]} />
            <Text style={styles.chartLegendText}>{item.label}</Text>
          </View>
        ))}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chartScroll}>
        <View style={[styles.chartPlot, { width: plotWidth, height: plotHeight + topPad + bottomPad }]}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <View key={ratio} style={[styles.chartGridLine, { top: topPad + ratio * plotHeight }]} />
          ))}
          {chart.levels.slice(0, 14).map((level) => {
            const y = priceToY(level.price);
            return (
              <View key={`${level.label}-${level.price}`} style={[styles.chartLevelWrap, { top: y }]}>
                <View style={[styles.chartLevelLine, levelLineStyle(level.tone)]} />
                <Text style={[styles.chartLevelLabel, levelTextStyle(level.tone)]} numberOfLines={1}>{shortChartLevelLabel(level.label)} {formatPrice(level.price)}</Text>
              </View>
            );
          })}
          {visibleCandles.map((candle, index) => {
            const rising = candle.close >= candle.open;
            const x = 24 + index * candleStep;
            const wickTop = priceToY(candle.high);
            const wickBottom = priceToY(candle.low);
            const bodyTop = priceToY(Math.max(candle.open, candle.close));
            const bodyBottom = priceToY(Math.min(candle.open, candle.close));
            const bodyHeight = Math.max(bodyBottom - bodyTop, 2);
            const isSelected = selectedInChart?.timestampUtc === candle.timestampUtc;
            return (
              <Pressable
                key={candle.timestampUtc}
                onPress={() => onSelectCandle(candle)}
                style={[styles.candleHitArea, { left: x - 2, height: plotHeight + topPad + bottomPad }]}
              >
                <View style={[styles.candleWick, rising ? styles.candleUp : styles.candleDown, { top: wickTop, height: Math.max(wickBottom - wickTop, 1) }]} />
                <View style={[styles.candleBody, rising ? styles.candleUp : styles.candleDown, isSelected && styles.candleSelected, { top: bodyTop, height: bodyHeight, width: candleWidth }]} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={styles.candleReadout}>
        <Metric label="Candle" value={formatTime(info.timestampUtc)} />
        <Metric label="O / H" value={`${formatPrice(info.open)} / ${formatPrice(info.high)}`} />
        <Metric label="L / C" value={`${formatPrice(info.low)} / ${formatPrice(info.close)}`} />
        <Metric label="Spread" value={info.spread == null ? "--" : formatPrice(info.spread)} />
      </View>
    </View>
  );
}

function ModuleDetail({
  module,
  learning,
  learningBusy,
  onRunLearning
}: {
  module: ModuleRow;
  learning?: ModuleLearningSnapshot;
  learningBusy?: boolean;
  onRunLearning?: (moduleCode: string) => void;
}) {
  const signal = signalLabel(module);
  const setup = module.currentSetup ?? {};
  const trade = module.currentTrade ?? {};
  const evaluations = setup.evaluations ?? [];
  const learningSummary = learning?.summary ?? {};
  const recommendations = learning?.recommendations ?? [];
  const topRecommendation = recommendations[0];
  const entry = trade.actual_entry ?? setup.entry_price;
  const stopLoss = trade.actual_stop ?? setup.stop_price;
  const mainTarget = trade.actual_target ?? setup.target_price ?? setup.take_profit;
  const targetLadder = dayTradingTargets(entry, stopLoss, mainTarget, trade.direction ?? setup.direction, trade.targets);
  const groupedRules = groupedChecklist(evaluations, module.code);
  return (
    <View style={styles.card}>
      <View style={styles.moduleHeader}>
        <View>
          <Text style={styles.cardTitle}>{module.shortName}</Text>
          <Text style={styles.muted}>{module.name}</Text>
          <Text style={styles.moduleTimingText}>{moduleTimingLabel(module)}</Text>
        </View>
        <View style={[styles.signalPill, signal.tone === "good" ? styles.goodPill : signal.tone === "bad" ? styles.badPill : styles.warnPill]}>
          <Text style={styles.signalText}>{signal.label}</Text>
        </View>
      </View>
      <Text style={styles.reason}>{setup.final_reason ?? signal.reason}</Text>
      <View style={styles.metricsGrid}>
        <Metric label="Direction" value={trade.direction ?? setup.direction ?? "--"} />
        <Metric label="Entry" value={formatPrice(entry)} />
        <Metric label="Stop Loss" value={formatPrice(stopLoss)} />
        <Metric label="TP1 1R" value={formatPrice(targetLadder.tp1)} />
        <Metric label="TP2 1.5R" value={formatPrice(targetLadder.tp2)} />
        <Metric label={`TP3 ${targetLadder.finalRLabel}`} value={formatPrice(targetLadder.tp3)} />
        <Metric label="Trade Horizon" value="Intraday max 12h" />
        <Metric label="Score" value={setup.favorability_score == null ? "--" : `${setup.favorability_score}/100`} />
        <Metric label="Trade" value={trade.outcome ?? "NONE"} />
        <Metric label="Week WR" value={formatPercent(module.weekly?.winRate)} />
        <Metric label="Month WR" value={formatPercent(module.monthly?.winRate)} />
      </View>
      <Text style={styles.sectionMini}>Rule Checklist</Text>
      {groupedRules.map((group) => (
        <View key={group.title} style={styles.checklistGroup}>
          <View style={styles.checklistGroupHeader}>
            <Text style={styles.checklistGroupTitle}>{group.title}</Text>
            <Text style={styles.checklistGroupMeta}>{group.summary}</Text>
          </View>
          {group.rules.slice(0, 8).map((rule: any) => (
            <View key={rule.rule_code ?? rule.ruleCode ?? rule.name} style={styles.ruleRow}>
              <Text style={[styles.ruleStatus, ruleStatusTone(rule.status)]}>{shortRuleStatus(rule.status)}</Text>
              <View style={styles.ruleBody}>
                <Text style={styles.ruleTitle}>{rule.name}</Text>
                <Text style={styles.ruleExplanation}>{rule.explanation}</Text>
              </View>
            </View>
          ))}
        </View>
      ))}
      {evaluations.length === 0 ? <Text style={styles.muted}>Waiting for this module to evaluate a completed NY candle.</Text> : null}

      <Text style={styles.sectionMini}>Learning Automation</Text>
      <View style={styles.learningPanel}>
        <View style={styles.learningHeader}>
          <View>
            <Text style={styles.ruleTitle}>{learning?.status === "COMPLETED" ? "Learning ready" : learning?.status === "FAILED" ? "Learning failed" : "Not trained yet"}</Text>
            <Text style={styles.ruleExplanation}>{learningStatusLabel(learning)}</Text>
          </View>
          <Pressable
            style={[styles.learningButton, learningBusy && styles.disabledButton]}
            disabled={learningBusy}
            onPress={(event) => {
              event.stopPropagation?.();
              onRunLearning?.(module.code);
            }}
          >
            <Text style={styles.learningButtonText}>{learningBusy ? "Running..." : "Run"}</Text>
          </Pressable>
        </View>
        <View style={styles.learningMetricRow}>
          <Metric label="Samples" value={learning?.sample_size ?? learning?.sampleSize ?? 0} />
          <Metric label="Mandatory" value={learningSummary.bySetupTier?.MANDATORY?.trades ?? 0} />
          <Metric label="Full" value={learningSummary.bySetupTier?.FULL?.trades ?? 0} />
        </View>
        {topRecommendation ? (
          <View style={styles.learningRecommendation}>
            <Text style={styles.learningRecommendationType}>{String(topRecommendation.recommendation_type ?? topRecommendation.recommendationType ?? "RECOMMENDATION").replaceAll("_", " ")}</Text>
            <Text style={styles.ruleTitle}>{topRecommendation.title ?? "Learning recommendation"}</Text>
            <Text style={styles.ruleExplanation}>{topRecommendation.rationale ?? "Review this module's latest learning output."}</Text>
          </View>
        ) : (
          <Text style={styles.muted}>Learning will separate mandatory-only and full-checklist paper trades for this module.</Text>
        )}
      </View>
    </View>
  );
}

function groupedChecklist(evaluations: any[], moduleCode: string) {
  const groups = [
    { title: moduleCode === "orb_max_options" ? "Mandatory ORB Gates" : "Mandatory Signal Gates", kind: "mandatory", rules: [] as any[] },
    { title: "Confirmation Rules", kind: "confirmation", rules: [] as any[] },
    { title: "Quality Filters", kind: "quality", rules: [] as any[] }
  ];
  for (const rule of evaluations) {
    const code = String(rule.rule_code ?? rule.ruleCode ?? rule.code ?? rule.name ?? "").toUpperCase();
    const name = String(rule.name ?? "").toUpperCase();
    const text = `${code} ${name}`;
    if (/SESSION|RANGE|SWEEP|DISPLACEMENT|BOS|CHOCH|DRIVE|PULLBACK|BREAKOUT|RETEST|ENTRY_ZONE/.test(text)) {
      groups[0].rules.push(rule);
    } else if (/EMA|VWAP|FVG|ORDER_BLOCK|OB|ENTRY_CANDLE|CONFIRMATION|BIAS|TREND/.test(text)) {
      groups[1].rules.push(rule);
    } else {
      groups[2].rules.push(rule);
    }
  }
  return groups
    .filter((group) => group.rules.length > 0)
    .map((group) => {
      const pass = group.rules.filter((rule) => String(rule.status ?? "").toUpperCase() === "PASS").length;
      return { ...group, summary: `${pass}/${group.rules.length}` };
    });
}

function ruleStatusTone(status: unknown) {
  const normalized = String(status ?? "").toUpperCase();
  if (normalized === "PASS") return styles.goodText;
  if (normalized === "FAIL" || normalized === "BLOCKED") return styles.badText;
  return styles.warnText;
}

function shortRuleStatus(status: unknown) {
  const normalized = String(status ?? "WAIT").toUpperCase();
  if (normalized === "NOT_APPLICABLE") return "N/A";
  if (normalized === "IN_PROGRESS") return "RUN";
  return normalized;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function EmptyCard({ text }: { text: string }) {
  return <View style={styles.card}><Text style={styles.muted}>{text}</Text></View>;
}

function BottomNavIcon({ tab, active }: { tab: MobileTab; active: boolean }) {
  const tone = active ? styles.iconLineActive : styles.iconLine;
  if (tab === "home") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconRoofLeft, tone]} />
        <View style={[styles.iconRoofRight, tone]} />
        <View style={[styles.iconHomeBase, tone]} />
      </View>
    );
  }
  if (tab === "buySell") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconSignalStem, tone]} />
        <View style={[styles.iconSignalDot, active ? styles.iconDotActive : styles.iconDot]} />
        <View style={[styles.iconSignalWaveOne, tone]} />
        <View style={[styles.iconSignalWaveTwo, tone]} />
      </View>
    );
  }
  if (tab === "chart") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconAxisLeft, tone]} />
        <View style={[styles.iconAxisBottom, tone]} />
        <View style={[styles.iconChartBarOne, tone]} />
        <View style={[styles.iconChartBarTwo, tone]} />
        <View style={[styles.iconChartBarThree, tone]} />
      </View>
    );
  }
  if (tab === "paper") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconBookCover, tone]} />
        <View style={[styles.iconBookLineOne, tone]} />
        <View style={[styles.iconBookLineTwo, tone]} />
      </View>
    );
  }
  return (
    <View style={styles.navIconCanvas}>
      <View style={[styles.iconMoreDotOne, active ? styles.iconDotActive : styles.iconDot]} />
      <View style={[styles.iconMoreDotTwo, active ? styles.iconDotActive : styles.iconDot]} />
      <View style={[styles.iconMoreDotThree, active ? styles.iconDotActive : styles.iconDot]} />
    </View>
  );
}

function MiniIcon({ name }: { name: string }) {
  if (name === "chart") {
    return (
      <View style={styles.miniIconCanvas}>
        <View style={styles.miniAxis} />
        <View style={styles.miniBarOne} />
        <View style={styles.miniBarTwo} />
        <View style={styles.miniBarThree} />
      </View>
    );
  }
  if (name === "alerts") {
    return (
      <View style={styles.miniIconCanvas}>
        <View style={styles.miniBell} />
        <View style={styles.miniBellDot} />
      </View>
    );
  }
  if (name === "time") {
    return (
      <View style={styles.miniClock}>
        <View style={styles.miniClockHandOne} />
        <View style={styles.miniClockHandTwo} />
      </View>
    );
  }
  if (name === "account") {
    return (
      <View style={styles.miniIconCanvas}>
        <View style={styles.miniUserHead} />
        <View style={styles.miniUserBody} />
      </View>
    );
  }
  return (
    <View style={styles.miniIconCanvas}>
      <View style={styles.miniSignalStem} />
      <View style={styles.miniSignalDot} />
      <View style={styles.miniSignalWave} />
    </View>
  );
}

function levelLineStyle(tone: string) {
  if (tone === "good") return styles.levelGoodLine;
  if (tone === "bad") return styles.levelBadLine;
  if (tone === "warn") return styles.levelWarnLine;
  if (tone === "entry") return styles.levelEntryLine;
  return styles.levelNeutralLine;
}

function levelTextStyle(tone: string) {
  if (tone === "good") return styles.levelGoodText;
  if (tone === "bad") return styles.levelBadText;
  if (tone === "warn") return styles.levelWarnText;
  if (tone === "entry") return styles.levelEntryText;
  return styles.levelNeutralText;
}

function chartLegend(chart: ChartPayload) {
  if (chart.moduleCode === "orb_max_options") {
    return [
      { label: "15M ORB range", tone: "warn" },
      { label: "5M trigger candles", tone: "entry" },
      { label: "Paper levels", tone: "good" }
    ];
  }
  if (chart.moduleCode === "high_probability_strategy_2") {
    return [
      { label: "Liquidity sweep", tone: "warn" },
      { label: "BOS / displacement", tone: "entry" },
      { label: "FVG / OB zone", tone: "neutral" },
      { label: "Entry / SL / TP", tone: "good" }
    ];
  }
  return [
    { label: "Module levels", tone: "entry" },
    { label: "Paper levels", tone: "good" }
  ];
}

function shortChartLevelLabel(label: string) {
  return label
    .replace("Opening Drive", "Drive")
    .replace("Displacement", "Disp.")
    .replace("BOS / CHoCH", "BOS")
    .replace("15M ORB", "ORB");
}

function isActionableModule(module: ModuleRow) {
  const label = signalLabel(module).label;
  if (label === "WAIT" || label === "NO TRADE") return false;
  const setup = module.currentSetup ?? {};
  const trade = module.currentTrade ?? {};
  return Boolean(trade.outcome === "ACTIVE" || (setupProbability(setup) >= 80 && (setup.entry_price || setup.status?.includes("SETUP") || setup.status === "PAPER_TRADE_OPENED")));
}

function isFullChecklistModule(module: ModuleRow) {
  const setup = module.currentSetup ?? {};
  const flags = setup.scenario_flags ?? {};
  if (flags.fullChecklistValid === true || flags.longChecklistBoost === true) return true;
  if (String(flags.setupTier ?? setup.setup_tier ?? "").toUpperCase() === "FULL") return true;
  const grouped = groupedChecklist(setup.evaluations ?? [], module.code);
  return grouped.length > 0 && grouped.every((group) => group.rules.every((rule: any) => String(rule.status ?? "").toUpperCase() === "PASS"));
}

function tradeAction(direction: unknown, fallbackLabel?: string) {
  const normalizedDirection = String(direction ?? "").toUpperCase();
  const normalizedFallback = String(fallbackLabel ?? "").toUpperCase();
  if (normalizedDirection === "SHORT" || normalizedDirection === "SELL" || normalizedFallback.includes("SELL")) return "SELL";
  return "BUY";
}

function entryRangeLabel(setup: any, fallbackEntry: unknown) {
  const low = setup.entry_zone_low ?? setup.entryZoneLow ?? setup.entry_low ?? setup.entryRangeLow;
  const high = setup.entry_zone_high ?? setup.entryZoneHigh ?? setup.entry_high ?? setup.entryRangeHigh;
  if (low != null && high != null) return `${formatPrice(low)} - ${formatPrice(high)}`;
  return formatPrice(fallbackEntry);
}

function setupScoreLabel(setup: any) {
  const numeric = setupProbability(setup);
  if (!Number.isFinite(numeric)) return "--";
  return `${numeric.toFixed(0)}/100`;
}

function setupProbability(setup: any) {
  const value = setup.chance ?? setup.confidence_score ?? setup.favorability_score ?? setup.score;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function signalLabel(module: ModuleRow) {
  const trade = module.currentTrade;
  const setup = module.currentSetup;
  if (trade?.outcome === "ACTIVE") return { label: trade.direction === "SHORT" ? "SELL ACTIVE" : "BUY ACTIVE", tone: trade.direction === "SHORT" ? "bad" : "good", reason: "Signal is active; paper tracking is recording win-rate and TP/SL outcome." };
  if (setup?.status === "LONG SETUP READY" || setup?.status === "PAPER_TRADE_OPENED") return { label: "BUY", tone: "good", reason: setup.final_reason ?? "Valid long setup." };
  if (setup?.status === "SHORT SETUP READY") return { label: "SELL", tone: "bad", reason: setup.final_reason ?? "Valid short setup." };
  if (setup?.status === "NO TRADE" || setup?.status === "BLOCKED") return { label: "NO TRADE", tone: "bad", reason: setup.final_reason ?? "Conditions blocked." };
  return { label: "WAIT", tone: "warn", reason: "Waiting for a valid session setup." };
}

function moduleIconLabel(moduleCode: string) {
  if (moduleCode === "orb_max_options") return "O";
  if (moduleCode === "high_probability_strategy_2") return "S";
  return "M";
}

function moduleTimingLabel(module: ModuleRow) {
  if (module.code === "orb_max_options") return "All-session 15M OR / 5M trigger";
  if (module.code === "high_probability_strategy_2") return "5M sweep + structure / 15M bias";
  return `${module.timeframeMinutes}M execution`;
}

function learningStatusLabel(learning?: ModuleLearningSnapshot) {
  if (!learning || learning.status === "NOT_RUN") return "No learning run yet for this module.";
  const samples = learning.sample_size ?? learning.sampleSize ?? 0;
  const recommendations = learning.recommendations?.length ?? learning.summary?.recommendations ?? 0;
  if (learning.status === "COMPLETED") return `${samples} result(s), ${recommendations} recommendation(s).`;
  if (learning.status === "FAILED") return "Latest learning run failed. Check backend logs.";
  return `${String(learning.status).replaceAll("_", " ")} · ${samples} result(s).`;
}

function notificationDetailFromPush(title: unknown, body: unknown, data: any): NotificationDetail {
  const payload = data ?? {};
  return {
    title: stringOrNull(title) ?? "Trading notification",
    body: stringOrNull(body) ?? "",
    eventType: stringOrNull(payload.eventType ?? payload.event_type),
    priority: stringOrNull(payload.priority),
    moduleCode: stringOrNull(payload.moduleCode ?? payload.module_code),
    moduleName: stringOrNull(payload.moduleName ?? payload.module_name),
    scenario: stringOrNull(payload.scenario),
    direction: stringOrNull(payload.direction),
    action: stringOrNull(payload.action),
    entry: payload.entry ?? payload.entryPrice ?? payload.entry_price ?? null,
    stopLoss: payload.stopLoss ?? payload.stop_loss ?? payload.sl ?? null,
    takeProfit: payload.takeProfit ?? payload.take_profit ?? payload.tp ?? null,
    targets: Array.isArray(payload.targets) ? payload.targets : [],
    targetNumber: payload.targetNumber ?? payload.target_number ?? null,
    targetPrice: payload.targetPrice ?? payload.target_price ?? null,
    riskMultiple: payload.riskMultiple ?? payload.risk_multiple ?? null,
    rewardToRisk: payload.rewardToRisk ?? payload.reward_to_risk ?? payload.rr ?? null,
    grade: payload.grade ?? null,
    confidence: payload.confidence ?? null,
    setupTier: stringOrNull(payload.setupTier ?? payload.setup_tier),
    variantCode: stringOrNull(payload.variantCode ?? payload.variant_code),
    variantName: stringOrNull(payload.variantName ?? payload.variant_name),
    variantVersion: stringOrNull(payload.variantVersion ?? payload.variant_version),
    setupCandidateId: payload.setupCandidateId ?? payload.setup_candidate_id ?? null,
    tradeId: payload.tradeId ?? payload.trade_id ?? null,
    symbol: stringOrNull(payload.symbol) ?? "XAUUSD",
    finalReason: stringOrNull(payload.finalReason ?? payload.final_reason),
    status: stringOrNull(payload.status),
    eventKey: stringOrNull(payload.eventKey ?? payload.event_key),
    mandatoryPassed: payload.mandatoryPassed ?? payload.mandatory_passed ?? null,
    confirmationPassed: payload.confirmationPassed ?? payload.confirmation_passed ?? null,
    qualityPassed: payload.qualityPassed ?? payload.quality_passed ?? null,
    missingRules: notificationMissingRules(payload.missingRules ?? payload.missing_rules),
    liquidity: payload.liquidity ?? null,
    displacement: payload.displacement ?? null,
    bos: payload.bos ?? null,
    entryZone: payload.entryZone ?? payload.entry_zone ?? null,
    category: stringOrNull(payload.category),
    issueCode: stringOrNull(payload.issueCode ?? payload.issue_code),
    recommendedAction: stringOrNull(payload.recommendedAction ?? payload.recommended_action),
    ageSeconds: payload.ageSeconds ?? payload.age_seconds ?? null,
    exitPrice: payload.exitPrice ?? payload.exit_price ?? payload.exit ?? null,
    resultR: payload.resultR ?? payload.result_r ?? null,
    closeReason: stringOrNull(payload.closeReason ?? payload.close_reason),
    provider: stringOrNull(payload.provider),
    cacheStatus: stringOrNull(payload.cacheStatus ?? payload.cache_status),
    schedulerStatus: stringOrNull(payload.schedulerStatus ?? payload.scheduler_status),
    source: "push"
  };
}

function dayTradingTargets(entryValue: unknown, stopValue: unknown, targetValue: unknown, directionValue: unknown, persistedTargets?: any[]) {
  const entry = Number(entryValue);
  const stop = Number(stopValue);
  const suppliedTarget = Number(targetValue);
  const direction = String(directionValue ?? "").toUpperCase();
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !["LONG", "SHORT", "BUY", "SELL"].includes(direction)) {
    return { tp1: null, tp2: null, tp3: null, finalRLabel: "strategy", statuses: [] as string[] };
  }
  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) return { tp1: null, tp2: null, tp3: null, finalRLabel: "strategy", statuses: [] as string[] };
  const multiplier = direction === "SHORT" || direction === "SELL" ? -1 : 1;
  const targetIsDirectional = Number.isFinite(suppliedTarget) && (suppliedTarget - entry) * multiplier > 0;
  const finalTarget = targetIsDirectional ? suppliedTarget : entry + multiplier * riskDistance * 2;
  const finalR = Math.abs(finalTarget - entry) / riskDistance;
  const generated = [Math.min(1, finalR), Math.min(1.5, finalR), finalR]
    .map((riskMultiple) => Number((entry + multiplier * riskDistance * riskMultiple).toFixed(2)));
  const persisted = Array.isArray(persistedTargets) ? [...persistedTargets].sort((a, b) => Number(a.targetNumber) - Number(b.targetNumber)) : [];
  const [tp1, tp2, tp3] = generated.map((price, index) => {
    const persistedPrice = Number(persisted[index]?.price);
    return Number.isFinite(persistedPrice) ? persistedPrice : price;
  });
  return {
    tp1,
    tp2,
    tp3,
    finalRLabel: `${Number(finalR.toFixed(2))}R`,
    statuses: persisted.map((target) => String(target.status ?? "PENDING").toUpperCase())
  };
}

function notificationDetailFromHistory(item: any, dashboard: Dashboard | null): NotificationDetail {
  const title = String(item?.title ?? "Trading notification");
  const body = String(item?.body ?? "");
  const payload = normalizeNotificationPayload(item?.data);
  const moduleCode = stringOrNull(payload.moduleCode ?? payload.module_code ?? item?.module_code) ?? moduleCodeFromText(`${item?.event_type ?? ""} ${title} ${body}`);
  const module = dashboard?.modules.find((row) => row.code === moduleCode) ?? null;
  const trade = module?.currentTrade ?? {};
  return {
    id: item?.id ?? null,
    title,
    body,
    eventType: stringOrNull(item?.event_type),
    priority: stringOrNull(item?.priority),
    createdAt: stringOrNull(item?.created_at),
    moduleCode,
    moduleName: stringOrNull(payload.moduleName ?? payload.module_name) ?? module?.shortName ?? moduleDisplayName(moduleCode),
    scenario: stringOrNull(payload.scenario) ?? extractScenario(body) ?? stringOrNull(module?.currentSetup?.scenario),
    direction: stringOrNull(payload.direction) ?? extractDirection(body) ?? stringOrNull(trade.direction),
    action: stringOrNull(payload.action) ?? extractAction(body) ?? (trade.direction === "SHORT" ? "SELL" : trade.direction === "LONG" ? "BUY" : null),
    entry: payload.entry ?? payload.entryPrice ?? payload.entry_price ?? extractBodyField(body, "entry") ?? trade.actual_entry ?? trade.entry_price ?? null,
    stopLoss: payload.stopLoss ?? payload.stop_loss ?? payload.sl ?? extractBodyField(body, "sl") ?? extractBodyField(body, "stop") ?? trade.actual_stop ?? trade.stop_price ?? null,
    takeProfit: payload.takeProfit ?? payload.take_profit ?? payload.tp ?? extractBodyField(body, "tp") ?? extractBodyField(body, "target") ?? trade.actual_target ?? trade.target_price ?? null,
    targets: Array.isArray(payload.targets) ? payload.targets : [],
    targetNumber: payload.targetNumber ?? payload.target_number ?? null,
    targetPrice: payload.targetPrice ?? payload.target_price ?? null,
    riskMultiple: payload.riskMultiple ?? payload.risk_multiple ?? null,
    rewardToRisk: payload.rewardToRisk ?? payload.reward_to_risk ?? payload.rr ?? extractBodyField(body, "rr") ?? trade.reward_to_risk ?? null,
    grade: payload.grade ?? extractBodyField(body, "grade") ?? module?.currentSetup?.trade_grade ?? null,
    confidence: payload.confidence ?? extractBodyField(body, "confidence") ?? module?.currentSetup?.confidence_score ?? null,
    setupTier: stringOrNull(payload.setupTier ?? payload.setup_tier) ?? stringOrNull(module?.currentSetup?.scenario_flags?.setupTier) ?? extractSetupTier(body),
    variantCode: stringOrNull(payload.variantCode ?? payload.variant_code) ?? stringOrNull(module?.currentSetup?.scenario_flags?.variantCode),
    variantName: stringOrNull(payload.variantName ?? payload.variant_name) ?? stringOrNull(module?.currentSetup?.scenario_flags?.module2Variant?.name),
    variantVersion: stringOrNull(payload.variantVersion ?? payload.variant_version) ?? stringOrNull(module?.currentSetup?.scenario_flags?.variantVersion),
    setupCandidateId: payload.setupCandidateId ?? payload.setup_candidate_id ?? item?.setup_candidate_id ?? module?.currentSetup?.id ?? null,
    tradeId: payload.tradeId ?? payload.trade_id ?? item?.trade_id ?? trade.id ?? null,
    symbol: stringOrNull(payload.symbol) ?? "XAUUSD",
    finalReason: stringOrNull(payload.finalReason ?? payload.final_reason),
    status: stringOrNull(payload.status),
    eventKey: stringOrNull(payload.eventKey ?? payload.event_key ?? item?.event_key),
    mandatoryPassed: payload.mandatoryPassed ?? payload.mandatory_passed ?? null,
    confirmationPassed: payload.confirmationPassed ?? payload.confirmation_passed ?? null,
    qualityPassed: payload.qualityPassed ?? payload.quality_passed ?? null,
    missingRules: notificationMissingRules(payload.missingRules ?? payload.missing_rules),
    liquidity: payload.liquidity ?? null,
    displacement: payload.displacement ?? null,
    bos: payload.bos ?? null,
    entryZone: payload.entryZone ?? payload.entry_zone ?? null,
    category: stringOrNull(payload.category),
    issueCode: stringOrNull(payload.issueCode ?? payload.issue_code),
    recommendedAction: stringOrNull(payload.recommendedAction ?? payload.recommended_action),
    ageSeconds: payload.ageSeconds ?? payload.age_seconds ?? null,
    exitPrice: payload.exitPrice ?? payload.exit_price ?? payload.exit ?? trade.actual_exit ?? null,
    resultR: payload.resultR ?? payload.result_r ?? trade.result_r ?? null,
    closeReason: stringOrNull(payload.closeReason ?? payload.close_reason ?? trade.close_reason),
    provider: stringOrNull(payload.provider),
    cacheStatus: stringOrNull(payload.cacheStatus ?? payload.cache_status),
    schedulerStatus: stringOrNull(payload.schedulerStatus ?? payload.scheduler_status),
    source: "history"
  };
}

function normalizeNotificationPayload(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function moduleCodeFromText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("orb") || normalized.includes("max option")) return "orb_max_options";
  if (normalized.includes("liquidity") || normalized.includes("sweep") || normalized.includes("bos")) return "high_probability_strategy_2";
  return null;
}

function moduleDisplayName(moduleCode?: string | null) {
  if (moduleCode === "orb_max_options") return "Module 1 ORB";
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Ultimate Sweep";
  return "Strategy module";
}

function extractBodyField(body: string, label: string) {
  const pattern = new RegExp(`${label}\\s*[:=]\\s*([A-Z+\\-]?\\d+(?:\\.\\d+)?%?|[A-Z][A-Z0-9+\\-]*)`, "i");
  return stringOrNull(body.match(pattern)?.[1]);
}

function extractScenario(body: string) {
  return extractBodyField(body, "scenario");
}

function extractDirection(body: string) {
  const upper = body.toUpperCase();
  if (upper.includes("SHORT") || upper.includes("SELL")) return "SHORT";
  if (upper.includes("LONG") || upper.includes("BUY")) return "LONG";
  return null;
}

function extractAction(body: string) {
  const upper = body.toUpperCase();
  if (upper.includes("SELL")) return "SELL";
  if (upper.includes("BUY")) return "BUY";
  return null;
}

function extractSetupTier(body: string) {
  const upper = body.toUpperCase();
  if (upper.includes("MANDATORY SETUP") || upper.includes("CORE BUY") || upper.includes("CORE SELL")) return "MANDATORY";
  if (upper.includes("FULL CHECKLIST SETUP") || upper.includes("FULL BUY") || upper.includes("FULL SELL")) return "FULL";
  return null;
}

function stringOrNull(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function notificationMissingRules(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean).slice(0, 8);
}

function notificationEvidencePrice(label: unknown, price: unknown) {
  const number = Number(price);
  const prefix = label ? `${formatScenarioName(String(label))} ` : "";
  return Number.isFinite(number) ? `${prefix}${number.toFixed(2)}` : "--";
}

function notificationZoneLabel(zone: any) {
  if (!zone || zone.low == null || zone.high == null) return "--";
  return `${formatPrice(zone.low)}-${formatPrice(zone.high)}`;
}

function hasTradeDetails(detail: NotificationDetail) {
  return detail.entry != null || detail.stopLoss != null || detail.takeProfit != null || detail.direction != null || detail.action != null;
}

function notificationCategory(detail: NotificationDetail) {
  const explicit = stringOrNull(detail.category)?.toUpperCase();
  if (explicit) return explicit;
  const haystack = `${detail.eventType ?? ""} ${detail.title} ${detail.body}`.toUpperCase();
  if (/TP[12]_HIT/.test(haystack)) return "TRADE_LIFECYCLE";
  if (hasTradeDetails(detail) || /ENTRY|SETUP_READY|VALID_ENTRY|BUY|SELL|SIGNAL/.test(haystack)) return "TRADE_SETUP";
  if (/TP[123]?_HIT|SL_HIT|TARGET|STOP LOSS|STOPPED|CLOSEOUT|CLOSED|WIN|LOSS/.test(haystack)) return "TRADE_CLOSEOUT";
  if (/TP[123]?_HIT|SL_HIT|CLOSE|CLOSED|OPEN_TOO_LONG|ACTIVE_TRADE|PAPER_TRADE|TRADE/.test(haystack)) return "TRADE_LIFECYCLE";
  if (/HEALTH|AUDIT|DISABLED|STALE|ERROR|FAILED|TOO_LONG|STUCK/.test(haystack)) return "HEALTH";
  if (/SESSION|WINDOW|PRESSESSION|PRE_SESSION|NY_START|EXPIRED/.test(haystack)) return "SESSION";
  if (/FEED|TWELVE|CANDLE|CACHE|MARKET_DATA/.test(haystack)) return "FEED";
  if (/REPORT|LEARNING|BACKTEST/.test(haystack)) return "SYSTEM";
  return "GENERAL";
}

function notificationRecommendedAction(category: string, detail: NotificationDetail) {
  const event = `${detail.eventType ?? ""} ${detail.title}`.toUpperCase();
  if (event.includes("ACTIVE_TRADE_OPEN_TOO_LONG")) return "Review the open paper trade on the module chart. The system will still close it automatically at TP or SL, but this alert means the trade has stayed open longer than expected.";
  if (event.includes("FEED_STALE")) return "Check market feed status and wait for the next scheduled candle sync before trusting fresh signals.";
  if (event.includes("SESSION_EXPIRED") || category === "SESSION") return "This is a session timing notice. New entries wait for the next active New York window.";
  if (category === "HEALTH") return "Open the module chart and System Status to inspect the affected automation, feed, or paper-trade state.";
  if (category === "FEED") return "Open Data Admin or the live chart to confirm candle cache and provider status.";
  if (category === "SYSTEM") return "Open the related dashboard screen for report, learning, or platform status details.";
  return "Open the module chart if this alert is connected to a strategy module.";
}

function formatDuration(value: unknown) {
  if (value == null || value === "") return "--";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatDetailValue(value: unknown) {
  if (value == null || value === "") return "--";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).length < 16) return numeric.toFixed(2);
  return String(value);
}

function cleanErrorMessage(message: string) {
  try {
    const parsed = JSON.parse(message);
    return parsed.message ?? parsed.error ?? message;
  } catch {
    return message;
  }
}

function formatPrice(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "--";
}

function formatPercent(value: unknown) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function formatR(value: unknown) {
  if (value == null || value === "") return "--";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}R`;
}

function formatScenarioName(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatFileSize(value: unknown) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTime(value: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function apiWebSocketUrl(apiBaseUrl: string, path: string) {
  const base = normalizeApiBaseUrl(apiBaseUrl);
  if (!base) return null;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function normalizeDownloadUrl(value: unknown, apiBaseUrl: string) {
  const raw = String(value ?? "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = normalizeApiBaseUrl(apiBaseUrl);
  if (!base) return raw;
  return `${base.replace(/\/$/, "")}/${raw.replace(/^\//, "")}`;
}

function normalizeApiBaseUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeCandles(candles: ChartCandle[]) {
  const byTime = new Map<number, ChartCandle>();
  for (const candle of candles) {
    const time = new Date(candle.timestampUtc).getTime();
    if (Number.isFinite(time)) byTime.set(time, candle);
  }
  return [...byTime.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

function normalizePushPreferences(input: Partial<PushPreferences> | null | undefined): PushPreferences {
  return {
    ...defaultPushPreferences,
    ...(input ?? {})
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#050706" },
  scroll: { flex: 1, paddingHorizontal: 16 },
  scrollContent: { paddingTop: 12, paddingBottom: 112 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  topBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 8, paddingBottom: 14 },
  searchBox: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#171a18",
    borderWidth: 1,
    borderColor: "#242a27",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16
  },
  headerMark: { width: 30, height: 30, marginRight: 10 },
  searchText: { color: "#b2bbb5", fontWeight: "700", fontSize: 14 },
  roundIconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#1d201e",
    borderWidth: 1,
    borderColor: "#2c3430",
    alignItems: "center",
    justifyContent: "center"
  },
  roundIconText: { color: "#f4f7f4", fontWeight: "900" },
  eyebrow: { color: "#2fe6a8", fontSize: 11, fontWeight: "800", letterSpacing: 0 },
  portfolioCard: {
    minHeight: 242,
    borderRadius: 24,
    backgroundColor: "#141816",
    borderWidth: 1,
    borderColor: "#2a302d",
    padding: 22,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.35,
    shadowRadius: 26,
    elevation: 8
  },
  cardGlow: {
    position: "absolute",
    top: -70,
    left: -20,
    right: -20,
    height: 150,
    backgroundColor: "#2a302d",
    opacity: 0.65,
    borderBottomLeftRadius: 120,
    borderBottomRightRadius: 120
  },
  heroTopRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  heroLabel: { color: "#9ca59f", fontSize: 13, fontWeight: "700" },
  heroValue: { color: "#f4f7f4", fontSize: 40, fontWeight: "900", marginTop: 10 },
  heroSub: { color: "#a4aea8", fontSize: 13, marginTop: 8, fontWeight: "700" },
  positiveText: { color: "#2fe6a8" },
  sessionBadge: { borderRadius: 18, backgroundColor: "#202522", paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: "#303832" },
  sessionBadgeText: { color: "#d8dfda", fontSize: 11, fontWeight: "900" },
  quickActions: { flexDirection: "row", justifyContent: "space-between", gap: 10, marginTop: 30 },
  quickAction: { flex: 1, alignItems: "center" },
  quickActionIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#353a37",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#434a45"
  },
  quickActionIconText: { color: "#f5f8f6", fontWeight: "900", fontSize: 18 },
  quickActionLabel: { color: "#f0f4f1", fontWeight: "800", fontSize: 12, marginTop: 10 },
  quickActionValue: { color: "#919c95", fontWeight: "700", fontSize: 10, marginTop: 4, maxWidth: 74 },
  updateBanner: {
    marginTop: 14,
    marginBottom: 2,
    minHeight: 86,
    borderRadius: 22,
    backgroundColor: "#13211b",
    borderWidth: 1,
    borderColor: "#2fe6a8",
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  updateBannerIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#20352c",
    alignItems: "center",
    justifyContent: "center"
  },
  updateBannerContent: { flex: 1 },
  updateBannerTitle: { color: "#f4f7f4", fontSize: 16, fontWeight: "900" },
  updateBannerCopy: { color: "#aeb8b2", fontSize: 12, fontWeight: "700", lineHeight: 17, marginTop: 5 },
  updateBannerAction: { color: "#2fe6a8", fontSize: 12, fontWeight: "900" },
  homeActionGrid: { flexDirection: "row", gap: 12, marginTop: 14 },
  homeActionCard: {
    flex: 1,
    minHeight: 128,
    borderRadius: 18,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    padding: 14
  },
  homeActionIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#202522",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12
  },
  homeActionTitle: { color: "#f4f7f4", fontWeight: "900", fontSize: 15 },
  homeActionCopy: { color: "#909a94", fontSize: 12, lineHeight: 17, marginTop: 6 },
  homeModuleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: "#252c28",
    paddingVertical: 13
  },
  homeModuleSignal: { fontSize: 12, fontWeight: "900" },
  statementCard: {
    marginTop: 14,
    borderRadius: 16,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#242a27",
    padding: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  statementIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: "#2b312d", alignItems: "center", justifyContent: "center" },
  statementIconText: { color: "#2fe6a8", fontWeight: "900", fontSize: 17 },
  statementContent: { flex: 1 },
  statementTitle: { color: "#f3f6f4", fontWeight: "900", fontSize: 15 },
  statementSub: { color: "#8d9791", marginTop: 4, fontSize: 12 },
  statementArrow: { color: "#f3f6f4", fontSize: 22, fontWeight: "900" },
  bottomNav: {
    position: "absolute",
    left: 14,
    right: 14,
    bottom: 22,
    zIndex: 50,
    height: 72,
    borderRadius: 28,
    backgroundColor: "#191d1a",
    borderWidth: 1,
    borderColor: "#2b302d",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 24
  },
  bottomNavItem: { flex: 1, height: 72, alignItems: "center", justifyContent: "center" },
  bottomNavIcon: { width: 34, height: 30, alignItems: "center", justifyContent: "center" },
  bottomNavText: { color: "#7f8983", fontWeight: "800", fontSize: 9, marginTop: 3 },
  bottomNavTextActive: { color: "#2fe6a8" },
  navIconCanvas: { width: 24, height: 24, position: "relative" },
  iconLine: { backgroundColor: "#7e8781", borderColor: "#7e8781" },
  iconLineActive: { backgroundColor: "#2fe6a8", borderColor: "#2fe6a8" },
  iconDot: { backgroundColor: "#7e8781" },
  iconDotActive: { backgroundColor: "#2fe6a8" },
  iconRoofLeft: { position: "absolute", left: 4, top: 5, width: 10, height: 3, borderRadius: 2, transform: [{ rotate: "-38deg" }] },
  iconRoofRight: { position: "absolute", right: 4, top: 5, width: 10, height: 3, borderRadius: 2, transform: [{ rotate: "38deg" }] },
  iconHomeBase: { position: "absolute", left: 6, right: 6, bottom: 5, height: 9, borderRadius: 2 },
  iconSignalStem: { position: "absolute", left: 10, top: 4, width: 3, height: 14, borderRadius: 2 },
  iconSignalDot: { position: "absolute", left: 7, top: 8, width: 9, height: 9, borderRadius: 5 },
  iconSignalWaveOne: { position: "absolute", left: 2, top: 5, width: 3, height: 12, borderRadius: 2 },
  iconSignalWaveTwo: { position: "absolute", right: 2, top: 5, width: 3, height: 12, borderRadius: 2 },
  iconAxisLeft: { position: "absolute", left: 3, top: 4, width: 3, height: 15, borderRadius: 2 },
  iconAxisBottom: { position: "absolute", left: 3, right: 3, bottom: 3, height: 3, borderRadius: 2 },
  iconChartBarOne: { position: "absolute", left: 7, bottom: 6, width: 3, height: 7, borderRadius: 2 },
  iconChartBarTwo: { position: "absolute", left: 12, bottom: 6, width: 3, height: 12, borderRadius: 2 },
  iconChartBarThree: { position: "absolute", left: 17, bottom: 6, width: 3, height: 9, borderRadius: 2 },
  iconBookCover: { position: "absolute", left: 5, top: 4, width: 13, height: 15, borderRadius: 3, borderWidth: 2, backgroundColor: "transparent" },
  iconBookLineOne: { position: "absolute", left: 8, top: 9, width: 8, height: 2, borderRadius: 2 },
  iconBookLineTwo: { position: "absolute", left: 8, top: 13, width: 6, height: 2, borderRadius: 2 },
  iconBellBody: { position: "absolute", left: 6, top: 7, width: 11, height: 10, borderTopLeftRadius: 7, borderTopRightRadius: 7, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  iconBellTop: { position: "absolute", left: 10, top: 4, width: 3, height: 4, borderRadius: 2 },
  iconBellClapper: { position: "absolute", left: 10, bottom: 3, width: 4, height: 4, borderRadius: 2 },
  iconMoreDotOne: { position: "absolute", left: 3, top: 9, width: 5, height: 5, borderRadius: 3 },
  iconMoreDotTwo: { position: "absolute", left: 9, top: 9, width: 5, height: 5, borderRadius: 3 },
  iconMoreDotThree: { position: "absolute", left: 15, top: 9, width: 5, height: 5, borderRadius: 3 },
  miniIconCanvas: { width: 22, height: 22, position: "relative" },
  miniAxis: { position: "absolute", left: 3, bottom: 4, width: 16, height: 2, borderRadius: 2, backgroundColor: "#f5f8f6" },
  miniBarOne: { position: "absolute", left: 6, bottom: 6, width: 3, height: 7, borderRadius: 2, backgroundColor: "#2fe6a8" },
  miniBarTwo: { position: "absolute", left: 11, bottom: 6, width: 3, height: 12, borderRadius: 2, backgroundColor: "#f0c94a" },
  miniBarThree: { position: "absolute", left: 16, bottom: 6, width: 3, height: 9, borderRadius: 2, backgroundColor: "#2fe6a8" },
  miniBell: { position: "absolute", left: 6, top: 5, width: 11, height: 12, borderRadius: 6, backgroundColor: "#2fe6a8" },
  miniBellDot: { position: "absolute", left: 10, bottom: 3, width: 4, height: 4, borderRadius: 2, backgroundColor: "#f5f8f6" },
  miniClock: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: "#2fe6a8", position: "relative" },
  miniClockHandOne: { position: "absolute", left: 9, top: 5, width: 2, height: 7, borderRadius: 2, backgroundColor: "#f5f8f6" },
  miniClockHandTwo: { position: "absolute", left: 10, top: 10, width: 6, height: 2, borderRadius: 2, backgroundColor: "#f5f8f6" },
  miniUserHead: { position: "absolute", left: 7, top: 3, width: 9, height: 9, borderRadius: 5, backgroundColor: "#f0c94a" },
  miniUserBody: { position: "absolute", left: 4, bottom: 3, width: 16, height: 9, borderRadius: 7, backgroundColor: "#2fe6a8" },
  miniSignalStem: { position: "absolute", left: 10, top: 4, width: 3, height: 14, borderRadius: 2, backgroundColor: "#2fe6a8" },
  miniSignalDot: { position: "absolute", left: 7, top: 8, width: 9, height: 9, borderRadius: 5, backgroundColor: "#f0c94a" },
  miniSignalWave: { position: "absolute", right: 2, top: 6, width: 3, height: 10, borderRadius: 2, backgroundColor: "#f5f8f6" },
  loginLogo: { width: 236, height: 72, marginBottom: 18, alignSelf: "center" },
  clockGrid: { flexDirection: "row", gap: 10, marginTop: 12 },
  sectionTitle: { color: "#f4f7f4", fontSize: 22, fontWeight: "900", marginTop: 22, marginBottom: 12 },
  moduleTabs: { gap: 12, paddingRight: 16 },
  moduleTab: {
    width: 178,
    minHeight: 154,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    borderRadius: 18,
    padding: 14
  },
  moduleTabActive: { borderColor: "#2fe6a8", backgroundColor: "#13211b" },
  moduleTabTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  moduleIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#252b27", alignItems: "center", justifyContent: "center" },
  moduleIconText: { color: "#2fe6a8", fontWeight: "900", fontSize: 17 },
  miniStatusDot: { width: 12, height: 12, borderRadius: 6 },
  dotGood: { backgroundColor: "#2fe6a8" },
  dotBad: { backgroundColor: "#ff6767" },
  dotWarn: { backgroundColor: "#f0c94a" },
  moduleTabTitle: { color: "#f4f7f4", fontWeight: "900", fontSize: 16 },
  moduleTabMeta: { color: "#939c96", marginTop: 8, fontSize: 12, fontWeight: "700" },
  moduleSignalText: { marginTop: 14, fontSize: 12, fontWeight: "900" },
  compactModuleTabs: { gap: 8, paddingRight: 16, marginBottom: 2 },
  compactModuleTab: {
    minWidth: 116,
    borderRadius: 18,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  compactModuleTabActive: { borderColor: "#2fe6a8", backgroundColor: "#13211b" },
  compactModuleText: { color: "#8d9690", fontWeight: "900", fontSize: 12 },
  compactModuleTextActive: { color: "#f4f7f4" },
  compactModuleMeta: { marginTop: 6, fontSize: 10, fontWeight: "900" },
  horizonTabs: { flexDirection: "row", gap: 10, marginBottom: 12 },
  horizonTab: {
    flex: 1,
    minHeight: 68,
    borderRadius: 18,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    paddingHorizontal: 14,
    paddingVertical: 11,
    justifyContent: "center"
  },
  horizonTabActive: { borderColor: "#2fe6a8", backgroundColor: "#13211b" },
  horizonTabText: { color: "#8d9690", fontWeight: "900", fontSize: 15 },
  horizonTabTextActive: { color: "#f4f7f4" },
  horizonTabMeta: { color: "#89938d", fontWeight: "700", fontSize: 11, marginTop: 5 },
  card: { backgroundColor: "#111412", borderWidth: 1, borderColor: "#252c28", borderRadius: 18, padding: 16, marginBottom: 14 },
  tradeSetupCard: {
    backgroundColor: "#101a15",
    borderWidth: 1,
    borderColor: "#254f40",
    borderRadius: 22,
    padding: 16,
    marginTop: 12,
    marginBottom: 14
  },
  tradeSetupCardSell: { backgroundColor: "#1a1112", borderColor: "#573036" },
  tradeSetupTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  tradeSetupModule: { color: "#2fe6a8", fontWeight: "900", fontSize: 12, marginBottom: 6 },
  tradeSetupTitle: { color: "#f4f7f4", fontWeight: "900", fontSize: 22, lineHeight: 27 },
  chartCard: {
    backgroundColor: "#0d100e",
    borderWidth: 1,
    borderColor: "#252c28",
    borderRadius: 22,
    paddingTop: 16,
    paddingBottom: 14,
    marginTop: 14,
    marginBottom: 16,
    overflow: "hidden"
  },
  chartHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 8 },
  chartLegend: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chartLegendItem: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#111412", borderWidth: 1, borderColor: "#252c28", borderRadius: 14, paddingHorizontal: 9, paddingVertical: 6 },
  chartLegendDot: { width: 9, height: 9, borderRadius: 5 },
  chartLegendText: { color: "#aeb8b2", fontSize: 10, fontWeight: "900" },
  priceBox: { alignItems: "flex-end" },
  priceLabel: { color: "#7d8781", fontSize: 11, fontWeight: "800" },
  priceValue: { color: "#2fe6a8", fontSize: 21, fontWeight: "900", marginTop: 2 },
  chartScroll: { paddingRight: 16 },
  chartPlot: { marginLeft: 10, marginRight: 10, backgroundColor: "#090c0a", borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#1b211d", position: "relative" },
  chartGridLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: "#1b211d" },
  chartLevelWrap: { position: "absolute", left: 0, right: 0, height: 20 },
  chartLevelLine: { position: "absolute", left: 0, right: 0, top: 0, height: 1 },
  chartLevelLabel: { position: "absolute", right: 4, top: 2, maxWidth: 132, fontSize: 10, fontWeight: "900", backgroundColor: "#090c0a", paddingHorizontal: 4 },
  candleHitArea: { position: "absolute", top: 0, width: 10 },
  candleWick: { position: "absolute", left: 4, width: 1 },
  candleBody: { position: "absolute", left: 1, borderRadius: 2 },
  candleUp: { backgroundColor: "#2fe6a8" },
  candleDown: { backgroundColor: "#ff6767" },
  candleSelected: { borderWidth: 1, borderColor: "#ffffff" },
  candleReadout: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingTop: 12 },
  levelGoodLine: { backgroundColor: "#2fe6a8" },
  levelBadLine: { backgroundColor: "#ff8c8c" },
  levelWarnLine: { backgroundColor: "#f0c94a" },
  levelEntryLine: { backgroundColor: "#49b8ff" },
  levelNeutralLine: { backgroundColor: "#a5b1aa" },
  levelGoodText: { color: "#2fe6a8" },
  levelBadText: { color: "#ff8c8c" },
  levelWarnText: { color: "#f0c94a" },
  levelEntryText: { color: "#49b8ff" },
  levelNeutralText: { color: "#a5b1aa" },
  moduleHeader: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  cardTitle: { color: "#f4f7f4", fontSize: 21, fontWeight: "900" },
  muted: { color: "#929c96", fontSize: 13 },
  moduleTimingText: { color: "#2fe6a8", fontWeight: "800", marginTop: 7, fontSize: 12 },
  reason: { color: "#c9d1cc", fontSize: 14, lineHeight: 21, marginTop: 14 },
  signalPill: { minWidth: 82, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  signalText: { color: "#050706", fontWeight: "900", fontSize: 12 },
  goodPill: { backgroundColor: "#2fe6a8" },
  badPill: { backgroundColor: "#ff6767" },
  warnPill: { backgroundColor: "#f0c94a" },
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  metric: { flexGrow: 1, flexBasis: "47%", backgroundColor: "#171a18", borderWidth: 1, borderColor: "#252c28", borderRadius: 13, padding: 13 },
  metricLabel: { color: "#89938d", fontSize: 12, fontWeight: "800" },
  metricValue: { color: "#f4f7f4", fontSize: 16, fontWeight: "900", marginTop: 7 },
  sectionMini: { color: "#f4f7f4", fontWeight: "900", marginTop: 18, marginBottom: 8, fontSize: 16 },
  checklistGroup: { backgroundColor: "#0d100e", borderWidth: 1, borderColor: "#26302a", borderRadius: 15, paddingHorizontal: 12, paddingTop: 10, marginBottom: 10 },
  checklistGroupHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingBottom: 2 },
  checklistGroupTitle: { color: "#edf5f0", fontWeight: "900", fontSize: 14, flex: 1 },
  checklistGroupMeta: { color: "#2fe6a8", fontWeight: "900", fontSize: 12 },
  ruleRow: { flexDirection: "row", gap: 10, borderTopWidth: 1, borderTopColor: "#252c28", paddingVertical: 12 },
  ruleStatus: { width: 52, fontSize: 11, fontWeight: "900" },
  ruleBody: { flex: 1 },
  ruleTitle: { color: "#edf5f0", fontWeight: "900" },
  ruleExplanation: { color: "#929c96", fontSize: 12, marginTop: 4, lineHeight: 17 },
  learningPanel: { backgroundColor: "#0d100e", borderWidth: 1, borderColor: "#26302a", borderRadius: 15, padding: 13 },
  learningHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  learningButton: { minWidth: 72, height: 36, borderRadius: 18, backgroundColor: "#2fe6a8", alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  learningButtonText: { color: "#050706", fontWeight: "900", fontSize: 12 },
  learningMetricRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  learningRecommendation: { marginTop: 12, borderTopWidth: 1, borderTopColor: "#26302a", paddingTop: 12 },
  learningRecommendationType: { color: "#2fe6a8", fontSize: 10, fontWeight: "900", marginBottom: 4 },
  goodText: { color: "#2fe6a8" },
  badText: { color: "#ff8c8c" },
  warnText: { color: "#f0c94a" },
  noticeRow: { flexDirection: "row", gap: 12, paddingVertical: 13, borderTopWidth: 1, borderTopColor: "#252c28" },
  noticePriority: { width: 4, borderRadius: 4, backgroundColor: "#2fe6a8" },
  noticeContent: { flex: 1 },
  noticeTitle: { color: "#edf5f0", fontWeight: "900" },
  noticeBody: { color: "#a8b4ad", marginTop: 4, lineHeight: 19 },
  noticeTime: { color: "#747e78", marginTop: 6, fontSize: 11, fontWeight: "700" },
  noticeChevron: { color: "#a8b4ad", fontSize: 24, fontWeight: "900", alignSelf: "center" },
  detailTopBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 8, marginBottom: 14 },
  backButton: {
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: "#171a18",
    borderWidth: 1,
    borderColor: "#2b302d",
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center"
  },
  backButtonText: { color: "#f4f7f4", fontSize: 15, fontWeight: "900" },
  detailPill: {
    color: "#2fe6a8",
    fontSize: 11,
    fontWeight: "900",
    backgroundColor: "#13211b",
    borderWidth: 1,
    borderColor: "#254f40",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  detailHero: {
    borderRadius: 24,
    backgroundColor: "#141816",
    borderWidth: 1,
    borderColor: "#2a302d",
    padding: 20,
    marginBottom: 14
  },
  detailTitle: { color: "#f4f7f4", fontSize: 28, fontWeight: "900", marginTop: 10, lineHeight: 34 },
  detailBody: { color: "#b9c3bd", fontSize: 15, lineHeight: 23, marginTop: 12 },
  tradeBadgeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 4, marginBottom: 2 },
  tradeDirectionBadge: {
    overflow: "hidden",
    color: "#04100b",
    backgroundColor: "#2fe6a8",
    borderRadius: 18,
    paddingHorizontal: 13,
    paddingVertical: 8,
    fontWeight: "900",
    fontSize: 12
  },
  tradeDirectionSell: { backgroundColor: "#ff6767" },
  tradeSymbol: {
    overflow: "hidden",
    color: "#f4f7f4",
    backgroundColor: "#202522",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontWeight: "900",
    fontSize: 12
  },
  tradeModule: {
    flexShrink: 1,
    overflow: "hidden",
    color: "#aeb8b2",
    backgroundColor: "#171a18",
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontWeight: "800",
    fontSize: 12
  },
  journalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: "#252c28",
    paddingVertical: 14
  },
  journalStats: { alignItems: "flex-end" },
  journalValue: { color: "#2fe6a8", fontWeight: "900", fontSize: 18 },
  journalLabel: { color: "#89938d", fontSize: 11, fontWeight: "800", marginTop: 3 },
  journalTradeCard: { borderTopWidth: 1, borderTopColor: "#252c28", paddingTop: 14, marginTop: 14 },
  mobileTargetProgress: { flexDirection: "row", gap: 8, marginTop: 10 },
  mobileTargetStep: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: "#303a35", borderRadius: 6, padding: 9, gap: 3 },
  mobileTargetStepHit: { borderColor: "#20c997", backgroundColor: "#10281f" },
  journalTradeTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  journalEvidenceLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10 },
  moreProfileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    borderRadius: 20,
    padding: 14,
    marginBottom: 14
  },
  moreAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#202522",
    alignItems: "center",
    justifyContent: "center"
  },
  moreProfileText: { flex: 1 },
  moreProfileName: { color: "#f4f7f4", fontSize: 17, fontWeight: "900" },
  moreProfileMeta: { color: "#8d9791", fontSize: 12, fontWeight: "700", marginTop: 4 },
  morePlanBadge: {
    maxWidth: 98,
    borderRadius: 14,
    backgroundColor: "#13211b",
    borderWidth: 1,
    borderColor: "#2fe6a8",
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  morePlanText: { color: "#2fe6a8", fontSize: 10, fontWeight: "900" },
  moreMenuGroup: {
    backgroundColor: "#111412",
    borderWidth: 1,
    borderColor: "#252c28",
    borderRadius: 20,
    paddingHorizontal: 14,
    marginBottom: 14
  },
  moreMenuRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: "#252c28",
    paddingVertical: 12
  },
  moreMenuIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#202522",
    alignItems: "center",
    justifyContent: "center"
  },
  moreMenuContent: { flex: 1 },
  moreMenuTitle: { color: "#edf5f0", fontSize: 15, fontWeight: "900" },
  moreMenuSubtitle: { color: "#89938d", fontSize: 12, fontWeight: "700", marginTop: 4 },
  moreMenuValue: { maxWidth: 80, color: "#8d9791", fontSize: 11, fontWeight: "900" },
  moreDiagnosticsCard: { backgroundColor: "#111412", borderWidth: 1, borderColor: "#252c28", borderRadius: 20, padding: 16, marginBottom: 14 },
  notificationTradeBuy: { borderColor: "#254f40", backgroundColor: "#101a15" },
  notificationTradeSell: { borderColor: "#573036", backgroundColor: "#1a1112" },
  notificationEvidenceStrip: { marginTop: 10, gap: 8 },
  moreHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20, marginBottom: 14 },
  moreBackButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#171a18",
    borderWidth: 1,
    borderColor: "#252c28",
    alignItems: "center",
    justifyContent: "center"
  },
  moreBackText: { color: "#f4f7f4", fontSize: 22, fontWeight: "900" },
  moreHeaderTitle: { color: "#f4f7f4", fontSize: 21, fontWeight: "900", flex: 1 },
  mfaQrCard: {
    alignSelf: "center",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#f4f7f4",
    borderRadius: 18,
    padding: 14,
    marginVertical: 10
  },
  mfaQrText: { color: "#07100c", fontSize: 12, fontWeight: "900" },
  pushToggleRow: {
    minHeight: 78,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: "#252c28",
    paddingVertical: 12
  },
  pushToggleText: { flex: 1 },
  tokenLabel: { color: "#89938d", fontSize: 12, fontWeight: "900", marginTop: 14 },
  tokenValue: {
    color: "#c4cdc7",
    backgroundColor: "#171a18",
    borderWidth: 1,
    borderColor: "#252c28",
    borderRadius: 13,
    padding: 12,
    marginTop: 7,
    fontSize: 11,
    lineHeight: 16
  },
  fullButton: { marginTop: 14, backgroundColor: "#2fbf8b", borderRadius: 22, paddingVertical: 14, alignItems: "center" },
  fullButtonText: { color: "#04100b", fontWeight: "900" },
  disabledButton: { opacity: 0.45 },
  ticketTypeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12, marginBottom: 10 },
  ticketTypeButton: { backgroundColor: "#171a18", borderWidth: 1, borderColor: "#2a302d", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9 },
  ticketTypeButtonActive: { backgroundColor: "#173328", borderColor: "#2fbf8b" },
  ticketTypeText: { color: "#8d9791", fontSize: 11, fontWeight: "900" },
  ticketTypeTextActive: { color: "#2fe6a8" },
  ticketTextArea: { minHeight: 104, textAlignVertical: "top" },
  secondaryButton: {
    marginTop: 10,
    backgroundColor: "#171a18",
    borderWidth: 1,
    borderColor: "#2fbf8b",
    borderRadius: 22,
    paddingVertical: 14,
    alignItems: "center"
  },
  secondaryButtonText: { color: "#2fe6a8", fontWeight: "900" },
  accountModuleRow: { borderTopWidth: 1, borderTopColor: "#252c28", paddingVertical: 12 },
  loginWrap: { flex: 1, justifyContent: "center", padding: 22 },
  loginTitle: { color: "#f4f7f4", fontSize: 40, fontWeight: "900", marginTop: 8 },
  loginCopy: { color: "#9ca7a0", fontSize: 15, lineHeight: 23, marginVertical: 20 },
  passwordHint: { color: "#8d9791", fontSize: 12, lineHeight: 18, marginBottom: 10 },
  input: { backgroundColor: "#111412", borderWidth: 1, borderColor: "#2a302d", borderRadius: 18, color: "#f4f7f4", paddingHorizontal: 16, paddingVertical: 14, marginBottom: 10 },
  loginButton: { backgroundColor: "#2fe6a8", borderRadius: 22, paddingVertical: 15, alignItems: "center", marginTop: 6 },
  loginButtonText: { color: "#050706", fontWeight: "900", fontSize: 15 }
});
