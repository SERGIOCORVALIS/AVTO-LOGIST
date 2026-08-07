<#
.SYNOPSIS
  Rebuild and restart Docker stack (force recreate).
.EXAMPLE
  .\scripts\docker-rebuild.ps1
  .\scripts\docker-rebuild.ps1 -WithObservability -NoCache
#>
param(
  [switch]$WithObservability,
  [switch]$NoCache,
  [switch]$InfraOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

Write-Host "==> Docker rebuild" -ForegroundColor Cyan

if ($InfraOnly) {
  $args = @("-f", "infra/docker-compose.yml")
  if ($WithObservability) { $args += @("--profile", "observability") }
  docker compose @args down
  docker compose @args pull
  docker compose @args up -d --force-recreate
  Write-Host "Infra recreated." -ForegroundColor Green
  exit 0
}

$buildArgs = @("--env-file", ".env", "build")
if ($NoCache) { $buildArgs += "--no-cache" }
if ($WithObservability) {
  docker compose --env-file .env --profile observability @buildArgs
  docker compose --env-file .env --profile observability down
  docker compose --env-file .env --profile observability up -d --force-recreate --build
} else {
  docker compose @buildArgs
  docker compose --env-file .env down
  docker compose --env-file .env up -d --force-recreate --build
}

Write-Host ""
Write-Host "Docker stack rebuilt & up." -ForegroundColor Green
docker compose --env-file .env ps
Write-Host "Health: curl http://localhost:3000/health && curl http://localhost:8000/health"
