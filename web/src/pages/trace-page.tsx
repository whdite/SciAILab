import { useEffect, useState } from "react";
import { ackMessage, attachTask, createMessage, fetchReadModel, markMessageRead, setMessageHandoffState } from "../api";
import { DetailDrawer } from "../components/detail-drawer";
import { MetricCard } from "../components/metric-card";
import { StatusBadge } from "../components/status-badge";
import { formatDateTime, t, translateStatus, type Locale } from "../i18n";
import type {
  AgentStateRecord,
  AgentSlaRecord,
  ArtifactRecord,
  CompletionHookRecord,
  ControlActionResult,
  ExecutionContextRecord,
  HandoffMetrics,
  MessageCreatePayload,
  MessageRecord,
  PackageRecord,
  ReadModelResponse,
  TaskRecord,
  TimelineItem,
  WorktreeRecord,
} from "../types";

type TracePageProps = {
  apiBaseUrl: string;
  projectId: string;
  limit: number;
  refreshToken: number;
  autoRefreshSeconds: number;
  locale: Locale;
};

type TraceFilters = {
  eventType: string;
  status: string;
  ownerAgent: string;
  query: string;
};

type QueueFilters = {
  handoffState: string;
  targetAgent: string;
  groupBy: "to_agent" | "handoff_state" | "message_type";
};

const DEFAULT_FILTERS: TraceFilters = {
  eventType: "",
  status: "",
  ownerAgent: "",
  query: "",
};

const DEFAULT_QUEUE_FILTERS: QueueFilters = {
  handoffState: "",
  targetAgent: "",
  groupBy: "to_agent",
};

type TraceSelection = {
  kind: string;
  title: string;
  payload: unknown;
  taskId?: string | null;
  ownerAgent?: string | null;
  projectId?: string | null;
};

