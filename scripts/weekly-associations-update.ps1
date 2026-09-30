# Weekly KazATO/BAMAP carrier catalog update for AutoLogistics OS.
param(
  [switch]$DryRun,
  [switch]$NoEnrich,
  [switch]$NoSeed
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

Set-Location $Root
if (Test-Path ".env") { Get-Content ".env" | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim() } } }

$Py = Join-Path $Root "services\.venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
  Write-Error "Python venv not found: $Py. Run pnpm setup first."
}

$Args = @("-m", "agents.run_association_update", "--triggered-by", "bat")
if ($DryRun) { $Args += "--dry-run" }
if ($NoEnrich) { $Args += "--no-enrich" }
if ($NoSeed) { $Args += "--no-seed" }

Write-Host "[weekly-associations] start $(Get-Date -Format o)"
Push-Location (Join-Path $Root "services")
try {
  & $Py @Args
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
Write-Host "[weekly-associations] done $(Get-Date -Format o)"
