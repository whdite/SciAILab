from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from research_runtime.openclaw_sync import (
    get_openclaw_live_snapshot,
    match_usage_provider,
    upsert_openclaw_api_key_profile,
)
from research_runtime.orchestrator.state_machine import (
    ensure_valid_agent_state,
    ensure_valid_artifact_transition,
    ensure_valid_task_status,
    ensure_valid_task_transition,
)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
COORDINATOR_ROLES = ("explorer", "experiment", "writer", "reviewer")
PENDING_HANDOFF_TIMEOUT_SECONDS = 30 * 60
BLOCKED_HANDOFF_TIMEOUT_SECONDS = 15 * 60
RUNTIME_SETTINGS_DEFAULTS = {
    "handoff_pending_timeout_seconds": PENDING_HANDOFF_TIMEOUT_SECONDS,
    "handoff_blocked_timeout_seconds": BLOCKED_HANDOFF_TIMEOUT_SECONDS,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized or "project"


def connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: str) -> dict:
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with connect(db_path) as conn:
        conn.executescript(schema)
        _ensure_message_schema(conn)
    return {"db_path": str(Path(db_path).resolve()), "initialized": True}


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row["name"]) for row in rows}


def _ensure_message_schema(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "messages")
    alterations = [
        ("handoff_state", "ALTER TABLE messages ADD COLUMN handoff_state TEXT NOT NULL DEFAULT 'queued'"),
        ("updated_at", "ALTER TABLE messages ADD COLUMN updated_at TEXT"),
        ("read_at", "ALTER TABLE messages ADD COLUMN read_at TEXT"),
        ("acked_at", "ALTER TABLE messages ADD COLUMN acked_at TEXT"),
        ("resolved_at", "ALTER TABLE messages ADD COLUMN resolved_at TEXT"),
    ]
    for column, statement in alterations:
        if column not in columns:
            conn.execute(statement)
    conn.execute(
        """
        UPDATE messages
        SET
          handoff_state = CASE
            WHEN handoff_state IS NULL OR handoff_state = '' THEN
              CASE
                WHEN status = 'read' THEN 'seen'
                WHEN status = 'acked' THEN 'accepted'
                WHEN status = 'resolved' THEN 'completed'
                WHEN status = 'blocked' THEN 'blocked'
                ELSE 'queued'
              END
            ELSE handoff_state
          END,
          updated_at = COALESCE(updated_at, created_at),
          read_at = CASE
            WHEN read_at IS NULL AND status IN ('read', 'acked', 'resolved') THEN COALESCE(updated_at, created_at)
            ELSE read_at
          END,
          acked_at = CASE
            WHEN acked_at IS NULL AND status IN ('acked', 'resolved') THEN COALESCE(updated_at, created_at)
            ELSE acked_at
          END,
          resolved_at = CASE
            WHEN resolved_at IS NULL AND status = 'resolved' THEN COALESCE(updated_at, created_at)
            ELSE resolved_at
          END
        """
    )


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def _coerce_runtime_setting_value(setting_key: str, value: object) -> int:
    if setting_key not in RUNTIME_SETTINGS_DEFAULTS:
        raise ValueError(f"unsupported runtime setting: {setting_key}")
    try:
        normalized = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid runtime setting value for {setting_key}: {value}") from exc
    if normalized < 60 or normalized > 7 * 24 * 60 * 60:
        raise ValueError(f"runtime setting out of range for {setting_key}: {normalized}")
    return normalized


def get_runtime_settings(db_path: str) -> dict:
    init_db(db_path)
    settings = dict(RUNTIME_SETTINGS_DEFAULTS)
    updated_at: str | None = None
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT setting_key, value_json, updated_at
            FROM runtime_settings
            ORDER BY setting_key ASC
            """
        ).fetchall()
    for row in rows:
        setting_key = str(row["setting_key"])
        if setting_key not in settings:
            continue
        parsed = _parse_json_text(str(row["value_json"]), settings[setting_key])
        try:
            settings[setting_key] = _coerce_runtime_setting_value(setting_key, parsed)
        except ValueError:
            settings[setting_key] = RUNTIME_SETTINGS_DEFAULTS[setting_key]
        row_updated_at = str(row["updated_at"] or "")
        if row_updated_at and (updated_at is None or row_updated_at > updated_at):
            updated_at = row_updated_at
    return {
        "settings": settings,
        "updated_at": updated_at,
    }


def upsert_runtime_settings(db_path: str, settings_update: dict[str, object]) -> dict:
    init_db(db_path)
    if not settings_update:
        return get_runtime_settings(db_path)
    now = utc_now()
    normalized_settings = {
        setting_key: _coerce_runtime_setting_value(setting_key, value)
        for setting_key, value in settings_update.items()
    }
    with connect(db_path) as conn:
        for setting_key, value in normalized_settings.items():
            conn.execute(
                """
                INSERT INTO runtime_settings (setting_key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(setting_key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
                """,
                (
                    setting_key,
                    json.dumps(value),
                    now,
                ),
            )
    return get_runtime_settings(db_path)


def ensure_coordinator_role(role: str) -> str:
    normalized = role.strip().lower()
    if normalized not in COORDINATOR_ROLES:
        raise ValueError(f"unsupported coordinator role: {role}")
    return normalized


def default_agent_route(role: str) -> dict:
    return {
        "role": ensure_coordinator_role(role),
        "active": True,
        "provider": None,
        "model": None,
        "auth_profile": None,
        "max_concurrency": 1,
        "updated_at": None,
    }


def default_auth_profile(profile_id: str, provider: str | None = None) -> dict:
    normalized_provider = (provider or profile_id.split(":", 1)[0]).strip().lower() or "unknown"
    return {
        "profile_id": profile_id.strip(),
        "provider": normalized_provider,
        "label": profile_id.strip(),
        "auth_type": "oauth",
        "status": "needs_login",
        "account_label": None,
        "credential_ref": None,
        "login_hint": None,
        "scopes": [],
        "last_tested_at": None,
        "last_error": None,
        "metadata": {},
        "created_at": None,
        "updated_at": None,
    }


def default_provider_observation(role: str) -> dict:
    return {
        "role": ensure_coordinator_role(role),
        "provider": None,
        "model": None,
        "auth_profile": None,
        "route_active": True,
        "status": "unknown",
        "requests_total": 0,
        "success_total": 0,
        "failure_total": 0,
        "rate_limit_total": 0,
        "failover_total": 0,
        "consecutive_failures": 0,
        "last_attempt_at": None,
        "last_success_at": None,
        "last_failure_at": None,
        "cooldown_until": None,
        "cooldown_active": False,
        "cooldown_seconds_remaining": 0,
        "last_error": None,
        "last_error_reason": None,
        "updated_at": None,
    }


def ensure_project_dirs(workspace_root: str, project_id: str, name: str, goal: str) -> str:
    project_root = Path(workspace_root) / project_id
    for relative in (
        "artifacts/explorer",
        "artifacts/experiment",
        "artifacts/writer",
        "artifacts/reviewer",
        "packages/research_package",
        "packages/experiment_bundle",
        "packages/writing_input_package",
        "inbox",
        "outbox",
        "runs",
        "memory",
    ):
        (project_root / relative).mkdir(parents=True, exist_ok=True)

    project_md = project_root / "project.md"
    if not project_md.exists():
        project_md.write_text(
            "\n".join(
                [
                    f"# {name}",
                    "",
                    f"- project_id: {project_id}",
                    f"- goal: {goal}",
                    f"- created_at: {utc_now()}",
                    "",
                    "## Notes",
                    "",
                ]
            ),
            encoding="utf-8",
        )

    return str(project_root.resolve())


def create_project(
    db_path: str,
    workspace_root: str,
    *,
    name: str,
    goal: str = "",
    owner_agent: str = "control-plane",
    project_id: str | None = None,
    bootstrap_flow: bool = True,
) -> dict:
    init_db(db_path)

    cleaned_name = name.strip()
    if not cleaned_name:
        raise ValueError("project name is required")

    resolved_project_id = project_id.strip() if project_id else ""
    if not resolved_project_id:
        resolved_project_id = f"{slugify(cleaned_name)}-{uuid4().hex[:8]}"

    now = utc_now()
    workspace_path = ensure_project_dirs(workspace_root, resolved_project_id, cleaned_name, goal)

    with connect(db_path) as conn:
        exists = conn.execute(
            "SELECT 1 FROM projects WHERE project_id = ?",
            (resolved_project_id,),
        ).fetchone()
        if exists:
            raise ValueError(f"project already exists: {resolved_project_id}")

        conn.execute(
            """
            INSERT INTO projects (
              project_id, name, goal, status, owner_agent, workspace_path, created_at, updated_at
            ) VALUES (?, ?, ?, 'created', ?, ?, ?, ?)
            """,
            (
                resolved_project_id,
                cleaned_name,
                goal,
                owner_agent,
                workspace_path,
                now,
                now,
            ),
        )

    if bootstrap_flow:
        task = create_task(
            db_path,
            project_id=resolved_project_id,
            title="Produce initial hypotheses and research package",
            scope="explorer",
            owner_agent="explorer",
            acceptance="Produce a hypotheses artifact that is ready for experiment handoff.",
            status="todo",
        )
        set_agent_state(
            db_path,
            project_id=resolved_project_id,
            agent_id="explorer",
            state="planning",
            current_task_id=str(task["task_id"]),
        )

    return get_project_status(db_path, resolved_project_id)


def get_project_status(db_path: str, project_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT * FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")

        def count(table: str) -> int:
            query = f"SELECT COUNT(*) AS count FROM {table} WHERE project_id = ?"
            row = conn.execute(query, (project_id,)).fetchone()
            return int(row["count"]) if row else 0

        return {
            "project": row_to_dict(project),
            "summary": {
                "artifacts": count("artifacts"),
                "messages": count("messages"),
                "events": count("events"),
                "tasks": count("tasks"),
                "packages": count("frozen_packages"),
                "worktrees": count("project_worktrees"),
                "execution_contexts": count("task_execution_contexts"),
            },
        }


def get_project_record(db_path: str, project_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT * FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    resolved = row_to_dict(project)
    if resolved is None:
        raise ValueError(f"project not found: {project_id}")
    return resolved


def _read_worktree_row(row: sqlite3.Row | None) -> dict | None:
    worktree = row_to_dict(row)
    if worktree is None:
        return None
    return {
        **worktree,
        "metadata": _parse_json_text(worktree.get("metadata_json"), {}),
    }


def _read_execution_context_row(row: sqlite3.Row | None) -> dict | None:
    context = row_to_dict(row)
    if context is None:
        return None
    return {
        **context,
        "metadata": _parse_json_text(context.get("metadata_json"), {}),
    }


def create_project_worktree(
    db_path: str,
    *,
    project_id: str,
    owner_agent: str,
    canonical_workspace_path: str,
    worktree_path: str,
    isolation_mode: str,
    branch_name: str | None = None,
    task_id: str | None = None,
    status: str = "prepared",
    metadata: dict | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    worktree_id = f"wt_{uuid4().hex}"
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")
        if task_id:
            task = conn.execute(
                "SELECT task_id FROM tasks WHERE task_id = ? AND project_id = ?",
                (task_id, project_id),
            ).fetchone()
            if task is None:
                raise ValueError(f"task not found for project {project_id}: {task_id}")
        conn.execute(
            """
            INSERT INTO project_worktrees (
              worktree_id, project_id, task_id, owner_agent, isolation_mode, branch_name,
              canonical_workspace_path, worktree_path, status, created_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                worktree_id,
                project_id,
                task_id,
                owner_agent,
                isolation_mode,
                branch_name,
                canonical_workspace_path,
                worktree_path,
                status,
                now,
                json.dumps(metadata or {}),
            ),
        )
        row = conn.execute(
            "SELECT * FROM project_worktrees WHERE worktree_id = ?",
            (worktree_id,),
        ).fetchone()
    worktree = _read_worktree_row(row)
    if worktree is None:
        raise RuntimeError("worktree insert failed")
    return worktree


def get_project_worktree(db_path: str, worktree_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM project_worktrees WHERE worktree_id = ?",
            (worktree_id,),
        ).fetchone()
    worktree = _read_worktree_row(row)
    if worktree is None:
        raise ValueError(f"worktree not found: {worktree_id}")
    return worktree


def list_project_worktrees(
    db_path: str,
    *,
    project_id: str | None = None,
    task_id: str | None = None,
    status: str | None = None,
    owner_agent: str | None = None,
    limit: int = 100,
) -> dict:
    init_db(db_path)
    query = """
        SELECT *
        FROM project_worktrees
        WHERE 1 = 1
    """
    params: list[object] = []
    if project_id:
        query += " AND project_id = ?"
        params.append(project_id)
    if task_id:
        query += " AND task_id = ?"
        params.append(task_id)
    if status:
        query += " AND status = ?"
        params.append(status)
    if owner_agent:
        query += " AND owner_agent = ?"
        params.append(owner_agent)
    query += " ORDER BY created_at DESC, worktree_id DESC LIMIT ?"
    params.append(max(1, min(limit, 500)))
    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "task_id": task_id,
        "status": status,
        "worktrees": [_read_worktree_row(row) for row in rows if row is not None],
    }


def update_project_worktree(
    db_path: str,
    worktree_id: str,
    *,
    status: str | None = None,
    task_id: str | None = None,
    metadata: dict | None = None,
    activated: bool = False,
    released: bool = False,
    cleaned: bool = False,
) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        current = conn.execute(
            "SELECT * FROM project_worktrees WHERE worktree_id = ?",
            (worktree_id,),
        ).fetchone()
        current_record = _read_worktree_row(current)
        if current_record is None:
            raise ValueError(f"worktree not found: {worktree_id}")
        next_metadata = dict(current_record.get("metadata") or {})
        if metadata:
            next_metadata.update(metadata)
        updates: list[str] = []
        params: list[object] = []
        if status is not None:
            updates.append("status = ?")
            params.append(status)
        if task_id is not None:
            updates.append("task_id = ?")
            params.append(task_id)
        if metadata is not None:
            updates.append("metadata_json = ?")
            params.append(json.dumps(next_metadata))
        if activated:
            updates.append("activated_at = COALESCE(activated_at, ?)")
            params.append(now)
        if released:
            updates.append("released_at = ?")
            params.append(now)
        if cleaned:
            updates.append("cleanup_at = ?")
            params.append(now)
        if not updates:
            return current_record
        params.extend([worktree_id])
        conn.execute(
            f"UPDATE project_worktrees SET {', '.join(updates)} WHERE worktree_id = ?",
            tuple(params),
        )
        row = conn.execute(
            "SELECT * FROM project_worktrees WHERE worktree_id = ?",
            (worktree_id,),
        ).fetchone()
    worktree = _read_worktree_row(row)
    if worktree is None:
        raise RuntimeError("worktree update failed")
    return worktree


