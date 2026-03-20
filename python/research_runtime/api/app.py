from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from research_runtime.api.read_model_page import render_project_trace_page
from research_runtime.coordinators.runner import run_coordinators
from research_runtime.orchestrator.event_consumer import consume_pending_events
from research_runtime.orchestrator.task_driver import complete_task_and_emit
from research_runtime.settings import load_settings
from research_runtime.storage.db import (
    build_scheduler_control_state,
    list_agent_routing,
    set_agent_activation,
    upsert_agent_routing,
    build_project_read_model,
    create_message,
    create_project,
    create_task,
    emit_event,
    freeze_package,
    get_project_status,
    init_db,
    claim_next_task,
    list_agent_states,
    list_artifacts,
    list_events,
    list_messages,
    list_packages,
    list_tasks,
    register_artifact,
    set_agent_state,
    transition_artifact_state,
    update_task_status,
)

settings = load_settings()
app = FastAPI(title="SciAILab Research Runtime", version="0.1.0")


class ProjectCreateRequest(BaseModel):
    name: str
    goal: str = ""
    owner_agent: str = "control-plane"
    project_id: str | None = None
    bootstrap_flow: bool = True


class ArtifactCreateRequest(BaseModel):
    project_id: str
    artifact_type: str
    owner: str
    path: str
    state: str = "draft"
    version: int | None = None
    upstream_dependencies: list[str] | None = None
    metadata: dict[str, Any] | None = None


class MessageCreateRequest(BaseModel):
    project_id: str
    from_agent: str
    to_agent: str
    message_type: str
    content: str
    priority: str = "normal"
    artifact_ref: str | None = None


class EventCreateRequest(BaseModel):
    project_id: str
    event_type: str
    source: str
    payload: dict[str, Any] | None = None


class PackageFreezeRequest(BaseModel):
    project_id: str
    package_type: str
    created_from: list[str] | None = None
    state: str = "frozen"


class TaskCreateRequest(BaseModel):
    project_id: str
    title: str
    scope: str
    owner_agent: str
    dependency: str | None = None
    acceptance: str | None = None
    status: str = "todo"


class TaskStatusUpdateRequest(BaseModel):
    task_id: str
    status: str
    source: str | None = None
    event_type: str | None = None
    event_payload: dict[str, Any] | None = None
    consume_after_emit: bool = True


class ArtifactTransitionRequest(BaseModel):
    artifact_id: str
    next_state: str


class AgentStateRequest(BaseModel):
    project_id: str
    agent_id: str
    state: str
    current_task_id: str | None = None
    last_error: str | None = None


class EventConsumeRequest(BaseModel):
    project_id: str
    limit: int = Field(default=20, ge=1, le=100)


class CoordinatorRunRequest(BaseModel):
    project_id: str | None = None
    owner_agent: str | None = None
    limit: int = Field(default=1, ge=1, le=100)
    consume_limit: int = Field(default=20, ge=1, le=100)


class TaskClaimRequest(BaseModel):
    project_id: str | None = None
    owner_agent: str | None = None


class AgentRouteConfigItem(BaseModel):
    role: str
    active: bool | None = None
    provider: str | None = None
    model: str | None = None
    auth_profile: str | None = None
    max_concurrency: int | None = Field(default=None, ge=1, le=32)


class AgentRoutingUpdateRequest(BaseModel):
    routes: list[AgentRouteConfigItem]


class AgentActivationRequest(BaseModel):
    role: str
    active: bool
    max_concurrency: int | None = Field(default=None, ge=1, le=32)


def maybe_consume_project_events(project_id: str, *, enabled: bool, limit: int | None = None) -> dict[str, Any] | None:
    if not enabled:
        return None
    return consume_pending_events(
        str(settings.db_path),
        project_id,
        limit=limit or settings.default_consume_limit,
    )


