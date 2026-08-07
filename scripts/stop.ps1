<#
.SYNOPSIS
  Stop locally started processes and optionally Docker stack.
#>
param(
  [switch]$DockerToo,
  [switch]$DockerOnly
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$boot = Join-Path $Root "logs\bootstrap"
$legacy = Join-Path $Root "data\logs"

if (-not $DockerOnly) {
  Write-Host "==> Stopping local processes" -ForegroundColor Cyan
  foreach ($dir in @($boot, $legacy)) {
    if (-not (Test-Path $dir)) { continue }
    Get-ChildItem -Path $dir -Filter "*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
      $pidVal = Get-Content $_.FullName -ErrorAction SilentlyContinue
      if ($pidVal) {
        Write-Host "Stopping pid $pidVal ($($_.BaseName))"
        Stop-Process -Id ([int]$pidVal) -Force -ErrorAction SilentlyContinue
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$pidVal" -ErrorAction SilentlyContinue |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      }
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($DockerToo -or $DockerOnly) {
  Write-Host "==> Stopping Docker compose" -ForegroundColor Cyan
  Set-Location $Root
  docker compose --env-file .env down 2>$null
  docker compose -f infra/docker-compose.yml down 2>$null
}

Write-Host "Stopped." -ForegroundColor Green
