<#
.SYNOPSIS
  Full install: Node (pnpm), Python venv, Docker infra images pull, shared build.
.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -WithObservability
#>
param(
  [switch]$WithObservability,
  [switch]$SkipDocker
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> AutoLogistics OS setup ($Root)" -ForegroundColor Cyan

function Ensure-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

Ensure-Command node
Ensure-Command python
$nodeVer = (node -v)
Write-Host "Node: $nodeVer"
if (-not $nodeVer.StartsWith("v2")) {
  Write-Warning "Node 20+ recommended (found $nodeVer)"
}

# --- .env ---
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example — fill secrets before production." -ForegroundColor Yellow
} else {
  Write-Host ".env already exists"
}

# --- Node / pnpm ---
Write-Host "==> Enabling corepack + pnpm" -ForegroundColor Cyan
corepack enable 2>$null
corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm --filter @alo/shared build

# --- Logs tree ---
$logRoot = Join-Path $Root "logs"
foreach ($s in @("api","gateway","workers","orchestrator","bootstrap","audit")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $logRoot $s) | Out-Null
}
Write-Host "Logs directory ready: $logRoot"

# --- Python ---
Write-Host "==> Python venv + services" -ForegroundColor Cyan
$venv = Join-Path $Root "services\.venv"
if (-not (Test-Path $venv)) {
  python -m venv $venv
}
& "$venv\Scripts\python.exe" -m pip install --upgrade pip
& "$venv\Scripts\pip.exe" install -e ".\services[dev]"

# --- Docker ---
if (-not $SkipDocker) {
  Ensure-Command docker
  Write-Host "==> Docker pull / build infra" -ForegroundColor Cyan
  $profiles = @()
  if ($WithObservability) { $profiles = @("--profile", "observability") }
  docker compose -f infra/docker-compose.yml @profiles pull
  docker compose -f infra/docker-compose.yml @profiles up -d
  Write-Host "Waiting for Postgres..." -ForegroundColor Cyan
  Start-Sleep -Seconds 5
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    docker compose -f infra/docker-compose.yml exec -T postgres pg_isready -U alo -d autologistics 2>$null
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) { Write-Warning "Postgres health check timed out — check Docker Desktop" }
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Next:  .\scripts\start.ps1"
Write-Host "Docker full stack rebuild:  .\scripts\docker-rebuild.ps1"
Write-Host "Stop:  .\scripts\stop.ps1"
