<#
.SYNOPSIS
  Install / configure / start AutoLogistics OS as a full Docker stack.
.DESCRIPTION
  Ensures .env, stops conflicting local processes, brings up docker compose
  (api, orchestrator, workers, web, voice, postgres, redis, minio), waits for
  health, applies SQL migrations from the host.
.EXAMPLE
  .\scripts\install-docker.ps1
  .\scripts\install-docker.ps1 -Rebuild -NoCache
  .\scripts\install-docker.ps1 -WithObservability
  .\scripts\install-docker.ps1 -SetupOnly
#>
param(
  [switch]$WithObservability,
  [switch]$Rebuild,
  [switch]$NoCache,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Test-DockerEngine {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  docker info 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Read-DotEnvMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $i = $line.IndexOf('=')
    $k = $line.Substring(0, $i).Trim()
    if (-not $k) { continue }
    $v = $line.Substring($i + 1)
    if ($v -notmatch '^\s*["'']' -and $v -match '\s+#') {
      $hash = $v.IndexOf(' #')
      if ($hash -lt 0) { $hash = $v.IndexOf("`t#") }
      if ($hash -ge 0) { $v = $v.Substring(0, $hash) }
    }
    $map[$k] = $v.Trim().Trim('"').Trim("'")
  }
  return $map
}

function Wait-HttpOk([string]$Url, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

Write-Host "==> AutoLogistics OS — Docker install" -ForegroundColor Cyan

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example — edit secrets if needed." -ForegroundColor Yellow
}

if (-not (Test-DockerEngine)) {
  Write-Host "Docker engine is not running." -ForegroundColor Red
  Write-Host "  1) Install/start Docker Desktop"
  Write-Host "  2) Or run install.bat once (installs Docker via winget)"
  Write-Host "  3) Reboot if Docker was just installed, then retry install-docker.bat"
  exit 1
}

# Free host ports used by compose (3000/8000/8080/3010/5432…)
Write-Host "==> Stopping local (non-Docker) processes if any" -ForegroundColor Cyan
try {
  & (Join-Path $PSScriptRoot "stop.ps1") | Out-Null
} catch {
  Write-Warning "stop.ps1: $_"
}

# Host tooling for migrate / license (optional but useful)
$needSetup = -not (Test-Path "node_modules") -or -not (Test-Path "packages\shared\dist")
if ($needSetup -or $SetupOnly) {
  Write-Host "==> Host deps (pnpm / shared) for migrate & license" -ForegroundColor Cyan
  $setupArgs = @("-SkipDocker")
  if ($WithObservability) { $setupArgs += "-WithObservability" }
  & (Join-Path $PSScriptRoot "setup.ps1") @setupArgs
}

if ($SetupOnly) {
  Write-Host "Setup-only done. Start stack with: install-docker.bat" -ForegroundColor Green
  exit 0
}

$envMap = Read-DotEnvMap (Join-Path $Root ".env")
$pgPort = if ($envMap.ContainsKey("POSTGRES_PORT") -and $envMap["POSTGRES_PORT"]) {
  $envMap["POSTGRES_PORT"]
} else { "5432" }

Write-Host "==> License check" -ForegroundColor Cyan
try {
  $env:ALO_ROOT = $Root
  pnpm --filter @alo/shared build | Out-Null
  node (Join-Path $PSScriptRoot "check-license.mjs")
} catch {
  Write-Warning "License check skipped/failed: $_"
}

$composeArgs = @("--env-file", ".env")
if ($WithObservability) { $composeArgs += @("--profile", "observability") }

if ($Rebuild) {
  Write-Host "==> Rebuild images" -ForegroundColor Cyan
  $build = @("--env-file", ".env", "build")
  if ($NoCache) { $build += "--no-cache" }
  if ($WithObservability) {
    docker compose --env-file .env --profile observability @build
  } else {
    docker compose @build
  }
  docker compose @composeArgs down
  docker compose @composeArgs up -d --force-recreate --build
} else {
  Write-Host "==> Docker compose up --build" -ForegroundColor Cyan
  docker compose @composeArgs up -d --build
}

Write-Host "==> Waiting for health..." -ForegroundColor Cyan
$apiOk = Wait-HttpOk "http://localhost:3000/health" 120
$orchOk = Wait-HttpOk "http://localhost:8000/health" 90
$webOk = Wait-HttpOk "http://localhost:8080" 60

Write-Host ("  API:           {0}" -f $(if ($apiOk) { "OK" } else { "WAIT/FAIL" }))
Write-Host ("  Orchestrator:  {0}" -f $(if ($orchOk) { "OK" } else { "WAIT/FAIL" }))
Write-Host ("  Cabinet:       {0}" -f $(if ($webOk) { "OK" } else { "WAIT/FAIL" }))

Write-Host "==> DB migrate (host → localhost:$pgPort)" -ForegroundColor Cyan
$migrateUrl = "postgresql://alo:alo@localhost:$pgPort/autologistics"
$env:DATABASE_URL = $migrateUrl
try {
  pnpm db:migrate
} catch {
  Write-Warning "db:migrate failed: $_. Try: `$env:DATABASE_URL='$migrateUrl'; pnpm db:migrate"
}

$seedFlag = "true"
if ($envMap.ContainsKey("SEED_SUPPLIERS_ON_BOOT")) {
  $seedFlag = [string]$envMap["SEED_SUPPLIERS_ON_BOOT"]
}
if ($seedFlag.ToLower() -in @("0", "false", "no", "off")) {
  Write-Host "==> seed:suppliers (boot-seed off)" -ForegroundColor Cyan
  try { pnpm seed:suppliers } catch { Write-Warning "seed failed: $_" }
} else {
  Write-Host "  Suppliers seed runs inside orchestrator when SEED_SUPPLIERS_ON_BOOT=true"
}

Write-Host ""
Write-Host "Docker stack is up." -ForegroundColor Green
docker compose --env-file .env ps
Write-Host ""
Write-Host "  API:           http://localhost:3000/health"
Write-Host "  Orchestrator:  http://localhost:8000/health"
Write-Host "  Cabinet:       http://localhost:8080"
Write-Host "  Voice:         http://localhost:3010/health"
Write-Host "  MinIO:         http://localhost:9001  (minioadmin / minioadmin)"
Write-Host "  TG gateway:    run locally — .\scripts\start.ps1 -WithGateway"
Write-Host "  Rebuild:       docker-rebuild.bat"
Write-Host "  Stop:          stop.bat /docker"
