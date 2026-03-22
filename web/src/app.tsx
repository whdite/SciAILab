import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  BookOpen,
  Boxes,
  Cpu,
  Download,
  FolderKanban,
  Instagram,
  Linkedin,
  Menu,
  Radar,
  Sparkles,
  Twitter,
  Wand2,
  Workflow,
} from "lucide-react";
import {
  ackMessage,
  attachTask,
  checkpointTask,
  cleanupTask,
  fetchExecutionContexts,
  fetchHealth,
  fetchProjects,
  fetchReadModel,
  fetchSchedulerState,
  fetchWorktrees,
  markMessageRead,
  mergeTask,
  setMessageHandoffState,
} from "./api";
import { StatusBadge } from "./components/status-badge";
import { formatDateTime, t } from "./i18n";
import { ControlPage } from "./pages/control-page";
import { AgentsPage } from "./pages/agents-page";
import { ProjectsPage } from "./pages/projects-page";
import { SettingsPage } from "./pages/settings-page";
import { TracePage } from "./pages/trace-page";
import { loadSettings, saveSettings } from "./storage";
import type {
  AgentSlaRecord,
  AppTab,
  ControlActionResult,
  ExecutionContextListResponse,
  HandoffMetrics,
  HealthResponse,
  MessageRecord,
  ProjectListResponse,
  ReadModelResponse,
  SchedulerStateResponse,
  UiSettings,
  WorktreeListResponse,
} from "./types";

type AppRoute = "home" | AppTab;
type HomeDashboardTab = "runtime" | "queue" | "logs";

const HERO_VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260315_073750_51473149-4350-4920-ae24-c8214286f323.mp4";

