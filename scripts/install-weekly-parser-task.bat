@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

set TASK_NAME=AutoLogistics-WeeklyAssociations
set BAT=%~dp0weekly-associations-update.bat

echo Registering Windows Task Scheduler job: %TASK_NAME%
echo Schedule: every Monday at 09:00 (local time)
echo Command: cmd /c "%BAT%"

schtasks /Create /TN "%TASK_NAME%" /TR "cmd /c \"%BAT%\"" /SC WEEKLY /D MON /ST 09:00 /RL HIGHEST /F
if errorlevel 1 (
  echo Failed to create task. Run this .bat as Administrator.
  exit /b 1
)

echo.
echo Task created. Verify:
echo   schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo.
echo Manual run now:
echo   schtasks /Run /TN "%TASK_NAME%"
exit /b 0
