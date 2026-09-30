@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Install / configure / start AutoLogistics fully in Docker.
REM Usage:
REM   install-docker.bat
REM   install-docker.bat /obs
REM   install-docker.bat /rebuild
REM   install-docker.bat /nocache
REM   install-docker.bat /setup-only

set "OBS=0"
set "REBUILD=0"
set "NOCACHE=0"
set "SETUPONLY=0"

:parse
if "%~1"=="" goto :run
if /i "%~1"=="/obs" set "OBS=1"
if /i "%~1"=="-WithObservability" set "OBS=1"
if /i "%~1"=="/rebuild" set "REBUILD=1"
if /i "%~1"=="-Rebuild" set "REBUILD=1"
if /i "%~1"=="/nocache" set "NOCACHE=1"
if /i "%~1"=="-NoCache" set "NOCACHE=1"
if /i "%~1"=="/setup-only" set "SETUPONLY=1"
if /i "%~1"=="-SetupOnly" set "SETUPONLY=1"
shift
goto :parse

:run
echo AutoLogistics OS - Docker install / setup / start
echo.

set "EXTRA="
if "%OBS%"=="1" set "EXTRA=%EXTRA% -WithObservability"
if "%REBUILD%"=="1" set "EXTRA=%EXTRA% -Rebuild"
if "%NOCACHE%"=="1" set "EXTRA=%EXTRA% -NoCache"
if "%SETUPONLY%"=="1" set "EXTRA=%EXTRA% -SetupOnly"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-docker.ps1" %EXTRA%
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo Docker install failed with exit code %ERR%.
  echo If Docker Desktop was just installed, reboot Windows and run install-docker.bat again.
) else (
  echo Done. Containers keep running after you close this window.
  echo Rebuild later:  docker-rebuild.bat
  echo Stop:           stop.bat /docker
)

pause
exit /b %ERR%
