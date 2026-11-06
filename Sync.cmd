@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Sync-CodexProjects.ps1" %*
set "_codexLocalSyncExit=%errorlevel%"
echo.
pause
exit /b %_codexLocalSyncExit%
