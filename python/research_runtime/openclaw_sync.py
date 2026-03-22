from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

_CACHE_LOCK = threading.Lock()
_STORE_LOCK = threading.Lock()
_CACHE_PAYLOAD: dict[str, Any] | None = None
_CACHE_AT = 0.0
_CATALOG_CACHE_LOCK = threading.Lock()
_CATALOG_CACHE_PAYLOAD: dict[str, Any] | None = None
_CATALOG_CACHE_AT = 0.0

_PROVIDER_ALIASES = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "github-copilot": "github-copilot",
    "copilot": "github-copilot",
    "github": "github-copilot",
    "gemini": "google-gemini-cli",
    "google": "google-gemini-cli",
    "google-gemini-cli": "google-gemini-cli",
    "minimax": "minimax",
    "openai": "openai-codex",
    "openai-codex": "openai-codex",
    "xiaomi": "xiaomi",
    "zai": "zai",
    "z-ai": "zai",
}

_ANSI_PATTERN = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _openclaw_dir() -> Path:
    configured = os.environ.get("SCIAILAB_OPENCLAW_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (_project_root() / "openclaw").resolve()


def _cache_ttl_seconds() -> int:
    raw = os.environ.get("SCIAILAB_OPENCLAW_SYNC_TTL_SECONDS", "15")
    try:
        ttl = int(raw)
    except ValueError:
        return 15
    return max(0, ttl)


def _catalog_cache_ttl_seconds() -> int:
    raw = os.environ.get("SCIAILAB_OPENCLAW_MODEL_CATALOG_TTL_SECONDS", "60")
    try:
        ttl = int(raw)
    except ValueError:
        return 60
    return max(0, ttl)


def _home_dir() -> Path:
    home = (
        os.environ.get("OPENCLAW_HOME")
        or os.environ.get("USERPROFILE")
        or os.environ.get("HOME")
        or str(Path.home())
    )
    return Path(home).expanduser().resolve()


def _state_dir() -> Path:
    override = os.environ.get("OPENCLAW_STATE_DIR") or os.environ.get("CLAWDBOT_STATE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (_home_dir() / ".openclaw").resolve()


def resolve_openclaw_agent_dir() -> Path:
    override = os.environ.get("OPENCLAW_AGENT_DIR") or os.environ.get("PI_CODING_AGENT_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return (_state_dir() / "agents" / "main" / "agent").resolve()


def resolve_auth_store_path() -> Path:
    return resolve_openclaw_agent_dir() / "auth-profiles.json"


def invalidate_openclaw_snapshot_cache() -> None:
    global _CACHE_AT, _CACHE_PAYLOAD
    with _CACHE_LOCK:
        _CACHE_PAYLOAD = None
        _CACHE_AT = 0.0
    global _CATALOG_CACHE_AT, _CATALOG_CACHE_PAYLOAD
    with _CATALOG_CACHE_LOCK:
        _CATALOG_CACHE_PAYLOAD = None
        _CATALOG_CACHE_AT = 0.0


def normalize_provider_id(provider: str | None) -> str:
    normalized = str(provider or "").strip().lower()
    return _PROVIDER_ALIASES.get(normalized, normalized)


def match_usage_provider(snapshot: dict[str, Any], provider: str | None) -> dict[str, Any] | None:
    normalized = normalize_provider_id(provider)
    if not normalized:
        return None
    usage_summary = snapshot.get("usage_summary") if isinstance(snapshot, dict) else None
    providers = usage_summary.get("providers") if isinstance(usage_summary, dict) else None
    if not isinstance(providers, list):
        return None
    for entry in providers:
        if not isinstance(entry, dict):
            continue
        if normalize_provider_id(entry.get("provider")) == normalized:
            return entry
    return None


def _empty_snapshot(error: str | None = None) -> dict[str, Any]:
    return {
        "ok": False,
        "generated_at": None,
        "agent_dir": str(resolve_openclaw_agent_dir()),
        "auth_store_path": str(resolve_auth_store_path()),
        "auth_store_exists": False,
        "auth_store": {
            "version": None,
            "last_good": {},
            "profiles": [],
        },
        "usage_summary": {
            "updated_at": None,
            "providers": [],
            "error": None,
        },
        "error": error,
    }


def _iso_from_millis(value: object) -> str | None:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None
    if numeric <= 0:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(numeric / 1000))


def _remaining_seconds(value: object, *, now_ms: int) -> int:
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return 0
    if numeric <= now_ms:
        return 0
    return max(0, (numeric - now_ms + 999) // 1000)


def _sanitize_credential_metadata(profile: dict[str, Any]) -> dict[str, str]:
    metadata: dict[str, str] = {}
    for source_key, target_key in (
        ("email", "email"),
        ("enterpriseUrl", "enterprise_url"),
        ("projectId", "project_id"),
        ("accountId", "account_id"),
    ):
        value = profile.get(source_key)
        if isinstance(value, str) and value.strip():
            metadata[target_key] = value.strip()
    provider_metadata = profile.get("metadata")
    if isinstance(provider_metadata, dict):
        for key, value in provider_metadata.items():
            if isinstance(value, str) and value.strip():
                metadata[f"provider_{key}"] = value.strip()
    return metadata


def _has_credential(profile: dict[str, Any]) -> bool:
    profile_type = str(profile.get("type") or "").strip().lower()
    if profile_type == "api_key":
        return bool(profile.get("key") or profile.get("keyRef"))
    if profile_type == "token":
        return bool(profile.get("token") or profile.get("tokenRef"))
    if profile_type == "oauth":
        return bool(profile.get("access") or profile.get("refresh"))
    return False


def _derive_profile_status(profile: dict[str, Any], usage: dict[str, Any], *, now_ms: int) -> tuple[str, str | None]:
    disabled_remaining = _remaining_seconds(usage.get("disabledUntil"), now_ms=now_ms)
    if disabled_remaining > 0:
        reason = usage.get("disabledReason")
        return "disabled", str(reason) if reason else "disabled"
    cooldown_remaining = _remaining_seconds(usage.get("cooldownUntil"), now_ms=now_ms)
    if cooldown_remaining > 0:
        reason = usage.get("disabledReason")
        return "cooldown", str(reason) if reason else "cooldown"
    if not _has_credential(profile):
        return "needs_login", "missing_credential"
    error_count = int(usage.get("errorCount") or 0)
    if error_count > 0 or usage.get("disabledReason"):
        reason = usage.get("disabledReason")
        return "degraded", str(reason) if reason else "recent_failures"
    return "connected", None


def _normalize_failure_counts(value: object) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    counts: dict[str, int] = {}
    for key, raw in value.items():
        try:
            count = int(raw)
        except (TypeError, ValueError):
            continue
        if count > 0:
            counts[str(key)] = count
    return dict(sorted(counts.items()))


def _load_auth_store_snapshot() -> tuple[dict[str, Any], str | None]:
    auth_store_path = resolve_auth_store_path()
    now_ms = int(time.time() * 1000)
    if not auth_store_path.exists():
        return {
            "version": None,
            "last_good": {},
            "profiles": [],
        }, None

    try:
        raw = json.loads(auth_store_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {
            "version": None,
            "last_good": {},
            "profiles": [],
        }, f"failed to read auth store: {exc}"

    profiles_raw = raw.get("profiles")
    usage_stats = raw.get("usageStats")
    last_good = raw.get("lastGood") if isinstance(raw.get("lastGood"), dict) else {}
    profiles: list[dict[str, Any]] = []
    if not isinstance(profiles_raw, dict):
        return {
            "version": raw.get("version"),
            "last_good": last_good,
            "profiles": [],
        }, "auth store is missing profiles object"

    for profile_id, entry in sorted(profiles_raw.items(), key=lambda item: str(item[0])):
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider") or str(profile_id).split(":", 1)[0]).strip().lower()
        usage = usage_stats.get(profile_id) if isinstance(usage_stats, dict) else {}
        if not isinstance(usage, dict):
            usage = {}
        metadata = _sanitize_credential_metadata(entry)
        status, status_reason = _derive_profile_status(entry, usage, now_ms=now_ms)
        profiles.append(
            {
                "profile_id": str(profile_id),
                "provider": provider,
                "auth_type": str(entry.get("type") or "oauth").strip().lower(),
                "has_credential": _has_credential(entry),
                "account_label": (
                    metadata.get("email")
                    or metadata.get("account_id")
                    or metadata.get("project_id")
                ),
                "status": status,
                "status_reason": status_reason,
                "last_used_at": _iso_from_millis(usage.get("lastUsed")),
                "cooldown_until": _iso_from_millis(usage.get("cooldownUntil")),
                "cooldown_seconds_remaining": _remaining_seconds(
                    usage.get("cooldownUntil"), now_ms=now_ms
                ),
                "disabled_until": _iso_from_millis(usage.get("disabledUntil")),
                "disabled_seconds_remaining": _remaining_seconds(
                    usage.get("disabledUntil"), now_ms=now_ms
                ),
                "disabled_reason": usage.get("disabledReason"),
                "error_count": int(usage.get("errorCount") or 0),
                "last_failure_at": _iso_from_millis(usage.get("lastFailureAt")),
                "failure_counts": _normalize_failure_counts(usage.get("failureCounts")),
                "last_good_for_provider": last_good.get(provider) == profile_id,
                "metadata": metadata,
            }
        )

    return {
        "version": raw.get("version"),
        "last_good": last_good,
        "profiles": profiles,
    }, None


def _read_auth_store_record(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "version": 1,
            "profiles": {},
            "lastGood": {},
            "usageStats": {},
        }

    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("auth store payload must be an object")
    return raw


def _write_auth_store_record(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(serialized, encoding="utf-8")
    tmp_path.replace(path)


def upsert_openclaw_api_key_profile(
    *,
    profile_id: str,
    provider: str,
    api_key: str,
    set_last_good: bool = True,
) -> dict[str, Any]:
    resolved_profile_id = str(profile_id).strip()
    resolved_provider = str(provider).strip().lower()
    resolved_api_key = str(api_key).strip()

    if not resolved_profile_id:
        raise ValueError("profile_id is required")
    if not resolved_provider:
        raise ValueError("provider is required")
    if not resolved_api_key:
        raise ValueError("api_key is required")

    auth_store_path = resolve_auth_store_path()
    with _STORE_LOCK:
        payload = _read_auth_store_record(auth_store_path)
        version = payload.get("version")
        try:
            resolved_version = max(1, int(version))
        except (TypeError, ValueError):
            resolved_version = 1

        profiles = payload.get("profiles")
        if not isinstance(profiles, dict):
            profiles = {}

        current = profiles.get(resolved_profile_id)
        next_profile = dict(current) if isinstance(current, dict) else {}
        next_profile.update(
            {
                "type": "api_key",
                "provider": resolved_provider,
                "key": resolved_api_key,
            }
        )
        for field in ("keyRef", "token", "tokenRef", "access", "refresh", "expires"):
            next_profile.pop(field, None)
        profiles[resolved_profile_id] = next_profile
        payload["version"] = resolved_version
        payload["profiles"] = profiles

        last_good = payload.get("lastGood")
        if not isinstance(last_good, dict):
            last_good = {}
        if set_last_good:
            last_good[resolved_provider] = resolved_profile_id
        payload["lastGood"] = last_good

        usage_stats = payload.get("usageStats")
        if not isinstance(usage_stats, dict):
            payload["usageStats"] = {}

        _write_auth_store_record(auth_store_path, payload)

    invalidate_openclaw_snapshot_cache()
    return {
        "profile_id": resolved_profile_id,
        "provider": resolved_provider,
        "auth_store_path": str(auth_store_path),
    }


def _strip_ansi(value: str) -> str:
    return _ANSI_PATTERN.sub("", value)


def _extract_json_object(value: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(value):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(value[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            if "usage" in parsed or "updatedAt" in parsed or "providers" in parsed:
                return parsed
    return None


def _extract_model_catalog_json(value: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(value):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(value[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("models"), list):
            return parsed
    return None


def _parse_model_catalog_key(key: object) -> tuple[str, str] | None:
    value = str(key or "").strip()
    if not value or "/" not in value:
        return None
    provider, model_id = value.split("/", 1)
    provider = provider.strip()
    model_id = model_id.strip()
    if not provider or not model_id:
        return None
    return provider, model_id


def _normalize_model_catalog(payload: dict[str, Any], *, generated_at: str) -> dict[str, Any]:
    models_raw = payload.get("models")
    models: list[dict[str, Any]] = []
    provider_stats: dict[str, dict[str, Any]] = {}

    if isinstance(models_raw, list):
        for entry in models_raw:
            if not isinstance(entry, dict):
                continue
            parsed_key = _parse_model_catalog_key(entry.get("key"))
            if parsed_key is None:
                continue
            provider, model_id = parsed_key
            available = bool(entry.get("available"))
            local = bool(entry.get("local"))
            model_record = {
                "key": str(entry.get("key")),
                "provider": provider,
                "model_id": model_id,
                "name": str(entry.get("name") or model_id),
                "input": str(entry.get("input") or "text"),
                "context_window": entry.get("contextWindow"),
                "local": local,
                "available": available,
                "missing": bool(entry.get("missing")),
                "tags": [str(tag) for tag in entry.get("tags", []) if isinstance(tag, str)],
            }
            models.append(model_record)

            stats = provider_stats.setdefault(
                provider,
                {
                    "id": provider,
                    "model_count": 0,
                    "available_count": 0,
                    "local_count": 0,
                },
            )
            stats["model_count"] += 1
            if available:
                stats["available_count"] += 1
            if local:
                stats["local_count"] += 1

    providers = sorted(provider_stats.values(), key=lambda item: str(item["id"]))
    models.sort(key=lambda item: (str(item["provider"]), str(item["model_id"])))

    try:
        reported_count = int(payload.get("count"))
    except (TypeError, ValueError):
        reported_count = len(models)

    return {
        "ok": True,
        "generated_at": generated_at,
        "count": reported_count,
        "provider_count": len(providers),
        "providers": providers,
        "models": models,
        "error": None,
    }


def _load_model_catalog(openclaw_dir: Path) -> dict[str, Any]:
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    node_bin = os.environ.get("SCIAILAB_NODE_BIN", "node")
    timeout_ms_raw = os.environ.get("SCIAILAB_OPENCLAW_MODEL_CATALOG_TIMEOUT_MS", "12000")
    try:
        timeout_ms = max(3000, int(timeout_ms_raw))
    except ValueError:
        timeout_ms = 12000

    env = os.environ.copy()
    env.setdefault("OPENCLAW_SKIP_CHANNELS", "1")
    env.setdefault("CLAWDBOT_SKIP_CHANNELS", "1")

    completed = subprocess.run(
        [node_bin, "openclaw.mjs", "models", "list", "--all", "--json"],
        cwd=str(openclaw_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(15, int(timeout_ms / 1000) + 8),
        env=env,
        check=False,
    )

    cleaned_stdout = _strip_ansi(completed.stdout or "")
    payload = _extract_model_catalog_json(cleaned_stdout)
    cleaned_stderr = _strip_ansi(completed.stderr or "").strip()

    if payload is None:
        detail = cleaned_stderr or (cleaned_stdout.strip().splitlines()[-1] if cleaned_stdout.strip() else "")
        return {
            "ok": False,
            "generated_at": generated_at,
            "count": 0,
            "provider_count": 0,
            "providers": [],
            "models": [],
            "error": detail or "failed to parse OpenClaw model catalog output",
        }

    catalog = _normalize_model_catalog(payload, generated_at=generated_at)
    if completed.returncode != 0:
        catalog["ok"] = False
        catalog["error"] = cleaned_stderr or f"openclaw models list exited with {completed.returncode}"
    return catalog


def _normalize_usage_summary(payload: dict[str, Any], *, generated_at: str) -> dict[str, Any]:
    usage_payload = payload.get("usage") if isinstance(payload.get("usage"), dict) else payload
    providers_raw = usage_payload.get("providers") if isinstance(usage_payload, dict) else None
    providers: list[dict[str, Any]] = []
    if isinstance(providers_raw, list):
        for entry in providers_raw:
            if not isinstance(entry, dict):
                continue
            windows_raw = entry.get("windows")
            windows: list[dict[str, Any]] = []
            if isinstance(windows_raw, list):
                for window in windows_raw:
                    if not isinstance(window, dict):
                        continue
                    reset_at_ms = None
                    try:
                        reset_at_ms = int(window.get("resetAt")) if window.get("resetAt") is not None else None
                    except (TypeError, ValueError):
                        reset_at_ms = None
                    windows.append(
                        {
                            "label": str(window.get("label") or "window"),
                            "used_percent": float(window.get("usedPercent") or 0),
                            "reset_at": _iso_from_millis(reset_at_ms),
                            "reset_at_ms": reset_at_ms,
                        }
                    )
            providers.append(
                {
                    "provider": entry.get("provider"),
                    "display_name": entry.get("displayName"),
                    "plan": entry.get("plan"),
                    "error": entry.get("error"),
                    "windows": windows,
                }
            )

    updated_at = _iso_from_millis(usage_payload.get("updatedAt")) if isinstance(usage_payload, dict) else None
    return {
        "updated_at": updated_at or generated_at,
        "providers": providers,
        "error": None,
    }


def _load_usage_summary(openclaw_dir: Path) -> dict[str, Any]:
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    fixture_path = os.environ.get("SCIAILAB_OPENCLAW_USAGE_FIXTURE_PATH")
    if fixture_path:
        try:
            payload = json.loads(Path(fixture_path).expanduser().resolve().read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                return _normalize_usage_summary(payload, generated_at=generated_at)
        except Exception as exc:  # noqa: BLE001
            return {
                "updated_at": generated_at,
                "providers": [],
                "error": f"failed to read usage fixture: {exc}",
            }

    if os.environ.get("SCIAILAB_OPENCLAW_SKIP_USAGE") == "1":
        return {
            "updated_at": generated_at,
            "providers": [],
            "error": None,
        }

    node_bin = os.environ.get("SCIAILAB_NODE_BIN", "node")
    timeout_ms_raw = os.environ.get("SCIAILAB_OPENCLAW_USAGE_TIMEOUT_MS", "6000")
    try:
        timeout_ms = max(1000, int(timeout_ms_raw))
    except ValueError:
        timeout_ms = 6000

    env = os.environ.copy()
    env.setdefault("OPENCLAW_SKIP_CHANNELS", "1")
    env.setdefault("CLAWDBOT_SKIP_CHANNELS", "1")

    completed = subprocess.run(
        [node_bin, "openclaw.mjs", "status", "--json", "--usage", "--timeout", str(timeout_ms)],
        cwd=str(openclaw_dir),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=max(10, int(timeout_ms / 1000) + 6),
        env=env,
        check=False,
    )

    cleaned_stdout = _strip_ansi(completed.stdout or "")
    payload = _extract_json_object(cleaned_stdout)
    if payload is None:
        detail = _strip_ansi(completed.stderr or "").strip()
        if completed.returncode != 0 and detail:
            return {
                "updated_at": generated_at,
                "providers": [],
                "error": detail,
            }
        return {
            "updated_at": generated_at,
            "providers": [],
            "error": "failed to parse usage summary from openclaw status output",
        }

    usage_summary = _normalize_usage_summary(payload, generated_at=generated_at)
    if completed.returncode != 0:
        usage_summary["error"] = _strip_ansi(completed.stderr or "").strip() or (
            f"openclaw status exited with {completed.returncode}"
        )
    return usage_summary


def _load_snapshot_uncached() -> dict[str, Any]:
    openclaw_dir = _openclaw_dir()
    agent_dir = resolve_openclaw_agent_dir()
    auth_store = {
        "version": None,
        "last_good": {},
        "profiles": [],
    }
    auth_error: str | None = None
    try:
        auth_store, auth_error = _load_auth_store_snapshot()
    except Exception as exc:  # noqa: BLE001
        auth_error = f"auth store sync failed: {exc}"

    try:
        usage_summary = _load_usage_summary(openclaw_dir)
    except Exception as exc:  # noqa: BLE001
        usage_summary = {
            "updated_at": None,
            "providers": [],
            "error": f"usage sync failed: {exc}",
        }

    errors = [message for message in (auth_error, usage_summary.get("error")) if message]
    return {
        "ok": not errors,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "agent_dir": str(agent_dir),
        "auth_store_path": str(resolve_auth_store_path()),
        "auth_store_exists": resolve_auth_store_path().exists(),
        "auth_store": auth_store,
        "usage_summary": usage_summary,
        "error": "; ".join(errors) if errors else None,
    }


def get_openclaw_live_snapshot(*, force_refresh: bool = False) -> dict[str, Any]:
    global _CACHE_AT, _CACHE_PAYLOAD

    ttl = _cache_ttl_seconds()
    now = time.time()
    with _CACHE_LOCK:
        if (
            not force_refresh
            and _CACHE_PAYLOAD is not None
            and ttl > 0
            and (now - _CACHE_AT) < ttl
        ):
            return _CACHE_PAYLOAD

        payload = _load_snapshot_uncached()
        _CACHE_PAYLOAD = payload
        _CACHE_AT = now
        return payload


def get_openclaw_model_catalog(*, force_refresh: bool = False) -> dict[str, Any]:
    global _CATALOG_CACHE_AT, _CATALOG_CACHE_PAYLOAD

    ttl = _catalog_cache_ttl_seconds()
    now = time.time()
    with _CATALOG_CACHE_LOCK:
        if (
            not force_refresh
            and _CATALOG_CACHE_PAYLOAD is not None
            and ttl > 0
            and (now - _CATALOG_CACHE_AT) < ttl
        ):
            return _CATALOG_CACHE_PAYLOAD

        payload = _load_model_catalog(_openclaw_dir())
        _CATALOG_CACHE_PAYLOAD = payload
        _CATALOG_CACHE_AT = now
        return payload
