from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from research_runtime.orchestrator.task_driver import complete_task_and_emit
from research_runtime.orchestrator.worktree_manager import (
    activate_execution_workspace,
    finalize_execution_workspace,
)
from research_runtime.storage.db import (
    list_agent_routing,
    connect,
    create_message,
    freeze_package,
    get_task_execution_context,
    get_project_record,
    record_provider_observation_event,
    register_artifact,
    set_agent_state,
    utc_now,
)

COORDINATOR_AGENTS = ("explorer", "experiment", "writer", "reviewer")


def _route_for_role(db_path: str, role: str) -> dict[str, Any]:
    routes = list_agent_routing(db_path)["routes"]
    for route in routes:
        if str(route.get("role")) == role:
            return route
    return {
        "role": role,
        "provider": None,
        "model": None,
        "auth_profile": None,
        "active": True,
    }


def _select_next_task(
    db_path: str,
    *,
    project_id: str | None = None,
    owner_agent: str | None = None,
) -> dict[str, Any] | None:
    query = """
        SELECT
          tasks.*,
          projects.name AS project_name,
          projects.goal AS project_goal,
          projects.workspace_path AS workspace_path
        FROM tasks
        INNER JOIN projects ON projects.project_id = tasks.project_id
        WHERE tasks.status = 'todo'
    """
    params: list[object] = []
    if project_id:
        query += " AND tasks.project_id = ?"
        params.append(project_id)
    if owner_agent:
        query += " AND tasks.owner_agent = ?"
        params.append(owner_agent)
    else:
        query += f" AND tasks.owner_agent IN ({','.join('?' for _ in COORDINATOR_AGENTS)})"
        params.extend(COORDINATOR_AGENTS)
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
            WHERE task_id = ? AND status = 'todo'
            """,
            (utc_now(), task["task_id"]),
        )
        if updated.rowcount != 1:
            return None

    return task


def _artifacts_by_type(db_path: str, project_id: str, artifact_type: str) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM artifacts
            WHERE project_id = ? AND artifact_type = ?
            ORDER BY version DESC, created_at DESC
            """,
            (project_id, artifact_type),
        ).fetchall()
    return [{key: row[key] for key in row.keys()} for row in rows]


def _latest_artifact(db_path: str, project_id: str, artifact_type: str) -> dict[str, Any] | None:
    artifacts = _artifacts_by_type(db_path, project_id, artifact_type)
    return artifacts[0] if artifacts else None


def _artifact_by_id(db_path: str, artifact_id: str) -> dict[str, Any] | None:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM artifacts WHERE artifact_id = ?", (artifact_id,)).fetchone()
    return {key: row[key] for key in row.keys()} if row is not None else None


def _artifact_from_task_dependency(db_path: str, dependency: str | None) -> dict[str, Any] | None:
    if not dependency or ":" not in dependency:
        return None
    return _artifact_by_id(db_path, dependency)


