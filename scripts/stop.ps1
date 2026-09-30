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
        taskkill /PID $pidVal /T /F 2>$null | Out-Null
        Stop-Process -Id ([int]$pidVal) -Force -ErrorAction SilentlyContinue
      }
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($port in @(3000, 3010, 5173, 8000)) {
    $pids = @()
    netstat -ano | Select-String ":$port\s+.+\s+LISTENING\s+(\d+)" | ForEach-Object {
      if ($_.Matches.Count -gt 0) { $pids += $_.Matches[0].Groups[1].Value }
    }
    $pids | Select-Object -Unique | ForEach-Object {
      if ($_ -and $_ -ne "0") {
        Write-Host "Stopping listener on :$port pid $_"
        taskkill /PID $_ /T /F 2>$null | Out-Null
      }
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
