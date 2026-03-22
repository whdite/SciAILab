import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  ClipboardCheck,
  GitMerge,
  HardDriveDownload,
  LoaderCircle,
  RefreshCcw,
  Sparkles,
  Trash2,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  createAgentWorkspaceMessage,
  fetchAgentWorkspaceOverview,
  fetchAgentWorkspaceThread,
  runAgentWorkspaceAction,
  uploadAgentWorkspaceFile,
} from "../api";
import { StatusBadge } from "../components/status-badge";
import { AgentChatComposer } from "../components/ui/agent-chat-composer";
import { formatDateTime, type Locale } from "../i18n";
import type {
  AgentThreadAttachmentRecord,
  AgentThreadMessageRecord,
  AgentWorkspaceContext,
  AgentWorkspaceOverviewItem,
  AgentWorkspaceOverviewResponse,
  AgentWorkspaceThreadResponse,
} from "../types";

type AgentsPageProps = {
  apiBaseUrl: string;
  projectId: string;
  refreshToken: number;
  autoRefreshSeconds: number;
  locale: Locale;
};

type FilterState = "all" | "active" | "blocked" | "waiting" | "idle";
type ComposerMode = "chat" | "command" | "mixed";
type ContextTab = "overview" | "actions" | "handoff" | "history" | "outputs";

const DEFAULT_FILTER: FilterState = "all";

