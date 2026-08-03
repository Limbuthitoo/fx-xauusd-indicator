import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
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
const PUSH_TOKEN_KEY = "orb_mobile_push_token";
const PUSH_SYNC_KEY = "orb_mobile_push_synced_at";
const UPDATE_PROMPT_KEY = "orb_mobile_update_prompted_version";
const DEFAULT_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  "http://localhost:7073";
const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
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
  user: { displayName: string; email: string };
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
  rewardToRisk?: string | number | null;
  grade?: string | number | null;
  confidence?: string | number | null;
  setupCandidateId?: string | number | null;
  tradeId?: string | number | null;
  symbol?: string | null;
  source: "push" | "history";
};

type MoreView = "menu" | "profile" | "push-settings" | "modules" | "chart-preferences" | "session-settings" | "notification-history" | "support" | "about";

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

type MobileTab = "home" | "signals" | "chart" | "journal" | "alerts" | "more";

const mobileTabs: Array<{ key: MobileTab; label: string }> = [
  { key: "home", label: "Home" },
  { key: "signals", label: "Signals" },
  { key: "chart", label: "Chart" },
  { key: "journal", label: "Journal" },
  { key: "alerts", label: "Alerts" },
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
  const [selectedCandle, setSelectedCandle] = useState<ChartCandle | null>(null);
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
  const [moreView, setMoreView] = useState<MoreView>("menu");
  const [socketStatus, setSocketStatus] = useState("Socket offline");
  const [activeTab, setActiveTab] = useState<MobileTab>("home");
  const [selectedNotificationDetail, setSelectedNotificationDetail] = useState<NotificationDetail | null>(null);
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
      setActiveTab("alerts");
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
  }, [token, apiBaseUrl, selectedModuleCode, authUser?.passwordChangeRequired]);

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
    const [savedToken, savedApi, savedPushToken, savedPushSyncedAt] = await Promise.all([
      readSecureToken(),
      AsyncStorage.getItem(API_URL_KEY),
      AsyncStorage.getItem(PUSH_TOKEN_KEY),
      AsyncStorage.getItem(PUSH_SYNC_KEY)
    ]);
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

  async function login(email: string, password: string) {
    const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    if (!response.ok) throw new Error("Invalid tenant login.");
    const payload = await response.json() as { token: string; user: AuthUser };
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
    if (syncChart && nextModuleCode) await loadChart(nextModuleCode, authToken);
    checkAppUpdate().catch(() => undefined);
    setLoading(false);
  }

  async function checkAppUpdate() {
    if (Platform.OS !== "android") return;
    const response = await fetch(`${apiBaseUrl}/api/mobile/app-update?platform=android&currentVersion=${encodeURIComponent(APP_VERSION)}`);
    if (!response.ok) return;
    const payload = await response.json() as { updateAvailable?: boolean; latest?: any };
    const latest = payload.latest;
    if (!payload.updateAvailable || !latest?.downloadUrl || !latest?.version_name) return;
    const prompted = await AsyncStorage.getItem(UPDATE_PROMPT_KEY);
    if (prompted === latest.version_name) return;
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
    const response = await fetch(`${apiBaseUrl}/api/mobile/chart?moduleCode=${encodeURIComponent(moduleCode)}&limit=90`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json() as ChartPayload;
    setChart(data);
    setSelectedCandle(data.candles[data.candles.length - 1] ?? null);
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
            onOpenAlerts={() => setActiveTab("alerts")}
            onOpenSignals={() => setActiveTab("signals")}
            onOpenChart={() => setActiveTab("chart")}
          />
        ) : null}

        {activeTab === "signals" ? (
          <SignalsScreen
            dashboard={dashboard}
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
            chart={chart?.moduleCode === selectedModule?.code ? chart : null}
            selectedCandle={selectedCandle}
            setSelectedCandle={setSelectedCandle}
            onSelectModule={(moduleCode) => {
              setSelectedModuleCode(moduleCode);
              loadChart(moduleCode).catch((error) => Alert.alert("Chart failed", error.message));
            }}
          />
        ) : null}

        {activeTab === "journal" ? <JournalScreen dashboard={dashboard} /> : null}

        {activeTab === "alerts" ? (
          <AlertsScreen
            notifications={dashboard?.notifications ?? []}
            onOpenNotification={(item) => {
              setSelectedNotificationDetail(notificationDetailFromHistory(item, dashboard));
              acknowledgeNotification(item.id);
            }}
          />
        ) : null}

        {activeTab === "more" ? (
          <MoreScreen
            dashboard={dashboard}
            apiBaseUrl={apiBaseUrl}
            pushStatus={pushStatus}
            pushDiagnostics={pushDiagnostics}
            pushPreferences={pushPreferences}
            view={moreView}
            setView={setMoreView}
            socketStatus={socketStatus}
            onRegisterPush={() => registerPush().catch((error) => Alert.alert("Push failed", error.message))}
            onTestPush={() => sendTestPush().catch((error) => Alert.alert("Test push failed", error.message))}
            onDisablePushDevice={(deviceId) => disablePushDevice(deviceId).catch((error) => Alert.alert("Disable failed", error.message))}
            onSavePushPreferences={(preferences) => savePushPreferences(preferences).catch((error) => Alert.alert("Save failed", error.message))}
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

function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        <Pressable
          style={styles.loginButton}
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await onLogin(email, password);
            } catch (error) {
              Alert.alert("Login failed", (error as Error).message);
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
  onOpenAlerts,
  onOpenSignals,
  onOpenChart
}: {
  dashboard: Dashboard | null;
  activeSignals: number;
  latestAlert: any;
  pushStatus: string;
  socketStatus: string;
  onOpenAlerts: () => void;
  onOpenSignals: () => void;
  onOpenChart: () => void;
}) {
  const modules = dashboard?.modules ?? [];
  const bestModule = modules.find((module) => signalLabel(module).label !== "WAIT") ?? modules[0];
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

      <View style={styles.homeActionGrid}>
        <Pressable style={styles.homeActionCard} onPress={onOpenSignals}>
          <View style={styles.homeActionIcon}><MiniIcon name="signals" /></View>
          <Text style={styles.homeActionTitle}>Strategy Signals</Text>
          <Text style={styles.homeActionCopy}>Rule checklist, entry status, SL and TP.</Text>
        </Pressable>
        <Pressable style={styles.homeActionCard} onPress={onOpenChart}>
          <View style={styles.homeActionIcon}><MiniIcon name="chart" /></View>
          <Text style={styles.homeActionTitle}>Live XAUUSD Chart</Text>
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
        <EmptyCard text={bestModule ? "No new alerts. Assigned modules are waiting for valid NY session setups." : "No alerts yet."} />
      )}
    </>
  );
}

