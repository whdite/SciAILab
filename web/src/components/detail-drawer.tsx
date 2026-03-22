import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { formatDateTime, type Locale } from "../i18n";
import type {
  CompletionHookRecord,
  ControlActionResult,
  MessageCreatePayload,
  MessageRecord,
  TimelineItem,
} from "../types";
import { StatusBadge } from "./status-badge";

type DetailDrawerProps = {
  title: string | null;
  open: boolean;
  payload: unknown;
  onClose: () => void;
  locale: Locale;
  messageContext?: Partial<MessageCreatePayload> | null;
  onSendMessage?: ((payload: MessageCreatePayload) => Promise<void>) | undefined;
  messageBusy?: boolean;
  messageError?: string | null;
  messageSuccess?: string | null;
};

export function DetailDrawer({
  title,
  open,
  payload,
  onClose,
  locale,
  messageContext,
  onSendMessage,
  messageBusy = false,
  messageError = null,
  messageSuccess = null,
}: DetailDrawerProps) {
  const [draft, setDraft] = useState<MessageCreatePayload>({
    project_id: "",
    from_agent: "operator",
    to_agent: "",
    message_type: "teammate_note",
    content: "",
    priority: "normal",
    artifact_ref: null,
  });

  useEffect(() => {
    setDraft({
      project_id: messageContext?.project_id?.trim() || "",
      from_agent: messageContext?.from_agent?.trim() || "operator",
      to_agent: messageContext?.to_agent?.trim() || "",
      message_type: messageContext?.message_type?.trim() || "teammate_note",
      content: "",
      priority: messageContext?.priority?.trim() || "normal",
      artifact_ref: messageContext?.artifact_ref?.trim() || null,
    });
  }, [
    messageContext?.artifact_ref,
    messageContext?.from_agent,
    messageContext?.message_type,
    messageContext?.priority,
    messageContext?.project_id,
    messageContext?.to_agent,
  ]);

  const canCompose = Boolean(onSendMessage && draft.project_id && draft.to_agent);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!onSendMessage || !draft.project_id || !draft.to_agent || !draft.content.trim()) {
      return;
    }
    try {
      await onSendMessage({
        ...draft,
        content: draft.content.trim(),
        artifact_ref: draft.artifact_ref?.trim() || null,
      });
      setDraft((current) => ({
        ...current,
        content: "",
      }));
    } catch {
      // The parent owns the error state.
    }
  }

  return (
    <aside className={`detail-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="detail-drawer__header">
        <div>
          <div className="eyebrow">{locale === "zh-CN" ? "详情" : "Detail"}</div>
          <h3>{title || (locale === "zh-CN" ? "当前选择" : "Selection")}</h3>
        </div>
        <button type="button" className="ghost-button" onClick={onClose}>
          {locale === "zh-CN" ? "关闭" : "Close"}
        </button>
      </div>
      <div className="detail-drawer__body">
        {isAttachPayload(payload) ? (
          <AttachPayloadView
            payload={payload}
            locale={locale}
            draft={draft}
            canCompose={canCompose}
            messageBusy={messageBusy}
            messageError={messageError}
            messageSuccess={messageSuccess}
            onDraftChange={setDraft}
            onSendMessage={handleSubmit}
          />
        ) : isTimelineItem(payload) ? (
          <TimelinePayloadView payload={payload} locale={locale} />
        ) : (
          <RawPayloadView payload={payload} locale={locale} />
        )}
      </div>
    </aside>
  );
}

function AttachPayloadView({
  payload,
  locale,
  draft,
  canCompose,
  messageBusy,
  messageError,
  messageSuccess,
  onDraftChange,
  onSendMessage,
}: {
  payload: ControlActionResult;
  locale: Locale;
  draft: MessageCreatePayload;
  canCompose: boolean;
  messageBusy: boolean;
  messageError: string | null;
  messageSuccess: string | null;
  onDraftChange: Dispatch<SetStateAction<MessageCreatePayload>>;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const task = payload.task;
  const executionContext = payload.execution_context;
  const worktree = payload.worktree;
  const event = payload.event;
  const hooks = payload.hooks || [];
  const inbox = payload.inbox || [];
  const outgoing = payload.outgoing || [];

  return (
    <div className="detail-sections">
      <section className="detail-section">
        <div className="eyebrow">{locale === "zh-CN" ? "Attach 汇总" : "Attach Summary"}</div>
        <div className="detail-grid">
          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "任务" : "Task"}</strong>
              {task?.status ? <StatusBadge value={task.status} locale={locale} /> : null}
            </div>
            {task ? (
              <div className="detail-kv">
                <div><span>{locale === "zh-CN" ? "标题" : "Title"}</span><strong>{task.title}</strong></div>
                <div><span>{locale === "zh-CN" ? "负责人" : "Owner"}</span><strong>{task.owner_agent}</strong></div>
                <div><span>ID</span><strong className="mono">{task.task_id}</strong></div>
                <div><span>{locale === "zh-CN" ? "依赖" : "Dependency"}</span><strong className="mono">{task.dependency || fallback(locale)}</strong></div>
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "没有任务上下文。" : "No task context."}</div>
            )}
          </article>

          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "执行上下文" : "Execution Context"}</strong>
              {executionContext?.status ? <StatusBadge value={executionContext.status} locale={locale} /> : null}
            </div>
            {executionContext ? (
              <div className="detail-kv">
                <div><span>{locale === "zh-CN" ? "运行类型" : "Runtime"}</span><strong>{executionContext.runtime_kind}</strong></div>
                <div><span>{locale === "zh-CN" ? "准备时间" : "Prepared"}</span><strong>{formatWhen(locale, executionContext.prepared_at)}</strong></div>
                <div><span>{locale === "zh-CN" ? "执行工作区" : "Execution Workspace"}</span><strong className="mono">{executionContext.execution_workspace_path}</strong></div>
                <div><span>{locale === "zh-CN" ? "主工作区" : "Canonical Workspace"}</span><strong className="mono">{executionContext.canonical_workspace_path}</strong></div>
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "没有 execution context。" : "No execution context."}</div>
            )}
          </article>

          <article className="detail-card">
            <div className="detail-card__header">
              <strong>Worktree</strong>
              {worktree?.status ? <StatusBadge value={worktree.status} locale={locale} /> : null}
            </div>
            {worktree ? (
              <div className="detail-kv">
                <div><span>{locale === "zh-CN" ? "隔离模式" : "Isolation"}</span><strong>{worktree.isolation_mode}</strong></div>
                <div><span>{locale === "zh-CN" ? "分支" : "Branch"}</span><strong className="mono">{worktree.branch_name || fallback(locale)}</strong></div>
                <div><span>{locale === "zh-CN" ? "路径" : "Path"}</span><strong className="mono">{worktree.worktree_path}</strong></div>
                <div><span>{locale === "zh-CN" ? "激活时间" : "Activated"}</span><strong>{formatWhen(locale, worktree.activated_at || worktree.created_at)}</strong></div>
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "当前任务没有绑定 worktree。" : "This task has no bound worktree."}</div>
            )}
          </article>

          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "Attach 事件" : "Attach Event"}</strong>
              {event?.status ? <StatusBadge value={event.status} locale={locale} /> : null}
            </div>
            {event ? (
              <div className="detail-kv">
                <div><span>{locale === "zh-CN" ? "事件类型" : "Event Type"}</span><strong>{event.event_type}</strong></div>
                <div><span>{locale === "zh-CN" ? "来源" : "Source"}</span><strong>{event.source}</strong></div>
                <div><span>ID</span><strong className="mono">{event.event_id}</strong></div>
                <div><span>{locale === "zh-CN" ? "时间" : "Created"}</span><strong>{formatWhen(locale, event.created_at)}</strong></div>
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "没有 attach 审计事件。" : "No attach audit event."}</div>
            )}
          </article>
        </div>
      </section>

      <section className="detail-section">
        <div className="detail-section__header">
          <div>
            <div className="eyebrow">{locale === "zh-CN" ? "收口流水线" : "Completion Pipeline"}</div>
            <h4>{locale === "zh-CN" ? "Checkpoint / Merge / Cleanup" : "Checkpoint / Merge / Cleanup"}</h4>
          </div>
          <span className="pill">{hooks.length}</span>
        </div>
        {hooks.length ? (
          <div className="detail-list">
            {hooks.map((hook) => (
              <HookListItem key={hook.hook_id} hook={hook} locale={locale} />
            ))}
          </div>
        ) : (
          <div className="detail-empty">{locale === "zh-CN" ? "还没有 completion hook 记录。" : "No completion hooks yet."}</div>
        )}
      </section>

      <section className="detail-section">
        <div className="detail-section__header">
          <div>
            <div className="eyebrow">{locale === "zh-CN" ? "消息交接" : "Messaging"}</div>
            <h4>{locale === "zh-CN" ? "Inbox / Teammate Messaging" : "Inbox / Teammate Messaging"}</h4>
          </div>
          <span className="pill">{inbox.length + outgoing.length}</span>
        </div>
        <div className="detail-grid detail-grid--messages">
          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "待处理 Inbox" : "Pending Inbox"}</strong>
              <span className="pill">{inbox.length}</span>
            </div>
            {inbox.length ? (
              <div className="detail-list">
                {inbox.map((message) => (
                  <MessageListItem key={message.message_id} message={message} locale={locale} />
                ))}
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "没有待处理消息。" : "No pending inbox messages."}</div>
            )}
          </article>

          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "队友消息" : "Teammate Messages"}</strong>
              <span className="pill">{outgoing.length}</span>
            </div>
            {outgoing.length ? (
              <div className="detail-list">
                {outgoing.map((message) => (
                  <MessageListItem key={message.message_id} message={message} locale={locale} />
                ))}
              </div>
            ) : (
              <div className="detail-empty">{locale === "zh-CN" ? "还没有发出的 teammate message。" : "No outgoing teammate messages."}</div>
            )}
          </article>
        </div>
      </section>

      <section className="detail-section">
        <div className="eyebrow">{locale === "zh-CN" ? "发送队友消息" : "Send Teammate Message"}</div>
        {canCompose ? (
          <form className="detail-form" onSubmit={(event) => void onSendMessage(event)}>
            <div className="detail-form__row">
              <label className="field">
                <span>{locale === "zh-CN" ? "发件方" : "From"}</span>
                <input
                  value={draft.from_agent}
                  onChange={(event) => onDraftChange((current) => ({ ...current, from_agent: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>{locale === "zh-CN" ? "收件方" : "To"}</span>
                <input
                  value={draft.to_agent}
                  onChange={(event) => onDraftChange((current) => ({ ...current, to_agent: event.target.value }))}
                />
              </label>
            </div>

            <div className="detail-form__row">
              <label className="field">
                <span>{locale === "zh-CN" ? "消息类型" : "Message Type"}</span>
                <input
                  value={draft.message_type}
                  onChange={(event) => onDraftChange((current) => ({ ...current, message_type: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>{locale === "zh-CN" ? "优先级" : "Priority"}</span>
                <select
                  value={draft.priority || "normal"}
                  onChange={(event) => onDraftChange((current) => ({ ...current, priority: event.target.value }))}
                >
                  <option value="low">{locale === "zh-CN" ? "低" : "Low"}</option>
                  <option value="normal">{locale === "zh-CN" ? "普通" : "Normal"}</option>
                  <option value="high">{locale === "zh-CN" ? "高" : "High"}</option>
                </select>
              </label>
            </div>

            <label className="field">
              <span>{locale === "zh-CN" ? "关联工件" : "Artifact Ref"}</span>
              <input
                value={draft.artifact_ref || ""}
                onChange={(event) => onDraftChange((current) => ({ ...current, artifact_ref: event.target.value || null }))}
                placeholder={locale === "zh-CN" ? "可选，例如 draft-artifact-v2" : "Optional, for example draft-artifact-v2"}
              />
            </label>

            <label className="field">
              <span>{locale === "zh-CN" ? "消息内容" : "Content"}</span>
              <textarea
                rows={5}
                value={draft.content}
                onChange={(event) => onDraftChange((current) => ({ ...current, content: event.target.value }))}
                placeholder={
                  locale === "zh-CN"
                    ? "写入交接说明、阻塞原因、下一步建议。"
                    : "Write the handoff note, blocker, or next-step instruction."
                }
              />
            </label>

            {messageError ? <div className="inline-alert danger">{messageError}</div> : null}
            {messageSuccess ? <div className="inline-alert">{messageSuccess}</div> : null}

            <div className="detail-actions">
              <button type="submit" className="ghost-button" disabled={messageBusy || !draft.content.trim()}>
                {messageBusy
                  ? locale === "zh-CN"
                    ? "发送中"
                    : "Sending"
                  : locale === "zh-CN"
                    ? "发送消息"
                    : "Send Message"}
              </button>
            </div>
          </form>
        ) : (
          <div className="detail-empty">
            {locale === "zh-CN"
              ? "当前 attach 结果没有足够的任务上下文，无法直接发消息。"
              : "This attach result does not provide enough task context to send a message."}
          </div>
        )}
      </section>

      <RawPayloadView payload={payload} locale={locale} />
    </div>
  );
}

function TimelinePayloadView({ payload, locale }: { payload: TimelineItem; locale: Locale }) {
  return (
    <div className="detail-sections">
      <section className="detail-section">
        <div className="detail-grid">
          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "概览" : "Overview"}</strong>
              {payload.status ? <StatusBadge value={payload.status} locale={locale} /> : null}
            </div>
            <div className="detail-kv">
              <div><span>{locale === "zh-CN" ? "类型" : "Kind"}</span><strong>{payload.kind}</strong></div>
              <div><span>ID</span><strong className="mono">{payload.id}</strong></div>
              <div><span>{locale === "zh-CN" ? "负责人" : "Owner"}</span><strong>{payload.owner_agent || fallback(locale)}</strong></div>
              <div><span>{locale === "zh-CN" ? "时间" : "Time"}</span><strong>{formatWhen(locale, payload.timestamp)}</strong></div>
              <div><span>{locale === "zh-CN" ? "摘要" : "Summary"}</span><strong>{payload.summary}</strong></div>
              <div><span>{locale === "zh-CN" ? "事件类型" : "Event Type"}</span><strong>{payload.event_type || fallback(locale)}</strong></div>
            </div>
          </article>

          <article className="detail-card">
            <div className="detail-card__header">
              <strong>{locale === "zh-CN" ? "明细字段" : "Detail Fields"}</strong>
            </div>
            <div className="detail-kv">
              {Object.entries(payload.details || {}).length ? (
                Object.entries(payload.details || {}).map(([key, value]) => (
                  <div key={key}>
                    <span>{key}</span>
                    <strong className={typeof value === "string" && looksLikePath(value) ? "mono" : undefined}>
                      {stringifyValue(value)}
                    </strong>
                  </div>
                ))
              ) : (
                <div><span>{locale === "zh-CN" ? "内容" : "Content"}</span><strong>{fallback(locale)}</strong></div>
              )}
            </div>
          </article>
        </div>
      </section>

      <RawPayloadView payload={payload} locale={locale} />
    </div>
  );
}

function RawPayloadView({ payload, locale }: { payload: unknown; locale: Locale }) {
  return (
    <details className="detail-raw" open>
      <summary>{locale === "zh-CN" ? "原始 JSON" : "Raw JSON"}</summary>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </details>
  );
}

function HookListItem({ hook, locale }: { hook: CompletionHookRecord; locale: Locale }) {
  return (
    <article className="detail-list-item">
      <div className="detail-list-item__header">
        <strong>{hook.hook_type}</strong>
        <StatusBadge value={hook.status} locale={locale} />
      </div>
      <span className="detail-list-item__meta mono">{hook.task_id}</span>
      <span className="detail-list-item__meta">{formatWhen(locale, hook.completed_at || hook.updated_at)}</span>
    </article>
  );
}

function MessageListItem({ message, locale }: { message: MessageRecord; locale: Locale }) {
  return (
    <article className="detail-list-item">
      <div className="detail-list-item__header">
        <strong>{message.from_agent} → {message.to_agent}</strong>
        <StatusBadge value={message.status} locale={locale} />
      </div>
      <span className="detail-list-item__meta">
        {message.message_type} / {message.handoff_state || "queued"} / {message.priority}
      </span>
      {message.artifact_ref ? <span className="detail-list-item__meta mono">{message.artifact_ref}</span> : null}
      <p>{message.content}</p>
    </article>
  );
}

function formatWhen(locale: Locale, value: string | null | undefined): string {
  if (!value) {
    return fallback(locale);
  }
  return formatDateTime(locale, value);
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function looksLikePath(value: string): boolean {
  return value.includes("\\") || value.includes("/") || value.includes(":");
}

function fallback(locale: Locale): string {
  return locale === "zh-CN" ? "无" : "None";
}

function isAttachPayload(value: unknown): value is ControlActionResult {
  if (!isRecord(value)) {
    return false;
  }
  return Boolean(
    value.task ||
      value.execution_context ||
      value.worktree ||
      value.event ||
      Array.isArray(value.inbox) ||
      Array.isArray(value.outgoing) ||
      Array.isArray(value.hooks),
  );
}

function isTimelineItem(value: unknown): value is TimelineItem {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.kind === "string" && typeof value.id === "string" && typeof value.title === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
