from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from research_runtime.orchestrator.state_machine import (
    ensure_valid_agent_state,
    ensure_valid_artifact_transition,
    ensure_valid_task_status,
    ensure_valid_task_transition,
)

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
COORDINATOR_ROLES = ("explorer", "experiment", "writer", "reviewer")


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
    return {"db_path": str(Path(db_path).resolve()), "initialized": True}


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


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
              priority, artifact_ref, status, content, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
    to_agent: str | None = None,
    status: str | None = None,
) -> dict:
    init_db(db_path)
    query = """
        SELECT * FROM messages
        WHERE project_id = ?
    """
    params: list[object] = [project_id]
    if to_agent:
        query += " AND to_agent = ?"
        params.append(to_agent)
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC"

    with connect(db_path) as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return {
        "project_id": project_id,
        "messages": [row_to_dict(row) for row in rows],
    }


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


def build_project_read_model(db_path: str, project_id: str, *, limit: int = 60) -> dict:
    project = get_project_record(db_path, project_id)
    tasks = list_tasks(db_path, project_id)["tasks"]
    artifacts_raw = list_artifacts(db_path, project_id)["artifacts"]
    messages = list_messages(db_path, project_id)["messages"]
    events_raw = list_events(db_path, project_id)["events"]
    packages_raw = list_packages(db_path, project_id)["packages"]
    agent_states = list_agent_states(db_path, project_id)["agent_states"]

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
                "timestamp": message["created_at"],
                "title": f"{message['from_agent']} -> {message['to_agent']}",
                "summary": f"{message['message_type']} / {message['priority']}",
                "status": message["status"],
                "owner": message["to_agent"],
                "owner_agent": message["to_agent"],
                "event_type": None,
                "details": {
                    "from_agent": message["from_agent"],
                    "to_agent": message["to_agent"],
                    "message_type": message["message_type"],
                    "priority": message["priority"],
                    "artifact_ref": message["artifact_ref"],
                    "content": message["content"],
                    "created_at": message["created_at"],
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
            },
            "task_status_counts": _count_by(tasks, "status"),
            "task_owner_counts": _count_by(tasks, "owner_agent"),
            "event_type_counts": _count_by(events, "event_type"),
            "artifact_type_counts": _count_by(artifacts, "artifact_type"),
            "package_type_counts": _count_by(packages, "package_type"),
            "agent_state_counts": _count_by(agent_states, "state"),
            "latest_event_type": latest_event_type,
        },
        "read_model": {
            "active_tasks": active_tasks,
            "blocked_tasks": [task for task in tasks if str(task["status"]) == "blocked"],
            "latest_artifacts": latest_artifacts,
            "latest_packages": latest_packages,
            "agent_states": sorted(agent_states, key=lambda item: str(item["agent_id"])),
            "recent_messages": messages[:10],
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
    return {
        "roles": [
            {
                **route,
                "queue": queue_counts.get(str(route["role"]), {}),
                "agent_state": agent_states.get(str(route["role"])),
            }
            for route in routing
        ],
        "queue_counts": queue_counts,
    }
