import { useEffect, useMemo, useState } from "react";
import {
  checkpointTask,
  cleanupTask,
  deleteAuthProfile,
  fetchAgentRouting,
  fetchAuthProfiles,
  fetchCompletionHooks,
  fetchExecutionContexts,
  fetchModelCatalog,
  fetchProviderObservability,
  fetchRuntimeSettings,
  fetchSchedulerState,
  fetchWorktrees,
  mergeTask,
  setAgentActivation,
  testAuthProfile,
  upsertApiKeyAuthProfile,
  updateAgentRouting,
  updateAuthProfiles,
} from "../api";
import { StatusBadge } from "../components/status-badge";
import { formatDateTime, t, translateSaveState, type Locale } from "../i18n";
import type {
  AgentRoutingRecord,
  AuthProfileRecord,
  AuthProfilesResponse,
  CompletionHookListResponse,
  ExecutionContextListResponse,
  ModelCatalogEntry,
  ModelCatalogResponse,
  ProviderObservabilityResponse,
  RuntimeSettingsResponse,
  SaveState,
  SchedulerStateResponse,
  WorktreeListResponse,
} from "../types";

type ControlPageProps = {
  apiBaseUrl: string;
  projectId: string;
  refreshToken: number;
  locale: Locale;
};

type AuthProfileDraft = {
  profile_id: string;
  provider: string;
  label: string;
  auth_type: string;
  status: string;
  account_label: string;
  credential_ref: string;
  login_hint: string;
};

type ApiKeyDraft = {
  provider: string;
  profile_id: string;
  label: string;
  api_key: string;
  account_label: string;
  login_hint: string;
  set_last_good: boolean;
};

const DEFAULT_PROFILE_DRAFT: AuthProfileDraft = {
  profile_id: "",
  provider: "",
  label: "",
  auth_type: "oauth",
  status: "needs_login",
  account_label: "",
  credential_ref: "",
  login_hint: "",
};

const DEFAULT_API_KEY_DRAFT: ApiKeyDraft = {
  provider: "",
  profile_id: "",
  label: "",
  api_key: "",
  account_label: "",
  login_hint: "",
  set_last_good: true,
};

