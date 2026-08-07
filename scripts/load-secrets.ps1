<#
.SYNOPSIS
  Load secrets into current session from Doppler (if available) or print .env reminder.
#>
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (Get-Command doppler -ErrorAction SilentlyContinue) {
  if ($env:DOPPLER_TOKEN -or (Test-Path "doppler.yaml")) {
    Write-Host "==> Loading Doppler secrets into process env" -ForegroundColor Cyan
    doppler secrets download --no-file --format env | ForEach-Object {
      if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
      $i = $_.IndexOf('=')
      $k = $_.Substring(0, $i).Trim()
      $v = $_.Substring($i + 1).Trim().Trim('"').Trim("'")
      Set-Item -Path "Env:$k" -Value $v
    }
    Write-Host "Doppler secrets loaded." -ForegroundColor Green
    return
  }
}

Write-Host "Doppler not configured. Using .env file (copy from .env.example)." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env"
}
# Dot-source key=value into session (simple parser)
Get-Content ".env" | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $i = $_.IndexOf('=')
  $k = $_.Substring(0, $i).Trim()
  $v = $_.Substring($i + 1).Trim().Trim('"').Trim("'")
  if ($k -and -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($k))) { return }
  Set-Item -Path "Env:$k" -Value $v
}
Write-Host ".env applied to session (existing env vars not overwritten)."