@app.on_event("startup")
def startup() -> None:
    init_db(str(settings.db_path))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "db_path": str(settings.db_path),
        "workspace_root": str(settings.workspace_root),
        "auto_consume_events": settings.auto_consume_events,
    }


@app.post("/v1/projects")
def create_project_endpoint(request: ProjectCreateRequest) -> dict[str, Any]:
    return create_project(
        str(settings.db_path),
        str(settings.workspace_root),
        name=request.name,
        goal=request.goal,
        owner_agent=request.owner_agent,
        project_id=request.project_id,
        bootstrap_flow=request.bootstrap_flow,
    )


@app.get("/v1/projects/{project_id}")
def project_status_endpoint(project_id: str) -> dict[str, Any]:
    return get_project_status(str(settings.db_path), project_id)


@app.get("/v1/projects/{project_id}/read-model")
def project_read_model_endpoint(project_id: str, limit: int = 60) -> dict[str, Any]:
    return build_project_read_model(
        str(settings.db_path),
        project_id,
        limit=max(10, min(limit, 200)),
    )


@app.get("/trace/{project_id}", response_class=HTMLResponse)
def project_trace_page_endpoint(project_id: str, limit: int = 60) -> HTMLResponse:
    return HTMLResponse(
        render_project_trace_page(
            project_id,
            limit=max(10, min(limit, 200)),
        )
    )


@app.get("/v1/control/agent-routing")
def list_agent_routing_endpoint() -> dict[str, Any]:
    return list_agent_routing(str(settings.db_path))


@app.post("/v1/control/agent-routing")
def update_agent_routing_endpoint(request: AgentRoutingUpdateRequest) -> dict[str, Any]:
    return upsert_agent_routing(
        str(settings.db_path),
        [item.model_dump(exclude_unset=True) for item in request.routes],
    )


@app.post("/v1/control/agent-activation")
def set_agent_activation_endpoint(request: AgentActivationRequest) -> dict[str, Any]:
    return set_agent_activation(
        str(settings.db_path),
        role=request.role,
        active=request.active,
        max_concurrency=request.max_concurrency,
    )


@app.get("/v1/control/scheduler-state")
def scheduler_control_state_endpoint() -> dict[str, Any]:
    return build_scheduler_control_state(str(settings.db_path))


@app.post("/v1/artifacts")
def create_artifact_endpoint(request: ArtifactCreateRequest) -> dict[str, Any]:
    return register_artifact(
        str(settings.db_path),
        project_id=request.project_id,
        artifact_type=request.artifact_type,
        owner=request.owner,
        path=request.path,
        state=request.state,
        version=request.version,
        upstream_dependencies=request.upstream_dependencies,
        metadata=request.metadata,
    )


@app.get("/v1/projects/{project_id}/artifacts")
def list_artifacts_endpoint(project_id: str) -> dict[str, Any]:
    return list_artifacts(str(settings.db_path), project_id)


@app.post("/v1/messages")
def create_message_endpoint(request: MessageCreateRequest) -> dict[str, Any]:
    return create_message(
        str(settings.db_path),
        project_id=request.project_id,
        from_agent=request.from_agent,
        to_agent=request.to_agent,
        message_type=request.message_type,
        content=request.content,
        priority=request.priority,
        artifact_ref=request.artifact_ref,
    )


