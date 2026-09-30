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

function Get-PythonCommand {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notmatch "WindowsApps") {
    & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return , @("python") }
  }
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return , @("py", "-3") }
  }
  throw "Required command not found: python 3.11+ (Microsoft Store stub is not valid; use py -3 or python.org)"
}

function Test-AloTrialActive {
  $stamp = Join-Path $Root "data\.alo_install.json"
  if (-not (Test-Path -LiteralPath $stamp)) { return $true }
  try {
    $j = Get-Content -LiteralPath $stamp -Raw -Encoding UTF8 | ConvertFrom-Json
    $start = [datetime]::Parse($j.installedAt, $null, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    return ((Get-Date).ToUniversalTime() -le $start.AddMonths(12))
  } catch {
    return $true
  }
}

function Invoke-AloLicenseCheck {
  param([string]$Service = "bootstrap")
  $env:ALO_ROOT = $Root
  $env:ALO_LICENSE_SERVICE = $Service
  $mjs = Join-Path $PSScriptRoot "check-license.mjs"
  $dist = Join-Path $Root "packages\shared\dist\license.js"
  $env:ALO_LICENSE_JS = $dist

  $code = 1
  if (Test-Path -LiteralPath $mjs) {
    & node $mjs
    $code = $LASTEXITCODE
  }
  if ($code -ne 0 -and (Test-Path -LiteralPath $dist)) {
    & node --eval "const m=require(process.env.ALO_LICENSE_JS); const fn=m.enforceLicense||(m.default&&m.default.enforceLicense); if(typeof fn!=='function'){process.exit(2)} fn({service:process.env.ALO_LICENSE_SERVICE||'bootstrap',allowPrompt:false}).then(function(){console.log('[license] OK')})"
    $code = $LASTEXITCODE
  }
  if ($code -eq 0) { return }
  if (Test-AloTrialActive) {
    Write-Host "License module unavailable; 12-month trial still active, continuing." -ForegroundColor DarkYellow
    return
  }
  throw "License check failed (exit $code). Set LICENSE_KEY in .env or data\.alo_license"
}

function Invoke-Python([string[]]$PyArgs) {
  # @() keeps a single command ("python") as a 1-element array; otherwise
  # PowerShell unwraps it to a string and [0] becomes the letter "p".
  $cmd = @($script:PythonCmd)
  if ($cmd.Count -gt 1) {
    & $cmd[0] $cmd[1] @PyArgs
  } else {
    & $cmd[0] @PyArgs
  }
}

Ensure-Command node
$script:PythonCmd = @(Get-PythonCommand)
$nodeVer = (node -v)
Write-Host "Node: $nodeVer"
if (-not $nodeVer.StartsWith("v2")) {
  Write-Warning "Node 20+ recommended (found $nodeVer)"
}
Write-Host "Python: $(Invoke-Python @('--version') 2>&1)"

# --- .env ---
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example - fill secrets before production." -ForegroundColor Yellow
} else {
  Write-Host ".env already exists"
}

# --- Node / pnpm ---
Write-Host "==> Enabling corepack + pnpm" -ForegroundColor Cyan
# corepack enable writes shims into Program Files\nodejs and fails without admin (EPERM).
& corepack enable 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "corepack enable skipped (no write access to Node.js folder). Using existing pnpm." -ForegroundColor DarkYellow
}
& corepack prepare pnpm@9.15.0 --activate 2>&1 | Out-Null
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm not found. Re-run install.bat as Administrator once, or: npm install -g pnpm@9.15.0"
}
pnpm install
pnpm --filter @alo/shared build

# --- License install stamp (trial starts here / on first launch) ---
$dataDir = Join-Path $Root "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$installStamp = Join-Path $dataDir ".alo_install.json"
if (-not (Test-Path $installStamp)) {
  $installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  @{
    installedAt = $installedAt
    product     = "AutoLogistics OS"
    copyright   = "Copyright (c) 2026 Pankov Sergey Vladimirovich"
  } | ConvertTo-Json | Set-Content -Path $installStamp -Encoding UTF8
  Write-Host "License trial started at ${installedAt} (12 months)." -ForegroundColor Yellow
} else {
  Write-Host "License install stamp already present: $installStamp"
}
Write-Host "==> License check" -ForegroundColor Cyan
Invoke-AloLicenseCheck -Service "bootstrap"

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
  Invoke-Python @("-m", "venv", $venv)
}
& "$venv\Scripts\python.exe" -m pip install --upgrade pip
& "$venv\Scripts\pip.exe" install -e ".\services[dev]"

# --- Docker ---
if (-not $SkipDocker) {
  Ensure-Command docker
  Write-Host "==> Docker pull / build infra" -ForegroundColor Cyan
  $profiles = @()
  if ($WithObservability) { $profiles = @("--profile", "observability") }
  docker compose --env-file .env -f infra/docker-compose.yml @profiles pull
  docker compose --env-file .env -f infra/docker-compose.yml @profiles up -d
  Write-Host "Waiting for Postgres..." -ForegroundColor Cyan
  Start-Sleep -Seconds 3
  $ok = $false
  # Windows PowerShell treats docker stderr as terminating errors when EAP=Stop;
  # pg_isready writes to stderr while Postgres is still starting / recovering.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    for ($i = 0; $i -lt 60; $i++) {
      $cid = (docker compose --env-file .env -f infra/docker-compose.yml ps -q postgres 2>$null | Select-Object -First 1)
      if ($cid) {
        $health = (docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $cid 2>$null)
        if ($health -eq "healthy") {
          $ok = $true
          break
        }
        if ($health -eq "running") {
          # No healthcheck configured — probe directly (stderr expected until ready)
          docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres pg_isready -U alo -d autologistics 1>$null 2>$null | Out-Null
          if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        }
      }
      Start-Sleep -Seconds 2
    }
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($ok) {
    Write-Host "Postgres is ready." -ForegroundColor Green
  } else {
    Write-Warning "Postgres health check timed out - check Docker Desktop (docker compose -f infra/docker-compose.yml logs postgres)"
  }
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Next:  .\scripts\start.ps1"
Write-Host "Docker full stack rebuild:  .\scripts\docker-rebuild.ps1"
Write-Host "Stop:  .\scripts\stop.ps1"
