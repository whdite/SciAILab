# Research Agent Tech Stack Decision

This document records the current stack choices for SciAILab research execution and the rationale behind them.

## 1. Finalized Current Stack

### 1.1 Agent Host

- OpenClaw
- TypeScript plugin: `openclaw/extensions/research-core`

Why:

- OpenClaw already provides plugin registration, agent tools, gateway methods, service lifecycle, and subagent execution
- SciAILab needs to attach research workflow capabilities to that runtime instead of building another host from scratch

### 1.2 Workflow Runtime

- Python
- FastAPI

Why:

- the runtime needs a clean process boundary and a stable API surface for projects, tasks, events, messages, packages, and state
- FastAPI makes local testing and verification straightforward

Decision:

- FastAPI is the primary runtime transport
- stdio remains supported only as fallback compatibility

### 1.3 Truth Store

- SQLite

Why:

- current scope is a local-first, single-workspace system
- SQLite is enough for the present control-plane truth and is already validated end to end

Non-decision:

- PostgreSQL is not required yet
- if cross-project memory, shared indexing, or concurrent workers become important, PostgreSQL can be added as an extension layer later

### 1.4 Workspace Persistence

- filesystem workspace under `workspace/projects/`

Why:

- artifacts and frozen packages should stay directly inspectable
- local replay and debugging are simpler when files are visible on disk

### 1.5 Coordinator Execution

- OpenClaw subagent execution
- role skills for explorer, experiment, writer, reviewer

Why:

- the current goal is to prove and use the real agent path, not just a coordinator stub
- role-specialized skills keep prompting and output format constraints isolated per coordinator type

Decision:

- default coordinator execution mode is `agent`
- python/template fallback is secondary

## 2. Current Interfaces

### 2.1 Gateway Layer

Current `research-core` gateway surface:

- project create/status
- artifact list
- message send/list
- event emit/list/consume
- package freeze/list
- task create/list/update_status
- agent state list
- coordinator run

### 2.2 Tool Layer

Current tools:

- `research_project`
- `research_artifact`
- `research_message`
- `research_event`
- `research_freeze`
- `research_task`
- `research_state`
- `research_coordinator`

### 2.3 Runtime API Layer

Current FastAPI endpoints cover:

- health
- project CRUD subset
- artifact registration/list
- message create/list
- event emit/list/consume
- package freeze/list
- task create/list/claim/update status
- artifact state transition
- agent state list/update
- coordinator run

## 3. Orchestration Model

Chosen model:

- event-driven downstream workflow

How it works now:

- coordinators finish a task
- completion goes through `research_task.update_status(..., eventType=...)`
- FastAPI emits the event
- the event consumer creates downstream tasks/messages/state changes

Why this model won:

- downstream orchestration remains centralized
- event rules are easier to test than coordinator-specific branching scattered across the stack
- OpenClaw stays focused on agent execution rather than workflow persistence

## 4. Package Strategy

Chosen model:

- frozen package boundaries before writing and review handoff

Why:

- stable writing inputs
- reproducible runs
- cleaner artifact provenance

Current concrete package types observed in verification:

- `research_package`
- `experiment_bundle`
- `writing_input_package`

## 5. Local Developer Experience Stack

Current supporting tools:

- `uvicorn`
- `tsx`
- PowerShell bootstrap script
- local compatibility scripts for the OpenClaw workspace

Current one-shot entry:

- `scripts/bootstrap_verify_research_core.ps1`

Why:

- the workspace still has dependency/export drift
- repeatable bootstrap and verify steps are required so the stack can be run locally without manual repair every time

## 6. Deferred Choices

These are intentionally not committed as present stack requirements:

- PostgreSQL as the main truth store
- pgvector or a global memory index
- distributed workers
- full observability stack
- dead-letter and retry infrastructure

These should only be introduced after the current event-driven local chain becomes insufficient.

## 7. Decision Summary

The current stack decision is:

- OpenClaw for host, plugin runtime, tools, and subagents
- TypeScript for `research-core`
- Python + FastAPI for workflow runtime
- SQLite for current truth storage
- filesystem workspace for artifact and package persistence
- event-driven downstream orchestration
- agent-backed coordinators as the default execution path

This stack is already integrated and locally verified in the current workspace, so future changes should build on it rather than resetting the foundation.
