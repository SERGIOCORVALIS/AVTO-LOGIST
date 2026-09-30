@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo [weekly-associations] AutoLogistics OS — обновление базы перевозчиков КазАТО/БАМАП
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0weekly-associations-update.ps1" %*
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo [weekly-associations] FAILED exit=%ERR%
) else (
  echo [weekly-associations] OK
)
exit /b %ERR%