function SignalsScreen({
  dashboard,
  onSelectModule
}: {
  dashboard: Dashboard | null;
  onSelectModule: (moduleCode: string) => void;
}) {
  const modules = dashboard?.modules ?? [];
  return (
    <>
      <View style={styles.clockGrid}>
        <Metric label="New York" value={dashboard?.clocks.newYork ?? "--"} />
        <Metric label="Nepal" value={dashboard?.clocks.nepal ?? "--"} />
      </View>

      <SectionTitle title="Strategy Signals" />
      {modules.map((module) => (
        <Pressable key={module.code} onPress={() => onSelectModule(module.code)}>
          <ModuleDetail module={module} />
        </Pressable>
      ))}
      {modules.length === 0 ? <EmptyCard text="No strategy modules are assigned to this tenant account." /> : null}
    </>
  );
}

function ChartScreen({
  dashboard,
  selectedModule,
  chart,
  selectedCandle,
  setSelectedCandle,
  onSelectModule
}: {
  dashboard: Dashboard | null;
  selectedModule?: ModuleRow;
  chart: ChartPayload | null;
  selectedCandle: ChartCandle | null;
  setSelectedCandle: (candle: ChartCandle) => void;
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
        <MobileCandlestickChart chart={chart} selectedCandle={selectedCandle} onSelectCandle={setSelectedCandle} />
      ) : (
        <EmptyCard text="No strategy module is selected." />
      )}
      {selectedModule ? <ModuleDetail module={selectedModule} /> : null}
    </>
  );
}

