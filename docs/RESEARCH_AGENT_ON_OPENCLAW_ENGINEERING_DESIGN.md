# Research Agent On OpenClaw Engineering Design

This document records the engineering design that SciAILab is actually using on top of OpenClaw today. It is written against the current implementation, not an earlier design-phase proposal.

## 1. Design Goal

The goal is to run a research control-plane where:

- OpenClaw owns plugin registration, tools, service lifecycle, and subagent execution
- Python owns event/task/state orchestration and persistence
- coordinator outputs are pushed into a durable event-driven downstream pipeline
- each project keeps inspectable workspace artifacts on disk

The design target is a locally runnable system first, then stronger scheduling, memory, and observability later.

## 2. Core Design Decisions

### 2.1 FastAPI-First Runtime

Decision:

- the current primary runtime transport is FastAPI
- stdio remains only as a compatibility and fallback path

Reason:

- tasks, events, packages, and state transitions are easier to expose, test, and verify through a stable HTTP surface
- OpenClaw and Python can evolve independently behind that contract

Current implementation:

- `python/research_runtime/api/app.py` exposes the runtime APIs
- `openclaw/extensions/research-core/src/gateway-methods.ts` calls those APIs

### 2.2 Agent-Backed Coordinators

Decision:

- explorer, experiment, writer, and reviewer all run through role-specific skill/subagent calls
- template outputs are no longer the default execution mode

Reason:

- the whole point of this architecture is to let OpenClaw own agent execution while Python owns workflow truth
- a template-first coordinator would only prove plumbing, not the real coordination path

Current implementation:

- `openclaw/extensions/research-core/src/coordinator-agent.ts`
- role skills under `openclaw/extensions/research-core/skills/`

### 2.3 Unified Task Completion Contract

Decision:

- coordinators do not manually create downstream work by hand
- they complete work through `research_task.update_status(..., eventType=...)`

Reason:

- downstream creation should stay centralized in the runtime
- event handling rules then remain inspectable, testable, and replaceable without changing every coordinator

Current implementation:

- `openclaw/extensions/research-core/src/tools/research-task-tool.ts`
- `python/research_runtime/orchestrator/task_driver.py`
- `python/research_runtime/orchestrator/event_consumer.py`

### 2.4 Frozen Package Boundary

Decision:

- writing inputs should be frozen before the writer consumes them

Reason:

- writers should work against a reproducible input package, not moving workspace state
- review and replay are much easier if each writing pass can be reconstructed from a package boundary

Current implementation:

- `research.package.freeze`
- `writing_input_package`

### 2.5 SQLite Now, PostgreSQL Later If Needed

Decision:

- keep SQLite as the current truth store
- do not introduce PostgreSQL until cross-project memory or concurrent workers become a real requirement

Reason:

- the current system is single-workspace, local-first, and already validated on SQLite
- PostgreSQL should be introduced only when it materially improves memory sharing, indexing, or concurrency

Current posture:

- SQLite is the active control-plane store
- PostgreSQL remains an optional future memory/index layer, not a replacement that is required now

## 3. Implemented System Shape

The current implemented shape is:

`OpenClaw research-core -> FastAPI runtime -> SQLite -> workspace/projects`

### OpenClaw side

Responsibilities:

- register `research-core`
- expose gateway methods and tools
- run the coordinator service
- claim tasks and launch subagents
- persist subagent results back to the runtime

### Python side

Responsibilities:

- persist control-plane truth
- consume events into downstream tasks/messages/state
- validate transitions
- expose runtime APIs for both direct verification and plugin access

### Workspace side

Responsibilities:

- hold artifact markdown
- hold frozen package files
- provide project-local inspection and replay surface

## 4. Execution Sequence

Current happy path:

1. A project is created in FastAPI.
2. Initial tasks and states are bootstrapped.
3. `research-core` claims a task for a coordinator role.
4. The matching role skill runs inside OpenClaw subagent execution.
5. The subagent returns structured JSON with `artifact_markdown` and optional `message` and `event_type`.
6. `research-core` writes the artifact file and registers metadata.
7. `research-core` freezes packages when needed.
8. `research-core` completes the task through `research_task.update_status(..., eventType=...)`.
9. FastAPI emits the event and immediately consumes it into downstream tasks/messages/state when auto-consume is enabled.

This sequence is already verified end to end.

## 5. Role Design

Current roles:

- `explorer`
- `experiment`
- `writer`
- `reviewer`

Current default event outputs:

- `explorer` -> `hypothesis_ready_for_experiment`
- `experiment` -> `experiment_results_ready`
- `writer` -> `review_requested`
- `reviewer` -> `review_requires_ablation` or `review_approved`

Reviewer is intentionally stricter than the other roles because its output controls whether the chain terminates or loops back into another experiment pass.

## 6. Current Engineering Constraints

### 6.1 OpenClaw Workspace Drift

The OpenClaw workspace still needs runtime compatibility helpers to make local plugin verification stable.

Current helpers:

- `openclaw/tsconfig.runtime-imports.json`
- `openclaw/scripts/ensure-plugin-sdk-runtime-shims.mjs`
- `openclaw/scripts/ensure-pi-ai-compat.mjs`
- local `openclaw` self-reference junction

These should be treated as local enablement shims, not architectural business logic.

### 6.2 Event Rules Are Still Expanding

The event-driven chain works, but the downstream rule table is still relatively small.

Current gap:

- retry, dead-letter, richer blocked/requeue logic, and finer-grained review branching are not fully specified yet

### 6.3 Global Memory Is Not Yet A Runtime Requirement

Cross-project memory has been discussed, but current implementation does not need a shared PostgreSQL layer to function correctly.

## 7. Verification Standard

The engineering design is considered active only because it is verified in the workspace.

Current verification scripts:

- `scripts/verify_fastapi_runtime.py`
- `scripts/verify_coordinator_pipeline.py`
- `scripts/verify_openclaw_agent_coordinator.mjs`
- `scripts/verify_openclaw_plugin_import.mjs`
- `scripts/bootstrap_verify_research_core.ps1`

The bootstrap script exists specifically to make the current workspace reproducible instead of depending on manual setup steps.

## 8. Near-Term Design Work

The next design work should stay on the current chain instead of reopening first-principles architecture debate.

Priority areas:

- formalize task claim/retry/requeue rules
- expand reviewer loop branching
- add clearer run/event/task traceability
- decide whether cross-project memory is needed based on actual retrieval and concurrency requirements

The current engineering direction is therefore stable:

- OpenClaw for agent execution
- FastAPI for workflow runtime
- SQLite for present truth
- frozen packages for reproducible writing inputs
- event-driven downstream owned by Python runtime
