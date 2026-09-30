@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Rebuild all Docker images and recreate containers (full stack).
REM Usage:
REM   docker-rebuild.bat
REM   docker-rebuild.bat /nocache
REM   docker-rebuild.bat /obs
REM   docker-rebuild.bat /infra
REM   docker-rebuild.bat /nocache /obs

set "NOCACHE=0"
set "OBS=0"
set "INFRA=0"

:parse
if "%~1"=="" goto :run
if /i "%~1"=="/nocache" set "NOCACHE=1"
if /i "%~1"=="-NoCache" set "NOCACHE=1"
if /i "%~1"=="/obs" set "OBS=1"
if /i "%~1"=="-WithObservability" set "OBS=1"
if /i "%~1"=="/infra" set "INFRA=1"
if /i "%~1"=="-InfraOnly" set "INFRA=1"
shift
goto :parse

:run
echo AutoLogistics OS - Docker full rebuild
echo.

set "EXTRA="
if "%NOCACHE%"=="1" set "EXTRA=%EXTRA% -NoCache"
if "%OBS%"=="1" set "EXTRA=%EXTRA% -WithObservability"
if "%INFRA%"=="1" set "EXTRA=%EXTRA% -InfraOnly"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\docker-rebuild.ps1" %EXTRA%
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo Docker rebuild failed with exit code %ERR%.
  echo Check Docker Desktop is running, then retry.
) else (
  echo Rebuild done.
  echo API:           http://localhost:3000/health
  echo Orchestrator:  http://localhost:8000/health
  echo Cabinet:       http://localhost:8080
  echo MinIO:         http://localhost:9001
  echo Stop Docker:   stop.bat /docker
)

pause
exit /b %ERR%
