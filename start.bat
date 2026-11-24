@echo off
cd /d "%~dp0"
set "PYEXE=python"
if exist "%~dp0data\python_exe.txt" (
    set /p PYEXE=<"%~dp0data\python_exe.txt"
)
echo Starting Scoville Overdue Alerts on http://127.0.0.1:5055 ...
echo Keep this black window open while using 127.0.0.1:5055 (or double-click Setup-This-PC for silent background mode).
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5055/'"
"%PYEXE%" app.py
pause
