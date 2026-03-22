from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from research_runtime.storage.db import (
    create_project_worktree,
    get_project_record,
    get_project_worktree,
    get_task_execution_context,
    get_task_record,
    update_project_worktree,
    upsert_task_execution_context,
)


def _slug(value: str) -> str:
    normalized = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    collapsed = "-".join(part for part in normalized.split("-") if part)
    return collapsed or "runtime"


def _run_git(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        check=False,
    )


def _detect_git_root(path: Path) -> Path | None:
    result = _run_git("-C", str(path), "rev-parse", "--show-toplevel")
    if result.returncode != 0:
        return None
    resolved = Path(result.stdout.strip())
    return resolved.resolve() if result.stdout.strip() else None


def _ensure_manifest(path: Path, payload: dict[str, Any]) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / ".sciailab-worktree.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _default_branch_name(project_id: str, owner_agent: str, task_id: str | None) -> str:
    project_part = _slug(project_id)[:32]
    owner_part = _slug(owner_agent)[:24]
    task_part = _slug(task_id or "manual")[:24]
    return f"sciailab/{project_part}/{owner_part}/{task_part}"


def _target_path(worktree_root: str, project_id: str, owner_agent: str, task_id: str | None) -> Path:
    task_part = _slug(task_id or "manual")
    return Path(worktree_root) / _slug(project_id) / _slug(owner_agent) / task_part


