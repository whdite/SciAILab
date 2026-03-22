from __future__ import annotations

from typing import Any

from research_runtime.orchestrator.archive_manager import (
    cleanup_execution_result,
    create_checkpoint,
    merge_execution_result,
)
from research_runtime.orchestrator.event_consumer import consume_pending_events
from research_runtime.settings import load_settings
from research_runtime.storage.db import (
    emit_event,
    get_task_execution_context,
    get_task_record,
    update_task_status,
)


def complete_task_and_emit(
    db_path: str,
    *,
    task_id: str,
    status: str,
    source: str | None = None,
    event_type: str | None = None,
    event_payload: dict[str, Any] | None = None,
    consume_after_emit: bool = True,
    consume_limit: int = 20,
) -> dict[str, Any]:
    task = update_task_status(db_path, task_id=task_id, status=status)
    auto_actions = _run_auto_completion_pipeline(db_path, task)
    if not event_type:
        return {
            "task": task,
            "event": None,
            "downstream": None,
            "auto_actions": auto_actions,
        }

    event = emit_event(
        db_path,
        project_id=str(task["project_id"]),
        event_type=event_type,
        source=source or str(task["owner_agent"]),
        payload=event_payload,
    )
    downstream = (
        consume_pending_events(
            db_path,
            str(task["project_id"]),
            limit=consume_limit,
        )
        if consume_after_emit
        else None
    )
    return {
        "task": task,
        "event": event,
        "downstream": downstream,
        "auto_actions": auto_actions,
    }


def get_task_completion_context(db_path: str, task_id: str) -> dict[str, Any]:
    task = get_task_record(db_path, task_id)
    return {
        "task": task,
        "execution_context": get_task_execution_context(db_path, task_id),
    }


def _run_auto_completion_pipeline(db_path: str, task: dict[str, Any]) -> dict[str, Any] | None:
    if str(task.get("status")) != "done":
        return None
    context = get_task_execution_context(db_path, str(task["task_id"]))
    if context is None:
        return {"skipped": True, "reason": "no_execution_context"}

    settings = load_settings()
    result: dict[str, Any] = {
        "skipped": False,
        "checkpoint": None,
        "merge": None,
        "cleanup": None,
        "errors": [],
    }
    try:
        result["checkpoint"] = create_checkpoint(
            db_path,
            str(settings.workspace_root),
            task_id=str(task["task_id"]),
        )
    except Exception as exc:  # noqa: BLE001
        result["errors"].append({"stage": "checkpoint", "error": str(exc)})
        return result

    try:
        result["merge"] = merge_execution_result(
            db_path,
            str(settings.workspace_root),
            task_id=str(task["task_id"]),
        )
    except Exception as exc:  # noqa: BLE001
        result["errors"].append({"stage": "merge", "error": str(exc)})
        return result

    if context.get("worktree_id"):
        try:
            result["cleanup"] = cleanup_execution_result(
                db_path,
                task_id=str(task["task_id"]),
            )
        except Exception as exc:  # noqa: BLE001
            result["errors"].append({"stage": "cleanup", "error": str(exc)})
    else:
        result["cleanup"] = {"skipped": True, "reason": "no_worktree_id"}
    return result
