from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass

from research_runtime.orchestrator.state_machine import (
    ensure_valid_agent_state,
    ensure_valid_task_transition,
)
from research_runtime.storage.db import connect, row_to_dict, utc_now


@dataclass(frozen=True)
class DownstreamTaskRule:
    action: str
    owner_agent: str
    scope: str
    title: str
    acceptance: str
    to_agent: str
    message_type: str
    content: str
    agent_state: str


DOWNSTREAM_TASK_RULES: dict[str, DownstreamTaskRule] = {
    "hypothesis_ready_for_experiment": DownstreamTaskRule(
        action="experiment_task_created",
        owner_agent="experiment",
        scope="experiment",
        title="Design and run experiment for hypothesis package",
        acceptance="Produce experiment plan and initial results summary.",
        to_agent="experiment",
        message_type="request",
        content="A hypothesis package is ready. Please create an experiment plan.",
        agent_state="planning",
    ),
    "experiment_results_ready": DownstreamTaskRule(
        action="writer_task_created",
        owner_agent="writer",
        scope="writer",
        title="Write draft from experiment results bundle",
        acceptance="Produce draft outline or next draft revision.",
        to_agent="writer",
        message_type="handoff",
        content="Experiment results are ready for writing input assembly.",
        agent_state="planning",
    ),
    "writer_needs_evidence": DownstreamTaskRule(
        action="evidence_task_created",
        owner_agent="experiment",
        scope="experiment",
        title="Provide missing evidence requested by writer",
        acceptance="Return evidence or explain the missing support.",
        to_agent="experiment",
        message_type="need_evidence",
        content="Writer requested additional evidence for the current draft.",
        agent_state="executing",
    ),
    "review_requested": DownstreamTaskRule(
        action="review_task_created",
        owner_agent="reviewer",
        scope="review",
        title="Review the latest draft and return publication feedback",
        acceptance="Produce review notes or approval decision for the current draft.",
        to_agent="reviewer",
        message_type="review_request",
        content="A draft is ready for review. Please evaluate and return review notes.",
        agent_state="review_pending",
    ),
    "review_requires_ablation": DownstreamTaskRule(
        action="ablation_task_created",
        owner_agent="experiment",
        scope="experiment",
        title="Run ablation requested by reviewer",
        acceptance="Produce ablation results and updated summary.",
        to_agent="experiment",
        message_type="review_note",
        content="Reviewer requested additional ablation experiments.",
        agent_state="planning",
    ),
    "review_requires_evidence": DownstreamTaskRule(
        action="evidence_followup_task_created",
        owner_agent="experiment",
        scope="experiment",
        title="Gather additional evidence requested by reviewer",
        acceptance="Produce the missing evidence and update the experiment summary.",
        to_agent="experiment",
        message_type="review_note",
        content="Reviewer requested stronger evidence for the current draft.",
        agent_state="planning",
    ),
    "review_requires_revision": DownstreamTaskRule(
        action="revision_task_created",
        owner_agent="writer",
        scope="writer",
        title="Revise draft based on reviewer feedback",
        acceptance="Produce an updated draft that addresses reviewer revision notes.",
        to_agent="writer",
        message_type="review_note",
        content="Reviewer requested a draft revision before approval.",
        agent_state="planning",
    ),
}


def _create_task(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    project_id: str,
    title: str,
    scope: str,
    owner_agent: str,
    status: str,
    acceptance: str,
    dependency: str | None = None,
) -> None:
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
            utc_now(),
            utc_now(),
        ),
    )


