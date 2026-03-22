import type { Locale } from "./i18n";

export type AppTab = "trace" | "control" | "projects" | "settings" | "agents";

export type ControlSyncState = {
  ok: boolean;
  error: string | null;
  generated_at: string | null;
  auth_store_path?: string | null;
  usage_updated_at?: string | null;
  usage_error?: string | null;
};

export type UsageWindowRecord = {
  label: string;
  used_percent: number;
  reset_at: string | null;
  reset_at_ms: number | null;
};

export type UiSettings = {
  apiBaseUrl: string;
  gatewayUrl: string;
  defaultProjectId: string;
  traceLimit: number;
  autoRefreshSeconds: number;
  locale: Locale;
};

export type RuntimeSettings = {
  handoff_pending_timeout_seconds: number;
  handoff_blocked_timeout_seconds: number;
};

export type RuntimeSettingsResponse = {
  settings: RuntimeSettings;
  updated_at: string | null;
};

export type ReadModelResponse = {
  project_id: string;
  project: {
    project_id: string;
    name: string;
    goal: string;
    owner_agent: string;
    status: string;
    created_at: string;
    updated_at: string;
  };
  summary: {
    counts: Record<string, number>;
    task_status_counts: Record<string, number>;
    task_owner_counts: Record<string, number>;
    event_type_counts: Record<string, number>;
    artifact_type_counts: Record<string, number>;
    package_type_counts: Record<string, number>;
    agent_state_counts: Record<string, number>;
    worktree_status_counts: Record<string, number>;
    execution_status_counts: Record<string, number>;
    latest_event_type: string | null;
  };
  read_model: {
    active_tasks: TaskRecord[];
    blocked_tasks: TaskRecord[];
    latest_artifacts: Record<string, ArtifactRecord>;
    latest_packages: Record<string, PackageRecord>;
    agent_states: AgentStateRecord[];
    active_worktrees: WorktreeRecord[];
    execution_contexts: ExecutionContextRecord[];
    recent_hooks: CompletionHookRecord[];
    pending_inbox: MessageRecord[];
    teammate_messages: MessageRecord[];
    recent_messages: MessageRecord[];
    handoff_metrics: HandoffMetrics;
    handoff_sla: HandoffSla;
    filters: {
      event_types: string[];
      statuses: string[];
      owner_agents: string[];
    };
  };
  trace: {
    timeline: TimelineItem[];
    recent_events: EventRecord[];
    recent_tasks: TaskRecord[];
  };
};

export type ProjectListItem = {
  project: {
    project_id: string;
    name: string;
    goal: string;
    owner_agent: string;
    status: string;
    workspace_path: string;
    created_at: string;
    updated_at: string;
  };
  summary: {
    artifacts: number;
    messages: number;
    events: number;
    tasks: number;
    packages: number;
    worktrees: number;
    execution_contexts: number;
    active_tasks: number;
    non_idle_agents: number;
    latest_event_type: string | null;
  };
};

export type ProjectListResponse = {
  projects: ProjectListItem[];
  count: number;
};

export type ProjectStatusResponse = {
  project: {
    project_id: string;
    name: string;
    goal: string;
    status: string;
    owner_agent: string;
    workspace_path: string;
    created_at: string;
    updated_at: string;
  };
  summary: {
    artifacts: number;
    messages: number;
    events: number;
    tasks: number;
    packages: number;
    worktrees: number;
    execution_contexts: number;
  };
};

export type WorktreeRecord = {
  worktree_id: string;
  project_id: string;
  task_id: string | null;
  owner_agent: string;
  isolation_mode: string;
  branch_name: string | null;
  canonical_workspace_path: string;
  worktree_path: string;
  status: string;
  created_at: string;
  activated_at: string | null;
  released_at: string | null;
  cleanup_at: string | null;
  metadata: Record<string, unknown>;
};

export type ExecutionContextRecord = {
  task_id: string;
  project_id: string;
  owner_agent: string;
  worktree_id: string | null;
  runtime_kind: string;
  status: string;
  canonical_workspace_path: string;
  execution_workspace_path: string;
  prepared_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  metadata: Record<string, unknown>;
};

