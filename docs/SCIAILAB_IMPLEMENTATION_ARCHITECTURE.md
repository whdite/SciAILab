# SciAILab Implementation Architecture

This document describes the architecture that is actually implemented in the current workspace. It replaces earlier MVP descriptions that assumed a stdio-first bridge or coordinator templates as the main path.

## 1. Current Architecture Summary

SciAILab currently runs as a split control-plane/runtime architecture:

- OpenClaw hosts the `research-core` plugin and provides gateway methods, agent tools, service lifecycle, and subagent execution.
- FastAPI provides the research runtime for project state, tasks, events, messages, packages, and agent state transitions.
- SQLite is the current truth store.
- `workspace/projects/<project-id>/` stores project-local artifacts and frozen packages.

The active end-to-end chain is:

`OpenClaw research-core -> FastAPI runtime -> SQLite truth store + workspace files`

This chain is no longer just target architecture. It is already wired and locally verified.

## 2. Runtime Layers

### 2.1 OpenClaw Host Layer

Key files:

- `openclaw/extensions/research-core/index.ts`
- `openclaw/extensions/research-core/src/gateway-methods.ts`
- `openclaw/extensions/research-core/src/coordinator-agent.ts`
- `openclaw/extensions/research-core/src/project-paths.ts`

Responsibilities:

- register the `research-core` plugin
- expose research gateway methods
- expose research tools to agents
- run the coordinator polling service
- claim `research_task` work from FastAPI
- launch role-specific subagents for explorer, experiment, writer, and reviewer
- persist coordinator outputs back through the runtime APIs

### 2.2 Python Runtime Layer

Key files:

- `python/research_runtime/api/app.py`
- `python/research_runtime/orchestrator/event_consumer.py`
- `python/research_runtime/orchestrator/task_driver.py`
- `python/research_runtime/orchestrator/state_machine.py`
- `python/research_runtime/storage/db.py`

Responsibilities:

- expose the FastAPI HTTP surface
- initialize and operate the SQLite schema
- create and list projects, tasks, artifacts, messages, events, packages, and agent states
- consume pending events into downstream tasks/messages/state changes
- update task status and optionally emit downstream events in one call
- validate task status, artifact state, and agent state transitions

### 2.3 Truth Store And Workspace Layer

Current persistence split:

- SQLite stores canonical control-plane truth
- workspace folders store markdown artifacts and frozen package files

Current default locations:

- `data/research.db`
- `workspace/projects/`

This keeps local development simple while preserving durable, inspectable project outputs on disk.

## 3. Current Plugin Surface

The `research-core` plugin currently registers:

- 15 gateway methods
- 8 agent tools
- 1 coordinator service

Implemented gateway coverage:

- `research.project.create`
- `research.project.status`
- `research.artifact.list`
- `research.message.send`
- `research.message.list`
- `research.event.emit`
- `research.event.list`
- `research.event.consume`
- `research.package.freeze`
- `research.package.list`
- `research.task.create`
- `research.task.list`
- `research.task.update_status`
- `research.state.agent_list`
- `research.coordinator.run`

Implemented tool coverage:

- `research_project`
- `research_artifact`
- `research_message`
- `research_event`
- `research_freeze`
- `research_task`
- `research_state`
- `research_coordinator`

## 4. Coordinator Execution Path

The coordinator path is now agent-backed by default, not template-backed.

Current flow:

1. FastAPI stores tasks in SQLite and exposes `/v1/tasks/claim`.
2. `research-core` service polls and claims the next eligible task.
3. The task owner determines the role subagent to run: `explorer`, `experiment`, `writer`, or `reviewer`.
4. The subagent returns structured JSON.
5. `research-core` parses the response and writes artifact markdown into the project workspace.
6. `research-core` registers artifact, package, message, and state updates through FastAPI.
7. Task completion is pushed through `research_task.update_status(..., eventType=...)`.
8. FastAPI emits the event and the event consumer creates downstream tasks/messages/state changes.

Current default downstream events:

- explorer -> `hypothesis_ready_for_experiment`
- experiment -> `experiment_results_ready`
- writer -> `review_requested`
- reviewer -> `review_requires_ablation` or `review_approved`

## 5. Event-Driven Downstream

The downstream chain is now event-driven instead of manually stitched between coordinators.

`python/research_runtime/orchestrator/event_consumer.py` currently consumes:

- `hypothesis_ready_for_experiment`
- `experiment_results_ready`
- `writer_needs_evidence`
- `review_requested`
- `review_requires_ablation`
- `agent_blocked`
- `agent_recovered`

Typical downstream actions:

- create the next role task
- create a handoff or review message
- move agent state into `planning`, `executing`, `review_pending`, `blocked`, or `idle`

This gives the Python runtime, not the individual coordinator, ownership of downstream workflow materialization.

## 6. Frozen Package Model

Frozen packages are part of the implemented chain, not a future placeholder.

Current role in the system:

- explorer and experiment outputs can be frozen into reusable packages
- writer consumes a `writing_input_package`
- writer no longer depends on a live read of whatever the latest workspace state happens to be

This makes each writing pass auditable and reproducible.

## 7. Transport And Configuration

Resolved in `openclaw/extensions/research-core/src/project-paths.ts`:

- primary transport: `fastapi`
- fallback transport: `stdio`
- default coordinator execution: `agent`
- default service base URL: `http://127.0.0.1:8765`
- default DB path: `data/research.db`
- default workspace root: `workspace/projects`

Important clarification:

- `stdio` still exists as a compatibility path
- it is no longer the recommended or primary architecture for current SciAILab development

## 8. Workspace Compatibility Layer

The current OpenClaw workspace still needs a small local compatibility layer for `research-core` verification.

Implemented compatibility pieces:

- `openclaw/tsconfig.runtime-imports.json`
- `openclaw/scripts/ensure-plugin-sdk-runtime-shims.mjs`
- `openclaw/scripts/ensure-pi-ai-compat.mjs`
- local self-reference junction: `openclaw/node_modules/openclaw -> openclaw`

These steps exist to stabilize the current workspace for local execution. They are not part of the product architecture itself.

## 9. Validation Path

The current workspace has a repeatable bootstrap and verification path.

Bootstrap/verify entry:

- `scripts/bootstrap_verify_research_core.ps1`

Verified checks:

- `python scripts/verify_fastapi_runtime.py`
- `python scripts/verify_coordinator_pipeline.py`
- `tsx scripts/verify_openclaw_agent_coordinator.mjs`
- `tsx --tsconfig tsconfig.runtime-imports.json ..\\scripts\\verify_openclaw_plugin_import.mjs`

This means the current goal is already met:

- `research-core` can run locally in the current workspace
- `research-core` can be verified locally in the current workspace

## 10. Scope Boundary

Implemented now:

- FastAPI runtime
- SQLite truth store
- event consumer
- task driver
- frozen package support
- four coordinator roles on the agent-backed path
- OpenClaw plugin/tool/service integration
- bootstrap/verify automation

Not implemented yet:

- cross-project global memory as a first-class layer
- PostgreSQL-based shared memory/index plane
- multi-worker scheduling and retry/dead-letter policy
- full observability surfaces for event/task traces

PostgreSQL is therefore still an optional future extension for cross-project memory. It is not required for the current local truth store or runtime chain.
