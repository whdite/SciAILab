from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

runtime_root = Path(tempfile.mkdtemp(prefix="sciailab-fastapi-verify-"))
os.environ["SCIAILAB_DB_PATH"] = str(runtime_root / "research.db")
os.environ["SCIAILAB_WORKSPACE_ROOT"] = str(runtime_root / "workspace")
openclaw_agent_dir = runtime_root / "openclaw-agent"
openclaw_agent_dir.mkdir(parents=True, exist_ok=True)
auth_store_path = openclaw_agent_dir / "auth-profiles.json"
usage_fixture_path = runtime_root / "openclaw-usage.json"
os.environ["OPENCLAW_AGENT_DIR"] = str(openclaw_agent_dir)
os.environ["SCIAILAB_OPENCLAW_USAGE_FIXTURE_PATH"] = str(usage_fixture_path)
os.environ["SCIAILAB_OPENCLAW_SYNC_TTL_SECONDS"] = "0"

auth_store_path.write_text(
    json.dumps(
        {
            "version": 1,
            "profiles": {
                "profile-explorer": {
                    "type": "api_key",
                    "provider": "openai",
                    "key": "verify-openai-key",
                },
                "anthropic:review-work": {
                    "type": "oauth",
                    "provider": "anthropic",
                    "access": "verify-access",
                    "refresh": "verify-refresh",
                    "email": "reviewer@example.com",
                },
            },
            "lastGood": {
                "openai": "profile-explorer",
                "anthropic": "anthropic:review-work",
            },
            "usageStats": {
                "profile-explorer": {
                    "lastUsed": 1774000000000,
                    "cooldownUntil": 4070908800000,
                    "disabledReason": "rate_limit",
                    "errorCount": 2,
                    "failureCounts": {"rate_limit": 1},
                    "lastFailureAt": 1774000005000,
                },
                "anthropic:review-work": {
                    "lastUsed": 1774000100000,
                    "errorCount": 0,
                },
            },
        },
        ensure_ascii=False,
    ),
    encoding="utf-8",
)
usage_fixture_path.write_text(
    json.dumps(
        {
            "updatedAt": 1774000200000,
            "providers": [
                {
                    "provider": "openai-codex",
                    "displayName": "OpenAI Codex",
                    "plan": "pro",
                    "windows": [
                        {
                            "label": "Daily",
                            "usedPercent": 72,
                            "resetAt": 1774003800000,
                        }
                    ],
                },
                {
                    "provider": "anthropic",
                    "displayName": "Anthropic",
                    "plan": "max",
                    "windows": [
                        {
                            "label": "Hourly",
                            "usedPercent": 15,
                            "resetAt": 1774002000000,
                        }
                    ],
                },
            ],
        },
        ensure_ascii=False,
    ),
    encoding="utf-8",
)