def upsert_task_execution_context(
    db_path: str,
    *,
    task_id: str,
    project_id: str,
    owner_agent: str,
    canonical_workspace_path: str,
    execution_workspace_path: str,
    worktree_id: str | None = None,
    runtime_kind: str = "coordinator",
    status: str = "prepared",
    metadata: dict | None = None,
    started: bool = False,
    finished: bool = False,
) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")
        task = conn.execute(
            "SELECT task_id FROM tasks WHERE task_id = ? AND project_id = ?",
            (task_id, project_id),
        ).fetchone()
        if task is None:
            raise ValueError(f"task not found for project {project_id}: {task_id}")
        current = conn.execute(
            "SELECT * FROM task_execution_contexts WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        current_record = _read_execution_context_row(current)
        next_metadata = dict(current_record.get("metadata") or {}) if current_record else {}
        if metadata:
            next_metadata.update(metadata)
        prepared_at = (
            str(current_record.get("prepared_at"))
            if current_record and current_record.get("prepared_at")
            else now
        )
        started_at = (
            str(current_record.get("started_at"))
            if current_record and current_record.get("started_at")
            else (now if started else None)
        )
        finished_at = (
            now
            if finished
            else (str(current_record.get("finished_at")) if current_record else None)
        )
        conn.execute(
            """
            INSERT INTO task_execution_contexts (
              task_id, project_id, owner_agent, worktree_id, runtime_kind, status,
              canonical_workspace_path, execution_workspace_path, prepared_at, started_at,
              finished_at, updated_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id) DO UPDATE SET
              project_id = excluded.project_id,
              owner_agent = excluded.owner_agent,
              worktree_id = excluded.worktree_id,
              runtime_kind = excluded.runtime_kind,
              status = excluded.status,
              canonical_workspace_path = excluded.canonical_workspace_path,
              execution_workspace_path = excluded.execution_workspace_path,
              prepared_at = excluded.prepared_at,
              started_at = excluded.started_at,
              finished_at = excluded.finished_at,
              updated_at = excluded.updated_at,
              metadata_json = excluded.metadata_json
            """,
            (
                task_id,
                project_id,
                owner_agent,
                worktree_id,
                runtime_kind,
                status,
                canonical_workspace_path,
                execution_workspace_path,
                prepared_at,
                started_at,
                finished_at,
                now,
                json.dumps(next_metadata),
            ),
        )
        row = conn.execute(
            "SELECT * FROM task_execution_contexts WHERE task_id = ?",
            (task_id,),
        ).fetchone()
    context = _read_execution_context_row(row)
    if context is None:
        raise RuntimeError("task execution context upsert failed")
    return context


def get_task_execution_context(db_path: str, task_id: str) -> dict | None:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM task_execution_contexts WHERE task_id = ?",
            (task_id,),
        ).fetchone()
    return _read_execution_context_row(row)


def list_task_execution_contexts(
    db_path: str,
    *,
    project_id: str | None = None,
    status: str | None = None,
    owner_agent: str | None = None,
    limit: int = 100,
) -> dict:
    init_db(db_path)
    query = """
        SELECT *
        FROM task_execution_contexts
        WHERE 1 = 1
    """
    params: list[object] = []
    if project_id:
        query += " AND project_id = ?"
        params.append(project_id)
    if status:
        query += " AND status = ?"
        params.append(status)
    if owner_agent:
        query += " AND owner_agent = ?"
        params.append(owner_agent)
    query += " ORDER BY updated_at DESC, task_id DESC LIMIT ?"
    params.append(max(1, min(limit, 500)))
    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "status": status,
        "execution_contexts": [_read_execution_context_row(row) for row in rows if row is not None],
    }


def _read_task_completion_hook_row(row: sqlite3.Row | None) -> dict | None:
    hook = row_to_dict(row)
    if hook is None:
        return None
    return {
        **hook,
        "payload": _parse_json_text(hook.get("payload_json"), {}),
    }