export function ControlPage({ apiBaseUrl, projectId, refreshToken, locale }: ControlPageProps) {
  const [routes, setRoutes] = useState<AgentRoutingRecord[]>([]);
  const [draftRoutes, setDraftRoutes] = useState<AgentRoutingRecord[]>([]);
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [authProfileResponse, setAuthProfileResponse] = useState<AuthProfilesResponse | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogResponse | null>(null);
  const [schedulerState, setSchedulerState] = useState<SchedulerStateResponse | null>(null);
  const [observability, setObservability] = useState<ProviderObservabilityResponse | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettingsResponse | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeListResponse | null>(null);
  const [executionContexts, setExecutionContexts] = useState<ExecutionContextListResponse | null>(null);
  const [completionHooks, setCompletionHooks] = useState<CompletionHookListResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [profileState, setProfileState] = useState<SaveState>("idle");
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState<ApiKeyDraft>(DEFAULT_API_KEY_DRAFT);
  const [profileDraft, setProfileDraft] = useState<AuthProfileDraft>(DEFAULT_PROFILE_DRAFT);
  const currentProjectId = projectId.trim() || undefined;

  function applyControlPlaneData(payload: {
    routing: Awaited<ReturnType<typeof fetchAgentRouting>>;
    scheduler: SchedulerStateResponse;
    authProfiles: AuthProfilesResponse;
    providerMonitor: ProviderObservabilityResponse;
    runtimeSettingsPayload: RuntimeSettingsResponse;
    worktreesPayload: WorktreeListResponse;
    executionContextsPayload: ExecutionContextListResponse;
    hooksPayload: CompletionHookListResponse;
  }): void {
    setRoutes(payload.routing.routes);
    setDraftRoutes(payload.routing.routes);
    setSchedulerState(payload.scheduler);
    setAuthProfileResponse(payload.authProfiles);
    setProfiles(payload.authProfiles.profiles);
    setObservability(payload.providerMonitor);
    setRuntimeSettings(payload.runtimeSettingsPayload);
    setWorktrees(payload.worktreesPayload);
    setExecutionContexts(payload.executionContextsPayload);
    setCompletionHooks(payload.hooksPayload);
  }

  async function loadControlPlaneData(): Promise<{
    controlPlane: Parameters<typeof applyControlPlaneData>[0];
    catalog: ModelCatalogResponse | null;
    catalogErrorMessage: string | null;
  }> {
    const coreRequest = Promise.all([
      fetchAgentRouting(apiBaseUrl),
      fetchSchedulerState(apiBaseUrl),
      fetchAuthProfiles(apiBaseUrl),
      fetchProviderObservability(apiBaseUrl),
      fetchRuntimeSettings(apiBaseUrl),
      fetchWorktrees({ projectId: currentProjectId, limit: 40 }, apiBaseUrl),
      fetchExecutionContexts({ projectId: currentProjectId, limit: 40 }, apiBaseUrl),
      fetchCompletionHooks({ projectId: currentProjectId, limit: 40 }, apiBaseUrl),
    ]);
    const [coreResult, catalogResult] = await Promise.allSettled([
      coreRequest,
      fetchModelCatalog(apiBaseUrl),
    ]);

    if (coreResult.status === "rejected") {
      throw coreResult.reason;
    }

    const [
      routing,
      scheduler,
      authProfiles,
      providerMonitor,
      runtimeSettingsPayload,
      worktreesPayload,
      executionContextsPayload,
      hooksPayload,
    ] = coreResult.value;

    return {
      controlPlane: {
        routing,
        scheduler,
        authProfiles,
        providerMonitor,
        runtimeSettingsPayload,
        worktreesPayload,
        executionContextsPayload,
        hooksPayload,
      },
      catalog: catalogResult.status === "fulfilled" ? catalogResult.value : null,
      catalogErrorMessage:
        catalogResult.status === "fulfilled"
          ? catalogResult.value.error || null
          : catalogResult.reason instanceof Error
            ? catalogResult.reason.message
            : String(catalogResult.reason),
    };
  }

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const payload = await loadControlPlaneData();
        if (cancelled) {
          return;
        }
        applyControlPlaneData(payload.controlPlane);
        setModelCatalog(payload.catalog);
        setCatalogError(payload.catalogErrorMessage);
        setError(null);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, currentProjectId, refreshToken]);

  const dirtyMap = new Map(
    draftRoutes.map((route) => [
      route.role,
      JSON.stringify(route) !== JSON.stringify(routes.find((candidate) => candidate.role === route.role)),
    ]),
  );

  const profileOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const profile of profiles) {
      options.set(profile.profile_id, `${profile.profile_id} (${profile.provider})`);
    }
    for (const route of draftRoutes) {
      if (route.auth_profile && !options.has(route.auth_profile)) {
        options.set(route.auth_profile, locale === "zh-CN" ? `${route.auth_profile}（未跟踪）` : `${route.auth_profile} (untracked)`);
      }
    }
    return Array.from(options.entries()).map(([value, label]) => ({ value, label }));
  }, [draftRoutes, profiles]);

  const providerOptions = useMemo(() => {
    const values = new Set<string>();
    for (const provider of modelCatalog?.providers || []) {
      if (provider.id) {
        values.add(provider.id);
      }
    }
    for (const profile of profiles) {
      if (profile.provider) {
        values.add(profile.provider);
      }
    }
    for (const route of draftRoutes) {
      if (route.provider) {
        values.add(route.provider);
      }
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [draftRoutes, modelCatalog?.providers, profiles]);

  const catalogModelsByProvider = useMemo(() => {
    const buckets = new Map<string, ModelCatalogEntry[]>();
    for (const model of modelCatalog?.models || []) {
      const existing = buckets.get(model.provider);
      if (existing) {
        existing.push(model);
      } else {
        buckets.set(model.provider, [model]);
      }
    }
    return buckets;
  }, [modelCatalog?.models]);

  const availableCatalogModels = useMemo(
    () => (modelCatalog?.models || []).filter((model) => model.available),
    [modelCatalog?.models],
  );

  const authProfileStats = useMemo(
    () => ({
      total: profiles.length,
      connected: profiles.filter((profile) => profile.status === "connected").length,
      apiKey: profiles.filter((profile) => profile.auth_type === "api_key").length,
      openclaw: profiles.filter((profile) => profile.openclaw_exists).length,
    }),
    [profiles],
  );

  const modelCatalogStats = useMemo(
    () => ({
      providers: modelCatalog?.provider_count ?? providerOptions.length,
      models: modelCatalog?.count ?? 0,
      available: availableCatalogModels.length,
      syncedAt: modelCatalog?.generated_at ?? null,
    }),
    [availableCatalogModels.length, modelCatalog?.count, modelCatalog?.generated_at, modelCatalog?.provider_count, providerOptions.length],
  );

  async function reloadControlPlane(): Promise<void> {
    const payload = await loadControlPlaneData();
    applyControlPlaneData(payload.controlPlane);
    setModelCatalog(payload.catalog);
    setCatalogError(payload.catalogErrorMessage);
  }

  async function saveRoutes(routesToSave: AgentRoutingRecord[]): Promise<void> {
    setSaveState("saving");
    try {
      await updateAgentRouting(
        routesToSave.map((route) => ({
          role: route.role,
          active: route.active,
          provider: route.provider,
          model: route.model,
          auth_profile: route.auth_profile || null,
          max_concurrency: route.max_concurrency,
        })),
        apiBaseUrl,
      );
      await reloadControlPlane();
      setSaveState("saved");
      setError(null);
      window.setTimeout(() => setSaveState("idle"), 1500);
    } catch (nextError) {
      setSaveState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function toggleActivation(role: string, active: boolean, maxConcurrency: number): Promise<void> {
    setSaveState("saving");
    try {
      await setAgentActivation(
        {
          role,
          active,
          max_concurrency: maxConcurrency,
        },
        apiBaseUrl,
      );
      await reloadControlPlane();
      setSaveState("saved");
      setError(null);
      window.setTimeout(() => setSaveState("idle"), 1500);
    } catch (nextError) {
      setSaveState("error");
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function saveProfileDraft(): Promise<void> {
    if (!profileDraft.profile_id.trim() || !profileDraft.provider.trim() || !profileDraft.label.trim()) {
      setProfileState("error");
      setProfileMessage(t(locale, "control.profileRequired"));
      return;
    }
    if (profileDraft.auth_type === "api_key" && !profileDraft.credential_ref.trim()) {
      setProfileState("error");
      setProfileMessage(t(locale, "control.apiKeyNeedsQuickAdd"));
      return;
    }
    setProfileState("saving");
    try {
      await updateAuthProfiles(
        [
          {
            profile_id: profileDraft.profile_id.trim(),
            provider: profileDraft.provider.trim(),
            label: profileDraft.label.trim(),
            auth_type: profileDraft.auth_type,
            status: profileDraft.status,
            account_label: profileDraft.account_label.trim() || null,
            credential_ref: profileDraft.credential_ref.trim() || null,
            login_hint: profileDraft.login_hint.trim() || null,
          },
        ],
        apiBaseUrl,
      );
      await reloadControlPlane();
      setProfileState("saved");
      setProfileMessage(t(locale, "control.profileSaved", { id: profileDraft.profile_id.trim() }));
      setProfileDraft(DEFAULT_PROFILE_DRAFT);
      window.setTimeout(() => setProfileState("idle"), 1500);
    } catch (nextError) {
      setProfileState("error");
      setProfileMessage(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function saveApiKeyDraft(): Promise<void> {
    const provider = apiKeyDraft.provider.trim().toLowerCase();
    if (!provider || !apiKeyDraft.api_key.trim()) {
      setProfileState("error");
      setProfileMessage(t(locale, "control.apiKeyRequired"));
      return;
    }

    const resolvedProfileId = apiKeyDraft.profile_id.trim() || `${provider}:default`;
    const resolvedLabel = apiKeyDraft.label.trim() || `${provider} API`;

    setProfileState("saving");
    try {
      await upsertApiKeyAuthProfile(
        {
          provider,
          api_key: apiKeyDraft.api_key.trim(),
          profile_id: resolvedProfileId,
          label: resolvedLabel,
          account_label: apiKeyDraft.account_label.trim() || null,
          login_hint: apiKeyDraft.login_hint.trim() || null,
          set_last_good: apiKeyDraft.set_last_good,
        },
        apiBaseUrl,
      );
      await reloadControlPlane();
      setProfileState("saved");
      setProfileMessage(t(locale, "control.apiKeySaved", { id: resolvedProfileId }));
      setApiKeyDraft(DEFAULT_API_KEY_DRAFT);
      setProfileDraft({
        profile_id: resolvedProfileId,
        provider,
        label: resolvedLabel,
        auth_type: "api_key",
        status: "connected",
        account_label: apiKeyDraft.account_label.trim(),
        credential_ref: resolvedProfileId,
        login_hint: apiKeyDraft.login_hint.trim(),
      });
      window.setTimeout(() => setProfileState("idle"), 1500);
    } catch (nextError) {
      setProfileState("error");
      setProfileMessage(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function runProfileTest(profileId: string): Promise<void> {
    setProfileState("saving");
    try {
      const result = await testAuthProfile(profileId, apiBaseUrl);
      await reloadControlPlane();
      setProfileState(result.status === "connected" ? "saved" : "error");
      setProfileMessage(result.message);
      window.setTimeout(() => setProfileState("idle"), 1500);
    } catch (nextError) {
      setProfileState("error");
      setProfileMessage(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function removeProfile(profileId: string): Promise<void> {
    setProfileState("saving");
    try {
      await deleteAuthProfile(profileId, apiBaseUrl);
      await reloadControlPlane();
      setProfileState("saved");
      setProfileMessage(t(locale, "control.profileDeleted", { id: profileId }));
      if (profileDraft.profile_id === profileId) {
        setProfileDraft(DEFAULT_PROFILE_DRAFT);
      }
      window.setTimeout(() => setProfileState("idle"), 1500);
    } catch (nextError) {
      setProfileState("error");
      setProfileMessage(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function runExecutionAction(
    action: "checkpoint" | "merge" | "cleanup",
    taskId: string,
  ): Promise<void> {
    setProfileState("saving");
    try {
      if (action === "checkpoint") {
        await checkpointTask(taskId, apiBaseUrl);
      } else if (action === "merge") {
        await mergeTask(taskId, apiBaseUrl);
      } else {
        await cleanupTask(taskId, apiBaseUrl);
      }
      await reloadControlPlane();
      setProfileState("saved");
      setProfileMessage(`${action} ${taskId}`);
      window.setTimeout(() => setProfileState("idle"), 1500);
    } catch (nextError) {
      setProfileState("error");
      setProfileMessage(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  return (
    <div className="page-layout single-column">
      <datalist id="control-provider-options">
        {providerOptions.map((provider) => (
          <option
            key={provider}
            value={provider}
            label={(() => {
              const summary = modelCatalog?.providers.find((item) => item.id === provider);
              if (!summary) {
                return provider;
              }
              return localize(
                locale,
                `${provider} · ${summary.model_count} 个模型 / ${summary.available_count} 个可用`,
                `${provider} · ${summary.model_count} models / ${summary.available_count} available`,
              );
            })()}
          />
        ))}
      </datalist>
      <section className="hero-card">
        <div>
          <div className="eyebrow">{t(locale, "control.heroEyebrow")}</div>
          <h1>{t(locale, "control.title")}</h1>
          <p className="hero-copy">{t(locale, "control.copy")}</p>
        </div>
        <div className="hero-meta">
          <div className={`pill ${saveState === "error" || profileState === "error" ? "danger" : ""}`}>
            {t(locale, "control.routing")} {translateSaveState(locale, saveState)} / {t(locale, "control.credentials")} {translateSaveState(locale, profileState)}
          </div>
          <div className="pill">
            {loading
              ? t(locale, "control.meta.loading")
              : t(locale, "control.meta.rolesProfiles", { roles: draftRoutes.length, profiles: profiles.length })}
          </div>
          {observability ? (
            <div className="pill">{t(locale, "control.meta.cooldown", { count: observability.totals.cooldown_active })}</div>
          ) : null}
          {authProfileResponse?.sync ? (
            <div className={`pill ${authProfileResponse.sync.ok ? "" : "danger"}`}>
              {authProfileResponse.sync.ok ? t(locale, "control.meta.syncOk") : t(locale, "control.meta.syncDegraded")}
            </div>
          ) : null}
          <div className={`pill ${catalogError ? "danger" : ""}`}>
            {localize(
              locale,
              `模型目录 ${modelCatalogStats.providers} 厂商 / ${modelCatalogStats.models} 模型 / ${modelCatalogStats.available} 可用`,
              `Catalog ${modelCatalogStats.providers} providers / ${modelCatalogStats.models} models / ${modelCatalogStats.available} available`,
            )}
          </div>
        </div>
      </section>

      {error ? <div className="inline-alert danger">{error}</div> : null}
      {profileMessage ? (
        <div className={`inline-alert ${profileState === "error" ? "danger" : ""}`}>{profileMessage}</div>
      ) : null}
      {authProfileResponse?.sync?.error ? (
        <div className="inline-alert danger">{t(locale, "control.openclawSync")}: {authProfileResponse.sync.error}</div>
      ) : null}
      {catalogError ? (
        <div className="inline-alert danger">
          {localize(locale, "OpenClaw 模型目录同步异常", "OpenClaw model catalog degraded")}: {catalogError}
        </div>
      ) : null}
      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.routingEyebrow")}</div>
            <h2>{t(locale, "control.routingTitle")}</h2>
          </div>
          <button type="button" className="primary-button" onClick={() => void saveRoutes(draftRoutes)}>
            {t(locale, "control.saveAll")}
          </button>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "control.role")}</th>
              <th>{t(locale, "control.active")}</th>
              <th>{t(locale, "control.provider")}</th>
              <th>{t(locale, "control.model")}</th>
              <th>{t(locale, "control.authProfile")}</th>
              <th>{t(locale, "control.maxConcurrency")}</th>
              <th>{t(locale, "control.state")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draftRoutes.map((route) => {
              const routeModelOptions = route.provider ? (catalogModelsByProvider.get(route.provider) || []) : [];
              const routeProviderSummary = modelCatalog?.providers.find((item) => item.id === route.provider) || null;
              return (
                <tr key={route.role}>
                  <td>{route.role}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={route.active}
                      onChange={(event) =>
                        setDraftRoutes((current) =>
                          current.map((item) =>
                            item.role === route.role ? { ...item, active: event.target.checked } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      list="control-provider-options"
                      value={route.provider}
                      onChange={(event) =>
                        setDraftRoutes((current) =>
                          current.map((item) =>
                            item.role === route.role ? { ...item, provider: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      list={route.provider ? `control-model-options-${route.role}` : undefined}
                      value={route.model}
                      placeholder={
                        route.provider
                          ? localize(locale, "输入模型 ID", "Enter model id")
                          : localize(locale, "先选择 provider 再选模型", "Pick provider first")
                      }
                      onChange={(event) =>
                        setDraftRoutes((current) =>
                          current.map((item) =>
                            item.role === route.role ? { ...item, model: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    {route.provider ? (
                      <datalist id={`control-model-options-${route.role}`}>
                        {routeModelOptions.map((model) => (
                          <option
                            key={`${route.role}:${model.key}`}
                            value={model.model_id}
                            label={localize(
                              locale,
                              `${model.name}${model.available ? " · 可用" : ""}`,
                              `${model.name}${model.available ? " · available" : ""}`,
                            )}
                          />
                        ))}
                      </datalist>
                    ) : null}
                    <div className="field-note">
                      {route.provider
                        ? routeProviderSummary
                          ? localize(
                              locale,
                              `${routeProviderSummary.model_count} 个模型，${routeProviderSummary.available_count} 个当前可用`,
                              `${routeProviderSummary.model_count} models, ${routeProviderSummary.available_count} currently available`,
                            )
                          : localize(
                              locale,
                              "该 provider 暂无目录快照，可继续手动输入",
                              "No catalog snapshot for this provider; manual input still works",
                            )
                        : localize(
                            locale,
                            "支持手动输入自定义 provider/model",
                            "Custom provider/model input is still allowed",
                          )}
                    </div>
                  </td>
                  <td>
                    <select
                      value={route.auth_profile || ""}
                      onChange={(event) =>
                        setDraftRoutes((current) =>
                          current.map((item) =>
                            item.role === route.role ? { ...item, auth_profile: event.target.value || null } : item,
                          ),
                        )
                      }
                    >
                      <option value="">{t(locale, "control.unbound")}</option>
                      {profileOptions.map((option) => (
                        <option key={`${route.role}:${option.value}`} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={route.max_concurrency}
                      onChange={(event) =>
                        setDraftRoutes((current) =>
                          current.map((item) =>
                            item.role === route.role
                              ? {
                                  ...item,
                                  max_concurrency: Math.max(1, Math.trunc(Number(event.target.value) || 1)),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    {dirtyMap.get(route.role) ? (
                      <span className="text-chip">{t(locale, "control.dirty")}</span>
                    ) : (
                      <span className="text-chip">{t(locale, "control.synced")}</span>
                    )}
                  </td>
                  <td>
                    <button type="button" className="ghost-button" onClick={() => void saveRoutes([route])}>
                      {t(locale, "control.save")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="page-card control-auth-shell">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.credentialsEyebrow")}</div>
            <h2>{t(locale, "control.credentialsTitle")}</h2>
          </div>
        </div>
        <div className="control-auth-layout">
          <div className="control-auth-stack">
            <article className="control-auth-panel control-auth-panel--primary">
              <div className="control-auth-panel__header">
                <div>
                  <h3>{t(locale, "control.apiKeyQuickTitle")}</h3>
                  <p className="control-auth-panel__copy">{t(locale, "control.apiKeyQuickCopy")}</p>
                </div>
              </div>
              <div className="control-auth-form-grid">
                <label className="field">
                  <span>{t(locale, "control.provider")}</span>
                  <input
                    list="control-provider-options"
                    value={apiKeyDraft.provider}
                    placeholder="openai"
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, provider: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{t(locale, "control.profileId")}</span>
                  <input
                    value={apiKeyDraft.profile_id}
                    placeholder="openai:default"
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, profile_id: event.target.value }))}
                  />
                  <small className="field-note">
                    {t(locale, "control.profileIdAutoHint", {
                      value: apiKeyDraft.provider.trim().toLowerCase()
                        ? `${apiKeyDraft.provider.trim().toLowerCase()}:default`
                        : "provider:default",
                    })}
                  </small>
                </label>
                <label className="field">
                  <span>{t(locale, "control.label")}</span>
                  <input
                    value={apiKeyDraft.label}
                    placeholder="OpenAI API"
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, label: event.target.value }))}
                  />
                  <small className="field-note">
                    {t(locale, "control.labelAutoHint", {
                      value: apiKeyDraft.provider.trim().toLowerCase() || "provider",
                    })}
                  </small>
                </label>
                <label className="field">
                  <span>{t(locale, "control.accountLabel")}</span>
                  <input
                    value={apiKeyDraft.account_label}
                    placeholder={t(locale, "control.placeholder.teamWorkspace")}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, account_label: event.target.value }))}
                  />
                </label>
                <label className="field field--full">
                  <span>{t(locale, "control.apiKey")}</span>
                  <input
                    type="password"
                    value={apiKeyDraft.api_key}
                    placeholder={t(locale, "control.apiKeyPlaceholder")}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, api_key: event.target.value }))}
                  />
                </label>
                <label className="field field--full">
                  <span>{t(locale, "control.loginHint")}</span>
                  <input
                    value={apiKeyDraft.login_hint}
                    placeholder={t(locale, "control.placeholder.optionalNote")}
                    onChange={(event) => setApiKeyDraft((current) => ({ ...current, login_hint: event.target.value }))}
                  />
                </label>
              </div>
              <div className="control-auth-options">
                <label className="control-auth-option">
                  <input
                    type="checkbox"
                    checked={apiKeyDraft.set_last_good}
                    onChange={(event) =>
                      setApiKeyDraft((current) => ({ ...current, set_last_good: event.target.checked }))
                    }
                  />
                  <span>
                    <strong>{t(locale, "control.makeDefault")}</strong>
                    <small>{t(locale, "control.makeDefaultCopy")}</small>
                  </span>
                </label>
              </div>
              <div className="control-auth-actions">
                <div className="button-row">
                  <button type="button" className="primary-button" onClick={() => void saveApiKeyDraft()}>
                    {t(locale, "control.saveApiKey")}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setApiKeyDraft(DEFAULT_API_KEY_DRAFT)}>
                    {t(locale, "settings.reset")}
                  </button>
                </div>
                <div className="control-auth-note">{t(locale, "control.realCredentialSource")}</div>
              </div>
            </article>

            <article className="control-auth-panel">
              <div className="control-auth-panel__header">
                <div>
                  <h3>{t(locale, "control.advancedEditorTitle")}</h3>
                  <p className="control-auth-panel__copy">{t(locale, "control.advancedEditorCopy")}</p>
                </div>
                <button type="button" className="ghost-button" onClick={() => setProfileDraft(DEFAULT_PROFILE_DRAFT)}>
                  {t(locale, "control.newDraft")}
                </button>
              </div>
              <div className="control-auth-form-grid control-auth-form-grid--advanced">
                <label className="field">
                  <span>{t(locale, "control.profileId")}</span>
                  <input
                    value={profileDraft.profile_id}
                    placeholder="openai:researcher"
                    onChange={(event) => setProfileDraft((current) => ({ ...current, profile_id: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{t(locale, "control.provider")}</span>
                  <input
                    list="control-provider-options"
                    value={profileDraft.provider}
                    placeholder="openai"
                    onChange={(event) => setProfileDraft((current) => ({ ...current, provider: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{t(locale, "control.label")}</span>
                  <input
                    value={profileDraft.label}
                    placeholder={t(locale, "control.placeholder.researchAccount")}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, label: event.target.value }))}
                  />
                </label>
                <label className="field">
                  <span>{t(locale, "control.authType")}</span>
                  <select
                    value={profileDraft.auth_type}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, auth_type: event.target.value }))}
                  >
                    <option value="oauth">oauth</option>
                    <option value="api_key">api_key</option>
                    <option value="token">token</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t(locale, "control.status")}</span>
                  <select
                    value={profileDraft.status}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, status: event.target.value }))}
                  >
                    <option value="needs_login">{t(locale, "status.needs_login")}</option>
                    <option value="connected">{t(locale, "status.connected")}</option>
                    <option value="degraded">{t(locale, "status.degraded")}</option>
                    <option value="error">{t(locale, "status.error")}</option>
                    <option value="disabled">{t(locale, "status.disabled")}</option>
                  </select>
                </label>
                <label className="field">
                  <span>{t(locale, "control.accountLabel")}</span>
                  <input
                    value={profileDraft.account_label}
                    placeholder={t(locale, "control.placeholder.teamWorkspace")}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, account_label: event.target.value }))}
                  />
                </label>
                <label className="field field--full">
                  <span>{t(locale, "control.credentialRef")}</span>
                  <input
                    value={profileDraft.credential_ref}
                    placeholder={t(locale, "control.placeholder.credentialRef")}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, credential_ref: event.target.value }))}
                  />
                </label>
                <label className="field field--full">
                  <span>{t(locale, "control.loginHint")}</span>
                  <input
                    value={profileDraft.login_hint}
                    placeholder={t(locale, "control.placeholder.oauthHint")}
                    onChange={(event) => setProfileDraft((current) => ({ ...current, login_hint: event.target.value }))}
                  />
                </label>
              </div>
              <div className="control-auth-actions">
                <div className="button-row">
                  <button type="button" className="primary-button" onClick={() => void saveProfileDraft()}>
                    {t(locale, "control.saveProfile")}
                  </button>
                </div>
              </div>
            </article>
          </div>

          <aside className="control-auth-sidebar">
            <article className="control-auth-panel control-auth-panel--sidebar">
              <div className="control-auth-panel__header">
                <div>
                  <h3>{t(locale, "control.syncSummaryTitle")}</h3>
                  <p className="control-auth-panel__copy">{t(locale, "control.syncSummaryCopy")}</p>
                </div>
              </div>
              <div className="control-auth-kv-list">
                <div className="control-auth-kv">
                  <span>{t(locale, "control.authStore")}</span>
                  <strong className="mono">{authProfileResponse?.sync?.auth_store_path || t(locale, "common.notAvailable")}</strong>
                </div>
                <div className="control-auth-kv">
                  <span>{t(locale, "control.syncedAt")}</span>
                  <strong>{formatTimestamp(authProfileResponse?.sync?.generated_at, locale)}</strong>
                </div>
                <div className="control-auth-kv">
                  <span>{t(locale, "control.usageAt")}</span>
                  <strong>{formatTimestamp(authProfileResponse?.sync?.usage_updated_at, locale)}</strong>
                </div>
              </div>
              {authProfileResponse?.sync?.usage_error ? (
                <div className="inline-alert danger">{t(locale, "control.usageError")}: {authProfileResponse.sync.usage_error}</div>
              ) : null}
            </article>

            <article className="control-auth-panel control-auth-panel--sidebar">
              <div className="control-auth-panel__header">
                <div>
                  <h3>{t(locale, "control.inventoryTitle")}</h3>
                  <p className="control-auth-panel__copy">{t(locale, "control.inventoryCopy")}</p>
                </div>
              </div>
              <div className="control-auth-stat-grid">
                <div className="control-auth-stat">
                  <span>{t(locale, "control.totalProfiles")}</span>
                  <strong>{authProfileStats.total}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{t(locale, "control.connectedProfiles")}</span>
                  <strong>{authProfileStats.connected}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{t(locale, "control.apiKeyProfiles")}</span>
                  <strong>{authProfileStats.apiKey}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{t(locale, "control.openclawProfiles")}</span>
                  <strong>{authProfileStats.openclaw}</strong>
                </div>
              </div>
            </article>

            <article className="control-auth-panel control-auth-panel--sidebar">
              <div className="control-auth-panel__header">
                <div>
                  <h3>{localize(locale, "模型目录", "Model Catalog")}</h3>
                  <p className="control-auth-panel__copy">
                    {localize(locale, "直接读取 OpenClaw 实际可发现的 provider 与模型，不再依赖前端写死列表。", "Reads the live OpenClaw provider/model catalog instead of a hardcoded frontend list.")}
                  </p>
                </div>
              </div>
              <div className="control-auth-stat-grid">
                <div className="control-auth-stat">
                  <span>{localize(locale, "厂商", "Providers")}</span>
                  <strong>{modelCatalogStats.providers}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{localize(locale, "模型", "Models")}</span>
                  <strong>{modelCatalogStats.models}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{localize(locale, "当前可用", "Available now")}</span>
                  <strong>{modelCatalogStats.available}</strong>
                </div>
                <div className="control-auth-stat">
                  <span>{localize(locale, "同步时间", "Synced at")}</span>
                  <strong>{formatTimestamp(modelCatalogStats.syncedAt, locale)}</strong>
                </div>
              </div>
              <div className="control-auth-note">
                {localize(locale, "路由表中的 provider 和 model 输入支持继续手填，自定义值不会被目录限制。", "Provider and model fields still allow manual input; custom values are not blocked by the catalog.")}
              </div>
            </article>
          </aside>
        </div>

        <div className="page-card__header control-auth-list-header">
          <div>
            <div className="eyebrow">{t(locale, "control.inventoryTitle")}</div>
            <h2>{t(locale, "control.profileListTitle")}</h2>
          </div>
          <div className="pill">
            {t(locale, "control.meta.rolesProfiles", {
              roles: draftRoutes.length,
              profiles: authProfileStats.total,
            })}
          </div>
        </div>

        <div className="activation-grid control-profile-grid">
          {profiles.length ? (
            profiles.map((profile) => (
              <div className="activation-card" key={profile.profile_id}>
                <div className="activation-card__header">
                  <strong>{profile.label}</strong>
                  <div className="button-row">
                    <StatusBadge value={profile.status} locale={locale} />
                    {profile.openclaw_exists ? <StatusBadge value={profile.openclaw_status || "unknown"} locale={locale} /> : null}
                  </div>
                </div>
                <div className="activation-meta">
                  <span className="mono">{profile.profile_id}</span>
                  <span>{t(locale, "control.providerValue", { value: profile.provider })}</span>
                  <span>{t(locale, "control.type")}: {profile.auth_type}</span>
                  <span>{t(locale, "control.source")}: {profile.source || t(locale, "common.local")}</span>
                  <span>{t(locale, "control.account")}: {profile.account_label || profile.openclaw_account_label || t(locale, "common.unknown")}</span>
                  <span>{t(locale, "control.credentialRef")}: {profile.credential_ref || t(locale, "common.unset")}</span>
                  <span>{t(locale, "control.lastTested")}: {formatTimestamp(profile.last_tested_at, locale)}</span>
                  <span>{t(locale, "control.lastUsed")}: {formatTimestamp(profile.last_used_at, locale)}</span>
                  <span>
                    {t(locale, "control.cooldown")}:{" "}
                    {profile.cooldown_active
                      ? t(locale, "control.cooldownRemaining", { seconds: profile.cooldown_seconds_remaining || 0 })
                      : profile.cooldown_until
                        ? formatTimestamp(profile.cooldown_until, locale)
                        : t(locale, "control.none")}
                  </span>
                  <span>
                    {t(locale, "control.disable")}:{" "}
                    {profile.disabled_active
                      ? t(locale, "control.cooldownRemaining", { seconds: profile.disabled_seconds_remaining || 0 })
                      : profile.disabled_until
                        ? formatTimestamp(profile.disabled_until, locale)
                        : t(locale, "common.no")}
                  </span>
                  {profile.disabled_reason ? <span>{t(locale, "control.disabledReason")}: {profile.disabled_reason}</span> : null}
                  {profile.error_count ? <span>{t(locale, "control.errorCount")}: {profile.error_count}</span> : null}
                  {profile.last_good_for_provider ? <span>{t(locale, "control.lastGoodProfile")}</span> : null}
                </div>
                {profile.quota_provider || profile.quota_error || profile.quota_windows?.length ? (
                  <div className="inline-alert">
                    {t(locale, "control.quota")}: {profile.quota_display_name || profile.quota_provider || profile.provider}
                    {profile.quota_plan ? ` / ${t(locale, "control.plan")} ${profile.quota_plan}` : ""}
                    {profile.quota_windows?.length ? ` / ${formatQuotaWindows(profile.quota_windows, locale)}` : ""}
                    {profile.quota_error ? ` / ${t(locale, "status.error")} ${profile.quota_error}` : ""}
                    {profile.quota_updated_at ? ` / ${t(locale, "control.updated")} ${formatTimestamp(profile.quota_updated_at, locale)}` : ""}
                  </div>
                ) : null}
                <div className="button-row">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setProfileDraft({
                        profile_id: profile.profile_id,
                        provider: profile.provider,
                        label: profile.label,
                        auth_type: profile.auth_type,
                        status: profile.status,
                        account_label: profile.account_label || "",
                        credential_ref: profile.credential_ref || "",
                        login_hint: profile.login_hint || "",
                      })
                    }
                  >
                    {t(locale, "control.edit")}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => void runProfileTest(profile.profile_id)}>
                    {t(locale, "control.test")}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={profile.source === "openclaw"}
                    onClick={() => void removeProfile(profile.profile_id)}
                  >
                    {t(locale, "control.delete")}
                  </button>
                </div>
                {profile.last_error ? <div className="inline-alert danger">{profile.last_error}</div> : null}
              </div>
            ))
          ) : (
            <div className="empty-state">{t(locale, "control.noProfiles")}</div>
          )}
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.quickOpsEyebrow")}</div>
            <h2>{t(locale, "control.quickOpsTitle")}</h2>
          </div>
        </div>
        <div className="activation-grid">
          {draftRoutes.map((route) => (
            <div className="activation-card" key={`activation:${route.role}`}>
              <div className="activation-card__header">
                <strong>{route.role}</strong>
                <StatusBadge value={route.active ? "active" : "disabled"} locale={locale} />
              </div>
              <div className="activation-meta">
                <span>{t(locale, "control.providerValue", { value: route.provider || t(locale, "control.none") })}</span>
                <span>{t(locale, "control.modelValue", { value: route.model || t(locale, "control.none") })}</span>
                <span>{t(locale, "control.authProfileValue", { value: route.auth_profile || t(locale, "control.unbound") })}</span>
              </div>
              <div className="activation-controls">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void toggleActivation(route.role, !route.active, route.max_concurrency)}
                >
                  {route.active ? t(locale, "control.disable") : t(locale, "control.enable")}
                </button>
                <div className="stepper">
                  <button
                    type="button"
                    className="stepper-button"
                    onClick={() => void toggleActivation(route.role, route.active, Math.max(1, route.max_concurrency - 1))}
                  >
                    -
                  </button>
                  <span>{route.max_concurrency}</span>
                  <button
                    type="button"
                    className="stepper-button"
                    onClick={() => void toggleActivation(route.role, route.active, route.max_concurrency + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.observabilityEyebrow")}</div>
            <h2>{t(locale, "control.observabilityTitle")}</h2>
          </div>
        </div>
        <div className="hint-grid">
          <div className="hint-card">
            <strong>{t(locale, "control.requests")}</strong>
            <span>{observability?.totals.requests_total ?? 0}</span>
          </div>
          <div className="hint-card">
            <strong>{t(locale, "control.success")}</strong>
            <span>{observability?.totals.success_total ?? 0}</span>
          </div>
          <div className="hint-card">
            <strong>{t(locale, "control.failures")}</strong>
            <span>{observability?.totals.failure_total ?? 0}</span>
          </div>
          <div className="hint-card">
            <strong>{t(locale, "control.rateLimitHits")}</strong>
            <span>{observability?.totals.rate_limit_total ?? 0}</span>
          </div>
          <div className="hint-card">
            <strong>{t(locale, "control.failoverSignals")}</strong>
            <span>{observability?.totals.failover_total ?? 0}</span>
          </div>
          <div className="hint-card">
            <strong>{t(locale, "control.meta.cooldown", { count: observability?.totals.cooldown_active ?? 0 }).replace(/^.*? /, "")}</strong>
            <span>{observability?.totals.cooldown_active ?? 0}</span>
          </div>
        </div>
        {observability?.sync ? (
          <div className={`inline-alert ${observability.sync.ok ? "" : "danger"}`}>
            {t(locale, "control.providerSync")}: {formatTimestamp(observability.sync.generated_at, locale)}
            {" / "}
            {t(locale, "control.usageAt")}: {formatTimestamp(observability.sync.usage_updated_at, locale)}
            {observability.sync.usage_error ? ` / ${observability.sync.usage_error}` : ""}
          </div>
        ) : null}
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "control.role")}</th>
              <th>{t(locale, "control.providerColumn")}</th>
              <th>{t(locale, "control.statusColumn")}</th>
              <th>{t(locale, "control.authRuntimeColumn")}</th>
              <th>{t(locale, "control.requestsColumn")}</th>
              <th>{t(locale, "control.cooldownColumn")}</th>
              <th>{t(locale, "control.quotaColumn")}</th>
              <th>{t(locale, "control.lastSuccessColumn")}</th>
              <th>{t(locale, "control.lastFailureColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {observability?.roles.length ? (
              observability.roles.map((role) => (
                <tr key={`provider:${role.role}`}>
                  <td>{role.role}</td>
                  <td>
                    <div>{role.provider || t(locale, "common.unconfigured")}</div>
                    <div className="mono">{role.model || "-"}</div>
                  </td>
                  <td>
                    <StatusBadge value={role.status} locale={locale} />
                    {role.last_error_reason ? <div className="mono">{role.last_error_reason}</div> : null}
                    {role.disabled_reason ? <div className="mono">{role.disabled_reason}</div> : null}
                  </td>
                  <td>
                    <div>{role.auth_profile_label || role.auth_profile || t(locale, "control.unbound")}</div>
                    {role.auth_profile_status ? <StatusBadge value={role.auth_profile_status} locale={locale} /> : null}
                    {role.auth_profile_openclaw_status ? (
                      <div>
                        <StatusBadge value={role.auth_profile_openclaw_status} locale={locale} />
                      </div>
                    ) : null}
                    {role.auth_profile_source ? <div className="mono">{role.auth_profile_source}</div> : null}
                  </td>
                  <td className="mono">
                    {t(locale, "control.requestSummary", { total: role.requests_total, success: role.success_total, failure: role.failure_total })}
                  </td>
                  <td className="mono">
                    {role.cooldown_active
                      ? t(locale, "control.cooldownRemaining", { seconds: role.cooldown_seconds_remaining })
                      : role.cooldown_until
                        ? t(locale, "control.cooldownUntil", { time: formatTimestamp(role.cooldown_until, locale) })
                        : t(locale, "control.none")}
                  </td>
                  <td className="mono">
                    {role.quota_windows?.length ? formatQuotaWindows(role.quota_windows, locale) : t(locale, "control.noQuotaSnapshot")}
                    {role.quota_plan ? <div>{t(locale, "control.plan")} {role.quota_plan}</div> : null}
                    {role.quota_error ? <div>{role.quota_error}</div> : null}
                    <div>{t(locale, "control.failoverSummary", { failover: role.failover_total, rateLimit: role.rate_limit_total, consecutive: role.consecutive_failures })}</div>
                  </td>
                  <td>{formatTimestamp(role.last_success_at, locale)}</td>
                  <td>
                    <div>{formatTimestamp(role.last_failure_at, locale)}</div>
                    {role.last_error ? <div className="mono">{role.last_error}</div> : null}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {t(locale, "control.providerUnavailable")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{localize(locale, "运行时策略", "Runtime Policy")}</div>
            <h2>{localize(locale, "交接 SLA", "Handoff SLA")}</h2>
          </div>
          <div className="pill">{localize(locale, "在设置页修改阈值", "Edit thresholds in Settings")}</div>
        </div>
        <div className="hint-grid compact-hint-grid">
          <div className="hint-card">
            <strong>{formatAge(locale, runtimeSettings?.settings.handoff_pending_timeout_seconds)}</strong>
            <span>{localize(locale, "Pending SLA", "Pending SLA")}</span>
            <span>{localize(locale, "超过该阈值后计入 timed-out pending", "Counts as timed-out pending after this threshold")}</span>
          </div>
          <div className="hint-card">
            <strong>{formatAge(locale, runtimeSettings?.settings.handoff_blocked_timeout_seconds)}</strong>
            <span>{localize(locale, "Blocked SLA", "Blocked SLA")}</span>
            <span>{localize(locale, "用于阻塞交接的告警与积压判断", "Used for blocked handoff alerting and backlog classification")}</span>
          </div>
          <div className="hint-card">
            <strong>{formatTimestamp(runtimeSettings?.updated_at, locale)}</strong>
            <span>{localize(locale, "最近生效时间", "Last applied")}</span>
            <span>{localize(locale, "首页与 Trace 使用同一组运行时阈值", "Dashboard and Trace use the same runtime thresholds")}</span>
          </div>
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.schedulerEyebrow")}</div>
            <h2>{t(locale, "control.schedulerTitle")}</h2>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "control.role")}</th>
              <th>{t(locale, "control.queue")}</th>
              <th>{t(locale, "control.agentState")}</th>
              <th>{t(locale, "control.currentTask")}</th>
              <th>{t(locale, "control.lastError")}</th>
            </tr>
          </thead>
          <tbody>
            {schedulerState?.roles.length ? (
              schedulerState.roles.map((role) => (
                <tr key={`scheduler:${role.role}`}>
                  <td>{role.role}</td>
                  <td className="mono">{formatQueue(role.queue, locale)}</td>
                  <td>
                    <StatusBadge value={role.agent_state?.state || (role.active ? "idle" : "disabled")} locale={locale} />
                  </td>
                  <td className="mono">{role.agent_state?.current_task_id || t(locale, "control.none")}</td>
                  <td className="mono">{role.agent_state?.last_error || "-"}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="empty-cell">
                  {t(locale, "control.schedulerUnavailable")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.actionsEyebrow")}</div>
            <h2>{t(locale, "control.actionsTitle")}</h2>
          </div>
        </div>
        <div className="hint-grid">
          <div className="hint-card">
            <strong>{currentProjectId || t(locale, "control.none")}</strong>
            <span>{currentProjectId ? t(locale, "topbar.project") : t(locale, "control.noSelectedProject")}</span>
          </div>
          <div className="hint-card">
            <strong>{executionContexts?.execution_contexts.length ?? 0}</strong>
            <span>{t(locale, "control.executionTitle")}</span>
          </div>
          <div className="hint-card">
            <strong>{completionHooks?.hooks.length ?? 0}</strong>
            <span>{t(locale, "trace.completionHooks")}</span>
          </div>
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.worktreesEyebrow")}</div>
            <h2>{t(locale, "control.worktreesTitle")}</h2>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "control.worktreeId")}</th>
              <th>{t(locale, "control.role")}</th>
              <th>{t(locale, "control.currentTask")}</th>
              <th>{t(locale, "control.isolationMode")}</th>
              <th>{t(locale, "control.branch")}</th>
              <th>{t(locale, "control.worktreePath")}</th>
              <th>{t(locale, "control.state")}</th>
            </tr>
          </thead>
          <tbody>
            {worktrees?.worktrees.length ? (
              worktrees.worktrees.map((worktree) => (
                <tr key={worktree.worktree_id}>
                  <td className="mono">{worktree.worktree_id}</td>
                  <td>{worktree.owner_agent}</td>
                  <td className="mono">{worktree.task_id || t(locale, "control.none")}</td>
                  <td>{worktree.isolation_mode}</td>
                  <td className="mono">{worktree.branch_name || t(locale, "control.none")}</td>
                  <td className="mono">{formatCompactPath(worktree.worktree_path)}</td>
                  <td><StatusBadge value={worktree.status} locale={locale} /></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {t(locale, "control.noWorktrees")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "control.executionEyebrow")}</div>
            <h2>{t(locale, "control.executionTitle")}</h2>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "control.currentTask")}</th>
              <th>{t(locale, "control.role")}</th>
              <th>{t(locale, "control.runtimeKind")}</th>
              <th>{t(locale, "control.executionPath")}</th>
              <th>{t(locale, "control.canonicalWorkspace")}</th>
              <th>{t(locale, "control.preparedAt")}</th>
              <th>{t(locale, "control.state")}</th>
              <th>{t(locale, "control.actionsTitle")}</th>
            </tr>
          </thead>
          <tbody>
            {executionContexts?.execution_contexts.length ? (
              executionContexts.execution_contexts.map((context) => (
                <tr key={`${context.task_id}:${context.updated_at}`}>
                  <td className="mono">{context.task_id}</td>
                  <td>{context.owner_agent}</td>
                  <td>{context.runtime_kind}</td>
                  <td className="mono">{formatCompactPath(context.execution_workspace_path)}</td>
                  <td className="mono">{formatCompactPath(context.canonical_workspace_path)}</td>
                  <td>{formatTimestamp(context.prepared_at, locale)}</td>
                  <td><StatusBadge value={context.status} locale={locale} /></td>
                  <td>
                    <div className="button-row">
                      <button type="button" className="ghost-button" onClick={() => void runExecutionAction("checkpoint", context.task_id)}>
                        {t(locale, "control.actionCheckpoint")}
                      </button>
                      <button type="button" className="ghost-button" onClick={() => void runExecutionAction("merge", context.task_id)}>
                        {t(locale, "control.actionMerge")}
                      </button>
                      <button type="button" className="ghost-button" onClick={() => void runExecutionAction("cleanup", context.task_id)}>
                        {t(locale, "control.actionCleanup")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty-cell">
                  {t(locale, "control.noExecutionContexts")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "trace.hooksEyebrow")}</div>
            <h2>{t(locale, "trace.hooksTitle")}</h2>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t(locale, "trace.hookType")}</th>
              <th>{t(locale, "control.currentTask")}</th>
              <th>{t(locale, "trace.completedAt")}</th>
              <th>{t(locale, "control.state")}</th>
            </tr>
          </thead>
          <tbody>
            {completionHooks?.hooks.length ? (
              completionHooks.hooks.map((hook) => (
                <tr key={hook.hook_id}>
                  <td>{hook.hook_type}</td>
                  <td className="mono">{hook.task_id}</td>
                  <td>{formatTimestamp(hook.completed_at || hook.updated_at, locale)}</td>
                  <td><StatusBadge value={hook.status} locale={locale} /></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="empty-cell">
                  {t(locale, "trace.noHooks")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function formatQueue(queue: Record<string, number>, locale: Locale): string {
  const entries = Object.entries(queue);
  if (!entries.length) {
    return t(locale, "control.empty");
  }
  return entries.map(([status, count]) => `${status}:${String(count)}`).join(" ");
}

function formatQuotaWindows(
  windows: Array<{
    label: string;
    used_percent: number;
    reset_at: string | null;
  }>,
  locale: Locale,
): string {
  if (!windows.length) {
    return t(locale, "control.noQuotaSnapshot");
  }
  return windows
    .map((window) => {
      const used = `${Math.round(window.used_percent)}%`;
      const reset = window.reset_at ? ` -> ${formatTimestamp(window.reset_at, locale)}` : "";
      return `${window.label} ${used}${reset}`;
    })
    .join(" / ");
}

function formatCompactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-4).join("/") || normalized;
}

function localize(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function formatAge(locale: Locale, seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) {
    return localize(locale, "暂无", "n/a");
  }
  if (seconds < 60) {
    return localize(locale, `${seconds} 秒`, `${seconds}s`);
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return localize(locale, `${minutes} 分钟`, `${minutes}m`);
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return localize(
      locale,
      remainderMinutes ? `${hours} 小时 ${remainderMinutes} 分钟` : `${hours} 小时`,
      remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`,
    );
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return localize(
    locale,
    remainderHours ? `${days} 天 ${remainderHours} 小时` : `${days} 天`,
    remainderHours ? `${days}d ${remainderHours}h` : `${days}d`,
  );
}

function formatTimestamp(value: string | null | undefined, locale: Locale): string {
  return formatDateTime(locale, value);
}
