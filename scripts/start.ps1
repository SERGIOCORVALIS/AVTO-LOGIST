<#
.SYNOPSIS
  Start AutoLogistics locally: infra (if needed) + API + orchestrator + workers + optional gateway.
.EXAMPLE
  .\scripts\start.ps1
  .\scripts\start.ps1 -WithGateway
  .\scripts\start.ps1 -DockerStack
#>
param(
  [switch]$WithGateway,
  [switch]$WithVoiceGateway,
  [switch]$DockerStack,
  [switch]$Detached
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$env:LOG_DIR = Join-Path $Root "logs"
foreach ($s in @("api","gateway","workers","orchestrator","voice","bootstrap","audit")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $env:LOG_DIR $s) | Out-Null
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env — edit secrets if needed." -ForegroundColor Yellow
}

# Optional Doppler/.env into session
if (Test-Path "$PSScriptRoot\load-secrets.ps1") {
  & "$PSScriptRoot\load-secrets.ps1" | Out-Null
}

if ($DockerStack) {
  Write-Host "==> Starting full Docker stack" -ForegroundColor Cyan
  docker compose --env-file .env up -d --build
  Write-Host "API http://localhost:3000  Orchestrator http://localhost:8000"
  Write-Host "Gateway: .\scripts\start.ps1 -WithGateway"
  exit 0
}

Write-Host "==> Ensuring infra (postgres/redis/minio)" -ForegroundColor Cyan
docker compose -f infra/docker-compose.yml up -d

$venvPy = Join-Path $Root "services\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Write-Host "venv missing — running setup..." -ForegroundColor Yellow
  & "$PSScriptRoot\setup.ps1" -SkipDocker
}

$boot = Join-Path $env:LOG_DIR "bootstrap"
New-Item -ItemType Directory -Force -Path $boot | Out-Null

function Start-Bg($name, $workdir, $command) {
  $out = Join-Path $boot "$name.out.log"
  $err = Join-Path $boot "$name.err.log"
  Write-Host "Starting $name ..." -ForegroundColor Cyan
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-Command",
    "`$env:LOG_DIR='$($env:LOG_DIR)'; Set-Location '$workdir'; $command *>> '$out' 2>> '$err'"
  ) -PassThru -WindowStyle Hidden
  Set-Content -Path (Join-Path $boot "$name.pid") -Value $p.Id
  Write-Host "  pid=$($p.Id)  stdout=$out"
}

pnpm --filter @alo/shared build | Out-Null

$ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
Add-Content -Path (Join-Path $boot "current.log") -Value "{`"ts`":`"$ts`",`"msg`":`"start`",`"gateway`":$([bool]$WithGateway),`"voice`":$([bool]$WithVoiceGateway)}"

Start-Bg "orchestrator" (Join-Path $Root "services") `
  "& '.\.venv\Scripts\uvicorn.exe' orchestrator.app:app --host 0.0.0.0 --port 8000 --reload"
Start-Sleep -Seconds 2
Start-Bg "api" $Root "pnpm --filter @alo/api dev"
Start-Bg "workers" $Root "pnpm --filter @alo/workers-ts dev"
if ($WithGateway) {
  Start-Bg "gateway" $Root "pnpm --filter @alo/tg-gateway dev"
}
if ($WithVoiceGateway) {
  Start-Bg "voice" $Root "pnpm --filter @alo/voice-gateway dev"
}

Write-Host ""
Write-Host "Started." -ForegroundColor Green
Write-Host "  API:           http://localhost:3000/health"
Write-Host "  Orchestrator:  http://localhost:8000/health"
if ($WithVoiceGateway) {
  Write-Host "  Voice:         http://localhost:3010/health"
}
Write-Host "  Logs:          $($env:LOG_DIR)"
Write-Host "  Tail audit:    Get-Content .\logs\audit\current.log -Wait -Tail 40"
Write-Host "  Stop:          .\scripts\stop.ps1"
Write-Host "  Commands docs: docs\COMMANDS.md"
