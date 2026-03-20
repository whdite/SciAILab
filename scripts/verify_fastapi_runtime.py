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

    tasks = get(port, f"/v1/projects/{project_id}/tasks")
    agent_states = get(port, f"/v1/projects/{project_id}/state/agents")
    events = get(port, f"/v1/projects/{project_id}/events")
    read_model = get(port, f"/v1/projects/{project_id}/read-model?limit=25")
    trace_page = get_text(port, f"/trace/{project_id}?limit=25")
    scheduler_state = get(port, "/v1/control/scheduler-state")

    server.should_exit = True
    thread.join(timeout=5)

    task_statuses = {item["task_id"]: item["status"] for item in tasks["tasks"]}
    agent_state_map = {item["agent_id"]: item["state"] for item in agent_states["agent_states"]}
    task_titles = {item["title"] for item in tasks["tasks"]}
    event_actions = [item["event_type"] for item in events["events"]]

    assert_equal(task_statuses[task["task_id"]], "done", "lifecycle task final status")
    assert "Review the latest draft and return publication feedback" in task_titles
    assert "Gather additional evidence requested by reviewer" in task_titles
    assert "Revise draft based on reviewer feedback" in task_titles
    assert_equal(agent_state_map["experiment"], "planning", "experiment state after evidence request")
    assert_equal(agent_state_map["reviewer"], "review_pending", "reviewer state after review request")
    assert_equal(agent_state_map["writer"], "planning", "writer state after revision request")
    assert_equal(read_model["project"]["project_id"], project_id, "read model project id")
    assert_equal(read_model["summary"]["counts"]["tasks"], len(tasks["tasks"]), "read model task count")
    explorer_route = next(item for item in updated_routing["routes"] if item["role"] == "explorer")
    reviewer_route = next(item for item in activated_routing["routes"] if item["role"] == "reviewer")
    assert_equal(initial_routing["count"], 4, "initial routing count")
    assert_equal(explorer_route["provider"], "openai", "explorer provider route")
    assert_equal(explorer_route["model"], "gpt-5.4", "explorer model route")
    assert_equal(explorer_route["max_concurrency"], 2, "explorer concurrency route")
    assert_equal(reviewer_route["active"], True, "reviewer activation")
    assert_equal(reviewer_route["max_concurrency"], 3, "reviewer activation concurrency")
    assert_equal(len(scheduler_state["roles"]), 4, "scheduler role count")
    scheduler_explorer = next(item for item in scheduler_state["roles"] if item["role"] == "explorer")
    scheduler_reviewer = next(item for item in scheduler_state["roles"] if item["role"] == "reviewer")
    assert_equal(scheduler_explorer["provider"], "openai", "scheduler explorer provider")
    assert_equal(scheduler_explorer["max_concurrency"], 2, "scheduler explorer concurrency")
    assert_equal(scheduler_reviewer["active"], True, "scheduler reviewer active")
    assert_equal("queue" in scheduler_explorer, True, "scheduler queue present")
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
                    evidence_request["event_type"],
                    revision_request["event_type"],
                ],
                "agent_states": agent_state_map,
                "routing": {
                    "initial_count": initial_routing["count"],
                    "explorer": explorer_route,
                    "reviewer": reviewer_route,
                },
                "scheduler_state": {
                    "role_count": len(scheduler_state["roles"]),
                    "queue_counts": scheduler_state["queue_counts"],
                },
                "read_model_counts": read_model["summary"]["counts"],
                "read_model_filters": read_model["read_model"]["filters"],
                "trace_page": {
                    "contains_title": "SciAILab Runtime Trace" in trace_page,
                    "contains_project_id": project_id in trace_page,
                    "contains_filters": all(token in trace_page for token in ("event-type-filter", "status-filter", "owner-agent-filter")),
                    "contains_details": "Payload / Metadata Details" in trace_page,
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
