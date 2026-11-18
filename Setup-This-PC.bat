@echo off
cd /d "%~dp0"
echo ========================================================
echo   Scoville Overdue Alerts — One-Time Colleague PC Setup
echo ========================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Python not found on this PC. Installing official Python 3.12 via winget...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    echo.
    echo Please close this window and double-click Setup-This-PC.bat once more to finish!
    pause
    exit /b 0
)

echo Installing required packages (Flask, requests)...
python -m pip install --quiet -r requirements.txt

echo Creating Desktop shortcut...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Scoville Overdue Alerts.lnk'); $s.TargetPath = '%~dp0run_silent.vbs'; $s.WorkingDirectory = '%~dp0'; $s.Save()"

echo Starting Scoville Overdue Alerts in background...
wscript "%~dp0run_silent.vbs"
echo.
echo Done! Scoville Overdue Alerts is opening in your browser (http://127.0.0.1:5055).
echo Enter your Scoville email and password on the Settings tab and click Save!
timeout /t 4
