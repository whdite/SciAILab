from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from research_runtime.api.read_model_page import render_project_trace_page
from research_runtime.coordinators.runner import run_coordinators
from research_runtime.orchestrator.archive_manager import (
    cleanup_execution_result,
    create_checkpoint,
    merge_execution_result,
)
from research_runtime.orchestrator.event_consumer import consume_pending_events
from research_runtime.orchestrator.task_driver import complete_task_and_emit
from research_runtime.orchestrator.worktree_manager import (
    cleanup_worktree,
    prepare_execution_workspace,
    release_worktree,
)
from research_runtime.openclaw_sync import get_openclaw_model_catalog
from research_runtime.settings import load_settings
from research_runtime.storage.db import (
    build_attach_payload,
    create_agent_thread_message,
    get_agent_workspace_thread,
    build_scheduler_control_state,
    delete_auth_profile,
    get_project_record,
    list_auth_profiles,
    list_agent_workspace_overview,
    list_agent_routing,
    list_provider_observability,
    get_runtime_settings,
    record_provider_observation_event,
    list_projects,
    set_agent_activation,
    test_auth_profile,
    upsert_agent_routing,
    upsert_auth_profiles,
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
    list_project_worktrees,
    list_task_completion_hooks,
    list_task_execution_contexts,
    list_tasks,
    register_artifact,
    set_agent_state,
    record_agent_operator_action,
    transition_artifact_state,
    update_message_state,
    update_task_status,
    upsert_api_key_auth_profile,
    upsert_runtime_settings,
)

settings = load_settings()
app = FastAPI(title="SciAILab Research Runtime", version="0.1.0")


class SpaStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.status_code != 404:
            return response
        normalized = path.strip("/")
        if not normalized or "." in normalized or normalized.startswith("assets/"):
            return response
        return await super().get_response("index.html", scope)


def resolve_web_dist() -> Path:
    return Path(__file__).resolve().parents[3] / "web" / "dist"


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


class MessageHandoffStateRequest(BaseModel):
    handoff_state: str
    status: str | None = None


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


class WorktreePrepareRequest(BaseModel):
    project_id: str
    task_id: str | None = None
    owner_agent: str | None = None
    branch_name: str | None = None
    runtime_kind: str = "coordinator"
    metadata: dict[str, Any] | None = None


class WorktreeReleaseRequest(BaseModel):
    metadata: dict[str, Any] | None = None


class TaskControlActionRequest(BaseModel):
    task_id: str


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


class AuthProfileConfigItem(BaseModel):
    profile_id: str
    provider: str
    label: str
    auth_type: str = "oauth"
    status: str | None = None
    account_label: str | None = None
    credential_ref: str | None = None
    login_hint: str | None = None
    scopes: list[str] | None = None
    last_error: str | None = None
    metadata: dict[str, Any] | None = None


class AuthProfilesUpdateRequest(BaseModel):
    profiles: list[AuthProfileConfigItem]


class AuthProfileTestRequest(BaseModel):
    profile_id: str


class ApiKeyAuthProfileUpsertRequest(BaseModel):
    provider: str
    api_key: str
    profile_id: str | None = None
    label: str | None = None
    account_label: str | None = None
    login_hint: str | None = None
    set_last_good: bool = True


class ProviderObservationEventRequest(BaseModel):
    role: str
    event_type: str
    provider: str | None = None
    model: str | None = None
    auth_profile: str | None = None
    error: str | None = None
    failover: bool = False


class RuntimeSettingsUpdateRequest(BaseModel):
    handoff_pending_timeout_seconds: int | None = Field(default=None, ge=60, le=604800)
    handoff_blocked_timeout_seconds: int | None = Field(default=None, ge=60, le=604800)


class AgentThreadAttachmentItem(BaseModel):
    attachment_type: str
    name: str | None = None
    path: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    metadata: dict[str, Any] | None = None


class AgentThreadMentionItem(BaseModel):
    kind: str
    value: str
    label: str | None = None
    metadata: dict[str, Any] | None = None


class AgentThreadMessageCreateRequest(BaseModel):
    project_id: str
    content: str = ""
    input_mode: str = "mixed"
    intent: str = "chat"
    task_id: str | None = None
    execution_context_task_id: str | None = None
    attachments: list[AgentThreadAttachmentItem] | None = None
    mentions: list[AgentThreadMentionItem] | None = None
    metadata: dict[str, Any] | None = None


