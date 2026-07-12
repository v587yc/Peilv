@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
cd /d "%PROJECT_ROOT%"

set "EFFECTIVE_DATA_BACKEND=%DATA_BACKEND%"
if not defined EFFECTIVE_DATA_BACKEND if exist "%PROJECT_ROOT%\.env" (
    for /f "usebackq tokens=1,* delims==" %%A in (`findstr /B /C:"DATA_BACKEND=" "%PROJECT_ROOT%\.env"`) do set "EFFECTIVE_DATA_BACKEND=%%B"
)
if not defined EFFECTIVE_DATA_BACKEND set "EFFECTIVE_DATA_BACKEND=online"
set "EFFECTIVE_DATA_BACKEND=%EFFECTIVE_DATA_BACKEND:"=%"
if /I "%EFFECTIVE_DATA_BACKEND%"=="local" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%\scripts\local-data.ps1" health
    if errorlevel 1 exit /b 1
) else if /I not "%EFFECTIVE_DATA_BACKEND%"=="online" (
    echo DATA_BACKEND must be online or local. 1>&2
    exit /b 1
)

node "%PROJECT_ROOT%\dist\server.js" >> "%PROJECT_ROOT%\server.log" 2>&1
