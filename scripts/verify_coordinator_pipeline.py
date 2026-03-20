from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

runtime_root = Path(tempfile.mkdtemp(prefix="sciailab-coordinator-verify-"))
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
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def get(port: int, path: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


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
            get(port, "/health")
            break
        except Exception:
            time.sleep(0.25)
    else:
        raise RuntimeError("fastapi service did not start in time")

    project = post(
        port,
        "/v1/projects",
        {
            "name": "SciAILab Coordinator Verification",
            "goal": "Verify the coordinator chain with reviewer loop branching.",
            "project_id": f"coordinator-check-{uuid4().hex[:8]}",
        },
    )
    project_id = project["project"]["project_id"]

    coordinator = post(
        port,
        "/v1/coordinators/run",
        {
            "project_id": project_id,
            "limit": 20,
            "consume_limit": 20,
        },
    )
    tasks = get(port, f"/v1/projects/{project_id}/tasks")
    artifacts = get(port, f"/v1/projects/{project_id}/artifacts")
    packages = get(port, f"/v1/projects/{project_id}/packages")
    agent_states = get(port, f"/v1/projects/{project_id}/state/agents")
    events = get(port, f"/v1/projects/{project_id}/events")

    server.should_exit = True
    thread.join(timeout=5)

    task_counter = Counter(task["owner_agent"] for task in tasks["tasks"])
    task_statuses = Counter(task["status"] for task in tasks["tasks"])
    artifact_types = sorted({artifact["artifact_type"] for artifact in artifacts["artifacts"]})
    event_types = [event["event_type"] for event in events["events"]]
    package_types = sorted({package["package_type"] for package in packages["packages"]})
    agent_state_map = {item["agent_id"]: item["state"] for item in agent_states["agent_states"]}

    assert_equal(coordinator["count"], 12, "coordinator run count")
    assert_equal(task_counter, Counter({"writer": 4, "reviewer": 4, "experiment": 3, "explorer": 1}), "task owner counts")
    assert_equal(task_statuses, Counter({"done": 12}), "task statuses")
    assert_equal(artifact_types, ["draft", "hypotheses", "results_summary", "review_report"], "artifact types")
    assert_equal(package_types, ["experiment_bundle", "research_package", "writing_input_package"], "package types")
    assert_equal(agent_state_map, {"explorer": "idle", "experiment": "idle", "writer": "done", "reviewer": "idle"}, "agent states")
    for required_event in (
        "hypothesis_ready_for_experiment",
        "experiment_results_ready",
        "review_requested",
        "review_requires_ablation",
        "review_requires_evidence",
        "review_requires_revision",
        "review_approved",
    ):
        if required_event not in event_types:
            raise AssertionError(f"missing event: {required_event}")

    print(
        json.dumps(
            {
                "project_id": project_id,
                "coordinator_runs": coordinator["count"],
                "task_counts": task_counter,
                "artifact_types": artifact_types,
                "package_count": len(packages["packages"]),
                "package_types": package_types,
                "agent_states": agent_state_map,
                "events": event_types,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