class AgentWorkspaceActionRequest(BaseModel):
    project_id: str
    task_id: str | None = None
    action_type: str
    payload: dict[str, Any] | None = None


def maybe_consume_project_events(project_id: str, *, enabled: bool, limit: int | None = None) -> dict[str, Any] | None:
    if not enabled:
        return None
    return consume_pending_events(
        str(settings.db_path),
        project_id,
        limit=limit or settings.default_consume_limit,
    )


def _safe_upload_name(name: str | None) -> str:
    raw = Path(name or "upload.bin").name
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("._")
    return sanitized or "upload.bin"


def _build_unique_upload_path(upload_root: Path, safe_name: str) -> Path:
    stem = Path(safe_name).stem or "upload"
    suffix = Path(safe_name).suffix
    candidate = upload_root / f"{stem}{suffix}"
    counter = 0
    while candidate.exists():
        counter += 1
        candidate = upload_root / f"{stem}-{counter}{suffix}"
    return candidate


def _describe_agent_workspace_action(action_type: str, task_id: str | None, result: dict[str, Any]) -> str:
    if action_type == "attach":
        owner = str((result.get("task") or {}).get("owner_agent") or (result.get("execution_context") or {}).get("owner_agent") or "runtime")
        return f"已附着 {owner} / {task_id or 'n/a'}。"
    if action_type == "checkpoint":
        return f"已为 {task_id or 'n/a'} 生成检查点。"
    if action_type == "merge":
        copied = len(result.get("copied_files") or [])
        return f"已归档 {task_id or 'n/a'} 的执行结果，复制文件 {copied} 个。"
    if action_type == "cleanup":
        return f"已清理 {task_id or 'n/a'} 的执行工作区。"
    if action_type == "retry":
        return f"已将 {task_id or 'n/a'} 标记为 retry。"
    if action_type == "mark_blocked":
        return f"已将 {task_id or 'n/a'} 标记为 blocked。"
    if action_type == "handoff":
        handoff_message = result.get("handoff_message") or {}
        return f"已创建交接消息 {handoff_message.get('message_id', '')}。"
    return f"已执行动作 {action_type}。"


def _build_agent_workspace_auto_reply(
    *,
    project_id: str,
    agent_id: str,
    operator_content: str,
) -> tuple[str, str | None]:
    thread = get_agent_workspace_thread(
        str(settings.db_path),
        project_id=project_id,
        agent_id=agent_id,
        limit=20,
    )
    context = thread.get("context") or {}
    project = context.get("project") or {}
    route = context.get("route") or {}
    agent_state = context.get("agent_state") or {}
    current_task = context.get("current_task") or {}
    execution_context = context.get("execution_context") or {}
    recent_artifacts = list(context.get("recent_artifacts") or [])
    recent_packages = list(context.get("recent_packages") or [])
    recent_handoffs = list(context.get("recent_handoffs") or [])

    project_name = str(project.get("name") or project_id)
    state_text = str(agent_state.get("state") or "idle")
    task_title = str(current_task.get("title") or "")
    task_id = str(current_task.get("task_id") or "") or None
    provider = str(route.get("provider") or "")
    model = str(route.get("model") or "")
    route_text = " / ".join(part for part in [provider, model] if part) or "未配置路由"
    execution_path = str(execution_context.get("execution_workspace_path") or "")

    latest_artifact = recent_artifacts[0] if recent_artifacts else None
    latest_package = recent_packages[0] if recent_packages else None
    latest_handoff = recent_handoffs[0] if recent_handoffs else None

    latest_artifact_text = ""
    if latest_artifact:
        latest_artifact_text = (
            f"最近产出是 {latest_artifact.get('artifact_type')} v{latest_artifact.get('version')}，"
            f"状态 {latest_artifact.get('state')}。"
        )

    latest_package_text = ""
    if latest_package:
        latest_package_text = (
            f"最近冻结包是 {latest_package.get('package_type')} v{latest_package.get('version')}。"
        )

    latest_handoff_text = ""
    if latest_handoff:
        latest_handoff_text = (
            f"最近一条交接来自 {latest_handoff.get('from_agent')} -> {latest_handoff.get('to_agent')}，"
            f"类型 {latest_handoff.get('message_type')}。"
        )

    content = operator_content.strip()
    lowered = content.lower()
    asks_status = any(token in content for token in ["状态", "进度", "当前", "汇总", "回显"]) or any(
        token in lowered for token in ["status", "state", "progress", "summary"]
    )

    if asks_status:
        reply = (
            f"已收到你的询问。当前 Agent 是 `{agent_id}`，项目为 `{project_name}`，运行状态 `{state_text}`，"
            f"路由 `{route_text}`。"
        )
        if task_title:
            reply += f" 当前绑定任务是“{task_title}”。"
        else:
            reply += " 当前没有绑定任务，可以直接下发说明，或先把具体 task attach 到这个 Agent。"
        if execution_path:
            reply += f" 当前执行工作区在 `{execution_path}`。"
        if latest_artifact_text:
            reply += f" {latest_artifact_text}"
        elif latest_package_text:
            reply += f" {latest_package_text}"
        if latest_handoff_text:
            reply += f" {latest_handoff_text}"
        return reply, task_id

    reply = f"已收到你发给 `{agent_id}` 的消息：{content or '空消息'}。"
    if task_title:
        reply += f" 我当前关联的任务是“{task_title}”，会按这个上下文继续处理。"
    else:
        reply += " 当前没有绑定任务，我先按通用会话上下文记录这条说明。"
    if latest_artifact_text:
        reply += f" {latest_artifact_text}"
    elif latest_package_text:
        reply += f" {latest_package_text}"
    return reply, task_id


