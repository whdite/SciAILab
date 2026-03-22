from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from research_runtime.coordinators.runner import run_coordinators
from research_runtime.orchestrator.event_consumer import consume_pending_events
from research_runtime.orchestrator.task_driver import complete_task_and_emit
from research_runtime.storage.db import (
    build_scheduler_control_state,
    create_project,
    create_message,
    create_task,
    emit_event,
    freeze_package,
    claim_next_task,
    get_project_status,
    init_db,
    list_agent_routing,
    list_agent_states,
    list_artifacts,
    list_events,
    list_messages,
    list_packages,
    list_tasks,
    register_artifact,
    set_agent_activation,
    set_agent_state,
    transition_artifact_state,
    update_message_state,
    update_task_status,
    upsert_agent_routing,
)


def build_error(exc: Exception) -> dict[str, Any]:
    return {
        "status": "error",
        "error": str(exc),
        "error_type": exc.__class__.__name__,
    }


def handle_command(request: dict[str, Any]) -> dict[str, Any]:
    command = request.get("command")
    db_path = str(request.get("db_path") or "")
    workspace_root = str(request.get("workspace_root") or "")
    worktree_root = str(request.get("worktree_root") or (Path(workspace_root).resolve().parent / "worktrees"))
    payload = request.get("payload") or {}

    if not db_path:
        raise ValueError("db_path is required")

    if command == "health":
        return {"status": "ok", "result": {"python": sys.version.split()[0]}}

    if command == "init_db":
        return {"status": "ok", "result": init_db(db_path)}

    if command == "create_project":
        return {
            "status": "ok",
            "result": create_project(
                db_path,
                workspace_root,
                name=str(payload.get("name") or ""),
                goal=str(payload.get("goal") or ""),
                owner_agent=str(payload.get("owner_agent") or "control-plane"),
                project_id=str(payload["project_id"]) if payload.get("project_id") else None,
                bootstrap_flow=bool(payload.get("bootstrap_flow", True)),
            ),
        }

    if command == "get_project_status":
        return {
            "status": "ok",
            "result": get_project_status(
                db_path,
                str(payload.get("project_id") or ""),
            ),
        }

    if command == "list_agent_routing":
        return {
            "status": "ok",
            "result": list_agent_routing(db_path),
        }

    if command == "upsert_agent_routing":
        routes = payload.get("routes")
        return {
            "status": "ok",
            "result": upsert_agent_routing(
                db_path,
                list(routes) if isinstance(routes, list) else [],
            ),
        }

    if command == "set_agent_activation":
        return {
            "status": "ok",
            "result": set_agent_activation(
                db_path,
                role=str(payload.get("role") or ""),
                active=bool(payload.get("active")),
                max_concurrency=int(payload["max_concurrency"])
                if payload.get("max_concurrency") is not None
                else None,
            ),
        }

    if command == "build_scheduler_control_state":
        return {
            "status": "ok",
            "result": build_scheduler_control_state(db_path),
        }

    if command == "register_artifact":
        metadata = payload.get("metadata")
        deps = payload.get("upstream_dependencies")
        return {
            "status": "ok",
            "result": register_artifact(
                db_path,
                project_id=str(payload.get("project_id") or ""),
                artifact_type=str(payload.get("artifact_type") or ""),
                owner=str(payload.get("owner") or ""),
                path=str(payload.get("path") or ""),
                state=str(payload.get("state") or "draft"),
                version=int(payload["version"]) if payload.get("version") is not None else None,
                upstream_dependencies=list(deps) if isinstance(deps, list) else None,
                metadata=dict(metadata) if isinstance(metadata, dict) else None,
            ),
        }

    if command == "list_artifacts":
        return {
            "status": "ok",
            "result": list_artifacts(
                db_path,
                str(payload.get("project_id") or ""),
            ),
        }

    if command == "create_message":
        return {
            "status": "ok",
            "result": create_message(
                db_path,
                project_id=str(payload.get("project_id") or ""),
                from_agent=str(payload.get("from_agent") or ""),
                to_agent=str(payload.get("to_agent") or ""),
                message_type=str(payload.get("message_type") or ""),
                content=str(payload.get("content") or ""),
                priority=str(payload.get("priority") or "normal"),
                artifact_ref=str(payload["artifact_ref"]) if payload.get("artifact_ref") else None,
            ),
        }

    if command == "list_messages":
        return {
            "status": "ok",
            "result": list_messages(
                db_path,
                str(payload.get("project_id") or ""),
                from_agent=str(payload["from_agent"]) if payload.get("from_agent") else None,
                to_agent=str(payload["to_agent"]) if payload.get("to_agent") else None,
                status=str(payload["status"]) if payload.get("status") else None,
                handoff_state=str(payload["handoff_state"]) if payload.get("handoff_state") else None,
                limit=int(payload["limit"]) if payload.get("limit") is not None else None,
            ),
        }

    if command == "update_message_state":
        return {
            "status": "ok",
            "result": update_message_state(
                db_path,
                message_id=str(payload.get("message_id") or ""),
                status=str(payload["status"]) if payload.get("status") else None,
                handoff_state=str(payload["handoff_state"]) if payload.get("handoff_state") else None,
            ),
        }

    if command == "emit_event":
        raw_payload = payload.get("payload")
        return {
            "status": "ok",
            "result": emit_event(
                db_path,
                project_id=str(payload.get("project_id") or ""),
                event_type=str(payload.get("event_type") or ""),
                source=str(payload.get("source") or ""),
                payload=dict(raw_payload) if isinstance(raw_payload, dict) else None,
            ),
        }

    if command == "list_events":
        return {
            "status": "ok",
            "result": list_events(
                db_path,
                str(payload.get("project_id") or ""),
                status=str(payload["status"]) if payload.get("status") else None,
                event_type=str(payload["event_type"]) if payload.get("event_type") else None,
            ),
        }

    if command == "freeze_package":
        created_from = payload.get("created_from")
        return {
            "status": "ok",
            "result": freeze_package(
                db_path,
                workspace_root,
                project_id=str(payload.get("project_id") or ""),
                package_type=str(payload.get("package_type") or ""),
                created_from=list(created_from) if isinstance(created_from, list) else None,
                state=str(payload.get("state") or "frozen"),
            ),
        }

    if command == "list_packages":
        return {
            "status": "ok",
            "result": list_packages(
                db_path,
                str(payload.get("project_id") or ""),
                package_type=str(payload["package_type"]) if payload.get("package_type") else None,
            ),
        }

    if command == "create_task":
        return {
            "status": "ok",
            "result": create_task(
                db_path,
                project_id=str(payload.get("project_id") or ""),
                title=str(payload.get("title") or ""),
                scope=str(payload.get("scope") or ""),
                owner_agent=str(payload.get("owner_agent") or ""),
                dependency=str(payload["dependency"]) if payload.get("dependency") else None,
                acceptance=str(payload["acceptance"]) if payload.get("acceptance") else None,
                status=str(payload.get("status") or "todo"),
            ),
        }

    if command == "list_tasks":
        return {
            "status": "ok",
            "result": list_tasks(
                db_path,
                str(payload.get("project_id") or ""),
                owner_agent=str(payload["owner_agent"]) if payload.get("owner_agent") else None,
                status=str(payload["status"]) if payload.get("status") else None,
            ),
        }

    if command == "claim_task":
        return {
            "status": "ok",
            "result": {
                "task": claim_next_task(
                    db_path,
                    project_id=str(payload["project_id"]) if payload.get("project_id") else None,
                    owner_agent=str(payload["owner_agent"]) if payload.get("owner_agent") else None,
                ),
            },
        }

    if command == "update_task_status":
        if not payload.get("event_type"):
            completion = complete_task_and_emit(
                db_path,
                task_id=str(payload.get("task_id") or ""),
                status=str(payload.get("status") or ""),
                consume_after_emit=False,
                consume_limit=int(payload.get("limit") or 20),
            )
            return {
                "status": "ok",
                "result": {
                    **completion["task"],
                    "auto_actions": completion["auto_actions"],
                },
            }
        return {
            "status": "ok",
            "result": complete_task_and_emit(
                db_path,
                task_id=str(payload.get("task_id") or ""),
                status=str(payload.get("status") or ""),
                source=str(payload["source"]) if payload.get("source") else None,
                event_type=str(payload.get("event_type") or ""),
                event_payload=dict(payload["event_payload"])
                if isinstance(payload.get("event_payload"), dict)
                else None,
                consume_limit=int(payload.get("limit") or 20),
            ),
        }

    if command == "list_agent_states":
        return {
            "status": "ok",
            "result": list_agent_states(
                db_path,
                str(payload.get("project_id") or ""),
                agent_id=str(payload["agent_id"]) if payload.get("agent_id") else None,
                state=str(payload["state"]) if payload.get("state") else None,
            ),
        }

    if command == "run_coordinators":
        return {
            "status": "ok",
            "result": run_coordinators(
                db_path,
                workspace_root,
                worktree_root,
                project_id=str(payload["project_id"]) if payload.get("project_id") else None,
                owner_agent=str(payload["owner_agent"]) if payload.get("owner_agent") else None,
                limit=int(payload.get("limit") or 1),
                consume_limit=int(payload.get("consume_limit") or 20),
            ),
        }

    if command == "transition_artifact_state":
        return {
            "status": "ok",
            "result": transition_artifact_state(
                db_path,
                artifact_id=str(payload.get("artifact_id") or ""),
                next_state=str(payload.get("next_state") or ""),
            ),
        }

    if command == "set_agent_state":
        return {
            "status": "ok",
            "result": set_agent_state(
                db_path,
                project_id=str(payload.get("project_id") or ""),
                agent_id=str(payload.get("agent_id") or ""),
                state=str(payload.get("state") or ""),
                current_task_id=str(payload["current_task_id"])
                if payload.get("current_task_id")
                else None,
                last_error=str(payload["last_error"]) if payload.get("last_error") else None,
            ),
        }

    if command == "consume_events":
        return {
            "status": "ok",
            "result": consume_pending_events(
                db_path,
                str(payload.get("project_id") or ""),
                limit=int(payload.get("limit") or 20),
            ),
        }

    raise ValueError(f"unsupported command: {command}")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stdout.write(json.dumps(build_error(ValueError("empty request"))))
        return 1

    try:
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        response = handle_command(request)
    except Exception as exc:  # noqa: BLE001
        response = build_error(exc)

    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    return 0 if response.get("status") == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
