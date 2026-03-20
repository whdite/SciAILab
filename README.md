# SciAILab

SciAILab is a research control-plane project built around a FastAPI runtime, SQLite truth store, and an OpenClaw-hosted `research-core` plugin.

## Repository Layout

- `docs/`: architecture, progress, and rule-matrix documents
- `python/`: FastAPI runtime, storage, orchestrator, and coordinator pipeline
- `scripts/`: bootstrap and verification scripts
- `openclaw/`: vendored OpenClaw workspace with SciAILab `research-core` integration

## Local Bootstrap

Run the end-to-end verification flow with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1
```

Use verify-only mode if dependencies are already prepared:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bootstrap_verify_research_core.ps1 -VerifyOnly
```
