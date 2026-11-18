@echo off
cd /d "%~dp0"
set "PYEXE=python"
if exist "%~dp0data\python_exe.txt" (
    set /p PYEXE=<"%~dp0data\python_exe.txt"
)
echo Starting Scoville Overdue Alerts on http://127.0.0.1:5055 ...
start "" "http://127.0.0.1:5055"
"%PYEXE%" app.py
pause