@app.on_event("startup")
def startup() -> None:
    init_db(str(settings.db_path))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "db_path": str(settings.db_path),
        "workspace_root": str(settings.workspace_root),
        "worktree_root": str(settings.worktree_root),
        "auto_consume_events": settings.auto_consume_events,
    }


@app.get("/v1/runtime-settings")
def get_runtime_settings_endpoint() -> dict[str, Any]:
    return get_runtime_settings(str(settings.db_path))


@app.post("/v1/runtime-settings")
def update_runtime_settings_endpoint(request: RuntimeSettingsUpdateRequest) -> dict[str, Any]:
    payload = request.model_dump(exclude_none=True)
    return upsert_runtime_settings(str(settings.db_path), payload)


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


@app.get("/v1/projects")
def list_projects_endpoint(limit: int = 50) -> dict[str, Any]:
    return list_projects(str(settings.db_path), limit=max(1, min(limit, 200)))


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


@app.get("/v1/agents/overview")
def agent_workspace_overview_endpoint(project_id: str, limit: int = 50) -> dict[str, Any]:
    return list_agent_workspace_overview(
        str(settings.db_path),
        project_id=project_id,
        limit=limit,
    )


@app.get("/v1/agents/{agent_id}/thread")
def agent_workspace_thread_endpoint(agent_id: str, project_id: str, limit: int = 80) -> dict[str, Any]:
    return get_agent_workspace_thread(
        str(settings.db_path),
        project_id=project_id,
        agent_id=agent_id,
        limit=limit,
    )


@app.post("/v1/agents/{agent_id}/thread/messages")
def create_agent_workspace_message_endpoint(
    agent_id: str,
    request: AgentThreadMessageCreateRequest,
) -> dict[str, Any]:
    metadata = dict(request.metadata or {})
    if request.mentions:
        metadata["mentions"] = [item.model_dump(exclude_none=True) for item in request.mentions]
    created = create_agent_thread_message(
        str(settings.db_path),
        project_id=request.project_id,
        agent_id=agent_id,
        sender_type="operator",
        message_type="operator_message",
        content=request.content,
        input_mode=request.input_mode,
        intent=request.intent,
        task_id=request.task_id,
        execution_context_task_id=request.execution_context_task_id,
        status="delivered",
        attachments=[item.model_dump(exclude_none=True) for item in (request.attachments or [])],
        metadata=metadata,
    )
    event = emit_event(
        str(settings.db_path),
        project_id=request.project_id,
        event_type="agent_workspace_message_created",
        source="agent-workspace",
        payload={
            "agent_id": agent_id,
            "thread_id": created["thread"]["thread_id"] if created.get("thread") else None,
            "message_id": created["message"]["message_id"],
            "task_id": request.task_id,
            "intent": request.intent,
        },
    )
    reply_content, reply_task_id = _build_agent_workspace_auto_reply(
        project_id=request.project_id,
        agent_id=agent_id,
        operator_content=request.content,
    )
    reply = create_agent_thread_message(
        str(settings.db_path),
        project_id=request.project_id,
        agent_id=agent_id,
        sender_type="agent",
        message_type="agent_response",
        content=reply_content,
        input_mode="chat",
        intent="chat",
        task_id=request.task_id or reply_task_id,
        execution_context_task_id=request.execution_context_task_id or reply_task_id,
        status="completed",
        attachments=[],
        metadata={
            "source": "agent_workspace_auto_reply",
            "reply_to_message_id": created["message"]["message_id"],
        },
    )
    return {
        **created,
        "event": event,
        "reply": reply,
    }


