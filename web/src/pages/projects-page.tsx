import { useEffect, useMemo, useState } from "react";
import { createProject, fetchProjects } from "../api";
import { StatusBadge } from "../components/status-badge";
import { formatDateTime, t, translateSaveState, translateStatus, type Locale } from "../i18n";
import type { ProjectListItem, SaveState } from "../types";

type ProjectsPageProps = {
  apiBaseUrl: string;
  refreshToken: number;
  locale: Locale;
  onOpenTrace: (projectId: string) => void;
};

type ProjectCreateDraft = {
  name: string;
  goal: string;
  ownerAgent: string;
  projectId: string;
  bootstrapFlow: boolean;
};

const DEFAULT_CREATE_DRAFT: ProjectCreateDraft = {
  name: "",
  goal: "",
  ownerAgent: "control-plane",
  projectId: "",
  bootstrapFlow: true,
};

export function ProjectsPage({ apiBaseUrl, refreshToken, locale, onOpenTrace }: ProjectsPageProps) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [createDraft, setCreateDraft] = useState<ProjectCreateDraft>(DEFAULT_CREATE_DRAFT);
  const [createState, setCreateState] = useState<SaveState>("idle");
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const result = await fetchProjects(100, apiBaseUrl);
        if (cancelled) {
          return;
        }
        setProjects(result.projects);
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
  }, [apiBaseUrl, refreshToken]);

  const sortedProjects = useMemo(
    () =>
      [...projects].sort(
        (left, right) =>
          new Date(right.project.updated_at).getTime() - new Date(left.project.updated_at).getTime(),
      ),
    [projects],
  );

  const recentProjects = sortedProjects.slice(0, 3);
  const statusOptions = useMemo(
    () => Array.from(new Set(projects.map((item) => item.project.status || "unknown"))).sort(),
    [projects],
  );
  const eventOptions = useMemo(
    () =>
      Array.from(
        new Set(projects.map((item) => item.summary.latest_event_type).filter((value): value is string => Boolean(value))),
      ).sort(),
    [projects],
  );

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sortedProjects.filter((item) => {
      if (statusFilter && (item.project.status || "unknown") !== statusFilter) {
        return false;
      }
      if (eventFilter && (item.summary.latest_event_type || "") !== eventFilter) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack =
        `${item.project.name} ${item.project.project_id} ${item.project.goal} ${item.summary.latest_event_type || ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [eventFilter, query, sortedProjects, statusFilter]);

  async function handleCreateProject(): Promise<void> {
    if (!createDraft.name.trim()) {
      setCreateState("error");
      setCreateError(t(locale, "projects.nameRequired"));
      return;
    }
    setCreateState("saving");
    setCreateError(null);
    try {
      const created = await createProject(
        {
          name: createDraft.name.trim(),
          goal: createDraft.goal.trim(),
          owner_agent: createDraft.ownerAgent.trim() || "control-plane",
          project_id: createDraft.projectId.trim() || undefined,
          bootstrap_flow: createDraft.bootstrapFlow,
        },
        apiBaseUrl,
      );
      const listed = await fetchProjects(100, apiBaseUrl);
      setProjects(listed.projects);
      setCreateDraft(DEFAULT_CREATE_DRAFT);
      setCreateState("saved");
      window.setTimeout(() => setCreateState("idle"), 1500);
      onOpenTrace(created.project.project_id);
    } catch (nextError) {
      setCreateState("error");
      setCreateError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  return (
    <div className="page-layout single-column">
      <section className="hero-card">
        <div>
          <div className="eyebrow">{t(locale, "projects.heroEyebrow")}</div>
          <h1>{t(locale, "projects.title")}</h1>
          <p className="hero-copy">{t(locale, "projects.copy")}</p>
        </div>
        <div className="hero-meta">
          <div className="pill">
            {loading ? t(locale, "projects.loading") : t(locale, "projects.count", { count: projects.length })}
          </div>
          <div className={`pill ${createState === "error" ? "danger" : ""}`}>{t(locale, "projects.createState", { state: translateSaveState(locale, createState) })}</div>
        </div>
      </section>

      {error ? <div className="inline-alert danger">{error}</div> : null}
      {createError ? <div className="inline-alert danger">{createError}</div> : null}

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "projects.createEyebrow")}</div>
            <h2>{t(locale, "projects.createTitle")}</h2>
          </div>
          <button type="button" className="primary-button" onClick={() => void handleCreateProject()}>
            {t(locale, "projects.createButton")}
          </button>
        </div>
        <div className="settings-grid settings-grid--project-create">
          <label className="field">
            <span>{t(locale, "projects.name")}</span>
            <input
              value={createDraft.name}
              placeholder={t(locale, "projects.namePlaceholder")}
              onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t(locale, "projects.ownerAgent")}</span>
            <input
              value={createDraft.ownerAgent}
              onChange={(event) => setCreateDraft((current) => ({ ...current, ownerAgent: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>{t(locale, "projects.projectId")}</span>
            <input
              value={createDraft.projectId}
              placeholder={t(locale, "projects.projectIdPlaceholder")}
              onChange={(event) => setCreateDraft((current) => ({ ...current, projectId: event.target.value }))}
            />
          </label>
          <label className="field field--checkbox">
            <span>{t(locale, "projects.bootstrapFlow")}</span>
            <div className="checkbox-row">
              <input
                type="checkbox"
                checked={createDraft.bootstrapFlow}
                onChange={(event) => setCreateDraft((current) => ({ ...current, bootstrapFlow: event.target.checked }))}
              />
              <strong>{t(locale, "projects.bootstrapFlowCopy")}</strong>
            </div>
          </label>
          <label className="field field--full">
            <span>{t(locale, "projects.goal")}</span>
            <textarea
              value={createDraft.goal}
              placeholder={t(locale, "projects.goalPlaceholder")}
              onChange={(event) => setCreateDraft((current) => ({ ...current, goal: event.target.value }))}
            />
          </label>
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "projects.recentEyebrow")}</div>
            <h2>{t(locale, "projects.recentTitle")}</h2>
          </div>
        </div>
        <div className="projects-grid projects-grid--recent">
          {recentProjects.length ? (
            recentProjects.map((item) => (
              <ProjectCard key={`recent:${item.project.project_id}`} item={item} apiBaseUrl={apiBaseUrl} onOpenTrace={onOpenTrace} locale={locale} />
            ))
          ) : (
            <div className="empty-state">{t(locale, "projects.noneYet")}</div>
          )}
        </div>
      </section>

      <section className="page-card">
        <div className="page-card__header">
          <div>
            <div className="eyebrow">{t(locale, "projects.searchEyebrow")}</div>
            <h2>{t(locale, "projects.searchTitle")}</h2>
          </div>
        </div>
        <div className="filters-row">
          <label className="field field--grow">
            <span>{t(locale, "projects.search")}</span>
            <input
              value={query}
              placeholder={t(locale, "projects.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t(locale, "projects.status")}</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">{t(locale, "trace.all")}</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {translateStatus(locale, status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t(locale, "projects.latestEvent")}</span>
            <select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
              <option value="">{t(locale, "trace.all")}</option>
              {eventOptions.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventType}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>{t(locale, "projects.order")}</span>
            <div className="pill">{t(locale, "projects.recentFirst")}</div>
          </div>
        </div>

        <div className="projects-grid">
          {filteredProjects.length ? (
            filteredProjects.map((item) => (
              <ProjectCard key={item.project.project_id} item={item} apiBaseUrl={apiBaseUrl} onOpenTrace={onOpenTrace} locale={locale} />
            ))
          ) : (
            <div className="empty-state">
              {projects.length ? t(locale, "projects.noMatch") : t(locale, "projects.noFound")}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

type ProjectCardProps = {
  item: ProjectListItem;
  apiBaseUrl: string;
  onOpenTrace: (projectId: string) => void;
  locale: Locale;
};

function ProjectCard({ item, apiBaseUrl, onOpenTrace, locale }: ProjectCardProps) {
  return (
    <article className="project-card">
      <div className="project-card__header">
        <div>
          <div className="eyebrow">{t(locale, "projects.projectEyebrow")}</div>
          <h3>{item.project.name}</h3>
        </div>
        <StatusBadge value={item.project.status || "ready"} locale={locale} />
      </div>
      <p className="project-card__goal">{item.project.goal || t(locale, "projects.noGoal")}</p>
      <div className="project-card__meta mono">{item.project.project_id}</div>
      <div className="project-card__stats">
        <span className="text-chip">{t(locale, "projects.activeTasks")} {item.summary.active_tasks}</span>
        <span className="text-chip">{t(locale, "projects.events")} {item.summary.events}</span>
        <span className="text-chip">{t(locale, "projects.nonIdleAgents")} {item.summary.non_idle_agents}</span>
      </div>
      <div className="project-card__footer">
        <span className="project-card__event">{t(locale, "projects.latestEventLabel")}: {item.summary.latest_event_type || t(locale, "trace.none")}</span>
        <span className="project-card__updated">{t(locale, "projects.updated", { time: formatTimestamp(item.project.updated_at, locale) })}</span>
      </div>
      <div className="project-card__actions">
        <button type="button" className="primary-button" onClick={() => onOpenTrace(item.project.project_id)}>
          {t(locale, "projects.openTrace")}
        </button>
        <a
          className="ghost-link"
          href={`${apiBaseUrl || ""}/v1/projects/${encodeURIComponent(item.project.project_id)}/read-model?limit=60`}
          target="_blank"
          rel="noreferrer"
        >
          {t(locale, "topbar.json")}
        </a>
      </div>
    </article>
  );
}

function formatTimestamp(value: string, locale: Locale): string {
  return formatDateTime(locale, value);
}
