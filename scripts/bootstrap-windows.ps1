<#
.SYNOPSIS
  Install system deps (Node, Python, Git, Docker) via winget, then setup + start AutoLogistics OS.
.EXAMPLE
  .\scripts\bootstrap-windows.ps1
  .\scripts\bootstrap-windows.ps1 -WithGateway -WithVoiceGateway
  .\scripts\bootstrap-windows.ps1 -SetupOnly
#>
param(
  [switch]$WithGateway,
  [switch]$WithVoiceGateway,
  [switch]$WithObservability,
  [switch]$SetupOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> AutoLogistics OS Windows bootstrap ($Root)" -ForegroundColor Cyan

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Refresh-EnvPath {
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
  $extras = @(
    "$env:ProgramFiles\nodejs",
    "$env:LOCALAPPDATA\Programs\nodejs",
    "$env:APPDATA\npm",
    "$env:LOCALAPPDATA\Programs\Python\Python312",
    "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
    "$env:LOCALAPPDATA\Programs\Python\Python311",
    "$env:LOCALAPPDATA\Programs\Python\Python311\Scripts",
    "$env:LOCALAPPDATA\Programs\Python\Launcher",
    "$env:ProgramFiles\Git\cmd",
    "$env:ProgramFiles\Docker\Docker\resources\bin"
  )
  foreach ($p in $extras) {
    if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
      $env:Path = "$p;$env:Path"
    }
  }
}

function Test-Cmd($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-WingetOk([int]$code) {
  # 0 = success; -1978335189 / -1978335135 = already installed / no applicable update
  return ($code -eq 0 -or $code -eq -1978335189 -or $code -eq -1978335135)
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Scope = "user",
    [switch]$AllowFail
  )
  Write-Host "==> winget install $Id" -ForegroundColor Cyan
  $common = @(
    "install", "-e", "--id", $Id,
    "--accept-package-agreements",
    "--accept-source-agreements"
  )

  $code = 1
  if ($Scope) {
    & winget @common --scope $Scope
    $code = $LASTEXITCODE
    if (Test-WingetOk $code) { Refresh-EnvPath; return $true }
    Write-Host "Retrying $Id without --scope $Scope ..." -ForegroundColor Yellow
  }

  & winget @common
  $code = $LASTEXITCODE
  if (Test-WingetOk $code) { Refresh-EnvPath; return $true }

  $msg = "winget install $Id failed (exit $code)."
  if ($AllowFail) {
    Write-Warning $msg
    return $false
  }
  throw "$msg Run install.bat as Administrator, or install the package manually."
}

function Test-RealPython {
  Refresh-EnvPath
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notmatch "WindowsApps") {
    & python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  if (Test-Cmd "py") {
    & py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}

function Get-DotEnvValue([string]$key) {
  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path $envFile)) { return $null }
  foreach ($line in Get-Content -Path $envFile -Encoding UTF8) {
    $trim = $line.Trim()
    if ($trim -eq "" -or $trim.StartsWith("#")) { continue }
    $eq = $trim.IndexOf("=")
    if ($eq -lt 1) { continue }
    $k = $trim.Substring(0, $eq).Trim()
    if ($k -ne $key) { continue }
    $val = $trim.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($val -ne "") { return $val }
  }
  return $null
}