import uvicorn
from research_runtime.api.app import app


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def post(port: int, path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def get(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def get_text(port: int, path: str) -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
        return response.read().decode("utf-8")


def assert_equal(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def main() -> int:
    port = find_free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    for _ in range(40):
        try:
            health = get(port, "/health")
            break
        except Exception:
            time.sleep(0.25)
    else:
        raise RuntimeError("fastapi service did not start in time")

    project = post(
        port,
        "/v1/projects",
        {
            "name": "SciAILab FastAPI Runtime Verification",
            "goal": "Verify task lifecycle transitions and downstream event rules.",
            "project_id": "fastapi-runtime-check",
            "bootstrap_flow": False,
        },
    )
    project_id = project["project"]["project_id"]

    initial_routing = get(port, "/v1/control/agent-routing")
    updated_routing = post(
        port,
        "/v1/control/agent-routing",
        {
            "routes": [
                {
                    "role": "explorer",
                    "provider": "openai",
                    "model": "gpt-5.4",
                    "auth_profile": "profile-explorer",
                    "max_concurrency": 2,
                },
                {
                    "role": "reviewer",
                    "active": False,
                    "provider": "anthropic",
                    "model": "claude-review",
                    "max_concurrency": 1,
                },
            ]
        },
    )
    auth_profiles_after_route = get(port, "/v1/control/auth-profiles")
    saved_profiles = post(
        port,
        "/v1/control/auth-profiles",
        {
            "profiles": [
                {
                    "profile_id": "anthropic:review-work",
                    "provider": "anthropic",
                    "label": "Reviewer Work Account",
                    "auth_type": "oauth",
                    "status": "connected",
                    "credential_ref": "anthropic:review-work",
                    "login_hint": "openclaw models auth login anthropic",
                }
            ]
        },
    )
    tested_profile = post(
        port,
        "/v1/control/auth-profiles/test",
        {
            "profile_id": "anthropic:review-work",
        },
    )
    activated_routing = post(
        port,
        "/v1/control/agent-activation",
        {
            "role": "reviewer",
            "active": True,
            "max_concurrency": 3,
        },
    )

    task = post(
        port,
        "/v1/tasks",
        {
            "project_id": project_id,
            "title": "Verify task lifecycle transitions",
            "scope": "experiment",
            "owner_agent": "experiment",
            "status": "todo",
        },
    )
    claimed_once = post(port, "/v1/tasks/claim", {"project_id": project_id, "owner_agent": "experiment"})
    assert_equal(claimed_once["claimed"], True, "claim_once")
    assert_equal(claimed_once["task"]["task_id"], task["task_id"], "claimed task id")

    blocked = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "agent_blocked",
            "source": "experiment",
            "payload": {
                "agent_id": "experiment",
                "task_id": task["task_id"],
                "reason": "verification block",
            },
        },
    )
    retry = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "task_retry_requested",
            "source": "control-plane",
            "payload": {
                "task_id": task["task_id"],
            },
        },
    )
    requeue = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "task_requeued",
            "source": "control-plane",
            "payload": {
                "task_id": task["task_id"],
            },
        },
    )
    claimed_twice = post(port, "/v1/tasks/claim", {"project_id": project_id, "owner_agent": "experiment"})
    assert_equal(claimed_twice["claimed"], True, "claim_twice")
    assert_equal(claimed_twice["task"]["task_id"], task["task_id"], "reclaimed task id")

    finished = post(
        port,
        "/v1/tasks/status",
        {
            "task_id": task["task_id"],
            "status": "done",
        },
    )
    reviewer_request = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "review_requested",
            "source": "writer",
            "payload": {"artifact_id": "draft-artifact-v1"},
        },
    )
    duplicate_reviewer_request = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "review_requested",
            "source": "writer",
            "payload": {"artifact_id": "draft-artifact-v1"},
        },
    )
    evidence_request = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "review_requires_evidence",
            "source": "reviewer",
            "payload": {"artifact_id": "review-report-v1"},
        },
    )
    revision_request = post(
        port,
        "/v1/events",
        {
            "project_id": project_id,
            "event_type": "review_requires_revision",
            "source": "reviewer",
            "payload": {
                "artifact_id": "review-report-v2",
                "draft_artifact_id": "draft-artifact-v1",
            },
        },
    )
    provider_attempt = post(
        port,
        "/v1/control/provider-observability/event",
        {
            "role": "explorer",
            "event_type": "attempt",
            "provider": "openai",
            "model": "gpt-5.4",
            "auth_profile": "profile-explorer",
        },
    )
    provider_failure = post(
        port,
        "/v1/control/provider-observability/event",
        {
            "role": "explorer",
            "event_type": "failure",
            "provider": "openai",
            "model": "gpt-5.4",
            "auth_profile": "profile-explorer",
            "error": "429 rate limit exceeded",
            "failover": True,
        },
    )
    provider_success = post(
        port,
        "/v1/control/provider-observability/event",
        {
            "role": "reviewer",
            "event_type": "success",
            "provider": "anthropic",
            "model": "claude-review",
            "auth_profile": "anthropic:review-work",
        },
    )

    tasks = get(port, f"/v1/projects/{project_id}/tasks")
    agent_states = get(port, f"/v1/projects/{project_id}/state/agents")
    events = get(port, f"/v1/projects/{project_id}/events")
    projects = get(port, "/v1/projects?limit=20")
    read_model = get(port, f"/v1/projects/{project_id}/read-model?limit=25")
    trace_page = get_text(port, f"/trace/{project_id}?limit=25")
    web_root = get_text(port, "/")
    scheduler_state = get(port, "/v1/control/scheduler-state")
    provider_observability = get(port, "/v1/control/provider-observability")

    server.should_exit = True
    thread.join(timeout=5)

    task_statuses = {item["task_id"]: item["status"] for item in tasks["tasks"]}
    agent_state_map = {item["agent_id"]: item["state"] for item in agent_states["agent_states"]}
    task_titles = {item["title"] for item in tasks["tasks"]}
    event_actions = [item["event_type"] for item in events["events"]]
    review_task_count = sum(
        1 for item in tasks["tasks"] if item["title"] == "Review the latest draft and return publication feedback"
    )

    assert_equal(task_statuses[task["task_id"]], "done", "lifecycle task final status")
    assert "Review the latest draft and return publication feedback" in task_titles
    assert_equal(review_task_count, 1, "review task dedupe count")
    assert "Gather additional evidence requested by reviewer" in task_titles
    assert "Revise draft based on reviewer feedback" in task_titles
    assert_equal(agent_state_map["experiment"], "planning", "experiment state after evidence request")
    assert_equal(agent_state_map["reviewer"], "review_pending", "reviewer state after review request")
    assert_equal(agent_state_map["writer"], "planning", "writer state after revision request")
    assert_equal(projects["count"], 1, "project list count")
    assert_equal(projects["projects"][0]["project"]["project_id"], project_id, "project list first id")
    assert_equal(projects["projects"][0]["summary"]["tasks"], len(tasks["tasks"]), "project list task count")
    assert_equal(read_model["project"]["project_id"], project_id, "read model project id")
    assert_equal(read_model["summary"]["counts"]["tasks"], len(tasks["tasks"]), "read model task count")
    explorer_route = next(item for item in updated_routing["routes"] if item["role"] == "explorer")
    reviewer_route = next(item for item in activated_routing["routes"] if item["role"] == "reviewer")
    explorer_profile = next(item for item in auth_profiles_after_route["profiles"] if item["profile_id"] == "profile-explorer")
    reviewer_profile = next(item for item in saved_profiles["profiles"] if item["profile_id"] == "anthropic:review-work")
    assert_equal(initial_routing["count"], 4, "initial routing count")
    assert_equal(explorer_route["provider"], "openai", "explorer provider route")
    assert_equal(explorer_route["model"], "gpt-5.4", "explorer model route")
    assert_equal(explorer_route["max_concurrency"], 2, "explorer concurrency route")
    assert_equal(reviewer_route["active"], True, "reviewer activation")
    assert_equal(reviewer_route["max_concurrency"], 3, "reviewer activation concurrency")
    assert_equal(explorer_profile["provider"], "openai", "explorer auth profile provider")
    assert_equal(explorer_profile["openclaw_exists"], True, "explorer openclaw presence")
    assert_equal(explorer_profile["cooldown_active"], True, "explorer openclaw cooldown active")
    assert_equal(explorer_profile["quota_provider"], "openai-codex", "explorer quota provider mapped")
    assert_equal(reviewer_profile["credential_ref"], "anthropic:review-work", "saved auth profile credential ref")
    assert_equal(reviewer_profile["openclaw_exists"], True, "reviewer openclaw presence")
    assert_equal(saved_profiles["sync"]["ok"], True, "auth profile sync ok")
    assert_equal(tested_profile["status"], "connected", "tested auth profile status")
    assert_equal(len(scheduler_state["roles"]), 4, "scheduler role count")
    scheduler_explorer = next(item for item in scheduler_state["roles"] if item["role"] == "explorer")
    scheduler_reviewer = next(item for item in scheduler_state["roles"] if item["role"] == "reviewer")
    assert_equal(scheduler_explorer["provider"], "openai", "scheduler explorer provider")
    assert_equal(scheduler_explorer["max_concurrency"], 2, "scheduler explorer concurrency")
    assert_equal(scheduler_reviewer["active"], True, "scheduler reviewer active")
    assert_equal("queue" in scheduler_explorer, True, "scheduler queue present")
    assert_equal(provider_attempt["totals"]["requests_total"] >= 1, True, "provider attempt tracked")
    explorer_observation = next(item for item in provider_failure["roles"] if item["role"] == "explorer")
    reviewer_observation = next(item for item in provider_success["roles"] if item["role"] == "reviewer")
    assert_equal(explorer_observation["status"], "cooldown", "provider failure cooldown status")
    assert_equal(explorer_observation["rate_limit_total"] >= 1, True, "provider rate limit tracked")
    assert_equal(explorer_observation["failover_total"] >= 1, True, "provider failover tracked")
    assert_equal(explorer_observation["quota_provider"], "openai-codex", "provider quota provider mapped")
    assert_equal(len(explorer_observation["quota_windows"]) >= 1, True, "provider quota windows present")
    assert_equal(explorer_observation["cooldown_active"], True, "provider cooldown linked")
    assert_equal(reviewer_observation["success_total"] >= 1, True, "provider success tracked")
    assert_equal(provider_observability["count"], 4, "provider observability role count")
    assert_equal(provider_observability["sync"]["ok"], True, "provider sync ok")
    assert "event_types" in read_model["read_model"]["filters"]
    assert "statuses" in read_model["read_model"]["filters"]
    assert "owner_agents" in read_model["read_model"]["filters"]
    timeline_event = next(item for item in read_model["trace"]["timeline"] if item["kind"] == "event")
    assert_equal(timeline_event["event_type"] in {"agent_blocked", "task_retry_requested", "task_requeued", "review_requested", "review_requires_evidence", "review_requires_revision"}, True, "timeline event_type populated")
    assert_equal("details" in timeline_event, True, "timeline details present")
    assert_equal("payload" in timeline_event["details"], True, "timeline event payload present")
    assert "SciAILab Runtime Trace" in trace_page
    assert project_id in trace_page
    assert "event-type-filter" in trace_page
    assert "status-filter" in trace_page
    assert "owner-agent-filter" in trace_page
    assert "Payload / Metadata Details" in trace_page
    assert '<div id="root"></div>' in web_root
    assert "SciAILab" in web_root

    print(
        json.dumps(
            {
                "health": health["status"],
                "db_path": health["db_path"],
                "lifecycle_task": {
                    "task_id": task["task_id"],
                    "blocked_event": blocked["event_type"],
                    "retry_event": retry["event_type"],
                    "requeue_event": requeue["event_type"],
                    "final_status": finished["status"],
                },
                "downstream_events": [
                    reviewer_request["event_type"],
                    duplicate_reviewer_request["event_type"],
                    evidence_request["event_type"],
                    revision_request["event_type"],
                ],
                "agent_states": agent_state_map,
                "routing": {
                    "initial_count": initial_routing["count"],
                    "explorer": explorer_route,
                    "reviewer": reviewer_route,
                },
                "auth_profiles": {
                    "count": saved_profiles["count"],
                    "explorer_stub": explorer_profile,
                    "reviewer_profile": reviewer_profile,
                    "test": tested_profile,
                    "sync": saved_profiles["sync"],
                },
                "scheduler_state": {
                    "role_count": len(scheduler_state["roles"]),
                    "queue_counts": scheduler_state["queue_counts"],
                },
                "provider_observability": {
                    "totals": provider_observability["totals"],
                    "explorer": explorer_observation,
                    "reviewer": reviewer_observation,
                    "sync": provider_observability["sync"],
                },
                "projects": {
                    "count": projects["count"],
                    "first_project": projects["projects"][0],
                },
                "read_model_counts": read_model["summary"]["counts"],
                "read_model_filters": read_model["read_model"]["filters"],
                "trace_page": {
                    "contains_title": "SciAILab Runtime Trace" in trace_page,
                    "contains_project_id": project_id in trace_page,
                    "contains_filters": all(token in trace_page for token in ("event-type-filter", "status-filter", "owner-agent-filter")),
                    "contains_details": "Payload / Metadata Details" in trace_page,
                },
                "web_root": {
                    "contains_root_div": '<div id="root"></div>' in web_root,
                    "contains_title": "SciAILab" in web_root,
                },
                "task_titles": sorted(task_titles),
                "events": event_actions,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