function localize(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function parseMentions(content: string): Array<{ kind: string; value: string; label: string }> {
  const matches = content.matchAll(/@([^\s]+)/g);
  const mentions: Array<{ kind: string; value: string; label: string }> = [];
  for (const match of matches) {
    const token = (match[1] || "").trim();
    if (!token) {
      continue;
    }
    if (token.startsWith("artifact:")) {
      mentions.push({ kind: "artifact_ref", value: token.slice("artifact:".length), label: token });
      continue;
    }
    if (token.startsWith("package:")) {
      mentions.push({ kind: "package_ref", value: token.slice("package:".length), label: token });
      continue;
    }
    if (token.startsWith("task:")) {
      mentions.push({ kind: "task_ref", value: token.slice("task:".length), label: token });
      continue;
    }
    mentions.push({ kind: "workspace_file_ref", value: token, label: token });
  }
  return mentions;
}

function inferIntent(mode: ComposerMode, content: string): string {
  if (mode === "command" || content.trim().startsWith("/")) {
    return "request_action";
  }
  return "chat";
}

function summarizeAgent(locale: Locale, item: AgentWorkspaceOverviewItem): string {
  return localize(
    locale,
    `交接 ${item.open_handoffs} / 阻塞 ${item.blocked_handoffs} / 超时 ${item.timed_out_pending_handoffs}`,
    `Open ${item.open_handoffs} / blocked ${item.blocked_handoffs} / timed-out ${item.timed_out_pending_handoffs}`,
  );
}

function matchesFilter(item: AgentWorkspaceOverviewItem, filter: FilterState): boolean {
  if (filter === "all") {
    return true;
  }
  const state = item.state.toLowerCase();
  if (filter === "active") {
    return ["executing", "planning", "review_pending"].includes(state);
  }
  if (filter === "blocked") {
    return state === "blocked" || item.blocked_handoffs > 0 || item.sla_status === "blocked";
  }
  if (filter === "waiting") {
    return state === "waiting_input" || item.open_handoffs > 0;
  }
  return state === "idle";
}

function attachmentLabel(locale: Locale, attachment: AgentThreadAttachmentRecord): string {
  const name = attachment.name || attachment.path || localize(locale, "未命名附件", "Untitled attachment");
  if (attachment.attachment_type === "image") {
    return localize(locale, `图片 ${name}`, `Image ${name}`);
  }
  if (attachment.attachment_type.endsWith("_ref")) {
    return localize(locale, `引用 ${name}`, `Reference ${name}`);
  }
  return localize(locale, `文件 ${name}`, `File ${name}`);
}

function messageTitle(locale: Locale, message: AgentThreadMessageRecord): string {
  if (message.sender_type === "operator") {
    return localize(locale, "操作员", "Operator");
  }
  if (message.sender_type === "agent") {
    return message.agent_id;
  }
  if (message.message_type === "control_result") {
    return localize(locale, "控制动作回执", "Control Result");
  }
  return localize(locale, "系统", "System");
}

function messageMeta(locale: Locale, message: AgentThreadMessageRecord): string[] {
  const tags: string[] = [];
  if (message.input_mode) {
    tags.push(message.input_mode);
  }
  if (message.intent) {
    tags.push(message.intent);
  }
  if (message.task_id) {
    tags.push(localize(locale, `任务 ${message.task_id}`, `Task ${message.task_id}`));
  }
  if (message.execution_context_task_id) {
    tags.push(localize(locale, `上下文 ${message.execution_context_task_id}`, `Context ${message.execution_context_task_id}`));
  }
  return tags;
}

type MessageBubbleKind = "operator" | "agent-output" | "handoff" | "system-status";

function formatArtifactTypeForBubble(locale: Locale, value: unknown): string {
  const artifactType = String(value || "").toLowerCase();
  const map: Record<string, { zh: string; en: string }> = {
    draft: { zh: "草稿", en: "Draft" },
    review_report: { zh: "评审报告", en: "Review report" },
    results_summary: { zh: "实验摘要", en: "Results summary" },
    hypotheses: { zh: "假设包", en: "Hypotheses" },
  };
  const resolved = map[artifactType];
  return resolved ? localize(locale, resolved.zh, resolved.en) : artifactType || localize(locale, "产物", "Artifact");
}

function formatPackageTypeForBubble(locale: Locale, value: unknown): string {
  const packageType = String(value || "").toLowerCase();
  const map: Record<string, { zh: string; en: string }> = {
    execution_checkpoint: { zh: "执行快照", en: "Execution checkpoint" },
    merge_bundle: { zh: "合并包", en: "Merge bundle" },
    writing_input_package: { zh: "写作输入包", en: "Writing input package" },
    experiment_bundle: { zh: "实验包", en: "Experiment bundle" },
    research_package: { zh: "研究包", en: "Research package" },
  };
  const resolved = map[packageType];
  return resolved ? localize(locale, resolved.zh, resolved.en) : packageType || localize(locale, "数据包", "Package");
}

function resolveMessageBubbleKind(message: AgentThreadMessageRecord): MessageBubbleKind {
  const source = String(message.metadata?.source || "");
  if (message.sender_type === "operator") {
    return "operator";
  }
  if (message.sender_type === "agent") {
    return "agent-output";
  }
  if (source === "derived_artifact") {
    return "agent-output";
  }
  if (source === "derived_handoff") {
    return "handoff";
  }
  return "system-status";
}

function formatMessageEyebrow(locale: Locale, message: AgentThreadMessageRecord): string {
  const kind = resolveMessageBubbleKind(message);
  if (kind === "operator") {
    return localize(locale, "你的消息", "Your message");
  }
  if (kind === "agent-output") {
    return localize(locale, "Agent 输出", "Agent output");
  }
  if (kind === "handoff") {
    return localize(locale, "交接消息", "Handoff");
  }
  return localize(locale, "系统状态", "System status");
}

function formatMessageTitle(locale: Locale, message: AgentThreadMessageRecord): string {
  const kind = resolveMessageBubbleKind(message);
  if (kind === "operator") {
    return localize(locale, "你", "You");
  }
  if (kind === "agent-output") {
    return localize(locale, `${message.agent_id} 已完成输出`, `${message.agent_id} finished output`);
  }
  if (kind === "handoff") {
    const fromAgent = String(message.metadata?.from_agent || "");
    const toAgent = String(message.metadata?.to_agent || "");
    const direction = String(message.metadata?.handoff_direction || "");
    if (direction === "incoming" && fromAgent) {
      return localize(locale, `${fromAgent} 发来交接`, `${fromAgent} sent a handoff`);
    }
    if (direction === "outgoing" && toAgent) {
      return localize(locale, `已交接给 ${toAgent}`, `Handed off to ${toAgent}`);
    }
    return localize(locale, "任务交接", "Task handoff");
  }
  if (message.message_type === "control_result") {
    return localize(locale, "控制动作回执", "Control result");
  }
  return localize(locale, "系统运行状态", "System status");
}

function formatMessageContent(locale: Locale, message: AgentThreadMessageRecord): string {
  const source = String(message.metadata?.source || "");
  if (source === "derived_artifact") {
    const artifactType = formatArtifactTypeForBubble(locale, message.metadata?.artifact_type);
    const version = message.metadata?.version;
    const suffix = version !== undefined && version !== null && String(version) !== "" ? ` v${String(version)}` : "";
    return localize(
      locale,
      `我已产出${artifactType}${suffix}，可继续进入下一步。`,
      `${artifactType}${suffix} is ready for the next step.`,
    );
  }
  if (source === "derived_package") {
    const packageType = formatPackageTypeForBubble(locale, message.metadata?.package_type);
    const version = message.metadata?.version;
    const suffix = version !== undefined && version !== null && String(version) !== "" ? ` v${String(version)}` : "";
    return localize(
      locale,
      `系统已冻结${packageType}${suffix}，当前执行快照已归档。`,
      `${packageType}${suffix} has been frozen and archived.`,
    );
  }
  if (source === "derived_handoff") {
    const direction = String(message.metadata?.handoff_direction || "");
    if (direction === "incoming") {
      return localize(locale, `收到交接：${message.content}`, `Incoming handoff: ${message.content}`);
    }
    if (direction === "outgoing") {
      return localize(locale, `已发送交接：${message.content}`, `Sent handoff: ${message.content}`);
    }
  }
  if (message.message_type === "control_result") {
    return localize(locale, `控制台操作已执行：${message.content}`, `Control action completed: ${message.content}`);
  }
  return message.content;
}

function formatMessageMeta(locale: Locale, message: AgentThreadMessageRecord): string[] {
  const tags: string[] = [];
  const kind = resolveMessageBubbleKind(message);
  if (kind === "agent-output") {
    tags.push(localize(locale, "产出更新", "Output update"));
  } else if (kind === "handoff") {
    tags.push(localize(locale, "交接流", "Handoff"));
  } else if (kind === "system-status") {
    tags.push(localize(locale, "运行状态", "Runtime"));
  }
  if (message.message_type === "artifact_update") {
    tags.push(formatArtifactTypeForBubble(locale, message.metadata?.artifact_type));
  }
  if (message.message_type === "package_update") {
    tags.push(formatPackageTypeForBubble(locale, message.metadata?.package_type));
  }
  if (message.task_id) {
    tags.push(localize(locale, `任务 ${message.task_id}`, `Task ${message.task_id}`));
  }
  if (message.execution_context_task_id) {
    tags.push(localize(locale, `上下文 ${message.execution_context_task_id}`, `Context ${message.execution_context_task_id}`));
  }
  return tags;
}

function actionFeedback(locale: Locale, actionType: string): string {
  const actionMap: Record<string, { zh: string; en: string }> = {
    attach: { zh: "已附着执行上下文。", en: "Execution context attached." },
    checkpoint: { zh: "已创建 checkpoint。", en: "Checkpoint created." },
    merge: { zh: "已触发 merge。", en: "Merge triggered." },
    cleanup: { zh: "已触发 cleanup。", en: "Cleanup triggered." },
    retry: { zh: "任务已标记为 retry。", en: "Task marked as retry." },
    mark_blocked: { zh: "任务已标记为 blocked。", en: "Task marked as blocked." },
    handoff: { zh: "已创建 handoff。", en: "Handoff created." },
  };
  const copy = actionMap[actionType] || { zh: "动作已执行。", en: "Action executed." };
  return localize(locale, copy.zh, copy.en);
}

function attachmentKey(item: AgentThreadAttachmentRecord, index: number): string {
  return `${item.path || item.name || item.attachment_type || "attachment"}-${index}`;
}

function mergeThreadMessages(
  current: AgentThreadMessageRecord[],
  incoming: AgentThreadMessageRecord[],
): AgentThreadMessageRecord[] {
  const merged = new Map<string, AgentThreadMessageRecord>();
  for (const item of current) {
    merged.set(item.message_id, item);
  }
  for (const item of incoming) {
    merged.set(item.message_id, item);
  }
  return Array.from(merged.values()).sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.message_id.localeCompare(right.message_id);
  });
}