@app.get("/v1/projects/{project_id}/messages")
def list_messages_endpoint(
    project_id: str,
    to_agent: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    return list_messages(str(settings.db_path), project_id, to_agent=to_agent, status=status)


@app.post("/v1/events")
def create_event_endpoint(request: EventCreateRequest) -> dict[str, Any]:
    event = emit_event(
        str(settings.db_path),
        project_id=request.project_id,
        event_type=request.event_type,
        source=request.source,
        payload=request.payload,
    )
    downstream = maybe_consume_project_events(
        request.project_id,
        enabled=settings.auto_consume_events,
    )
    if downstream is not None:
        event["downstream"] = downstream
    return event


@app.get("/v1/projects/{project_id}/events")
def list_events_endpoint(
    project_id: str,
    status: str | None = None,
    event_type: str | None = None,
) -> dict[str, Any]:
    return list_events(str(settings.db_path), project_id, status=status, event_type=event_type)


@app.post("/v1/events/consume")
def consume_events_endpoint(request: EventConsumeRequest) -> dict[str, Any]:
    return consume_pending_events(str(settings.db_path), request.project_id, limit=request.limit)


@app.post("/v1/packages/freeze")
def freeze_package_endpoint(request: PackageFreezeRequest) -> dict[str, Any]:
    return freeze_package(
        str(settings.db_path),
        str(settings.workspace_root),
        project_id=request.project_id,
        package_type=request.package_type,
        created_from=request.created_from,
        state=request.state,
    )


@app.get("/v1/projects/{project_id}/packages")
def list_packages_endpoint(project_id: str, package_type: str | None = None) -> dict[str, Any]:
    return list_packages(str(settings.db_path), project_id, package_type=package_type)


@app.post("/v1/tasks")
def create_task_endpoint(request: TaskCreateRequest) -> dict[str, Any]:
    return create_task(
        str(settings.db_path),
        project_id=request.project_id,
        title=request.title,
        scope=request.scope,
        owner_agent=request.owner_agent,
        dependency=request.dependency,
        acceptance=request.acceptance,
        status=request.status,
    )


@app.get("/v1/projects/{project_id}/tasks")
def list_tasks_endpoint(
    project_id: str,
    owner_agent: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    return list_tasks(str(settings.db_path), project_id, owner_agent=owner_agent, status=status)


@app.post("/v1/tasks/claim")
def claim_task_endpoint(request: TaskClaimRequest) -> dict[str, Any]:
    task = claim_next_task(
        str(settings.db_path),
        project_id=request.project_id,
        owner_agent=request.owner_agent,
    )
    return {
        "task": task,
        "claimed": task is not None,
    }


@app.post("/v1/tasks/status")
def update_task_status_endpoint(request: TaskStatusUpdateRequest) -> dict[str, Any]:
    if not request.event_type:
        return update_task_status(str(settings.db_path), task_id=request.task_id, status=request.status)
    return complete_task_and_emit(
        str(settings.db_path),
        task_id=request.task_id,
        status=request.status,
        source=request.source,
        event_type=request.event_type,
        event_payload=request.event_payload,
        consume_after_emit=settings.auto_consume_events and request.consume_after_emit,
        consume_limit=settings.default_consume_limit,
    )


@app.post("/v1/state/artifact")
def transition_artifact_endpoint(request: ArtifactTransitionRequest) -> dict[str, Any]:
    return transition_artifact_state(
        str(settings.db_path),
        artifact_id=request.artifact_id,
        next_state=request.next_state,
    )


@app.post("/v1/state/agent")
def set_agent_state_endpoint(request: AgentStateRequest) -> dict[str, Any]:
    return set_agent_state(
        str(settings.db_path),
        project_id=request.project_id,
        agent_id=request.agent_id,
        state=request.state,
        current_task_id=request.current_task_id,
        last_error=request.last_error,
    )


@app.get("/v1/projects/{project_id}/state/agents")
def list_agent_states_endpoint(
    project_id: str,
    agent_id: str | None = None,
    state: str | None = None,
) -> dict[str, Any]:
    return list_agent_states(
        str(settings.db_path),
        project_id,
        agent_id=agent_id,
        state=state,
    )


@app.post("/v1/coordinators/run")
def run_coordinators_endpoint(request: CoordinatorRunRequest) -> dict[str, Any]:
    return run_coordinators(
        str(settings.db_path),
        str(settings.workspace_root),
        project_id=request.project_id,
        owner_agent=request.owner_agent,
        limit=request.limit,
        consume_limit=request.consume_limit,
    )
