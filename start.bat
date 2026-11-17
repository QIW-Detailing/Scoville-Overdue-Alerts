@echo off
cd /d "%~dp0"
echo Starting Scoville Overdue Alerts on http://127.0.0.1:5055 ...
start "" "http://127.0.0.1:5055"
python app.py
pause
