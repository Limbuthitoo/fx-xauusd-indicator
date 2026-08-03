export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:7073";
const TOKEN_KEY = "orb_admin_token";

export function getAuthToken() {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export function apiWebSocketUrl(path: string) {
  const base = new URL(API_BASE_URL);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = path;
  base.search = "";
  return base.toString();
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const controller = new AbortController();
  const timeoutMs = path.includes("/mobile-app/releases") && options.method === "POST" ? 120_000 : 10_000;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const body = options.body;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      credentials: "include",
      signal: options.signal ?? controller.signal,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });
    if (!response.ok) {
      if (response.status === 401) clearAuthToken();
      const body = await response.text();
      let parsed: any = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const message = parsed?.message ?? parsed?.error ?? body;
      throw new Error(message || `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`API request timed out: ${path}`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