function JournalScreen({ dashboard }: { dashboard: Dashboard | null }) {
  const modules = dashboard?.modules ?? [];
  return (
    <>
      <SectionTitle title="Paper Journal" />
      <View style={styles.card}>
        {modules.map((module) => {
          const trade = module.currentTrade ?? {};
          return (
            <View key={module.code} style={styles.journalRow}>
              <View>
                <Text style={styles.ruleTitle}>{module.shortName}</Text>
                <Text style={styles.muted}>{trade.outcome ?? "No active paper trade"}</Text>
              </View>
              <View style={styles.journalStats}>
                <Text style={styles.journalValue}>{formatPercent(module.weekly?.winRate)}</Text>
                <Text style={styles.journalLabel}>Week WR</Text>
              </View>
            </View>
          );
        })}
        {modules.length === 0 ? <Text style={styles.muted}>No journal data yet.</Text> : null}
      </View>
    </>
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
  const isTradeAlert = hasTradeDetails(detail) || entry !== "--" || stopLoss !== "--" || takeProfit !== "--";

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

        <View style={styles.moreDiagnosticsCard}>
          <Text style={styles.sectionMini}>Trade Details</Text>
          <View style={styles.tradeBadgeRow}>
            <Text style={[styles.tradeDirectionBadge, action === "SELL" && styles.tradeDirectionSell]}>{action}</Text>
            <Text style={styles.tradeSymbol}>{symbol}</Text>
            <Text style={styles.tradeModule}>{detail.moduleName ?? module?.shortName ?? moduleDisplayName(moduleCode)}</Text>
          </View>
          <View style={styles.metricsGrid}>
            <Metric label="Entry" value={formatDetailValue(entry)} />
            <Metric label="Stop Loss" value={formatDetailValue(stopLoss)} />
            <Metric label="Take Profit" value={formatDetailValue(takeProfit)} />
            <Metric label="Direction" value={String(direction)} />
            <Metric label="RR" value={formatDetailValue(rr)} />
            <Metric label="Grade" value={formatDetailValue(detail.grade)} />
          </View>
          {!isTradeAlert ? <Text style={styles.reason}>This notification does not include a full paper-trade plan. Valid entry alerts will show entry, SL, TP, direction, RR, and module context here.</Text> : null}
        </View>

        <View style={styles.moreDiagnosticsCard}>
          <Text style={styles.sectionMini}>Setup Context</Text>
          <Metric label="Scenario" value={formatDetailValue(detail.scenario)} />
          <Metric label="Confidence" value={detail.confidence == null ? "--" : `${detail.confidence}%`} />
          <Metric label="Setup ID" value={formatDetailValue(detail.setupCandidateId)} />
          <Metric label="Trade ID" value={formatDetailValue(detail.tradeId)} />
          {moduleCode ? (
            <Pressable style={styles.fullButton} onPress={() => onOpenChart(moduleCode)}>
              <Text style={styles.fullButtonText}>Open Module Chart</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function MoreScreen({
  dashboard,
  apiBaseUrl,
  pushStatus,
  pushDiagnostics,
  pushPreferences,
  view,
  setView,
  socketStatus,
  onRegisterPush,
  onTestPush,
  onDisablePushDevice,
  onSavePushPreferences,
  onCreateTicket,
  onOpenNotification
}: {
  dashboard: Dashboard | null;
  apiBaseUrl: string;
  pushStatus: string;
  pushDiagnostics: PushDiagnostics;
  pushPreferences: PushPreferences;
  view: MoreView;
  setView: (view: MoreView) => void;
  socketStatus: string;
  onRegisterPush: () => void;
  onTestPush: () => void;
  onDisablePushDevice: (deviceId: string) => void;
  onSavePushPreferences: (preferences: PushPreferences) => void;
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
  if (view === "about") {
    return (
      <>
        <MoreHeader title="About" onBack={() => setView("menu")} />
        <View style={styles.moreDiagnosticsCard}>
          <Metric label="App" value={supportInfo.brandName ?? "XAUUSD Signal"} />
          <Metric label="Version" value="0.1.0" />
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
        <MoreMenuRow icon="alerts" title="Push Alerts" subtitle={pushStatus} value={pushDiagnostics.permission} onPress={() => setView("push-settings")} />
        <MoreMenuRow icon="signals" title="Strategy Modules" subtitle={`${modules.length} assigned modules`} value="Open" onPress={() => setView("modules")} />
        <MoreMenuRow icon="chart" title="Chart Preferences" subtitle="Candle view, modules, and live stream" value="Open" onPress={() => setView("chart-preferences")} />
      </View>

      <View style={styles.moreMenuGroup}>
        <MoreMenuRow icon="time" title="Session Settings" subtitle="New York session and Nepal time display" value="NY" onPress={() => setView("session-settings")} />
        <MoreMenuRow icon="alerts" title="Notification History" subtitle="Signal, report, and paper-trade alerts" value="Open" onPress={() => setView("notification-history")} />
        <MoreMenuRow icon="account" title="Support" subtitle={supportInfo.supportEmail ?? "Help, feedback, and issue reports"} value="Help" onPress={() => setView("support")} />
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
        <PushToggleRow title="Paper trade opened" subtitle="Notify when the system opens a paper trade." value={preferences.paperTradeOpened} onValueChange={(value) => update("paperTradeOpened", value)} />
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
  selectedCandle,
  onSelectCandle
}: {
  chart: ChartPayload | null;
  selectedCandle: ChartCandle | null;
  onSelectCandle: (candle: ChartCandle) => void;
}) {
  if (!chart) return <EmptyCard text="Loading XAUUSD chart from server cache..." />;
  if (chart.candles.length === 0) return <EmptyCard text="No cached XAUUSD candles are available yet." />;

  const plotHeight = 184;
  const topPad = 14;
  const bottomPad = 18;
  const candleStep = 10;
  const candleWidth = 6;
  const plotWidth = Math.max(340, chart.candles.length * candleStep + 56);
  const prices = [
    ...chart.candles.flatMap((candle) => [candle.high, candle.low]),
    ...chart.levels.map((level) => level.price)
  ].filter(Number.isFinite);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = Math.max(maxPrice - minPrice, 0.01);
  const priceToY = (price: number) => topPad + ((maxPrice - price) / range) * plotHeight;
  const latest = chart.candles[chart.candles.length - 1];
  const info = selectedCandle ?? latest;

  return (
    <View style={styles.chartCard}>
      <View style={styles.chartHeader}>
        <View>
          <Text style={styles.cardTitle}>{chart.symbol}</Text>
          <Text style={styles.muted}>{chart.timeframeMinutes}m live chart · {chart.candles.length} candles</Text>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.priceLabel}>Last</Text>
          <Text style={styles.priceValue}>{formatPrice(latest.close)}</Text>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chartScroll}>
        <View style={[styles.chartPlot, { width: plotWidth, height: plotHeight + topPad + bottomPad }]}>
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <View key={ratio} style={[styles.chartGridLine, { top: topPad + ratio * plotHeight }]} />
          ))}
          {chart.levels.map((level) => {
            const y = priceToY(level.price);
            return (
              <View key={`${level.label}-${level.price}`} style={[styles.chartLevelWrap, { top: y }]}>
                <View style={[styles.chartLevelLine, levelLineStyle(level.tone)]} />
                <Text style={[styles.chartLevelLabel, levelTextStyle(level.tone)]}>{level.label} {formatPrice(level.price)}</Text>
              </View>
            );
          })}
          {chart.candles.map((candle, index) => {
            const rising = candle.close >= candle.open;
            const x = 24 + index * candleStep;
            const wickTop = priceToY(candle.high);
            const wickBottom = priceToY(candle.low);
            const bodyTop = priceToY(Math.max(candle.open, candle.close));
            const bodyBottom = priceToY(Math.min(candle.open, candle.close));
            const bodyHeight = Math.max(bodyBottom - bodyTop, 2);
            const isSelected = selectedCandle?.timestampUtc === candle.timestampUtc;
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

function ModuleDetail({ module }: { module: ModuleRow }) {
  const signal = signalLabel(module);
  const setup = module.currentSetup ?? {};
  const trade = module.currentTrade ?? {};
  const evaluations = setup.evaluations ?? [];
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
        <Metric label="Entry" value={formatPrice(trade.actual_entry ?? setup.entry_price)} />
        <Metric label="Stop Loss" value={formatPrice(trade.actual_stop ?? setup.stop_price)} />
        <Metric label="Take Profit" value={formatPrice(trade.actual_target ?? setup.target_price)} />
        <Metric label="Score" value={setup.favorability_score == null ? "--" : `${setup.favorability_score}/100`} />
        <Metric label="Trade" value={trade.outcome ?? "NONE"} />
        <Metric label="Week WR" value={formatPercent(module.weekly?.winRate)} />
        <Metric label="Month WR" value={formatPercent(module.monthly?.winRate)} />
      </View>
      <Text style={styles.sectionMini}>Rule Checklist</Text>
      {evaluations.slice(0, 8).map((rule: any) => (
        <View key={rule.rule_code ?? rule.ruleCode ?? rule.name} style={styles.ruleRow}>
          <Text style={[styles.ruleStatus, rule.status === "PASS" ? styles.goodText : rule.status === "FAIL" ? styles.badText : styles.warnText]}>{rule.status ?? "WAIT"}</Text>
          <View style={styles.ruleBody}>
            <Text style={styles.ruleTitle}>{rule.name}</Text>
            <Text style={styles.ruleExplanation}>{rule.explanation}</Text>
          </View>
        </View>
      ))}
      {evaluations.length === 0 ? <Text style={styles.muted}>Waiting for this module to evaluate a completed NY candle.</Text> : null}
    </View>
  );
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
  if (tab === "signals") {
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
  if (tab === "journal") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconBookCover, tone]} />
        <View style={[styles.iconBookLineOne, tone]} />
        <View style={[styles.iconBookLineTwo, tone]} />
      </View>
    );
  }
  if (tab === "alerts") {
    return (
      <View style={styles.navIconCanvas}>
        <View style={[styles.iconBellBody, tone]} />
        <View style={[styles.iconBellClapper, active ? styles.iconDotActive : styles.iconDot]} />
        <View style={[styles.iconBellTop, tone]} />
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

function signalLabel(module: ModuleRow) {
  const trade = module.currentTrade;
  const setup = module.currentSetup;
  if (trade?.outcome === "ACTIVE") return { label: trade.direction === "SHORT" ? "SELL ACTIVE" : "BUY ACTIVE", tone: trade.direction === "SHORT" ? "bad" : "good", reason: "Active paper trade is open." };
  if (setup?.status === "LONG SETUP READY" || setup?.status === "PAPER_TRADE_OPENED") return { label: "BUY", tone: "good", reason: setup.final_reason ?? "Valid long setup." };
  if (setup?.status === "SHORT SETUP READY") return { label: "SELL", tone: "bad", reason: setup.final_reason ?? "Valid short setup." };
  if (setup?.status === "NO TRADE" || setup?.status === "BLOCKED") return { label: "NO TRADE", tone: "bad", reason: setup.final_reason ?? "Conditions blocked." };
  return { label: "WAIT", tone: "warn", reason: "Waiting for valid NY session setup." };
}

function moduleIconLabel(moduleCode: string) {
  if (moduleCode === "orb_max_options") return "O";
  if (moduleCode === "high_probability_strategy_2") return "S";
  if (moduleCode === "strategy_lab_3") return "V";
  return "M";
}

function moduleTimingLabel(module: ModuleRow) {
  if (module.code === "orb_max_options") return "15M OR / 5M trigger";
  if (module.code === "high_probability_strategy_2") return "5M sweep / 15M bias";
  if (module.code === "strategy_lab_3") return "5M VWAP / 15M bias";
  return `${module.timeframeMinutes}M execution`;
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
    rewardToRisk: payload.rewardToRisk ?? payload.reward_to_risk ?? payload.rr ?? null,
    grade: payload.grade ?? null,
    confidence: payload.confidence ?? null,
    setupCandidateId: payload.setupCandidateId ?? payload.setup_candidate_id ?? null,
    tradeId: payload.tradeId ?? payload.trade_id ?? null,
    symbol: stringOrNull(payload.symbol) ?? "XAUUSD",
    source: "push"
  };
}

function notificationDetailFromHistory(item: any, dashboard: Dashboard | null): NotificationDetail {
  const title = String(item?.title ?? "Trading notification");
  const body = String(item?.body ?? "");
  const moduleCode = stringOrNull(item?.module_code) ?? moduleCodeFromText(`${item?.event_type ?? ""} ${title} ${body}`);
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
    moduleName: module?.shortName ?? moduleDisplayName(moduleCode),
    scenario: extractScenario(body) ?? stringOrNull(module?.currentSetup?.scenario),
    direction: extractDirection(body) ?? stringOrNull(trade.direction),
    action: extractAction(body) ?? (trade.direction === "SHORT" ? "SELL" : trade.direction === "LONG" ? "BUY" : null),
    entry: extractBodyField(body, "entry") ?? trade.actual_entry ?? trade.entry_price ?? null,
    stopLoss: extractBodyField(body, "sl") ?? extractBodyField(body, "stop") ?? trade.actual_stop ?? trade.stop_price ?? null,
    takeProfit: extractBodyField(body, "tp") ?? extractBodyField(body, "target") ?? trade.actual_target ?? trade.target_price ?? null,
    rewardToRisk: extractBodyField(body, "rr") ?? trade.reward_to_risk ?? null,
    grade: extractBodyField(body, "grade") ?? module?.currentSetup?.trade_grade ?? null,
    confidence: extractBodyField(body, "confidence") ?? module?.currentSetup?.confidence_score ?? null,
    setupCandidateId: item?.setup_candidate_id ?? module?.currentSetup?.id ?? null,
    tradeId: item?.trade_id ?? trade.id ?? null,
    symbol: "XAUUSD",
    source: "history"
  };
}

function moduleCodeFromText(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("orb") || normalized.includes("max option")) return "orb_max_options";
  if (normalized.includes("liquidity") || normalized.includes("sweep") || normalized.includes("bos")) return "high_probability_strategy_2";
  if (normalized.includes("vwap") || normalized.includes("opening drive")) return "strategy_lab_3";
  return null;
}

function moduleDisplayName(moduleCode?: string | null) {
  if (moduleCode === "orb_max_options") return "Module 1 ORB";
  if (moduleCode === "high_probability_strategy_2") return "Module 2 Sweep + BOS";
  if (moduleCode === "strategy_lab_3") return "Module 3 VWAP Drive";
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

function stringOrNull(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function hasTradeDetails(detail: NotificationDetail) {
  return detail.entry != null || detail.stopLoss != null || detail.takeProfit != null || detail.direction != null || detail.action != null;
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
  card: { backgroundColor: "#111412", borderWidth: 1, borderColor: "#252c28", borderRadius: 18, padding: 16, marginBottom: 14 },
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
  priceBox: { alignItems: "flex-end" },
  priceLabel: { color: "#7d8781", fontSize: 11, fontWeight: "800" },
  priceValue: { color: "#2fe6a8", fontSize: 21, fontWeight: "900", marginTop: 2 },
  chartScroll: { paddingRight: 16 },
  chartPlot: { marginLeft: 10, marginRight: 10, backgroundColor: "#090c0a", borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#1b211d", position: "relative" },
  chartGridLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: "#1b211d" },
  chartLevelWrap: { position: "absolute", left: 0, right: 0, height: 20 },
  chartLevelLine: { position: "absolute", left: 0, right: 0, top: 0, height: 1 },
  chartLevelLabel: { position: "absolute", right: 4, top: 2, fontSize: 10, fontWeight: "900", backgroundColor: "#090c0a", paddingHorizontal: 4 },
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
  ruleRow: { flexDirection: "row", gap: 10, borderTopWidth: 1, borderTopColor: "#252c28", paddingVertical: 12 },
  ruleStatus: { width: 52, fontSize: 11, fontWeight: "900" },
  ruleBody: { flex: 1 },
  ruleTitle: { color: "#edf5f0", fontWeight: "900" },
  ruleExplanation: { color: "#929c96", fontSize: 12, marginTop: 4, lineHeight: 17 },
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
