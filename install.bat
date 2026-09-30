@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "GATEWAY=0"
set "VOICE=0"
set "OBS=0"
set "SETUPONLY=0"

:parse
if "%~1"=="" goto :run
if /i "%~1"=="/gateway" set "GATEWAY=1"
if /i "%~1"=="-WithGateway" set "GATEWAY=1"
if /i "%~1"=="/voice" set "VOICE=1"
if /i "%~1"=="-WithVoiceGateway" set "VOICE=1"
if /i "%~1"=="/obs" set "OBS=1"
if /i "%~1"=="-WithObservability" set "OBS=1"
if /i "%~1"=="/setup-only" set "SETUPONLY=1"
if /i "%~1"=="-SetupOnly" set "SETUPONLY=1"
shift
goto :parse

:run
echo AutoLogistics OS - Windows install / start
echo.

set "BOOTSTRAP=%~dp0scripts\bootstrap-windows.ps1"
set "EXTRA="
if "%GATEWAY%"=="1" set "EXTRA=%EXTRA% -WithGateway"
if "%VOICE%"=="1" set "EXTRA=%EXTRA% -WithVoiceGateway"
if "%OBS%"=="1" set "EXTRA=%EXTRA% -WithObservability"
if "%SETUPONLY%"=="1" set "EXTRA=%EXTRA% -SetupOnly"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%" %EXTRA%
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo Install failed with exit code %ERR%.
  echo If Docker Desktop was just installed, reboot Windows and run install.bat again.
) else (
  echo Done. Services keep running after you close this window.
  echo Stop:  stop.bat
)

pause
exit /b %ERR%
