PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
  owner_agent TEXT NOT NULL DEFAULT 'control-plane',
  workspace_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  owner_agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  dependency TEXT,
  acceptance TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  path TEXT NOT NULL,
  upstream_dependencies TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  UNIQUE(project_id, artifact_type, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_type
  ON artifacts(project_id, artifact_type);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  artifact_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  handoff_state TEXT NOT NULL DEFAULT 'queued',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT,
  acked_at TEXT,
  resolved_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_project_status
  ON messages(project_id, status);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_project_status
  ON events(project_id, status);

CREATE TABLE IF NOT EXISTS agent_states (
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  current_task_id TEXT,
  last_heartbeat_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, project_id),
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY(current_task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS frozen_packages (
  package_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'assembling',
  manifest_path TEXT NOT NULL,
  created_from TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  UNIQUE(project_id, package_type, version)
);

CREATE TABLE IF NOT EXISTS project_worktrees (
  worktree_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT,
  owner_agent TEXT NOT NULL DEFAULT 'runtime',
  isolation_mode TEXT NOT NULL DEFAULT 'detached',
  branch_name TEXT,
  canonical_workspace_path TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  created_at TEXT NOT NULL,
  activated_at TEXT,
  released_at TEXT,
  cleanup_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_worktrees_project_status
  ON project_worktrees(project_id, status);

CREATE INDEX IF NOT EXISTS idx_project_worktrees_task
  ON project_worktrees(task_id);

CREATE TABLE IF NOT EXISTS task_execution_contexts (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_agent TEXT NOT NULL,
  worktree_id TEXT,
  runtime_kind TEXT NOT NULL DEFAULT 'coordinator',
  status TEXT NOT NULL DEFAULT 'prepared',
  canonical_workspace_path TEXT NOT NULL,
  execution_workspace_path TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY(worktree_id) REFERENCES project_worktrees(worktree_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_task_execution_contexts_project_status
  ON task_execution_contexts(project_id, status);

CREATE TABLE IF NOT EXISTS task_completion_hooks (
  hook_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_completion_hooks_task_status
  ON task_completion_hooks(task_id, status);

CREATE TABLE IF NOT EXISTS agent_routing (
  role TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  model TEXT,
  auth_profile TEXT,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_profiles (
  profile_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'oauth',
  status TEXT NOT NULL DEFAULT 'needs_login',
  account_label TEXT,
  credential_ref TEXT,
  login_hint TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  last_tested_at TEXT,
  last_error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_profiles_provider
  ON auth_profiles(provider);

CREATE TABLE IF NOT EXISTS provider_observability (
  role TEXT PRIMARY KEY,
  provider TEXT,
  model TEXT,
  auth_profile TEXT,
  route_active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  requests_total INTEGER NOT NULL DEFAULT 0,
  success_total INTEGER NOT NULL DEFAULT 0,
  failure_total INTEGER NOT NULL DEFAULT 0,
  rate_limit_total INTEGER NOT NULL DEFAULT 0,
  failover_total INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  cooldown_until TEXT,
  last_error TEXT,
  last_error_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_message_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  UNIQUE(project_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_project_updated
  ON agent_threads(project_id, updated_at);

CREATE TABLE IF NOT EXISTS agent_thread_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  execution_context_task_id TEXT,
  sender_type TEXT NOT NULL,
  message_type TEXT NOT NULL,
  input_mode TEXT NOT NULL DEFAULT 'mixed',
  intent TEXT NOT NULL DEFAULT 'chat',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES agent_threads(thread_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_thread_created
  ON agent_thread_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_agent_created
  ON agent_thread_messages(project_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS agent_thread_attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attachment_type TEXT NOT NULL,
  name TEXT,
  path TEXT,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES agent_thread_messages(message_id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_thread_attachments_message
  ON agent_thread_attachments(message_id);

CREATE TABLE IF NOT EXISTS agent_operator_actions (
  action_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_operator_actions_agent_created
  ON agent_operator_actions(project_id, agent_id, created_at);