def _create_message(
    conn: sqlite3.Connection,
    *,
    message_id: str,
    project_id: str,
    from_agent: str,
    to_agent: str,
    message_type: str,
    content: str,
    artifact_ref: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO messages (
          message_id, project_id, from_agent, to_agent, message_type,
          priority, artifact_ref, status, content, created_at
        ) VALUES (?, ?, ?, ?, ?, 'normal', ?, 'pending', ?, ?)
        """,
        (
            message_id,
            project_id,
            from_agent,
            to_agent,
            message_type,
            artifact_ref,
            content,
            utc_now(),
        ),
    )


def _set_agent_state(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    agent_id: str,
    state: str,
    current_task_id: str | None = None,
    last_error: str | None = None,
) -> None:
    ensure_valid_agent_state(state)
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
            utc_now(),
            last_error,
            utc_now(),
        ),
    )


def _load_task(conn: sqlite3.Connection, task_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    return row_to_dict(row)


def _update_task_status(
    conn: sqlite3.Connection,
    *,
    task_id: str,
    next_status: str,
) -> dict:
    current = _load_task(conn, task_id)
    if current is None:
        raise ValueError(f"task not found: {task_id}")
    ensure_valid_task_transition(str(current["status"]), next_status)
    conn.execute(
        "UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?",
        (next_status, utc_now(), task_id),
    )
    updated = _load_task(conn, task_id)
    if updated is None:
        raise RuntimeError("task update failed")
    return updated


def _task_artifact_ref(payload: dict) -> str | None:
    artifact_id = payload.get("artifact_id")
    if isinstance(artifact_id, str) and artifact_id:
        return artifact_id
    draft_artifact_id = payload.get("draft_artifact_id")
    if isinstance(draft_artifact_id, str) and draft_artifact_id:
        return draft_artifact_id
    return None


def _dependency_for_payload(payload: dict) -> str | None:
    package_id = payload.get("package_id")
    if isinstance(package_id, str) and package_id:
        return package_id
    artifact_ref = _task_artifact_ref(payload)
    return artifact_ref


def _consume_downstream_task_rule(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    event: dict,
    payload: dict,
    rule: DownstreamTaskRule,
) -> str:
    task_id = f"task_{event['event_id']}"
    _create_task(
        conn,
        task_id=task_id,
        project_id=project_id,
        title=rule.title,
        scope=rule.scope,
        owner_agent=rule.owner_agent,
        status="todo",
        acceptance=rule.acceptance,
        dependency=_dependency_for_payload(payload),
    )
    _create_message(
        conn,
        message_id=f"msg_{event['event_id']}",
        project_id=project_id,
        from_agent=str(event["source"]),
        to_agent=rule.to_agent,
        message_type=rule.message_type,
        content=rule.content,
        artifact_ref=_task_artifact_ref(payload),
    )
    _set_agent_state(
        conn,
        project_id=project_id,
        agent_id=rule.owner_agent,
        state=rule.agent_state,
        current_task_id=task_id,
    )
    return rule.action


def _handle_agent_blocked(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    event: dict,
    payload: dict,
) -> str:
    agent_id = str(payload.get("agent_id") or event["source"])
    task_id = payload.get("task_id")
    if isinstance(task_id, str) and task_id:
        task = _load_task(conn, task_id)
        if task is not None and str(task["status"]) != "blocked":
            _update_task_status(conn, task_id=task_id, next_status="blocked")
    _set_agent_state(
        conn,
        project_id=project_id,
        agent_id=agent_id,
        state="blocked",
        current_task_id=task_id if isinstance(task_id, str) and task_id else None,
        last_error=str(payload.get("reason") or "blocked"),
    )
    return "agent_blocked"


def _handle_agent_recovered(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    event: dict,
    payload: dict,
) -> str:
    agent_id = str(payload.get("agent_id") or event["source"])
    _set_agent_state(
        conn,
        project_id=project_id,
        agent_id=agent_id,
        state="idle",
        current_task_id=None,
        last_error=None,
    )
    return "agent_recovered"


def _handle_task_retry_requested(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    payload: dict,
) -> str:
    task_id = payload.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("task_retry_requested requires payload.task_id")
    task = _update_task_status(conn, task_id=task_id, next_status="retry")
    _set_agent_state(
        conn,
        project_id=project_id,
        agent_id=str(task["owner_agent"]),
        state="planning",
        current_task_id=None,
        last_error=None,
    )
    return "task_retry_requested"


def _handle_task_requeued(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    payload: dict,
) -> str:
    task_id = payload.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("task_requeued requires payload.task_id")
    task = _update_task_status(conn, task_id=task_id, next_status="todo")
    _set_agent_state(
        conn,
        project_id=project_id,
        agent_id=str(task["owner_agent"]),
        state="planning",
        current_task_id=task_id,
        last_error=None,
    )
    return "task_requeued"


def _handle_review_approved(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    payload: dict,
) -> str:
    writer_agent = payload.get("next_agent")
    if isinstance(writer_agent, str) and writer_agent:
        _set_agent_state(
            conn,
            project_id=project_id,
            agent_id=writer_agent,
            state="done",
            current_task_id=None,
            last_error=None,
        )
    return "review_approved"


def consume_pending_events(db_path: str, project_id: str, *, limit: int = 20) -> dict:
    consumed: list[dict] = []
    with connect(db_path) as conn:
        events = conn.execute(
            """
            SELECT * FROM events
            WHERE project_id = ? AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (project_id, limit),
        ).fetchall()

        for row in events:
            event = row_to_dict(row)
            if event is None:
                continue
            payload = json.loads(event["payload"] or "{}")
            event_type = str(event["event_type"])
            event_id = str(event["event_id"])

            if event_type in DOWNSTREAM_TASK_RULES:
                action = _consume_downstream_task_rule(
                    conn,
                    project_id=project_id,
                    event=event,
                    payload=payload,
                    rule=DOWNSTREAM_TASK_RULES[event_type],
                )
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            if event_type == "agent_blocked":
                action = _handle_agent_blocked(conn, project_id=project_id, event=event, payload=payload)
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            if event_type == "agent_recovered":
                action = _handle_agent_recovered(conn, project_id=project_id, event=event, payload=payload)
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            if event_type == "task_retry_requested":
                action = _handle_task_retry_requested(conn, project_id=project_id, payload=payload)
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            if event_type == "task_requeued":
                action = _handle_task_requeued(conn, project_id=project_id, payload=payload)
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            if event_type == "review_approved":
                action = _handle_review_approved(conn, project_id=project_id, payload=payload)
                conn.execute("UPDATE events SET status = 'consumed' WHERE event_id = ?", (event_id,))
                consumed.append({"event_id": event_id, "action": action})
                continue

            conn.execute("UPDATE events SET status = 'ignored' WHERE event_id = ?", (event_id,))
            consumed.append({"event_id": event_id, "action": "ignored"})

    return {
        "project_id": project_id,
        "consumed": consumed,
        "count": len(consumed),
    }
