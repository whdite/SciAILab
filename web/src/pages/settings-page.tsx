import { useEffect, useState } from "react";
import { fetchHealth, fetchRuntimeSettings, updateRuntimeSettings } from "../api";
import { StatusBadge } from "../components/status-badge";
import { formatDateTime, t, translateBoolean, translateSaveState, type Locale } from "../i18n";
import type { HealthResponse, RuntimeSettings, SaveState, UiSettings } from "../types";

type SettingsPageProps = {
  settings: UiSettings;
  onApply: (settings: UiSettings) => void;
  onPreviewLocale: (locale: Locale | null) => void;
  locale: Locale;
};

type GatewayProbeResult = {
  status: "connected" | "reachable" | "error";
  message: string;
  resolvedUrl: string;
  checkedAt: string;
  closeCode?: number;
  closeReason?: string;
};

const GATEWAY_TEST_TIMEOUT_MS = 5000;
const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  handoff_pending_timeout_seconds: 30 * 60,
  handoff_blocked_timeout_seconds: 15 * 60,
};

export function SettingsPage({ settings, onApply, onPreviewLocale, locale }: SettingsPageProps) {
  const [draft, setDraft] = useState<UiSettings>(settings);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [runtimeSaved, setRuntimeSaved] = useState<RuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [runtimeSettingsUpdatedAt, setRuntimeSettingsUpdatedAt] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [runtimeSaveState, setRuntimeSaveState] = useState<SaveState>("idle");
  const [fastApiTestState, setFastApiTestState] = useState<SaveState>("idle");
  const [gatewayTestState, setGatewayTestState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [fastApiError, setFastApiError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [gatewayProbe, setGatewayProbe] = useState<GatewayProbeResult | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      onPreviewLocale(null);
    };
  }, [onPreviewLocale]);

  useEffect(() => {
    setGatewayProbe(null);
    setGatewayTestState("idle");
  }, [draft.gatewayUrl]);

  useEffect(() => {
    let cancelled = false;
    void fetchRuntimeSettings(draft.apiBaseUrl)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setRuntimeDraft(result.settings);
        setRuntimeSaved(result.settings);
        setRuntimeSettingsUpdatedAt(result.updated_at);
        setRuntimeError(null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setRuntimeDraft(DEFAULT_RUNTIME_SETTINGS);
        setRuntimeSaved(DEFAULT_RUNTIME_SETTINGS);
        setRuntimeSettingsUpdatedAt(null);
        setRuntimeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [draft.apiBaseUrl]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const runtimeDirty = JSON.stringify(runtimeDraft) !== JSON.stringify(runtimeSaved);

  async function handleSave(): Promise<void> {
    setSaveError(null);
    setRuntimeError(null);
    try {
      setSaveState("saving");
      onApply({
        ...draft,
        traceLimit: Math.max(10, Math.min(200, Math.trunc(draft.traceLimit))),
        autoRefreshSeconds: Math.max(0, Math.min(120, Math.trunc(draft.autoRefreshSeconds))),
      });
      setSaveState("saved");
      if (runtimeDirty) {
        setRuntimeSaveState("saving");
        const result = await updateRuntimeSettings(runtimeDraft, draft.apiBaseUrl);
        setRuntimeDraft(result.settings);
        setRuntimeSaved(result.settings);
        setRuntimeSettingsUpdatedAt(result.updated_at);
        setRuntimeSaveState("saved");
      }
      window.setTimeout(() => {
        setSaveState("idle");
        setRuntimeSaveState("idle");
      }, 1500);
    } catch (nextError) {
      setSaveState("error");
      if (runtimeDirty) {
        setRuntimeSaveState("error");
      }
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setSaveError(message);
      setRuntimeError(message);
    }
  }

  async function handleTestFastApi(): Promise<void> {
    setFastApiTestState("saving");
    setFastApiError(null);
    try {
      const result = await fetchHealth(draft.apiBaseUrl);
      setHealth(result);
      setFastApiTestState("saved");
      setFastApiError(null);
      window.setTimeout(() => setFastApiTestState("idle"), 1500);
    } catch (nextError) {
      setHealth(null);
      setFastApiTestState("error");
      setFastApiError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function handleTestGateway(): Promise<void> {
    setGatewayTestState("saving");
    const result = await probeGateway(draft.gatewayUrl, locale);
    setGatewayProbe(result);
    setGatewayTestState(result.status === "error" ? "error" : "saved");
    if (result.status !== "error") {
      window.setTimeout(() => setGatewayTestState("idle"), 1500);
    }
  }

  function handleReset(): void {
    setDraft(settings);
    setRuntimeDraft(runtimeSaved);
    onPreviewLocale(null);
    setSaveError(null);
    setRuntimeError(null);
    setFastApiError(null);
    setSaveState("idle");
    setRuntimeSaveState("idle");
    setFastApiTestState("idle");
    setGatewayTestState("idle");
    setHealth(null);
    setGatewayProbe(null);
  }

  return (
    <section className="page-layout single-column">
      <section className="hero-card">
        <div>
          <div className="eyebrow">{t(locale, "settings.heroEyebrow")}</div>
          <h1>{t(locale, "settings.title")}</h1>
          <p className="hero-copy">{t(locale, "settings.copy")}</p>
        </div>
        <div className="hero-meta">
          <div className="pill">{isDirty ? t(locale, "settings.unsaved") : t(locale, "settings.synced")}</div>
          <div
            className={`pill ${saveState === "error" || fastApiTestState === "error" || gatewayTestState === "error" ? "danger" : ""}`}
          >
            {t(locale, "settings.stateSummary", {
              save: translateSaveState(locale, saveState),
              api: translateSaveState(locale, fastApiTestState),
              gateway: translateSaveState(locale, gatewayTestState),
            })}
          </div>
          <div className={`pill ${runtimeSaveState === "error" ? "danger" : ""}`}>
            {localize(locale, `Runtime ${translateSaveState(locale, runtimeSaveState)}`, `runtime ${translateSaveState(locale, runtimeSaveState)}`)}
          </div>
        </div>
      </section>

      {saveError ? <div className="inline-alert danger">{saveError}</div> : null}
      {runtimeError ? <div className="inline-alert danger">{runtimeError}</div> : null}
      {fastApiError ? <div className="inline-alert danger">{fastApiError}</div> : null}

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "settings.configurationEyebrow")}</div>
            <h2>{t(locale, "settings.configurationTitle")}</h2>
          </div>
          <div className="button-row">
            <button type="button" className="ghost-button" onClick={() => void handleTestFastApi()}>
              {t(locale, "settings.testFastApi")}
            </button>
            <button type="button" className="ghost-button" onClick={() => void handleTestGateway()}>
              {t(locale, "settings.testGateway")}
            </button>
            <button type="button" className="ghost-button" onClick={handleReset}>
              {t(locale, "settings.reset")}
            </button>
            <button type="button" className="primary-button" onClick={() => void handleSave()}>
              {t(locale, "settings.save")}
            </button>
          </div>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>{t(locale, "settings.fastApiBaseUrl")}</span>
            <input
              value={draft.apiBaseUrl}
              placeholder={t(locale, "settings.fastApiPlaceholder")}
              onChange={(event) => setDraft((current) => ({ ...current, apiBaseUrl: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t(locale, "settings.gatewayUrl")}</span>
            <input
              value={draft.gatewayUrl}
              onChange={(event) => setDraft((current) => ({ ...current, gatewayUrl: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t(locale, "settings.defaultProjectId")}</span>
            <input
              value={draft.defaultProjectId}
              onChange={(event) => setDraft((current) => ({ ...current, defaultProjectId: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t(locale, "settings.traceLimit")}</span>
            <input
              type="number"
              min={10}
              max={200}
              value={draft.traceLimit}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  traceLimit: Math.max(10, Math.min(200, Math.trunc(Number(event.target.value) || 60))),
                }))
              }
            />
          </label>
          <label className="field">
            <span>{t(locale, "settings.autoRefreshSeconds")}</span>
            <input
              type="number"
              min={0}
              max={120}
              value={draft.autoRefreshSeconds}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  autoRefreshSeconds: Math.max(0, Math.min(120, Math.trunc(Number(event.target.value) || 0))),
                }))
              }
            />
          </label>
          <label className="field">
            <span>{t(locale, "settings.interfaceLanguage")}</span>
            <select
              value={draft.locale}
              onChange={(event) => {
                const nextLocale = event.target.value === "en-US" ? "en-US" : "zh-CN";
                setDraft((current) => ({ ...current, locale: nextLocale }));
                onPreviewLocale(nextLocale);
              }}
            >
              <option value="zh-CN">{t(locale, "language.zh-CN")}</option>
              <option value="en-US">{t(locale, "language.en-US")}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "settings.healthEyebrow")}</div>
            <h2>{t(locale, "settings.healthTitle")}</h2>
          </div>
        </div>
        {health ? (
          <div className="hint-grid">
            <div className="hint-card">
              <strong>{t(locale, "settings.status")}</strong>
              <span>{health.status}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.dbPath")}</strong>
              <span className="mono">{health.db_path}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.workspaceRoot")}</strong>
              <span className="mono">{health.workspace_root}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.autoConsumeEvents")}</strong>
              <span>{translateBoolean(locale, health.auto_consume_events)}</span>
            </div>
          </div>
        ) : (
          <div className="empty-state compact">{t(locale, "settings.fastApiHint")}</div>
        )}
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{localize(locale, "运行规则", "Runtime Rules")}</div>
            <h2>{localize(locale, "交接 SLA 阈值", "Handoff SLA Thresholds")}</h2>
          </div>
          <div className="pill">
            {runtimeSettingsUpdatedAt
              ? localize(locale, `后端更新于 ${formatTimestamp(runtimeSettingsUpdatedAt, locale)}`, `backend updated at ${formatTimestamp(runtimeSettingsUpdatedAt, locale)}`)
              : localize(locale, "使用默认阈值", "using default thresholds")}
          </div>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>{localize(locale, "Pending SLA 秒数", "Pending SLA Seconds")}</span>
            <input
              type="number"
              min={60}
              max={604800}
              value={runtimeDraft.handoff_pending_timeout_seconds}
              onChange={(event) =>
                setRuntimeDraft((current) => ({
                  ...current,
                  handoff_pending_timeout_seconds: clampRuntimeSeconds(
                    event.target.value,
                    current.handoff_pending_timeout_seconds,
                  ),
                }))
              }
            />
            <small className="field-note">
              {localize(
                locale,
                "超过该时间的 queued/seen/accepted 交接会被计为超时 pending。",
                "queued/seen/accepted handoffs older than this threshold are counted as timed-out pending.",
              )}
            </small>
          </label>
          <label className="field">
            <span>{localize(locale, "Blocked SLA 秒数", "Blocked SLA Seconds")}</span>
            <input
              type="number"
              min={60}
              max={604800}
              value={runtimeDraft.handoff_blocked_timeout_seconds}
              onChange={(event) =>
                setRuntimeDraft((current) => ({
                  ...current,
                  handoff_blocked_timeout_seconds: clampRuntimeSeconds(
                    event.target.value,
                    current.handoff_blocked_timeout_seconds,
                  ),
                }))
              }
            />
            <small className="field-note">
              {localize(
                locale,
                "超过该时间的 blocked 交接会将 agent SLA 升级为 blocked。",
                "blocked handoffs older than this threshold escalate the agent SLA to blocked.",
              )}
            </small>
          </label>
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "settings.gatewayEyebrow")}</div>
            <h2>{t(locale, "settings.gatewayTitle")}</h2>
          </div>
          <div className="pill mono">{normalizeGatewayDisplay(draft.gatewayUrl, locale)}</div>
        </div>
        {gatewayProbe ? (
          <div className="hint-grid">
            <div className="hint-card">
              <strong>{t(locale, "settings.status")}</strong>
              <StatusBadge value={gatewayProbe.status} locale={locale} />
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.resolvedUrl")}</strong>
              <span className="mono">{gatewayProbe.resolvedUrl || "-"}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.checkedAt")}</strong>
              <span>{formatTimestamp(gatewayProbe.checkedAt, locale)}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.message")}</strong>
              <span>{gatewayProbe.message}</span>
            </div>
            <div className="hint-card">
              <strong>{t(locale, "settings.closeInfo")}</strong>
              <span className="mono">
                {gatewayProbe.closeCode !== undefined
                  ? `${String(gatewayProbe.closeCode)} ${gatewayProbe.closeReason || ""}`.trim()
                  : t(locale, "common.notAvailable")}
              </span>
            </div>
          </div>
        ) : (
          <div className="empty-state compact">{t(locale, "settings.gatewayHint")}</div>
        )}
      </section>
    </section>
  );
}