function Test-DockerEngine {
  Refresh-EnvPath
  if (-not (Test-Cmd "docker")) { return $false }
  try {
    docker info 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Wait-DockerEngine {
  param([int]$TimeoutSec = 180)
  Write-Host "==> Waiting for Docker engine (up to $TimeoutSec sec)..." -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerEngine) {
      Write-Host "Docker engine is ready."
      return $true
    }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Start-DockerDesktop {
  $candidates = @(
    "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
    "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe"
  )
  foreach ($exe in $candidates) {
    if (Test-Path $exe) {
      if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
        Write-Host "Starting Docker Desktop..."
        Start-Process -FilePath $exe | Out-Null
      }
      return $true
    }
  }
  return $false
}

function Wait-HttpOk([string]$url, [int]$timeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      # 2xx/3xx — health, Vite SPA, MinIO console
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# --- winget ---
Refresh-EnvPath
if (-not (Test-Cmd "winget")) {
  Write-Host ""
  Write-Host "winget is not installed." -ForegroundColor Red
  Write-Host "Install App Installer, then run install.bat again:"
  Write-Host "  https://aka.ms/getwinget"
  exit 1
}

# --- Node.js LTS (>=20) ---
if (-not (Test-Cmd "node")) {
  Install-WingetPackage -Id "OpenJS.NodeJS.LTS"
  Refresh-EnvPath
}
if (-not (Test-Cmd "node")) {
  throw "node not found after install. Close this window, open a new one, and run install.bat again."
}
$nodeVer = node -v
Write-Host "Node: $nodeVer"
if (-not $nodeVer.StartsWith("v2")) {
  Write-Warning "Node 20+ recommended (found $nodeVer)"
}

# --- Python 3.11+ ---
if (-not (Test-RealPython)) {
  Install-WingetPackage -Id "Python.Python.3.12"
  Refresh-EnvPath
}
if (-not (Test-RealPython)) {
  throw "Python 3.11+ not found after install (Microsoft Store stub does not count). Re-run install.bat after a new terminal, or install from https://www.python.org/downloads/"
}
Write-Host "Python: OK (3.11+)"

# --- Git (optional-ish) ---
if (-not (Test-Cmd "git")) {
  Install-WingetPackage -Id "Git.Git" -AllowFail | Out-Null
  Refresh-EnvPath
}

# --- VC++ redistributable (native Node addons) ---
if (-not (Test-Path "$env:SystemRoot\System32\vcruntime140.dll")) {
  Install-WingetPackage -Id "Microsoft.VCRedist.2015+.x64" -Scope "" -AllowFail | Out-Null
}

# --- Docker Desktop ---
Refresh-EnvPath
$dockerOk = Test-DockerEngine

if (-not $dockerOk) {
  if (-not (Test-Cmd "docker") -and -not (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe")) {
    Write-Host "==> Docker Desktop is missing" -ForegroundColor Cyan
    if (-not (Test-IsAdmin)) {
      Write-Host "Requesting Administrator rights to install Docker Desktop..." -ForegroundColor Yellow
      $wingetCmd = 'winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements; exit $LASTEXITCODE'
      try {
        $p = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList @(
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $wingetCmd
        )
        if ($p.ExitCode -ne 0 -and -not (Test-WingetOk $p.ExitCode)) {
          Write-Warning "Elevated Docker install exited with $($p.ExitCode). Trying current session..."
          Install-WingetPackage -Id "Docker.DockerDesktop" -Scope "" -AllowFail | Out-Null
        }
      } catch {
        Write-Warning "Administrator prompt was cancelled. Trying Docker install in the current session..."
        Install-WingetPackage -Id "Docker.DockerDesktop" -Scope "" -AllowFail | Out-Null
      }
    } else {
      Install-WingetPackage -Id "Docker.DockerDesktop" -Scope ""
    }
    Refresh-EnvPath
  }

  if (-not (Start-DockerDesktop)) {
    Write-Host ""
    Write-Host "Docker Desktop is not installed or not found." -ForegroundColor Red
    Write-Host "Install it, reboot Windows if prompted, then run install.bat again."
    Write-Host "  https://www.docker.com/products/docker-desktop/"
    exit 1
  }

  if (-not (Wait-DockerEngine -TimeoutSec 180)) {
    Write-Host ""
    Write-Host "Docker engine did not become ready in time." -ForegroundColor Red
    Write-Host "A reboot is often required after the first Docker Desktop install (WSL2)."
    Write-Host "Reboot Windows, start Docker Desktop, then run install.bat again."
    Write-Host ""
    Write-Host "Secrets (OpenAI / Telegram / mail / SIP) are not auto-filled - edit .env after setup."
    exit 1
  }
}

Write-Host ""
Write-Host "System dependencies are ready." -ForegroundColor Green
Write-Host "Note: API keys (OpenAI, Telegram, mail, SIP) must be set manually in .env."
Write-Host "      First-time Docker Desktop install may require a Windows reboot."
Write-Host ""

# --- project setup ---
& (Join-Path $PSScriptRoot "setup.ps1") -WithObservability:$WithObservability

if ($SetupOnly) {
  Write-Host ""
  Write-Host "Setup-only complete. Start later with install.bat or .\scripts\start.ps1" -ForegroundColor Green
  exit 0
}

# --- auto-detect optional gateways from .env ---
$useGateway = [bool]$WithGateway
$useVoice = [bool]$WithVoiceGateway
if (-not $useGateway) {
  $tg = Get-DotEnvValue "TG_STRING_SESSION"
  if ($tg) {
    $useGateway = $true
    Write-Host "Detected TG_STRING_SESSION - starting Telegram gateway." -ForegroundColor Yellow
  }
}
if (-not $useVoice) {
  $sip = Get-DotEnvValue "SIP_PUBLIC_HOST"
  if ($sip) {
    $useVoice = $true
    Write-Host "Detected SIP_PUBLIC_HOST - starting voice gateway." -ForegroundColor Yellow
  }
}

& (Join-Path $PSScriptRoot "start.ps1") -WithGateway:$useGateway -WithVoiceGateway:$useVoice

Write-Host ""
Write-Host "==> Waiting for health endpoints..." -ForegroundColor Cyan
$apiOk = Wait-HttpOk "http://localhost:3000/health" 90
$orchOk = Wait-HttpOk "http://localhost:8000/health" 90
$webOk = Wait-HttpOk "http://localhost:5173" 90
$minioOk = Wait-HttpOk "http://localhost:9001" 60

if ($apiOk) {
  Write-Host "API health:          OK  http://localhost:3000/health" -ForegroundColor Green
} else {
  Write-Warning "API did not respond on http://localhost:3000/health - see logs\api and logs\bootstrap"
}
if ($orchOk) {
  Write-Host "Orchestrator health: OK  http://localhost:8000/health" -ForegroundColor Green
} else {
  Write-Warning "Orchestrator did not respond on http://localhost:8000/health - see logs\orchestrator"
}
if ($webOk) {
  Write-Host "Cabinet (web):       OK  http://localhost:5173" -ForegroundColor Green
} else {
  Write-Warning "Web UI did not respond on http://localhost:5173 - see logs\bootstrap\web.out.log"
}
if ($minioOk) {
  Write-Host "MinIO console:       OK  http://localhost:9001" -ForegroundColor Green
} else {
  Write-Warning "MinIO console did not respond on http://localhost:9001 - check: docker compose -f infra/docker-compose.yml ps"
}

# Open primary UIs in the default browser
if ($webOk) {
  Start-Process "http://localhost:5173" | Out-Null
}
if ($minioOk) {
  Start-Process "http://localhost:9001" | Out-Null
}

Write-Host ""
Write-Host "Stop:  stop.bat   or   .\scripts\stop.ps1" -ForegroundColor Green
