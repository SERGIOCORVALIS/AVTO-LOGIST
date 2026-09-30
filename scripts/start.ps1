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
  throw "License check failed. Set LICENSE_KEY in .env or data\.alo_license"
}

$env:LOG_DIR = Join-Path $Root "logs"
foreach ($s in @("api","gateway","workers","orchestrator","voice","bootstrap","audit")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $env:LOG_DIR $s) | Out-Null
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env - edit secrets if needed." -ForegroundColor Yellow
}

# Optional Doppler/.env into session
if (Test-Path "$PSScriptRoot\load-secrets.ps1") {
  & "$PSScriptRoot\load-secrets.ps1" | Out-Null
}

if ($DockerStack) {
  Write-Host "==> License check" -ForegroundColor Cyan
  pnpm --filter @alo/shared build | Out-Null
  Invoke-AloLicenseCheck -Service "bootstrap"
  Write-Host "==> Starting full Docker stack" -ForegroundColor Cyan
  docker compose --env-file .env up -d --build
  Write-Host "API http://localhost:3000  Cabinet http://localhost:8080  Orchestrator http://localhost:8000"
  Write-Host "Gateway: .\scripts\start.ps1 -WithGateway"
  exit 0
}

Write-Host "==> Ensuring infra (postgres/redis/minio)" -ForegroundColor Cyan
docker compose --env-file .env -f infra/docker-compose.yml up -d

$venvPy = Join-Path $Root "services\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Write-Host "venv missing - running setup..." -ForegroundColor Yellow
  & "$PSScriptRoot\setup.ps1" -SkipDocker
}

$boot = Join-Path $env:LOG_DIR "bootstrap"
New-Item -ItemType Directory -Force -Path $boot | Out-Null

function Read-DotEnvMap([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path -Encoding UTF8) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $i = $line.IndexOf('=')
    $k = $line.Substring(0, $i).Trim()
    if (-not $k) { continue }
    $v = $line.Substring($i + 1)
    # strip unquoted trailing comments
    if ($v -notmatch '^\s*["'']' -and $v -match '\s+#') {
      $hash = $v.IndexOf(' #')
      if ($hash -lt 0) { $hash = $v.IndexOf("`t#") }
      if ($hash -ge 0) { $v = $v.Substring(0, $hash) }
    }
    $v = $v.Trim().Trim('"').Trim("'")
    $map[$k] = $v
  }
  return $map
}

function Read-DotEnvValue([string]$Key) {
  $file = Join-Path $Root ".env"
  $map = Read-DotEnvMap $file
  if ($map.ContainsKey($Key)) { return [string]$map[$Key] }
  return ""
}

function Start-Bg($name, $workdir, $command) {
  $out = Join-Path $boot "$name.out.log"
  $err = Join-Path $boot "$name.err.log"
  Write-Host "Starting $name ..." -ForegroundColor Cyan
  # Inject ENTIRE .env into child so every key is available (not only DATABASE/REDIS).
  $envMap = Read-DotEnvMap (Join-Path $Root ".env")
  $envAssign = New-Object System.Collections.Generic.List[string]
  $envAssign.Add("`$env:LOG_DIR='$($env:LOG_DIR)'")
  $envAssign.Add("`$env:ALO_ROOT='$Root'")
  $envAssign.Add("`$env:ALO_LICENSE_ALLOW_PROMPT='0'")
  foreach ($k in $envMap.Keys) {
    if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
    $raw = [string]$envMap[$k]
    $esc = $raw.Replace("'", "''")
    $envAssign.Add("`$env:$k='$esc'")
  }
  $prefix = ($envAssign -join "; ")
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-Command",
    "$prefix; Set-Location '$workdir'; $command *>> '$out' 2>> '$err'"
  ) -PassThru -WindowStyle Hidden
  Set-Content -Path (Join-Path $boot "$name.pid") -Value $p.Id
  Write-Host "  pid=$($p.Id)  stdout=$out"
}

pnpm --filter @alo/shared build | Out-Null

Write-Host "==> DB migrate + supplier seed" -ForegroundColor Cyan
$rootEnv = Read-DotEnvMap (Join-Path $Root ".env")
try {
  pnpm db:migrate
  if ($LASTEXITCODE -ne 0) { Write-Warning "db:migrate failed (check DATABASE_URL)" }
} catch {
  Write-Warning "db:migrate error: $_"
}
$seedOnBoot = "true"
if ($rootEnv.ContainsKey("SEED_SUPPLIERS_ON_BOOT")) {
  $seedOnBoot = [string]$rootEnv["SEED_SUPPLIERS_ON_BOOT"]
}
if ($seedOnBoot.ToLower() -in @("0", "false", "no", "off")) {
  Write-Host "  seed:suppliers (boot-seed off)..."
  try {
    pnpm seed:suppliers
  } catch {
    Write-Warning "seed:suppliers error: $_"
  }
} else {
  Write-Host "  seed on orchestrator boot (SEED_SUPPLIERS_ON_BOOT=$seedOnBoot)"
}

Write-Host "==> License check (trial 12 months, then LICENSE_KEY)" -ForegroundColor Cyan
Invoke-AloLicenseCheck -Service "bootstrap"

$ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
Add-Content -Path (Join-Path $boot "current.log") -Value "{`"ts`":`"$ts`",`"msg`":`"start`",`"gateway`":$([bool]$WithGateway),`"voice`":$([bool]$WithVoiceGateway)}"

Start-Bg "orchestrator" (Join-Path $Root "services") `
  "& '.\.venv\Scripts\python.exe' -m uvicorn 'orchestrator.app:app' --host 0.0.0.0 --port 8000"
Start-Sleep -Seconds 2
Start-Bg "api" $Root "pnpm --filter @alo/api dev"
Start-Bg "workers" $Root "pnpm --filter @alo/workers-ts dev"
Start-Bg "web" $Root "pnpm --filter @alo/web dev"
if ($WithGateway) {
  Start-Bg "gateway" $Root "pnpm --filter @alo/tg-gateway dev"
}
if ($WithVoiceGateway) {
  Start-Bg "voice" $Root "pnpm --filter @alo/voice-gateway dev"
}

Write-Host ""
Write-Host "Started." -ForegroundColor Green
Write-Host "  API:           http://localhost:3000/health"
Write-Host "  Cabinet:       http://localhost:5173"
Write-Host "  MinIO console: http://localhost:9001  (minioadmin / minioadmin)"
Write-Host "  Orchestrator:  http://localhost:8000/health"
Write-Host "  Frontend:      http://localhost:5173"
if ($WithVoiceGateway) {
  Write-Host "  Voice:         http://localhost:3010/health"
}
Write-Host "  Logs:          $($env:LOG_DIR)"
Write-Host "  Tail audit:    Get-Content .\logs\audit\current.log -Wait -Tail 40"
Write-Host "  Stop:          .\scripts\stop.ps1"
Write-Host "  Commands docs: docs\COMMANDS.md"