function contextValue(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function AgentsPage({
  apiBaseUrl,
  projectId,
  refreshToken,
  autoRefreshSeconds,
  locale,
}: AgentsPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [overview, setOverview] = useState<AgentWorkspaceOverviewResponse | null>(null);
  const [threadView, setThreadView] = useState<AgentWorkspaceThreadResponse | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER);
  const [query, setQuery] = useState("");
  const [composerMode, setComposerMode] = useState<ComposerMode>("mixed");
  const [contextTab, setContextTab] = useState<ContextTab>("overview");
  const [composerText, setComposerText] = useState("");
  const [taskIdDraft, setTaskIdDraft] = useState("");
  const [executionContextDraft, setExecutionContextDraft] = useState("");
  const [handoffTarget, setHandoffTarget] = useState("");
  const [handoffContent, setHandoffContent] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<AgentThreadAttachmentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const effectiveProjectId = projectId.trim();

  async function loadOverview(preferredAgentId?: string): Promise<AgentWorkspaceOverviewResponse | null> {
    if (!effectiveProjectId) {
      setOverview(null);
      setSelectedAgentId("");
      return null;
    }
    const nextOverview = await fetchAgentWorkspaceOverview(effectiveProjectId, 80, apiBaseUrl);
    setOverview(nextOverview);
    const chosenAgentId =
      preferredAgentId && nextOverview.agents.some((item) => item.agent_id === preferredAgentId)
        ? preferredAgentId
        : selectedAgentId && nextOverview.agents.some((item) => item.agent_id === selectedAgentId)
          ? selectedAgentId
          : nextOverview.agents[0]?.agent_id || "";
    setSelectedAgentId(chosenAgentId);
    return nextOverview;
  }

  async function loadThread(agentId: string): Promise<AgentWorkspaceThreadResponse | null> {
    if (!effectiveProjectId || !agentId) {
      setThreadView(null);
      return null;
    }
    const nextThread = await fetchAgentWorkspaceThread(effectiveProjectId, agentId, 120, apiBaseUrl);
    setThreadView(nextThread);
    if (!taskIdDraft) {
      setTaskIdDraft(nextThread.context.current_task?.task_id || "");
    }
    if (!executionContextDraft) {
      setExecutionContextDraft(nextThread.context.execution_context?.task_id || "");
    }
    return nextThread;
  }

  async function reloadAll(agentId?: string): Promise<void> {
    const nextOverview = await loadOverview(agentId);
    const resolvedAgentId =
      agentId ||
      nextOverview?.agents.find((item) => item.agent_id === selectedAgentId)?.agent_id ||
      nextOverview?.agents[0]?.agent_id ||
      "";
    if (resolvedAgentId) {
      await loadThread(resolvedAgentId);
    } else {
      setThreadView(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!effectiveProjectId) {
      setOverview(null);
      setThreadView(null);
      setError(null);
      return;
    }
    const run = async () => {
      setLoading(true);
      try {
        const nextOverview = await fetchAgentWorkspaceOverview(effectiveProjectId, 80, apiBaseUrl);
        if (cancelled) {
          return;
        }
        setOverview(nextOverview);
        const nextAgentId =
          selectedAgentId && nextOverview.agents.some((item) => item.agent_id === selectedAgentId)
            ? selectedAgentId
            : nextOverview.agents[0]?.agent_id || "";
        setSelectedAgentId(nextAgentId);
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
    void run();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, effectiveProjectId, refreshToken]);

  useEffect(() => {
    let cancelled = false;
    if (!effectiveProjectId || !selectedAgentId) {
      setThreadView(null);
      return;
    }
    const run = async () => {
      setThreadLoading(true);
      try {
        const nextThread = await fetchAgentWorkspaceThread(effectiveProjectId, selectedAgentId, 120, apiBaseUrl);
        if (cancelled) {
          return;
        }
        setThreadView(nextThread);
        setTaskIdDraft((current) => current || nextThread.context.current_task?.task_id || "");
        setExecutionContextDraft((current) => current || nextThread.context.execution_context?.task_id || "");
        setError(null);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (!cancelled) {
          setThreadLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, effectiveProjectId, selectedAgentId]);

  useEffect(() => {
    if (!effectiveProjectId || autoRefreshSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      const activeAgentId = selectedAgentId;
      void loadOverview(activeAgentId)
        .then(() => {
          if (activeAgentId) {
            return loadThread(activeAgentId);
          }
          return null;
        })
        .catch((nextError) => {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        });
    }, Math.max(autoRefreshSeconds, 10) * 1000);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, autoRefreshSeconds, effectiveProjectId, selectedAgentId]);

  const agents =
    overview?.agents.filter((item) => {
      if (!matchesFilter(item, filter)) {
        return false;
      }
      if (!query.trim()) {
        return true;
      }
      const haystack = [
        item.agent_id,
        item.role,
        item.state,
        item.current_task_id,
        item.current_task_title,
        item.provider,
        item.model,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    }) || [];

  const selectedAgent = overview?.agents.find((item) => item.agent_id === selectedAgentId) || null;
  const context = threadView?.context || null;

  async function handleUpload(files: FileList | null): Promise<void> {
    if (!files?.length || !effectiveProjectId || !selectedAgentId) {
      return;
    }
    setUploading(true);
    setFeedback(null);
    setError(null);
    try {
      const nextItems: AgentThreadAttachmentRecord[] = [];
      for (const file of Array.from(files)) {
        const uploaded = await uploadAgentWorkspaceFile(effectiveProjectId, selectedAgentId, file, apiBaseUrl);
        nextItems.push(uploaded);
      }
      setPendingAttachments((current) => [...current, ...nextItems]);
      setFeedback(localize(locale, "附件已加入待发送队列。", "Attachments queued for send."));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleSendMessage(): Promise<void> {
    if (!effectiveProjectId || !selectedAgentId) {
      return;
    }
    if (!composerText.trim() && pendingAttachments.length === 0) {
      setError(localize(locale, "请输入消息或先上传附件。", "Enter a message or upload an attachment."));
      return;
    }
    setSending(true);
    setFeedback(null);
    setError(null);
    try {
      const mentions = parseMentions(composerText);
      const created = await createAgentWorkspaceMessage(
        selectedAgentId,
        {
          project_id: effectiveProjectId,
          content: composerText.trim(),
          input_mode: composerMode,
          intent: inferIntent(composerMode, composerText),
          task_id: taskIdDraft.trim() || undefined,
          execution_context_task_id: executionContextDraft.trim() || undefined,
          attachments: pendingAttachments.map((item) => ({
            attachment_type: item.attachment_type,
            name: item.name,
            path: item.path,
            mime_type: item.mime_type,
            size_bytes: item.size_bytes,
            metadata: item.metadata,
          })),
          mentions,
          metadata: {
            client_surface: "agent_workspace",
          },
        },
        apiBaseUrl,
      );
      setThreadView((current) => {
        if (!current || current.agent_id !== selectedAgentId || current.project_id !== effectiveProjectId) {
          return current;
        }
        const incoming = [created.message];
        if (created.reply?.message) {
          incoming.push(created.reply.message);
        }
        return {
          ...current,
          thread: created.reply?.thread || created.thread,
          messages: mergeThreadMessages(current.messages, incoming),
        };
      });
      setComposerText("");
      setPendingAttachments([]);
      await reloadAll(selectedAgentId);
      setFeedback(localize(locale, "消息已写入 Agent 线程。", "Message added to agent workspace thread."));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSending(false);
    }
  }

  function handleInsertReference(text: string): void {
    setComposerText((current) => `${current}${text}`);
  }

  async function handleAction(actionType: string): Promise<void> {
    if (!effectiveProjectId || !selectedAgentId) {
      return;
    }
    setActionBusy(actionType);
    setFeedback(null);
    setError(null);
    try {
      await runAgentWorkspaceAction(
        selectedAgentId,
        {
          project_id: effectiveProjectId,
          task_id: taskIdDraft.trim() || undefined,
          action_type: actionType,
        },
        apiBaseUrl,
      );
      await reloadAll(selectedAgentId);
      setFeedback(actionFeedback(locale, actionType));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleHandoff(): Promise<void> {
    if (!effectiveProjectId || !selectedAgentId) {
      return;
    }
    if (!handoffTarget.trim()) {
      setError(localize(locale, "请先填写目标 Agent。", "Enter a handoff target agent."));
      return;
    }
    setActionBusy("handoff");
    setFeedback(null);
    setError(null);
    try {
      await runAgentWorkspaceAction(
        selectedAgentId,
        {
          project_id: effectiveProjectId,
          task_id: taskIdDraft.trim() || undefined,
          action_type: "handoff",
          payload: {
            to_agent: handoffTarget.trim(),
            content:
              handoffContent.trim() ||
              localize(locale, `来自 ${selectedAgentId} 的人工 handoff`, `Operator handoff from ${selectedAgentId}`),
          },
        },
        apiBaseUrl,
      );
      setHandoffContent("");
      await reloadAll(selectedAgentId);
      setFeedback(actionFeedback(locale, "handoff"));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleManualRefresh(): Promise<void> {
    if (!effectiveProjectId) {
      return;
    }
    setLoading(true);
    setThreadLoading(Boolean(selectedAgentId));
    setError(null);
    try {
      await reloadAll(selectedAgentId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
      setThreadLoading(false);
    }
  }

  function renderActionButton(actionType: string, labelZh: string, labelEn: string, icon: React.ReactNode) {
    const busy = actionBusy === actionType;
    return (
      <button
        type="button"
        className="ghost-button agent-context-action"
        onClick={() => void handleAction(actionType)}
        disabled={Boolean(actionBusy)}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : icon}
        <span>{localize(locale, labelZh, labelEn)}</span>
      </button>
    );
  }

  function renderContextCard(nextContext: AgentWorkspaceContext | null) {
    if (!nextContext) {
      return <div className="empty-state compact">{localize(locale, "等待上下文加载。", "Waiting for context.")}</div>;
    }

    const tabs: Array<{ key: ContextTab; zh: string; en: string }> = [
      { key: "overview", zh: "概览", en: "Overview" },
      { key: "actions", zh: "控制", en: "Actions" },
      { key: "handoff", zh: "交接", en: "Handoff" },
      { key: "history", zh: "历史", en: "History" },
      { key: "outputs", zh: "产出", en: "Outputs" },
    ];

    return (
      <section className="page-card agent-context-card agent-context-card--tabbed">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{localize(locale, "右侧面板", "Side Panel")}</div>
            <h2>{localize(locale, "线程上下文", "Thread Context")}</h2>
          </div>
          <Sparkles size={18} />
        </div>

        <div className="agent-context-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`tab-button ${contextTab === tab.key ? "active" : ""}`}
              onClick={() => setContextTab(tab.key)}
            >
              {localize(locale, tab.zh, tab.en)}
            </button>
          ))}
        </div>

        {contextTab === "overview" ? (
          <div className="agent-context-grid">
            <div className="hint-card">
              <span>{localize(locale, "Agent 状态", "Agent State")}</span>
              <strong>{contextValue(nextContext.agent_state?.state, localize(locale, "未知", "Unknown"))}</strong>
              <span>
                {nextContext.agent_state?.updated_at
                  ? formatDateTime(locale, nextContext.agent_state.updated_at)
                  : localize(locale, "暂无时间戳", "No timestamp")}
              </span>
            </div>
            <div className="hint-card">
              <span>{localize(locale, "当前任务", "Current Task")}</span>
              <strong>{nextContext.current_task?.title || localize(locale, "未绑定", "Unbound")}</strong>
              <span className="mono">{nextContext.current_task?.task_id || "-"}</span>
            </div>
            <div className="hint-card">
              <span>{localize(locale, "执行上下文", "Execution Context")}</span>
              <strong>{contextValue(nextContext.execution_context?.status, localize(locale, "无", "None"))}</strong>
              <span className="mono">{contextValue(nextContext.execution_context?.execution_workspace_path, "-")}</span>
            </div>
            <div className="hint-card">
              <span>{localize(locale, "Git Worktree", "Git Worktree")}</span>
              <strong>{contextValue(nextContext.worktree?.status, localize(locale, "无", "None"))}</strong>
              <span className="mono">{nextContext.worktree?.branch_name || nextContext.worktree?.worktree_id || "-"}</span>
            </div>
            <div className="hint-card">
              <span>{localize(locale, "模型路由", "Model Routing")}</span>
              <strong>{nextContext.route?.provider || "-"}</strong>
              <span className="mono">
                {[nextContext.route?.model, nextContext.route?.auth_profile].filter(Boolean).join(" / ") || "-"}
              </span>
            </div>
            <div className="hint-card">
              <span>{localize(locale, "项目", "Project")}</span>
              <strong>{nextContext.project.name}</strong>
              <span className="mono">{nextContext.project.project_id}</span>
            </div>
          </div>
        ) : null}

        {contextTab === "actions" ? (
          <div className="agent-context-pane">
            <div className="agent-context-actions">
              {renderActionButton("attach", "附着", "Attach", <HardDriveDownload size={16} />)}
              {renderActionButton("checkpoint", "Checkpoint", "Checkpoint", <ClipboardCheck size={16} />)}
              {renderActionButton("merge", "Merge", "Merge", <GitMerge size={16} />)}
              {renderActionButton("cleanup", "Cleanup", "Cleanup", <Trash2 size={16} />)}
              {renderActionButton("retry", "Retry", "Retry", <RefreshCcw size={16} />)}
              {renderActionButton("mark_blocked", "标记阻塞", "Mark Blocked", <Wrench size={16} />)}
            </div>

            <div className="agent-inline-fields">
              <label className="field">
                <span>{localize(locale, "任务 ID", "Task ID")}</span>
                <input value={taskIdDraft} onChange={(event) => setTaskIdDraft(event.target.value)} placeholder="task_..." />
              </label>
              <label className="field">
                <span>{localize(locale, "执行上下文任务 ID", "Execution Context Task ID")}</span>
                <input
                  value={executionContextDraft}
                  onChange={(event) => setExecutionContextDraft(event.target.value)}
                  placeholder="task_..."
                />
              </label>
            </div>
          </div>
        ) : null}

        {contextTab === "handoff" ? (
          <div className="agent-context-pane">
            <div className="agent-inline-fields">
              <label className="field">
                <span>{localize(locale, "目标 Agent", "Target Agent")}</span>
                <input value={handoffTarget} onChange={(event) => setHandoffTarget(event.target.value)} placeholder="reviewer" />
              </label>
              <label className="field field--full">
                <span>{localize(locale, "交接说明", "Handoff Note")}</span>
                <textarea
                  value={handoffContent}
                  onChange={(event) => setHandoffContent(event.target.value)}
                  placeholder={localize(locale, "补充当前进度、阻塞点和下一步建议。", "Add progress, blockers, and the next suggested step.")}
                />
              </label>
            </div>

            <button type="button" className="primary-button" onClick={() => void handleHandoff()} disabled={Boolean(actionBusy)}>
              {actionBusy === "handoff" ? <LoaderCircle size={16} className="spin" /> : <ArrowRightLeft size={16} />}
              <span>{localize(locale, "创建 Handoff", "Create Handoff")}</span>
            </button>
          </div>
        ) : null}

        {contextTab === "history" ? (
          <div className="agent-side-list">
            {nextContext.recent_actions.length ? (
              nextContext.recent_actions.slice(0, 6).map((item) => (
                <article key={item.action_id} className="agent-side-list__item">
                  <div className="agent-side-list__header">
                    <strong>{item.action_type}</strong>
                    <StatusBadge value={item.status} locale={locale} />
                  </div>
                  <span className="mono">{item.task_id || "-"}</span>
                  <span>{formatDateTime(locale, item.created_at)}</span>
                </article>
              ))
            ) : (
              <div className="empty-state compact">{localize(locale, "暂无控制动作记录。", "No actions yet.")}</div>
            )}
          </div>
        ) : null}

        {contextTab === "outputs" ? (
          <div className="agent-side-list">
            {nextContext.recent_handoffs.slice(0, 3).map((item) => (
              <article key={item.message_id} className="agent-side-list__item">
                <div className="agent-side-list__header">
                  <strong>{item.to_agent}</strong>
                  <StatusBadge value={item.handoff_state || item.status} locale={locale} />
                </div>
                <span>{item.content}</span>
                <span>{formatDateTime(locale, item.created_at)}</span>
              </article>
            ))}

            {nextContext.recent_artifacts.slice(0, 2).map((item) => (
              <article key={item.artifact_id} className="agent-side-list__item">
                <div className="agent-side-list__header">
                  <strong>{item.artifact_type}</strong>
                  <StatusBadge value={item.state} locale={locale} />
                </div>
                <span className="mono">{item.path}</span>
                <span>{item.owner}</span>
              </article>
            ))}

            {nextContext.recent_packages.slice(0, 2).map((item) => (
              <article key={item.package_id} className="agent-side-list__item">
                <div className="agent-side-list__header">
                  <strong>{item.package_type}</strong>
                  <StatusBadge value={item.state} locale={locale} />
                </div>
                <span className="mono">{item.manifest_path}</span>
                <span>{formatDateTime(locale, item.created_at)}</span>
              </article>
            ))}

            {!nextContext.recent_handoffs.length && !nextContext.recent_artifacts.length && !nextContext.recent_packages.length ? (
              <div className="empty-state compact">
                {localize(locale, "暂无最近交接、产物或包记录。", "No recent handoffs, artifacts, or packages.")}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className="page-layout single-column agent-page-shell">
      <section className="page-card agent-page-topbar">
        <div>
          <div className="eyebrow">{localize(locale, "Agent Workspace", "Agent Workspace")}</div>
          <h1>{localize(locale, "Agent 对话工作台", "Agent Conversation Workspace")}</h1>
          <p className="muted-copy agent-page-topbar__copy">
            {localize(
              locale,
              "把命令、自然语言、文件、图像和 @ 工作区引用放进一个常规聊天界面里，同时保留线程上下文、交接和控制动作。",
              "Use a conventional chat workspace for commands, natural language, files, images, and @ workspace references without losing thread context, handoffs, or control actions.",
            )}
          </p>
        </div>

        <div className="agent-page-topbar__meta">
          <span className="pill mono">{effectiveProjectId || localize(locale, "未选择项目", "No project")}</span>
          <span className="pill">{localize(locale, `${overview?.count || 0} 个 Agent`, `${overview?.count || 0} agents`)}</span>
          <span className="pill">
            {localize(locale, `自动刷新 ${Math.max(autoRefreshSeconds, 10)}s`, `Auto refresh ${Math.max(autoRefreshSeconds, 10)}s`)}
          </span>
        </div>
      </section>

      {error ? <div className="inline-alert danger">{error}</div> : null}
      {feedback ? <div className="inline-alert">{feedback}</div> : null}

      {!effectiveProjectId ? (
        <div className="empty-state">{localize(locale, "请先在顶部加载项目，然后进入 Agent 工作台。", "Load a project first to use the agent workspace.")}</div>
      ) : (
        <section className="agent-workspace-layout agent-workspace-layout--chat">
          <aside className="agent-list-column page-card agent-chat-sidebar">
            <div className="page-card__header">
              <div>
                <div className="eyebrow">{localize(locale, "会话列表", "Conversation List")}</div>
                <h2>{localize(locale, "Agent 线程", "Agent Threads")}</h2>
              </div>
              {loading ? <LoaderCircle size={18} className="spin" /> : <Workflow size={18} />}
            </div>

            <div className="agent-list-toolbar">
              <label className="field">
                <span>{localize(locale, "搜索", "Search")}</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={localize(locale, "agent / 角色 / task / model", "agent / role / task / model")}
                />
              </label>
              <label className="field">
                <span>{localize(locale, "状态", "State")}</span>
                <select value={filter} onChange={(event) => setFilter(event.target.value as FilterState)}>
                  <option value="all">{localize(locale, "全部", "All")}</option>
                  <option value="active">{localize(locale, "活跃", "Active")}</option>
                  <option value="blocked">{localize(locale, "阻塞", "Blocked")}</option>
                  <option value="waiting">{localize(locale, "等待", "Waiting")}</option>
                  <option value="idle">{localize(locale, "空闲", "Idle")}</option>
                </select>
              </label>
            </div>

            <div className="agent-list-stack agent-list-stack--chat">
              {agents.length ? (
                agents.map((item) => (
                  <button
                    key={item.agent_id}
                    type="button"
                    className={`agent-list-item ${item.agent_id === selectedAgentId ? "active" : ""}`}
                    onClick={() => {
                      setSelectedAgentId(item.agent_id);
                      setTaskIdDraft(item.current_task_id || "");
                      setExecutionContextDraft(item.execution_context?.task_id || "");
                      setFeedback(null);
                    }}
                  >
                    <div className="agent-list-item__header">
                      <div className="agent-list-item__title">
                        <strong>{item.agent_id}</strong>
                        <span>{item.role || localize(locale, "未标注角色", "No role")}</span>
                      </div>
                      <StatusBadge value={item.state} locale={locale} />
                    </div>

                    <p className="agent-list-item__body">
                      {item.current_task_title || localize(locale, "当前没有活跃任务。", "No active task.")}
                    </p>

                    <div className="agent-list-item__meta">
                      <span className="mono">{item.current_task_id || item.provider || "-"}</span>
                      <span>{item.model || item.auth_profile || "-"}</span>
                    </div>

                    <div className="agent-list-item__footer">
                      <span>{summarizeAgent(locale, item)}</span>
                      <StatusBadge value={item.sla_status} locale={locale} />
                    </div>
                  </button>
                ))
              ) : (
                <div className="empty-state">{localize(locale, "当前筛选条件下没有匹配的 Agent。", "No agents match the current filters.")}</div>
              )}
            </div>
          </aside>

          <main className="agent-thread-column agent-chat-panel">
            <section className="page-card agent-chat-card">
              <div className="page-card__header agent-chat-panel__header">
                <div>
                  <div className="eyebrow">{localize(locale, "对话区", "Conversation")}</div>
                  <h2>{selectedAgentId || localize(locale, "选择左侧 Agent", "Choose an agent")}</h2>
                  <p className="muted-copy agent-chat-panel__summary">
                    {selectedAgent
                      ? selectedAgent.current_task_title || localize(locale, "当前没有绑定任务，可以直接开始对话。", "No bound task yet. Start the conversation directly.")
                      : localize(locale, "选择一个 Agent 后即可像常规聊天工具一样下发指令。", "Pick an agent to start chatting like a standard chat tool.")}
                  </p>
                </div>

                <div className="agent-chat-panel__meta">
                  {selectedAgent ? <StatusBadge value={selectedAgent.state} locale={locale} /> : null}
                  {selectedAgent?.provider ? (
                    <span className="pill mono">
                      {[selectedAgent.provider, selectedAgent.model].filter(Boolean).join(" / ")}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="ghost-button agent-chat-refresh"
                    onClick={() => void handleManualRefresh()}
                    disabled={loading || threadLoading}
                  >
                    {loading || threadLoading ? <LoaderCircle size={16} className="spin" /> : <RefreshCcw size={16} />}
                    <span>{localize(locale, "刷新", "Refresh")}</span>
                  </button>
                </div>
              </div>

              <div className="agent-chat-stream-shell">
                <div className="agent-thread-stream agent-thread-stream--chat">
                  {threadView?.messages.length ? (
                    threadView.messages.map((message) => (
                      <article
                        key={message.message_id}
                        className={`agent-thread-message agent-thread-message--${message.sender_type} agent-thread-message--${resolveMessageBubbleKind(message)}`}
                      >
                        <div className="agent-thread-message__header">
                          <div>
                            <span className="agent-thread-message__eyebrow">{formatMessageEyebrow(locale, message)}</span>
                            <strong>{formatMessageTitle(locale, message)}</strong>
                            <span>{formatDateTime(locale, message.created_at)}</span>
                          </div>
                          <StatusBadge value={message.status} locale={locale} />
                        </div>

                        {message.content ? <p className="agent-thread-message__content">{formatMessageContent(locale, message)}</p> : null}

                        {formatMessageMeta(locale, message).length ? (
                          <div className="agent-thread-tags">
                            {formatMessageMeta(locale, message).map((tag) => (
                              <span key={`${message.message_id}-${tag}`} className="text-chip">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        {message.attachments.length ? (
                          <div className="agent-attachment-row">
                            {message.attachments.map((attachment, index) => (
                              <span key={`${message.message_id}-${attachment.path || attachment.name || index}`} className="chip-pill">
                                {attachmentLabel(locale, attachment)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <div className="empty-state agent-chat-empty">
                      {selectedAgentId
                        ? localize(locale, "当前线程还没有消息。可以先发一条自然语言说明、命令，或上传附件。", "This thread has no messages yet. Start with natural language, a command, or an upload.")
                        : localize(locale, "先从左侧选择一个 Agent。", "Select an agent from the left sidebar first.")}
                    </div>
                  )}
                </div>
              </div>

              <div className="agent-chat-composer-shell">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => void handleUpload(event.target.files)}
                />

                <AgentChatComposer
                  locale={locale}
                  selectedAgentId={selectedAgentId}
                  projectId={effectiveProjectId}
                  value={composerText}
                  onValueChange={setComposerText}
                  onSubmit={() => void handleSendMessage()}
                  onUploadClick={() => fileInputRef.current?.click()}
                  onInsertReference={handleInsertReference}
                  mode={composerMode}
                  onModeChange={setComposerMode}
                  attachments={pendingAttachments.map((attachment, index) => ({
                    key: attachmentKey(attachment, index),
                    label: attachmentLabel(locale, attachment),
                  }))}
                  onRemoveAttachment={(key) =>
                    setPendingAttachments((current) =>
                      current.filter((attachment, index) => attachmentKey(attachment, index) !== key),
                    )
                  }
                  sending={sending}
                  uploading={uploading}
                />
              </div>
            </section>
          </main>

          <aside className="agent-context-column agent-context-column--chat">{renderContextCard(context)}</aside>
        </section>
      )}
    </div>
  );
}
