import { useCallback, useEffect, useRef } from "react";
import {
  ArrowUpIcon,
  AtSign,
  CircleUserRound,
  FileUp,
  ImageIcon,
  Paperclip,
  PlusIcon,
  Sparkles,
  Workflow,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { Locale } from "../../i18n";
import { Textarea } from "./textarea";

type ComposerMode = "chat" | "command" | "mixed";

type QuickAction = {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
};

type AgentChatComposerProps = {
  locale: Locale;
  selectedAgentId: string;
  projectId: string;
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onUploadClick: () => void;
  onInsertReference: (value: string) => void;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  attachments: Array<{ key: string; label: string }>;
  onRemoveAttachment: (key: string) => void;
  sending: boolean;
  uploading: boolean;
};

type UseAutoResizeTextareaProps = {
  minHeight: number;
  maxHeight?: number;
};

function localize(locale: Locale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

function useAutoResizeTextarea({ minHeight, maxHeight }: UseAutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(
    (reset?: boolean) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      if (reset) {
        textarea.style.height = `${minHeight}px`;
        return;
      }
      textarea.style.height = `${minHeight}px`;
      const newHeight = Math.max(
        minHeight,
        Math.min(textarea.scrollHeight, maxHeight ?? Number.POSITIVE_INFINITY),
      );
      textarea.style.height = `${newHeight}px`;
    },
    [minHeight, maxHeight],
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = `${minHeight}px`;
    }
  }, [minHeight]);

  useEffect(() => {
    const handleResize = () => adjustHeight();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [adjustHeight]);

  return { textareaRef, adjustHeight };
}

export function AgentChatComposer({
  locale,
  selectedAgentId,
  projectId,
  value,
  onValueChange,
  onSubmit,
  onUploadClick,
  onInsertReference,
  mode,
  onModeChange,
  attachments,
  onRemoveAttachment,
  sending,
  uploading,
}: AgentChatComposerProps) {
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({
    minHeight: 72,
    maxHeight: 240,
  });

  const quickActions: QuickAction[] = [
    {
      key: "workspace-file",
      icon: <AtSign className="w-4 h-4" />,
      label: localize(locale, "引用工作区文件", "Reference Workspace File"),
      onClick: () => onInsertReference("@docs/"),
    },
    {
      key: "image",
      icon: <ImageIcon className="w-4 h-4" />,
      label: localize(locale, "上传图像", "Upload Image"),
      onClick: onUploadClick,
    },
    {
      key: "task",
      icon: <Workflow className="w-4 h-4" />,
      label: localize(locale, "插入任务引用", "Insert Task Ref"),
      onClick: () => onInsertReference("@task:"),
    },
    {
      key: "handoff",
      icon: <CircleUserRound className="w-4 h-4" />,
      label: localize(locale, "生成交接说明", "Draft Handoff"),
      onClick: () =>
        onInsertReference(
          localize(
            locale,
            "\n请整理当前阻塞点、已完成项、下一步建议，并补一段 handoff 说明。",
            "\nSummarize blockers, completed work, next steps, and add a handoff note.",
          ),
        ),
    },
    {
      key: "checkpoint",
      icon: <Sparkles className="w-4 h-4" />,
      label: localize(locale, "请求检查点", "Request Checkpoint"),
      onClick: () =>
        onInsertReference(
          localize(
            locale,
            "\n请先概括当前状态，并判断现在是否应该创建 checkpoint。",
            "\nSummarize the current state and whether a checkpoint should be created now.",
          ),
        ),
    },
  ];

  const canSubmit = Boolean(value.trim() || attachments.length);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSubmit) {
        onSubmit();
        adjustHeight(true);
      }
    }
  };

  return (
    <div className="agent-v0-shell agent-v0-shell--compact">
      <div className="agent-v0-context">
        <div className="agent-v0-context__chips">
          <span className="pill mono">{selectedAgentId || localize(locale, "未选择 Agent", "No agent selected")}</span>
          <span className="pill mono">{projectId || localize(locale, "未选择项目", "No project")}</span>
        </div>

        <div className="agent-v0-mode-switch">
          <button
            type="button"
            className={cn("agent-v0-mode-button", mode === "chat" && "active")}
            onClick={() => onModeChange("chat")}
          >
            {localize(locale, "对话", "Chat")}
          </button>
          <button
            type="button"
            className={cn("agent-v0-mode-button", mode === "command" && "active")}
            onClick={() => onModeChange("command")}
          >
            {localize(locale, "指令", "Command")}
          </button>
          <button
            type="button"
            className={cn("agent-v0-mode-button", mode === "mixed" && "active")}
            onClick={() => onModeChange("mixed")}
          >
            {localize(locale, "混合", "Mixed")}
          </button>
        </div>
      </div>

      <div className="agent-v0-card agent-v0-card--composer">
        <div className="agent-v0-input-wrap">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value);
              adjustHeight();
            }}
            onKeyDown={handleKeyDown}
            placeholder={localize(
              locale,
              "输入给 Agent 的任务说明、命令或自然语言消息。支持 Shift+Enter 换行，也支持 @task: / @artifact: / @package: / @路径。",
              "Type a task description, command, or natural language message. Supports Shift+Enter and @task: / @artifact: / @package: / @path.",
            )}
            className="agent-v0-textarea"
            style={{ overflow: "hidden" }}
          />
        </div>

        {attachments.length ? (
          <div className="agent-v0-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.key} className="chip-pill">
                {attachment.label}
                <button
                  type="button"
                  className="chip-pill__remove"
                  onClick={() => onRemoveAttachment(attachment.key)}
                  aria-label={localize(locale, "移除附件", "Remove attachment")}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="agent-v0-toolbar">
          <div className="agent-v0-toolbar__left">
            <button type="button" className="agent-v0-icon-button" onClick={onUploadClick} disabled={uploading}>
              <Paperclip className="w-4 h-4" />
              <span>{uploading ? localize(locale, "上传中", "Uploading") : localize(locale, "附件", "Attach")}</span>
            </button>

            <button type="button" className="agent-v0-project-pill">
              <PlusIcon className="w-4 h-4" />
              <span>{localize(locale, "项目上下文", "Project Context")}</span>
            </button>
          </div>

          <div className="agent-v0-toolbar__right">
            <button
              type="button"
              className={cn("agent-v0-send-button", canSubmit && "active")}
              onClick={onSubmit}
              disabled={!canSubmit}
            >
              <ArrowUpIcon className="w-4 h-4" />
              <span className="sr-only">
                {sending ? localize(locale, "发送中", "Sending") : localize(locale, "发送", "Send")}
              </span>
            </button>
          </div>
        </div>
      </div>

      <div className="agent-v0-actions">
        {quickActions.map((item) => (
          <button key={item.key} type="button" className="agent-v0-action-button" onClick={item.onClick}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
        <button key="upload-file" type="button" className="agent-v0-action-button" onClick={onUploadClick}>
          <FileUp className="w-4 h-4" />
          <span>{localize(locale, "上传文件", "Upload File")}</span>
        </button>
      </div>
    </div>
  );
}
