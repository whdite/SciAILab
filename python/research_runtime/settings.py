from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class ResearchRuntimeSettings:
    project_root: Path
    db_path: Path
    workspace_root: Path
    host: str
    port: int
    auto_consume_events: bool
    default_consume_limit: int


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def load_settings() -> ResearchRuntimeSettings:
    root = project_root()
    db_path = Path(os.environ.get("SCIAILAB_DB_PATH", root / "data" / "research.db"))
    workspace_root = Path(
        os.environ.get("SCIAILAB_WORKSPACE_ROOT", root / "workspace" / "projects")
    )
    host = os.environ.get("SCIAILAB_FASTAPI_HOST", "127.0.0.1")
    port = int(os.environ.get("SCIAILAB_FASTAPI_PORT", "8765"))
    auto_consume_events = env_flag("SCIAILAB_AUTO_CONSUME_EVENTS", True)
    default_consume_limit = int(os.environ.get("SCIAILAB_EVENT_CONSUME_LIMIT", "20"))
    return ResearchRuntimeSettings(
        project_root=root,
        db_path=db_path,
        workspace_root=workspace_root,
        host=host,
        port=port,
        auto_consume_events=auto_consume_events,
        default_consume_limit=default_consume_limit,
    )
