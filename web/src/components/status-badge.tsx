import { translateStatus, type Locale } from "../i18n";

type StatusBadgeProps = {
  value: string | null | undefined;
  locale?: Locale;
};

function statusClass(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "blocked" || normalized === "error" || normalized === "disabled") {
    return "danger";
  }
  if (
    normalized === "retry" ||
    normalized === "review_pending" ||
    normalized === "reachable" ||
    normalized === "degraded" ||
    normalized === "cooldown" ||
    normalized === "needs_login" ||
    normalized === "queued" ||
    normalized === "seen"
  ) {
    return "warning";
  }
  if (
    normalized === "done" ||
    normalized === "idle" ||
    normalized === "ready" ||
    normalized === "complete" ||
    normalized === "active" ||
    normalized === "connected" ||
    normalized === "healthy" ||
    normalized === "configured" ||
    normalized === "read" ||
    normalized === "acked" ||
    normalized === "accepted" ||
    normalized === "resolved" ||
    normalized === "completed"
  ) {
    return "success";
  }
  if (normalized === "in_progress" || normalized === "executing" || normalized === "planning" || normalized === "running") {
    return "accent";
  }
  return "neutral";
}

export function StatusBadge({ value, locale = "en-US" }: StatusBadgeProps) {
  const text = value?.trim() || "unknown";
  return <span className={`status-badge ${statusClass(text)}`}>{translateStatus(locale, text)}</span>;
}