def prepare_execution_workspace(
    db_path: str,
    worktree_root: str,
    *,
    project_id: str,
    owner_agent: str | None = None,
    task_id: str | None = None,
    branch_name: str | None = None,
    runtime_kind: str = "coordinator",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    project = get_project_record(db_path, project_id)
    canonical_workspace = Path(str(project["workspace_path"])).resolve()
    task = get_task_record(db_path, task_id) if task_id else None
    resolved_owner = owner_agent or (str(task["owner_agent"]) if task else "runtime")

    existing_context = get_task_execution_context(db_path, task_id) if task_id else None
    if existing_context:
        execution_path = Path(str(existing_context["execution_workspace_path"]))
        if execution_path.exists():
            worktree = (
                get_project_worktree(db_path, str(existing_context["worktree_id"]))
                if existing_context.get("worktree_id")
                else None
            )
            return {
                "project_id": project_id,
                "task_id": task_id,
                "reused": True,
                "worktree": worktree,
                "execution_context": existing_context,
            }

    target_path = _target_path(worktree_root, project_id, resolved_owner, task_id).resolve()
    if target_path.exists():
        shutil.rmtree(target_path, ignore_errors=True)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    requested_branch = branch_name or _default_branch_name(project_id, resolved_owner, task_id)
    git_root = _detect_git_root(canonical_workspace)
    isolation_mode = "detached"
    effective_branch: str | None = None
    preparation_note: dict[str, Any] = {"requested_branch": requested_branch}

    if git_root is not None:
        git_result = _run_git(
            "-C",
            str(git_root),
            "worktree",
            "add",
            str(target_path),
            "-b",
            requested_branch,
        )
        if git_result.returncode == 0:
            isolation_mode = "git_worktree"
            effective_branch = requested_branch
            preparation_note["git_root"] = str(git_root)
        else:
            preparation_note["git_error"] = (git_result.stderr or git_result.stdout).strip()
            _ensure_manifest(
                target_path,
                {
                    "kind": "detached_execution_workspace",
                    "project_id": project_id,
                    "task_id": task_id,
                    "owner_agent": resolved_owner,
                    "canonical_workspace_path": str(canonical_workspace),
                    "requested_branch": requested_branch,
                },
            )
    else:
        _ensure_manifest(
            target_path,
            {
                "kind": "detached_execution_workspace",
                "project_id": project_id,
                "task_id": task_id,
                "owner_agent": resolved_owner,
                "canonical_workspace_path": str(canonical_workspace),
                "requested_branch": requested_branch,
            },
        )

    worktree = create_project_worktree(
        db_path,
        project_id=project_id,
        task_id=task_id,
        owner_agent=resolved_owner,
        canonical_workspace_path=str(canonical_workspace),
        worktree_path=str(target_path),
        isolation_mode=isolation_mode,
        branch_name=effective_branch,
        status="prepared",
        metadata={**(metadata or {}), **preparation_note},
    )
    execution_context = None
    if task_id:
        execution_context = upsert_task_execution_context(
            db_path,
            task_id=task_id,
            project_id=project_id,
            owner_agent=resolved_owner,
            canonical_workspace_path=str(canonical_workspace),
            execution_workspace_path=str(target_path),
            worktree_id=str(worktree["worktree_id"]),
            runtime_kind=runtime_kind,
            status="prepared",
            metadata=metadata,
        )
    return {
        "project_id": project_id,
        "task_id": task_id,
        "reused": False,
        "worktree": worktree,
        "execution_context": execution_context,
    }


def activate_execution_workspace(
    db_path: str,
    worktree_root: str,
    *,
    project_id: str,
    task_id: str,
    owner_agent: str | None = None,
    runtime_kind: str = "coordinator",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    prepared = prepare_execution_workspace(
        db_path,
        worktree_root,
        project_id=project_id,
        task_id=task_id,
        owner_agent=owner_agent,
        runtime_kind=runtime_kind,
        metadata=metadata,
    )
    worktree = prepared.get("worktree")
    if not isinstance(worktree, dict):
        raise RuntimeError("missing prepared worktree")
    updated_worktree = update_project_worktree(
        db_path,
        str(worktree["worktree_id"]),
        status="active",
        activated=True,
        metadata=metadata,
    )
    task = get_task_record(db_path, task_id)
    context = upsert_task_execution_context(
        db_path,
        task_id=task_id,
        project_id=str(task["project_id"]),
        owner_agent=owner_agent or str(task["owner_agent"]),
        canonical_workspace_path=str(updated_worktree["canonical_workspace_path"]),
        execution_workspace_path=str(updated_worktree["worktree_path"]),
        worktree_id=str(updated_worktree["worktree_id"]),
        runtime_kind=runtime_kind,
        status="active",
        metadata=metadata,
        started=True,
    )
    return {
        **prepared,
        "worktree": updated_worktree,
        "execution_context": context,
    }


def finalize_execution_workspace(
    db_path: str,
    *,
    task_id: str,
    final_status: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    context = get_task_execution_context(db_path, task_id)
    if context is None:
        return None
    next_worktree_status = "released" if final_status in {"completed", "done"} else final_status
    worktree = None
    if context.get("worktree_id"):
        worktree = update_project_worktree(
            db_path,
            str(context["worktree_id"]),
            status=next_worktree_status,
            metadata=metadata,
            released=next_worktree_status == "released",
        )
    updated_context = upsert_task_execution_context(
        db_path,
        task_id=str(context["task_id"]),
        project_id=str(context["project_id"]),
        owner_agent=str(context["owner_agent"]),
        canonical_workspace_path=str(context["canonical_workspace_path"]),
        execution_workspace_path=str(context["execution_workspace_path"]),
        worktree_id=str(context["worktree_id"]) if context.get("worktree_id") else None,
        runtime_kind=str(context["runtime_kind"]),
        status=final_status,
        metadata=metadata,
        finished=True,
    )
    return {
        "worktree": worktree,
        "execution_context": updated_context,
    }


def release_worktree(
    db_path: str,
    *,
    worktree_id: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return update_project_worktree(
        db_path,
        worktree_id,
        status="released",
        released=True,
        metadata=metadata,
    )


def cleanup_worktree(
    db_path: str,
    *,
    worktree_id: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    worktree = get_project_worktree(db_path, worktree_id)
    target_path = Path(str(worktree["worktree_path"])).resolve()
    canonical_workspace = Path(str(worktree["canonical_workspace_path"])).resolve()
    if target_path == canonical_workspace:
        raise ValueError("refusing to cleanup canonical workspace")
    if target_path.exists():
        if str(worktree["isolation_mode"]) == "git_worktree":
            git_root = _detect_git_root(canonical_workspace)
            if git_root is not None:
                _run_git("-C", str(git_root), "worktree", "remove", "--force", str(target_path))
                _run_git("-C", str(git_root), "worktree", "prune")
        if target_path.exists():
            shutil.rmtree(target_path, ignore_errors=True)
    cleaned = update_project_worktree(
        db_path,
        worktree_id,
        status="cleaned",
        cleaned=True,
        metadata=metadata,
    )
    return cleaned
