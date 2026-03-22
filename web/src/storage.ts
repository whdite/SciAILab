import type { UiSettings } from "./types";

const STORAGE_KEY = "sciailab.web.settings";

const DEFAULT_SETTINGS: UiSettings = {
  apiBaseUrl: "",
  gatewayUrl: "ws://127.0.0.1:18789",
  defaultProjectId: "",
  traceLimit: 60,
  autoRefreshSeconds: 10,
  locale: "zh-CN",
};

export function loadSettings(): UiSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl : DEFAULT_SETTINGS.apiBaseUrl,
      gatewayUrl: typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : DEFAULT_SETTINGS.gatewayUrl,
      defaultProjectId:
        typeof parsed.defaultProjectId === "string"
          ? parsed.defaultProjectId
          : DEFAULT_SETTINGS.defaultProjectId,
      traceLimit:
        typeof parsed.traceLimit === "number" && Number.isFinite(parsed.traceLimit)
          ? Math.max(10, Math.min(200, Math.trunc(parsed.traceLimit)))
          : DEFAULT_SETTINGS.traceLimit,
      autoRefreshSeconds:
        typeof parsed.autoRefreshSeconds === "number" && Number.isFinite(parsed.autoRefreshSeconds)
          ? Math.max(0, Math.min(120, Math.trunc(parsed.autoRefreshSeconds)))
          : DEFAULT_SETTINGS.autoRefreshSeconds,
      locale: parsed.locale === "en-US" ? "en-US" : DEFAULT_SETTINGS.locale,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: UiSettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
