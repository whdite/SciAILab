import type {
  AgentThreadMessageCreatePayload,
  AgentRoutingResponse,
  AgentWorkspaceActionPayload,
  AgentWorkspaceActionResponse,
  AgentWorkspaceMessageCreateResponse,
  AgentWorkspaceOverviewResponse,
  AgentWorkspaceThreadResponse,
  AgentWorkspaceUploadResponse,
  CompletionHookListResponse,
  ControlActionResult,
  MessageCreatePayload,
  MessageHandoffStatePayload,
  MessageRecord,
  AuthProfileTestResponse,
  AuthProfilesResponse,
  ModelCatalogResponse,
  ExecutionContextListResponse,
  HealthResponse,
  ProviderObservabilityResponse,
  ProjectListResponse,
  ProjectStatusResponse,
  ReadModelResponse,
  RuntimeSettingsResponse,
  SchedulerStateResponse,
  WorktreeListResponse,
} from "./types";

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildUrl(path: string, baseUrl = ""): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${String(response.status)}`);
  }
  return (await response.json()) as T;
}

export async function fetchHealth(baseUrl = ""): Promise<HealthResponse> {
  const response = await fetch(buildUrl("/health", baseUrl));
  return readJson<HealthResponse>(response);
}

export async function fetchRuntimeSettings(baseUrl = ""): Promise<RuntimeSettingsResponse> {
  const response = await fetch(buildUrl("/v1/runtime-settings", baseUrl));
  return readJson<RuntimeSettingsResponse>(response);
}

export async function updateRuntimeSettings(
  payload: Partial<RuntimeSettingsResponse["settings"]>,
  baseUrl = "",
): Promise<RuntimeSettingsResponse> {
  const response = await fetch(buildUrl("/v1/runtime-settings", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<RuntimeSettingsResponse>(response);
}

export async function fetchReadModel(
  projectId: string,
  limit: number,
  baseUrl = "",
): Promise<ReadModelResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(
    buildUrl(`/v1/projects/${encodeURIComponent(projectId)}/read-model?${query.toString()}`, baseUrl),
  );
  return readJson<ReadModelResponse>(response);
}

export async function fetchProjects(limit = 50, baseUrl = ""): Promise<ProjectListResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(buildUrl(`/v1/projects?${query.toString()}`, baseUrl));
  return readJson<ProjectListResponse>(response);
}

export async function fetchAgentWorkspaceOverview(
  projectId: string,
  limit = 50,
  baseUrl = "",
): Promise<AgentWorkspaceOverviewResponse> {
  const query = new URLSearchParams({
    project_id: projectId,
    limit: String(limit),
  });
  const response = await fetch(buildUrl(`/v1/agents/overview?${query.toString()}`, baseUrl));
  return readJson<AgentWorkspaceOverviewResponse>(response);
}

export async function fetchAgentWorkspaceThread(
  projectId: string,
  agentId: string,
  limit = 80,
  baseUrl = "",
): Promise<AgentWorkspaceThreadResponse> {
  const query = new URLSearchParams({
    project_id: projectId,
    limit: String(limit),
  });
  const response = await fetch(
    buildUrl(`/v1/agents/${encodeURIComponent(agentId)}/thread?${query.toString()}`, baseUrl),
  );
  return readJson<AgentWorkspaceThreadResponse>(response);
}

export async function createAgentWorkspaceMessage(
  agentId: string,
  payload: AgentThreadMessageCreatePayload,
  baseUrl = "",
): Promise<AgentWorkspaceMessageCreateResponse> {
  const response = await fetch(buildUrl(`/v1/agents/${encodeURIComponent(agentId)}/thread/messages`, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<AgentWorkspaceMessageCreateResponse>(response);
}

export async function uploadAgentWorkspaceFile(
  projectId: string,
  agentId: string,
  file: File,
  baseUrl = "",
): Promise<AgentWorkspaceUploadResponse> {
  const form = new FormData();
  form.set("project_id", projectId);
  form.set("agent_id", agentId);
  form.set("file", file);
  const response = await fetch(buildUrl("/v1/agents/uploads", baseUrl), {
    method: "POST",
    body: form,
  });
  return readJson<AgentWorkspaceUploadResponse>(response);
}

export async function runAgentWorkspaceAction(
  agentId: string,
  payload: AgentWorkspaceActionPayload,
  baseUrl = "",
): Promise<AgentWorkspaceActionResponse> {
  const response = await fetch(buildUrl(`/v1/agents/${encodeURIComponent(agentId)}/actions`, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<AgentWorkspaceActionResponse>(response);
}

export async function createProject(
  payload: {
    name: string;
    goal: string;
    owner_agent?: string;
    project_id?: string;
    bootstrap_flow?: boolean;
  },
  baseUrl = "",
): Promise<ProjectStatusResponse> {
  const response = await fetch(buildUrl("/v1/projects", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<ProjectStatusResponse>(response);
}

export async function fetchAgentRouting(baseUrl = ""): Promise<AgentRoutingResponse> {
  const response = await fetch(buildUrl("/v1/control/agent-routing", baseUrl));
  return readJson<AgentRoutingResponse>(response);
}

export async function updateAgentRouting(
  routes: Array<Record<string, unknown>>,
  baseUrl = "",
): Promise<AgentRoutingResponse> {
  const response = await fetch(buildUrl("/v1/control/agent-routing", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ routes }),
  });
  return readJson<AgentRoutingResponse>(response);
}

export async function setAgentActivation(
  payload: {
    role: string;
    active: boolean;
    max_concurrency?: number;
  },
  baseUrl = "",
): Promise<AgentRoutingResponse> {
  const response = await fetch(buildUrl("/v1/control/agent-activation", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<AgentRoutingResponse>(response);
}

export async function fetchSchedulerState(baseUrl = ""): Promise<SchedulerStateResponse> {
  const response = await fetch(buildUrl("/v1/control/scheduler-state", baseUrl));
  return readJson<SchedulerStateResponse>(response);
}

export async function fetchWorktrees(
  params: {
    projectId?: string;
    taskId?: string;
    status?: string;
    ownerAgent?: string;
    limit?: number;
  } = {},
  baseUrl = "",
): Promise<WorktreeListResponse> {
  const query = new URLSearchParams();
  if (params.projectId) {
    query.set("project_id", params.projectId);
  }
  if (params.taskId) {
    query.set("task_id", params.taskId);
  }
  if (params.status) {
    query.set("status", params.status);
  }
  if (params.ownerAgent) {
    query.set("owner_agent", params.ownerAgent);
  }
  query.set("limit", String(params.limit ?? 50));
  const response = await fetch(buildUrl(`/v1/worktrees?${query.toString()}`, baseUrl));
  return readJson<WorktreeListResponse>(response);
}

export async function fetchExecutionContexts(
  params: {
    projectId?: string;
    status?: string;
    ownerAgent?: string;
    limit?: number;
  } = {},
  baseUrl = "",
): Promise<ExecutionContextListResponse> {
  const query = new URLSearchParams();
  if (params.projectId) {
    query.set("project_id", params.projectId);
  }
  if (params.status) {
    query.set("status", params.status);
  }
  if (params.ownerAgent) {
    query.set("owner_agent", params.ownerAgent);
  }
  query.set("limit", String(params.limit ?? 50));
  const response = await fetch(buildUrl(`/v1/execution-contexts?${query.toString()}`, baseUrl));
  return readJson<ExecutionContextListResponse>(response);
}

export async function fetchCompletionHooks(
  params: {
    projectId?: string;
    taskId?: string;
    status?: string;
    limit?: number;
  } = {},
  baseUrl = "",
): Promise<CompletionHookListResponse> {
  const query = new URLSearchParams();
  if (params.projectId) {
    query.set("project_id", params.projectId);
  }
  if (params.taskId) {
    query.set("task_id", params.taskId);
  }
  if (params.status) {
    query.set("status", params.status);
  }
  query.set("limit", String(params.limit ?? 50));
  const response = await fetch(buildUrl(`/v1/completion-hooks?${query.toString()}`, baseUrl));
  return readJson<CompletionHookListResponse>(response);
}

async function runTaskControlAction(
  action: "checkpoint" | "merge" | "cleanup" | "attach",
  taskId: string,
  baseUrl = "",
): Promise<ControlActionResult> {
  const response = await fetch(buildUrl(`/v1/control/actions/${action}`, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ task_id: taskId }),
  });
  return readJson<ControlActionResult>(response);
}

export async function checkpointTask(taskId: string, baseUrl = ""): Promise<ControlActionResult> {
  return runTaskControlAction("checkpoint", taskId, baseUrl);
}

export async function mergeTask(taskId: string, baseUrl = ""): Promise<ControlActionResult> {
  return runTaskControlAction("merge", taskId, baseUrl);
}

export async function cleanupTask(taskId: string, baseUrl = ""): Promise<ControlActionResult> {
  return runTaskControlAction("cleanup", taskId, baseUrl);
}

export async function attachTask(taskId: string, baseUrl = ""): Promise<ControlActionResult> {
  return runTaskControlAction("attach", taskId, baseUrl);
}

export async function createMessage(
  payload: MessageCreatePayload,
  baseUrl = "",
): Promise<MessageRecord> {
  const response = await fetch(buildUrl("/v1/messages", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<MessageRecord>(response);
}

export async function markMessageRead(messageId: string, baseUrl = ""): Promise<MessageRecord> {
  const response = await fetch(buildUrl(`/v1/messages/${encodeURIComponent(messageId)}/mark-read`, baseUrl), {
    method: "POST",
  });
  return readJson<MessageRecord>(response);
}

export async function ackMessage(messageId: string, baseUrl = ""): Promise<MessageRecord> {
  const response = await fetch(buildUrl(`/v1/messages/${encodeURIComponent(messageId)}/ack`, baseUrl), {
    method: "POST",
  });
  return readJson<MessageRecord>(response);
}

export async function setMessageHandoffState(
  messageId: string,
  payload: MessageHandoffStatePayload,
  baseUrl = "",
): Promise<MessageRecord> {
  const response = await fetch(buildUrl(`/v1/messages/${encodeURIComponent(messageId)}/handoff-state`, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<MessageRecord>(response);
}

export async function fetchAuthProfiles(baseUrl = ""): Promise<AuthProfilesResponse> {
  const response = await fetch(buildUrl("/v1/control/auth-profiles", baseUrl));
  return readJson<AuthProfilesResponse>(response);
}

export async function fetchModelCatalog(baseUrl = ""): Promise<ModelCatalogResponse> {
  const response = await fetch(buildUrl("/v1/control/model-catalog", baseUrl));
  return readJson<ModelCatalogResponse>(response);
}

export async function updateAuthProfiles(
  profiles: Array<Record<string, unknown>>,
  baseUrl = "",
): Promise<AuthProfilesResponse> {
  const response = await fetch(buildUrl("/v1/control/auth-profiles", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profiles }),
  });
  return readJson<AuthProfilesResponse>(response);
}

export async function upsertApiKeyAuthProfile(
  payload: {
    provider: string;
    api_key: string;
    profile_id?: string | null;
    label?: string | null;
    account_label?: string | null;
    login_hint?: string | null;
    set_last_good?: boolean;
  },
  baseUrl = "",
): Promise<AuthProfilesResponse> {
  const response = await fetch(buildUrl("/v1/control/auth-profiles/api-key", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return readJson<AuthProfilesResponse>(response);
}

export async function deleteAuthProfile(profileId: string, baseUrl = ""): Promise<AuthProfilesResponse> {
  const response = await fetch(buildUrl(`/v1/control/auth-profiles/${encodeURIComponent(profileId)}`, baseUrl), {
    method: "DELETE",
  });
  return readJson<AuthProfilesResponse>(response);
}

export async function testAuthProfile(profileId: string, baseUrl = ""): Promise<AuthProfileTestResponse> {
  const response = await fetch(buildUrl("/v1/control/auth-profiles/test", baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profile_id: profileId }),
  });
  return readJson<AuthProfileTestResponse>(response);
}

export async function fetchProviderObservability(baseUrl = ""): Promise<ProviderObservabilityResponse> {
  const response = await fetch(buildUrl("/v1/control/provider-observability", baseUrl));
  return readJson<ProviderObservabilityResponse>(response);
}