function localize(locale: UiSettings["locale"], zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function handoffStateLabel(locale: UiSettings["locale"], value: string): string {
  if (value === "queued") {
    return localize(locale, "排队", "Queued");
  }
  if (value === "seen") {
    return localize(locale, "已读", "Seen");
  }
  if (value === "accepted") {
    return localize(locale, "接手", "Accepted");
  }
  if (value === "blocked") {
    return localize(locale, "阻塞", "Blocked");
  }
  if (value === "completed") {
    return localize(locale, "完成", "Completed");
  }
  return value;
}

function formatAge(locale: UiSettings["locale"], seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) {
    return localize(locale, "鏆傛棤", "n/a");
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

function buildOperatorBacklogCards(
  locale: UiSettings["locale"],
  metrics: HandoffMetrics | null,
): Array<{ label: string; value: string; detail: string }> {
  return [
    {
      label: localize(locale, "阻塞交接", "Blocked handoffs"),
      value: String(metrics?.blocked_count ?? 0),
      detail: localize(
        locale,
        `SLA ${formatAge(locale, metrics?.blocked_timeout_seconds ?? null)}`,
        `SLA ${formatAge(locale, metrics?.blocked_timeout_seconds ?? null)}`,
      ),
    },
    {
      label: localize(locale, "超时 Pending", "Timed-out pending"),
      value: String(metrics?.aged_pending_count ?? 0),
      detail: localize(
        locale,
        `阈值 ${formatAge(locale, metrics?.pending_timeout_seconds ?? null)}`,
        `Threshold ${formatAge(locale, metrics?.pending_timeout_seconds ?? null)}`,
      ),
    },
    {
      label: localize(locale, "未确认", "Unacked"),
      value: String(metrics?.unacked_count ?? 0),
      detail: localize(
        locale,
        `Open ${String(metrics?.open_count ?? 0)}`,
        `Open ${String(metrics?.open_count ?? 0)}`,
      ),
    },
    {
      label: localize(locale, "值班 Agent", "Busy agents"),
      value: String(metrics?.busy_agent_count ?? 0),
      detail: localize(
        locale,
        `Pending ${String(metrics?.pending_count ?? 0)}`,
        `Pending ${String(metrics?.pending_count ?? 0)}`,
      ),
    },
  ];
}

function formatAgentSlaSummary(locale: UiSettings["locale"], agent: AgentSlaRecord): string {
  return localize(
    locale,
    `Open ${agent.open_count} / 阻塞 ${agent.blocked_count} / 超时 ${agent.aged_pending_count}`,
    `Open ${agent.open_count} / blocked ${agent.blocked_count} / timed-out ${agent.aged_pending_count}`,
  );
}

function formatAgentSlaAges(locale: UiSettings["locale"], agent: AgentSlaRecord): string {
  return localize(
    locale,
    `最久 Pending ${formatAge(locale, agent.oldest_pending_age_seconds)} / 平均 ${formatAge(locale, agent.avg_pending_age_seconds)}`,
    `Oldest pending ${formatAge(locale, agent.oldest_pending_age_seconds)} / avg ${formatAge(locale, agent.avg_pending_age_seconds)}`,
  );
}

function describeDashboardActionCopy(
  locale: UiSettings["locale"],
  action: "attach" | "checkpoint" | "merge" | "cleanup",
  taskId: string,
  result: ControlActionResult,
): string {
  if (action === "attach") {
    const owner = result.task?.owner_agent || result.execution_context?.owner_agent || "runtime";
    const inboxCount = result.inbox?.length ?? 0;
    return localize(
      locale,
      `已附着 ${owner} / ${taskId}，当前待处理交接 ${String(inboxCount)} 条。`,
      `Attached ${owner} / ${taskId} with ${String(inboxCount)} pending handoffs.`,
    );
  }
  if (action === "checkpoint") {
    return localize(locale, `已为 ${taskId} 生成 checkpoint。`, `Checkpoint created for ${taskId}.`);
  }
  if (action === "merge") {
    const copied = result.copied_files?.length ?? 0;
    return localize(
      locale,
      `已归档 ${taskId} 的执行结果，复制文件 ${String(copied)} 个。`,
      `Merged execution result for ${taskId}; copied ${String(copied)} files.`,
    );
  }
  return localize(locale, `已清理 ${taskId} 的执行工作区。`, `Cleaned execution workspace for ${taskId}.`);
}

function isAppTab(value: string): value is AppTab {
  return value === "trace" || value === "control" || value === "agents" || value === "projects" || value === "settings";
}

function readRouteFromHash(): AppRoute {
  if (typeof window === "undefined") {
    return "home";
  }
  const normalized = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
  if (!normalized || normalized === "home") {
    return "home";
  }
  if (isAppTab(normalized)) {
    return normalized;
  }
  return "home";
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => readRouteFromHash());
  const [settings, setSettings] = useState<UiSettings>(() => loadSettings());
  const [localePreview, setLocalePreview] = useState<UiSettings["locale"] | null>(null);
  const [projectIdDraft, setProjectIdDraft] = useState(settings.defaultProjectId);
  const [projectId, setProjectId] = useState(settings.defaultProjectId);
  const [refreshToken, setRefreshToken] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectListResponse | null>(null);
  const [schedulerState, setSchedulerState] = useState<SchedulerStateResponse | null>(null);
  const [heroReadModel, setHeroReadModel] = useState<ReadModelResponse | null>(null);
  const [dashboardWorktrees, setDashboardWorktrees] = useState<WorktreeListResponse | null>(null);
  const [dashboardExecutionContexts, setDashboardExecutionContexts] = useState<ExecutionContextListResponse | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [messageActionBusyId, setMessageActionBusyId] = useState<string | null>(null);
  const [messageActionError, setMessageActionError] = useState<string | null>(null);
  const [dashboardActionBusyTaskId, setDashboardActionBusyTaskId] = useState<string | null>(null);
  const [dashboardActionFeedback, setDashboardActionFeedback] = useState<string | null>(null);
  const [dashboardQueueFilter, setDashboardQueueFilter] = useState("");
  const [homeDashboardTab, setHomeDashboardTab] = useState<HomeDashboardTab>("runtime");
  const heroStageRef = useRef<HTMLElement | null>(null);
  const locale = localePreview ?? settings.locale;
  const tabs: Array<{ id: AppRoute; label: string }> = [
    { id: "home", label: localize(locale, "首页", "Home") },
    { id: "trace", label: t(locale, "tabs.trace") },
    { id: "control", label: t(locale, "tabs.control") },
    { id: "agents", label: localize(locale, "Agent 工作台", "Agents") },
    { id: "projects", label: t(locale, "tabs.projects") },
    { id: "settings", label: t(locale, "tabs.settings") },
  ];

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(readRouteFromHash());
    };
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    setProjectIdDraft(settings.defaultProjectId);
    if (!projectId) {
      setProjectId(settings.defaultProjectId);
    }
  }, [settings.defaultProjectId, projectId]);

  useEffect(() => {
    let cancelled = false;
    void fetchHealth(settings.apiBaseUrl)
      .then((result) => {
        if (!cancelled) {
          setHealth(result);
          setHealthError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setHealthError(error instanceof Error ? error.message : String(error));
          setHealth(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.apiBaseUrl, refreshToken]);

  useEffect(() => {
    let cancelled = false;

    const loadDashboard = async () => {
      try {
        const [nextProjects, nextScheduler] = await Promise.all([
          fetchProjects(6, settings.apiBaseUrl),
          fetchSchedulerState(settings.apiBaseUrl),
        ]);

        const nextProjectId = projectId.trim() || nextProjects.projects[0]?.project.project_id || "";
        let nextReadModel: ReadModelResponse | null = null;
        let nextDashboardError: string | null = null;

        if (nextProjectId) {
          try {
            const [readModel, worktrees, executionContexts] = await Promise.all([
              fetchReadModel(
                nextProjectId,
                Math.max(settings.traceLimit, 12),
                settings.apiBaseUrl,
              ),
              fetchWorktrees({ projectId: nextProjectId, limit: 8 }, settings.apiBaseUrl),
              fetchExecutionContexts({ projectId: nextProjectId, limit: 8 }, settings.apiBaseUrl),
            ]);
            nextReadModel = readModel;
            if (!cancelled) {
              setDashboardWorktrees(worktrees);
              setDashboardExecutionContexts(executionContexts);
            }
          } catch (error) {
            nextDashboardError = error instanceof Error ? error.message : String(error);
          }
        } else {
          const [worktrees, executionContexts] = await Promise.all([
            fetchWorktrees({ limit: 8 }, settings.apiBaseUrl),
            fetchExecutionContexts({ limit: 8 }, settings.apiBaseUrl),
          ]);
          if (!cancelled) {
            setDashboardWorktrees(worktrees);
            setDashboardExecutionContexts(executionContexts);
          }
        }

        if (!cancelled) {
          setProjects(nextProjects);
          setSchedulerState(nextScheduler);
          setHeroReadModel(nextReadModel);
          setDashboardError(nextDashboardError);
        }
      } catch (error) {
        if (!cancelled) {
          setDashboardError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void loadDashboard();

    if (settings.autoRefreshSeconds <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => {
      void loadDashboard();
    }, Math.max(settings.autoRefreshSeconds, 10) * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId, refreshToken, settings.apiBaseUrl, settings.autoRefreshSeconds, settings.traceLimit]);

  useEffect(() => {
    const heroStage = heroStageRef.current;
    if (!heroStage) {
      return;
    }

    let frameId = 0;

    const updateMotion = (clientX: number, clientY: number) => {
      const bounds = heroStage.getBoundingClientRect();
      const offsetX = (clientX - bounds.left) / bounds.width - 0.5;
      const offsetY = (clientY - bounds.top) / bounds.height - 0.5;
      heroStage.style.setProperty("--pointer-x", `${(offsetX * 2).toFixed(4)}`);
      heroStage.style.setProperty("--pointer-y", `${(offsetY * 2).toFixed(4)}`);
      heroStage.style.setProperty("--glow-x", `${((offsetX + 0.5) * 100).toFixed(2)}%`);
      heroStage.style.setProperty("--glow-y", `${((offsetY + 0.5) * 100).toFixed(2)}%`);
    };

    const onPointerMove = (event: PointerEvent) => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => updateMotion(event.clientX, event.clientY));
    };

    const onPointerLeave = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        heroStage.style.setProperty("--pointer-x", "0");
        heroStage.style.setProperty("--pointer-y", "0");
        heroStage.style.setProperty("--glow-x", "50%");
        heroStage.style.setProperty("--glow-y", "32%");
      });
    };

    heroStage.addEventListener("pointermove", onPointerMove);
    heroStage.addEventListener("pointerleave", onPointerLeave);
    onPointerLeave();

    return () => {
      cancelAnimationFrame(frameId);
      heroStage.removeEventListener("pointermove", onPointerMove);
      heroStage.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  function navigateTo(nextRoute: AppRoute): void {
    if (typeof window === "undefined") {
      setRoute(nextRoute);
      return;
    }
    const nextHash = nextRoute === "home" ? "#/home" : `#/${nextRoute}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    } else {
      setRoute(nextRoute);
    }
  }

  async function handleDashboardMessageAction(
    messageId: string,
    action: "mark-read" | "ack" | "handoff-state",
    handoffState?: string,
  ): Promise<void> {
    setMessageActionBusyId(messageId);
    setMessageActionError(null);
    try {
      if (action === "mark-read") {
        await markMessageRead(messageId, settings.apiBaseUrl);
      } else if (action === "ack") {
        await ackMessage(messageId, settings.apiBaseUrl);
      } else if (handoffState) {
        await setMessageHandoffState(messageId, { handoff_state: handoffState }, settings.apiBaseUrl);
      }
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setMessageActionBusyId(null);
    }
  }

  async function handleDashboardExecutionAction(
    action: "attach" | "checkpoint" | "merge" | "cleanup",
    taskId: string,
  ): Promise<void> {
    setDashboardActionBusyTaskId(taskId);
    setDashboardActionFeedback(null);
    setDashboardError(null);
    try {
      let result: ControlActionResult;
      if (action === "attach") {
        result = await attachTask(taskId, settings.apiBaseUrl);
      } else if (action === "checkpoint") {
        result = await checkpointTask(taskId, settings.apiBaseUrl);
      } else if (action === "merge") {
        result = await mergeTask(taskId, settings.apiBaseUrl);
      } else {
        result = await cleanupTask(taskId, settings.apiBaseUrl);
      }
      setDashboardActionFeedback(describeDashboardActionCopy(locale, action, taskId, result));
      setRefreshToken((current) => current + 1);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : String(error));
    } finally {
      setDashboardActionBusyTaskId(null);
    }
  }

  function renderActivePage() {
    if (route === "trace") {
      return (
        <TracePage
          apiBaseUrl={settings.apiBaseUrl}
          projectId={projectId}
          limit={settings.traceLimit}
          refreshToken={refreshToken}
          autoRefreshSeconds={settings.autoRefreshSeconds}
          locale={locale}
        />
      );
    }
    if (route === "control") {
      return <ControlPage apiBaseUrl={settings.apiBaseUrl} projectId={projectId} refreshToken={refreshToken} locale={locale} />;
    }
    if (route === "agents") {
      return (
        <AgentsPage
          apiBaseUrl={settings.apiBaseUrl}
          projectId={projectId}
          refreshToken={refreshToken}
          autoRefreshSeconds={settings.autoRefreshSeconds}
          locale={locale}
        />
      );
    }
    if (route === "projects") {
      return (
        <ProjectsPage
          apiBaseUrl={settings.apiBaseUrl}
          refreshToken={refreshToken}
          locale={locale}
          onOpenTrace={(nextProjectId) => {
            setProjectId(nextProjectId);
            setProjectIdDraft(nextProjectId);
            setSettings((current) => ({ ...current, defaultProjectId: nextProjectId }));
            navigateTo("trace");
          }}
        />
      );
    }
    if (route === "home") {
      return null;
    }
    return (
      <SettingsPage
        settings={settings}
        locale={locale}
        onPreviewLocale={setLocalePreview}
        onApply={(nextSettings) => {
          setSettings(nextSettings);
          setLocalePreview(null);
          setRefreshToken((current) => current + 1);
        }}
      />
    );
  }

  const runtimeStatus = health?.status || (healthError ? "error" : "loading");
  const runtimePath = health?.db_path || healthError || t(locale, "dashboard.awaitingRuntimeHealth");
  const monitoredProjectId = heroReadModel?.project.project_id || projectId.trim() || projects?.projects[0]?.project.project_id || "";
  const monitoredProject =
    heroReadModel?.project ||
    projects?.projects.find((item) => item.project.project_id === monitoredProjectId)?.project ||
    projects?.projects[0]?.project ||
    null;
  const monitoredProjectSummary =
    projects?.projects.find((item) => item.project.project_id === monitoredProjectId)?.summary || projects?.projects[0]?.summary || null;
  const activeTasks = heroReadModel?.summary.counts.active_tasks ?? monitoredProjectSummary?.active_tasks ?? 0;
  const artifactCount = heroReadModel?.summary.counts.artifacts ?? monitoredProjectSummary?.artifacts ?? 0;
  const packageCount = heroReadModel?.summary.counts.packages ?? monitoredProjectSummary?.packages ?? 0;
  const eventCount = heroReadModel?.summary.counts.events ?? monitoredProjectSummary?.events ?? 0;
  const messageCount = heroReadModel?.summary.counts.messages ?? monitoredProjectSummary?.messages ?? 0;
  const activeWorktrees =
    dashboardWorktrees?.worktrees.filter((item) => ["prepared", "active"].includes(item.status.toLowerCase())).length ??
    heroReadModel?.summary.counts.active_worktrees ??
    0;
  const executionContextCount =
    dashboardExecutionContexts?.execution_contexts.filter((item) => ["prepared", "active"].includes(item.status.toLowerCase())).length ??
    heroReadModel?.summary.counts.active_execution_contexts ??
    0;
  const runningAgents =
    heroReadModel?.read_model.agent_states.filter((agent) => !["idle", "disabled"].includes(agent.state.toLowerCase())).length ??
    monitoredProjectSummary?.non_idle_agents ??
    0;
  const queuedJobs =
    schedulerState?.roles.reduce((total, role) => total + getQueueTotal(role.queue), 0) ?? 0;
  const activeRoles = schedulerState?.roles.filter((role) => role.active).length ?? 0;
  const outputSignals = [
    { label: t(locale, "dashboard.output.artifacts"), value: artifactCount, icon: Boxes },
    { label: t(locale, "dashboard.output.packages"), value: packageCount, icon: FolderKanban },
    { label: t(locale, "dashboard.output.events"), value: eventCount, icon: Activity },
    { label: t(locale, "dashboard.output.messages"), value: messageCount, icon: Workflow },
  ];
  const liveAgents = heroReadModel?.read_model.agent_states.slice(0, 5) ?? [];
  const schedulerRoles = schedulerState?.roles.slice(0, 5) ?? [];
  const dispatchLog = heroReadModel?.trace.timeline.slice(0, 6) ?? [];
  const handoffQueue = heroReadModel?.read_model.pending_inbox ?? [];
  const handoffMetrics = heroReadModel?.read_model.handoff_metrics ?? null;
  const handoffSlaAgents = heroReadModel?.read_model.handoff_sla.agents.slice(0, 5) ?? [];
  const filteredHandoffQueue = handoffQueue.filter((message) =>
    dashboardQueueFilter ? (message.handoff_state || "queued") === dashboardQueueFilter : true,
  );
  const handoffQueueGroups = groupDashboardMessages(filteredHandoffQueue, "to_agent");
  const worktreeRows = dashboardWorktrees?.worktrees.slice(0, 4) ?? heroReadModel?.read_model.active_worktrees.slice(0, 4) ?? [];
  const executionRows =
    dashboardExecutionContexts?.execution_contexts.slice(0, 4) ?? heroReadModel?.read_model.execution_contexts.slice(0, 4) ?? [];
  const topProjects = projects?.projects.slice(0, 3) ?? [];
  const latestEventType =
    heroReadModel?.summary.latest_event_type || monitoredProjectSummary?.latest_event_type || t(locale, "dashboard.awaitingEvents");
  const updatedLabel = heroReadModel ? formatDateTime(locale, heroReadModel.project.updated_at) : t(locale, "dashboard.awaitingSnapshot");
  const activePageLabel = tabs.find((item) => item.id === route)?.label || localize(locale, "首页", "Home");
  const activePageCopy =
    route === "trace"
      ? localize(locale, "独立查看时间线、队列和执行链路。", "Inspect timeline, queues, and execution flow on a dedicated page.")
      : route === "control"
        ? localize(locale, "独立管理路由、凭证和运行策略。", "Manage routing, credentials, and runtime policy on a dedicated page.")
        : route === "agents"
          ? localize(locale, "独立查看 Agent Workspace，不再嵌在首页下面。", "Agent Workspace now lives on its own page.")
          : route === "projects"
            ? localize(locale, "独立管理项目入口和切换。", "Manage projects from a dedicated page.")
            : route === "settings"
              ? localize(locale, "独立维护本地连接与界面设置。", "Maintain local connection and UI settings on a dedicated page.")
              : localize(locale, "首页只保留总览大屏。", "Home now only keeps the overview dashboard.");

  return (
    <div className="video-shell">
      <video
        className="video-background"
        autoPlay
        loop
        muted
        playsInline
        src={HERO_VIDEO_URL}
      />
      <div className="video-overlay" />
      <div className="video-vignette" />

      <div className="app-shell">
        {route === "home" ? (
        <section ref={heroStageRef} className="hero-stage">
          <div className="hero-ambient hero-ambient--one" aria-hidden="true" />
          <div className="hero-ambient hero-ambient--two" aria-hidden="true" />
          <div className="hero-ambient hero-ambient--three" aria-hidden="true" />
          <div className="hero-grid">
            <div className="hero-left">
              <div className="hero-left__glass liquid-glass-strong motion-panel">
                <div className="hero-left__content">
                  <header className="hero-nav motion-fade-up">
                    <button
                      type="button"
                      className="brand-lockup"
                      onClick={() => navigateTo("trace")}
                      aria-label={locale === "zh-CN" ? "打开 SciAILab 工作区" : "Open SciAILab workspace"}
                    >
                      <img src="/logo.png" alt="SciAILab logo" className="brand-mark" />
                      <span className="brand-text">sciailab</span>
                    </button>

                    <button type="button" className="menu-button liquid-glass" onClick={() => navigateTo("control")}>
                      <Menu size={18} strokeWidth={1.8} />
                      <span>{t(locale, "dashboard.menu")}</span>
                    </button>
                  </header>

                  <div className="hero-dashboard">
                    <div className="command-deck motion-fade-up motion-fade-up--delay-1">
                      <div className="hero-center hero-center--dashboard">
                        <div className="hero-copyblock">
                          <img src="/logo.png" alt="SciAILab logo" className="hero-logo motion-float" />
                          <div className="eyebrow">{t(locale, "dashboard.commandDeckEyebrow")}</div>
                          <h1 className={`hero-title hero-title--dashboard ${locale === "zh-CN" ? "hero-title--dashboard-zh" : ""}`}>
                            {locale === "zh-CN" ? (
                              <>
                                <span className="hero-title__brand">{t(locale, "dashboard.titlePrefix")}</span>
                                <span className="hero-title__cn">
                                  <em>{t(locale, "dashboard.titleEmphasis")}</em>
                                  <span>{t(locale, "dashboard.titleSuffix")}</span>
                                </span>
                              </>
                            ) : (
                              <>
                                {t(locale, "dashboard.titlePrefix")} <em>{t(locale, "dashboard.titleEmphasis")}</em>{" "}
                                {t(locale, "dashboard.titleSuffix")}
                              </>
                            )}
                          </h1>
                          <p className="hero-subcopy hero-subcopy--dashboard">
                            {t(locale, "dashboard.copy")}
                          </p>
                        </div>

                        <div className="signal-bar">
                          <div className="signal-pill liquid-glass">
                            <Cpu size={16} strokeWidth={1.8} />
                            <span>{t(locale, "dashboard.runtime")}</span>
                            <StatusBadge value={runtimeStatus} locale={locale} />
                          </div>
                          <div className="signal-pill liquid-glass">
                            <Radar size={16} strokeWidth={1.8} />
                            <span>{t(locale, "dashboard.queues")}</span>
                            <strong>{queuedJobs}</strong>
                          </div>
                          <div className="signal-pill liquid-glass">
                            <Workflow size={16} strokeWidth={1.8} />
                            <span>{t(locale, "dashboard.worktrees")}</span>
                            <strong>{activeWorktrees}</strong>
                          </div>
                          <div className="signal-pill liquid-glass">
                            <Bot size={16} strokeWidth={1.8} />
                            <span>{t(locale, "dashboard.runningAgents")}</span>
                            <strong>{runningAgents}</strong>
                          </div>
                          <div className="signal-pill liquid-glass">
                            <FolderKanban size={16} strokeWidth={1.8} />
                            <span>{t(locale, "dashboard.executionContexts")}</span>
                            <strong>{executionContextCount}</strong>
                          </div>
                        </div>

                        <div className="hero-metric-grid motion-fade-up motion-fade-up--delay-2">
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{t(locale, "dashboard.labRuntime")}</span>
                            <strong><StatusBadge value={runtimeStatus} locale={locale} /></strong>
                            <span>{health?.auto_consume_events ? t(locale, "dashboard.autoConsumeEnabled") : t(locale, "dashboard.manualConsumeMode")}</span>
                          </article>
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{t(locale, "dashboard.outputs")}</span>
                            <strong>{artifactCount + packageCount}</strong>
                            <span>{t(locale, "dashboard.outputsSummary", { artifacts: artifactCount, packages: packageCount })}</span>
                          </article>
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{t(locale, "dashboard.agentLoad")}</span>
                            <strong>{runningAgents}</strong>
                            <span>{t(locale, "dashboard.agentLoadSummary", { roles: activeRoles, tasks: activeTasks })}</span>
                          </article>
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{t(locale, "dashboard.lastEvent")}</span>
                            <strong>{latestEventType}</strong>
                            <span>{updatedLabel}</span>
                          </article>
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{localize(locale, "阻塞交接", "Blocked Handoffs")}</span>
                            <strong>{handoffMetrics?.blocked_count ?? 0}</strong>
                            <span>
                              {localize(
                                locale,
                                `最久阻塞 ${formatAge(locale, handoffMetrics?.oldest_blocked_age_seconds)}`,
                                `Oldest blocked ${formatAge(locale, handoffMetrics?.oldest_blocked_age_seconds)}`,
                              )}
                            </span>
                          </article>
                          <article className="cyber-stat-card">
                            <span className="cyber-stat-card__label">{localize(locale, "超时 Pending", "Timed-out Pending")}</span>
                            <strong>{handoffMetrics?.aged_pending_count ?? 0}</strong>
                            <span>
                              {localize(
                                locale,
                                `阈值 ${formatAge(locale, handoffMetrics?.pending_timeout_seconds)}`,
                                `Threshold ${formatAge(locale, handoffMetrics?.pending_timeout_seconds)}`,
                              )}
                            </span>
                          </article>
                        </div>

                        <div className="command-actions motion-fade-up motion-fade-up--delay-3">
                          <button
                            type="button"
                            className="cta-button liquid-glass-strong"
                            onClick={() => navigateTo("trace")}
                          >
                            <span>{t(locale, "dashboard.openTrace")}</span>
                            <span className="icon-circle">
                              <Download size={16} strokeWidth={1.8} />
                            </span>
                          </button>

                          <div className="chip-row">
                            <button type="button" className="chip-pill liquid-glass" onClick={() => navigateTo("control")}>
                              {t(locale, "dashboard.routingMatrix")}
                            </button>
                            <button type="button" className="chip-pill liquid-glass" onClick={() => navigateTo("agents")}>
                              {localize(locale, "Agent 工作台", "Agent Workspace")}
                            </button>
                            <button type="button" className="chip-pill liquid-glass" onClick={() => navigateTo("projects")}>
                              {t(locale, "dashboard.outputArchive")}
                            </button>
                            <button type="button" className="chip-pill liquid-glass" onClick={() => navigateTo("settings")}>
                              {t(locale, "dashboard.runtimeSettings")}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div className="command-floor motion-fade-up motion-fade-up--delay-4">
                        <section className="scanner-panel liquid-glass">
                          <div className="scanner-panel__header">
                            <div>
                              <div className="eyebrow">{t(locale, "dashboard.projectScanEyebrow")}</div>
                              <h2>{t(locale, "dashboard.projectScanTitle")}</h2>
                            </div>
                            <button type="button" className="ghost-link liquid-glass" onClick={() => navigateTo("projects")}>
                              {t(locale, "dashboard.openArchive")}
                            </button>
                          </div>
                          <div className="scanner-grid">
                            {topProjects.length ? (
                              topProjects.map((item) => (
                                <button
                                  key={item.project.project_id}
                                  type="button"
                                  className={`scanner-card ${monitoredProjectId === item.project.project_id ? "active" : ""}`}
                                  onClick={() => {
                                    setProjectId(item.project.project_id);
                                    setProjectIdDraft(item.project.project_id);
                                    navigateTo("trace");
                                  }}
                                >
                                  <div className="scanner-card__title">
                                    <strong>{item.project.name}</strong>
                                    <StatusBadge value={item.project.status} locale={locale} />
                                  </div>
                                  <span className="mono">{item.project.project_id}</span>
                                  <span>{t(locale, "dashboard.projectScanSummary", { tasks: item.summary.active_tasks, agents: item.summary.non_idle_agents })}</span>
                                </button>
                              ))
                            ) : (
                              <div className="empty-state compact">{t(locale, "dashboard.noIndexedProjects")}</div>
                            )}
                          </div>
                        </section>

                        <section className="radar-panel liquid-glass">
                          <div className="scanner-panel__header">
                            <div>
                              <div className="eyebrow">{t(locale, "dashboard.outputVectorEyebrow")}</div>
                              <h2>{t(locale, "dashboard.outputVectorTitle")}</h2>
                            </div>
                          </div>
                          <div className="signal-grid">
                            {outputSignals.map((item) => {
                              const Icon = item.icon;
                              return (
                                <div key={item.label} className="signal-cell">
                                  <span className="icon-circle icon-circle--small">
                                    <Icon size={14} strokeWidth={1.8} />
                                  </span>
                                  <div>
                                    <strong>{item.value}</strong>
                                    <span>{item.label}</span>
                                  </div>
                                  <div className="signal-cell__bar">
                                    <span style={{ width: `${Math.min(100, Math.max(12, item.value * 8))}%` }} />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <aside className="hero-right">
              <div className="hero-right__topbar motion-fade-up motion-fade-up--delay-1">
                <div className="social-pill liquid-glass motion-panel motion-panel--small">
                  <span className="icon-link" aria-hidden="true">
                    <Twitter size={16} strokeWidth={1.8} />
                  </span>
                  <span className="icon-link" aria-hidden="true">
                    <Linkedin size={16} strokeWidth={1.8} />
                  </span>
                  <span className="icon-link" aria-hidden="true">
                    <Instagram size={16} strokeWidth={1.8} />
                  </span>
                  <span className="icon-circle icon-circle--small">
                    <ArrowRight size={14} strokeWidth={1.8} />
                  </span>
                </div>

                <button
                  type="button"
                  className="account-button liquid-glass motion-panel motion-panel--small"
                  onClick={() => navigateTo("settings")}
                >
                  <span className="icon-circle icon-circle--small">
                    <Sparkles size={14} strokeWidth={1.8} />
                  </span>
                  <span>{t(locale, "dashboard.operator")}</span>
                </button>
              </div>

              <div className="hero-aside-card liquid-glass motion-panel motion-fade-up motion-fade-up--delay-2">
                <div className="eyebrow">{t(locale, "dashboard.labStatus")}</div>
                <h2>{monitoredProject?.name || t(locale, "dashboard.noProjectSelected")}</h2>
                <p>{monitoredProject?.goal || t(locale, "dashboard.loadProjectHint")}</p>
              </div>

              <div className="feature-shell feature-shell--compact liquid-glass motion-panel motion-fade-up motion-fade-up--delay-3">
                <div className="feature-grid feature-grid--stacked">
                  <div className="feature-card liquid-glass motion-float motion-float--delay-1">
                    <span className="icon-circle">
                      <Wand2 size={18} strokeWidth={1.8} />
                    </span>
                    <div>
                      <strong>{t(locale, "dashboard.runtimeCore")}</strong>
                      <p>{health?.workspace_root || t(locale, "dashboard.awaitingWorkspaceRoot")}</p>
                    </div>
                  </div>

                  <div className="feature-card liquid-glass motion-float motion-float--delay-2">
                    <span className="icon-circle">
                      <BookOpen size={18} strokeWidth={1.8} />
                    </span>
                    <div>
                      <strong>{t(locale, "dashboard.worktreeRoot")}</strong>
                      <p>{health?.worktree_root || t(locale, "dashboard.awaitingWorkspaceRoot")}</p>
                    </div>
                  </div>
                </div>

                <div className="feature-preview feature-preview--dashboard liquid-glass motion-panel motion-float motion-float--delay-3">
                  <div className="feature-preview__body feature-preview__body--stack">
                    <div className="feature-preview__tabs">
                      {[
                        { key: "runtime" as const, label: localize(locale, "运行", "Runtime") },
                        { key: "queue" as const, label: localize(locale, "队列", "Queue") },
                        { key: "logs" as const, label: localize(locale, "日志", "Logs") },
                      ].map((tab) => (
                        <button
                          key={tab.key}
                          type="button"
                          className={`tab-button liquid-glass ${homeDashboardTab === tab.key ? "active" : ""}`}
                          onClick={() => setHomeDashboardTab(tab.key)}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {homeDashboardTab === "runtime" ? (
                      <div className="feature-preview__panel">
                    <div className="feature-preview__section">
                      <h3>{t(locale, "dashboard.runningAgentsTitle")}</h3>
                      <div className="agent-monitor-list">
                        {liveAgents.length ? (
                          liveAgents.map((agent) => (
                            <div key={`${agent.project_id}:${agent.agent_id}`} className="agent-monitor-row">
                              <div>
                                <strong>{agent.agent_id}</strong>
                                <span className="mono">{agent.current_task_id || t(locale, "dashboard.noCurrentTask")}</span>
                              </div>
                              <StatusBadge value={agent.state} locale={locale} />
                            </div>
                          ))
                        ) : (
                          schedulerRoles.map((role) => (
                            <div key={role.role} className="agent-monitor-row">
                              <div>
                                <strong>{role.role}</strong>
                                <span className="mono">{formatQueueSummary(role.queue, locale)}</span>
                              </div>
                              <StatusBadge
                                value={role.agent_state?.state || (role.active ? "idle" : "disabled")}
                                locale={locale}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="feature-preview__section">
                      <div className="eyebrow">{t(locale, "dashboard.worktreeBoardEyebrow")}</div>
                      <div className="feature-preview__section-header">
                        <h3>{t(locale, "dashboard.worktreeBoardTitle")}</h3>
                        <button type="button" className="plus-button liquid-glass" onClick={() => navigateTo("control")}>
                          +
                        </button>
                      </div>
                      <div className="agent-monitor-list">
                        {worktreeRows.length ? (
                          worktreeRows.map((item) => (
                            <div key={item.worktree_id} className="agent-monitor-row">
                              <div>
                                <strong>{item.owner_agent}</strong>
                                <span className="mono">{formatCompactPath(item.worktree_path)}</span>
                              </div>
                              <StatusBadge value={item.status} locale={locale} />
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{t(locale, "dashboard.noWorktreeData")}</div>
                        )}
                      </div>
                    </div>

                    <div className="feature-preview__section">
                      <div className="eyebrow">{t(locale, "dashboard.executionBoardEyebrow")}</div>
                      <div className="feature-preview__section-header">
                        <h3>{t(locale, "dashboard.executionBoardTitle")}</h3>
                        <button type="button" className="plus-button liquid-glass" onClick={() => navigateTo("control")}>
                          +
                        </button>
                      </div>
                      {dashboardActionFeedback ? <div className="inline-alert">{dashboardActionFeedback}</div> : null}
                      <div className="agent-monitor-list">
                        {executionRows.length ? (
                          executionRows.map((item) => (
                            <div key={`${item.task_id}:${item.updated_at}`} className="agent-monitor-row">
                              <div>
                                <strong>{item.owner_agent}</strong>
                                <span className="mono">{item.task_id}</span>
                                <span>{formatCompactPath(item.execution_workspace_path)}</span>
                              </div>
                              <div className="dashboard-execution-actions">
                                <StatusBadge value={item.status} locale={locale} />
                                <div className="table-actions">
                                  <button
                                    type="button"
                                    className="ghost-button liquid-glass"
                                    disabled={dashboardActionBusyTaskId === item.task_id}
                                    onClick={() => void handleDashboardExecutionAction("attach", item.task_id)}
                                  >
                                    {locale === "zh-CN" ? "附着" : "Attach"}
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button liquid-glass"
                                    disabled={dashboardActionBusyTaskId === item.task_id}
                                    onClick={() => void handleDashboardExecutionAction("checkpoint", item.task_id)}
                                  >
                                    {locale === "zh-CN" ? "检查点" : "Checkpoint"}
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button liquid-glass"
                                    disabled={dashboardActionBusyTaskId === item.task_id}
                                    onClick={() => void handleDashboardExecutionAction("merge", item.task_id)}
                                  >
                                    {locale === "zh-CN" ? "合并" : "Merge"}
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button liquid-glass"
                                    disabled={dashboardActionBusyTaskId === item.task_id}
                                    onClick={() => void handleDashboardExecutionAction("cleanup", item.task_id)}
                                  >
                                    {locale === "zh-CN" ? "清理" : "Cleanup"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{t(locale, "dashboard.noExecutionData")}</div>
                        )}
                      </div>
                    </div>

                    </div>
                    ) : null}

                    {homeDashboardTab === "queue" ? (
                      <div className="feature-preview__panel">
                    <div className="feature-preview__section">
                      <div className="feature-preview__section-header">
                        <h3>{localize(locale, "交接队列", "Handoff Queue")}</h3>
                        <button
                          type="button"
                          className="plus-button liquid-glass"
                          onClick={() => navigateTo("trace")}
                        >
                          +
                        </button>
                      </div>
                      {messageActionError ? <div className="inline-alert danger">{messageActionError}</div> : null}
                      <div className="chip-row">
                        {["", "queued", "seen", "accepted", "blocked", "completed"].map((value) => (
                          <button
                            key={`dashboard-queue-${value || "all"}`}
                            type="button"
                            className="chip-pill liquid-glass"
                            onClick={() => setDashboardQueueFilter(value)}
                          >
                            {value ? handoffStateLabel(locale, value) : localize(locale, "全部", "All")}
                          </button>
                        ))}
                      </div>
                      <div className="hint-grid compact-hint-grid">
                        {handoffQueueGroups.length ? (
                          handoffQueueGroups.map((group) => (
                            <div key={group.label} className="hint-card">
                              <strong>{group.label}</strong>
                              <span>{localize(locale, `${group.count} 条待处理`, `${group.count} pending`)}</span>
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{localize(locale, "当前筛选下没有交接。", "No handoffs under current filter.")}</div>
                        )}
                      </div>
                      <div className="dispatch-log">
                        {filteredHandoffQueue.length ? (
                          filteredHandoffQueue.map((message) => (
                            <div key={message.message_id} className="dispatch-log__row dispatch-log__row--message">
                              <span className="dispatch-log__time">{formatDateTime(locale, message.updated_at || message.created_at)}</span>
                              <div className="dispatch-log__body">
                                <strong>{message.from_agent} -&gt; {message.to_agent}</strong>
                                <span>{message.message_type} / {message.handoff_state || "queued"}</span>
                                <span>{message.content}</span>
                              </div>
                              <div className="dashboard-message-actions">
                                <StatusBadge value={message.status} locale={locale} />
                                <button
                                  type="button"
                                  className="ghost-button liquid-glass"
                                  disabled={messageActionBusyId === message.message_id || message.status === "resolved"}
                                  onClick={() => void handleDashboardMessageAction(message.message_id, "mark-read")}
                                >
                                  {localize(locale, "已读", "Read")}
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button liquid-glass"
                                  disabled={messageActionBusyId === message.message_id || message.status === "resolved"}
                                  onClick={() => void handleDashboardMessageAction(message.message_id, "ack")}
                                >
                                  {localize(locale, "确认", "Ack")}
                                </button>
                                <select
                                  value={message.handoff_state || "queued"}
                                  disabled={messageActionBusyId === message.message_id}
                                  onChange={(event) =>
                                    void handleDashboardMessageAction(
                                      message.message_id,
                                      "handoff-state",
                                      event.target.value,
                                    )
                                  }
                                >
                                  <option value="queued">{handoffStateLabel(locale, "queued")}</option>
                                  <option value="seen">{handoffStateLabel(locale, "seen")}</option>
                                  <option value="accepted">{handoffStateLabel(locale, "accepted")}</option>
                                  <option value="blocked">{handoffStateLabel(locale, "blocked")}</option>
                                  <option value="completed">{handoffStateLabel(locale, "completed")}</option>
                                </select>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{localize(locale, "当前没有待处理交接。", "No active handoffs.")}</div>
                        )}
                      </div>
                    </div>

                    <div className="feature-preview__section">
                      <div className="eyebrow">{localize(locale, "操作积压", "Operator Backlog")}</div>
                      <div className="hint-grid compact-hint-grid operator-backlog-grid">
                        {buildOperatorBacklogCards(locale, handoffMetrics).map((item) => (
                          <div key={item.label} className="hint-card">
                            <strong>{item.value}</strong>
                            <span>{item.label}</span>
                            <span>{item.detail}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="feature-preview__section">
                      <div className="eyebrow">{localize(locale, "Agent SLA", "Agent SLA")}</div>
                      <div className="feature-preview__section-header">
                        <h3>{localize(locale, "值班面板", "Coverage Board")}</h3>
                        <button type="button" className="plus-button liquid-glass" onClick={() => navigateTo("trace")}>
                          +
                        </button>
                      </div>
                      <div className="agent-monitor-list">
                        {handoffSlaAgents.length ? (
                          handoffSlaAgents.map((agent) => (
                            <div key={agent.agent_id} className="agent-monitor-row">
                              <div>
                                <strong>{agent.agent_id}</strong>
                                <span>{formatAgentSlaSummary(locale, agent)}</span>
                                <span className="mono">{formatAgentSlaAges(locale, agent)}</span>
                              </div>
                              <StatusBadge value={agent.sla_status} locale={locale} />
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{localize(locale, "当前没有活跃交接。", "No active handoffs.")}</div>
                        )}
                      </div>
                    </div>

                    </div>
                    ) : null}

                    {homeDashboardTab === "logs" ? (
                      <div className="feature-preview__panel">
                    <div className="feature-preview__section">
                      <div className="feature-preview__section-header">
                        <h3>{t(locale, "dashboard.dispatchLogs")}</h3>
                        <button type="button" className="plus-button liquid-glass" onClick={() => navigateTo("trace")}>
                          +
                        </button>
                      </div>
                      <div className="dispatch-log">
                        {dispatchLog.length ? (
                          dispatchLog.map((item) => (
                            <div key={`${item.kind}:${item.id}`} className="dispatch-log__row">
                              <span className="dispatch-log__time">{formatDateTime(locale, item.timestamp)}</span>
                              <div className="dispatch-log__body">
                                <strong>{item.title}</strong>
                                <span>{item.summary}</span>
                              </div>
                              <StatusBadge value={item.status || item.kind} locale={locale} />
                            </div>
                          ))
                        ) : (
                          <div className="empty-state compact">{t(locale, "dashboard.noDispatchEntries")}</div>
                        )}
                      </div>
                    </div>
                    </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>
        ) : null}

        {route !== "home" ? (
          <section className="workspace-stage workspace-stage--standalone">
            <div className="workspace-frame liquid-glass-strong">
              <div className="workspace-topbar">
                <div>
                  <div className="eyebrow">{localize(locale, "独立页面", "Standalone Page")}</div>
                  <h2>{activePageLabel}</h2>
                  <p className="muted-copy">{activePageCopy}</p>
                </div>

                <div className="workspace-topbar__meta">
                  <div className="runtime-pill liquid-glass">
                    <span>FastAPI</span>
                    <StatusBadge value={runtimeStatus} locale={locale} />
                  </div>
                  {dashboardError ? <div className="inline-alert danger">{dashboardError}</div> : null}
                  <div className="runtime-path mono">{runtimePath}</div>
                  <a
                    className="ghost-link liquid-glass"
                    href={
                      projectId
                        ? `${settings.apiBaseUrl || ""}/v1/projects/${encodeURIComponent(projectId)}/read-model?limit=${String(settings.traceLimit)}`
                        : "#"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t(locale, "dashboard.readModelJson")}
                  </a>
                </div>
              </div>

              <div className="workspace-controls liquid-glass">
                <label className="field field--project">
                  <span>{t(locale, "topbar.project")}</span>
                  <input
                    value={projectIdDraft}
                    placeholder={t(locale, "topbar.projectPlaceholder")}
                    onChange={(event) => setProjectIdDraft(event.target.value)}
                  />
                </label>

                <label className="field">
                  <span>{t(locale, "language")}</span>
                  <select
                    value={locale}
                    onChange={(event) => {
                      const nextLocale = event.target.value === "en-US" ? "en-US" : "zh-CN";
                      setLocalePreview(null);
                      setSettings((current) => ({
                        ...current,
                        locale: nextLocale,
                      }));
                    }}
                  >
                    <option value="zh-CN">{t(locale, "language.zh-CN")}</option>
                    <option value="en-US">{t(locale, "language.en-US")}</option>
                  </select>
                </label>

                <button
                  type="button"
                  className="primary-button liquid-glass-strong"
                  onClick={() => {
                    const nextProjectId = projectIdDraft.trim();
                    setProjectId(nextProjectId);
                    setSettings((current) => ({ ...current, defaultProjectId: nextProjectId }));
                    setRefreshToken((current) => current + 1);
                  }}
                >
                  {t(locale, "topbar.load")}
                </button>

                <button
                  type="button"
                  className="ghost-button liquid-glass"
                  onClick={() => setRefreshToken((current) => current + 1)}
                >
                  {t(locale, "topbar.refresh")}
                </button>
              </div>

              <div className="workspace-tabs">
                {tabs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`tab-button liquid-glass ${route === item.id ? "active" : ""}`}
                    onClick={() => navigateTo(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="workspace-panel">{renderActivePage()}</div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function getQueueTotal(queue: Record<string, number>): number {
  return Object.values(queue).reduce((total, value) => total + value, 0);
}

function formatQueueSummary(queue: Record<string, number>, locale: UiSettings["locale"]): string {
  const entries = Object.entries(queue);
  if (!entries.length) {
    return t(locale, "control.queueEmpty");
  }
  return entries.map(([status, count]) => `${status}:${String(count)}`).join(" ");
}

function formatCompactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || normalized;
}

function groupDashboardMessages(
  messages: MessageRecord[],
  field: "to_agent" | "handoff_state",
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const label = field === "handoff_state" ? message.handoff_state || "queued" : message.to_agent;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}


