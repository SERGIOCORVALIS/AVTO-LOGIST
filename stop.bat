@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "DOCKERTOO=0"
:parse
if "%~1"=="" goto :run
if /i "%~1"=="/docker" set "DOCKERTOO=1"
if /i "%~1"=="/DockerToo" set "DOCKERTOO=1"
if /i "%~1"=="-DockerToo" set "DOCKERTOO=1"
shift
goto :parse

:run
set "EXTRA="
if "%DOCKERTOO%"=="1" set "EXTRA=-DockerToo"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %EXTRA%
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo Stop failed with exit code %ERR%..
) else (
  echo Stopped.
)

pause
exit /b %ERR%