def _artifact_metadata(artifact: dict[str, Any] | None) -> dict[str, Any]:
    if artifact is None:
        return {}
    raw = artifact.get("metadata_json")
    if not isinstance(raw, str) or not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write_markdown(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _read_markdown_excerpt(path_value: str | None) -> str:
    if not path_value:
        return ""
    path = Path(path_value)
    if not path.exists():
        return ""
    content = path.read_text(encoding="utf-8")
    return content.strip()[:800]


def _coordinator_run_path(workspace_path: str, owner_agent: str, task_id: str, stem: str) -> Path:
    return Path(workspace_path) / "artifacts" / owner_agent / f"{stem}_{task_id}.md"


def _task_output_workspace(task: dict[str, Any]) -> str:
    execution_workspace_path = str(task.get("execution_workspace_path") or "").strip()
    if execution_workspace_path:
        return execution_workspace_path
    return str(task["workspace_path"])


def _set_running_state(project_id: str, owner_agent: str, task_id: str, db_path: str) -> None:
    set_agent_state(
        db_path,
        project_id=project_id,
        agent_id=owner_agent,
        state="executing",
        current_task_id=task_id,
    )


def _set_idle_state(project_id: str, owner_agent: str, db_path: str) -> None:
    set_agent_state(
        db_path,
        project_id=project_id,
        agent_id=owner_agent,
        state="idle",
        current_task_id=None,
    )


def _run_explorer_task(db_path: str, workspace_root: str, task: dict[str, Any], consume_limit: int) -> dict[str, Any]:
    project_id = str(task["project_id"])
    artifact_workspace_path = _task_output_workspace(task)
    artifact_path = _coordinator_run_path(artifact_workspace_path, "explorer", str(task["task_id"]), "hypotheses")
    _write_markdown(
        artifact_path,
        [
            f"# Hypotheses for {task['project_name']}",
            "",
            f"- project_id: {project_id}",
            f"- task_id: {task['task_id']}",
            f"- created_at: {utc_now()}",
            "",
            "## Goal",
            "",
            str(task["project_goal"] or "Clarify the research objective."),
            "",
            "## Hypotheses",
            "",
            "1. The baseline OpenClaw control plane can host a research-specific orchestration layer.",
            "2. Event-driven task handoff reduces coordinator drift and repeated planning.",
            "3. Frozen packages make writer and reviewer stages auditable and convergent.",
        ],
    )
    artifact = register_artifact(
        db_path,
        project_id=project_id,
        artifact_type="hypotheses",
        owner="explorer",
        path=str(artifact_path.resolve()),
        state="ready_for_experiment",
        metadata={"task_id": task["task_id"], "scope": task["scope"]},
    )
    package = freeze_package(
        db_path,
        workspace_root,
        project_id=project_id,
        package_type="research_package",
        created_from=[str(artifact["artifact_id"])],
        state="frozen",
    )
    completion = complete_task_and_emit(
        db_path,
        task_id=str(task["task_id"]),
        status="done",
        source="explorer",
        event_type="hypothesis_ready_for_experiment",
        event_payload={
            "artifact_id": artifact["artifact_id"],
            "package_id": package["package_id"],
        },
        consume_limit=consume_limit,
    )
    _set_idle_state(project_id, "explorer", db_path)
    return {
        "artifact": artifact,
        "package": package,
        "completion": completion,
    }


def _run_experiment_task(db_path: str, workspace_root: str, task: dict[str, Any], consume_limit: int) -> dict[str, Any]:
    project_id = str(task["project_id"])
    artifact_workspace_path = _task_output_workspace(task)
    hypothesis = _latest_artifact(db_path, project_id, "hypotheses")
    if hypothesis is None:
        raise ValueError(f"experiment coordinator requires hypotheses artifact for project {project_id}")
    review_feedback = _artifact_from_task_dependency(db_path, str(task.get("dependency") or ""))
    review_feedback_excerpt = _read_markdown_excerpt(str(review_feedback["path"])) if review_feedback else ""
    review_feedback_metadata = _artifact_metadata(review_feedback)
    upstream_dependencies = [str(hypothesis["artifact_id"])]
    if review_feedback is not None:
        upstream_dependencies.append(str(review_feedback["artifact_id"]))

    artifact_path = _coordinator_run_path(artifact_workspace_path, "experiment", str(task["task_id"]), "results_summary")
    task_title = str(task["title"])
    task_acceptance = str(task["acceptance"] or "")
    lines = [
        f"# Experiment Results for {task['project_name']}",
        "",
        f"- project_id: {project_id}",
        f"- task_id: {task['task_id']}",
        f"- hypothesis_artifact: {hypothesis['artifact_id']}",
        f"- created_at: {utc_now()}",
        "",
        "## Task Context",
        "",
        f"- title: {task_title}",
        f"- acceptance: {task_acceptance or '(none)'}",
    ]
    if review_feedback is not None:
        lines.extend(
            [
                f"- review_feedback: {review_feedback['artifact_id']}",
                f"- requested_action: {review_feedback_metadata.get('requested_action') or '(none)'}",
            ]
        )
    lines.extend(
        [
            "",
            "## Experiment Plan",
            "",
            "- Validate the FastAPI-driven event chain in a single-project SQLite workspace.",
            "- Measure whether tasks are created, consumed, and handed off without manual polling.",
        ]
    )
    if review_feedback is not None:
        lines.extend(
            [
                "",
                "## Reviewer Feedback Context",
                "",
                review_feedback_excerpt or "(review report content unavailable)",
            ]
        )
    lines.extend(
        [
            "",
            "## Results Summary",
            "",
            "- Event consumption produced the expected downstream task.",
            "- The runtime preserved project truth in SQLite while artifacts were persisted to markdown.",
            "- The coordinator chain stayed within the OpenClaw plugin boundary.",
        ]
    )
    _write_markdown(artifact_path, lines)
    artifact = register_artifact(
        db_path,
        project_id=project_id,
        artifact_type="results_summary",
        owner="experiment",
        path=str(artifact_path.resolve()),
        state="complete",
        upstream_dependencies=upstream_dependencies,
        metadata={
            "task_id": task["task_id"],
            "scope": task["scope"],
            "review_feedback_artifact_id": review_feedback["artifact_id"] if review_feedback is not None else None,
        },
    )
    package = freeze_package(
        db_path,
        workspace_root,
        project_id=project_id,
        package_type="experiment_bundle",
        created_from=[str(hypothesis["artifact_id"]), str(artifact["artifact_id"])],
        state="frozen",
    )
    completion = complete_task_and_emit(
        db_path,
        task_id=str(task["task_id"]),
        status="done",
        source="experiment",
        event_type="experiment_results_ready",
        event_payload={
            "artifact_id": artifact["artifact_id"],
            "package_id": package["package_id"],
        },
        consume_limit=consume_limit,
    )
    _set_idle_state(project_id, "experiment", db_path)
    return {
        "artifact": artifact,
        "package": package,
        "completion": completion,
    }


def _run_writer_task(db_path: str, workspace_root: str, task: dict[str, Any], consume_limit: int) -> dict[str, Any]:
    project_id = str(task["project_id"])
    artifact_workspace_path = _task_output_workspace(task)
    hypothesis = _latest_artifact(db_path, project_id, "hypotheses")
    results_summary = _latest_artifact(db_path, project_id, "results_summary")
    if hypothesis is None or results_summary is None:
        raise ValueError(f"writer coordinator requires hypotheses and results_summary artifacts for project {project_id}")
    review_feedback = _artifact_from_task_dependency(db_path, str(task.get("dependency") or ""))
    review_feedback_excerpt = _read_markdown_excerpt(str(review_feedback["path"])) if review_feedback else ""
    review_feedback_metadata = _artifact_metadata(review_feedback)
    upstream_dependencies = [str(hypothesis["artifact_id"]), str(results_summary["artifact_id"])]
    if review_feedback is not None:
        upstream_dependencies.append(str(review_feedback["artifact_id"]))

    package = freeze_package(
        db_path,
        workspace_root,
        project_id=project_id,
        package_type="writing_input_package",
        created_from=upstream_dependencies,
        state="frozen",
    )
    artifact_path = _coordinator_run_path(artifact_workspace_path, "writer", str(task["task_id"]), "draft")
    task_title = str(task["title"])
    task_acceptance = str(task["acceptance"] or "")
    lines = [
        f"# Draft for {task['project_name']}",
        "",
        f"- project_id: {project_id}",
        f"- task_id: {task['task_id']}",
        f"- writing_input_package: {package['package_id']}",
        f"- created_at: {utc_now()}",
        "",
        "## Task Context",
        "",
        f"- title: {task_title}",
        f"- acceptance: {task_acceptance or '(none)'}",
        "",
        "## Abstract",
        "",
        "We present a minimal research control plane built on top of OpenClaw and a FastAPI runtime.",
        "",
        "## Core Claim",
        "",
        "An event-driven coordinator chain can manage project truth, artifact ownership, and reviewer loops without rewriting OpenClaw core.",
        "",
        "## Evidence",
        "",
        f"- Hypothesis source: {hypothesis['artifact_id']}",
        f"- Experiment source: {results_summary['artifact_id']}",
    ]
    if review_feedback is not None:
        lines.extend(
            [
                f"- Review feedback source: {review_feedback['artifact_id']}",
                "",
                "## Review Feedback",
                "",
                f"- requested_action: {review_feedback_metadata.get('requested_action') or '(none)'}",
                f"- review_cycle: {review_feedback_metadata.get('review_cycle') or '(unknown)'}",
                "",
                review_feedback_excerpt or "(review report content unavailable)",
            ]
        )
    _write_markdown(artifact_path, lines)
    artifact = register_artifact(
        db_path,
        project_id=project_id,
        artifact_type="draft",
        owner="writer",
        path=str(artifact_path.resolve()),
        state="ready",
        upstream_dependencies=upstream_dependencies,
        metadata={
            "task_id": task["task_id"],
            "scope": task["scope"],
            "package_id": package["package_id"],
            "review_feedback_artifact_id": review_feedback["artifact_id"] if review_feedback is not None else None,
        },
    )
    completion = complete_task_and_emit(
        db_path,
        task_id=str(task["task_id"]),
        status="done",
        source="writer",
        event_type="review_requested",
        event_payload={
            "artifact_id": artifact["artifact_id"],
            "package_id": package["package_id"],
        },
        consume_limit=consume_limit,
    )
    _set_idle_state(project_id, "writer", db_path)
    return {
        "artifact": artifact,
        "package": package,
        "completion": completion,
    }


def _run_reviewer_task(db_path: str, _workspace_root: str, task: dict[str, Any], consume_limit: int) -> dict[str, Any]:
    project_id = str(task["project_id"])
    artifact_workspace_path = _task_output_workspace(task)
    draft = _latest_artifact(db_path, project_id, "draft")
    if draft is None:
        raise ValueError(f"reviewer coordinator requires a draft artifact for project {project_id}")

    prior_reports = _artifacts_by_type(db_path, project_id, "review_report")
    review_cycle = len(prior_reports) + 1
    review_sequence = [
        ("review_requires_ablation", "experiment", "review_note", "ablation"),
        ("review_requires_evidence", "experiment", "review_note", "evidence"),
        ("review_requires_revision", "writer", "review_note", "revision"),
        ("review_approved", "writer", "approval", "approved"),
    ]
    event_type, message_target, message_type, requested_action = review_sequence[
        min(len(prior_reports), len(review_sequence) - 1)
    ]
    artifact_path = _coordinator_run_path(artifact_workspace_path, "reviewer", str(task["task_id"]), "review_report")
    _write_markdown(
        artifact_path,
        [
            f"# Review Report for {task['project_name']}",
            "",
            f"- project_id: {project_id}",
            f"- task_id: {task['task_id']}",
            f"- draft_artifact: {draft['artifact_id']}",
            f"- review_cycle: {review_cycle}",
            f"- created_at: {utc_now()}",
            "",
            "## Summary",
            "",
            "The draft is structurally coherent and grounded in the project event history.",
            "",
            "## Decision",
            "",
            f"- Reviewer action: {requested_action}.",
            "",
            "## Notes",
            "",
            _read_markdown_excerpt(str(draft["path"])),
        ],
    )
    artifact = register_artifact(
        db_path,
        project_id=project_id,
        artifact_type="review_report",
        owner="reviewer",
        path=str(artifact_path.resolve()),
        state="complete",
        upstream_dependencies=[str(draft["artifact_id"])],
        metadata={
            "task_id": task["task_id"],
            "scope": task["scope"],
            "review_cycle": review_cycle,
            "requested_action": requested_action,
        },
    )
    create_message(
        db_path,
        project_id=project_id,
        from_agent="reviewer",
        to_agent=message_target,
        message_type=message_type,
        content=(
            "Please run one additional ablation pass before final approval."
            if requested_action == "ablation"
            else "Please gather stronger evidence for the current claims."
            if requested_action == "evidence"
            else "Please revise the draft to address reviewer comments."
            if requested_action == "revision"
            else "The draft is approved for the current MVP milestone."
        ),
        artifact_ref=str(artifact["artifact_id"]),
    )
    completion = complete_task_and_emit(
        db_path,
        task_id=str(task["task_id"]),
        status="done",
        source="reviewer",
        event_type=event_type,
        event_payload={
            "artifact_id": artifact["artifact_id"],
            "draft_artifact_id": draft["artifact_id"],
            "requested_action": requested_action,
            "next_agent": message_target,
            "review_cycle": review_cycle,
        },
        consume_limit=consume_limit,
    )
    _set_idle_state(project_id, "reviewer", db_path)
    return {
        "artifact": artifact,
        "completion": completion,
        "requested_action": requested_action,
        "review_cycle": review_cycle,
    }


def run_next_coordinator_task(
    db_path: str,
    workspace_root: str,
    worktree_root: str,
    *,
    project_id: str | None = None,
    owner_agent: str | None = None,
    consume_limit: int = 20,
) -> dict[str, Any]:
    task = _select_next_task(db_path, project_id=project_id, owner_agent=owner_agent)
    if task is None:
        return {"executed": False}

    project = get_project_record(db_path, str(task["project_id"]))
    task["workspace_path"] = project["workspace_path"]
    task["project_name"] = project["name"]
    task["project_goal"] = project["goal"]
    owner = str(task["owner_agent"])
    _set_running_state(str(task["project_id"]), owner, str(task["task_id"]), db_path)

    handlers = {
        "explorer": _run_explorer_task,
        "experiment": _run_experiment_task,
        "writer": _run_writer_task,
        "reviewer": _run_reviewer_task,
    }
    handler = handlers.get(owner)
    if handler is None:
        raise ValueError(f"unsupported coordinator owner_agent: {owner}")

    execution: dict[str, Any] | None = None
    try:
        execution = activate_execution_workspace(
            db_path,
            worktree_root,
            project_id=str(task["project_id"]),
            task_id=str(task["task_id"]),
            owner_agent=owner,
            runtime_kind="coordinator",
            metadata={"source": "run_next_coordinator_task"},
        )
        execution_context = execution.get("execution_context") if isinstance(execution, dict) else None
        worktree = execution.get("worktree") if isinstance(execution, dict) else None
        if isinstance(execution_context, dict):
            task["execution_workspace_path"] = execution_context.get("execution_workspace_path")
            task["canonical_workspace_path"] = execution_context.get("canonical_workspace_path")
        if isinstance(worktree, dict):
            task["worktree_id"] = worktree.get("worktree_id")
        route = _route_for_role(db_path, owner)
        record_provider_observation_event(
            db_path,
            role=owner,
            event_type="attempt",
            provider=route.get("provider"),
            model=route.get("model"),
            auth_profile=route.get("auth_profile"),
        )
        result = handler(db_path, workspace_root, task, consume_limit)
        latest_context = get_task_execution_context(db_path, str(task["task_id"]))
        if latest_context is None or str(latest_context.get("status")) not in {"cleaned", "completed"}:
            execution = finalize_execution_workspace(
                db_path,
                task_id=str(task["task_id"]),
                final_status="completed",
                metadata={"source": "run_next_coordinator_task"},
            )
        record_provider_observation_event(
            db_path,
            role=owner,
            event_type="success",
            provider=route.get("provider"),
            model=route.get("model"),
            auth_profile=route.get("auth_profile"),
        )
    except Exception as exc:
        route = _route_for_role(db_path, owner)
        record_provider_observation_event(
            db_path,
            role=owner,
            event_type="failure",
            provider=route.get("provider"),
            model=route.get("model"),
            auth_profile=route.get("auth_profile"),
            error=str(exc),
        )
        execution = finalize_execution_workspace(
            db_path,
            task_id=str(task["task_id"]),
            final_status="blocked",
            metadata={"error": str(exc), "source": "run_next_coordinator_task"},
        )
        complete_task_and_emit(
            db_path,
            task_id=str(task["task_id"]),
            status="blocked",
            source=owner,
            event_type="agent_blocked",
            event_payload={
                "agent_id": owner,
                "task_id": task["task_id"],
                "reason": str(exc),
            },
            consume_limit=consume_limit,
        )
        set_agent_state(
            db_path,
            project_id=str(task["project_id"]),
            agent_id=owner,
            state="blocked",
            current_task_id=str(task["task_id"]),
            last_error=str(exc),
        )
        raise
    return {
        "executed": True,
        "owner_agent": owner,
        "project_id": task["project_id"],
        "task_id": task["task_id"],
        "execution": execution,
        "result": result,
    }


def run_coordinators(
    db_path: str,
    workspace_root: str,
    worktree_root: str,
    *,
    project_id: str | None = None,
    owner_agent: str | None = None,
    limit: int = 10,
    consume_limit: int = 20,
) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    for _ in range(limit):
        result = run_next_coordinator_task(
            db_path,
            workspace_root,
            worktree_root,
            project_id=project_id,
            owner_agent=owner_agent,
            consume_limit=consume_limit,
        )
        if not result["executed"]:
            break
        runs.append(result)

    return {
        "count": len(runs),
        "runs": runs,
        "project_id": project_id,
        "owner_agent": owner_agent,
        "idle": len(runs) < limit,
    }