async function probeGateway(rawUrl: string, locale: Locale): Promise<GatewayProbeResult> {
  const checkedAt = new Date().toISOString();
  let resolvedUrl = rawUrl.trim();

  try {
    resolvedUrl = normalizeGatewayUrl(rawUrl, locale);
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      resolvedUrl,
      checkedAt,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let opened = false;
    let socket: WebSocket | null = null;

    const finish = (result: GatewayProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
        socket.close();
      }
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      finish({
        status: "error",
        message: t(locale, "settings.gatewayTimeout", { seconds: GATEWAY_TEST_TIMEOUT_MS / 1000 }),
        resolvedUrl,
        checkedAt,
      });
    }, GATEWAY_TEST_TIMEOUT_MS);

    try {
      socket = new WebSocket(resolvedUrl);
    } catch (error) {
      finish({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        resolvedUrl,
        checkedAt,
      });
      return;
    }

    socket.onopen = () => {
      opened = true;
      finish({
        status: "connected",
        message: t(locale, "settings.gatewayHandshakeSucceeded"),
        resolvedUrl,
        checkedAt,
      });
    };

    socket.onerror = () => {
      if (opened || settled) {
        return;
      }
      // Wait for close or timeout to classify the failure more precisely.
    };

    socket.onclose = (event) => {
      if (settled) {
        return;
      }
      if (!opened && event.code !== 1006) {
        finish({
          status: "reachable",
          message: t(locale, "settings.gatewayReachable"),
          resolvedUrl,
          checkedAt,
          closeCode: event.code,
          closeReason: event.reason || undefined,
        });
        return;
      }
      finish({
        status: "error",
        message:
          event.code === 1006
            ? t(locale, "settings.gatewayHandshakeFailed")
            : t(locale, "settings.gatewayClosedImmediately"),
        resolvedUrl,
        checkedAt,
        closeCode: event.code,
        closeReason: event.reason || undefined,
      });
    };
  });
}

function normalizeGatewayUrl(rawUrl: string, locale: Locale): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error(t(locale, "settings.gatewayRequired"));
  }

  let candidate = trimmed;
  if (candidate.startsWith("http://")) {
    candidate = `ws://${candidate.slice("http://".length)}`;
  } else if (candidate.startsWith("https://")) {
    candidate = `wss://${candidate.slice("https://".length)}`;
  } else if (!/^[a-z]+:\/\//i.test(candidate)) {
    candidate = `ws://${candidate}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(t(locale, "settings.gatewayProtocol"));
  }
  return parsed.toString();
}

function normalizeGatewayDisplay(rawUrl: string, locale: Locale): string {
  try {
    return normalizeGatewayUrl(rawUrl, locale);
  } catch {
    return rawUrl.trim() || t(locale, "settings.gatewayUnset");
  }
}

function clampRuntimeSeconds(rawValue: string, fallback: number): number {
  const parsed = Math.trunc(Number(rawValue));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(60, Math.min(604800, parsed));
}

function localize(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function formatTimestamp(value: string, locale: Locale): string {
  return formatDateTime(locale, value);
}
