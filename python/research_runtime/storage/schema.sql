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
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS agent_routing (
  role TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  model TEXT,
  auth_profile TEXT,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
