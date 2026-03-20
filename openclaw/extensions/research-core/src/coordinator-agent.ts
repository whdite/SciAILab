import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "./project-paths.js";
import { runResearchRequest } from "./research-service.js";

type CoordinatorRole = "explorer" | "experiment" | "writer" | "reviewer";

type ClaimedTask = {
  task_id: string;
  project_id: string;
  title: string;
  scope: string;
  owner_agent: CoordinatorRole;
  status: string;
  dependency?: string | null;
  acceptance?: string | null;
  created_at?: string;
  updated_at?: string;
  project_name: string;
  project_goal: string;
  workspace_path: string;
};

type ProjectStatusResponse = {
  project: {
    project_id: string;
    name: string;
    goal: string;
    workspace_path: string;
  };
  summary: Record<string, unknown>;
};

type ArtifactRecord = {
  artifact_id: string;
  project_id: string;
  artifact_type: string;
  owner: string;
  version: number;
  state: string;
  path: string;
};

type PackageRecord = {
  package_id: string;
};

type CoordinatorResult = {
  artifact_markdown: string;
  summary?: string;
  message?: {
    to_agent: string;
    message_type: string;
    content: string;
  };
  event_type?: string;
};

type CoordinatorPassParams = {
  projectId?: string;
  ownerAgent?: CoordinatorRole;
  limit?: number;
  consumeLimit?: number;
  routeConfig?: RoleRoutingConfig;
};

type RoleRoutingConfig = {
  role: CoordinatorRole;
  active: boolean;
  provider?: string;
  model?: string;
  auth_profile?: string;
  max_concurrency: number;
};

type RoleWorkerHandle = {
  stopRequested: boolean;
  promise: Promise<void>;
};

const ROLE_SKILLS: Record<CoordinatorRole, string> = {
  explorer: "sciailab-explorer-coordinator",
  experiment: "sciailab-experiment-coordinator",
  writer: "sciailab-writer-coordinator",
  reviewer: "sciailab-reviewer-coordinator",
};

const ROLE_ARTIFACT_TYPES: Record<CoordinatorRole, string> = {
  explorer: "hypotheses",
  experiment: "results_summary",
  writer: "draft",
  reviewer: "review_report",
};

const ROLE_ARTIFACT_STATES: Record<CoordinatorRole, string> = {
  explorer: "ready_for_experiment",
  experiment: "complete",
  writer: "ready",
  reviewer: "complete",
};

const ROLE_DEFAULT_EVENTS: Record<CoordinatorRole, string> = {
  explorer: "hypothesis_ready_for_experiment",
  experiment: "experiment_results_ready",
  writer: "review_requested",
  reviewer: "review_approved",
};

const VALID_REVIEW_EVENTS = new Set([
  "review_requires_ablation",
  "review_requires_evidence",
  "review_requires_revision",
  "review_approved",
]);

const COORDINATOR_ROLES: CoordinatorRole[] = ["explorer", "experiment", "writer", "reviewer"];

function isCoordinatorRole(value: unknown): value is CoordinatorRole {
  return value === "explorer" || value === "experiment" || value === "writer" || value === "reviewer";
}

function extractTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractLatestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const message = candidate as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractTextParts(message.content);
    if (text) {
      return text;
    }
  }
  throw new Error("subagent returned no assistant text");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("coordinator output must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseCoordinatorResult(role: CoordinatorRole, text: string): CoordinatorResult {
  const parsed = parseJsonObject(text);
  const artifactMarkdown = typeof parsed.artifact_markdown === "string" ? parsed.artifact_markdown.trim() : "";
  if (!artifactMarkdown) {
    throw new Error("coordinator output missing artifact_markdown");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : undefined;
  const messageRaw =
    parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
      ? (parsed.message as Record<string, unknown>)
      : undefined;
  const message =
    messageRaw &&
    typeof messageRaw.to_agent === "string" &&
    typeof messageRaw.message_type === "string" &&
    typeof messageRaw.content === "string"
      ? {
          to_agent: messageRaw.to_agent.trim(),
          message_type: messageRaw.message_type.trim(),
          content: messageRaw.content.trim(),
        }
      : undefined;

  let eventType =
    typeof parsed.event_type === "string" && parsed.event_type.trim()
      ? parsed.event_type.trim()
      : ROLE_DEFAULT_EVENTS[role];
  if (role === "reviewer" && !VALID_REVIEW_EVENTS.has(eventType)) {
    throw new Error(`reviewer event_type must be one of: ${Array.from(VALID_REVIEW_EVENTS).join(", ")}`);
  }
  if (role !== "reviewer") {
    eventType = ROLE_DEFAULT_EVENTS[role];
  }

  return {
    artifact_markdown: artifactMarkdown,
    summary,
    message,
    event_type: eventType,
  };
}

function latestArtifactByType(artifacts: ArtifactRecord[], artifactType: string): ArtifactRecord | undefined {
  return artifacts.find((artifact) => artifact.artifact_type === artifactType);
}

function buildArtifactPath(task: ClaimedTask): string {
  const artifactType = ROLE_ARTIFACT_TYPES[task.owner_agent];
  return path.join(task.workspace_path, "artifacts", task.owner_agent, `${artifactType}_${task.task_id}.md`);
}

function artifactExcerpt(artifact: ArtifactRecord | undefined): string {
  if (!artifact) {
    return "(missing)";
  }
  return `- ${artifact.artifact_id} [${artifact.state}] @ ${artifact.path}`;
}

function buildCoordinatorMessage(params: {
  task: ClaimedTask;
  project: ProjectStatusResponse["project"];
  artifacts: ArtifactRecord[];
  inputPackageId?: string;
}): string {
  const hypothesis = latestArtifactByType(params.artifacts, "hypotheses");
  const results = latestArtifactByType(params.artifacts, "results_summary");
  const draft = latestArtifactByType(params.artifacts, "draft");
  const review = latestArtifactByType(params.artifacts, "review_report");
  const reviewerDecisionHint =
    params.task.owner_agent === "reviewer"
      ? [
          "Reviewer event_type rule:",
          "- return `review_requires_ablation` if the draft still needs another experiment pass",
          "- return `review_requires_evidence` if the draft needs stronger supporting evidence but not a full ablation pass",
          "- return `review_requires_revision` if the evidence is sufficient but the draft itself needs revision",
          "- return `review_approved` if the draft is acceptable for the current MVP milestone",
          "",
        ].join("\n")
      : "";
  const inputPackageHint = params.inputPackageId
    ? `Frozen input package for this run: ${params.inputPackageId}\n`
    : "";
  return [
    `Project: ${params.project.name} (${params.project.project_id})`,
    `Goal: ${params.project.goal || "(empty)"}`,
    `Task: ${params.task.title}`,
    `Acceptance: ${params.task.acceptance || "(none)"}`,
    `Owner role: ${params.task.owner_agent}`,
    "",
    "Latest artifacts:",
    artifactExcerpt(hypothesis),
    artifactExcerpt(results),
    artifactExcerpt(draft),
    artifactExcerpt(review),
    "",
    inputPackageHint,
    reviewerDecisionHint,
    "Return ONLY JSON with this shape:",
    "{",
    '  "artifact_markdown": "full markdown artifact content",',
    '  "summary": "short run summary",',
    '  "message": { "to_agent": "experiment|writer|reviewer", "message_type": "handoff|review_note|need_evidence|approval", "content": "message text" } | null,',
    `  "event_type": "${params.task.owner_agent === "reviewer" ? "review_requires_ablation|review_requires_evidence|review_requires_revision|review_approved" : ROLE_DEFAULT_EVENTS[params.task.owner_agent]}"`,
    "}",
    "",
    "Do not wrap the JSON in commentary. Use the role skill before responding.",
  ].join("\n");
}

function buildCoordinatorSystemPrompt(role: CoordinatorRole): string {
  return [
    `You are the SciAILab ${role} coordinator.`,
    `You must use the bundled skill \`${ROLE_SKILLS[role]}\` before responding.`,
    "Keep the run grounded in project artifacts and task acceptance criteria.",
    "Return only the requested JSON object.",
  ].join("\n");
}

function defaultRoleRouting(
  paths: ResolvedResearchPaths,
  role: CoordinatorRole,
): RoleRoutingConfig {
  return {
    role,
    active: true,
    provider: paths.coordinatorProvider,
    model: paths.coordinatorModel,
    max_concurrency: 1,
  };
}

function normalizeRoleRouting(
  paths: ResolvedResearchPaths,
  raw: Partial<RoleRoutingConfig> | undefined,
  role: CoordinatorRole,
): RoleRoutingConfig {
  const fallback = defaultRoleRouting(paths, role);
  return {
    role,
    active: raw?.active ?? fallback.active,
    provider: raw?.provider?.trim() || fallback.provider,
    model: raw?.model?.trim() || fallback.model,
    auth_profile: raw?.auth_profile?.trim() || undefined,
    max_concurrency: Math.max(1, raw?.max_concurrency ?? fallback.max_concurrency),
  };
}

async function fetchAgentRouting(
  paths: ResolvedResearchPaths,
): Promise<Map<CoordinatorRole, RoleRoutingConfig>> {
  const result = await runResearchRequest<{ routes?: Array<Record<string, unknown>> }>(paths, {
    method: "GET",
    route: "/v1/control/agent-routing",
  });
  const routes = new Map<CoordinatorRole, RoleRoutingConfig>();
  for (const role of COORDINATOR_ROLES) {
    const raw = Array.isArray(result.routes)
      ? result.routes.find((item) => item?.role === role)
      : undefined;
    routes.set(
      role,
      normalizeRoleRouting(paths, raw as Partial<RoleRoutingConfig> | undefined, role),
    );
  }
  return routes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimTask(
  paths: ResolvedResearchPaths,
  params: { projectId?: string; ownerAgent?: CoordinatorRole },
): Promise<ClaimedTask | undefined> {
  const payload = {
    ...(params.projectId ? { project_id: params.projectId } : {}),
    ...(params.ownerAgent ? { owner_agent: params.ownerAgent } : {}),
  };
  const result = await runResearchRequest<{ task?: ClaimedTask | null }>(paths, {
    method: "POST",
    route: "/v1/tasks/claim",
    body: payload,
    fallbackCommand: "claim_task",
    fallbackPayload: payload,
  });
  return result.task ?? undefined;
}

async function getProjectStatus(
  paths: ResolvedResearchPaths,
  projectId: string,
): Promise<ProjectStatusResponse> {
  return await runResearchRequest<ProjectStatusResponse>(paths, {
    method: "GET",
    route: `/v1/projects/${encodeURIComponent(projectId)}`,
    fallbackCommand: "get_project_status",
    fallbackPayload: { project_id: projectId },
  });
}

async function listArtifacts(paths: ResolvedResearchPaths, projectId: string): Promise<ArtifactRecord[]> {
  const result = await runResearchRequest<{ artifacts: ArtifactRecord[] }>(paths, {
    method: "GET",
    route: `/v1/projects/${encodeURIComponent(projectId)}/artifacts`,
    fallbackCommand: "list_artifacts",
    fallbackPayload: { project_id: projectId },
  });
  return Array.isArray(result.artifacts) ? result.artifacts : [];
}

async function setAgentState(
  paths: ResolvedResearchPaths,
  params: {
    projectId: string;
    agentId: CoordinatorRole;
    state: string;
    currentTaskId?: string;
    lastError?: string;
  },
): Promise<unknown> {
  const payload = {
    project_id: params.projectId,
    agent_id: params.agentId,
    state: params.state,
    ...(params.currentTaskId ? { current_task_id: params.currentTaskId } : {}),
    ...(params.lastError ? { last_error: params.lastError } : {}),
  };
  return await runResearchRequest(paths, {
    method: "POST",
    route: "/v1/state/agent",
    body: payload,
    fallbackCommand: "set_agent_state",
    fallbackPayload: payload,
  });
}

async function registerArtifact(
  paths: ResolvedResearchPaths,
  params: {
    projectId: string;
    owner: CoordinatorRole;
    artifactType: string;
    artifactPath: string;
    state: string;
    upstreamDependencies?: string[];
    metadata?: Record<string, unknown>;
  },
): Promise<ArtifactRecord> {
  const payload = {
    project_id: params.projectId,
    artifact_type: params.artifactType,
    owner: params.owner,
    path: params.artifactPath,
    state: params.state,
    ...(params.upstreamDependencies ? { upstream_dependencies: params.upstreamDependencies } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  };
  return await runResearchRequest<ArtifactRecord>(paths, {
    method: "POST",
    route: "/v1/artifacts",
    body: payload,
    fallbackCommand: "register_artifact",
    fallbackPayload: payload,
  });
}

async function freezePackage(
  paths: ResolvedResearchPaths,
  params: {
    projectId: string;
    packageType: string;
    createdFrom: string[];
  },
): Promise<PackageRecord> {
  const payload = {
    project_id: params.projectId,
    package_type: params.packageType,
    created_from: params.createdFrom,
    state: "frozen",
  };
  return await runResearchRequest<PackageRecord>(paths, {
    method: "POST",
    route: "/v1/packages/freeze",
    body: payload,
    fallbackCommand: "freeze_package",
    fallbackPayload: payload,
  });
}

async function createMessage(
  paths: ResolvedResearchPaths,
  params: {
    projectId: string;
    fromAgent: CoordinatorRole;
    toAgent: string;
    messageType: string;
    content: string;
    artifactRef?: string;
  },
): Promise<unknown> {
  const payload = {
    project_id: params.projectId,
    from_agent: params.fromAgent,
    to_agent: params.toAgent,
    message_type: params.messageType,
    content: params.content,
    priority: "normal",
    ...(params.artifactRef ? { artifact_ref: params.artifactRef } : {}),
  };
  return await runResearchRequest(paths, {
    method: "POST",
    route: "/v1/messages",
    body: payload,
    fallbackCommand: "create_message",
    fallbackPayload: payload,
  });
}

async function completeTask(
  paths: ResolvedResearchPaths,
  params: {
    taskId: string;
    status: string;
    source: CoordinatorRole;
    eventType?: string;
    eventPayload?: Record<string, unknown>;
  },
): Promise<unknown> {
  const payload = {
    task_id: params.taskId,
    status: params.status,
    source: params.source,
    ...(params.eventType ? { event_type: params.eventType } : {}),
    ...(params.eventPayload ? { event_payload: params.eventPayload } : {}),
  };
  return await runResearchRequest(paths, {
    method: "POST",
    route: "/v1/tasks/status",
    body: payload,
    fallbackCommand: "update_task_status",
    fallbackPayload: payload,
  });
}

async function prepareInputPackage(
  paths: ResolvedResearchPaths,
  task: ClaimedTask,
  artifacts: ArtifactRecord[],
): Promise<PackageRecord | undefined> {
  if (task.owner_agent !== "writer") {
    return undefined;
  }
  const hypothesis = latestArtifactByType(artifacts, "hypotheses");
  const results = latestArtifactByType(artifacts, "results_summary");
  if (!hypothesis || !results) {
    throw new Error(`writer requires hypotheses and results_summary for project ${task.project_id}`);
  }
  return await freezePackage(paths, {
    projectId: task.project_id,
    packageType: "writing_input_package",
    createdFrom: [hypothesis.artifact_id, results.artifact_id],
  });
}

function upstreamDependenciesForRole(role: CoordinatorRole, artifacts: ArtifactRecord[]): string[] | undefined {
  if (role === "explorer") {
    return undefined;
  }
  if (role === "experiment") {
    const hypothesis = latestArtifactByType(artifacts, "hypotheses");
    return hypothesis ? [hypothesis.artifact_id] : undefined;
  }
  if (role === "writer") {
    const hypothesis = latestArtifactByType(artifacts, "hypotheses");
    const results = latestArtifactByType(artifacts, "results_summary");
    return [hypothesis?.artifact_id, results?.artifact_id].filter((value): value is string => Boolean(value));
  }
  const draft = latestArtifactByType(artifacts, "draft");
  return draft ? [draft.artifact_id] : undefined;
}

function packageForRole(
  role: CoordinatorRole,
  artifacts: ArtifactRecord[],
  artifactId: string,
): { packageType: string; createdFrom: string[] } | undefined {
  if (role === "explorer") {
    return {
      packageType: "research_package",
      createdFrom: [artifactId],
    };
  }
  if (role === "experiment") {
    const hypothesis = latestArtifactByType(artifacts, "hypotheses");
    return {
      packageType: "experiment_bundle",
      createdFrom: [hypothesis?.artifact_id, artifactId].filter((value): value is string => Boolean(value)),
    };
  }
  return undefined;
}

async function runSingleCoordinatorTask(
  api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
  task: ClaimedTask,
  consumeLimit: number,
  routeConfig?: RoleRoutingConfig,
): Promise<Record<string, unknown>> {
  const role = task.owner_agent;
  const projectStatus = await getProjectStatus(paths, task.project_id);
  const artifacts = await listArtifacts(paths, task.project_id);
  const inputPackage = await prepareInputPackage(paths, task, artifacts);
  await setAgentState(paths, {
    projectId: task.project_id,
    agentId: role,
    state: role === "reviewer" ? "review_pending" : "executing",
    currentTaskId: task.task_id,
  });

  const sessionKey = `${paths.coordinatorSessionPrefix}:${role}:${task.task_id}`;
  const run = await api.runtime.subagent.run({
    sessionKey,
    message: buildCoordinatorMessage({
      task,
      project: projectStatus.project,
      artifacts,
      inputPackageId: inputPackage?.package_id,
    }),
    extraSystemPrompt: buildCoordinatorSystemPrompt(role),
    deliver: false,
    ...(routeConfig?.provider ? { provider: routeConfig.provider } : {}),
    ...(routeConfig?.model ? { model: routeConfig.model } : {}),
    idempotencyKey: `research-core:${task.task_id}`,
  });
  const wait = await api.runtime.subagent.waitForRun({
    runId: run.runId,
    timeoutMs: paths.coordinatorRunTimeoutMs,
  });
  if (wait.status !== "ok") {
    throw new Error(wait.error || `subagent run did not complete successfully: ${wait.status}`);
  }
  const history = await api.runtime.subagent.getSessionMessages({
    sessionKey,
    limit: 100,
  });
  const result = parseCoordinatorResult(role, extractLatestAssistantText(history.messages));
  const artifactPath = buildArtifactPath(task);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, `${result.artifact_markdown.trim()}\n`, "utf8");

  const artifact = await registerArtifact(paths, {
    projectId: task.project_id,
    owner: role,
    artifactType: ROLE_ARTIFACT_TYPES[role],
    artifactPath,
    state: ROLE_ARTIFACT_STATES[role],
    upstreamDependencies: upstreamDependenciesForRole(role, artifacts),
    metadata: {
      task_id: task.task_id,
      session_key: sessionKey,
      summary: result.summary,
      input_package_id: inputPackage?.package_id,
    },
  });

  const packageSpec = packageForRole(role, artifacts, artifact.artifact_id);
  const frozenPackage = packageSpec
    ? await freezePackage(paths, {
        projectId: task.project_id,
        packageType: packageSpec.packageType,
        createdFrom: packageSpec.createdFrom,
      })
    : inputPackage;

  if (result.message?.content) {
    await createMessage(paths, {
      projectId: task.project_id,
      fromAgent: role,
      toAgent: result.message.to_agent,
      messageType: result.message.message_type,
      content: result.message.content,
      artifactRef: artifact.artifact_id,
    });
  }

  const completion = await completeTask(paths, {
    taskId: task.task_id,
    status: "done",
    source: role,
    eventType: result.event_type ?? ROLE_DEFAULT_EVENTS[role],
    eventPayload: {
      artifact_id: artifact.artifact_id,
      ...(frozenPackage?.package_id ? { package_id: frozenPackage.package_id } : {}),
      ...(result.message?.to_agent ? { next_agent: result.message.to_agent } : {}),
      ...(consumeLimit ? { consume_limit: consumeLimit } : {}),
    },
  });
  await setAgentState(paths, {
    projectId: task.project_id,
    agentId: role,
    state: "idle",
  });
  if (paths.coordinatorDeleteSession) {
    await api.runtime.subagent.deleteSession({
      sessionKey,
      deleteTranscript: true,
    });
  }
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    owner_agent: role,
    artifact_id: artifact.artifact_id,
    package_id: frozenPackage?.package_id,
    completion,
  };
}

async function blockTask(
  paths: ResolvedResearchPaths,
  task: ClaimedTask,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await completeTask(paths, {
    taskId: task.task_id,
    status: "blocked",
    source: task.owner_agent,
    eventType: "agent_blocked",
    eventPayload: {
      agent_id: task.owner_agent,
      task_id: task.task_id,
      reason: message,
    },
  });
  await setAgentState(paths, {
    projectId: task.project_id,
    agentId: task.owner_agent,
    state: "blocked",
    currentTaskId: task.task_id,
    lastError: message,
  });
}

export async function runResearchCoordinatorPass(
  api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
  params: CoordinatorPassParams = {},
): Promise<Record<string, unknown>> {
  if (paths.coordinatorExecution === "python") {
    const payload = {
      ...(params.projectId ? { project_id: params.projectId } : {}),
      ...(params.ownerAgent ? { owner_agent: params.ownerAgent } : {}),
      limit: params.limit ?? 1,
      consume_limit: params.consumeLimit ?? 20,
    };
    return await runResearchRequest<Record<string, unknown>>(paths, {
      method: "POST",
      route: "/v1/coordinators/run",
      body: payload,
      fallbackCommand: "run_coordinators",
      fallbackPayload: payload,
    });
  }

  const limit = Math.max(1, params.limit ?? 1);
  const consumeLimit = Math.max(1, params.consumeLimit ?? 20);
  const runs: Array<Record<string, unknown>> = [];
  for (let index = 0; index < limit; index += 1) {
    const task = await claimTask(paths, {
      projectId: params.projectId,
      ownerAgent: params.ownerAgent,
    });
    if (!task) {
      break;
    }
    try {
      runs.push(await runSingleCoordinatorTask(api, paths, task, consumeLimit, params.routeConfig));
    } catch (error) {
      await blockTask(paths, task, error);
      throw error;
    }
  }
  return {
    count: runs.length,
    runs,
    project_id: params.projectId,
    owner_agent: params.ownerAgent,
    idle: runs.length < limit,
    mode: "agent",
  };
}

export function createResearchCoordinatorService(
  api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
): OpenClawPluginService {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastControlError = "";
  const routingByRole = new Map<CoordinatorRole, RoleRoutingConfig>(
    COORDINATOR_ROLES.map((role) => [role, defaultRoleRouting(paths, role)]),
  );
  const workerPools = new Map<CoordinatorRole, Set<RoleWorkerHandle>>(
    COORDINATOR_ROLES.map((role) => [role, new Set<RoleWorkerHandle>()]),
  );

  const reconcileWorkers = (role: CoordinatorRole) => {
    const pool = workerPools.get(role);
    if (!pool) {
      return;
    }
    const routing = routingByRole.get(role) ?? defaultRoleRouting(paths, role);
    const desired =
      !stopped && paths.coordinatorAutoRun && paths.coordinatorExecution === "agent" && routing.active
        ? Math.max(1, routing.max_concurrency)
        : 0;
    while (pool.size > desired) {
      const handle = pool.values().next().value as RoleWorkerHandle | undefined;
      if (!handle) {
        break;
      }
      handle.stopRequested = true;
      pool.delete(handle);
    }
    while (pool.size < desired) {
      const handle: RoleWorkerHandle = {
        stopRequested: false,
        promise: Promise.resolve(),
      };
      handle.promise = (async () => {
        while (!stopped && !handle.stopRequested) {
          const activeRouting = routingByRole.get(role) ?? defaultRoleRouting(paths, role);
          if (!activeRouting.active) {
            break;
          }
          try {
            const result = await runResearchCoordinatorPass(api, paths, {
              ownerAgent: role,
              limit: 1,
              consumeLimit: 20,
              routeConfig: activeRouting,
            });
            const count = typeof result.count === "number" ? result.count : 0;
            if (count > 0) {
              api.logger.info(
                `[research-core] ${role} worker processed ${String(count)} task(s) with concurrency ${String(activeRouting.max_concurrency)}`,
              );
            }
            if (count === 0) {
              await sleep(paths.coordinatorPollMs);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.logger.warn(`[research-core] ${role} worker error: ${message}`);
            await sleep(paths.coordinatorPollMs);
          }
        }
      })().finally(() => {
        pool.delete(handle);
        if (!stopped) {
          reconcileWorkers(role);
        }
      });
      pool.add(handle);
    }
  };

  const refreshRouting = async () => {
    try {
      const fetched = await fetchAgentRouting(paths);
      for (const role of COORDINATOR_ROLES) {
        routingByRole.set(role, fetched.get(role) ?? defaultRoleRouting(paths, role));
      }
      lastControlError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastControlError) {
        api.logger.warn(
          `[research-core] failed to load agent routing from FastAPI control API, using local defaults: ${message}`,
        );
        lastControlError = message;
      }
      for (const role of COORDINATOR_ROLES) {
        if (!routingByRole.has(role)) {
          routingByRole.set(role, defaultRoleRouting(paths, role));
        }
      }
    }
    for (const role of COORDINATOR_ROLES) {
      reconcileWorkers(role);
    }
  };

  return {
    id: "research-core-coordinator-service",
    async start() {
      if (!paths.coordinatorAutoRun || paths.coordinatorExecution !== "agent") {
        api.logger.info("[research-core] coordinator service disabled");
        return;
      }
      stopped = false;
      timer = setInterval(() => {
        void refreshRouting();
      }, paths.coordinatorPollMs);
      timer.unref?.();
      void refreshRouting();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const pending: Promise<void>[] = [];
      for (const role of COORDINATOR_ROLES) {
        const pool = workerPools.get(role);
        if (!pool) {
          continue;
        }
        for (const handle of pool) {
          handle.stopRequested = true;
          pending.push(handle.promise);
        }
        pool.clear();
      }
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
    },
  };
}

export function asCoordinatorRole(value: string | undefined): CoordinatorRole | undefined {
  return isCoordinatorRole(value) ? value : undefined;
}
