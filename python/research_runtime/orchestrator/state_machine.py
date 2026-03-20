from __future__ import annotations


ARTIFACT_STATE_TRANSITIONS: dict[str, set[str]] = {
    "draft": {"updated", "ready_for_experiment", "frozen", "deprecated"},
    "updated": {"ready_for_experiment", "revising", "frozen", "deprecated"},
    "ready_for_experiment": {"running", "revising", "frozen", "deprecated"},
    "running": {"partial", "complete", "failed", "frozen"},
    "partial": {"complete", "failed", "frozen"},
    "complete": {"frozen", "superseded"},
    "revising": {"updated", "ready_for_experiment", "deprecated"},
    "failed": {"revising", "deprecated"},
    "assembling": {"ready", "frozen", "superseded"},
    "ready": {"frozen", "superseded"},
    "frozen": {"superseded", "deprecated"},
    "superseded": {"deprecated"},
    "deprecated": set(),
}

AGENT_STATES: set[str] = {
    "idle",
    "waiting_input",
    "planning",
    "executing",
    "blocked",
    "needs_human",
    "review_pending",
    "done",
}

TASK_STATUSES: set[str] = {
    "todo",
    "in_progress",
    "blocked",
    "retry",
    "done",
}

TASK_STATUS_TRANSITIONS: dict[str, set[str]] = {
    "todo": {"in_progress", "blocked", "retry"},
    "in_progress": {"blocked", "retry", "todo", "done"},
    "blocked": {"retry", "todo", "in_progress"},
    "retry": {"in_progress", "blocked", "todo", "done"},
    "done": set(),
}


def ensure_valid_artifact_transition(current_state: str, next_state: str) -> None:
    if current_state == next_state:
        return
    allowed = ARTIFACT_STATE_TRANSITIONS.get(current_state)
    if allowed is None:
        raise ValueError(f"unknown artifact state: {current_state}")
    if next_state not in allowed:
        raise ValueError(f"invalid artifact transition: {current_state} -> {next_state}")


def ensure_valid_agent_state(state: str) -> None:
    if state not in AGENT_STATES:
        raise ValueError(f"invalid agent state: {state}")


def ensure_valid_task_status(status: str) -> None:
    if status not in TASK_STATUSES:
        raise ValueError(f"invalid task status: {status}")


def ensure_valid_task_transition(current_status: str, next_status: str) -> None:
    ensure_valid_task_status(current_status)
    ensure_valid_task_status(next_status)
    if current_status == next_status:
        return
    allowed = TASK_STATUS_TRANSITIONS[current_status]
    if next_status not in allowed:
        raise ValueError(f"invalid task transition: {current_status} -> {next_status}")
