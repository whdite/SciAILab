# SciAILab Rule Matrix

This document is the readable rule matrix for the current SciAILab runtime. It reflects the implemented behavior in the FastAPI runtime and `research-core`, not an aspirational workflow sketch.

## 1. Scope

This matrix covers:

- task lifecycle states
- task status transitions
- coordinator completion events
- event-to-downstream-task rules
- reviewer loop branches
- read-model and trace surfaces

Primary implementation sources:

- `python/research_runtime/orchestrator/state_machine.py`
- `python/research_runtime/orchestrator/event_consumer.py`
- `python/research_runtime/orchestrator/task_driver.py`
- `python/research_runtime/coordinators/runner.py`
- `openclaw/extensions/research-core/src/coordinator-agent.ts`

## 2. Task Status Matrix

Current task statuses:

- `todo`
- `in_progress`
- `blocked`
- `retry`
- `done`

### 2.1 Allowed Task Transitions

| Current | Allowed Next |
| --- | --- |
| `todo` | `in_progress`, `blocked`, `retry` |
| `in_progress` | `blocked`, `retry`, `todo`, `done` |
| `blocked` | `retry`, `todo`, `in_progress` |
| `retry` | `in_progress`, `blocked`, `todo`, `done` |
| `done` | none |

### 2.2 Operational Meaning

| Status | Meaning |
| --- | --- |
| `todo` | fresh downstream work waiting to be claimed |
| `in_progress` | claimed by a worker/coordinator and currently executing |
| `blocked` | execution failed or is waiting on an unblock action |
| `retry` | runnable again, but explicitly marked as a retry path |
| `done` | terminal completed state |

### 2.3 Claim Rule

`/v1/tasks/claim` can claim tasks in:

- `todo`
- `retry`

Claim always moves the task to:

- `in_progress`

## 3. Agent State Matrix

Current agent states:

- `idle`
- `waiting_input`
- `planning`
- `executing`
- `blocked`
- `needs_human`
- `review_pending`
- `done`

Most important runtime-owned transitions:

| Trigger | Agent | State |
| --- | --- | --- |
| project bootstrap | `explorer` | `planning` |
| task claimed by coordinator | owner agent | `executing` or `review_pending` for reviewer |
| downstream task created for experiment | `experiment` | `planning` or `executing` depending on event |
| downstream task created for writer | `writer` | `planning` |
| downstream task created for reviewer | `reviewer` | `review_pending` |
| coordinator success | current owner | `idle` |
| `agent_blocked` | payload agent or event source | `blocked` |
| `agent_recovered` | payload agent or event source | `idle` |
| `review_approved` | `writer` via `next_agent` | `done` |

## 4. Coordinator Completion Matrix

Current default completion events emitted through `research_task.update_status(..., eventType=...)`:

| Coordinator | Artifact | Completion Event |
| --- | --- | --- |
| `explorer` | `hypotheses` | `hypothesis_ready_for_experiment` |
| `experiment` | `results_summary` | `experiment_results_ready` |
| `writer` | `draft` | `review_requested` |
| `reviewer` | `review_report` | `review_requires_ablation`, `review_requires_evidence`, `review_requires_revision`, or `review_approved` |

## 5. Event To Downstream Task Matrix

These rules are owned by `python/research_runtime/orchestrator/event_consumer.py`.

| Event Type | Downstream Task Owner | Scope | Downstream Task Title | Message | Agent State |
| --- | --- | --- | --- | --- | --- |
| `hypothesis_ready_for_experiment` | `experiment` | `experiment` | `Design and run experiment for hypothesis package` | to `experiment`, `request` | `planning` |
| `experiment_results_ready` | `writer` | `writer` | `Write draft from experiment results bundle` | to `writer`, `handoff` | `planning` |
| `writer_needs_evidence` | `experiment` | `experiment` | `Provide missing evidence requested by writer` | to `experiment`, `need_evidence` | `executing` |
| `review_requested` | `reviewer` | `review` | `Review the latest draft and return publication feedback` | to `reviewer`, `review_request` | `review_pending` |
| `review_requires_ablation` | `experiment` | `experiment` | `Run ablation requested by reviewer` | to `experiment`, `review_note` | `planning` |
| `review_requires_evidence` | `experiment` | `experiment` | `Gather additional evidence requested by reviewer` | to `experiment`, `review_note` | `planning` |
| `review_requires_revision` | `writer` | `writer` | `Revise draft based on reviewer feedback` | to `writer`, `review_note` | `planning` |

### 5.1 Non-Task Events

| Event Type | Effect |
| --- | --- |
| `agent_blocked` | mark target agent `blocked`; mark referenced task `blocked` when `payload.task_id` is present |
| `agent_recovered` | mark target agent `idle` |
| `task_retry_requested` | move referenced task to `retry`; move owner agent to `planning` |
| `task_requeued` | move referenced task to `todo`; move owner agent to `planning` |
| `review_approved` | no new task; mark `next_agent` as `done` when provided |

## 6. Reviewer Loop Matrix

Current Python coordinator loop order:

| Review Pass | Reviewer Event | Routed To | Meaning |
| --- | --- | --- | --- |
| first review report | `review_requires_ablation` | `experiment` | run an additional ablation pass |
| second review report | `review_requires_evidence` | `experiment` | gather stronger supporting evidence |
| third review report | `review_requires_revision` | `writer` | rewrite the draft against the evidence already present |
| fourth review report and later | `review_approved` | `writer` | terminate the review loop for the current MVP path |

This is the current implemented minimum viable reviewer loop. It is deterministic on purpose so the loop stays testable.

## 7. Package Matrix

| Package Type | Produced By | Used By |
| --- | --- | --- |
| `research_package` | explorer output freeze | experiment |
| `experiment_bundle` | experiment output freeze | writer |
| `writing_input_package` | writer input assembly freeze | writer run and review provenance |

## 8. Read Model And Trace Surface

### 8.1 JSON Read Model

Endpoint:

- `/v1/projects/{project_id}/read-model`

Current output includes:

- project metadata
- summary counts
- task status distribution
- event type distribution
- latest artifacts by type
- latest packages by type
- active task list
- agent state list
- recent timeline

### 8.2 HTML Trace Page

Page:

- `/trace/{project_id}`

Current page shows:

- top-level project metrics
- active tasks
- agent states
- event mix
- latest artifacts
- latest packages
- unified recent timeline

The HTML page is intentionally thin. The JSON read model is the stable contract; the page is only a local inspection surface over that contract.

## 9. Validation Matrix

Current local verification coverage:

| Verification | What It Covers |
| --- | --- |
| `python scripts/verify_fastapi_runtime.py` | task lifecycle transitions, downstream event rules, read-model JSON, trace page |
| `python scripts/verify_coordinator_pipeline.py` | Python coordinator chain including reviewer loop branches |
| `tsx scripts/verify_openclaw_agent_coordinator.mjs` | OpenClaw agent-backed coordinator path including reviewer branch events |
| `tsx --tsconfig tsconfig.runtime-imports.json ..\\scripts\\verify_openclaw_plugin_import.mjs` | plugin import and registration surface |

## 10. Current Boundary

This matrix does not yet define:

- retry limits
- dead-letter routing
- human intervention policy
- cross-project memory retrieval rules
- multi-worker concurrency policy

Those are still next-stage workflow hardening topics, not part of the current minimum rule set.