def create_task_completion_hook(
    db_path: str,
    *,
    task_id: str,
    project_id: str,
    hook_type: str,
    status: str = "pending",
    payload: dict | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    hook_id = f"hook_{uuid4().hex}"
    with connect(db_path) as conn:
        task = conn.execute(
            "SELECT task_id FROM tasks WHERE task_id = ? AND project_id = ?",
            (task_id, project_id),
        ).fetchone()
        if task is None:
            raise ValueError(f"task not found for project {project_id}: {task_id}")
        conn.execute(
            """
            INSERT INTO task_completion_hooks (
              hook_id, task_id, project_id, hook_type, status, payload_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                hook_id,
                task_id,
                project_id,
                hook_type,
                status,
                json.dumps(payload or {}),
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM task_completion_hooks WHERE hook_id = ?",
            (hook_id,),
        ).fetchone()
    hook = _read_task_completion_hook_row(row)
    if hook is None:
        raise RuntimeError("task completion hook insert failed")
    return hook


def update_task_completion_hook(
    db_path: str,
    hook_id: str,
    *,
    status: str | None = None,
    payload: dict | None = None,
    completed: bool = False,
) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        current = conn.execute(
            "SELECT * FROM task_completion_hooks WHERE hook_id = ?",
            (hook_id,),
        ).fetchone()
        current_record = _read_task_completion_hook_row(current)
        if current_record is None:
            raise ValueError(f"task completion hook not found: {hook_id}")
        next_payload = dict(current_record.get("payload") or {})
        if payload:
            next_payload.update(payload)
        updates = ["updated_at = ?"]
        params: list[object] = [now]
        if status is not None:
            updates.append("status = ?")
            params.append(status)
        if payload is not None:
            updates.append("payload_json = ?")
            params.append(json.dumps(next_payload))
        if completed:
            updates.append("completed_at = ?")
            params.append(now)
        params.append(hook_id)
        conn.execute(
            f"UPDATE task_completion_hooks SET {', '.join(updates)} WHERE hook_id = ?",
            tuple(params),
        )
        row = conn.execute(
            "SELECT * FROM task_completion_hooks WHERE hook_id = ?",
            (hook_id,),
        ).fetchone()
    hook = _read_task_completion_hook_row(row)
    if hook is None:
        raise RuntimeError("task completion hook update failed")
    return hook


def list_task_completion_hooks(
    db_path: str,
    *,
    project_id: str | None = None,
    task_id: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict:
    init_db(db_path)
    query = """
        SELECT *
        FROM task_completion_hooks
        WHERE 1 = 1
    """
    params: list[object] = []
    if project_id:
        query += " AND project_id = ?"
        params.append(project_id)
    if task_id:
        query += " AND task_id = ?"
        params.append(task_id)
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY updated_at DESC, hook_id DESC LIMIT ?"
    params.append(max(1, min(limit, 500)))
    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "task_id": task_id,
        "status": status,
        "hooks": [_read_task_completion_hook_row(row) for row in rows if row is not None],
    }


def build_attach_payload(db_path: str, task_id: str) -> dict:
    task = get_task_record(db_path, task_id)
    execution_context = get_task_execution_context(db_path, task_id)
    worktree = (
        get_project_worktree(db_path, str(execution_context["worktree_id"]))
        if execution_context and execution_context.get("worktree_id")
        else None
    )
    owner_agent = str(task["owner_agent"])
    project_id = str(task["project_id"])
    inbox = [
        message
        for message in list_messages(db_path, project_id, to_agent=owner_agent, limit=20)["messages"]
        if str(message.get("status")) != "resolved"
    ]
    outgoing = list_messages(db_path, project_id, from_agent=owner_agent, limit=20)["messages"]
    hooks = list_task_completion_hooks(db_path, task_id=task_id, limit=20)["hooks"]
    return {
        "task": task,
        "execution_context": execution_context,
        "worktree": worktree,
        "inbox": inbox,
        "outgoing": outgoing,
        "hooks": hooks,
    }


def list_projects(db_path: str, *, limit: int = 50) -> dict:
    init_db(db_path)
    resolved_limit = max(1, min(limit, 200))
    with connect(db_path) as conn:
        project_rows = conn.execute(
            """
            SELECT *
            FROM projects
            ORDER BY updated_at DESC, created_at DESC, project_id ASC
            LIMIT ?
            """,
            (resolved_limit,),
        ).fetchall()

        projects: list[dict] = []
        for row in project_rows:
            project = row_to_dict(row)
            if project is None:
                continue
            project_id = str(project["project_id"])

            def count(table: str) -> int:
                query = f"SELECT COUNT(*) AS count FROM {table} WHERE project_id = ?"
                count_row = conn.execute(query, (project_id,)).fetchone()
                return int(count_row["count"]) if count_row else 0

            active_tasks_row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM tasks
                WHERE project_id = ? AND status != 'done'
                """,
                (project_id,),
            ).fetchone()
            non_idle_agents_row = conn.execute(
                """
                SELECT COUNT(*) AS count
                FROM agent_states
                WHERE project_id = ? AND state != 'idle'
                """,
                (project_id,),
            ).fetchone()
            latest_event_row = conn.execute(
                """
                SELECT event_type
                FROM events
                WHERE project_id = ?
                ORDER BY created_at DESC, event_id DESC
                LIMIT 1
                """,
                (project_id,),
            ).fetchone()

            projects.append(
                {
                    "project": project,
                    "summary": {
                        "artifacts": count("artifacts"),
                        "messages": count("messages"),
                        "events": count("events"),
                        "tasks": count("tasks"),
                        "packages": count("frozen_packages"),
                        "worktrees": count("project_worktrees"),
                        "execution_contexts": count("task_execution_contexts"),
                        "active_tasks": int(active_tasks_row["count"]) if active_tasks_row else 0,
                        "non_idle_agents": int(non_idle_agents_row["count"]) if non_idle_agents_row else 0,
                        "latest_event_type": str(latest_event_row["event_type"]) if latest_event_row else None,
                    },
                }
            )

    return {
        "projects": projects,
        "count": len(projects),
    }


def next_artifact_version(conn: sqlite3.Connection, project_id: str, artifact_type: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM artifacts
        WHERE project_id = ? AND artifact_type = ?
        """,
        (project_id, artifact_type),
    ).fetchone()
    return int(row["max_version"]) + 1 if row else 1


def register_artifact(
    db_path: str,
    *,
    project_id: str,
    artifact_type: str,
    owner: str,
    path: str,
    state: str = "draft",
    version: int | None = None,
    upstream_dependencies: list[str] | None = None,
    metadata: dict | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")

        resolved_version = version or next_artifact_version(conn, project_id, artifact_type)
        artifact_id = f"{project_id}:{artifact_type}:v{resolved_version}"
        conn.execute(
            """
            INSERT INTO artifacts (
              artifact_id, project_id, artifact_type, owner, version, state, path,
              upstream_dependencies, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                artifact_id,
                project_id,
                artifact_type,
                owner,
                resolved_version,
                state,
                path,
                json.dumps(upstream_dependencies or []),
                json.dumps(metadata or {}),
                now,
                now,
            ),
        )
        conn.execute(
            "UPDATE projects SET updated_at = ? WHERE project_id = ?",
            (now, project_id),
        )
        row = conn.execute(
            "SELECT * FROM artifacts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()

    artifact = row_to_dict(row)
    if artifact is None:
        raise RuntimeError("artifact insert failed")
    return artifact


def list_artifacts(db_path: str, project_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM artifacts
            WHERE project_id = ?
            ORDER BY artifact_type ASC, version DESC
            """,
            (project_id,),
        ).fetchall()
    return {
        "project_id": project_id,
        "artifacts": [row_to_dict(row) for row in rows],
    }


def create_message(
    db_path: str,
    *,
    project_id: str,
    from_agent: str,
    to_agent: str,
    message_type: str,
    content: str,
    priority: str = "normal",
    artifact_ref: str | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    message_id = f"msg_{uuid4().hex}"
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")

        conn.execute(
            """
            INSERT INTO messages (
              message_id, project_id, from_agent, to_agent, message_type,
              priority, artifact_ref, status, handoff_state, content, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?)
            """,
            (
                message_id,
                project_id,
                from_agent,
                to_agent,
                message_type,
                priority,
                artifact_ref,
                content,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM messages WHERE message_id = ?",
            (message_id,),
        ).fetchone()
    message = row_to_dict(row)
    if message is None:
        raise RuntimeError("message insert failed")
    return message


def list_messages(
    db_path: str,
    project_id: str,
    *,
    from_agent: str | None = None,
    to_agent: str | None = None,
    status: str | None = None,
    handoff_state: str | None = None,
    limit: int | None = None,
) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM messages
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if from_agent:
        query += " AND from_agent = ?"
        params.append(from_agent)
    if to_agent:
        query += " AND to_agent = ?"
        params.append(to_agent)
    if status:
        query += " AND status = ?"
        params.append(status)
    if handoff_state:
        query += " AND handoff_state = ?"
        params.append(handoff_state)
    query += " ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC"
    if limit is not None:
        query += " LIMIT ?"
        params.append(max(1, min(limit, 500)))

    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "messages": [row_to_dict(row) for row in rows],
    }


def _derive_message_status_from_handoff_state(handoff_state: str) -> str:
    normalized = handoff_state.strip().lower()
    if normalized == "seen":
        return "read"
    if normalized == "accepted":
        return "acked"
    if normalized == "blocked":
        return "blocked"
    if normalized == "completed":
        return "resolved"
    return "pending"


def update_message_state(
    db_path: str,
    *,
    message_id: str,
    status: str | None = None,
    handoff_state: str | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    project_id = ""
    previous_status = None
    previous_handoff_state = None
    with connect(db_path) as conn:
        current = conn.execute(
            "SELECT * FROM messages WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        current_record = row_to_dict(current)
        if current_record is None:
            raise ValueError(f"message not found: {message_id}")
        project_id = str(current_record.get("project_id") or "")
        previous_status = current_record.get("status")
        previous_handoff_state = current_record.get("handoff_state")

        next_handoff_state = (
            handoff_state.strip().lower()
            if isinstance(handoff_state, str) and handoff_state.strip()
            else str(current_record.get("handoff_state") or "queued")
        )
        next_status = (
            status.strip().lower()
            if isinstance(status, str) and status.strip()
            else _derive_message_status_from_handoff_state(next_handoff_state)
        )
        updates: list[str] = ["status = ?", "handoff_state = ?", "updated_at = ?"]
        params: list[object] = [next_status, next_handoff_state, now]

        current_read_at = current_record.get("read_at")
        current_acked_at = current_record.get("acked_at")
        current_resolved_at = current_record.get("resolved_at")
        read_at = current_read_at or (now if next_status in {"read", "acked", "resolved"} else None)
        acked_at = current_acked_at or (now if next_status in {"acked", "resolved"} else None)
        resolved_at = current_resolved_at or (now if next_status == "resolved" else None)

        updates.extend(["read_at = ?", "acked_at = ?", "resolved_at = ?"])
        params.extend([read_at, acked_at, resolved_at, message_id])

        conn.execute(
            f"UPDATE messages SET {', '.join(updates)} WHERE message_id = ?",
            tuple(params),
        )
        row = conn.execute(
            "SELECT * FROM messages WHERE message_id = ?",
            (message_id,),
        ).fetchone()
    message = row_to_dict(row)
    if message is None:
        raise RuntimeError("message update failed")
    event_type = "message_handoff_state_changed"
    if str(message.get("status")) == "read" and str(previous_status) != "read":
        event_type = "message_marked_read"
    elif str(message.get("status")) == "acked" and str(previous_status) != "acked":
        event_type = "message_acked"
    if (
        str(previous_status) != str(message.get("status"))
        or str(previous_handoff_state) != str(message.get("handoff_state"))
    ):
        emit_event(
            db_path,
            project_id=project_id,
            event_type=event_type,
            source="control-plane",
            payload={
                "message_id": message_id,
                "from_agent": message.get("from_agent"),
                "to_agent": message.get("to_agent"),
                "message_type": message.get("message_type"),
                "previous_status": previous_status,
                "status": message.get("status"),
                "previous_handoff_state": previous_handoff_state,
                "handoff_state": message.get("handoff_state"),
                "updated_at": message.get("updated_at"),
            },
        )
    return message


def emit_event(
    db_path: str,
    *,
    project_id: str,
    event_type: str,
    source: str,
    payload: dict | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    event_id = f"evt_{uuid4().hex}"
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")

        conn.execute(
            """
            INSERT INTO events (
              event_id, project_id, event_type, source, payload, status, created_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                event_id,
                project_id,
                event_type,
                source,
                json.dumps(payload or {}),
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
    event = row_to_dict(row)
    if event is None:
        raise RuntimeError("event insert failed")
    return event


def list_events(
    db_path: str,
    project_id: str,
    *,
    status: str | None = None,
    event_type: str | None = None,
) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM events
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if status:
        query += " AND status = ?"
        params.append(status)
    if event_type:
        query += " AND event_type = ?"
        params.append(event_type)
    query += " ORDER BY created_at DESC"

    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "events": [row_to_dict(row) for row in rows],
    }


def next_package_version(conn: sqlite3.Connection, project_id: str, package_type: str) -> int:
    row = conn.execute(
        """
        SELECT COALESCE(MAX(version), 0) AS max_version
        FROM frozen_packages
        WHERE project_id = ? AND package_type = ?
        """,
        (project_id, package_type),
    ).fetchone()
    return int(row["max_version"]) + 1 if row else 1


def freeze_package(
    db_path: str,
    workspace_root: str,
    *,
    project_id: str,
    package_type: str,
    created_from: list[str] | None = None,
    state: str = "frozen",
) -> dict:
    init_db(db_path)
    now = utc_now()
    package_dir = Path(workspace_root) / project_id / "packages" / package_type
    package_dir.mkdir(parents=True, exist_ok=True)

    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")

        version = next_package_version(conn, project_id, package_type)
        package_id = f"{project_id}:{package_type}:v{version}"
        manifest_file_name = package_id.replace(":", "__") + ".json"
        manifest_path = package_dir / manifest_file_name
        manifest = {
            "package_id": package_id,
            "project_id": project_id,
            "package_type": package_type,
            "version": version,
            "state": state,
            "created_from": created_from or [],
            "created_at": now,
        }
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        conn.execute(
            """
            INSERT INTO frozen_packages (
              package_id, project_id, package_type, version, state,
              manifest_path, created_from, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                package_id,
                project_id,
                package_type,
                version,
                state,
                str(manifest_path.resolve()),
                json.dumps(created_from or []),
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM frozen_packages WHERE package_id = ?",
            (package_id,),
        ).fetchone()
    package = row_to_dict(row)
    if package is None:
        raise RuntimeError("package insert failed")
    return package


def list_packages(db_path: str, project_id: str, *, package_type: str | None = None) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM frozen_packages
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if package_type:
        query += " AND package_type = ?"
        params.append(package_type)
    query += " ORDER BY created_at DESC"

    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "packages": [row_to_dict(row) for row in rows],
    }


def create_task(
    db_path: str,
    *,
    project_id: str,
    title: str,
    scope: str,
    owner_agent: str,
    dependency: str | None = None,
    acceptance: str | None = None,
    status: str = "todo",
) -> dict:
    init_db(db_path)
    ensure_valid_task_status(status)
    now = utc_now()
    task_id = f"task_{uuid4().hex}"
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")
        conn.execute(
            """
            INSERT INTO tasks (
              task_id, project_id, title, scope, owner_agent, status,
              dependency, acceptance, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                project_id,
                title,
                scope,
                owner_agent,
                status,
                dependency,
                acceptance,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    task = row_to_dict(row)
    if task is None:
        raise RuntimeError("task insert failed")
    return task


def list_tasks(
    db_path: str,
    project_id: str,
    *,
    owner_agent: str | None = None,
    status: str | None = None,
) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM tasks
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if owner_agent:
        query += " AND owner_agent = ?"
        params.append(owner_agent)
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC"
    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "tasks": [row_to_dict(row) for row in rows],
    }


def get_task_record(db_path: str, task_id: str) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    task = row_to_dict(row)
    if task is None:
        raise ValueError(f"task not found: {task_id}")
    return task


def claim_next_task(
    db_path: str,
    *,
    project_id: str | None = None,
    owner_agent: str | None = None,
) -> dict | None:
    init_db(db_path)
    query = """
        SELECT
          tasks.*,
          projects.name AS project_name,
          projects.goal AS project_goal,
          projects.workspace_path AS workspace_path
        FROM tasks
        INNER JOIN projects ON projects.project_id = tasks.project_id
        WHERE tasks.status IN ('todo', 'retry')
    """
    params: list[object] = []
    if project_id:
        query += " AND tasks.project_id = ?"
        params.append(project_id)
    if owner_agent:
        query += " AND tasks.owner_agent = ?"
        params.append(owner_agent)
    query += " ORDER BY tasks.created_at ASC LIMIT 1"

    with connect(db_path) as conn:
        row = conn.execute(query, tuple(params)).fetchone()
        if row is None:
            return None
        task = {key: row[key] for key in row.keys()}
        updated = conn.execute(
            """
            UPDATE tasks
            SET status = 'in_progress', updated_at = ?
            WHERE task_id = ? AND status IN ('todo', 'retry')
            """,
            (utc_now(), task["task_id"]),
        )
        if updated.rowcount != 1:
            return None
    return task


def list_agent_states(
    db_path: str,
    project_id: str,
    *,
    agent_id: str | None = None,
    state: str | None = None,
) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM agent_states
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if agent_id:
        query += " AND agent_id = ?"
        params.append(agent_id)
    if state:
        query += " AND state = ?"
        params.append(state)
    query += " ORDER BY updated_at DESC, agent_id ASC"
    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "agent_states": [row_to_dict(row) for row in rows],
    }


def update_task_status(
    db_path: str,
    *,
    task_id: str,
    status: str,
) -> dict:
    init_db(db_path)
    ensure_valid_task_status(status)
    now = utc_now()
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        if row is None:
            raise ValueError(f"task not found: {task_id}")
        current = row_to_dict(row)
        if current is None:
            raise RuntimeError("task lookup failed")
        ensure_valid_task_transition(str(current["status"]), status)
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
            (status, now, task_id),
        )
        updated = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    task = row_to_dict(updated)
    if task is None:
        raise RuntimeError("task update failed")
    return task


def transition_artifact_state(
    db_path: str,
    *,
    artifact_id: str,
    next_state: str,
) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM artifacts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()
        if row is None:
            raise ValueError(f"artifact not found: {artifact_id}")
        current = row_to_dict(row)
        if current is None:
            raise RuntimeError("artifact lookup failed")
        ensure_valid_artifact_transition(str(current["state"]), next_state)
        conn.execute(
            "UPDATE artifacts SET state = ?, updated_at = ? WHERE artifact_id = ?",
            (next_state, now, artifact_id),
        )
        updated = conn.execute(
            "SELECT * FROM artifacts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()
    artifact = row_to_dict(updated)
    if artifact is None:
        raise RuntimeError("artifact transition failed")
    return artifact


def set_agent_state(
    db_path: str,
    *,
    project_id: str,
    agent_id: str,
    state: str,
    current_task_id: str | None = None,
    last_error: str | None = None,
) -> dict:
    init_db(db_path)
    ensure_valid_agent_state(state)
    now = utc_now()
    with connect(db_path) as conn:
        project = conn.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            raise ValueError(f"project not found: {project_id}")
        conn.execute(
            """
            INSERT INTO agent_states (
              agent_id, project_id, state, current_task_id, last_heartbeat_at, last_error, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_id, project_id) DO UPDATE SET
              state = excluded.state,
              current_task_id = excluded.current_task_id,
              last_heartbeat_at = excluded.last_heartbeat_at,
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
            """,
            (
                agent_id,
                project_id,
                state,
                current_task_id,
                now,
                last_error,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM agent_states WHERE agent_id = ? AND project_id = ?",
            (agent_id, project_id),
        ).fetchone()
    agent_state = row_to_dict(row)
    if agent_state is None:
        raise RuntimeError("agent state upsert failed")
    return agent_state


def _read_agent_route_row(conn: sqlite3.Connection, role: str) -> dict | None:
    row = conn.execute("SELECT * FROM agent_routing WHERE role = ?", (role,)).fetchone()
    route = row_to_dict(row)
    if route is None:
        return None
    return {
        **route,
        "active": bool(route["active"]),
        "max_concurrency": int(route["max_concurrency"]),
    }


def _read_auth_profile_row(conn: sqlite3.Connection, profile_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM auth_profiles WHERE profile_id = ?", (profile_id,)).fetchone()
    if row is None:
        return None
    profile = row_to_dict(row)
    if profile is None:
        return None
    return {
        **profile,
        "scopes": _parse_json_text(profile.get("scopes"), []),
        "metadata": _parse_json_text(profile.get("metadata_json"), {}),
    }


def _read_provider_observation_row(conn: sqlite3.Connection, role: str) -> dict | None:
    row = conn.execute("SELECT * FROM provider_observability WHERE role = ?", (role,)).fetchone()
    if row is None:
        return None
    observation = row_to_dict(row)
    if observation is None:
        return None
    return _decorate_provider_observation(observation)


def _decorate_provider_observation(observation: dict) -> dict:
    cooldown_until = str(observation.get("cooldown_until") or "").strip()
    cooldown_active = False
    cooldown_seconds_remaining = 0
    if cooldown_until:
        try:
            deadline = datetime.fromisoformat(cooldown_until)
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            remaining = int((deadline - datetime.now(timezone.utc)).total_seconds())
            if remaining > 0:
                cooldown_active = True
                cooldown_seconds_remaining = remaining
        except ValueError:
            cooldown_until = ""
    return {
        **observation,
        "route_active": bool(observation.get("route_active")),
        "requests_total": int(observation.get("requests_total") or 0),
        "success_total": int(observation.get("success_total") or 0),
        "failure_total": int(observation.get("failure_total") or 0),
        "rate_limit_total": int(observation.get("rate_limit_total") or 0),
        "failover_total": int(observation.get("failover_total") or 0),
        "consecutive_failures": int(observation.get("consecutive_failures") or 0),
        "cooldown_until": cooldown_until or None,
        "cooldown_active": cooldown_active,
        "cooldown_seconds_remaining": cooldown_seconds_remaining,
    }


def _sync_provider_observation_with_route(
    conn: sqlite3.Connection,
    *,
    role: str,
    provider: str | None,
    model: str | None,
    auth_profile: str | None,
    route_active: bool,
    updated_at: str,
) -> None:
    current = _read_provider_observation_row(conn, role) or default_provider_observation(role)
    next_status = str(current.get("status") or "unknown")
    if route_active and provider:
        if next_status in {"unknown", "disabled"}:
            next_status = "configured"
    elif not route_active:
        next_status = "disabled"
    conn.execute(
        """
        INSERT INTO provider_observability (
          role, provider, model, auth_profile, route_active, status,
          requests_total, success_total, failure_total, rate_limit_total, failover_total,
          consecutive_failures, last_attempt_at, last_success_at, last_failure_at,
          cooldown_until, last_error, last_error_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          auth_profile = excluded.auth_profile,
          route_active = excluded.route_active,
          status = excluded.status,
          updated_at = excluded.updated_at
        """,
        (
            role,
            provider,
            model,
            auth_profile,
            1 if route_active else 0,
            next_status,
            int(current.get("requests_total") or 0),
            int(current.get("success_total") or 0),
            int(current.get("failure_total") or 0),
            int(current.get("rate_limit_total") or 0),
            int(current.get("failover_total") or 0),
            int(current.get("consecutive_failures") or 0),
            current.get("last_attempt_at"),
            current.get("last_success_at"),
            current.get("last_failure_at"),
            current.get("cooldown_until"),
            current.get("last_error"),
            current.get("last_error_reason"),
            updated_at,
        ),
    )


def _classify_provider_error_reason(error_message: str) -> str:
    normalized = error_message.strip().lower()
    if not normalized:
        return "unknown"
    if "rate limit" in normalized or "429" in normalized or "quota" in normalized:
        return "rate_limit"
    if "cooldown" in normalized or "cooling down" in normalized:
        return "rate_limit"
    if "billing" in normalized or "payment" in normalized or "credit" in normalized:
        return "billing"
    if "auth" in normalized or "unauthorized" in normalized or "forbidden" in normalized or "token" in normalized:
        return "auth"
    if "timeout" in normalized or "timed out" in normalized or "econn" in normalized or "network" in normalized:
        return "timeout"
    if "overload" in normalized or "overloaded" in normalized or "503" in normalized or "529" in normalized:
        return "overloaded"
    if "fallback" in normalized or "failover" in normalized:
        return "unknown"
    return "unknown"


def _normalize_failure_counts(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    for key, raw_count in value.items():
        try:
            count = int(raw_count)
        except (TypeError, ValueError):
            continue
        if count > 0:
            counts[str(key)] = count
    return dict(sorted(counts.items()))


def _merge_auth_profile_record(
    local_profile: dict | None,
    openclaw_profile: dict | None,
    snapshot: dict,
) -> dict:
    local_metadata = (
        dict(local_profile.get("metadata") or {})
        if isinstance(local_profile, dict) and isinstance(local_profile.get("metadata"), dict)
        else {}
    )
    local_scopes = (
        list(local_profile.get("scopes") or [])
        if isinstance(local_profile, dict) and isinstance(local_profile.get("scopes"), list)
        else []
    )
    openclaw_metadata = (
        dict(openclaw_profile.get("metadata") or {})
        if isinstance(openclaw_profile, dict) and isinstance(openclaw_profile.get("metadata"), dict)
        else {}
    )
    provider = str(
        (local_profile or {}).get("provider")
        or (openclaw_profile or {}).get("provider")
        or "unknown"
    ).strip().lower()
    profile_id = str(
        (local_profile or {}).get("profile_id")
        or (openclaw_profile or {}).get("profile_id")
        or ""
    ).strip()
    quota = match_usage_provider(snapshot, provider)
    openclaw_status = str(openclaw_profile.get("status") or "").strip() if openclaw_profile else None
    merged_metadata = {
        **local_metadata,
        "source": "local" if local_profile and not openclaw_profile else "openclaw" if openclaw_profile and not local_profile else "merged",
        "openclaw": {
            "exists": bool(openclaw_profile),
            "status": openclaw_status,
            "status_reason": openclaw_profile.get("status_reason") if openclaw_profile else None,
            "store_path": snapshot.get("auth_store_path"),
            "account_label": openclaw_profile.get("account_label") if openclaw_profile else None,
            "last_used_at": openclaw_profile.get("last_used_at") if openclaw_profile else None,
            "cooldown_until": openclaw_profile.get("cooldown_until") if openclaw_profile else None,
            "disabled_until": openclaw_profile.get("disabled_until") if openclaw_profile else None,
            "disabled_reason": openclaw_profile.get("disabled_reason") if openclaw_profile else None,
            "error_count": int(openclaw_profile.get("error_count") or 0) if openclaw_profile else 0,
            "failure_counts": _normalize_failure_counts(
                openclaw_profile.get("failure_counts") if openclaw_profile else {}
            ),
            "metadata": openclaw_metadata,
        },
        "quota": {
            "provider": quota.get("provider") if quota else None,
            "display_name": quota.get("display_name") if quota else None,
            "plan": quota.get("plan") if quota else None,
            "updated_at": (
                snapshot.get("usage_summary", {}).get("updated_at")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
            "error": quota.get("error") if quota else None,
            "windows": quota.get("windows") if quota else [],
        },
    }

    return {
        **(local_profile or default_auth_profile(profile_id, provider)),
        "profile_id": profile_id,
        "provider": provider,
        "label": str((local_profile or {}).get("label") or profile_id).strip() or profile_id,
        "auth_type": str(
            (local_profile or {}).get("auth_type")
            or (openclaw_profile or {}).get("auth_type")
            or "oauth"
        ).strip(),
        "status": openclaw_status or str((local_profile or {}).get("status") or "needs_login"),
        "account_label": (
            (local_profile or {}).get("account_label")
            or (openclaw_profile or {}).get("account_label")
        ),
        "credential_ref": (
            (local_profile or {}).get("credential_ref")
            or (profile_id if openclaw_profile else None)
        ),
        "login_hint": (local_profile or {}).get("login_hint"),
        "scopes": local_scopes,
        "last_tested_at": (local_profile or {}).get("last_tested_at"),
        "last_error": (local_profile or {}).get("last_error"),
        "metadata": merged_metadata,
        "created_at": (local_profile or {}).get("created_at"),
        "updated_at": (local_profile or {}).get("updated_at"),
        "source": merged_metadata["source"],
        "openclaw_exists": bool(openclaw_profile),
        "openclaw_status": openclaw_status,
        "openclaw_status_reason": openclaw_profile.get("status_reason") if openclaw_profile else None,
        "openclaw_store_path": snapshot.get("auth_store_path"),
        "openclaw_account_label": openclaw_profile.get("account_label") if openclaw_profile else None,
        "last_used_at": openclaw_profile.get("last_used_at") if openclaw_profile else None,
        "cooldown_until": openclaw_profile.get("cooldown_until") if openclaw_profile else None,
        "cooldown_active": bool(openclaw_profile and int(openclaw_profile.get("cooldown_seconds_remaining") or 0) > 0),
        "cooldown_seconds_remaining": int(openclaw_profile.get("cooldown_seconds_remaining") or 0) if openclaw_profile else 0,
        "disabled_until": openclaw_profile.get("disabled_until") if openclaw_profile else None,
        "disabled_active": bool(openclaw_profile and int(openclaw_profile.get("disabled_seconds_remaining") or 0) > 0),
        "disabled_seconds_remaining": int(openclaw_profile.get("disabled_seconds_remaining") or 0) if openclaw_profile else 0,
        "disabled_reason": openclaw_profile.get("disabled_reason") if openclaw_profile else None,
        "error_count": int(openclaw_profile.get("error_count") or 0) if openclaw_profile else 0,
        "last_failure_at": openclaw_profile.get("last_failure_at") if openclaw_profile else None,
        "failure_counts": _normalize_failure_counts(
            openclaw_profile.get("failure_counts") if openclaw_profile else {}
        ),
        "last_good_for_provider": bool(openclaw_profile and openclaw_profile.get("last_good_for_provider")),
        "quota_provider": quota.get("provider") if quota else None,
        "quota_display_name": quota.get("display_name") if quota else None,
        "quota_plan": quota.get("plan") if quota else None,
        "quota_error": quota.get("error") if quota else None,
        "quota_updated_at": (
            snapshot.get("usage_summary", {}).get("updated_at")
            if isinstance(snapshot.get("usage_summary"), dict)
            else None
        ),
        "quota_windows": list(quota.get("windows") or []) if quota else [],
    }


def _list_auth_profiles_with_snapshot(
    db_path: str,
    snapshot: dict,
) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        local_profiles = {
            str(row["profile_id"]): _read_auth_profile_row(conn, str(row["profile_id"]))
            for row in conn.execute(
                """
                SELECT profile_id
                FROM auth_profiles
                ORDER BY provider ASC, profile_id ASC
                """
            ).fetchall()
        }
    openclaw_profiles = {
        str(item.get("profile_id")): item
        for item in snapshot.get("auth_store", {}).get("profiles", [])
        if isinstance(item, dict) and item.get("profile_id")
    }
    profile_ids = sorted(set(local_profiles) | set(openclaw_profiles))
    profiles = [
        _merge_auth_profile_record(local_profiles.get(profile_id), openclaw_profiles.get(profile_id), snapshot)
        for profile_id in profile_ids
    ]
    return {
        "profiles": profiles,
        "count": len(profiles),
        "sync": {
            "ok": bool(snapshot.get("ok")),
            "error": snapshot.get("error"),
            "generated_at": snapshot.get("generated_at"),
            "auth_store_path": snapshot.get("auth_store_path"),
            "usage_updated_at": (
                snapshot.get("usage_summary", {}).get("updated_at")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
            "usage_error": (
                snapshot.get("usage_summary", {}).get("error")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
        },
    }


def list_auth_profiles(db_path: str) -> dict:
    snapshot = get_openclaw_live_snapshot()
    return _list_auth_profiles_with_snapshot(db_path, snapshot)


def upsert_auth_profiles(db_path: str, updates: list[dict]) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        for raw_update in updates:
            profile_id = str(raw_update.get("profile_id") or "").strip()
            if not profile_id:
                raise ValueError("profile_id is required")
            current = _read_auth_profile_row(conn, profile_id) or default_auth_profile(profile_id, str(raw_update.get("provider") or ""))
            provider = str(raw_update.get("provider") or current.get("provider") or "").strip().lower()
            if not provider:
                raise ValueError("provider is required")
            label = str(raw_update.get("label") or current.get("label") or profile_id).strip()
            if not label:
                raise ValueError("label is required")
            auth_type = str(raw_update.get("auth_type") or current.get("auth_type") or "oauth").strip().lower()
            if auth_type not in {"oauth", "api_key", "token"}:
                raise ValueError("auth_type must be oauth, api_key, or token")
            status = str(raw_update.get("status") or current.get("status") or "needs_login").strip().lower()
            if status not in {"needs_login", "connected", "degraded", "error", "disabled"}:
                raise ValueError("status must be needs_login, connected, degraded, error, or disabled")
            account_label = (
                str(raw_update.get("account_label")).strip()
                if raw_update.get("account_label") is not None
                else current.get("account_label")
            )
            credential_ref = (
                str(raw_update.get("credential_ref")).strip()
                if raw_update.get("credential_ref") is not None
                else current.get("credential_ref")
            )
            login_hint = (
                str(raw_update.get("login_hint")).strip()
                if raw_update.get("login_hint") is not None
                else current.get("login_hint")
            )
            scopes_raw = raw_update.get("scopes", current.get("scopes") or [])
            scopes = [str(item).strip() for item in scopes_raw] if isinstance(scopes_raw, list) else []
            metadata_raw = raw_update.get("metadata", current.get("metadata") or {})
            metadata = metadata_raw if isinstance(metadata_raw, dict) else {}
            last_error = (
                str(raw_update.get("last_error")).strip()
                if raw_update.get("last_error") is not None
                else current.get("last_error")
            )
            last_tested_at = (
                str(raw_update.get("last_tested_at")).strip()
                if raw_update.get("last_tested_at") is not None
                else current.get("last_tested_at")
            )
            created_at = str(current.get("created_at") or now)
            conn.execute(
                """
                INSERT INTO auth_profiles (
                  profile_id, provider, label, auth_type, status, account_label, credential_ref, login_hint,
                  scopes, last_tested_at, last_error, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                  provider = excluded.provider,
                  label = excluded.label,
                  auth_type = excluded.auth_type,
                  status = excluded.status,
                  account_label = excluded.account_label,
                  credential_ref = excluded.credential_ref,
                  login_hint = excluded.login_hint,
                  scopes = excluded.scopes,
                  last_tested_at = excluded.last_tested_at,
                  last_error = excluded.last_error,
                  metadata_json = excluded.metadata_json,
                  updated_at = excluded.updated_at
                """,
                (
                    profile_id,
                    provider,
                    label,
                    auth_type,
                    status,
                    account_label,
                    credential_ref,
                    login_hint,
                    json.dumps(scopes),
                    last_tested_at,
                    last_error,
                    json.dumps(metadata),
                    created_at,
                    now,
                ),
            )
    return list_auth_profiles(db_path)


def upsert_api_key_auth_profile(
    db_path: str,
    *,
    provider: str,
    api_key: str,
    profile_id: str | None = None,
    label: str | None = None,
    account_label: str | None = None,
    login_hint: str | None = None,
    set_last_good: bool = True,
) -> dict:
    resolved_provider = str(provider or "").strip().lower()
    resolved_api_key = str(api_key or "").strip()
    resolved_profile_id = str(profile_id or "").strip() or (
        f"{resolved_provider}:default" if resolved_provider else ""
    )
    resolved_label = str(label or "").strip() or (
        f"{resolved_provider} API" if resolved_provider else resolved_profile_id
    )

    if not resolved_provider:
        raise ValueError("provider is required")
    if not resolved_api_key:
        raise ValueError("api_key is required")
    if not resolved_profile_id:
        raise ValueError("profile_id is required")

    upsert_openclaw_api_key_profile(
        profile_id=resolved_profile_id,
        provider=resolved_provider,
        api_key=resolved_api_key,
        set_last_good=set_last_good,
    )
    return upsert_auth_profiles(
        db_path,
        [
            {
                "profile_id": resolved_profile_id,
                "provider": resolved_provider,
                "label": resolved_label,
                "auth_type": "api_key",
                "status": "connected",
                "account_label": str(account_label).strip() if account_label is not None else None,
                "credential_ref": resolved_profile_id,
                "login_hint": str(login_hint).strip() if login_hint is not None else None,
                "metadata": {
                    "managed_by": "sciailab-webui",
                    "credential_mode": "direct_api_key",
                },
            }
        ],
    )


def delete_auth_profile(db_path: str, profile_id: str) -> dict:
    init_db(db_path)
    resolved_profile_id = profile_id.strip()
    with connect(db_path) as conn:
        conn.execute("DELETE FROM auth_profiles WHERE profile_id = ?", (resolved_profile_id,))
        conn.execute(
            """
            UPDATE agent_routing
            SET auth_profile = NULL, updated_at = ?
            WHERE auth_profile = ?
            """,
            (utc_now(), resolved_profile_id),
        )
        conn.execute(
            """
            UPDATE provider_observability
            SET auth_profile = NULL, updated_at = ?
            WHERE auth_profile = ?
            """,
            (utc_now(), resolved_profile_id),
        )
    return list_auth_profiles(db_path)


def test_auth_profile(db_path: str, profile_id: str) -> dict:
    init_db(db_path)
    now = utc_now()
    snapshot = get_openclaw_live_snapshot(force_refresh=True)
    merged_profiles = {
        str(profile.get("profile_id")): profile
        for profile in _list_auth_profiles_with_snapshot(db_path, snapshot)["profiles"]
    }
    merged_profile = merged_profiles.get(profile_id)
    with connect(db_path) as conn:
        local_profile = _read_auth_profile_row(conn, profile_id)
        if local_profile is None and merged_profile is None:
            raise ValueError(f"auth profile not found: {profile_id}")
        profile = merged_profile or local_profile
        status = str(profile.get("status") or "unknown")
        message = "profile status unknown"
        if bool(profile.get("openclaw_exists")):
            if bool(profile.get("disabled_active")):
                message = (
                    f"profile disabled until {profile.get('disabled_until')} "
                    f"({profile.get('disabled_reason') or 'disabled'})"
                )
            elif bool(profile.get("cooldown_active")):
                message = (
                    f"profile cooling down for "
                    f"{int(profile.get('cooldown_seconds_remaining') or 0)}s"
                )
            elif status == "connected":
                message = "profile is present in OpenClaw auth store and ready"
            elif status == "degraded":
                message = (
                    f"profile has recent failures: {int(profile.get('error_count') or 0)}"
                )
            else:
                message = f"profile status from OpenClaw: {status}"
        else:
            credential_ref = str(profile.get("credential_ref") or "").strip()
            login_hint = str(profile.get("login_hint") or "").strip()
            message = (
                f"profile is configured with credential_ref {credential_ref}"
                if credential_ref
                else login_hint or "profile has no credential_ref yet"
            )
            status = "connected" if credential_ref else "needs_login"

        last_error = None if status in {"connected", "cooldown"} else message
        if local_profile is not None:
            conn.execute(
                """
                UPDATE auth_profiles
                SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ?
                WHERE profile_id = ?
                """,
                (status, now, last_error, now, profile_id),
            )
            profile = _merge_auth_profile_record(
                _read_auth_profile_row(conn, profile_id),
                next(
                    (
                        item
                        for item in snapshot.get("auth_store", {}).get("profiles", [])
                        if isinstance(item, dict) and str(item.get("profile_id")) == profile_id
                    ),
                    None,
                ),
                snapshot,
            )
        else:
            profile = merged_profile
    return {
        "profile": profile,
        "status": status,
        "message": message,
        "checked_at": now,
    }


def list_provider_observability(db_path: str) -> dict:
    init_db(db_path)
    routes = list_agent_routing(db_path)["routes"]
    merged_profiles = {
        str(profile["profile_id"]): profile
        for profile in list_auth_profiles(db_path)["profiles"]
    }
    snapshot = get_openclaw_live_snapshot()
    with connect(db_path) as conn:
        rows = {
            str(row["role"]): _decorate_provider_observation(row_to_dict(row) or {})
            for row in conn.execute(
                """
                SELECT *
                FROM provider_observability
                ORDER BY role ASC
                """
            ).fetchall()
        }
    roles: list[dict] = []
    totals = {
        "requests_total": 0,
        "success_total": 0,
        "failure_total": 0,
        "rate_limit_total": 0,
        "failover_total": 0,
        "cooldown_active": 0,
    }
    for route in routes:
        role = str(route["role"])
        observation = rows.get(role) or {
            **default_provider_observation(role),
            "provider": route.get("provider"),
            "model": route.get("model"),
            "auth_profile": route.get("auth_profile"),
            "route_active": bool(route.get("active")),
            "status": "configured" if route.get("provider") and route.get("active") else "disabled" if not route.get("active") else "unknown",
        }
        auth_profile_id = str(observation.get("auth_profile") or route.get("auth_profile") or "").strip()
        auth_profile = merged_profiles.get(auth_profile_id) if auth_profile_id else None
        quota = match_usage_provider(snapshot, observation.get("provider") or route.get("provider"))
        linked_cooldown_until = (
            auth_profile.get("cooldown_until")
            if auth_profile and auth_profile.get("cooldown_active")
            else observation.get("cooldown_until")
        )
        linked_cooldown_active = bool(
            (auth_profile and auth_profile.get("cooldown_active"))
            or observation.get("cooldown_active")
        )
        linked_cooldown_seconds = max(
            int(observation.get("cooldown_seconds_remaining") or 0),
            int(auth_profile.get("cooldown_seconds_remaining") or 0) if auth_profile else 0,
        )
        linked_status = str(observation.get("status") or "unknown")
        if auth_profile and auth_profile.get("disabled_active"):
            linked_status = "disabled"
        elif linked_cooldown_active:
            linked_status = "cooldown"
        elif auth_profile and auth_profile.get("openclaw_status") in {"connected", "degraded"} and linked_status in {"unknown", "configured"}:
            linked_status = str(auth_profile.get("openclaw_status"))
        entry = {
            **observation,
            "role": role,
            "provider": observation.get("provider") or route.get("provider"),
            "model": observation.get("model") or route.get("model"),
            "auth_profile": auth_profile_id or None,
            "route_active": bool(route.get("active")),
            "status": linked_status,
            "auth_profile_status": auth_profile.get("status") if auth_profile else None,
            "auth_profile_label": auth_profile.get("label") if auth_profile else None,
            "auth_profile_source": auth_profile.get("source") if auth_profile else None,
            "auth_profile_openclaw_status": auth_profile.get("openclaw_status") if auth_profile else None,
            "cooldown_until": linked_cooldown_until,
            "cooldown_active": linked_cooldown_active,
            "cooldown_seconds_remaining": linked_cooldown_seconds,
            "disabled_active": bool(auth_profile and auth_profile.get("disabled_active")),
            "disabled_until": auth_profile.get("disabled_until") if auth_profile else None,
            "disabled_reason": auth_profile.get("disabled_reason") if auth_profile else None,
            "quota_provider": quota.get("provider") if quota else None,
            "quota_display_name": quota.get("display_name") if quota else None,
            "quota_plan": quota.get("plan") if quota else None,
            "quota_error": quota.get("error") if quota else None,
            "quota_updated_at": (
                snapshot.get("usage_summary", {}).get("updated_at")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
            "quota_windows": list(quota.get("windows") or []) if quota else [],
        }
        totals["requests_total"] += int(entry.get("requests_total") or 0)
        totals["success_total"] += int(entry.get("success_total") or 0)
        totals["failure_total"] += int(entry.get("failure_total") or 0)
        totals["rate_limit_total"] += int(entry.get("rate_limit_total") or 0)
        totals["failover_total"] += int(entry.get("failover_total") or 0)
        totals["cooldown_active"] += 1 if entry.get("cooldown_active") else 0
        roles.append(entry)
    return {
        "roles": roles,
        "count": len(roles),
        "totals": totals,
        "sync": {
            "ok": bool(snapshot.get("ok")),
            "error": snapshot.get("error"),
            "generated_at": snapshot.get("generated_at"),
            "auth_store_path": snapshot.get("auth_store_path"),
            "usage_updated_at": (
                snapshot.get("usage_summary", {}).get("updated_at")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
            "usage_error": (
                snapshot.get("usage_summary", {}).get("error")
                if isinstance(snapshot.get("usage_summary"), dict)
                else None
            ),
        },
    }


def record_provider_observation_event(
    db_path: str,
    *,
    role: str,
    event_type: str,
    provider: str | None = None,
    model: str | None = None,
    auth_profile: str | None = None,
    error: str | None = None,
    failover: bool = False,
) -> dict:
    init_db(db_path)
    normalized_role = ensure_coordinator_role(role)
    normalized_event_type = event_type.strip().lower()
    if normalized_event_type not in {"attempt", "success", "failure"}:
        raise ValueError("event_type must be attempt, success, or failure")
    now = utc_now()
    with connect(db_path) as conn:
        route = _read_agent_route_row(conn, normalized_role) or default_agent_route(normalized_role)
        current = _read_provider_observation_row(conn, normalized_role) or default_provider_observation(normalized_role)
        next_provider = (provider or current.get("provider") or route.get("provider"))
        next_model = (model or current.get("model") or route.get("model"))
        next_auth_profile = (auth_profile or current.get("auth_profile") or route.get("auth_profile"))
        status = str(current.get("status") or "unknown")
        requests_total = int(current.get("requests_total") or 0)
        success_total = int(current.get("success_total") or 0)
        failure_total = int(current.get("failure_total") or 0)
        rate_limit_total = int(current.get("rate_limit_total") or 0)
        failover_total = int(current.get("failover_total") or 0)
        consecutive_failures = int(current.get("consecutive_failures") or 0)
        last_attempt_at = current.get("last_attempt_at")
        last_success_at = current.get("last_success_at")
        last_failure_at = current.get("last_failure_at")
        cooldown_until = current.get("cooldown_until")
        last_error = current.get("last_error")
        last_error_reason = current.get("last_error_reason")

        if normalized_event_type == "attempt":
            requests_total += 1
            last_attempt_at = now
            status = "running"
            last_error = None
            last_error_reason = None
        elif normalized_event_type == "success":
            success_total += 1
            consecutive_failures = 0
            last_success_at = now
            cooldown_until = None
            last_error = None
            last_error_reason = None
            status = "healthy"
        else:
            failure_total += 1
            consecutive_failures += 1
            last_failure_at = now
            last_error = error
            last_error_reason = _classify_provider_error_reason(error or "")
            status = "degraded"
            if last_error_reason == "rate_limit":
                rate_limit_total += 1
                cooldown_until = (datetime.now(timezone.utc) + timedelta(minutes=5)).replace(microsecond=0).isoformat()
                status = "cooldown"
            if failover:
                failover_total += 1

        conn.execute(
            """
            INSERT INTO provider_observability (
              role, provider, model, auth_profile, route_active, status,
              requests_total, success_total, failure_total, rate_limit_total, failover_total,
              consecutive_failures, last_attempt_at, last_success_at, last_failure_at,
              cooldown_until, last_error, last_error_reason, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(role) DO UPDATE SET
              provider = excluded.provider,
              model = excluded.model,
              auth_profile = excluded.auth_profile,
              route_active = excluded.route_active,
              status = excluded.status,
              requests_total = excluded.requests_total,
              success_total = excluded.success_total,
              failure_total = excluded.failure_total,
              rate_limit_total = excluded.rate_limit_total,
              failover_total = excluded.failover_total,
              consecutive_failures = excluded.consecutive_failures,
              last_attempt_at = excluded.last_attempt_at,
              last_success_at = excluded.last_success_at,
              last_failure_at = excluded.last_failure_at,
              cooldown_until = excluded.cooldown_until,
              last_error = excluded.last_error,
              last_error_reason = excluded.last_error_reason,
              updated_at = excluded.updated_at
            """,
            (
                normalized_role,
                next_provider,
                next_model,
                next_auth_profile,
                1 if bool(route.get("active")) else 0,
                status,
                requests_total,
                success_total,
                failure_total,
                rate_limit_total,
                failover_total,
                consecutive_failures,
                last_attempt_at,
                last_success_at,
                last_failure_at,
                cooldown_until,
                last_error,
                last_error_reason,
                now,
            ),
        )
    return list_provider_observability(db_path)


def list_agent_routing(db_path: str) -> dict:
    init_db(db_path)
    routes: list[dict] = []
    with connect(db_path) as conn:
        for role in COORDINATOR_ROLES:
            route = _read_agent_route_row(conn, role) or default_agent_route(role)
            routes.append(route)
    return {
        "routes": routes,
        "count": len(routes),
    }


def upsert_agent_routing(db_path: str, updates: list[dict]) -> dict:
    init_db(db_path)
    now = utc_now()
    with connect(db_path) as conn:
        for raw_update in updates:
            role = ensure_coordinator_role(str(raw_update.get("role") or ""))
            current = _read_agent_route_row(conn, role) or default_agent_route(role)
            active = bool(raw_update["active"]) if "active" in raw_update else bool(current["active"])
            provider = raw_update["provider"] if "provider" in raw_update else current["provider"]
            model = raw_update["model"] if "model" in raw_update else current["model"]
            auth_profile = (
                raw_update["auth_profile"] if "auth_profile" in raw_update else current["auth_profile"]
            )
            max_concurrency = (
                int(raw_update["max_concurrency"])
                if "max_concurrency" in raw_update and raw_update["max_concurrency"] is not None
                else int(current["max_concurrency"])
            )
            if max_concurrency < 1:
                raise ValueError("max_concurrency must be >= 1")
            if auth_profile:
                existing_profile = _read_auth_profile_row(conn, str(auth_profile))
                if existing_profile is None:
                    stub = default_auth_profile(str(auth_profile), str(provider or auth_profile).split(":", 1)[0])
                    conn.execute(
                        """
                        INSERT INTO auth_profiles (
                          profile_id, provider, label, auth_type, status, account_label, credential_ref, login_hint,
                          scopes, last_tested_at, last_error, metadata_json, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            stub["profile_id"],
                            stub["provider"],
                            stub["label"],
                            stub["auth_type"],
                            stub["status"],
                            stub["account_label"],
                            stub["credential_ref"],
                            stub["login_hint"],
                            json.dumps(stub["scopes"]),
                            stub["last_tested_at"],
                            stub["last_error"],
                            json.dumps(stub["metadata"]),
                            now,
                            now,
                        ),
                    )
            conn.execute(
                """
                INSERT INTO agent_routing (
                  role, active, provider, model, auth_profile, max_concurrency, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(role) DO UPDATE SET
                  active = excluded.active,
                  provider = excluded.provider,
                  model = excluded.model,
                  auth_profile = excluded.auth_profile,
                  max_concurrency = excluded.max_concurrency,
                  updated_at = excluded.updated_at
                """,
                (
                    role,
                    1 if active else 0,
                    provider,
                    model,
                    auth_profile,
                    max_concurrency,
                    now,
                ),
            )
            _sync_provider_observation_with_route(
                conn,
                role=role,
                provider=provider,
                model=model,
                auth_profile=auth_profile,
                route_active=active,
                updated_at=now,
            )
    return list_agent_routing(db_path)


def set_agent_activation(
    db_path: str,
    *,
    role: str,
    active: bool,
    max_concurrency: int | None = None,
) -> dict:
    updates: dict[str, object] = {
        "role": ensure_coordinator_role(role),
        "active": active,
    }
    if max_concurrency is not None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be >= 1")
        updates["max_concurrency"] = max_concurrency
    return upsert_agent_routing(db_path, [updates])


def _parse_json_text(value: str | None, fallback: object) -> object:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _count_by(records: list[dict], field: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in records:
        key = str(record.get(field) or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _latest_by_type(records: list[dict], type_field: str) -> dict[str, dict]:
    latest: dict[str, dict] = {}
    for record in records:
        record_type = str(record.get(type_field) or "unknown")
        current = latest.get(record_type)
        record_version = int(record.get("version") or 0)
        current_version = int(current.get("version") or 0) if current else -1
        if current is None or record_version > current_version:
            latest[record_type] = record
    return dict(sorted(latest.items()))


def _unique_values(records: list[dict], field: str) -> list[str]:
    values = {str(record.get(field) or "") for record in records if record.get(field)}
    return sorted(values)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _derive_message_handoff_state(message: dict) -> str:
    handoff_state = str(message.get("handoff_state") or "").strip().lower()
    if handoff_state:
        return handoff_state
    status = str(message.get("status") or "").strip().lower()
    if status == "resolved":
        return "completed"
    if status == "acked":
        return "accepted"
    if status == "read":
        return "seen"
    if status == "blocked":
        return "blocked"
    return "queued"


def _build_handoff_operator_backlog(
    messages: list[dict],
    *,
    pending_timeout_seconds: int,
    blocked_timeout_seconds: int,
) -> dict:
    now = datetime.now(timezone.utc)
    state_counts: dict[str, int] = {}
    agent_counts: dict[str, int] = {}
    per_agent: dict[str, dict[str, object]] = {}
    open_count = 0
    pending_count = 0
    blocked_count = 0
    aged_pending_count = 0
    unacked_count = 0
    oldest_pending_age_seconds: int | None = None
    oldest_blocked_age_seconds: int | None = None

    for message in messages:
        handoff_state = _derive_message_handoff_state(message)
        status = str(message.get("status") or "").strip().lower()
        if handoff_state == "completed" or status == "resolved":
            continue

        target_agent = str(message.get("to_agent") or "unknown")
        timestamp = _parse_iso_datetime(
            str(message.get("updated_at") or message.get("created_at") or "")
        )
        age_seconds = (
            max(0, int((now - timestamp).total_seconds()))
            if timestamp is not None
            else None
        )
        is_pending = handoff_state in {"queued", "seen", "accepted"}
        is_blocked = handoff_state == "blocked"
        is_aged_pending = bool(
            is_pending
            and age_seconds is not None
            and age_seconds >= pending_timeout_seconds
        )
        is_unacked = bool(is_pending and not message.get("acked_at"))

        open_count += 1
        state_counts[handoff_state] = state_counts.get(handoff_state, 0) + 1
        agent_counts[target_agent] = agent_counts.get(target_agent, 0) + 1

        if is_pending:
            pending_count += 1
            if is_aged_pending:
                aged_pending_count += 1
            if age_seconds is not None:
                oldest_pending_age_seconds = max(oldest_pending_age_seconds or 0, age_seconds)
        if is_blocked:
            blocked_count += 1
            if age_seconds is not None:
                oldest_blocked_age_seconds = max(oldest_blocked_age_seconds or 0, age_seconds)
        if is_unacked:
            unacked_count += 1

        agent_row = per_agent.setdefault(
            target_agent,
            {
                "agent_id": target_agent,
                "open_count": 0,
                "pending_count": 0,
                "queued_count": 0,
                "seen_count": 0,
                "accepted_count": 0,
                "blocked_count": 0,
                "aged_pending_count": 0,
                "unacked_count": 0,
                "oldest_pending_age_seconds": None,
                "oldest_blocked_age_seconds": None,
                "avg_pending_age_seconds": None,
                "last_message_at": None,
                "_pending_age_total": 0,
                "_pending_age_count": 0,
            },
        )
        agent_row["open_count"] = int(agent_row["open_count"]) + 1
        if is_pending:
            agent_row["pending_count"] = int(agent_row["pending_count"]) + 1
            state_key = f"{handoff_state}_count"
            agent_row[state_key] = int(agent_row.get(state_key) or 0) + 1
            if is_aged_pending:
                agent_row["aged_pending_count"] = int(agent_row["aged_pending_count"]) + 1
            if is_unacked:
                agent_row["unacked_count"] = int(agent_row["unacked_count"]) + 1
            if age_seconds is not None:
                agent_row["_pending_age_total"] = int(agent_row["_pending_age_total"]) + age_seconds
                agent_row["_pending_age_count"] = int(agent_row["_pending_age_count"]) + 1
                agent_row["oldest_pending_age_seconds"] = max(
                    int(agent_row.get("oldest_pending_age_seconds") or 0),
                    age_seconds,
                )
        if is_blocked:
            agent_row["blocked_count"] = int(agent_row["blocked_count"]) + 1
            if age_seconds is not None:
                agent_row["oldest_blocked_age_seconds"] = max(
                    int(agent_row.get("oldest_blocked_age_seconds") or 0),
                    age_seconds,
                )
        last_message_at = str(message.get("updated_at") or message.get("created_at") or "")
        if last_message_at > str(agent_row.get("last_message_at") or ""):
            agent_row["last_message_at"] = last_message_at

    agents: list[dict] = []
    for agent_row in per_agent.values():
        pending_age_count = int(agent_row.pop("_pending_age_count", 0) or 0)
        pending_age_total = int(agent_row.pop("_pending_age_total", 0) or 0)
        agent_row["avg_pending_age_seconds"] = (
            int(pending_age_total / pending_age_count)
            if pending_age_count > 0
            else None
        )
        if int(agent_row["aged_pending_count"]) > 0:
            agent_row["sla_status"] = "blocked"
        elif int(agent_row["blocked_count"]) > 0:
            blocked_oldest = agent_row.get("oldest_blocked_age_seconds")
            agent_row["sla_status"] = (
                "blocked"
                if blocked_oldest is not None
                and int(blocked_oldest) >= blocked_timeout_seconds
                else "degraded"
            )
        elif int(agent_row["open_count"]) > 0:
            agent_row["sla_status"] = "active"
        else:
            agent_row["sla_status"] = "healthy"
        agents.append(agent_row)

    agents.sort(
        key=lambda item: (
            0 if str(item["sla_status"]) == "blocked" else 1 if str(item["sla_status"]) == "degraded" else 2,
            -int(item["aged_pending_count"]),
            -int(item["blocked_count"]),
            -int(item["open_count"]),
            str(item["agent_id"]),
        )
    )

    return {
        "handoff_metrics": {
            "open_count": open_count,
            "pending_count": pending_count,
            "blocked_count": blocked_count,
            "aged_pending_count": aged_pending_count,
            "unacked_count": unacked_count,
            "busy_agent_count": len(agents),
            "oldest_pending_age_seconds": oldest_pending_age_seconds,
            "oldest_blocked_age_seconds": oldest_blocked_age_seconds,
            "pending_timeout_seconds": pending_timeout_seconds,
            "blocked_timeout_seconds": blocked_timeout_seconds,
            "state_counts": dict(sorted(state_counts.items())),
            "agent_counts": dict(sorted(agent_counts.items())),
        },
        "handoff_sla": {
            "generated_at": utc_now(),
            "pending_timeout_seconds": pending_timeout_seconds,
            "blocked_timeout_seconds": blocked_timeout_seconds,
            "agents": agents,
        },
    }


def build_project_read_model(db_path: str, project_id: str, *, limit: int = 60) -> dict:
    project = get_project_record(db_path, project_id)
    tasks = list_tasks(db_path, project_id)["tasks"]
    artifacts_raw = list_artifacts(db_path, project_id)["artifacts"]
    messages = list_messages(db_path, project_id)["messages"]
    events_raw = list_events(db_path, project_id)["events"]
    packages_raw = list_packages(db_path, project_id)["packages"]
    agent_states = list_agent_states(db_path, project_id)["agent_states"]
    worktrees = list_project_worktrees(db_path, project_id=project_id, limit=100)["worktrees"]
    execution_contexts = list_task_execution_contexts(db_path, project_id=project_id, limit=100)["execution_contexts"]
    hooks = list_task_completion_hooks(db_path, project_id=project_id, limit=100)["hooks"]

    artifacts: list[dict] = []
    for artifact in artifacts_raw:
        artifacts.append(
            {
                **artifact,
                "upstream_dependencies": _parse_json_text(artifact.get("upstream_dependencies"), []),
                "metadata": _parse_json_text(artifact.get("metadata_json"), {}),
            }
        )

    events: list[dict] = []
    for event in events_raw:
        events.append(
            {
                **event,
                "payload_json": _parse_json_text(event.get("payload"), {}),
            }
        )

    packages: list[dict] = []
    for package in packages_raw:
        packages.append(
            {
                **package,
                "created_from_list": _parse_json_text(package.get("created_from"), []),
            }
        )

    active_tasks = [task for task in tasks if str(task["status"]) != "done"]
    latest_event_type = events[0]["event_type"] if events else None
    latest_artifacts = _latest_by_type(artifacts, "artifact_type")
    latest_packages = _latest_by_type(packages, "package_type")
    active_worktrees = [item for item in worktrees if str(item.get("status")) in {"prepared", "active"}]
    active_execution_contexts = [
        item for item in execution_contexts if str(item.get("status")) in {"prepared", "active"}
    ]
    pending_inbox = [message for message in messages if str(message.get("status")) != "resolved"][:20]
    teammate_messages = messages[:20]
    runtime_settings = get_runtime_settings(db_path)["settings"]
    handoff_operator = _build_handoff_operator_backlog(
        messages,
        pending_timeout_seconds=int(runtime_settings["handoff_pending_timeout_seconds"]),
        blocked_timeout_seconds=int(runtime_settings["handoff_blocked_timeout_seconds"]),
    )

    timeline: list[dict] = []
    for task in tasks:
        timeline.append(
            {
                "kind": "task",
                "id": task["task_id"],
                "timestamp": task["updated_at"],
                "title": str(task["title"]),
                "summary": f"{task['owner_agent']} task -> {task['status']}",
                "status": task["status"],
                "owner": task["owner_agent"],
                "owner_agent": task["owner_agent"],
                "event_type": None,
                "details": {
                    "scope": task["scope"],
                    "dependency": task["dependency"],
                    "acceptance": task["acceptance"],
                    "created_at": task["created_at"],
                    "updated_at": task["updated_at"],
                },
            }
        )
    for event in events:
        timeline.append(
            {
                "kind": "event",
                "id": event["event_id"],
                "timestamp": event["created_at"],
                "title": str(event["event_type"]),
                "summary": f"{event['source']} emitted {event['event_type']}",
                "status": event["status"],
                "owner": event["source"],
                "owner_agent": event["source"],
                "event_type": event["event_type"],
                "details": {
                    "payload": event["payload_json"],
                    "created_at": event["created_at"],
                    "source": event["source"],
                },
            }
        )
    for artifact in artifacts:
        timeline.append(
            {
                "kind": "artifact",
                "id": artifact["artifact_id"],
                "timestamp": artifact["updated_at"],
                "title": f"{artifact['artifact_type']} v{artifact['version']}",
                "summary": f"{artifact['owner']} artifact -> {artifact['state']}",
                "status": artifact["state"],
                "owner": artifact["owner"],
                "owner_agent": artifact["owner"],
                "event_type": None,
                "details": {
                    "artifact_type": artifact["artifact_type"],
                    "path": artifact["path"],
                    "upstream_dependencies": artifact["upstream_dependencies"],
                    "metadata": artifact["metadata"],
                    "created_at": artifact["created_at"],
                    "updated_at": artifact["updated_at"],
                },
            }
        )
    for package in packages:
        timeline.append(
            {
                "kind": "package",
                "id": package["package_id"],
                "timestamp": package["created_at"],
                "title": f"{package['package_type']} v{package['version']}",
                "summary": f"frozen package -> {package['state']}",
                "status": package["state"],
                "owner": "runtime",
                "owner_agent": "runtime",
                "event_type": None,
                "details": {
                    "package_type": package["package_type"],
                    "manifest_path": package["manifest_path"],
                    "created_from": package["created_from_list"],
                    "created_at": package["created_at"],
                },
            }
        )
    for message in messages:
        timeline.append(
            {
                "kind": "message",
                "id": message["message_id"],
                "timestamp": message.get("updated_at") or message["created_at"],
                "title": f"{message['from_agent']} -> {message['to_agent']}",
                "summary": f"{message['message_type']} / {message['handoff_state']} / {message['priority']}",
                "status": message["status"],
                "owner": message["to_agent"],
                "owner_agent": message["to_agent"],
                "event_type": None,
                "details": {
                    "from_agent": message["from_agent"],
                    "to_agent": message["to_agent"],
                    "message_type": message["message_type"],
                    "priority": message["priority"],
                    "handoff_state": message.get("handoff_state"),
                    "artifact_ref": message["artifact_ref"],
                    "content": message["content"],
                    "created_at": message["created_at"],
                    "updated_at": message.get("updated_at"),
                    "read_at": message.get("read_at"),
                    "acked_at": message.get("acked_at"),
                    "resolved_at": message.get("resolved_at"),
                },
            }
        )
    for agent_state in agent_states:
        timeline.append(
            {
                "kind": "agent_state",
                "id": f"{agent_state['agent_id']}:{agent_state['project_id']}",
                "timestamp": agent_state["updated_at"],
                "title": str(agent_state["agent_id"]),
                "summary": f"agent state -> {agent_state['state']}",
                "status": agent_state["state"],
                "owner": agent_state["agent_id"],
                "owner_agent": agent_state["agent_id"],
                "event_type": None,
                "details": {
                    "current_task_id": agent_state["current_task_id"],
                    "last_error": agent_state["last_error"],
                    "last_heartbeat_at": agent_state["last_heartbeat_at"],
                    "updated_at": agent_state["updated_at"],
                },
            }
        )
    for execution_context in execution_contexts:
        timeline.append(
            {
                "kind": "execution_context",
                "id": execution_context["task_id"],
                "timestamp": execution_context["updated_at"],
                "title": f"{execution_context['owner_agent']} execution context",
                "summary": f"{execution_context['runtime_kind']} -> {execution_context['status']}",
                "status": execution_context["status"],
                "owner": execution_context["owner_agent"],
                "owner_agent": execution_context["owner_agent"],
                "event_type": None,
                "details": {
                    "worktree_id": execution_context["worktree_id"],
                    "canonical_workspace_path": execution_context["canonical_workspace_path"],
                    "execution_workspace_path": execution_context["execution_workspace_path"],
                    "prepared_at": execution_context["prepared_at"],
                    "started_at": execution_context["started_at"],
                    "finished_at": execution_context["finished_at"],
                    "metadata": execution_context["metadata"],
                },
            }
        )
    for worktree in worktrees:
        timeline.append(
            {
                "kind": "worktree",
                "id": worktree["worktree_id"],
                "timestamp": worktree["cleanup_at"] or worktree["released_at"] or worktree["activated_at"] or worktree["created_at"],
                "title": f"{worktree['owner_agent']} worktree",
                "summary": f"{worktree['isolation_mode']} -> {worktree['status']}",
                "status": worktree["status"],
                "owner": worktree["owner_agent"],
                "owner_agent": worktree["owner_agent"],
                "event_type": None,
                "details": {
                    "task_id": worktree["task_id"],
                    "branch_name": worktree["branch_name"],
                    "canonical_workspace_path": worktree["canonical_workspace_path"],
                    "worktree_path": worktree["worktree_path"],
                    "created_at": worktree["created_at"],
                    "activated_at": worktree["activated_at"],
                    "released_at": worktree["released_at"],
                    "cleanup_at": worktree["cleanup_at"],
                    "metadata": worktree["metadata"],
                },
            }
        )
    for hook in hooks:
        timeline.append(
            {
                "kind": "completion_hook",
                "id": hook["hook_id"],
                "timestamp": hook["completed_at"] or hook["updated_at"] or hook["created_at"],
                "title": str(hook["hook_type"]),
                "summary": f"hook -> {hook['status']}",
                "status": hook["status"],
                "owner": "runtime",
                "owner_agent": "runtime",
                "event_type": None,
                "details": {
                    "task_id": hook["task_id"],
                    "hook_type": hook["hook_type"],
                    "created_at": hook["created_at"],
                    "updated_at": hook["updated_at"],
                    "completed_at": hook["completed_at"],
                    "payload": hook["payload"],
                },
            }
        )
    timeline.sort(
        key=lambda item: (str(item.get("timestamp") or ""), str(item.get("kind") or ""), str(item.get("id") or "")),
        reverse=True,
    )

    return {
        "project_id": project_id,
        "project": project,
        "summary": {
            "counts": {
                "tasks": len(tasks),
                "active_tasks": len(active_tasks),
                "artifacts": len(artifacts),
                "messages": len(messages),
                "events": len(events),
                "packages": len(packages),
                "agent_states": len(agent_states),
                "worktrees": len(worktrees),
                "execution_contexts": len(execution_contexts),
                "completion_hooks": len(hooks),
                "active_worktrees": len(active_worktrees),
                "active_execution_contexts": len(active_execution_contexts),
            },
            "task_status_counts": _count_by(tasks, "status"),
            "task_owner_counts": _count_by(tasks, "owner_agent"),
            "event_type_counts": _count_by(events, "event_type"),
            "artifact_type_counts": _count_by(artifacts, "artifact_type"),
            "package_type_counts": _count_by(packages, "package_type"),
            "agent_state_counts": _count_by(agent_states, "state"),
            "worktree_status_counts": _count_by(worktrees, "status"),
            "execution_status_counts": _count_by(execution_contexts, "status"),
            "hook_status_counts": _count_by(hooks, "status"),
            "latest_event_type": latest_event_type,
        },
        "read_model": {
            "active_tasks": active_tasks,
            "blocked_tasks": [task for task in tasks if str(task["status"]) == "blocked"],
            "latest_artifacts": latest_artifacts,
            "latest_packages": latest_packages,
            "agent_states": sorted(agent_states, key=lambda item: str(item["agent_id"])),
            "active_worktrees": active_worktrees,
            "execution_contexts": execution_contexts[:20],
            "recent_hooks": hooks[:20],
            "pending_inbox": pending_inbox,
            "teammate_messages": teammate_messages,
            "recent_messages": messages[:10],
            "handoff_metrics": handoff_operator["handoff_metrics"],
            "handoff_sla": handoff_operator["handoff_sla"],
            "filters": {
                "event_types": _unique_values(events, "event_type"),
                "statuses": sorted({str(item["status"]) for item in timeline if item.get("status")}),
                "owner_agents": sorted({str(item["owner_agent"]) for item in timeline if item.get("owner_agent")}),
            },
        },
        "trace": {
            "timeline": timeline[: max(10, min(limit, 200))],
            "recent_events": events[:10],
            "recent_tasks": tasks[:10],
        },
    }


def build_scheduler_control_state(db_path: str) -> dict:
    init_db(db_path)
    routing = list_agent_routing(db_path)["routes"]
    with connect(db_path) as conn:
        task_rows = conn.execute(
            """
            SELECT owner_agent, status, COUNT(*) AS count
            FROM tasks
            GROUP BY owner_agent, status
            """
        ).fetchall()
        queue_counts: dict[str, dict[str, int]] = {}
        for row in task_rows:
            owner_agent = str(row["owner_agent"])
            status = str(row["status"])
            queue_counts.setdefault(owner_agent, {})[status] = int(row["count"])
        agent_states = {
            str(row["agent_id"]): row_to_dict(row)
            for row in conn.execute(
                """
                SELECT * FROM agent_states
                ORDER BY updated_at DESC
                """
            ).fetchall()
        }
        worktree_rows = conn.execute(
            """
            SELECT owner_agent, status, COUNT(*) AS count
            FROM project_worktrees
            GROUP BY owner_agent, status
            """
        ).fetchall()
        worktree_counts: dict[str, dict[str, int]] = {}
        for row in worktree_rows:
            owner_agent = str(row["owner_agent"])
            status = str(row["status"])
            worktree_counts.setdefault(owner_agent, {})[status] = int(row["count"])
    return {
        "roles": [
            {
                **route,
                "queue": queue_counts.get(str(route["role"]), {}),
                "agent_state": agent_states.get(str(route["role"])),
                "worktrees": worktree_counts.get(str(route["role"]), {}),
            }
            for route in routing
        ],
        "queue_counts": queue_counts,
        "worktree_counts": worktree_counts,
    }


def _read_agent_thread_row(row: sqlite3.Row | None) -> dict | None:
    thread = row_to_dict(row)
    if thread is None:
        return None
    return {
        **thread,
        "metadata": _parse_json_text(thread.get("metadata_json"), {}),
    }


def _read_agent_thread_message_row(row: sqlite3.Row | None) -> dict | None:
    message = row_to_dict(row)
    if message is None:
        return None
    return {
        **message,
        "metadata": _parse_json_text(message.get("metadata_json"), {}),
    }


def _read_agent_thread_attachment_row(row: sqlite3.Row | None) -> dict | None:
    attachment = row_to_dict(row)
    if attachment is None:
        return None
    return {
        **attachment,
        "metadata": _parse_json_text(attachment.get("metadata_json"), {}),
    }


def _read_agent_operator_action_row(row: sqlite3.Row | None) -> dict | None:
    action = row_to_dict(row)
    if action is None:
        return None
    return {
        **action,
        "payload": _parse_json_text(action.get("payload_json"), {}),
        "result": _parse_json_text(action.get("result_json"), {}),
    }


def _ensure_project_exists(conn: sqlite3.Connection, project_id: str) -> None:
    project = conn.execute(
        "SELECT project_id FROM projects WHERE project_id = ?",
        (project_id,),
    ).fetchone()
    if project is None:
        raise ValueError(f"project not found: {project_id}")


def _ensure_task_exists(conn: sqlite3.Connection, project_id: str, task_id: str | None) -> None:
    if not task_id:
        return
    task = conn.execute(
        "SELECT task_id FROM tasks WHERE task_id = ? AND project_id = ?",
        (task_id, project_id),
    ).fetchone()
    if task is None:
        raise ValueError(f"task not found for project {project_id}: {task_id}")


def _ensure_execution_context_exists(
    conn: sqlite3.Connection,
    project_id: str,
    execution_context_task_id: str | None,
) -> None:
    if not execution_context_task_id:
        return
    row = conn.execute(
        """
        SELECT task_id
        FROM task_execution_contexts
        WHERE task_id = ? AND project_id = ?
        """,
        (execution_context_task_id, project_id),
    ).fetchone()
    if row is None:
        raise ValueError(
            f"execution context not found for project {project_id}: {execution_context_task_id}"
        )


def _get_or_create_agent_thread_conn(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    agent_id: str,
    title: str | None = None,
    metadata: dict | None = None,
) -> dict:
    _ensure_project_exists(conn, project_id)
    existing = conn.execute(
        """
        SELECT *
        FROM agent_threads
        WHERE project_id = ? AND agent_id = ?
        """,
        (project_id, agent_id),
    ).fetchone()
    if existing is not None:
        thread = _read_agent_thread_row(existing)
        if thread is None:
            raise RuntimeError("agent thread read failed")
        return thread

    now = utc_now()
    thread_id = f"ath_{uuid4().hex}"
    resolved_title = title.strip() if isinstance(title, str) and title.strip() else f"{agent_id} workspace"
    conn.execute(
        """
        INSERT INTO agent_threads (
          thread_id, project_id, agent_id, title, status,
          created_at, updated_at, last_message_at, metadata_json
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?)
        """,
        (
            thread_id,
            project_id,
            agent_id,
            resolved_title,
            now,
            now,
            json.dumps(metadata or {}),
        ),
    )
    row = conn.execute(
        "SELECT * FROM agent_threads WHERE thread_id = ?",
        (thread_id,),
    ).fetchone()
    thread = _read_agent_thread_row(row)
    if thread is None:
        raise RuntimeError("agent thread insert failed")
    return thread


def get_or_create_agent_thread(
    db_path: str,
    *,
    project_id: str,
    agent_id: str,
    title: str | None = None,
    metadata: dict | None = None,
) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        return _get_or_create_agent_thread_conn(
            conn,
            project_id=project_id,
            agent_id=agent_id,
            title=title,
            metadata=metadata,
        )


def create_agent_thread_message(
    db_path: str,
    *,
    project_id: str,
    agent_id: str,
    sender_type: str,
    message_type: str,
    content: str = "",
    input_mode: str = "mixed",
    intent: str = "chat",
    task_id: str | None = None,
    execution_context_task_id: str | None = None,
    status: str = "queued",
    attachments: list[dict] | None = None,
    metadata: dict | None = None,
) -> dict:
    init_db(db_path)
    now = utc_now()
    message_id = f"atm_{uuid4().hex}"
    with connect(db_path) as conn:
        thread = _get_or_create_agent_thread_conn(
            conn,
            project_id=project_id,
            agent_id=agent_id,
        )
        _ensure_task_exists(conn, project_id, task_id)
        _ensure_execution_context_exists(conn, project_id, execution_context_task_id)
        conn.execute(
            """
            INSERT INTO agent_thread_messages (
              message_id, thread_id, project_id, agent_id, task_id, execution_context_task_id,
              sender_type, message_type, input_mode, intent, content, status,
              metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                thread["thread_id"],
                project_id,
                agent_id,
                task_id,
                execution_context_task_id,
                sender_type,
                message_type,
                input_mode,
                intent,
                content,
                status,
                json.dumps(metadata or {}),
                now,
                now,
            ),
        )
        for item in attachments or []:
            attachment_id = f"ata_{uuid4().hex}"
            conn.execute(
                """
                INSERT INTO agent_thread_attachments (
                  attachment_id, message_id, project_id, attachment_type, name, path,
                  mime_type, size_bytes, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attachment_id,
                    message_id,
                    project_id,
                    str(item.get("attachment_type") or "file"),
                    item.get("name"),
                    item.get("path"),
                    item.get("mime_type"),
                    int(item.get("size_bytes") or 0),
                    json.dumps(item.get("metadata") or {}),
                    now,
                ),
            )
        conn.execute(
            """
            UPDATE agent_threads
            SET updated_at = ?, last_message_at = ?
            WHERE thread_id = ?
            """,
            (now, now, thread["thread_id"]),
        )
        message_row = conn.execute(
            "SELECT * FROM agent_thread_messages WHERE message_id = ?",
            (message_id,),
        ).fetchone()
        attachment_rows = conn.execute(
            """
            SELECT *
            FROM agent_thread_attachments
            WHERE message_id = ?
            ORDER BY created_at ASC, attachment_id ASC
            """,
            (message_id,),
        ).fetchall()
        thread_row = conn.execute(
            "SELECT * FROM agent_threads WHERE thread_id = ?",
            (thread["thread_id"],),
        ).fetchone()
    message = _read_agent_thread_message_row(message_row)
    if message is None:
        raise RuntimeError("agent thread message insert failed")
    message["attachments"] = [
        attachment
        for attachment in (_read_agent_thread_attachment_row(row) for row in attachment_rows)
        if attachment is not None
    ]
    return {
        "thread": _read_agent_thread_row(thread_row),
        "message": message,
    }


def record_agent_operator_action(
    db_path: str,
    *,
    project_id: str,
    agent_id: str,
    action_type: str,
    task_id: str | None = None,
    payload: dict | None = None,
    result: dict | None = None,
    status: str = "completed",
) -> dict:
    init_db(db_path)
    now = utc_now()
    action_id = f"aoa_{uuid4().hex}"
    with connect(db_path) as conn:
        _ensure_project_exists(conn, project_id)
        _ensure_task_exists(conn, project_id, task_id)
        conn.execute(
            """
            INSERT INTO agent_operator_actions (
              action_id, project_id, agent_id, task_id, action_type,
              payload_json, result_json, status, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                action_id,
                project_id,
                agent_id,
                task_id,
                action_type,
                json.dumps(payload or {}),
                json.dumps(result or {}),
                status,
                now,
                now,
                now if status in {"completed", "failed"} else None,
            ),
        )
        row = conn.execute(
            "SELECT * FROM agent_operator_actions WHERE action_id = ?",
            (action_id,),
        ).fetchone()
    action = _read_agent_operator_action_row(row)
    if action is None:
        raise RuntimeError("agent operator action insert failed")
    return action


def _build_agent_workspace_context(db_path: str, project_id: str, agent_id: str) -> dict:
    project = get_project_record(db_path, project_id)
    tasks = list_tasks(db_path, project_id)["tasks"]
    task_map = {str(task["task_id"]): task for task in tasks}
    agent_states = list_agent_states(db_path, project_id, agent_id=agent_id)["agent_states"]
    agent_state = agent_states[0] if agent_states else None
    execution_contexts = list_task_execution_contexts(
        db_path,
        project_id=project_id,
        owner_agent=agent_id,
        limit=20,
    )["execution_contexts"]
    current_execution_context = None
    for item in execution_contexts:
        if str(item.get("status")) in {"active", "prepared"}:
            current_execution_context = item
            break
    if current_execution_context is None and execution_contexts:
        current_execution_context = execution_contexts[0]

    worktrees = list_project_worktrees(
        db_path,
        project_id=project_id,
        owner_agent=agent_id,
        limit=20,
    )["worktrees"]
    current_worktree = None
    if current_execution_context and current_execution_context.get("worktree_id"):
        for item in worktrees:
            if item.get("worktree_id") == current_execution_context.get("worktree_id"):
                current_worktree = item
                break
    if current_worktree is None and worktrees:
        current_worktree = worktrees[0]

    current_task_id = None
    if agent_state and agent_state.get("current_task_id"):
        current_task_id = str(agent_state["current_task_id"])
    elif current_execution_context and current_execution_context.get("task_id"):
        current_task_id = str(current_execution_context["task_id"])
    current_task = task_map.get(str(current_task_id)) if current_task_id else None

    route = next(
        (item for item in list_agent_routing(db_path)["routes"] if str(item.get("role")) == agent_id),
        None,
    )

    artifacts = list_artifacts(db_path, project_id)["artifacts"]
    recent_artifacts = []
    for artifact in artifacts:
        if str(artifact.get("owner")) != agent_id:
            continue
        recent_artifacts.append(
            {
                **artifact,
                "upstream_dependencies": _parse_json_text(artifact.get("upstream_dependencies"), []),
                "metadata": _parse_json_text(artifact.get("metadata_json"), {}),
            }
        )
    recent_artifacts.sort(
        key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""),
        reverse=True,
    )

    packages = list_packages(db_path, project_id)["packages"]
    recent_packages = [
        {
            **package,
            "created_from_list": _parse_json_text(package.get("created_from"), []),
        }
        for package in packages[:5]
    ]

    with connect(db_path) as conn:
        handoff_rows = conn.execute(
            """
            SELECT *
            FROM messages
            WHERE project_id = ?
              AND (to_agent = ? OR from_agent = ?)
            ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC
            LIMIT 10
            """,
            (project_id, agent_id, agent_id),
        ).fetchall()
        action_rows = conn.execute(
            """
            SELECT *
            FROM agent_operator_actions
            WHERE project_id = ? AND agent_id = ?
            ORDER BY created_at DESC, action_id DESC
            LIMIT 10
            """,
            (project_id, agent_id),
        ).fetchall()
    recent_handoffs = [row_to_dict(row) for row in handoff_rows]
    recent_actions = [
        item
        for item in (_read_agent_operator_action_row(row) for row in action_rows)
        if item is not None
    ]

    return {
        "project": {
            "project_id": project["project_id"],
            "name": project["name"],
            "goal": project["goal"],
        },
        "agent_state": agent_state,
        "route": route,
        "current_task": current_task,
        "execution_context": current_execution_context,
        "worktree": current_worktree,
        "recent_artifacts": recent_artifacts[:5],
        "recent_packages": recent_packages,
        "recent_handoffs": recent_handoffs,
        "recent_actions": recent_actions,
    }


def _build_agent_workspace_derived_messages(
    context: dict,
    *,
    thread_id: str,
    project_id: str,
    agent_id: str,
) -> list[dict]:
    derived: list[dict] = []

    for handoff in context.get("recent_handoffs", []):
        message_id = str(handoff.get("message_id") or "")
        if not message_id:
            continue
        created_at = str(handoff.get("created_at") or utc_now())
        updated_at = str(handoff.get("updated_at") or created_at)
        from_agent = str(handoff.get("from_agent") or "")
        to_agent = str(handoff.get("to_agent") or "")
        sender_type = "agent" if from_agent == agent_id else "system"
        direction = "incoming" if to_agent == agent_id else "outgoing"
        status = str(handoff.get("handoff_state") or handoff.get("status") or "queued")
        metadata = {
            "source": "derived_handoff",
            "handoff_direction": direction,
            "from_agent": from_agent,
            "to_agent": to_agent,
            "artifact_ref": handoff.get("artifact_ref"),
        }
        derived.append(
            {
                "message_id": f"derived-handoff-{message_id}",
                "thread_id": thread_id,
                "project_id": project_id,
                "agent_id": agent_id,
                "task_id": None,
                "execution_context_task_id": None,
                "sender_type": sender_type,
                "message_type": str(handoff.get("message_type") or "handoff"),
                "input_mode": "system",
                "intent": "status_update",
                "content": str(handoff.get("content") or ""),
                "status": status,
                "metadata_json": json.dumps(metadata),
                "metadata": metadata,
                "created_at": created_at,
                "updated_at": updated_at,
                "attachments": [],
            }
        )

    for artifact in context.get("recent_artifacts", []):
        artifact_id = str(artifact.get("artifact_id") or "")
        if not artifact_id:
            continue
        metadata = dict(artifact.get("metadata") or {})
        task_id = str(metadata.get("task_id") or "") or None
        created_at = str(artifact.get("updated_at") or artifact.get("created_at") or utc_now())
        content = (
            f"Artifact ready: {artifact.get('artifact_type')} v{artifact.get('version')} "
            f"({artifact.get('state')})"
        )
        derived.append(
            {
                "message_id": f"derived-artifact-{artifact_id}",
                "thread_id": thread_id,
                "project_id": project_id,
                "agent_id": agent_id,
                "task_id": task_id,
                "execution_context_task_id": task_id,
                "sender_type": "agent",
                "message_type": "artifact_update",
                "input_mode": "system",
                "intent": "status_update",
                "content": content,
                "status": str(artifact.get("state") or "ready"),
                "metadata_json": json.dumps(
                    {
                        "source": "derived_artifact",
                        "artifact_id": artifact_id,
                        "artifact_type": artifact.get("artifact_type"),
                        "path": artifact.get("path"),
                        "version": artifact.get("version"),
                    }
                ),
                "metadata": {
                    "source": "derived_artifact",
                    "artifact_id": artifact_id,
                    "artifact_type": artifact.get("artifact_type"),
                    "path": artifact.get("path"),
                    "version": artifact.get("version"),
                },
                "created_at": created_at,
                "updated_at": created_at,
                "attachments": [
                    {
                        "attachment_id": f"derived-attachment-{artifact_id}",
                        "message_id": f"derived-artifact-{artifact_id}",
                        "project_id": project_id,
                        "attachment_type": "artifact_ref",
                        "name": artifact_id,
                        "path": artifact.get("path"),
                        "mime_type": None,
                        "size_bytes": None,
                        "metadata_json": json.dumps({"artifact_id": artifact_id}),
                        "metadata": {"artifact_id": artifact_id},
                        "created_at": created_at,
                    }
                ],
            }
        )

    for package in context.get("recent_packages", []):
        package_id = str(package.get("package_id") or "")
        if not package_id:
            continue
        created_at = str(package.get("created_at") or utc_now())
        content = (
            f"Package frozen: {package.get('package_type')} v{package.get('version')} "
            f"({package.get('state')})"
        )
        derived.append(
            {
                "message_id": f"derived-package-{package_id}",
                "thread_id": thread_id,
                "project_id": project_id,
                "agent_id": agent_id,
                "task_id": None,
                "execution_context_task_id": None,
                "sender_type": "system",
                "message_type": "package_update",
                "input_mode": "system",
                "intent": "status_update",
                "content": content,
                "status": str(package.get("state") or "frozen"),
                "metadata_json": json.dumps(
                    {
                        "source": "derived_package",
                        "package_id": package_id,
                        "package_type": package.get("package_type"),
                        "manifest_path": package.get("manifest_path"),
                        "version": package.get("version"),
                    }
                ),
                "metadata": {
                    "source": "derived_package",
                    "package_id": package_id,
                    "package_type": package.get("package_type"),
                    "manifest_path": package.get("manifest_path"),
                    "version": package.get("version"),
                },
                "created_at": created_at,
                "updated_at": created_at,
                "attachments": [],
            }
        )

    derived.sort(
        key=lambda item: (
            str(item.get("created_at") or ""),
            str(item.get("message_id") or ""),
        )
    )
    return derived


def get_agent_workspace_thread(
    db_path: str,
    *,
    project_id: str,
    agent_id: str,
    limit: int = 80,
) -> dict:
    init_db(db_path)
    with connect(db_path) as conn:
        thread = _get_or_create_agent_thread_conn(
            conn,
            project_id=project_id,
            agent_id=agent_id,
        )
        rows = conn.execute(
            """
            SELECT *
            FROM agent_thread_messages
            WHERE thread_id = ?
            ORDER BY created_at DESC, message_id DESC
            LIMIT ?
            """,
            (thread["thread_id"], max(1, min(limit, 200))),
        ).fetchall()
    messages = list(reversed(rows))
    parsed_messages = [
        item
        for item in (_read_agent_thread_message_row(row) for row in messages)
        if item is not None
    ]
    message_ids = [str(item["message_id"]) for item in parsed_messages]
    attachments_by_message: dict[str, list[dict]] = {message_id: [] for message_id in message_ids}
    if message_ids:
        placeholders = ",".join("?" for _ in message_ids)
        with connect(db_path) as conn:
            attachment_rows = conn.execute(
                f"""
                SELECT *
                FROM agent_thread_attachments
                WHERE message_id IN ({placeholders})
                ORDER BY created_at ASC, attachment_id ASC
                """,
                tuple(message_ids),
            ).fetchall()
        for row in attachment_rows:
            attachment = _read_agent_thread_attachment_row(row)
            if attachment is None:
                continue
            attachments_by_message.setdefault(str(attachment["message_id"]), []).append(attachment)
    for message in parsed_messages:
        message["attachments"] = attachments_by_message.get(str(message["message_id"]), [])
    context = _build_agent_workspace_context(db_path, project_id, agent_id)
    derived_messages = _build_agent_workspace_derived_messages(
        context,
        thread_id=str(thread["thread_id"]),
        project_id=project_id,
        agent_id=agent_id,
    )
    merged_messages = parsed_messages + derived_messages
    merged_messages.sort(
        key=lambda item: (
            str(item.get("created_at") or ""),
            str(item.get("message_id") or ""),
        )
    )
    return {
        "project_id": project_id,
        "agent_id": agent_id,
        "thread": thread,
        "messages": merged_messages[-max(1, min(limit, 200)):],
        "context": context,
    }


def list_agent_workspace_overview(
    db_path: str,
    *,
    project_id: str,
    limit: int = 50,
) -> dict:
    init_db(db_path)
    project = get_project_record(db_path, project_id)
    tasks = list_tasks(db_path, project_id)["tasks"]
    task_map = {str(task["task_id"]): task for task in tasks}
    agent_states = list_agent_states(db_path, project_id)["agent_states"]
    state_map = {str(item["agent_id"]): item for item in agent_states}
    execution_contexts = list_task_execution_contexts(
        db_path,
        project_id=project_id,
        limit=200,
    )["execution_contexts"]
    latest_context_by_agent: dict[str, dict] = {}
    for item in execution_contexts:
        owner = str(item.get("owner_agent") or "runtime")
        latest_context_by_agent.setdefault(owner, item)

    messages = list_messages(db_path, project_id)["messages"]
    runtime_settings = get_runtime_settings(db_path)["settings"]
    handoff = _build_handoff_operator_backlog(
        messages,
        pending_timeout_seconds=int(runtime_settings["handoff_pending_timeout_seconds"]),
        blocked_timeout_seconds=int(runtime_settings["handoff_blocked_timeout_seconds"]),
    )
    handoff_map = {
        str(item["agent_id"]): item
        for item in handoff["handoff_sla"]["agents"]
    }

    routing = list_agent_routing(db_path)["routes"]
    route_map = {str(item["role"]): item for item in routing}

    with connect(db_path) as conn:
        thread_rows = conn.execute(
            """
            SELECT agent_id, MAX(last_message_at) AS last_message_at
            FROM agent_threads
            WHERE project_id = ?
            GROUP BY agent_id
            """,
            (project_id,),
        ).fetchall()
    thread_time_map = {
        str(row["agent_id"]): str(row["last_message_at"] or "")
        for row in thread_rows
    }

    agent_ids = set(COORDINATOR_ROLES)
    agent_ids.update(state_map.keys())
    agent_ids.update(latest_context_by_agent.keys())
    agent_ids.update(route_map.keys())
    agent_ids.update(handoff_map.keys())
    for task in tasks:
        agent_ids.add(str(task["owner_agent"]))

    overview: list[dict] = []
    state_rank = {
        "blocked": 0,
        "review_pending": 1,
        "executing": 2,
        "planning": 3,
        "waiting_input": 4,
        "idle": 5,
        "done": 6,
    }

    for agent_id in agent_ids:
        state_row = state_map.get(agent_id)
        context_row = latest_context_by_agent.get(agent_id)
        route_row = route_map.get(agent_id)
        handoff_row = handoff_map.get(agent_id, {})
        current_task_id = None
        if state_row and state_row.get("current_task_id"):
            current_task_id = str(state_row["current_task_id"])
        elif context_row and context_row.get("task_id"):
            current_task_id = str(context_row["task_id"])
        current_task = task_map.get(str(current_task_id)) if current_task_id else None
        derived_state = (
            str(state_row.get("state"))
            if state_row and state_row.get("state")
            else "executing"
            if context_row and str(context_row.get("status")) in {"active", "prepared"}
            else "idle"
        )
        last_event_at = max(
            [
                str(state_row.get("updated_at") or "") if state_row else "",
                str(context_row.get("updated_at") or "") if context_row else "",
                str(handoff_row.get("last_message_at") or ""),
                str(thread_time_map.get(agent_id) or ""),
            ]
        ) or None
        overview.append(
            {
                "agent_id": agent_id,
                "role": agent_id,
                "state": derived_state,
                "current_task_id": current_task_id,
                "current_task_title": current_task.get("title") if current_task else None,
                "current_task_status": current_task.get("status") if current_task else None,
                "open_handoffs": int(handoff_row.get("open_count") or 0),
                "blocked_handoffs": int(handoff_row.get("blocked_count") or 0),
                "timed_out_pending_handoffs": int(handoff_row.get("aged_pending_count") or 0),
                "sla_status": str(handoff_row.get("sla_status") or "healthy"),
                "execution_context": context_row,
                "provider": route_row.get("provider") if route_row else None,
                "model": route_row.get("model") if route_row else None,
                "auth_profile": route_row.get("auth_profile") if route_row else None,
                "last_event_at": last_event_at,
                "last_thread_message_at": thread_time_map.get(agent_id) or None,
            }
        )

    overview.sort(
        key=lambda item: (
            state_rank.get(str(item.get("state")), 99),
            0 if str(item.get("sla_status")) == "blocked" else 1 if str(item.get("sla_status")) == "degraded" else 2,
            -int(item.get("blocked_handoffs") or 0),
            -int(item.get("timed_out_pending_handoffs") or 0),
            str(item.get("last_event_at") or ""),
            str(item.get("agent_id") or ""),
        ),
        reverse=False,
    )
    overview.reverse()
    overview = sorted(
        overview,
        key=lambda item: (
            state_rank.get(str(item.get("state")), 99),
            0 if str(item.get("sla_status")) == "blocked" else 1 if str(item.get("sla_status")) == "degraded" else 2,
            -int(item.get("blocked_handoffs") or 0),
            -int(item.get("timed_out_pending_handoffs") or 0),
            -(1 if item.get("last_event_at") else 0),
            str(item.get("last_event_at") or ""),
            str(item.get("agent_id") or ""),
        ),
    )
    return {
        "project": {
            "project_id": project["project_id"],
            "name": project["name"],
            "goal": project["goal"],
            "status": project["status"],
        },
        "agents": overview[: max(1, min(limit, 200))],
        "count": len(overview),
    }