@app.post("/v1/agents/uploads")
async def upload_agent_workspace_attachment_endpoint(
    project_id: str = Form(...),
    agent_id: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    project = get_project_record(str(settings.db_path), project_id)
    upload_root = Path(str(project["workspace_path"])) / "uploads" / "agents" / agent_id
    upload_root.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_upload_name(file.filename)
    candidate = _build_unique_upload_path(upload_root, safe_name)
    content = await file.read()
    candidate.write_bytes(content)
    attachment_type = "image" if str(file.content_type or "").startswith("image/") else "file"
    return {
        "attachment_type": attachment_type,
        "name": safe_name,
        "path": str(candidate),
        "mime_type": file.content_type or "application/octet-stream",
        "size_bytes": len(content),
        "metadata": {
            "project_id": project_id,
            "agent_id": agent_id,
        },
    }


@app.post("/v1/agents/{agent_id}/actions")
def run_agent_workspace_action_endpoint(
    agent_id: str,
    request: AgentWorkspaceActionRequest,
) -> dict[str, Any]:
    action_type = request.action_type.strip().lower()
    payload = request.payload or {}
    result: dict[str, Any]
    if action_type == "attach":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for attach")
        attached = build_attach_payload(str(settings.db_path), request.task_id)
        event = emit_event(
            str(settings.db_path),
            project_id=request.project_id,
            event_type="attach_requested",
            source="control-plane",
            payload={"task_id": request.task_id, "agent_id": agent_id},
        )
        result = {
            **attached,
            "event": event,
        }
    elif action_type == "checkpoint":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for checkpoint")
        result = create_checkpoint(
            str(settings.db_path),
            str(settings.workspace_root),
            task_id=request.task_id,
        )
    elif action_type == "merge":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for merge")
        result = merge_execution_result(
            str(settings.db_path),
            str(settings.workspace_root),
            task_id=request.task_id,
        )
    elif action_type == "cleanup":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for cleanup")
        result = cleanup_execution_result(
            str(settings.db_path),
            task_id=request.task_id,
        )
    elif action_type == "retry":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for retry")
        result = {
            "task": update_task_status(
                str(settings.db_path),
                task_id=request.task_id,
                status="retry",
            )
        }
    elif action_type == "mark_blocked":
        if not request.task_id:
            raise HTTPException(status_code=400, detail="task_id is required for mark_blocked")
        result = {
            "task": update_task_status(
                str(settings.db_path),
                task_id=request.task_id,
                status="blocked",
            )
        }
    elif action_type == "handoff":
        to_agent = str(payload.get("to_agent") or "").strip()
        if not to_agent:
            raise HTTPException(status_code=400, detail="payload.to_agent is required for handoff")
        handoff_message = create_message(
            str(settings.db_path),
            project_id=request.project_id,
            from_agent=agent_id,
            to_agent=to_agent,
            message_type=str(payload.get("message_type") or "handoff"),
            content=str(payload.get("content") or f"Operator handoff from {agent_id}"),
            priority=str(payload.get("priority") or "normal"),
            artifact_ref=str(payload.get("artifact_ref")) if payload.get("artifact_ref") else None,
        )
        result = {"handoff_message": handoff_message}
    else:
        raise HTTPException(status_code=400, detail=f"unsupported agent workspace action: {action_type}")

    action_record = record_agent_operator_action(
        str(settings.db_path),
        project_id=request.project_id,
        agent_id=agent_id,
        action_type=action_type,
        task_id=request.task_id,
        payload=payload,
        result=result,
        status="completed",
    )
    thread_message = create_agent_thread_message(
        str(settings.db_path),
        project_id=request.project_id,
        agent_id=agent_id,
        sender_type="system",
        message_type="control_result",
        content=_describe_agent_workspace_action(action_type, request.task_id, result),
        input_mode="command",
        intent="request_action",
        task_id=request.task_id,
        execution_context_task_id=request.task_id,
        status="completed",
        attachments=[],
        metadata={
            "action_type": action_type,
            "action_id": action_record["action_id"],
            "result": result,
        },
    )
    return {
        "action": action_record,
        "thread_message": thread_message["message"],
        "result": result,
    }


@app.get("/trace/{project_id}", response_class=HTMLResponse)
def project_trace_page_endpoint(project_id: str, limit: int = 60) -> HTMLResponse:
    return HTMLResponse(
        render_project_trace_page(
            project_id,
            limit=max(10, min(limit, 200)),
        )
    )


@app.get("/v1/worktrees")
def list_worktrees_endpoint(
    project_id: str | None = None,
    task_id: str | None = None,
    status: str | None = None,
    owner_agent: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return list_project_worktrees(
        str(settings.db_path),
        project_id=project_id,
        task_id=task_id,
        status=status,
        owner_agent=owner_agent,
        limit=limit,
    )


@app.post("/v1/worktrees/prepare")
def prepare_worktree_endpoint(request: WorktreePrepareRequest) -> dict[str, Any]:
    return prepare_execution_workspace(
        str(settings.db_path),
        str(settings.worktree_root),
        project_id=request.project_id,
        task_id=request.task_id,
        owner_agent=request.owner_agent,
        branch_name=request.branch_name,
        runtime_kind=request.runtime_kind,
        metadata=request.metadata,
    )


@app.post("/v1/worktrees/{worktree_id}/release")
def release_worktree_endpoint(
    worktree_id: str,
    request: WorktreeReleaseRequest | None = None,
) -> dict[str, Any]:
    return release_worktree(
        str(settings.db_path),
        worktree_id=worktree_id,
        metadata=request.metadata if request else None,
    )


@app.post("/v1/worktrees/{worktree_id}/cleanup")
def cleanup_worktree_endpoint(
    worktree_id: str,
    request: WorktreeReleaseRequest | None = None,
) -> dict[str, Any]:
    return cleanup_worktree(
        str(settings.db_path),
        worktree_id=worktree_id,
        metadata=request.metadata if request else None,
    )


@app.get("/v1/execution-contexts")
def list_execution_contexts_endpoint(
    project_id: str | None = None,
    status: str | None = None,
    owner_agent: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return list_task_execution_contexts(
        str(settings.db_path),
        project_id=project_id,
        status=status,
        owner_agent=owner_agent,
        limit=limit,
    )


@app.get("/v1/completion-hooks")
def list_completion_hooks_endpoint(
    project_id: str | None = None,
    task_id: str | None = None,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    return list_task_completion_hooks(
        str(settings.db_path),
        project_id=project_id,
        task_id=task_id,
        status=status,
        limit=limit,
    )


@app.post("/v1/control/actions/checkpoint")
def checkpoint_control_action_endpoint(request: TaskControlActionRequest) -> dict[str, Any]:
    return create_checkpoint(
        str(settings.db_path),
        str(settings.workspace_root),
        task_id=request.task_id,
    )


@app.post("/v1/control/actions/merge")
def merge_control_action_endpoint(request: TaskControlActionRequest) -> dict[str, Any]:
    return merge_execution_result(
        str(settings.db_path),
        str(settings.workspace_root),
        task_id=request.task_id,
    )


@app.post("/v1/control/actions/cleanup")
def cleanup_control_action_endpoint(request: TaskControlActionRequest) -> dict[str, Any]:
    return cleanup_execution_result(
        str(settings.db_path),
        task_id=request.task_id,
    )


@app.post("/v1/control/actions/attach")
def attach_control_action_endpoint(request: TaskControlActionRequest) -> dict[str, Any]:
    payload = build_attach_payload(str(settings.db_path), request.task_id)
    event = emit_event(
        str(settings.db_path),
        project_id=str(payload["task"]["project_id"]),
        event_type="attach_requested",
        source="control-plane",
        payload={"task_id": request.task_id},
    )
    return {
        **payload,
        "event": event,
    }


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


@app.get("/v1/control/auth-profiles")
def list_auth_profiles_endpoint() -> dict[str, Any]:
    return list_auth_profiles(str(settings.db_path))


@app.get("/v1/control/model-catalog")
def control_model_catalog_endpoint(force_refresh: bool = False) -> dict[str, Any]:
    return get_openclaw_model_catalog(force_refresh=force_refresh)


@app.post("/v1/control/auth-profiles")
def update_auth_profiles_endpoint(request: AuthProfilesUpdateRequest) -> dict[str, Any]:
    return upsert_auth_profiles(
        str(settings.db_path),
        [item.model_dump(exclude_unset=True) for item in request.profiles],
    )


@app.post("/v1/control/auth-profiles/api-key")
def upsert_api_key_auth_profile_endpoint(request: ApiKeyAuthProfileUpsertRequest) -> dict[str, Any]:
    return upsert_api_key_auth_profile(
        str(settings.db_path),
        provider=request.provider,
        api_key=request.api_key,
        profile_id=request.profile_id,
        label=request.label,
        account_label=request.account_label,
        login_hint=request.login_hint,
        set_last_good=request.set_last_good,
    )


@app.delete("/v1/control/auth-profiles/{profile_id}")
def delete_auth_profile_endpoint(profile_id: str) -> dict[str, Any]:
    return delete_auth_profile(str(settings.db_path), profile_id)


@app.post("/v1/control/auth-profiles/test")
def test_auth_profile_endpoint(request: AuthProfileTestRequest) -> dict[str, Any]:
    return test_auth_profile(str(settings.db_path), request.profile_id)


@app.get("/v1/control/scheduler-state")
def scheduler_control_state_endpoint() -> dict[str, Any]:
    return build_scheduler_control_state(str(settings.db_path))


@app.get("/v1/control/provider-observability")
def provider_observability_endpoint() -> dict[str, Any]:
    return list_provider_observability(str(settings.db_path))


@app.post("/v1/control/provider-observability/event")
def provider_observability_event_endpoint(request: ProviderObservationEventRequest) -> dict[str, Any]:
    return record_provider_observation_event(
        str(settings.db_path),
        role=request.role,
        event_type=request.event_type,
        provider=request.provider,
        model=request.model,
        auth_profile=request.auth_profile,
        error=request.error,
        failover=request.failover,
    )


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
    from_agent: str | None = None,
    to_agent: str | None = None,
    status: str | None = None,
    handoff_state: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    return list_messages(
        str(settings.db_path),
        project_id,
        from_agent=from_agent,
        to_agent=to_agent,
        status=status,
        handoff_state=handoff_state,
        limit=limit,
    )


@app.post("/v1/messages/{message_id}/mark-read")
def mark_message_read_endpoint(message_id: str) -> dict[str, Any]:
    return update_message_state(
        str(settings.db_path),
        message_id=message_id,
        status="read",
        handoff_state="seen",
    )


@app.post("/v1/messages/{message_id}/ack")
def ack_message_endpoint(message_id: str) -> dict[str, Any]:
    return update_message_state(
        str(settings.db_path),
        message_id=message_id,
        status="acked",
        handoff_state="accepted",
    )


@app.post("/v1/messages/{message_id}/handoff-state")
def set_message_handoff_state_endpoint(
    message_id: str,
    request: MessageHandoffStateRequest,
) -> dict[str, Any]:
    return update_message_state(
        str(settings.db_path),
        message_id=message_id,
        status=request.status,
        handoff_state=request.handoff_state,
    )


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
        completion = complete_task_and_emit(
            str(settings.db_path),
            task_id=request.task_id,
            status=request.status,
            consume_after_emit=False,
            consume_limit=settings.default_consume_limit,
        )
        return {
            **completion["task"],
            "auto_actions": completion["auto_actions"],
        }
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
        str(settings.worktree_root),
        project_id=request.project_id,
        owner_agent=request.owner_agent,
        limit=request.limit,
        consume_limit=request.consume_limit,
    )


web_dist = resolve_web_dist()
if web_dist.exists():
    app.mount("/", SpaStaticFiles(directory=str(web_dist), html=True), name="sciailab-web")
