from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from research_runtime.orchestrator.worktree_manager import cleanup_worktree
from research_runtime.storage.db import (
    create_task_completion_hook,
    emit_event,
    freeze_package,
    get_project_record,
    get_task_execution_context,
    get_task_record,
    list_artifacts,
    update_task_completion_hook,
    upsert_task_execution_context,
)


def _artifact_records_for_task(db_path: str, project_id: str, task_id: str) -> list[dict[str, Any]]:
    candidates = list_artifacts(db_path, project_id)["artifacts"]
    records: list[dict[str, Any]] = []
    for artifact in candidates:
        raw_metadata = artifact.get("metadata_json")
        metadata: dict[str, Any] = {}
        if isinstance(raw_metadata, str) and raw_metadata:
            try:
                parsed = json.loads(raw_metadata)
            except json.JSONDecodeError:
                parsed = {}
            if isinstance(parsed, dict):
                metadata = parsed
        if str(metadata.get("task_id") or "") == task_id:
            records.append({**artifact, "metadata": metadata})
    return records


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def create_checkpoint(
    db_path: str,
    workspace_root: str,
    *,
    task_id: str,
) -> dict[str, Any]:
    task = get_task_record(db_path, task_id)
    project = get_project_record(db_path, str(task["project_id"]))
    context = get_task_execution_context(db_path, task_id)
    artifacts = _artifact_records_for_task(db_path, str(task["project_id"]), task_id)
    hook = create_task_completion_hook(
        db_path,
        task_id=task_id,
        project_id=str(task["project_id"]),
        hook_type="checkpoint_now",
        status="running",
        payload={"artifact_ids": [item["artifact_id"] for item in artifacts]},
    )
    canonical_workspace = Path(str(project["workspace_path"])).resolve()
    checkpoint_path = (
        canonical_workspace
        / "runs"
        / "checkpoints"
        / f"{task_id}__{str(hook['hook_id'])}.json"
    )
    package = freeze_package(
        db_path,
        workspace_root,
        project_id=str(task["project_id"]),
        package_type="execution_checkpoint",
        created_from=[str(item["artifact_id"]) for item in artifacts],
        state="frozen",
    )
    manifest = {
        "hook_id": hook["hook_id"],
        "task_id": task_id,
        "project_id": str(task["project_id"]),
        "owner_agent": str(task["owner_agent"]),
        "worktree_id": context.get("worktree_id") if context else None,
        "execution_workspace_path": context.get("execution_workspace_path") if context else None,
        "artifact_ids": [str(item["artifact_id"]) for item in artifacts],
        "package_id": str(package["package_id"]),
    }
    _write_json(checkpoint_path, manifest)
    completed_hook = update_task_completion_hook(
        db_path,
        str(hook["hook_id"]),
        status="completed",
        payload={
            **manifest,
            "checkpoint_manifest_path": str(checkpoint_path.resolve()),
        },
        completed=True,
    )
    event = emit_event(
        db_path,
        project_id=str(task["project_id"]),
        event_type="execution_checkpoint_created",
        source="control-plane",
        payload={
            "task_id": task_id,
            "hook_id": completed_hook["hook_id"],
            "package_id": package["package_id"],
        },
    )
    return {
        "hook": completed_hook,
        "package": package,
        "event": event,
        "checkpoint_manifest_path": str(checkpoint_path.resolve()),
    }