export type CompletionHookRecord = {
  hook_id: string;
  task_id: string;
  project_id: string;
  hook_type: string;
  status: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type TaskRecord = {
  task_id: string;
  project_id: string;
  title: string;
  scope: string;
  owner_agent: string;
  dependency: string | null;
  acceptance: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type ArtifactRecord = {
  artifact_id: string;
  project_id: string;
  artifact_type: string;
  owner: string;
  path: string;
  state: string;
  version: number;
  upstream_dependencies: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PackageRecord = {
  package_id: string;
  project_id: string;
  package_type: string;
  manifest_path: string;
  state: string;
  version: number;
  created_from_list: string[];
  created_at: string;
};

export type MessageRecord = {
  message_id: string;
  project_id: string;
  from_agent: string;
  to_agent: string;
  message_type: string;
  priority: string;
  artifact_ref: string | null;
  content: string;
  status: string;
  created_at: string;
  updated_at?: string | null;
  handoff_state?: string | null;
  read_at?: string | null;
  acked_at?: string | null;
  resolved_at?: string | null;
};

export type HandoffMetrics = {
  open_count: number;
  pending_count: number;
  blocked_count: number;
  aged_pending_count: number;
  unacked_count: number;
  busy_agent_count: number;
  oldest_pending_age_seconds: number | null;
  oldest_blocked_age_seconds: number | null;
  pending_timeout_seconds: number;
  blocked_timeout_seconds: number;
  state_counts: Record<string, number>;
  agent_counts: Record<string, number>;
};

export type AgentSlaRecord = {
  agent_id: string;
  open_count: number;
  pending_count: number;
  queued_count: number;
  seen_count: number;
  accepted_count: number;
  blocked_count: number;
  aged_pending_count: number;
  unacked_count: number;
  oldest_pending_age_seconds: number | null;
  oldest_blocked_age_seconds: number | null;
  avg_pending_age_seconds: number | null;
  last_message_at: string | null;
  sla_status: string;
};

export type HandoffSla = {
  generated_at: string;
  pending_timeout_seconds: number;
  blocked_timeout_seconds: number;
  agents: AgentSlaRecord[];
};

export type EventRecord = {
  event_id: string;
  project_id: string;
  event_type: string;
  source: string;
  status: string;
  payload: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
};

export type AgentStateRecord = {
  agent_id: string;
  project_id: string;
  state: string;
  current_task_id: string | null;
  last_error: string | null;
  last_heartbeat_at: string | null;
  updated_at: string;
};

export type TimelineItem = {
  kind: string;
  id: string;
  timestamp: string;
  title: string;
  summary: string;
  status: string | null;
  owner: string | null;
  owner_agent: string | null;
  event_type: string | null;
  details: Record<string, unknown>;
};

export type AgentRoutingRecord = {
  role: string;
  active: boolean;
  provider: string;
  model: string;
  auth_profile: string | null;
  max_concurrency: number;
  updated_at?: string;
};

export type AgentRoutingResponse = {
  routes: AgentRoutingRecord[];
  count: number;
};

export type AuthProfileRecord = {
  profile_id: string;
  provider: string;
  label: string;
  auth_type: string;
  status: string;
  account_label: string | null;
  credential_ref: string | null;
  login_hint: string | null;
  scopes: string[];
  last_tested_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
  source?: string;
  openclaw_exists?: boolean;
  openclaw_status?: string | null;
  openclaw_status_reason?: string | null;
  openclaw_store_path?: string | null;
  openclaw_account_label?: string | null;
  last_used_at?: string | null;
  cooldown_until?: string | null;
  cooldown_active?: boolean;
  cooldown_seconds_remaining?: number;
  disabled_until?: string | null;
  disabled_active?: boolean;
  disabled_seconds_remaining?: number;
  disabled_reason?: string | null;
  error_count?: number;
  last_failure_at?: string | null;
  failure_counts?: Record<string, number>;
  last_good_for_provider?: boolean;
  quota_provider?: string | null;
  quota_display_name?: string | null;
  quota_plan?: string | null;
  quota_error?: string | null;
  quota_updated_at?: string | null;
  quota_windows?: UsageWindowRecord[];
};

export type AuthProfilesResponse = {
  profiles: AuthProfileRecord[];
  count: number;
  sync?: ControlSyncState;
};

export type AuthProfileTestResponse = {
  profile: AuthProfileRecord | null;
  status: string;
  message: string;
  checked_at: string;
};

export type ModelCatalogProvider = {
  id: string;
  model_count: number;
  available_count: number;
  local_count: number;
};

export type ModelCatalogEntry = {
  key: string;
  provider: string;
  model_id: string;
  name: string;
  input: string;
  context_window: number | null;
  local: boolean;
  available: boolean;
  missing: boolean;
  tags: string[];
};

export type ModelCatalogResponse = {
  ok: boolean;
  generated_at: string | null;
  count: number;
  provider_count: number;
  providers: ModelCatalogProvider[];
  models: ModelCatalogEntry[];
  error: string | null;
};

export type SchedulerRoleState = AgentRoutingRecord & {
  queue: Record<string, number>;
  agent_state: AgentStateRecord | null;
  worktrees: Record<string, number>;
};

export type SchedulerStateResponse = {
  roles: SchedulerRoleState[];
  queue_counts: Record<string, Record<string, number>>;
  worktree_counts: Record<string, Record<string, number>>;
};

export type ProviderObservabilityRole = {
  role: string;
  provider: string | null;
  model: string | null;
  auth_profile: string | null;
  route_active: boolean;
  status: string;
  requests_total: number;
  success_total: number;
  failure_total: number;
  rate_limit_total: number;
  failover_total: number;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  cooldown_until: string | null;
  cooldown_active: boolean;
  cooldown_seconds_remaining: number;
  last_error: string | null;
  last_error_reason: string | null;
  updated_at: string | null;
  auth_profile_status: string | null;
  auth_profile_label: string | null;
  auth_profile_source?: string | null;
  auth_profile_openclaw_status?: string | null;
  disabled_active?: boolean;
  disabled_until?: string | null;
  disabled_reason?: string | null;
  quota_provider?: string | null;
  quota_display_name?: string | null;
  quota_plan?: string | null;
  quota_error?: string | null;
  quota_updated_at?: string | null;
  quota_windows?: UsageWindowRecord[];
};

export type ProviderObservabilityResponse = {
  roles: ProviderObservabilityRole[];
  count: number;
  totals: {
    requests_total: number;
    success_total: number;
    failure_total: number;
    rate_limit_total: number;
    failover_total: number;
    cooldown_active: number;
  };
  sync?: ControlSyncState;
};

export type HealthResponse = {
  status: string;
  db_path: string;
  workspace_root: string;
  worktree_root: string;
  auto_consume_events: boolean;
};

export type WorktreeListResponse = {
  project_id?: string | null;
  task_id?: string | null;
  status?: string | null;
  worktrees: WorktreeRecord[];
};

export type ExecutionContextListResponse = {
  project_id?: string | null;
  status?: string | null;
  execution_contexts: ExecutionContextRecord[];
};

export type CompletionHookListResponse = {
  project_id?: string | null;
  task_id?: string | null;
  status?: string | null;
  hooks: CompletionHookRecord[];
};

export type ControlActionResult = {
  hook?: CompletionHookRecord;
  package?: PackageRecord;
  event?: EventRecord;
  worktree?: WorktreeRecord;
  execution_context?: ExecutionContextRecord;
  task?: TaskRecord;
  inbox?: MessageRecord[];
  outgoing?: MessageRecord[];
  hooks?: CompletionHookRecord[];
  checkpoint_manifest_path?: string;
  merge_manifest_path?: string;
  copied_files?: string[];
};

export type AgentWorkspaceOverviewItem = {
  agent_id: string;
  role: string;
  state: string;
  current_task_id: string | null;
  current_task_title: string | null;
  current_task_status: string | null;
  open_handoffs: number;
  blocked_handoffs: number;
  timed_out_pending_handoffs: number;
  sla_status: string;
  execution_context: ExecutionContextRecord | null;
  provider: string | null;
  model: string | null;
  auth_profile: string | null;
  last_event_at: string | null;
  last_thread_message_at: string | null;
};

export type AgentWorkspaceOverviewResponse = {
  project: {
    project_id: string;
    name: string;
    goal: string;
    status: string;
  };
  agents: AgentWorkspaceOverviewItem[];
  count: number;
};

export type AgentThreadRecord = {
  thread_id: string;
  project_id: string;
  agent_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  metadata_json?: string | null;
  metadata: Record<string, unknown>;
};

export type AgentThreadAttachmentRecord = {
  attachment_id?: string;
  message_id?: string;
  project_id?: string;
  attachment_type: string;
  name: string | null;
  path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  metadata_json?: string | null;
  metadata: Record<string, unknown>;
  created_at?: string | null;
};

export type AgentThreadMessageRecord = {
  message_id: string;
  thread_id: string;
  project_id: string;
  agent_id: string;
  task_id: string | null;
  execution_context_task_id: string | null;
  sender_type: string;
  message_type: string;
  input_mode: string;
  intent: string;
  content: string;
  status: string;
  metadata_json?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  attachments: AgentThreadAttachmentRecord[];
};

export type AgentOperatorActionRecord = {
  action_id: string;
  project_id: string;
  agent_id: string;
  task_id: string | null;
  action_type: string;
  payload_json?: string | null;
  result_json?: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AgentWorkspaceContext = {
  project: {
    project_id: string;
    name: string;
    goal: string;
  };
  agent_state: AgentStateRecord | null;
  route: AgentRoutingRecord | null;
  current_task: TaskRecord | null;
  execution_context: ExecutionContextRecord | null;
  worktree: WorktreeRecord | null;
  recent_artifacts: ArtifactRecord[];
  recent_packages: PackageRecord[];
  recent_handoffs: MessageRecord[];
  recent_actions: AgentOperatorActionRecord[];
};

export type AgentWorkspaceThreadResponse = {
  project_id: string;
  agent_id: string;
  thread: AgentThreadRecord;
  messages: AgentThreadMessageRecord[];
  context: AgentWorkspaceContext;
};

export type AgentWorkspaceMessageCreateResponse = {
  thread: AgentThreadRecord;
  message: AgentThreadMessageRecord;
  event: EventRecord;
  reply?: {
    thread: AgentThreadRecord;
    message: AgentThreadMessageRecord;
  } | null;
};

export type AgentWorkspaceUploadResponse = AgentThreadAttachmentRecord;

export type AgentWorkspaceActionResponse = {
  action: AgentOperatorActionRecord;
  thread_message: AgentThreadMessageRecord;
  result: Record<string, unknown>;
};

export type AgentThreadAttachmentCreatePayload = {
  attachment_type: string;
  name?: string | null;
  path?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  metadata?: Record<string, unknown> | null;
};

export type AgentThreadMentionCreatePayload = {
  kind: string;
  value: string;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AgentThreadMessageCreatePayload = {
  project_id: string;
  content: string;
  input_mode?: string;
  intent?: string;
  task_id?: string | null;
  execution_context_task_id?: string | null;
  attachments?: AgentThreadAttachmentCreatePayload[];
  mentions?: AgentThreadMentionCreatePayload[];
  metadata?: Record<string, unknown> | null;
};

export type AgentWorkspaceActionPayload = {
  project_id: string;
  task_id?: string | null;
  action_type: string;
  payload?: Record<string, unknown> | null;
};

export type MessageCreatePayload = {
  project_id: string;
  from_agent: string;
  to_agent: string;
  message_type: string;
  content: string;
  priority?: string;
  artifact_ref?: string | null;
};

export type MessageHandoffStatePayload = {
  handoff_state: string;
  status?: string | null;
};

export type SaveState = "idle" | "saving" | "saved" | "error";
