@echo off
cd /d "%~dp0"

if not exist "%~dp0app.py" (
    echo ====================================================================
    echo   IMPORTANT: EXTRACT THE .ZIP FOLDER FIRST!
    echo ====================================================================
    echo It looks like you double-clicked Setup-This-PC.bat directly inside
    echo the compressed .zip preview window without extracting the files.
    echo.
    echo 1. Right-click the downloaded .zip file and click "Extract All..."
    echo 2. Open the extracted folder and double-click Setup-This-PC.bat
    echo ====================================================================
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_helper.ps1"
if %ERRORLEVEL% neq 0 (
    echo.
    pause
)