def merge_execution_result(
    db_path: str,
    workspace_root: str,
    *,
    task_id: str,
) -> dict[str, Any]:
    task = get_task_record(db_path, task_id)
    project = get_project_record(db_path, str(task["project_id"]))
    context = get_task_execution_context(db_path, task_id)
    if context is None:
        raise ValueError(f"execution context not found for task {task_id}")
    artifacts = _artifact_records_for_task(db_path, str(task["project_id"]), task_id)
    hook = create_task_completion_hook(
        db_path,
        task_id=task_id,
        project_id=str(task["project_id"]),
        hook_type="merge_now",
        status="running",
        payload={"artifact_ids": [item["artifact_id"] for item in artifacts]},
    )
    canonical_workspace = Path(str(project["workspace_path"])).resolve()
    merge_root = canonical_workspace / "runs" / "merges" / task_id
    merge_root.mkdir(parents=True, exist_ok=True)
    copied_files: list[str] = []
    artifact_root = Path(str(context["execution_workspace_path"])).resolve() / "artifacts"
    if artifact_root.exists():
        for source in artifact_root.rglob("*"):
            if not source.is_file():
                continue
            relative = source.relative_to(artifact_root)
            target = merge_root / "artifacts" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            copied_files.append(str(target.resolve()))
    package = freeze_package(
        db_path,
        workspace_root,
        project_id=str(task["project_id"]),
        package_type="merge_bundle",
        created_from=[str(item["artifact_id"]) for item in artifacts],
        state="frozen",
    )
    merge_manifest_path = merge_root / f"{task_id}__{hook['hook_id']}.json"
    manifest = {
        "hook_id": hook["hook_id"],
        "task_id": task_id,
        "project_id": str(task["project_id"]),
        "owner_agent": str(task["owner_agent"]),
        "worktree_id": context.get("worktree_id"),
        "execution_workspace_path": context.get("execution_workspace_path"),
        "artifact_ids": [str(item["artifact_id"]) for item in artifacts],
        "package_id": str(package["package_id"]),
        "copied_files": copied_files,
        "mode": "snapshot_promote",
    }
    _write_json(merge_manifest_path, manifest)
    completed_hook = update_task_completion_hook(
        db_path,
        str(hook["hook_id"]),
        status="completed",
        payload={**manifest, "merge_manifest_path": str(merge_manifest_path.resolve())},
        completed=True,
    )
    event = emit_event(
        db_path,
        project_id=str(task["project_id"]),
        event_type="execution_merge_prepared",
        source="control-plane",
        payload={
            "task_id": task_id,
            "hook_id": completed_hook["hook_id"],
            "package_id": package["package_id"],
        },
    )
    return {
        "hook": completed_hook,
        "package": package,
        "event": event,
        "merge_manifest_path": str(merge_manifest_path.resolve()),
        "copied_files": copied_files,
    }


def cleanup_execution_result(
    db_path: str,
    *,
    task_id: str,
) -> dict[str, Any]:
    task = get_task_record(db_path, task_id)
    context = get_task_execution_context(db_path, task_id)
    if context is None or not context.get("worktree_id"):
        raise ValueError(f"cleanup requires worktree-bound execution context for task {task_id}")
    hook = create_task_completion_hook(
        db_path,
        task_id=task_id,
        project_id=str(task["project_id"]),
        hook_type="cleanup_now",
        status="running",
        payload={"worktree_id": context["worktree_id"]},
    )
    cleaned_worktree = cleanup_worktree(
        db_path,
        worktree_id=str(context["worktree_id"]),
        metadata={"source": "cleanup_execution_result", "task_id": task_id},
    )
    updated_context = upsert_task_execution_context(
        db_path,
        task_id=task_id,
        project_id=str(task["project_id"]),
        owner_agent=str(task["owner_agent"]),
        canonical_workspace_path=str(context["canonical_workspace_path"]),
        execution_workspace_path=str(context["execution_workspace_path"]),
        worktree_id=str(context["worktree_id"]),
        runtime_kind=str(context["runtime_kind"]),
        status="cleaned",
        metadata={"cleanup_hook_id": hook["hook_id"]},
        finished=True,
    )
    completed_hook = update_task_completion_hook(
        db_path,
        str(hook["hook_id"]),
        status="completed",
        payload={
            "worktree_id": context["worktree_id"],
            "execution_workspace_path": context["execution_workspace_path"],
        },
        completed=True,
    )
    event = emit_event(
        db_path,
        project_id=str(task["project_id"]),
        event_type="execution_workspace_cleaned",
        source="control-plane",
        payload={
            "task_id": task_id,
            "hook_id": completed_hook["hook_id"],
            "worktree_id": context["worktree_id"],
        },
    )
    return {
        "hook": completed_hook,
        "worktree": cleaned_worktree,
        "execution_context": updated_context,
        "event": event,
    }
