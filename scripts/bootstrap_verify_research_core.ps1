param(
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$openclawRoot = Join-Path $repoRoot "openclaw"
$openclawNodeModules = Join-Path $openclawRoot "node_modules"
$openclawSelfLink = Join-Path $openclawNodeModules "openclaw"

$nodePackages = @(
  "@sinclair/typebox@0.34.48"
  "discord-api-types@^0.38.42"
  "@buape/carbon@0.0.0-beta-20260216184201"
  "@discordjs/voice@^0.19.2"
  "https-proxy-agent@^8.0.0"
  "opusscript@^0.1.1"
  "@larksuiteoapi/node-sdk@^1.59.0"
  "@slack/bolt@^4.6.0"
  "@slack/web-api@^7.15.0"
  "@grammyjs/runner@^2.0.3"
  "@grammyjs/transformer-throttler@^1.2.1"
  "grammy@^1.41.1"
)

function Write-Step([string]$Label) {
  Write-Host ""
  Write-Host "==> $Label"
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-NativeStep(
  [string]$Label,
  [string]$FilePath,
  [string[]]$ArgumentList,
  [string]$WorkingDirectory = $repoRoot
) {
  Write-Step $Label
  Push-Location $WorkingDirectory
  try {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Resolve-TsxCommand() {
  $localTscx = Join-Path $openclawRoot "node_modules\.bin\tsx.cmd"
  if (Test-Path $localTscx) {
    return $localTscx
  }

  $globalTscx = Get-Command "tsx" -ErrorAction SilentlyContinue
  if ($globalTscx) {
    return $globalTscx.Source
  }

  return $null
}

function Ensure-TsxCommand() {
  $tsx = Resolve-TsxCommand
  if ($tsx) {
    return $tsx
  }

  Invoke-NativeStep `
    -Label "Install global tsx/typescript" `
    -FilePath "npm" `
    -ArgumentList @("install", "-g", "tsx", "typescript") `
    -WorkingDirectory $repoRoot

  $tsx = Resolve-TsxCommand
  if (-not $tsx) {
    throw "tsx is still unavailable after installation"
  }
  return $tsx
}

function Ensure-OpenClawSelfLink() {
  if (-not (Test-Path $openclawNodeModules)) {
    New-Item -ItemType Directory -Path $openclawNodeModules | Out-Null
  }

  if (Test-Path $openclawSelfLink) {
    return
  }

  Write-Step "Create openclaw self-reference junction"
  New-Item -ItemType Junction -Path $openclawSelfLink -Target $openclawRoot | Out-Null
}

Assert-Command "python"
Assert-Command "node"
Assert-Command "npm"

if (-not $VerifyOnly) {
  Invoke-NativeStep `
    -Label "Install Python runtime (editable)" `
    -FilePath "python" `
    -ArgumentList @("-m", "pip", "install", "-e", "python") `
    -WorkingDirectory $repoRoot

  Invoke-NativeStep `
    -Label "Install OpenClaw runtime dependencies" `
    -FilePath "npm" `
    -ArgumentList (@("install", "--prefix", $openclawRoot, "--no-save") + $nodePackages) `
    -WorkingDirectory $repoRoot
}

$tsxCommand = Ensure-TsxCommand
Ensure-OpenClawSelfLink

Invoke-NativeStep `
  -Label "Bridge missing plugin-sdk dist exports to current source" `
  -FilePath "node" `
  -ArgumentList @("scripts/ensure-plugin-sdk-runtime-shims.mjs", "--force") `
  -WorkingDirectory $openclawRoot

Invoke-NativeStep `
  -Label "Patch pi-ai compatibility exports" `
  -FilePath "node" `
  -ArgumentList @("scripts/ensure-pi-ai-compat.mjs") `
  -WorkingDirectory $openclawRoot

Invoke-NativeStep `
  -Label "Verify FastAPI runtime" `
  -FilePath "python" `
  -ArgumentList @("scripts/verify_fastapi_runtime.py") `
  -WorkingDirectory $repoRoot

Invoke-NativeStep `
  -Label "Verify Python coordinator pipeline" `
  -FilePath "python" `
  -ArgumentList @("scripts/verify_coordinator_pipeline.py") `
  -WorkingDirectory $repoRoot

Invoke-NativeStep `
  -Label "Verify OpenClaw agent-backed coordinator path" `
  -FilePath $tsxCommand `
  -ArgumentList @("scripts/verify_openclaw_agent_coordinator.mjs") `
  -WorkingDirectory $repoRoot

Invoke-NativeStep `
  -Label "Verify OpenClaw coordinator worker-pool service" `
  -FilePath $tsxCommand `
  -ArgumentList @("scripts/verify_openclaw_coordinator_service_pool.mjs") `
  -WorkingDirectory $repoRoot

Invoke-NativeStep `
  -Label "Verify research-core plugin import/registration" `
  -FilePath $tsxCommand `
  -ArgumentList @("--tsconfig", "tsconfig.runtime-imports.json", "..\scripts\verify_openclaw_plugin_import.mjs") `
  -WorkingDirectory $openclawRoot

Write-Host ""
Write-Host "Bootstrap/verify completed."
Write-Host "Mode: $(if ($VerifyOnly) { "verify-only" } else { "bootstrap+verify" })"