export function TracePage({
  apiBaseUrl,
  projectId,
  limit,
  refreshToken,
  autoRefreshSeconds,
  locale,
}: TracePageProps) {
  const [data, setData] = useState<ReadModelResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<TraceFilters>(DEFAULT_FILTERS);
  const [queueFilters, setQueueFilters] = useState<QueueFilters>(DEFAULT_QUEUE_FILTERS);
  const [selectedItem, setSelectedItem] = useState<TraceSelection | null>(null);
  const [attachBusyTaskId, setAttachBusyTaskId] = useState<string | null>(null);
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageSuccess, setMessageSuccess] = useState<string | null>(null);
  const [messageActionBusyId, setMessageActionBusyId] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  async function reloadReadModel(): Promise<ReadModelResponse | null> {
    if (!projectId.trim()) {
      return null;
    }
    const next = await fetchReadModel(projectId.trim(), limit, apiBaseUrl);
    setData(next);
    setError(null);
    setLastLoadedAt(Date.now());
    return next;
  }

  useEffect(() => {
    if (!projectId.trim()) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const next = await fetchReadModel(projectId.trim(), limit, apiBaseUrl);
        if (cancelled) {
          return;
        }
        setData(next);
        setError(null);
        setLastLoadedAt(Date.now());
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
  }, [apiBaseUrl, projectId, limit, refreshToken]);

  useEffect(() => {
    if (!projectId.trim() || autoRefreshSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void fetchReadModel(projectId.trim(), limit, apiBaseUrl)
        .then((next) => {
          setData(next);
          setError(null);
          setLastLoadedAt(Date.now());
        })
        .catch((nextError) => {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        });
    }, autoRefreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, autoRefreshSeconds, limit, projectId]);

  const filteredTimeline =
    data?.trace.timeline.filter((item) => {
      if (filters.eventType && item.event_type !== filters.eventType) {
        return false;
      }
      if (filters.status && item.status !== filters.status) {
        return false;
      }
      if (filters.ownerAgent && item.owner_agent !== filters.ownerAgent) {
        return false;
      }
      if (filters.query) {
        const haystack = `${item.title} ${item.summary} ${item.id}`.toLowerCase();
        if (!haystack.includes(filters.query.toLowerCase())) {
          return false;
        }
      }
      return true;
    }) ?? [];

  const queueMessages = applyQueueFilters(data?.read_model.pending_inbox ?? [], queueFilters);
  const teammateQueueMessages = applyQueueFilters(data?.read_model.teammate_messages ?? [], queueFilters);
  const queueGroupCounts = groupMessages(queueMessages, queueFilters.groupBy);
  const handoffMetrics = data?.read_model.handoff_metrics ?? null;
  const handoffSlaAgents = data?.read_model.handoff_sla.agents ?? [];
  const queueTargetAgents = uniqueMessageValues(
    [
      ...(data?.read_model.pending_inbox ?? []),
      ...(data?.read_model.teammate_messages ?? []),
    ],
    "to_agent",
  );

  async function runAttach(taskId: string): Promise<void> {
    setAttachBusyTaskId(taskId);
    setMessageError(null);
    setMessageSuccess(null);
    try {
      const payload = await attachTask(taskId, apiBaseUrl);
      setSelectedItem(makeAttachSelection(payload, taskId, locale));
      await reloadReadModel();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setAttachBusyTaskId(null);
    }
  }

  async function handleSendMessage(
    selection: TraceSelection | null,
    payload: MessageCreatePayload,
  ): Promise<void> {
    setMessageBusy(true);
    setMessageError(null);
    setMessageSuccess(null);
    try {
      await createMessage(payload, apiBaseUrl);
      setMessageSuccess(locale === "zh-CN" ? "队友消息已写入收件箱。" : "Teammate message queued.");
      await reloadReadModel();
      if (selection?.taskId) {
        const attachPayload = await attachTask(selection.taskId, apiBaseUrl);
        setSelectedItem(makeAttachSelection(attachPayload, selection.taskId, locale));
      }
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : String(nextError);
      setMessageError(message);
      throw nextError;
    } finally {
      setMessageBusy(false);
    }
  }

  async function refreshSelectedAttach(selection: TraceSelection | null): Promise<void> {
    if (selection?.kind !== "attach" || !selection.taskId) {
      return;
    }
    const attachPayload = await attachTask(selection.taskId, apiBaseUrl);
    setSelectedItem(makeAttachSelection(attachPayload, selection.taskId, locale));
  }

  async function handleMessageAction(
    messageId: string,
    action: "mark-read" | "ack" | "handoff-state",
    handoffState?: string,
  ): Promise<void> {
    setMessageActionBusyId(messageId);
    setError(null);
    try {
      if (action === "mark-read") {
        await markMessageRead(messageId, apiBaseUrl);
      } else if (action === "ack") {
        await ackMessage(messageId, apiBaseUrl);
      } else if (handoffState) {
        await setMessageHandoffState(messageId, { handoff_state: handoffState }, apiBaseUrl);
      }
      await reloadReadModel();
      await refreshSelectedAttach(selectedItem);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setMessageActionBusyId(null);
    }
  }

  return (
    <div className="page-layout with-drawer">
      <div className="page-main">
        <section className="hero-card">
          <div>
            <div className="eyebrow">{t(locale, "trace.heroEyebrow")}</div>
            <h1>{data?.project.name || t(locale, "trace.title")}</h1>
            <p className="hero-copy">{data?.project.goal || t(locale, "trace.copy")}</p>
          </div>
          <div className="hero-meta">
            <div className="pill mono">{projectId || t(locale, "trace.noProject")}</div>
            <div className="pill">{t(locale, "trace.limit", { limit })}</div>
            <div className="pill">
              {lastLoadedAt
                ? t(locale, "trace.updated", { time: new Date(lastLoadedAt).toLocaleTimeString(locale) })
                : t(locale, "trace.awaitingData")}
            </div>
          </div>
        </section>

        {error ? <div className="inline-alert danger">{error}</div> : null}
        {!projectId.trim() ? <div className="empty-state">{t(locale, "trace.setProjectPrompt")}</div> : null}

        <section className="metric-grid">
          <MetricCard label={t(locale, "trace.activeTasks")} value={data?.summary.counts.active_tasks ?? "-"} />
          <MetricCard label={t(locale, "trace.events")} value={data?.summary.counts.events ?? "-"} />
          <MetricCard label={t(locale, "trace.artifacts")} value={data?.summary.counts.artifacts ?? "-"} />
          <MetricCard label={t(locale, "trace.packages")} value={data?.summary.counts.packages ?? "-"} />
          <MetricCard
            label={t(locale, "trace.agentStates")}
            value={data?.summary.counts.agent_states ?? "-"}
            hint={loading ? t(locale, "trace.refreshing") : undefined}
          />
          <MetricCard label={t(locale, "trace.worktrees")} value={data?.summary.counts.worktrees ?? "-"} />
          <MetricCard label={t(locale, "trace.executionContexts")} value={data?.summary.counts.execution_contexts ?? "-"} />
          <MetricCard label={t(locale, "trace.completionHooks")} value={data?.summary.counts.completion_hooks ?? "-"} />
        </section>

        <section className="page-card">
          <div className="page-card__header">
            <div>
              <div className="eyebrow">{localize(locale, "Operator 积压", "Operator Backlog")}</div>
              <h2>{localize(locale, "交接积压与 SLA", "Handoff Backlog & SLA")}</h2>
            </div>
          </div>
          <div className="operator-backlog-layout">
            <div className="hint-grid compact-hint-grid operator-backlog-grid">
              {buildOperatorBacklogCards(locale, handoffMetrics).map((item) => (
                <div key={item.label} className="hint-card">
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
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
        </section>

        <div className="two-column">
          <section className="page-card">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{t(locale, "trace.currentWorkEyebrow")}</div>
                <h2>{t(locale, "trace.currentWorkTitle")}</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(locale, "trace.task")}</th>
                  <th>{t(locale, "trace.owner")}</th>
                  <th>{t(locale, "control.status")}</th>
                  <th>{t(locale, "trace.dependency")}</th>
                  <th>{t(locale, "trace.attachAction")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.read_model.active_tasks.length ? (
                  data.read_model.active_tasks.map((task) => (
                    <tr key={task.task_id} onClick={() => setSelectedItem(makeTimelineSelection(makeTaskTimelineProxy(task, locale), projectId, locale))}>
                      <td>{task.title}</td>
                      <td>{task.owner_agent}</td>
                      <td><StatusBadge value={task.status} locale={locale} /></td>
                      <td className="mono">{task.dependency || t(locale, "trace.none")}</td>
                      <td>
                        <button type="button" className="ghost-button" onClick={(event) => { event.stopPropagation(); void runAttach(task.task_id); }}>
                          {attachBusyTaskId === task.task_id ? t(locale, "trace.refreshing") : t(locale, "trace.attachAction")}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={5} className="empty-cell">{t(locale, "trace.noActiveTasks")}</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="page-card">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{t(locale, "trace.rolesEyebrow")}</div>
                <h2>{t(locale, "trace.rolesTitle")}</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(locale, "trace.agent")}</th>
                  <th>{t(locale, "control.state")}</th>
                  <th>{t(locale, "trace.currentTask")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.read_model.agent_states.length ? (
                  data.read_model.agent_states.map((agent) => (
                    <tr key={`${agent.project_id}:${agent.agent_id}`} onClick={() => setSelectedItem(makeTimelineSelection(makeAgentTimelineProxy(agent, locale), projectId, locale))}>
                      <td>{agent.agent_id}</td>
                      <td><StatusBadge value={agent.state} locale={locale} /></td>
                      <td className="mono">{agent.current_task_id || t(locale, "trace.none")}</td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={3} className="empty-cell">{t(locale, "trace.noAgentStates")}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </div>

        <div className="two-column">
          <section className="page-card">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{t(locale, "trace.attachEyebrow")}</div>
                <h2>{t(locale, "trace.attachTitle")}</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(locale, "trace.owner")}</th>
                  <th>{t(locale, "trace.currentTask")}</th>
                  <th>{t(locale, "trace.runtimeKind")}</th>
                  <th>{t(locale, "trace.attachPath")}</th>
                  <th>{t(locale, "control.status")}</th>
                  <th>{t(locale, "trace.attachAction")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.read_model.execution_contexts.length ? (
                  data.read_model.execution_contexts.map((context) => (
                    <tr key={`${context.task_id}:${context.updated_at}`} onClick={() => setSelectedItem(makeTimelineSelection(makeExecutionContextTimelineProxy(context), projectId, locale))}>
                      <td>{context.owner_agent}</td>
                      <td className="mono">{context.task_id}</td>
                      <td>{context.runtime_kind}</td>
                      <td className="mono">{formatCompactPath(context.execution_workspace_path)}</td>
                      <td><StatusBadge value={context.status} locale={locale} /></td>
                      <td>
                        <button type="button" className="ghost-button" onClick={(event) => { event.stopPropagation(); void runAttach(context.task_id); }}>
                          {attachBusyTaskId === context.task_id ? t(locale, "trace.refreshing") : t(locale, "trace.attachAction")}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={6} className="empty-cell">{t(locale, "trace.noExecutionContexts")}</td></tr>
                )}
              </tbody>
            </table>
            <div className="list-grid compact-list-grid">
              {data?.read_model.active_worktrees.length ? (
                data.read_model.active_worktrees.map((worktree) => (
                  <button key={worktree.worktree_id} type="button" className="list-card" onClick={() => setSelectedItem(makeTimelineSelection(makeWorktreeTimelineProxy(worktree), projectId, locale))}>
                    <strong>{worktree.owner_agent}</strong>
                    <span className="mono">{formatCompactPath(worktree.worktree_path)}</span>
                    <StatusBadge value={worktree.status} locale={locale} />
                  </button>
                ))
              ) : (
                <div className="empty-state compact">{t(locale, "trace.noWorktrees")}</div>
              )}
            </div>
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
                  <th>{t(locale, "trace.currentTask")}</th>
                  <th>{t(locale, "trace.completedAt")}</th>
                  <th>{t(locale, "control.status")}</th>
                </tr>
              </thead>
              <tbody>
                {data?.read_model.recent_hooks.length ? (
                  data.read_model.recent_hooks.map((hook) => (
                    <tr key={hook.hook_id} onClick={() => setSelectedItem(makeTimelineSelection(makeHookTimelineProxy(hook), projectId, locale))}>
                      <td>{hook.hook_type}</td>
                      <td className="mono">{hook.task_id}</td>
                      <td>{formatTimestamp(hook.completed_at || hook.updated_at, locale)}</td>
                      <td><StatusBadge value={hook.status} locale={locale} /></td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={4} className="empty-cell">{t(locale, "trace.noHooks")}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </div>

        <section className="page-card">
          <div className="page-card__header">
            <div>
              <div className="eyebrow">{localize(locale, "交接队列", "Queue Lens")}</div>
              <h2>{localize(locale, "交接分组与过滤", "Handoff Grouping & Filters")}</h2>
            </div>
          </div>
          <div className="filters-row">
            <label className="field">
              <span>{localize(locale, "交接状态", "Handoff State")}</span>
              <select
                value={queueFilters.handoffState}
                onChange={(event) => setQueueFilters((current) => ({ ...current, handoffState: event.target.value }))}
              >
                <option value="">{localize(locale, "全部", "All")}</option>
                <option value="queued">{handoffStateLabel(locale, "queued")}</option>
                <option value="seen">{handoffStateLabel(locale, "seen")}</option>
                <option value="accepted">{handoffStateLabel(locale, "accepted")}</option>
                <option value="blocked">{handoffStateLabel(locale, "blocked")}</option>
                <option value="completed">{handoffStateLabel(locale, "completed")}</option>
              </select>
            </label>
            <label className="field">
              <span>{localize(locale, "目标 Agent", "Target Agent")}</span>
              <select
                value={queueFilters.targetAgent}
                onChange={(event) => setQueueFilters((current) => ({ ...current, targetAgent: event.target.value }))}
              >
                <option value="">{localize(locale, "全部", "All")}</option>
                {queueTargetAgents.map((agent) => (
                  <option key={agent} value={agent}>
                    {agent}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{localize(locale, "分组维度", "Group By")}</span>
              <select
                value={queueFilters.groupBy}
                onChange={(event) =>
                  setQueueFilters((current) => ({
                    ...current,
                    groupBy: event.target.value as QueueFilters["groupBy"],
                  }))
                }
              >
                <option value="to_agent">{localize(locale, "按目标 Agent", "By Target Agent")}</option>
                <option value="handoff_state">{localize(locale, "按交接状态", "By Handoff State")}</option>
                <option value="message_type">{localize(locale, "按消息类型", "By Message Type")}</option>
              </select>
            </label>
          </div>
          <div className="hint-grid compact-hint-grid">
            {buildQueueLensThresholdCards(locale, handoffMetrics).map((item) => (
              <div key={item.label} className="hint-card">
                <strong>{item.value}</strong>
                <span>{item.label}</span>
                <span>{item.detail}</span>
              </div>
            ))}
          </div>
          <div className="hint-grid">
            {queueGroupCounts.length ? (
              queueGroupCounts.map((item) => (
                <div key={`${queueFilters.groupBy}:${item.label}`} className="hint-card">
                  <strong>{item.label}</strong>
                  <span>{localize(locale, `${item.count} 条交接`, `${item.count} handoffs`)}</span>
                </div>
              ))
            ) : (
              <div className="empty-state compact">{localize(locale, "当前过滤下没有交接记录。", "No handoffs under current filters.")}</div>
            )}
          </div>
        </section>

        <div className="two-column">
          <section className="page-card">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{t(locale, "trace.inboxEyebrow")}</div>
                <h2>{t(locale, "trace.inboxTitle")}</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(locale, "trace.fromAgent")}</th>
                  <th>{t(locale, "trace.toAgent")}</th>
                  <th>{t(locale, "trace.messageType")}</th>
                  <th>{locale === "zh-CN" ? "交接状态" : "Handoff"}</th>
                  <th>{t(locale, "trace.summary")}</th>
                  <th>{locale === "zh-CN" ? "动作" : "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {queueMessages.length ? (
                  queueMessages.map((message) => (
                    <tr key={message.message_id} onClick={() => setSelectedItem(makeTimelineSelection(makeMessageTimelineProxy(message), projectId, locale))}>
                      <td>{message.from_agent}</td>
                      <td>{message.to_agent}</td>
                      <td>{message.message_type}</td>
                      <td><StatusBadge value={message.handoff_state || message.status} locale={locale} /></td>
                      <td>{message.content}</td>
                      <td>
                        <div className="table-actions">
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={messageActionBusyId === message.message_id || message.status === "resolved"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleMessageAction(message.message_id, "mark-read");
                            }}
                          >
                            {localize(locale, "已读", "Read")}
                          </button>
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={messageActionBusyId === message.message_id || message.status === "resolved"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleMessageAction(message.message_id, "ack");
                            }}
                          >
                            {localize(locale, "确认", "Ack")}
                          </button>
                          <select
                            value={message.handoff_state || "queued"}
                            disabled={messageActionBusyId === message.message_id}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => void handleMessageAction(message.message_id, "handoff-state", event.target.value)}
                          >
                            <option value="queued">{handoffStateLabel(locale, "queued")}</option>
                            <option value="seen">{handoffStateLabel(locale, "seen")}</option>
                            <option value="accepted">{handoffStateLabel(locale, "accepted")}</option>
                            <option value="blocked">{handoffStateLabel(locale, "blocked")}</option>
                            <option value="completed">{handoffStateLabel(locale, "completed")}</option>
                          </select>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={6} className="empty-cell">{t(locale, "trace.noInbox")}</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="page-card">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{t(locale, "trace.inboxEyebrow")}</div>
                <h2>{localize(locale, "队友消息", "Teammate Messaging")}</h2>
              </div>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(locale, "trace.fromAgent")}</th>
                  <th>{t(locale, "trace.toAgent")}</th>
                  <th>{t(locale, "trace.messageType")}</th>
                  <th>{locale === "zh-CN" ? "交接状态" : "Handoff"}</th>
                  <th>{t(locale, "control.status")}</th>
                  <th>{locale === "zh-CN" ? "动作" : "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {teammateQueueMessages.length ? (
                  teammateQueueMessages.map((message) => (
                    <tr key={message.message_id} onClick={() => setSelectedItem(makeTimelineSelection(makeMessageTimelineProxy(message), projectId, locale))}>
                      <td>{message.from_agent}</td>
                      <td>{message.to_agent}</td>
                      <td>{message.message_type}</td>
                      <td><StatusBadge value={message.handoff_state || message.status} locale={locale} /></td>
                      <td><StatusBadge value={message.status} locale={locale} /></td>
                      <td>
                        <select
                          value={message.handoff_state || "queued"}
                          disabled={messageActionBusyId === message.message_id}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => void handleMessageAction(message.message_id, "handoff-state", event.target.value)}
                        >
                          <option value="queued">{handoffStateLabel(locale, "queued")}</option>
                          <option value="seen">{handoffStateLabel(locale, "seen")}</option>
                          <option value="accepted">{handoffStateLabel(locale, "accepted")}</option>
                          <option value="blocked">{handoffStateLabel(locale, "blocked")}</option>
                          <option value="completed">{handoffStateLabel(locale, "completed")}</option>
                        </select>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr><td colSpan={6} className="empty-cell">{t(locale, "trace.noTeammateMessages")}</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </div>

        <div className="two-column">
          <section className="page-card">
            <div className="page-card__header">
              <div><div className="eyebrow">{t(locale, "trace.outputsEyebrow")}</div><h2>{t(locale, "trace.outputsTitle")}</h2></div>
            </div>
            <div className="list-grid">
              {Object.values(data?.read_model.latest_artifacts || {}).length ? (
                Object.values(data?.read_model.latest_artifacts || {}).map((artifact) => (
                  <button key={artifact.artifact_id} type="button" className="list-card" onClick={() => setSelectedItem(makeTimelineSelection(makeArtifactTimelineProxy(artifact, locale), projectId, locale))}>
                    <strong>{artifact.artifact_type}</strong>
                    <span>{artifact.owner}</span>
                    <StatusBadge value={artifact.state} locale={locale} />
                  </button>
                ))
              ) : (
                <div className="empty-state compact">{t(locale, "trace.noArtifacts")}</div>
              )}
            </div>
          </section>

          <section className="page-card">
            <div className="page-card__header">
              <div><div className="eyebrow">{t(locale, "trace.packagesEyebrow")}</div><h2>{t(locale, "trace.packagesTitle")}</h2></div>
            </div>
            <div className="list-grid">
              {Object.values(data?.read_model.latest_packages || {}).length ? (
                Object.values(data?.read_model.latest_packages || {}).map((pkg) => (
                  <button key={pkg.package_id} type="button" className="list-card" onClick={() => setSelectedItem(makeTimelineSelection(makePackageTimelineProxy(pkg, locale), projectId, locale))}>
                    <strong>{pkg.package_type}</strong>
                    <span className="mono">{pkg.manifest_path}</span>
                    <StatusBadge value={pkg.state} locale={locale} />
                  </button>
                ))
              ) : (
                <div className="empty-state compact">{t(locale, "trace.noPackages")}</div>
              )}
            </div>
          </section>
        </div>

        <section className="page-card">
          <div className="page-card__header">
            <div><div className="eyebrow">{t(locale, "trace.timelineEyebrow")}</div><h2>{t(locale, "trace.timelineTitle")}</h2></div>
          </div>
          <div className="filters-row">
            <label className="field">
              <span>{t(locale, "trace.eventType")}</span>
              <select value={filters.eventType} onChange={(event) => setFilters((current) => ({ ...current, eventType: event.target.value }))}>
                <option value="">{t(locale, "trace.all")}</option>
                {(data?.read_model.filters.event_types || []).map((eventType) => <option key={eventType} value={eventType}>{eventType}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{t(locale, "control.status")}</span>
              <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
                <option value="">{t(locale, "trace.all")}</option>
                {(data?.read_model.filters.statuses || []).map((status) => (
                  <option key={status} value={status}>
                    {translateStatus(locale, status)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t(locale, "trace.owner")}</span>
              <select value={filters.ownerAgent} onChange={(event) => setFilters((current) => ({ ...current, ownerAgent: event.target.value }))}>
                <option value="">{t(locale, "trace.all")}</option>
                {(data?.read_model.filters.owner_agents || []).map((ownerAgent) => <option key={ownerAgent} value={ownerAgent}>{ownerAgent}</option>)}
              </select>
            </label>
            <label className="field field--grow">
              <span>{t(locale, "trace.search")}</span>
              <input value={filters.query} onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))} placeholder={t(locale, "trace.searchPlaceholder")} />
            </label>
          </div>
          <table className="data-table timeline-table">
            <thead>
              <tr>
                <th>{t(locale, "trace.time")}</th>
                <th>{t(locale, "trace.kind")}</th>
                <th>{t(locale, "trace.owner")}</th>
                <th>{t(locale, "control.status")}</th>
                <th>{t(locale, "trace.summary")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredTimeline.length ? (
                filteredTimeline.map((item) => (
                  <tr key={`${item.kind}:${item.id}`} onClick={() => setSelectedItem(makeTimelineSelection(item, projectId, locale))}>
                    <td className="mono">{formatTimestamp(item.timestamp, locale)}</td>
                    <td>{translateTimelineKind(item.kind, locale)}</td>
                    <td>{item.owner_agent || "-"}</td>
                    <td><StatusBadge value={item.status} locale={locale} /></td>
                    <td>{item.summary}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan={5} className="empty-cell">{t(locale, "trace.noTimeline")}</td></tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="page-card">
          <div className="page-card__header">
            <div><div className="eyebrow">{t(locale, "trace.ruleEyebrow")}</div><h2>{t(locale, "trace.ruleTitle")}</h2></div>
          </div>
          <div className="hint-grid">
            <div className="hint-card"><strong>{t(locale, "trace.latestEvent")}</strong><span>{data?.summary.latest_event_type || t(locale, "trace.none")}</span></div>
            <div className="hint-card"><strong>{t(locale, "trace.reviewerLoop")}</strong><span>{t(locale, "trace.reviewerLoopCopy")}</span></div>
            <div className="hint-card"><strong>{t(locale, "trace.contract")}</strong><span>{t(locale, "trace.contractCopy")}</span></div>
          </div>
        </section>
      </div>

      <DetailDrawer
        open={Boolean(selectedItem)}
        title={selectedItem?.title || null}
        payload={selectedItem?.payload}
        locale={locale}
        messageContext={
          selectedItem?.kind === "attach"
            ? {
                project_id: selectedItem.projectId || projectId,
                from_agent: "operator",
                to_agent: selectedItem.ownerAgent || "",
                message_type: "teammate_note",
              }
            : null
        }
        onSendMessage={
          selectedItem?.kind === "attach"
            ? async (payload) => handleSendMessage(selectedItem, payload)
            : undefined
        }
        messageBusy={messageBusy}
        messageError={messageError}
        messageSuccess={messageSuccess}
        onClose={() => {
          setSelectedItem(null);
          setMessageError(null);
          setMessageSuccess(null);
        }}
      />
    </div>
  );
}

function formatTimestamp(value: string, locale: Locale): string {
  return formatDateTime(locale, value);
}

function makeTimelineSelection(item: TimelineItem, projectId: string, locale: Locale): TraceSelection {
  return {
    kind: item.kind,
    title: `${translateTimelineKind(item.kind, locale)}: ${item.title}`,
    payload: item,
    taskId: extractTaskId(item),
    ownerAgent: item.owner_agent,
    projectId,
  };
}

function makeAttachSelection(payload: ControlActionResult, taskId: string, locale: Locale): TraceSelection {
  const ownerAgent = payload.task?.owner_agent || payload.execution_context?.owner_agent || null;
  return {
    kind: "attach",
    title: locale === "zh-CN" ? `附着上下文: ${taskId}` : `Attach Context: ${taskId}`,
    payload,
    taskId,
    ownerAgent,
    projectId: payload.task?.project_id || null,
  };
}

function extractTaskId(item: TimelineItem): string | null {
  if (item.kind === "task" || item.kind === "execution_context") {
    return item.id;
  }
  const details = item.details as Record<string, unknown>;
  return typeof details.task_id === "string" ? details.task_id : null;
}

function translateTimelineKind(kind: string, locale: Locale): string {
  const normalized = kind.trim().toLowerCase();
  if (locale === "zh-CN") {
    if (normalized === "task") {
      return "任务";
    }
    if (normalized === "agent_state") {
      return "Agent 状态";
    }
    if (normalized === "artifact") {
      return "工件";
    }
    if (normalized === "package") {
      return "包";
    }
    if (normalized === "event") {
      return "事件";
    }
    if (normalized === "message") {
      return "消息";
    }
    if (normalized === "worktree") {
      return "Worktree";
    }
    if (normalized === "execution_context") {
      return "执行上下文";
    }
    if (normalized === "completion_hook") {
      return "收口动作";
    }
  }
  if (normalized === "agent_state") {
    return "Agent State";
  }
  if (normalized === "execution_context") {
    return "Execution Context";
  }
  if (normalized === "completion_hook") {
    return "Completion Hook";
  }
  if (normalized === "worktree") {
    return "Worktree";
  }
  return kind;
}

function makeTaskTimelineProxy(task: TaskRecord, locale: Locale): TimelineItem {
  return {
    kind: "task",
    id: task.task_id,
    timestamp: task.updated_at,
    title: task.title,
    summary: t(locale, "trace.taskSummary", { owner: task.owner_agent, status: task.status }),
    status: task.status,
    owner: task.owner_agent,
    owner_agent: task.owner_agent,
    event_type: null,
    details: {
      scope: task.scope,
      dependency: task.dependency,
      acceptance: task.acceptance,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
  };
}

function makeAgentTimelineProxy(agent: AgentStateRecord, locale: Locale): TimelineItem {
  return {
    kind: "agent_state",
    id: `${agent.project_id}:${agent.agent_id}`,
    timestamp: agent.updated_at,
    title: agent.agent_id,
    summary: t(locale, "trace.agentStateSummary", { state: agent.state }),
    status: agent.state,
    owner: agent.agent_id,
    owner_agent: agent.agent_id,
    event_type: null,
    details: {
      current_task_id: agent.current_task_id,
      last_error: agent.last_error,
      last_heartbeat_at: agent.last_heartbeat_at,
      updated_at: agent.updated_at,
    },
  };
}

function makeArtifactTimelineProxy(artifact: ArtifactRecord, locale: Locale): TimelineItem {
  return {
    kind: "artifact",
    id: artifact.artifact_id,
    timestamp: artifact.updated_at,
    title: `${artifact.artifact_type} v${String(artifact.version)}`,
    summary: t(locale, "trace.artifactSummary", { owner: artifact.owner, state: artifact.state }),
    status: artifact.state,
    owner: artifact.owner,
    owner_agent: artifact.owner,
    event_type: null,
    details: artifact as unknown as Record<string, unknown>,
  };
}

function makeExecutionContextTimelineProxy(context: ExecutionContextRecord): TimelineItem {
  return {
    kind: "execution_context",
    id: context.task_id,
    timestamp: context.updated_at,
    title: `${context.owner_agent} execution context`,
    summary: `${context.runtime_kind} -> ${context.status}`,
    status: context.status,
    owner: context.owner_agent,
    owner_agent: context.owner_agent,
    event_type: null,
    details: {
      worktree_id: context.worktree_id,
      canonical_workspace_path: context.canonical_workspace_path,
      execution_workspace_path: context.execution_workspace_path,
      prepared_at: context.prepared_at,
      started_at: context.started_at,
      finished_at: context.finished_at,
      metadata: context.metadata,
    },
  };
}

function makeWorktreeTimelineProxy(worktree: WorktreeRecord): TimelineItem {
  return {
    kind: "worktree",
    id: worktree.worktree_id,
    timestamp: worktree.cleanup_at || worktree.released_at || worktree.activated_at || worktree.created_at,
    title: `${worktree.owner_agent} worktree`,
    summary: `${worktree.isolation_mode} -> ${worktree.status}`,
    status: worktree.status,
    owner: worktree.owner_agent,
    owner_agent: worktree.owner_agent,
    event_type: null,
    details: {
      task_id: worktree.task_id,
      branch_name: worktree.branch_name,
      canonical_workspace_path: worktree.canonical_workspace_path,
      worktree_path: worktree.worktree_path,
      created_at: worktree.created_at,
      activated_at: worktree.activated_at,
      released_at: worktree.released_at,
      cleanup_at: worktree.cleanup_at,
      metadata: worktree.metadata,
    },
  };
}

function makeHookTimelineProxy(hook: CompletionHookRecord): TimelineItem {
  return {
    kind: "completion_hook",
    id: hook.hook_id,
    timestamp: hook.completed_at || hook.updated_at,
    title: hook.hook_type,
    summary: `hook -> ${hook.status}`,
    status: hook.status,
    owner: "runtime",
    owner_agent: "runtime",
    event_type: null,
    details: {
      task_id: hook.task_id,
      created_at: hook.created_at,
      updated_at: hook.updated_at,
      completed_at: hook.completed_at,
      payload: hook.payload,
    },
  };
}

function makeMessageTimelineProxy(message: MessageRecord): TimelineItem {
  return {
    kind: "message",
    id: message.message_id,
    timestamp: message.updated_at || message.created_at,
    title: `${message.from_agent} -> ${message.to_agent}`,
    summary: `${message.message_type} / ${message.handoff_state || "queued"} / ${message.priority}`,
    status: message.status,
    owner: message.to_agent,
    owner_agent: message.to_agent,
    event_type: null,
    details: {
      from_agent: message.from_agent,
      to_agent: message.to_agent,
      message_type: message.message_type,
      priority: message.priority,
      handoff_state: message.handoff_state,
      artifact_ref: message.artifact_ref,
      content: message.content,
      created_at: message.created_at,
      updated_at: message.updated_at,
      read_at: message.read_at,
      acked_at: message.acked_at,
      resolved_at: message.resolved_at,
    },
  };
}

function makePackageTimelineProxy(pkg: PackageRecord, locale: Locale): TimelineItem {
  return {
    kind: "package",
    id: pkg.package_id,
    timestamp: pkg.created_at,
    title: `${pkg.package_type} v${String(pkg.version)}`,
    summary: t(locale, "trace.packageSummary", { state: pkg.state }),
    status: pkg.state,
    owner: "runtime",
    owner_agent: "runtime",
    event_type: null,
    details: pkg as unknown as Record<string, unknown>,
  };
}

function formatCompactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-4).join("/") || normalized;
}

function applyQueueFilters(messages: MessageRecord[], filters: QueueFilters): MessageRecord[] {
  return messages.filter((message) => {
    if (filters.handoffState && (message.handoff_state || "queued") !== filters.handoffState) {
      return false;
    }
    if (filters.targetAgent && message.to_agent !== filters.targetAgent) {
      return false;
    }
    return true;
  });
}

function groupMessages(
  messages: MessageRecord[],
  field: QueueFilters["groupBy"],
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const label =
      field === "handoff_state"
        ? message.handoff_state || "queued"
        : field === "message_type"
          ? message.message_type
          : message.to_agent;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function uniqueMessageValues(messages: MessageRecord[], field: "to_agent"): string[] {
  return Array.from(new Set(messages.map((message) => message[field]).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function localize(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function handoffStateLabel(locale: Locale, value: string): string {
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

function buildOperatorBacklogCards(
  locale: Locale,
  metrics: HandoffMetrics | null,
): Array<{ label: string; value: string }> {
  return [
    {
      label: localize(locale, "阻塞交接", "Blocked handoffs"),
      value: String(metrics?.blocked_count ?? 0),
    },
    {
      label: localize(locale, "超时 Pending", "Timed-out pending"),
      value: String(metrics?.aged_pending_count ?? 0),
    },
    {
      label: localize(locale, "未确认", "Unacked"),
      value: String(metrics?.unacked_count ?? 0),
    },
    {
      label: localize(locale, "最久 Pending", "Oldest pending"),
      value: formatAge(locale, metrics?.oldest_pending_age_seconds),
    },
  ];
}

function buildQueueLensThresholdCards(
  locale: Locale,
  metrics: HandoffMetrics | null,
): Array<{ label: string; value: string; detail: string }> {
  return [
    {
      label: localize(locale, "Pending SLA", "Pending SLA"),
      value: formatAge(locale, metrics?.pending_timeout_seconds),
      detail: localize(
        locale,
        `超时计入 timed-out pending`,
        `Used for timed-out pending classification`,
      ),
    },
    {
      label: localize(locale, "Blocked SLA", "Blocked SLA"),
      value: formatAge(locale, metrics?.blocked_timeout_seconds),
      detail: localize(
        locale,
        `超时升级 agent SLA`,
        `Used to escalate the agent SLA to blocked`,
      ),
    },
  ];
}

function formatAgentSlaSummary(locale: Locale, agent: AgentSlaRecord): string {
  return localize(
    locale,
    `Open ${agent.open_count} / 阻塞 ${agent.blocked_count} / 超时 ${agent.aged_pending_count}`,
    `Open ${agent.open_count} / blocked ${agent.blocked_count} / timed-out ${agent.aged_pending_count}`,
  );
}

function formatAgentSlaAges(locale: Locale, agent: AgentSlaRecord): string {
  return localize(
    locale,
    `最久 Pending ${formatAge(locale, agent.oldest_pending_age_seconds)} / 平均 ${formatAge(locale, agent.avg_pending_age_seconds)}`,
    `Oldest pending ${formatAge(locale, agent.oldest_pending_age_seconds)} / avg ${formatAge(locale, agent.avg_pending_age_seconds)}`,
  );
}
