from __future__ import annotations

from typing import Any

from research_runtime.orchestrator.event_consumer import consume_pending_events
from research_runtime.storage.db import emit_event, get_task_record, update_task_status


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
    if not event_type:
        return task

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
    }


def get_task_completion_context(db_path: str, task_id: str) -> dict[str, Any]:
    return get_task_record(db_path, task_id)
